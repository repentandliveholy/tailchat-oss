package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
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
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `callable` is liveness, and it used to be dropped between the socket and the
 * screen: the frame was parsed into [CloudUser.callable] and then thrown away,
 * because the roster is rebuilt from Room and Room has no such column. Every
 * contact therefore looked uncallable, on every device, whatever the peer's
 * caps were. These tests pin the path that replaces it — socket frame →
 * [EphemeralState.callablePeers] → the roster merge — and the invariant that
 * makes keeping it out of Room correct: a lost link makes nobody callable.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallableLivenessTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    private val clock = AtomicLong(1_000L)
    private val connections = AtomicInteger(0)
    private val latestSocket = AtomicReference<WebSocket>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                // Only the first connection reports a call-capable peer: a
                // reconnect must not be able to repopulate the set behind an
                // assertion that the drop cleared it.
                val callable = connections.incrementAndGet() == 1
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (!text.contains("\"k\":\"auth\"")) return
                        latestSocket.set(webSocket)
                        webSocket.send(ready(callable))
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
            MediaCache(File.createTempFile("tailchat-callable-media", "").apply { delete(); mkdirs() }),
        ) { clock.get() }
        scope = CoroutineScope(Dispatchers.Unconfined)
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(budget = 64, windowMs = 1),
            cacheEnabled = { false },
            clock = { clock.get() },
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

    @Test
    fun `a call-capable peer in the ready roster reaches the live state`() = runBlocking {
        engine.start(session())
        await { ephemeral.state.value.link == CloudLink.Online }

        await { PEER in ephemeral.state.value.callablePeers }
        assertEquals(setOf(PEER), ephemeral.state.value.callablePeers)
        assertTrue(
            "the roster merge dropped the live call capability",
            rosterUser().callable,
        )
    }

    @Test
    fun `a users frame without the capability withdraws it`() = runBlocking {
        engine.start(session())
        await { PEER in ephemeral.state.value.callablePeers }
        assertTrue(rosterUser().callable)

        latestSocket.get().send(users(callable = false))

        await { ephemeral.state.value.callablePeers.isEmpty() }
        assertFalse(
            "a peer whose last connection lost the call cap stayed callable",
            rosterUser().callable,
        )
    }

    @Test
    fun `losing the link makes nobody callable`() = runBlocking {
        engine.start(session())
        await { PEER in ephemeral.state.value.callablePeers }

        latestSocket.get().close(1000, "test_disconnect")

        await { ephemeral.state.value.link == CloudLink.Offline }
        assertEquals(
            "a stale callable survived the socket that reported it",
            emptySet<String>(),
            ephemeral.state.value.callablePeers,
        )
        assertFalse(rosterUser().callable)
    }

    /** The roster exactly as `ServiceCloudController.collectRoster` assembles it. */
    private suspend fun rosterUser(): CloudUser {
        val key = accountKeyOf(session())
        val rows = withTimeoutOrNull(3_000) {
            var rows = repo.conversationSnapshot(key)
            while (rows.none { it.peer == PEER }) {
                delay(10)
                rows = repo.conversationSnapshot(key)
            }
            rows
        }
        assertTrue("the roster was never persisted", rows != null)
        return rows!!.map { it.toUser() }
            .withLiveRoster(ephemeral.state.value)
            .first { it.login == PEER }
    }

    private suspend fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms", settled == true)
    }

    private fun session() = CloudSession(
        server = server.url("/").toString(),
        token = "token-1",
        user = CloudUser("roman", "Roman"),
    )

    private fun ready(callable: Boolean): String =
        """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
            """"users":[{"login":"$PEER","name":"Bob","online":true,"callable":$callable}],""" +
            """"caps":["durable-ack","sync-v1","addressed-send","call-v1"]}"""

    private fun users(callable: Boolean): String =
        """{"k":"users","users":[{"login":"$PEER","name":"Bob","online":true,"callable":$callable}]}"""

    private companion object {
        const val PEER = "bob"
    }
}
