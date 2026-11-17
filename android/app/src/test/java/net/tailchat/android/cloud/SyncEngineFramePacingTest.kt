package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The typing indicator used to bypass [FramePacer] entirely —
 * `SyncEngine.keystroke()`/`stopOwnTyping()` called `connection.sendTyping`
 * directly, even though `sendTyping` builds the exact same `k:"frame"`
 * payload the hub counts toward its per-socket 60-frames/second close
 * ([FramePacer]'s own KDoc). A typing lease renewing every few seconds could
 * not blow the budget on its own, but it was still an outbound frame the
 * shared pacer never saw — a live violation of the "every sustained outbound
 * path" invariant that class documents, and exactly the kind of private
 * allowance the original `rate_limited` bug (see [FramePacerTest]) came from.
 *
 * This pins that a typing "start" and its later "stop" contend for the
 * *same* budget: with a one-frame-per-window pacer, "stop" sent right after
 * "start" must wait out that window instead of sailing through on an
 * allowance of its own — measured on the two frames alone, with no message
 * or database round trip in between to blur the timing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineFramePacingTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    private val frameTimes = CopyOnWriteArrayList<Long>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.contains("\"k\":\"frame\"")) frameTimes += System.nanoTime()
                        if (text.contains("\"k\":\"auth\"")) {
                            webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""",
                            )
                        }
                    }
                })
        }
        server.start()
        client = OkHttpClient()
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            TailchatDatabase::class.java,
        ).allowMainThreadQueries().build()
        repo = ChatRepository(
            db,
            MediaCache(File.createTempFile("tailchat-pacing-media", "").apply { delete(); mkdirs() }),
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
            // One frame per window makes "did the second frame wait for a
            // fresh window" observable in real time without slowing the
            // suite down.
            framePacer = FramePacer(budget = 1, windowMs = 600),
            cacheEnabled = { false },
            clock = { CLOCK },
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

    private suspend fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms: frames=${frameTimes.size}", settled == true)
    }

    @Test
    fun `typing start and stop frames share one budget instead of each getting their own`() = runBlocking {
        engine.start(
            CloudSession(server = server.url("/").toString(), token = "token-1", user = CloudUser("roman", "Roman")),
        )
        await { ephemeral.state.value.link == CloudLink.Online }

        // Spends the window's one slot on the "start" frame.
        engine.keystroke("bob")
        await { frameTimes.size >= 1 }
        val startAt = frameTimes[0]

        // Sent the instant after: if "stop" shared the budget, it is held
        // back to the next window; if it had its own private allowance (the
        // bug this pins), it goes out immediately alongside "start".
        engine.stopOwnTyping()
        await(timeoutMs = 3_000) { frameTimes.size >= 2 }
        val stopAt = frameTimes[1]

        val gapMs = (stopAt - startAt) / 1_000_000
        assertTrue(
            "expected the stop frame to wait out the start frame's window (gap=${gapMs}ms)",
            gapMs >= 400,
        )
    }

    private companion object {
        const val CLOCK = 1_000L
    }
}
