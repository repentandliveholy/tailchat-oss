package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.MediaCache
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
 * A `rate_limited` close is a *pause*, and nothing a caller does may shorten it.
 *
 * The hub closes a connection that sends more than 60 frames in a second with
 * 4429, and `onFailure` answers with a ten second delay. Three other paths —
 * a network callback, a return to the foreground, `/reconnect` — call
 * `reconnectNow()`, and that used to reset the delay to one second and dial
 * straight back into the penalty the server had just handed out. On a flapping
 * Tailscale link that is a reconnect every second, each one replaying whatever
 * the client owed: the disconnect the penalty was meant to end became permanent.
 *
 * The floor is measured against an injected monotonic clock, because that is the
 * only way to observe it without waiting out the production ten seconds — and
 * because on the JVM `SystemClock` is the test framework's virtual clock, which
 * does not move while the test thread is blocked. The pause itself is shortened
 * for the same reason: the mechanism under test is "a floor that a
 * `reconnectNow()` cannot clear", not the literal number.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineRateLimitBackoffTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    private val connections = AtomicInteger(0)

    /** Stands in for `SystemClock.elapsedRealtime` — see the class comment. */
    private val monotonic = AtomicLong(0L)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                // The first connection is answered and then closed the way the
                // hub closes an over-budget one; every later one is healthy.
                val punish = connections.incrementAndGet() == 1
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (!text.contains("\"k\":\"auth\"")) return
                        if (punish) {
                            webSocket.close(CloudSocket.RATE_LIMITED_CODE, "rate_limited")
                        } else {
                            webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[],""" +
                                    """"caps":["durable-ack","sync-v1","addressed-send"]}""",
                            )
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
        scope = CoroutineScope(Dispatchers.Unconfined)
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = ChatRepository(
                db,
                MediaCache(File.createTempFile("tailchat-backoff-media", "").apply { delete(); mkdirs() }),
            ) { CLOCK },
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(budget = 64, windowMs = 1),
            cacheEnabled = { false },
            clock = { CLOCK },
            monotonicMs = { monotonic.get() },
            rateLimitedPauseMs = PAUSE_MS,
        )
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

    @Test
    fun `the rate-limit pause survives an immediate reconnect request`() = runBlocking {
        engine.start(
            CloudSession(
                server = server.url("/").toString(),
                token = "token-1",
                user = CloudUser("roman", "Roman"),
            ),
        )
        val settled = withTimeoutOrNull(5_000) {
            while (ephemeral.state.value.failure?.code != "rate_limited") delay(10)
            true
        }
        assertTrue("the 4429 close did not surface as a failure", settled == true)

        val beforeAsking = connections.get()

        // Halfway into the pause, which is where a `reconnectNow()` from a
        // network callback or a return to the foreground lands: still inside the
        // penalty. It must not bring the next dial-in any closer.
        monotonic.set(PAUSE_MS / 2)
        engine.reconnectNow()
        val tooEarly = withTimeoutOrNull(500) {
            while (connections.get() == beforeAsking) delay(10)
            true
        }
        assertEquals("reconnectNow reopened the socket inside the penalty", null, tooEarly)

        // Past the pause, and then it does come back: a pause, not a wedge. The
        // real delay that carries this is the ordinary one — a second at most —
        // so this is the floor being honoured, not patience.
        monotonic.set(PAUSE_MS + 1)
        val redialled = withTimeoutOrNull(5_000) {
            while (connections.get() == beforeAsking) delay(10)
            true
        }
        assertTrue("the engine never redialled after the pause", redialled == true)
        val online = withTimeoutOrNull(5_000) {
            while (ephemeral.state.value.link != CloudLink.Online) delay(10)
            true
        }
        assertTrue("the reconnected socket never came up", online == true)
    }

    private companion object {
        const val CLOCK = 1_000L

        /** Longer than `RETRY_MS` and shorter than the production ten seconds:
         *  the mechanism is what is being measured, not the number. */
        const val PAUSE_MS = 1_500L
    }
}
