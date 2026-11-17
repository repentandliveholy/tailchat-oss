package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.ConversationEntity
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.TailchatDatabase
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The account feed names messages by id and deliberately carries none of their
 * content (`accounts.js`'s `eventsSince`), so a `message` event for an id this
 * device does not hold is a *fetch*, not a merge.
 *
 * The single page the client used to ask for was the newest two hundred
 * messages, which is exactly where an older gap is not: a phone that was away
 * for a while saw the event for a message from the middle of the gap, fetched
 * the newest page, found nothing, and moved its cursor past the event anyway —
 * the message was then named by nothing ever again. The obligation has to
 * survive both of those steps: recorded on disk in the same transaction as the
 * cursor that covered the event, and paid off by walking back through pages
 * until the id is found (or until the server says there is nothing older).
 *
 * The fake history endpoint below implements the server's own `before` /
 * `beforeId` semantics rather than serving canned pages, so a client that paged
 * wrongly — a bare timestamp on rows that share one, or the same page twice —
 * would loop or miss here instead of being quietly rescued by the fixture.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineBackfillTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var ephemeral: EphemeralState
    private lateinit var scope: CoroutineScope

    private val syncPages = CopyOnWriteArrayList<String>()

    /** Frames the fake server pushes right after `ready`, as a live delivery would. */
    private val liveFrames = CopyOnWriteArrayList<String>()

    /** Ids the fake `/history` serves as an edit's carrier: the tombstone a session without
     *  `e2ee-v1` is handed (`frameForCaps`), `text: ''` and `deletedAt` beside `sealedEdit`. */
    private val carrierIds = mutableSetOf<String>()

    /** Every frame the engine wrote to the socket, in order. */
    private val sentFrames = CopyOnWriteArrayList<String>()

    /** Every `/api/history` query the engine made, in order. */
    private val historyQueries = CopyOnWriteArrayList<String>()

    /** The whole conversation, oldest first, as `(id, ts)` — the fixture the
     *  endpoint above pages through. */
    private var historyRows: List<Pair<String, Long>> = emptyList()

    private val session
        get() = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))
    private val account get() = accountKeyOf(session)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    return historyResponse(request.requestUrl!!)
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        sentFrames += text
                        when {
                            text.contains("\"k\":\"auth\"") -> webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
                                    """"users":[{"login":"anna","name":"Anna"}],""" +
                                    """"caps":["durable-ack","sync-v1","addressed-send"]}""",
                            ).also { liveFrames.forEach(webSocket::send) }
                            text.contains("\"k\":\"sync\"") -> {
                                val page = syncPages.removeFirstOrNull()
                                    ?: """{"k":"sync-page","events":[],"cursor":0,"more":false,"reset":false}"""
                                webSocket.send(page)
                            }
                        }
                    }
                })
            }
        }
        server.start()
        client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun canceled(call: Call) {
                canceledCalls += call.request().url.toString()
            }
        }).build()
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            TailchatDatabase::class.java,
        ).allowMainThreadQueries().build()
        repo = ChatRepository(
            db,
            MediaCache(File.createTempFile("tailchat-backfill", "").apply { delete(); mkdirs() }),
        ) { CLOCK }
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    }

    @After
    fun tearDown() {
        if (::engine.isInitialized) engine.close()
        scope.coroutineContext[kotlinx.coroutines.Job]?.let { job ->
            job.cancel()
            kotlinx.coroutines.runBlocking { job.join() }
        }
        db.close()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    /** Page sizes above this are refused the way a body over the client's bound is — the
     *  endpoint's own answer, so the walk has to recover from it, not from a stub. */
    private var refuseAbove = Int.MAX_VALUE

    /** The first full-size `/history` request for the page below this `beforeId` is refused
     *  the same way — a page that happened not to fit, once, at one position. */
    private var refuseOnceBelow: String? = null
    private val refusedOnce = java.util.concurrent.atomic.AtomicBoolean()

    /** Delays every `/history` body this long — keeps a request in flight on purpose. */
    private var historyDelayMs = 0L

    /** Streams every `/history` body at a crawl — a page that would take minutes. */
    private var crawlHistory = false

    /** Every call OkHttp reported as cancelled, by URL. */
    private val canceledCalls = CopyOnWriteArrayList<String>()

    /** Successful (200) `/history` pages served so far, and how many may be served before
     *  every further one answers 500 — a walk interrupted by a plain server failure, which
     *  no halving can help. */
    private val okPages = java.util.concurrent.atomic.AtomicInteger()
    @Volatile private var failAfterOkPages = Int.MAX_VALUE

    /** What the engine's `cacheEnabled` answers: off by default, so every `/history`
     *  request here is attributable to the test's own trigger; on for the prefetch cases. */
    @Volatile private var cacheOn = false

    /**
     * The deployment's `/history`, as `server.js` builds it: ascending by `ts`,
     * everything strictly older than `beforeId` when that is given (which is
     * what makes a page of identical timestamps walkable), otherwise everything
     * older than `before`, and the newest `limit` of what is left.
     */
    private fun historyResponse(url: HttpUrl): MockResponse {
        historyQueries += url.toString()
        val limit = url.queryParameter("limit")?.toIntOrNull() ?: 200
        val refuseHere = refuseOnceBelow != null && limit == 200 &&
            url.queryParameter("beforeId") == refuseOnceBelow && refusedOnce.compareAndSet(false, true)
        if (limit > refuseAbove || refuseHere) {
            return MockResponse().setResponseCode(413).setBody("""{"error":"too_large"}""")
        }
        if (okPages.get() >= failAfterOkPages) {
            return MockResponse().setResponseCode(500).setBody("""{"error":"server_error"}""")
        }
        okPages.incrementAndGet()
        val beforeId = url.queryParameter("beforeId")
        val before = url.queryParameter("before")?.toLongOrNull()
        val cut = when {
            beforeId != null -> historyRows.indexOfFirst { it.first == beforeId }
                .let { if (it < 0) historyRows.size else it }
            before != null -> historyRows.indexOfFirst { it.second >= before }
                .let { if (it < 0) historyRows.size else it }
            else -> historyRows.size
        }
        val page = historyRows.take(cut).takeLast(limit)
        val body = page.joinToString(
            separator = ",",
            prefix = """{"messages":[""",
            postfix = """],"peerReadTs":0}""",
        ) { (id, ts) ->
            if (id in carrierIds) {
                """{"id":"$id","from":"anna","text":"","ts":$ts,"deletedAt":$ts,"sealedEdit":true}"""
            } else {
                """{"id":"$id","from":"anna","text":"$id","ts":$ts}"""
            }
        }
        val response = MockResponse().setResponseCode(200)
        if (crawlHistory) {
            // A megabyte at a kilobyte a second: nothing but a cancelled call ends this.
            return response.setBody(body.dropLast(1) + ""","pad":"${"x".repeat(1024 * 1024)}"}""")
                .throttleBody(1024, 1, TimeUnit.SECONDS)
        }
        if (historyDelayMs > 0) response.setBodyDelay(historyDelayMs, TimeUnit.MILLISECONDS)
        return response.setBody(body)
    }

    private fun startEngine() {
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(budget = 64, windowMs = 1),
            // The background prefetch has its own suite: leaving it off (unless a test
            // turns it on) keeps every `/history` request here attributable to the backfill.
            cacheEnabled = { cacheOn },
            clock = { CLOCK },
        )
        engine.start(session)
    }

    private suspend fun seedConversation(key: String, seeded: Boolean = true) {
        repo.upsertConversation(
            ConversationEntity(
                accountKey = key,
                peer = PEER,
                name = "Anna",
                self = false,
                previewFrom = PEER,
                previewText = "hi",
                previewMedia = null,
                previewTs = CLOCK,
                unread = 0,
                readWatermarkTs = 0L,
                peerReadTs = 0L,
                online = false,
                lastSeen = null,
                historySeeded = seeded,
                updatedAt = CLOCK,
            ),
        )
    }

    /**
     * E3: an encrypted edit's carrier is named by the feed like any message, and the server
     * answers it to this client (no `e2ee-v1`) as a tombstone. The walk must find that id on
     * the first page it reads: a tombstone this client could not store would leave the id
     * owed, and the walk would run to the beginning of the conversation on every sync.
     */
    @Test
    fun `a carrier named by the feed is closed by its tombstone in one page and never drawn`() = runBlocking {
        val key = account
        seedConversation(key)
        carrierIds += "e-1"
        historyRows = buildList {
            for (index in 1..150) add("n-$index" to (1_000L + index))
            add("e-1" to 5_000L)
        }
        syncPages +=
            """{"k":"sync-page","events":[{"seq":9,"kind":"message","peer":"anna","id":"e-1","ts":5000}],""" +
                """"cursor":9,"more":false,"reset":false}"""
        startEngine()

        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "e-1") }
        await { repo.backfillIds(key, PEER).isEmpty() }
        assertEquals("one page closes the debt: no walk back to the beginning", 1, historyQueries.size)
        val row = repo.message(key, PEER, "e-1")
        assertEquals("held as a tombstone, so it is never a bubble", 5_000L, row?.deletedAt)
        assertEquals("", row?.text)
        val conversation = repo.conversation(key, PEER)
        assertEquals("no unread for a carrier", 0, conversation?.unread)
        assertEquals("nor a preview line", "hi", conversation?.previewText)
    }

    /** E3: the live frame of a carrier (a stub from an older server, a tombstone from a newer
     *  one) is stored hidden under its id: no bubble, no unread, no preview, no backfill. */
    @Test
    fun `a live carrier frame is held hidden and moves no unread nor preview`() = runBlocking {
        val key = account
        seedConversation(key)
        liveFrames +=
            """{"k":"frame","from":"anna","d":{"t":"msg","id":"e-live","text":"stub","ts":7000,"sealedEdit":true}}"""
        liveFrames +=
            """{"k":"frame","from":"anna","d":{"t":"msg","id":"e-tomb","ts":7001,"deletedAt":7001,"sealedEdit":true}}"""
        liveFrames += """{"k":"frame","from":"anna","d":{"t":"msg","id":"m-real","text":"hello","ts":20000}}"""
        startEngine()

        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "m-real") }
        assertEquals(7_000L, repo.message(key, PEER, "e-live")?.deletedAt)
        assertEquals("", repo.message(key, PEER, "e-live")?.text)
        assertEquals(7_001L, repo.message(key, PEER, "e-tomb")?.deletedAt)
        assertEquals(null, repo.message(key, PEER, "m-real")?.deletedAt)
        val conversation = repo.conversation(key, PEER)
        assertEquals("only the real message counts", 1, conversation?.unread)
        assertEquals("hello", conversation?.previewText)
        assertTrue("nothing to fetch", historyQueries.isEmpty())
    }

    @Test
    fun `a gap deeper than one page is walked back to, and the debt is cleared`() = runBlocking {
        val key = account
        seedConversation(key)
        // Two hundred and one rows, oldest first as the endpoint's own contract
        // has them, with the one the feed named at the very bottom: the newest
        // page is full and the missed message is not in it.
        historyRows = buildList {
            add("m-gap" to 500L)
            for (index in 1..200) add("n-$index" to (10_000L + index))
        }
        syncPages +=
            """{"k":"sync-page","events":[{"seq":7,"kind":"message","peer":"anna","id":"m-gap","ts":500}],""" +
                """"cursor":7,"more":false,"reset":false}"""
        startEngine()

        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "m-gap") }
        await { repo.backfillIds(key, PEER).isEmpty() }
        assertEquals(
            "the missed message arrives once, with the content the feed never carried",
            "m-gap",
            repo.message(key, PEER, "m-gap")?.text,
        )
        assertTrue(
            "the walk has to go past the newest page, so there is more than one request",
            historyQueries.size >= 2,
        )
        assertTrue(
            "every request names the page size the paging loop reasons about",
            historyQueries.all { it.contains("limit=200") },
        )
        assertTrue(
            "the boundary after a full page is named by both timestamp and id, so rows " +
                "sharing a `ts` at the page edge can be neither skipped nor served twice",
            historyQueries[1].contains("beforeId=n-1") && historyQueries[1].contains("before=10001"),
        )
    }

    /**
     * A page that cannot be transferred — over the client's body bound, or cut off because
     * it could not finish inside the read timeout — is asked for again at the *same*
     * position with half the rows. The Rust core already encodes that policy
     * (`FetchError::TooLarge`: `same position, half the page`); this is the Android half of
     * it, and without it a conversation with tens of megabytes of inline media simply
     * never loads: every retry asks for the same page and fails at the same point.
     */
    @Test
    fun `a page too large to transfer is asked for again with half the rows`() = runBlocking {
        val key = account
        seedConversation(key)
        // Two hundred and one rows with the owed id at the very bottom, and an endpoint
        // that refuses anything above a hundred rows: only a walk that shrinks its page
        // can reach the id.
        historyRows = buildList {
            add("m-gap" to 500L)
            for (index in 1..200) add("n-$index" to (10_000L + index))
        }
        refuseAbove = 100
        repo.addBackfill(key, PEER, listOf("m-gap"))
        startEngine()

        await(timeoutMs = 15_000) { repo.hasMessage(key, PEER, "m-gap") }
        await { repo.backfillIds(key, PEER).isEmpty() }

        // Two triggers can walk the same debt concurrently (a sync page and the roster's
        // own drain), so the same question may be asked twice; what matters is that no
        // request is ever *newer* than the size this walk settled on, and that the first
        // step down is a half, at the same position.
        val sizes = historyQueries
            .map { it.substringAfter("limit=").substringBefore("&") }
            .distinct()
        assertEquals(
            "the full page is asked for, then the same page at half size",
            listOf("200", "100"),
            sizes.take(2),
        )
        assertTrue(
            "the shrunk page asks the same question — a halving is not a step of the walk",
            historyQueries.first { it.contains("limit=100") }.let { !it.contains("before=") },
        )
        assertTrue(
            "and the walk still moves: the page after the first successful one names its edge",
            historyQueries.firstOrNull { it.contains("beforeId=") }?.contains("beforeId=n-101") == true,
        )
        assertEquals("the missed message arrives, with the content the feed never carried", "m-gap", repo.message(key, PEER, "m-gap")?.text)
    }

    /**
     * After a halving, "fewer rows than asked for" has to mean fewer than *that* page asked
     * for, not fewer than the default. A hundred-row page is full when a hundred were
     * requested: reading it as "the beginning" clears the debt as unpayable while the id is
     * still a page and a half further back, and the message is then named by nothing ever
     * again.
     */
    @Test
    fun `a shrunk page is judged full against the size it actually asked for`() = runBlocking {
        val key = account
        seedConversation(key)
        // Two hundred and fifty rows; the owed id sits twenty rows from the oldest, so it
        // is reachable only by three pages of a hundred — and a walk that treated the first
        // hundred as "everything there is" would declare it absent.
        historyRows = buildList {
            for (index in 0 until 20) add("old-$index" to (1_000L + index))
            add("m-deep" to 2_000L)
            for (index in 0 until 229) add("n-$index" to (10_000L + index))
        }
        refuseAbove = 120
        repo.addBackfill(key, PEER, listOf("m-deep"))
        startEngine()

        await(timeoutMs = 15_000) { repo.hasMessage(key, PEER, "m-deep") }
        await { repo.backfillIds(key, PEER).isEmpty() }

        assertEquals("the debt is paid, not declared absent", "m-deep", repo.message(key, PEER, "m-deep")?.text)
        assertTrue(
            "the walk kept going past two full hundred-row pages",
            historyQueries.count { it.contains("limit=100") } >= 3,
        )
    }

    /**
     * The attempt budget belongs to one *position*, not to the whole walk. Counting every
     * request of the walk meant that after eleven good pages the first page that did not
     * fit was already the twelfth attempt — given up on as permanent (with a banner, from a
     * background walk) before a single halving was tried.
     */
    @Test
    fun `a page that does not fit after eleven good ones is still halved, not given up on`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = buildList {
            add("m-gap" to 500L)
            for (index in 1..2250) add("n-$index" to (10_000L + index))
        }
        // Eleven full pages reach `n-51`; the page below it does not fit, once.
        refuseOnceBelow = "n-51"
        repo.addBackfill(key, PEER, listOf("m-gap"))
        startEngine()

        await(timeoutMs = 20_000) { repo.hasMessage(key, PEER, "m-gap") }
        await { repo.backfillIds(key, PEER).isEmpty() }

        val refused = historyQueries.indexOfFirst { it.endsWith("beforeId=n-51") }
        assertEquals("eleven full pages first", 11, refused)
        assertTrue(historyQueries.take(11).all { limitOf(it) == "200" })
        assertEquals(
            "the twelfth request is refused and asked again at half size, at the same position",
            "limit=100|n-51",
            historyQueries[refused + 1].let { "limit=${limitOf(it)}|${it.substringAfter("beforeId=", "")}" },
        )
        assertNull("nothing was given up on, so nothing is reported", ephemeral.state.value.failure)
    }

    /**
     * The walk's bound is five thousand *rows*. Counted in pages, a walk whose pages had
     * to shrink to twelve rows covered three hundred, and a gap four hundred rows deep was
     * never reached by any pass.
     */
    @Test
    fun `a walk with shrunk pages reaches as deep as one with full pages`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = buildList {
            add("m-deep" to 500L)
            for (index in 1..400) add("n-$index" to (10_000L + index))
        }
        refuseAbove = 12
        repo.addBackfill(key, PEER, listOf("m-deep"))
        startEngine()

        await(timeoutMs = 30_000) { repo.hasMessage(key, PEER, "m-deep") }
        await { repo.backfillIds(key, PEER).isEmpty() }
        assertTrue("every successful page was the shrunk size", historyQueries.filter { limitOf(it) != "12" }.size == 4)
    }

    /**
     * An opened conversation is seeded with its newest two hundred rows, and `loadOlder`
     * only ever widens over what the database holds once a conversation is seeded. So a
     * fetch whose page had to shrink keeps walking until it has those two hundred — or a
     * halving would leave the conversation with a quarter of its history and nothing that
     * would ever fetch the rest. The size that worked is remembered for the next walk of
     * the same conversation on the same connection, instead of re-learning it by
     * downloading pages that cannot be transferred.
     */
    @Test
    fun `an opened conversation still gets its newest page's worth of rows after a halving`() = runBlocking {
        val key = account
        seedConversation(key, seeded = false)
        historyRows = (0 until 250).map { "n-$it" to (10_000L + it) }
        refuseAbove = 60
        startEngine()
        await { ephemeral.state.value.link == CloudLink.Online }

        engine.refreshHistory(PEER)

        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "n-50") }
        assertTrue("the newest row is there", repo.hasMessage(key, PEER, "n-249"))
        assertTrue("two hundred rows, not one shrunk page of them", !repo.hasMessage(key, PEER, "n-49"))
        assertEquals("and only now is it seeded", true, repo.conversation(key, PEER)?.historySeeded)
        assertEquals(
            "200 and 100 refused, then four pages of fifty",
            listOf("200", "100", "50", "50", "50", "50"),
            historyQueries.map(::limitOf),
        )

        val mark = historyQueries.size
        engine.refreshHistory(PEER)
        await { historyQueries.size >= mark + 4 }
        assertEquals("the next walk starts at the size that worked", "50", limitOf(historyQueries[mark]))
    }

    /**
     * A backfill walk is a walk other callers share (an open conversation asking for its
     * newest rows joins one already on the wire), so it fills the same newest page's worth
     * of rows even when the id it owes was in the very first shrunk page. Stopping at that
     * page — what a debt-only walk does — leaves the conversation the person opened with a
     * fraction of its history and seeded, so nothing fetches the rest.
     */
    @Test
    fun `a backfill walk whose debt is paid early still fills the newest page's worth`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = (0 until 250).map { "n-$it" to (10_000L + it) }
        refuseAbove = 60
        repo.addBackfill(key, PEER, listOf("n-249"))
        startEngine()

        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "n-50") }
        await { repo.backfillIds(key, PEER).isEmpty() }
        assertTrue("two hundred rows, not the one page that held the id", !repo.hasMessage(key, PEER, "n-49"))
    }

    /**
     * `history_failed` is for the person looking at the conversation: raised only by the
     * open conversation's own load, never by a background walk, and withdrawn by the next
     * load of that conversation that succeeds instead of staying up until a reconnect.
     */
    @Test
    fun `the history banner belongs to the open conversation and goes away once it loads`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = (1..3).map { "n-$it" to (10_000L + it) }
        refuseAbove = 0
        repo.addBackfill(key, PEER, listOf("m-gap"))
        startEngine()

        await(timeoutMs = 10_000) { historyQueries.any { limitOf(it) == "1" } }
        delay(300)
        assertNull("a background walk that gives up raises no banner", ephemeral.state.value.failure)

        engine.setViewInterest(PEER)
        engine.refreshHistory(PEER)
        await { ephemeral.state.value.failure == CloudFailure("history_failed", peer = PEER) }

        refuseAbove = Int.MAX_VALUE
        engine.refreshHistory(PEER)
        await { ephemeral.state.value.failure == null }
        assertTrue("and the conversation did load", repo.hasMessage(key, PEER, "n-3"))
    }

    /** The banner goes away with the conversation it names, and never covers a failure
     *  that is about everything rather than one thread. */
    @Test
    fun `the history banner leaves with its conversation and yields to a broader failure`() = runBlocking {
        val key = account
        seedConversation(key, seeded = false)
        historyRows = (1..3).map { "n-$it" to (10_000L + it) }
        refuseAbove = 0
        startEngine()
        await { ephemeral.state.value.link == CloudLink.Online }

        engine.setViewInterest(PEER)
        engine.refreshHistory(PEER)
        await(timeoutMs = 10_000) { ephemeral.state.value.failure == CloudFailure("history_failed", peer = PEER) }
        engine.setViewInterest(null)
        assertNull("closing the conversation takes its banner with it", ephemeral.state.value.failure)

        val broader = CloudFailure("unreachable")
        ephemeral.setFailure(broader)
        val mark = historyQueries.size
        engine.setViewInterest(PEER)
        engine.refreshHistory(PEER)
        await { historyQueries.size > mark }
        delay(500)
        assertEquals("a strip about one thread does not replace one about the link", broader, ephemeral.state.value.failure)
    }

    /**
     * The conversation is seeded only by the page that completes the newest-rows fill.
     * Seeded by the first shrunk page, a walk interrupted after it — here by a plain 500 —
     * left fifty rows that every loader then took for the whole conversation: `ready`
     * re-asks for the open conversation only while it is unseeded.
     */
    @Test
    fun `an interrupted walk after a halving is completed by the next connection`() = runBlocking {
        val key = account
        seedConversation(key, seeded = false)
        historyRows = (0 until 250).map { "n-$it" to (10_000L + it) }
        refuseAbove = 60
        failAfterOkPages = 1
        startEngine()
        await { ephemeral.state.value.link == CloudLink.Online }

        engine.refreshHistory(PEER)
        await(timeoutMs = 10_000) { historyQueries.size >= 4 }
        delay(500)
        assertTrue("the first fifty rows did land", repo.hasMessage(key, PEER, "n-249"))
        assertEquals("but a fraction is not a seeded conversation", false, repo.conversation(key, PEER)?.historySeeded)

        failAfterOkPages = Int.MAX_VALUE
        engine.setViewInterest(PEER)
        engine.reconnectNow()
        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "n-50") }
        assertTrue("its newest two hundred rows", !repo.hasMessage(key, PEER, "n-49"))
        assertEquals(true, repo.conversation(key, PEER)?.historySeeded)
    }

    /**
     * Opening a conversation while the prefetch is between two of its shrunk pages: the
     * prefetch's next page is discarded at the merge (the conversation is open now), and
     * `selectPeer` asks for history only while the conversation is unseeded — so the first
     * page must not have seeded it. The open also aborts the prefetch's download outright
     * rather than letting it finish into a page nobody merges.
     */
    @Test
    fun `opening a conversation mid-prefetch still fills it and aborts the prefetch`() = runBlocking {
        val key = account
        historyRows = (0 until 250).map { "n-$it" to (10_000L + it) }
        refuseAbove = 60
        historyDelayMs = 800
        cacheOn = true
        startEngine()
        await(timeoutMs = 15_000) { historyQueries.any { limitOf(it) == "50" } }
        delay(1_200) // the first fifty-row page merged, the second one in flight
        assertTrue("the prefetch has merged its first page", repo.hasMessage(key, PEER, "n-249"))

        // What `CloudController.selectPeer` does.
        engine.setViewInterest(PEER)
        val seededAtTap = repo.conversation(key, PEER)?.historySeeded
        if (seededAtTap != true) engine.refreshHistory(PEER)

        await(timeoutMs = 3_000) { canceledCalls.any { it.contains("/tailchat/api/history") } }
        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "n-50") }
        assertEquals("not seeded by the prefetch's first page", false, seededAtTap)
        assertTrue("its newest two hundred rows", !repo.hasMessage(key, PEER, "n-49"))
    }

    /**
     * A caller waiting out a walk that a reconnect then aborts must not start a walk of its
     * own for the generation that was aborted: nothing would ever cancel it. One request
     * for the first connection, one for the new one.
     */
    @Test
    fun `a waiter released by an abort does not walk for the aborted generation`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = listOf("m-gap" to 500L, "m-1" to 10_001L)
        repo.addBackfill(key, PEER, listOf("m-gap"))
        historyDelayMs = 1_500
        startEngine()
        engine.refreshHistory(PEER) // an interactive walk, created before `ready`
        await { historyQueries.size >= 1 }
        delay(600) // `ready` -> the backfill drain now waits behind it
        engine.reconnectNow() // aborts the interactive walk

        await(timeoutMs = 15_000) { repo.hasMessage(key, PEER, "m-gap") }
        delay(2_000)
        assertEquals(2, historyQueries.size)
    }

    /**
     * The size a walk shrank to is remembered the moment it shrinks — and when it gives up
     * — not only after a page succeeds: the next walk (a prefetch retries every thirty
     * seconds) starts there instead of paying for the whole ladder from two hundred again.
     */
    @Test
    fun `the size a walk shrank to is remembered even when the walk fails`() = runBlocking {
        val key = account
        seedConversation(key, seeded = false)
        historyRows = (0 until 250).map { "n-$it" to (10_000L + it) }
        refuseAbove = 60
        failAfterOkPages = 0 // the first page that fits answers 500
        startEngine()
        await { ephemeral.state.value.link == CloudLink.Online }

        engine.refreshHistory(PEER)
        await(timeoutMs = 10_000) { historyQueries.size >= 3 }
        delay(300)
        assertEquals(listOf("200", "100", "50"), historyQueries.map(::limitOf))

        refuseAbove = 0 // nothing fits any more: the walk gives up at one row
        engine.refreshHistory(PEER)
        await(timeoutMs = 10_000) { historyQueries.any { limitOf(it) == "1" } }
        delay(300)
        assertEquals("the second walk starts where the first one shrank to", "50", limitOf(historyQueries[3]))

        val mark = historyQueries.size
        engine.refreshHistory(PEER)
        await { historyQueries.size > mark }
        delay(300)
        assertEquals(
            "and after giving up, the next walk does not climb the ladder again",
            listOf("1"),
            historyQueries.drop(mark).map(::limitOf),
        )
    }

    /** One download per conversation at a time: the open conversation is asked for at
     *  `selectPeer`, at `ready` and by a `reset`, and each used to be its own copy of a
     *  page that can be tens of megabytes. */
    @Test
    fun `two loads of the same conversation share one request`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = (1..3).map { "m-$it" to (10_000L + it) }
        historyDelayMs = 300
        startEngine()
        await { ephemeral.state.value.link == CloudLink.Online }

        engine.refreshHistory(PEER)
        engine.refreshHistory(PEER)

        await { repo.hasMessage(key, PEER, "m-3") }
        delay(500)
        assertEquals(1, historyQueries.size)
    }

    /**
     * Without the shared eight-second budget, nothing but cancellation ends a slow page —
     * so a reconnect has to abort the downloads of the socket it replaces, and a logout
     * also the account-scoped push fetch (which a reconnect deliberately leaves running).
     * Each body here would take over a quarter of an hour; OkHttp's own `canceled` event
     * for the call is the proof it was aborted, not just discarded on arrival.
     */
    @Test
    fun `a reconnect aborts the open conversation's download and a logout the push fetch`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = listOf("m-1" to 10_001L)
        crawlHistory = true
        startEngine()
        await { ephemeral.state.value.link == CloudLink.Online }
        fun canceledHistory() = canceledCalls.count { it.contains("/tailchat/api/history") }

        engine.refreshHistory(PEER)
        await { historyQueries.size == 1 }
        delay(300)
        engine.reconnectNow()
        await(timeoutMs = 3_000) { canceledHistory() == 1 }

        await { ephemeral.state.value.link == CloudLink.Online }
        scope.launch { engine.processPushOnce(PEER, "m-1", accountScopeOf(session)) }
        await { historyQueries.size == 2 }
        delay(300)
        engine.reconnectNow()
        delay(1_000)
        assertEquals("a push fetch survives a reconnect", 1, canceledHistory())

        engine.forget()
        await(timeoutMs = 3_000) { canceledHistory() == 2 }
    }

    private fun limitOf(query: String) = query.substringAfter("limit=").substringBefore("&")

    /**
     * A message reaches a socket that is not subscribed to its author only
     * through the feed, never as a live frame — so before 184 nothing ever
     * acknowledged it and the author's mark stayed ✓ until the conversation
     * was opened here. Once the backfill holds it, the newest incoming message
     * the page named is acknowledged, exactly once, and nothing is said about
     * a message this account wrote itself.
     */
    @Test
    fun `a message the feed delivered is acknowledged once this device holds it`() = runBlocking {
        val key = account
        seedConversation(key)
        historyRows = listOf("m-1" to 1_000L, "m-2" to 2_000L)
        syncPages +=
            """{"k":"sync-page","events":[""" +
                """{"seq":8,"kind":"message","peer":"anna","id":"m-1","ts":1000},""" +
                """{"seq":9,"kind":"message","peer":"anna","id":"m-2","ts":2000},""" +
                """{"seq":10,"kind":"message","peer":"anna","id":"mine-1","ts":2500,"self":true}""" +
                """],"cursor":10,"more":false,"reset":false}"""
        startEngine()

        await(timeoutMs = 10_000) { sentFrames.any { it.contains("\"t\":\"ack\"") } }
        val acks = sentFrames.filter { it.contains("\"t\":\"ack\"") }
        assertEquals("one ack: the server keeps a watermark, not a flag per message", 1, acks.size)
        assertTrue("it names the newest incoming message, to its author", acks.single().contains("\"id\":\"m-2\"") && acks.single().contains("\"to\":\"anna\""))
    }

    @Test
    fun `a debt left by an interrupted backfill is paid on the next connection`() = runBlocking {
        val key = account
        seedConversation(key)
        // What a process killed between the cursor commit and the fetch leaves
        // behind: the conversation, the cursor already past the event, and the
        // debt — with nothing left that would ever name the id again.
        repo.addBackfill(key, PEER, listOf("m-gap"))
        assertEquals(listOf("m-gap"), repo.backfillIds(key, PEER))
        historyRows = listOf("m-gap" to 500L)
        startEngine()

        await(timeoutMs = 10_000) { repo.hasMessage(key, PEER, "m-gap") }
        await { repo.backfillIds(key, PEER).isEmpty() }
        assertTrue("the fetch happened without any feed event", historyQueries.isNotEmpty())
        assertNull(
            "the debt is gone once it is paid",
            repo.conversation(key, PEER)?.backfillJson,
        )
    }

    @Test
    fun `a message the server no longer has stops being owed instead of being retried forever`() = runBlocking {
        val key = account
        seedConversation(key)
        // The id names a message this account hid from its own side (or one
        // long past the retention window): the server's history simply does not
        // contain it, and no amount of walking will produce it. Reaching the
        // beginning of the pair's history is the proof of that, and the debt is
        // dropped there instead of being retried on every connection for the
        // life of the install.
        repo.addBackfill(key, PEER, listOf("m-gone"))
        historyRows = listOf("n-1" to 900L)
        startEngine()

        await(timeoutMs = 10_000) { repo.backfillIds(key, PEER).isEmpty() }
        assertNull(
            "a debt that cannot be paid is cleared, not kept",
            repo.conversation(key, PEER)?.backfillJson,
        )
        assertTrue(
            "and the conversation is not still on the worklist",
            repo.backfillPeers(key).isEmpty(),
        )
    }

    private suspend fun await(timeoutMs: Long = 5_000, condition: suspend () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(20)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms", settled == true)
    }

    private companion object {
        const val CLOCK = 10_000L
        const val PEER = "anna"
    }
}
