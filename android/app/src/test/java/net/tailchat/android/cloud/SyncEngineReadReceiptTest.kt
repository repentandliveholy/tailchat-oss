package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
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
 * `flushReads` used to replay the *entire* incoming history of a conversation
 * on every connect.
 *
 * Incoming rows are stored at [DeliveryState.Accepted] and nothing ever moved
 * them up, so `MessageDao.unreadIncoming` — which excludes anything already at
 * `Read` — returned every message the conversation had ever received, on every
 * reconnect. Those become `k:"frame"` read receipts, the only frames the hub
 * rate limits, at the pacer's 37.5/second: a two-thousand message thread was a
 * fifty-second burst against a sixty-frames-per-second close, and every
 * reconnect started the same burst again. That is the client half of the
 * "too many attempts" loop this test pins shut.
 *
 * What it asserts is both halves at once: the receipts that *are* owed still go
 * out (so the fix cannot be "stop sending receipts"), and the ones already sent
 * are not sent twice — including when one new message arrives after a
 * reconnect, which is what proves the flush ran at all rather than being
 * skipped.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineReadReceiptTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    /** Every read receipt the socket has carried, in order. */
    private val readIds = CopyOnWriteArrayList<String>()
    private val connections = AtomicInteger(0)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                connections.incrementAndGet()
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        when {
                            text.contains("\"k\":\"auth\"") -> webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[],""" +
                                    """"caps":["durable-ack","sync-v1","addressed-send"]}""",
                            )
                            text.contains("\"k\":\"subscribe\"") ->
                                webSocket.send("""{"k":"subscribed","peer":"$PEER"}""")
                            text.contains("\"t\":\"read\"") ->
                                readIds += text.substringAfter("\"id\":\"").substringBefore('"')
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
            MediaCache(File.createTempFile("tailchat-receipt-media", "").apply { delete(); mkdirs() }),
        ) { CLOCK }
        scope = CoroutineScope(Dispatchers.Unconfined)
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            // The budget is not what this test is about, and 15 frames per
            // 400 ms would make a fifty-receipt flush take seconds of real
            // time. Everything else about the pacing is covered by
            // SyncEngineFramePacingTest.
            framePacer = FramePacer(budget = 64, windowMs = 1),
            cacheEnabled = { false },
            clock = { CLOCK },
        )
    }

    @After
    fun tearDown() {
        if (::engine.isInitialized) engine.close()
        scope.coroutineContext[kotlinx.coroutines.Job]?.let { job ->
            job.cancel()
            runBlocking { job.join() }
        }
        db.close()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    private suspend fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms: readIds=${readIds.size}", settled == true)
    }

    @Test
    fun `a reconnect sends one new receipt instead of replaying fifty old ones`() = runBlocking {
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-1",
            user = CloudUser("roman", "Roman"),
        )
        val key = accountKeyOf(session)
        for (n in 0 until 50) {
            repo.applyIncoming(key, PEER, incoming(key, "m$n", ts = 1_000L + n), countUnread = false)
        }

        engine.setForeground(true)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }
        engine.setViewInterest(PEER)
        await { readIds.size >= 50 }
        assertEquals("every owed receipt goes out, oldest first", (0 until 50).map { "m$it" }, readIds.toList())

        val beforeReconnect = connections.get()
        engine.reconnectNow()
        await { connections.get() > beforeReconnect && ephemeral.state.value.link == CloudLink.Online }
        assertTrue("the reconnect opened a second socket", connections.get() > beforeReconnect)

        // One message arrives while the app was away, and the same flush runs
        // again — this is the path that used to replay everything.
        repo.applyIncoming(key, PEER, incoming(key, "after", ts = 2_000L), countUnread = false)
        engine.setViewInterest(null)
        engine.setViewInterest(PEER)
        await { readIds.contains("after") }
        // Long enough that a replayed batch would have arrived: the frames are
        // paced at 64 per millisecond window here, so fifty of them are not a
        // matter of waiting.
        delay(500)

        assertEquals(
            "only the receipt that was still owed: 50 from before the reconnect and one new message",
            51,
            readIds.size,
        )
        assertEquals(1, readIds.count { it == "after" })
        assertEquals("no receipt is sent twice", readIds.toSet().size, readIds.size)
    }

    @Test
    fun `background resubscribe leaves incoming unread until an explicit action`() = runBlocking {
        val session = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))
        val key = accountKeyOf(session)
        repo.applyIncoming(key, PEER, incoming(key, "hidden", 2_000L), countUnread = true)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }
        engine.setViewInterest(PEER)
        await { engine.subscribedTo(PEER) }
        val beforeReconnect = connections.get()
        engine.reconnectNow()
        await { connections.get() > beforeReconnect && engine.subscribedTo(PEER) }
        engine.markVisibleMessagesRead(PEER, listOf("hidden"))
        delay(200)
        assertEquals(emptyList<String>(), readIds.toList())
        assertEquals(DeliveryState.Accepted, repo.message(key, PEER, "hidden")?.deliveryState)

        engine.markConversationRead(PEER)
        await { "hidden" in readIds }
        assertEquals(listOf("hidden"), readIds.toList())
    }

    @Test
    fun `automatic read names only presented incoming bubbles`() = runBlocking {
        val session = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))
        val key = accountKeyOf(session)
        engine.setForeground(true)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }
        engine.setViewInterest(PEER)
        await { engine.subscribedTo(PEER) }
        repo.applyIncoming(key, PEER, incoming(key, "presented", 3_000L), countUnread = false)
        repo.applyIncoming(key, PEER, incoming(key, "later", 3_000L), countUnread = true)
        engine.markVisibleMessagesRead(PEER, listOf("presented"))
        await { "presented" in readIds }
        delay(200)
        assertEquals(listOf("presented"), readIds.toList())
        assertEquals(DeliveryState.Accepted, repo.message(key, PEER, "later")?.deliveryState)
    }

    private fun incoming(accountKey: String, id: String, ts: Long) = MessageEntity(
        accountKey = accountKey,
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

    private companion object {
        const val PEER = "bob"
        const val CLOCK = 1_000L
    }
}
