package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.SupervisorJob
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.NotificationDeliveryStatus
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEnginePushNotificationTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var ephemeral: EphemeralState
    private lateinit var scope: CoroutineScope
    private val notifications = CopyOnWriteArrayList<CloudUnreadNotification>()
    private val session get() = CloudSession(server.url("/").toString(), "token", CloudUser("roman", "Roman"))

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    return MockResponse().setResponseCode(200).setBody(
                        """{"messages":[{"id":"m1","from":"anna","text":"hello","ts":5000}]}""",
                    )
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        webSocket.send(
                            """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
                        )
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
            MediaCache(File.createTempFile("tailchat-push-media", "").apply { delete(); mkdirs() }),
        ) { 10_000L }
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {
                override fun onUnreadNotification(notification: CloudUnreadNotification) {
                    notifications += notification
                }
            },
            framePacer = FramePacer(),
            cacheEnabled = { false },
            clock = { 10_000L },
        )
        engine.start(session)
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
    fun `push resumes a stood-down engine fetches cold history and alerts once`() = runBlocking {
        delay(500)
        engine.standDown()
        delay(500)

        if (!processPush()) {
            assertTrue("WorkManager retry must recover a wake lost to socket teardown", processPush())
        }
        assertEquals(listOf("m1"), notifications.map { it.messageId })
        assertEquals("hello", repo.message(accountKeyOf(session), "anna", "m1")?.text)

        assertTrue(processPush())
        assertEquals("repeat push must not alert twice", 1, notifications.size)
        assertEquals(
            NotificationDeliveryStatus.CLAIMED,
            repo.notificationStatus(accountKeyOf(session), "anna", "m1"),
        )
    }

    @Test
    fun `push for the visible conversation is durably suppressed`() = runBlocking {
        engine.setViewInterest("anna")
        engine.setForeground(true)

        assertTrue(processPush())
        assertTrue(notifications.isEmpty())
        assertEquals(
            NotificationDeliveryStatus.SUPPRESSED,
            repo.notificationStatus(accountKeyOf(session), "anna", "m1"),
        )
    }

    private suspend fun processPush(): Boolean =
        engine.processPushOnce("anna", "m1", accountScopeOf(session))
}
