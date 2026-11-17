package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.ConversationEntity
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.MessageEntity
import net.tailchat.android.data.MessageKind
import net.tailchat.android.data.TailchatDatabase
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * One server event, two opposite meanings.
 *
 * A `read` receipt is recorded for *both* sides of a conversation
 * (`accounts.js`'s `recordEvent`): the reader's own devices see it with
 * `self: true`, and it is that account's read watermark — the roster badge for
 * this conversation is settled, and nothing here was read by *this* device.
 * The author's devices see the same event without `self`, and for them it says
 * the opposite: the peer has read this account's own messages up to `readTs`.
 *
 * The reducer treated both as the first, so:
 *  * a receipt arriving through the feed never turned a single ✓ into a double
 *    one — the outgoing checkmark the whole feature is about — while the live
 *    path only ever advanced the one bubble the frame named, so a single lost
 *    receipt left a run of older messages on ✓ under a newer ✓✓ until the
 *    conversation was reloaded;
 *  * and the *peer's* reading moved this device's own read watermark, which
 *    silently suppressed its own unread notification for a message it had
 *    never seen.
 *
 * What is pinned here is the split itself, in both directions, from both
 * transports: the durable feed (`k:"sync-page"`) and the live frame
 * (`d:{t:"read", readTs}`), because they are the same fact arriving two ways
 * and must not disagree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEnginePeerReadTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var ephemeral: EphemeralState
    private lateinit var scope: CoroutineScope

    /** Sync pages the test wants the server to answer with, newest first. */
    private val syncPages = CopyOnWriteArrayList<String>()
    /** Live frames to deliver once the socket is subscribed. */
    private val liveFrames = CopyOnWriteArrayList<String>()
    private var socket: WebSocket? = null

    private val session
        get() = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))
    private val account get() = accountKeyOf(session)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    return MockResponse().setResponseCode(200).setBody("""{"messages":[],"peerReadTs":0}""")
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                        socket = webSocket
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        when {
                            text.contains("\"k\":\"auth\"") -> webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
                                    """"users":[{"login":"anna","name":"Anna"}],""" +
                                    """"caps":["durable-ack","sync-v1","addressed-send"]}""",
                            )
                            text.contains("\"k\":\"subscribe\"") -> {
                                webSocket.send("""{"k":"subscribed","peer":"anna"}""")
                                for (frame in liveFrames) webSocket.send(frame)
                            }
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
        client = OkHttpClient()
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            TailchatDatabase::class.java,
        ).allowMainThreadQueries().build()
        repo = ChatRepository(
            db,
            MediaCache(File.createTempFile("tailchat-peer-read", "").apply { delete(); mkdirs() }),
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

    private fun startEngine(subscribe: Boolean = true) {
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(budget = 64, windowMs = 1),
            // The background prefetch has its own suite; leaving it off keeps
            // this one about the receipt reducer and the HTTP the backfill owes.
            cacheEnabled = { false },
            clock = { CLOCK },
        )
        engine.start(session)
        // A live frame only reaches a subscribed conversation — this socket
        // holds one subscription at a time (`hub.js`'s `relay`). The feed tests
        // deliberately leave the conversation closed: opening it also owes read
        // receipts for what is on screen, and this suite is about what the feed
        // says, not about what this device read.
        if (subscribe) engine.setViewInterest(PEER)
    }

    /** The conversation a peer read is measured against, with three own
     *  messages and one incoming one. */
    private suspend fun seedConversation(key: String) {
        repo.upsertConversation(conversation(key))
        repo.applyIncoming(key, PEER, incoming(key, "in-1", ts = 2_000L), countUnread = false)
        for (id in listOf("m-early", "m-mid", "m-late")) {
            repo.applyIncoming(key, PEER, own(key, id, ts = TS[id]!!), countUnread = false)
        }
        repo.markDelivery(key, PEER, "m-early", DeliveryState.Accepted)
        repo.markDelivery(key, PEER, "m-mid", DeliveryState.Accepted)
        repo.markDelivery(key, PEER, "m-late", DeliveryState.Accepted)
    }

    private fun conversation(key: String) = ConversationEntity(
        accountKey = key,
        peer = PEER,
        name = "Anna",
        self = false,
        previewFrom = PEER,
        previewText = "hi",
        previewMedia = null,
        previewTs = 4_000L,
        unread = 1,
        readWatermarkTs = 0L,
        peerReadTs = 0L,
        online = false,
        lastSeen = null,
        historySeeded = true,
        updatedAt = CLOCK,
    )

    @Test
    fun `a peer read event in the feed advances every own message it covers and nothing of ours`() = runBlocking {
        val key = account
        seedConversation(key)
        // The peer read up to 3000: everything of ours at or before it is read,
        // the later one is not, and the incoming message is not ours to state
        // anything about.
        syncPages +=
            """{"k":"sync-page","events":[{"seq":4,"kind":"read","peer":"anna","readTs":3000,"readAt":9000,"via":"android/450"}],""" +
                """"cursor":4,"more":false,"reset":false}"""
        startEngine(subscribe = false)

        await { repo.conversation(key, PEER)?.peerReadTs == 3_000L }
        assertEquals(
            "the feed's own read time and client are kept beside the watermark the menu explains",
            9_000L,
            repo.conversation(key, PEER)?.peerReadAt,
        )
        assertEquals("android/450", repo.conversation(key, PEER)?.peerReadVia)
        assertEquals(DeliveryState.Read, repo.message(key, PEER, "m-early")?.deliveryState)
        assertEquals(
            "a receipt is a watermark: everything above the named message is read too",
            DeliveryState.Read,
            repo.message(key, PEER, "m-mid")?.deliveryState,
        )
        assertEquals(
            "a message past the watermark is not read",
            DeliveryState.Accepted,
            repo.message(key, PEER, "m-late")?.deliveryState,
        )
        assertEquals(
            "the peer reading is not this device reading",
            DeliveryState.Accepted,
            repo.message(key, PEER, "in-1")?.deliveryState,
        )
        assertEquals(
            "the peer's receipt must not move this account's own read watermark",
            0L,
            repo.conversation(key, PEER)?.readWatermarkTs,
        )
    }

    @Test
    fun `this account's own read event in the feed keeps its own watermark and leaves the ticks alone`() = runBlocking {
        val key = account
        seedConversation(key)
        syncPages +=
            """{"k":"sync-page","events":[{"seq":5,"kind":"read","peer":"anna","readTs":3000,"self":true}],""" +
                """"cursor":5,"more":false,"reset":false}"""
        startEngine(subscribe = false)

        await { repo.conversation(key, PEER)?.readWatermarkTs == 3_000L }
        assertEquals(
            "our own reading says nothing about what the peer read",
            0L,
            repo.conversation(key, PEER)?.peerReadTs,
        )
        assertEquals(
            "and nothing about our own outgoing checkmarks",
            DeliveryState.Accepted,
            repo.message(key, PEER, "m-mid")?.deliveryState,
        )
    }

    @Test
    fun `a live read frame carries the watermark, so one receipt settles every message above it`() = runBlocking {
        val key = account
        seedConversation(key)
        liveFrames += """{"k":"frame","from":"anna","d":{"t":"read","id":"m-mid","readAt":9000,"readTs":3000,"via":"web"}}"""
        startEngine()

        await { repo.conversation(key, PEER)?.peerReadTs == 3_000L }
        assertEquals(
            "the live frame's read time reaches the row the menu reads",
            9_000L,
            repo.conversation(key, PEER)?.peerReadAt,
        )
        assertEquals("web", repo.conversation(key, PEER)?.peerReadVia)
        assertEquals(
            "the earlier message the receipt never named is read as well",
            DeliveryState.Read,
            repo.message(key, PEER, "m-early")?.deliveryState,
        )
        assertEquals(DeliveryState.Read, repo.message(key, PEER, "m-mid")?.deliveryState)
        assertEquals(
            "a message past the watermark is untouched",
            DeliveryState.Accepted,
            repo.message(key, PEER, "m-late")?.deliveryState,
        )
    }

    @Test
    fun `a live ack without a watermark still settles the id it names`() = runBlocking {
        val key = account
        seedConversation(key)
        liveFrames += """{"k":"frame","from":"anna","d":{"t":"ack","id":"m-early"}}"""
        startEngine()

        await { repo.message(key, PEER, "m-early")?.deliveryState == DeliveryState.Delivered }
        assertEquals(
            "an older server's `ack` names one message and claims nothing about the earlier ones",
            DeliveryState.Delivered,
            repo.message(key, PEER, "m-early")?.deliveryState,
        )
        assertEquals(
            "the ones it did not name keep their accepted tick",
            DeliveryState.Accepted,
            repo.message(key, PEER, "m-mid")?.deliveryState,
        )
        assertEquals(
            "and an ack is not a read: no watermark moves",
            0L,
            repo.conversation(key, PEER)?.peerReadTs,
        )
        assertEquals(
            "nor a delivered one, because this ack carried none",
            0L,
            repo.conversation(key, PEER)?.peerDeliveredTs,
        )
    }

    /**
     * The delivered rung the ladder was missing, on the same watermark terms as
     * the read one above it: an `ack` names one message but carries the peer's
     * whole delivered watermark, so the earlier messages it never named climb
     * to ✓✓ too — otherwise a receipt lost to a reconnect leaves every message
     * before it a rung short until the conversation is reloaded.
     *
     * Delivered is *not* read: the read watermark must stay where it was, the
     * incoming message's own delivery is this device's receipt state and is
     * none of the peer's business, and a message past the watermark keeps its
     * single ✓.
     */
    @Test
    fun `a live ack with a delivered watermark lifts every own message below it without claiming they were read`() = runBlocking {
        val key = account
        seedConversation(key)
        liveFrames += """{"k":"frame","from":"anna","d":{"t":"ack","id":"m-mid","deliveredTs":3000}}"""
        startEngine()

        await { repo.conversation(key, PEER)?.peerDeliveredTs == 3_000L }
        assertEquals(
            "the earlier message the receipt never named is delivered as well",
            DeliveryState.Delivered,
            repo.message(key, PEER, "m-early")?.deliveryState,
        )
        assertEquals(DeliveryState.Delivered, repo.message(key, PEER, "m-mid")?.deliveryState)
        assertEquals(
            "a message past the watermark is not delivered",
            DeliveryState.Accepted,
            repo.message(key, PEER, "m-late")?.deliveryState,
        )
        assertEquals(
            "delivered is not read: the read watermark must not move",
            0L,
            repo.conversation(key, PEER)?.peerReadTs,
        )
    }

    private fun own(key: String, id: String, ts: Long) = MessageEntity(
        accountKey = key,
        peer = PEER,
        id = id,
        text = id,
        ts = ts,
        author = "Roman",
        mine = true,
        delivery = DeliveryState.Queued.ordinal,
        system = false,
        kind = MessageKind.TEXT,
        imageDataUrl = null,
        imageWidth = null,
        imageHeight = null,
        voiceDataUrl = null,
        voiceDurationSec = null,
        reactionsJson = null,
        replyJson = null,
        forwardJson = null,
        editedAt = null,
        deletedAt = null,
        serverSeq = null,
    )

    private fun incoming(key: String, id: String, ts: Long) = MessageEntity(
        accountKey = key,
        peer = PEER,
        id = id,
        text = id,
        ts = ts,
        author = PEER,
        mine = false,
        delivery = DeliveryState.Accepted.ordinal,
        system = false,
        kind = MessageKind.TEXT,
        imageDataUrl = null,
        imageWidth = null,
        imageHeight = null,
        voiceDataUrl = null,
        voiceDurationSec = null,
        reactionsJson = null,
        replyJson = null,
        forwardJson = null,
        editedAt = null,
        deletedAt = null,
        serverSeq = null,
    )

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
        val TS = mapOf("m-early" to 1_000L, "m-mid" to 3_000L, "m-late" to 4_000L)
    }
}
