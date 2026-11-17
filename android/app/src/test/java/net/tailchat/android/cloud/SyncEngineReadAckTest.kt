package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.ErrorKind
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineReadAckTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    private val clock = AtomicLong(1_000L)
    private val connections = AtomicInteger(0)
    private val markReadFrames = AtomicInteger(0)
    private val readIds = CopyOnWriteArrayList<String>()
    private val latestBulkSocket = AtomicReference<WebSocket>()
    private val latestReceiptSocket = AtomicReference<WebSocket>()
    private val closeFirstBulk = AtomicBoolean(false)

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
                                    """"caps":["durable-ack","sync-v1","addressed-send","read-ack-v1"]}""",
                            )
                            text.contains("\"k\":\"subscribe\"") -> {
                                val peer = text.substringAfter("\"peer\":\"").substringBefore('"')
                                webSocket.send("""{"k":"subscribed","peer":"$peer"}""")
                            }
                            text.contains("\"k\":\"mark-read\"") -> {
                                latestBulkSocket.set(webSocket)
                                val number = markReadFrames.incrementAndGet()
                                if (closeFirstBulk.get() && number == 1) webSocket.close(1000, "test_disconnect")
                            }
                            text.contains("\"t\":\"read\"") -> {
                                latestReceiptSocket.set(webSocket)
                                readIds += text.substringAfter("\"id\":\"").substringBefore('"')
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
            MediaCache(File.createTempFile("tailchat-read-ack-media", "").apply { delete(); mkdirs() }),
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
    fun `bulk mark-read remains pending until its acknowledgement`() = runBlocking {
        val key = start()

        engine.markConversationRead(PEER)
        await { markReadFrames.get() == 1 }
        awaitPending(key)
        delay(50)

        latestBulkSocket.get().send(readAccepted(peer = PEER, id = null))

        awaitOperationGone(key)
        assertNull(repo.operation(opId(key)))
    }

    @Test
    fun `bulk mark-read without acknowledgement expires into retryable backoff`() = runBlocking {
        val key = start()

        engine.markConversationRead(PEER)
        await { markReadFrames.get() == 1 }
        awaitPending(key)
        clock.set(22_000L)

        val retried = withTimeoutOrNull(3_000) {
            while (repo.operation(opId(key))?.lastError != "no_read_ack") delay(10)
            repo.operation(opId(key))
        }
        assertTrue("the acknowledgement deadline never released the operation", retried != null)
        assertEquals(1, retried?.attempts)
        assertEquals(ErrorKind.Retryable.ordinal, retried?.errorKind)
        assertTrue("retry must use backoff instead of becoming immediately due", retried!!.nextAttemptAt > clock.get())
        assertEquals("the operation was unexpectedly resent before its backoff", 1, markReadFrames.get())
    }

    @Test
    fun `socket loss releases bulk mark-read and reconnect resends the same operation`() = runBlocking {
        closeFirstBulk.set(true)
        val key = start()

        engine.markConversationRead(PEER)
        await { markReadFrames.get() == 1 }
        val released = withTimeoutOrNull(3_000) {
            while (repo.operation(opId(key))?.leaseOwner != null) delay(10)
            repo.operation(opId(key))
        }
        assertTrue("socket loss did not release the operation lease", released != null)
        clock.set(released!!.nextAttemptAt)

        await(timeoutMs = 6_000) { connections.get() >= 2 && markReadFrames.get() >= 2 }
        assertEquals("reconnect created a duplicate pending operation", 1, repo.operations(key).size)
        delay(50)
        latestBulkSocket.get().send(readAccepted(peer = PEER, id = null))
        awaitOperationGone(key)
    }

    @Test
    fun `message read acknowledgement only commits for the matching peer`() = runBlocking {
        val session = session()
        val key = accountKeyOf(session)
        repo.applyIncoming(key, PEER, incoming(key, MESSAGE_ID), countUnread = false)
        engine.setForeground(true)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }

        engine.setViewInterest(PEER)
        await { MESSAGE_ID in readIds }
        delay(50)
        assertEquals(listOf(MESSAGE_ID), repo.unreadIncoming(key, PEER, 10))

        latestReceiptSocket.get().send(readAccepted(peer = "mallory", id = MESSAGE_ID))
        delay(200)
        assertEquals("an acknowledgement for another peer consumed the receipt", listOf(MESSAGE_ID), repo.unreadIncoming(key, PEER, 10))

        latestReceiptSocket.get().send(readAccepted(peer = PEER, id = MESSAGE_ID))
        val committed = withTimeoutOrNull(3_000) {
            while (repo.unreadIncoming(key, PEER, 10).isNotEmpty()) delay(10)
            true
        }
        assertTrue("the matching acknowledgement did not mark the incoming row read", committed == true)
    }

    private suspend fun start(): String {
        val session = session()
        val key = accountKeyOf(session)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }
        return key
    }

    private suspend fun awaitPending(key: String) {
        val pending = withTimeoutOrNull(3_000) {
            while (repo.operation(opId(key)) == null) delay(10)
            true
        }
        assertTrue("mark-read was not persisted", pending == true)
    }

    private suspend fun awaitOperationGone(key: String) {
        val gone = withTimeoutOrNull(3_000) {
            while (repo.operation(opId(key)) != null) delay(10)
            true
        }
        assertTrue("mark-read remained pending after acknowledgement", gone == true)
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

    private fun opId(key: String) = "read:$key:$PEER"

    private fun readAccepted(peer: String, id: String?): String =
        if (id == null) """{"k":"read-accepted","peer":"$peer","id":null,"readTs":1000}"""
        else """{"k":"read-accepted","peer":"$peer","id":"$id","readTs":1000}"""

    private fun incoming(accountKey: String, id: String) = MessageEntity(
        accountKey = accountKey,
        peer = PEER,
        id = id,
        text = id,
        ts = 1_000L,
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
        const val MESSAGE_ID = "message-1"
    }
}
