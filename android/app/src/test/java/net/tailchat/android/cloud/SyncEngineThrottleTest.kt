package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
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
 * `conn.sendReceipt` returning `true` only ever meant OkHttp queued the frame
 * locally — never that the hub processed it. Cloud 1.34's soft frame-budget
 * drop (`k:"throttle"`, `hub.js`'s `chargeFrame`) lets an over-budget frame
 * through OkHttp and then silently discards it server-side, with no id in the
 * notice to say which one. Before the fix this test pins, `SyncEngine` never
 * even parsed `k:"throttle"` — a receipt caught in one was marked read
 * (`MessageDao.markIncomingRead`) purely because sending it locally succeeded,
 * and since the hub never echoes `read-sync` back to its own sender, that row
 * never got another chance: its `✓✓` never reached the peer, permanently.
 *
 * On the old code this test's first assertion fails: every one of the 35
 * messages ends up `Read` after a single throttled drain, including the batch
 * that was in flight when the notice arrived.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineThrottleTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    private val readIds = CopyOnWriteArrayList<String>()
    private val throttleSent = AtomicBoolean(false)
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
                            text.contains("\"t\":\"read\"") -> {
                                readIds += text.substringAfter("\"id\":\"").substringBefore('"')
                                // Exactly once, on the very first receipt of the batch — the
                                // real hub reports at most once per over-budget window (see
                                // `chargeFrame`'s `windowOverNoted` gate), and firing here
                                // gives the slow pacer below the most time to land it before
                                // the batch this test cares about closes.
                                if (throttleSent.compareAndSet(false, true)) {
                                    webSocket.send("""{"k":"throttle","windowMs":1000,"frames":61,"limit":60}""")
                                }
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
            MediaCache(File.createTempFile("tailchat-throttle-media", "").apply { delete(); mkdirs() }),
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
            // Slow enough (25ms/frame) that the throttle notice — a loopback
            // round trip, sub-millisecond in practice — has landed and been
            // dispatched long before the batch of 32 this test relies on
            // closes; SyncEngineFramePacingTest covers the pacer itself.
            framePacer = FramePacer(budget = 1, windowMs = 25),
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

    private suspend fun await(timeoutMs: Long = 10_000, condition: suspend () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms: readIds=${readIds.size}", settled == true)
    }

    @Test
    fun `a receipt batch throttled mid-flight is not marked read, and is retried`() = runBlocking {
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-1",
            user = CloudUser("roman", "Roman"),
        )
        val key = accountKeyOf(session)
        // One more than SyncEngine's private RECEIPT_READ_BATCH (32): the
        // throttle notice fires on the very first frame, so it is visible to
        // the whole first (full) batch and the trailing partial one is a
        // clean control — proof this discards the batch that was actually
        // throttled, not every batch a throttle was ever seen in.
        val total = 35
        for (n in 0 until total) {
            repo.applyIncoming(key, PEER, incoming(key, "m$n", ts = 1_000L + n), countUnread = false)
        }

        engine.setForeground(true)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }
        engine.setViewInterest(PEER)
        // Every owed receipt is still sent — throttling is not "stop
        // retrying", it is "do not believe you succeeded".
        await(timeoutMs = 15_000) { readIds.size >= total }
        assertEquals("every owed receipt still goes out despite the throttle", total, readIds.size)

        val readAfterFirstDrain = (0 until total).count {
            repo.message(key, PEER, "m$it")?.deliveryState == DeliveryState.Read
        }
        assertTrue(
            "the throttled batch (the first 32) must not be marked read: $readAfterFirstDrain of $total are",
            readAfterFirstDrain < total,
        )
        assertEquals(
            "exactly the trailing partial batch (3 messages), untouched by the throttle, is marked read",
            total - 32,
            readAfterFirstDrain,
        )

        // The durable retry this fix depends on: a reconnect is what forgets
        // the discarded batch's `queuedReceipts` entries (`invalidate` calls
        // `forgetReceipts`), the same as any other frame the socket refused —
        // see `drainReceipts`'s own doc. Nothing about this fix invents a
        // faster retry than that existing contract already provides.
        readIds.clear()
        val beforeReconnect = connections.get()
        engine.reconnectNow()
        await { connections.get() > beforeReconnect && ephemeral.state.value.link == CloudLink.Online }
        engine.setViewInterest(null)
        engine.setViewInterest(PEER)
        await(timeoutMs = 15_000) { (0 until total).all { repo.message(key, PEER, "m$it")?.deliveryState == DeliveryState.Read } }
        assertEquals(
            "the retry re-sends exactly the 32 that were discarded, not the whole conversation again",
            32,
            readIds.size,
        )
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
