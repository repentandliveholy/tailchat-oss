package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.ConversationDao
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
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The background prefetch walk, against a real socket (MockWebServer), a real
 * [ChatRepository] on an in-memory database, and the real [CloudApi] /
 * [CloudSocket] the app builds — so this is what the engine asks the server
 * for, in what order, and how much of it at a time.
 *
 * The rules pinned here are the ones a rewrite would break silently: a
 * conversation this device already holds is not fetched again, no more than two
 * history requests are in flight at once, the account's own Saved Messages
 * thread is included even though the roster never lists it, and switching the
 * cache off stops the walk instead of filling a disk the user asked to keep
 * empty.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEnginePrefetchTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    /** The roster the server announces; the walk's candidate set. */
    private val users = listOf("anna", "boris", "carol")

    private val historyRequests = mutableListOf<String>()
    private val inFlight = AtomicInteger()
    private val maxInFlight = AtomicInteger()

    /** Held shut while a test watches how many requests are running at once. */
    private var gate: CountDownLatch? = null

    private val account get() = "${server.url("/")}|roman"

    private fun setUpServer() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl ?: return MockResponse().setResponseCode(400)
                if (url.encodedPath == "/tailchat/api/history") {
                    val peer = url.queryParameter("peer").orEmpty()
                    synchronized(historyRequests) { historyRequests += peer }
                    val running = inFlight.incrementAndGet()
                    maxInFlight.accumulateAndGet(running, ::maxOf)
                    gate?.await()
                    inFlight.decrementAndGet()
                    return MockResponse().setResponseCode(200).setBody(
                        """{"messages":[{"id":"m-$peer","from":"$peer","text":"from $peer","ts":5000}]}""",
                    )
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        webSocket.send(
                            """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[""" +
                                users.joinToString(",") { """{"login":"$it","name":"$it"}""" } +
                                """]}""",
                        )
                    }
                })
            }
        }
        server.start()
    }

    @Before
    fun setUp() {
        setUpServer()
        client = OkHttpClient()
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            TailchatDatabase::class.java,
        ).allowMainThreadQueries().build()
        repo = ChatRepository(
            db,
            MediaCache(File.createTempFile("tailchat-prefetch-media", "").apply { delete(); mkdirs() }),
        ) { CLOCK }
        scope = CoroutineScope(Dispatchers.Unconfined)
    }

    @After
    fun tearDown() {
        // A test that fails while requests are deliberately held must not leave
        // MockWebServer's worker threads parked on the gate.
        gate?.countDown()
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

    private fun startEngine(cacheEnabled: Boolean = true) {
        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(),
            cacheEnabled = { cacheEnabled },
            clock = { CLOCK },
        )
        engine.start(
            CloudSession(
                server = server.url("/").toString(),
                token = "token-1",
                user = CloudUser("roman", "Roman"),
            ),
        )
    }

    private fun requestedPeers(): List<String> = synchronized(historyRequests) { historyRequests.toList() }

    private suspend fun await(timeoutMs: Long = 5_000, condition: suspend () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(20)
            true
        }
        assertTrue(
            "condition not reached within ${timeoutMs}ms: requests=${requestedPeers()} maxInFlight=$maxInFlight inFlight=${inFlight.get()}",
            settled == true,
        )
    }

    private suspend fun awaitSeeded(peers: List<String>) = await {
        peers.all { repo.conversation(account, it)?.historySeeded == true }
    }

    @Test
    fun `every roster thread plus the account's own is fetched without opening any`() = runBlocking {
        startEngine()
        awaitSeeded(users + "roman")

        assertEquals((users + "roman").sorted(), requestedPeers().sorted())
        assertTrue(repo.hasMessage(account, "boris", "m-boris"))
        // History and its preview only: the badge is not the walk's to invent.
        assertEquals(0, repo.conversation(account, "anna")?.unread)
    }

    @Test
    fun `a conversation this device already holds is not fetched again`() = runBlocking {
        repo.upsertConversation(
            ConversationDao.blank(account, "boris", now = CLOCK).copy(historySeeded = true),
        )
        startEngine()
        awaitSeeded(listOf("anna", "carol", "roman"))

        assertTrue("boris was already seeded", "boris" !in requestedPeers())
    }

    @Test
    fun `the walk keeps at most two history requests in flight`() = runBlocking {
        gate = CountDownLatch(1)
        startEngine()
        await(timeoutMs = 8_000) { maxInFlight.get() >= 2 }

        // Held open deliberately: with four candidates and a two-wide window a
        // third concurrent request is exactly the regression this pins.
        delay(300)
        assertEquals(2, maxInFlight.get())

        gate?.countDown()
        awaitSeeded(users + "roman")
        assertEquals((users + "roman").sorted(), requestedPeers().sorted())
    }

    @Test
    fun `switching the cache off stops the walk before it asks for anything`() = runBlocking {
        startEngine(cacheEnabled = false)
        await { ephemeral.state.value.link == CloudLink.Online }
        delay(500)

        assertEquals(emptyList<String>(), requestedPeers())
    }

    private companion object {
        const val CLOCK = 1_000L
    }
}
