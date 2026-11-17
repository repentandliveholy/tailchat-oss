package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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
 * `tailik` answers a friend on the account owner's behalf under the owner's
 * own login — `ai-bridge.js`'s `ack()` defaults `from` to the account that
 * configured the bridge. The self-sync copy the hub sends to the owner's
 * other sessions (`hub.js`'s `selfSync`) sets `from` to the *conversation
 * peer* and `self: true` to mean "you sent this". Before this,
 * `SyncEngine.onMessage` computed `mine = message.self || message.from ==
 * self`, which is true for exactly this frame: the owner's own device
 * rendered tailik's reply as something it had typed itself, while the web
 * client (which explicitly excludes `kind == "ai"`) showed it correctly
 * attributed to tailik.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineAiAttributionTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope
    private val session get() = CloudSession(server.url("/").toString(), "token", CloudUser("roman", "Roman"))

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    return MockResponse().setResponseCode(200).setBody("""{"messages":[]}""")
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.contains("\"k\":\"auth\"")) {
                            webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
                            )
                            // The self-sync copy an AI reply produces for the
                            // owner's own other sessions: `from` names the
                            // conversation peer (anna), not the sender, and
                            // `self: true` says "you sent this" (`hub.js`'s
                            // `selfSync`, `from: toLogin`).
                            webSocket.send(
                                """{"k":"frame","from":"anna","self":true,"d":{"t":"ai","id":"ai-1",""" +
                                    """"text":"Привет!","ts":5680,"name":"tailik"}}""",
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
        repo = ChatRepository(
            db,
            MediaCache(File.createTempFile("tailchat-ai-media", "").apply { delete(); mkdirs() }),
        ) { 10_000L }
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(),
            cacheEnabled = { false },
            clock = { 10_000L },
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
    fun `an ai reply delivered under the owner's own login is not mine`() = runBlocking {
        val latch = CountDownLatch(1)
        val poll = scope.launch {
            while (repo.message(accountKeyOf(session), "anna", "ai-1") == null) delay(20)
            latch.countDown()
        }
        engine.start(session)
        assertTrue("the ai frame never landed", latch.await(5, TimeUnit.SECONDS))
        poll.cancel()

        val stored = repo.message(accountKeyOf(session), "anna", "ai-1")
        assertEquals(false, stored?.mine)
        assertEquals("tailik", stored?.author)
        assertEquals("Привет!", stored?.text)
    }
}
