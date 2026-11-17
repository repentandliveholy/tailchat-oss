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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
 * Issue #29: the engine decides whether a dial is a *wake-only* one — the app
 * is not on screen **and** the background service is off — and, when it is,
 * asks `CloudSocket` to declare `lurk-v1` in the `auth` frame so the hub counts
 * the connection for neither presence nor callability. This pins that decision
 * against the actual wire frame, since a regression here is invisible locally
 * (the socket still works) and only shows up as the owner looking offline on
 * everyone else's roster while the app is open.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineLurkDialTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope
    /** Every frame the server received, in order; only the first `auth` matters. */
    private val frames = CopyOnWriteArrayList<String>()

    private val session get() = CloudSession(server.url("/").toString(), "token", CloudUser("roman", "Roman"))

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        frames += text
                        if (text.contains("\"k\":\"auth\"")) {
                            webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
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
            MediaCache(File.createTempFile("tailchat-lurk-media", "").apply { delete(); mkdirs() }),
        ) { 10_000L }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        this.scope = scope
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = EphemeralState(scope),
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(),
        )
    }

    @After
    fun tearDown() {
        engine.close()
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
    fun `a wake-only dial declares lurk-v1 in the auth frame`() = runBlocking {
        // Defaults: never foregrounded, background service off — a dial that
        // only exists because a push woke the process.
        engine.start(session)

        val caps = authCaps()
        assertTrue("a wake-only dial must declare lurk-v1", "lurk-v1" in caps)
    }

    @Test
    fun `a dial made with the app on screen does not declare lurk-v1`() = runBlocking {
        engine.setForeground(true)
        engine.start(session)

        val caps = authCaps()
        assertTrue("an on-screen dial must not declare lurk-v1", "lurk-v1" !in caps)
    }

    private suspend fun authCaps(): List<String> {
        val frame = awaitAuthFrame()
        return Json.parseToJsonElement(frame).jsonObject
            .getValue("caps").jsonArray.map { it.jsonPrimitive.content }
    }

    private suspend fun awaitAuthFrame(): String {
        repeat(250) {
            frames.firstOrNull { it.contains("\"k\":\"auth\"") }?.let { return it }
            delay(20)
        }
        throw AssertionError("the auth frame never arrived")
    }
}
