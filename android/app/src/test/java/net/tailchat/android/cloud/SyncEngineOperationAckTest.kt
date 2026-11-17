package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.ErrorKind
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.Payloads
import net.tailchat.android.data.PendingOperationEntity
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
class SyncEngineOperationAckTest {
    private data class ReceivedOperation(val kind: String, val id: String, val opId: String)

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    private val clock = AtomicLong(1_000L)
    private val declareAck = AtomicBoolean(true)
    private val received = CopyOnWriteArrayList<ReceivedOperation>()
    private val serverSocket = AtomicReference<WebSocket>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val payload = Json.parseToJsonElement(text).jsonObject
                        when (payload["k"]?.jsonPrimitive?.content) {
                            "auth" -> {
                                val caps = if (declareAck.get()) {
                                    "\"durable-ack\",\"sync-v1\",\"addressed-send\",\"op-ack-v1\""
                                } else {
                                    "\"durable-ack\",\"sync-v1\",\"addressed-send\""
                                }
                                webSocket.send(
                                    """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[],"caps":[$caps]}""",
                                )
                            }
                            "frame" -> {
                                val frame = payload["d"]?.jsonObject ?: return
                                val kind = frame["t"]?.jsonPrimitive?.content ?: return
                                if (kind !in setOf("edit", "react", "del")) return
                                val id = if (kind == "del") {
                                    frame["ids"]?.jsonArray?.firstOrNull()?.jsonPrimitive?.content ?: return
                                } else {
                                    frame["id"]?.jsonPrimitive?.content ?: return
                                }
                                val opId = frame["opId"]?.jsonPrimitive?.content ?: return
                                serverSocket.set(webSocket)
                                received += ReceivedOperation(
                                    kind = if (kind == "del") "delete" else kind,
                                    id = id,
                                    opId = opId,
                                )
                            }
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
            MediaCache(File.createTempFile("tailchat-op-ack-media", "").apply { delete(); mkdirs() }),
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
            kotlinx.coroutines.runBlocking { job.join() }
        }
        db.close()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    @Test
    fun `correlated acknowledgements settle only their exact mutation`() = runBlocking {
        val key = accountKeyOf(session())
        val operations = listOf(
            operation(key, "edit-op", "edit", Payloads.editPayload("changed")),
            operation(key, "react-thumb", "react", Payloads.reactPayload("👍", true)),
            operation(key, "react-fire", "react", Payloads.reactPayload("🔥", true)),
            operation(key, "delete-op", "delete", Payloads.deletePayload("self")),
        )
        for (operation in operations) repo.enqueueOperation(operation)
        start()
        await { received.size == operations.size }

        assertEquals(operations.map { it.opId }.toSet(), received.map { it.opId }.toSet())
        assertEquals(operations.map { it.opId }.toSet(), repo.operations(key).map { it.opId }.toSet())

        serverSocket.get().send(opAccepted("react", "react-thumb"))
        awaitOperationGone("react-thumb")
        assertTrue("an ack for one reaction consumed its sibling", repo.operation("react-fire") != null)

        serverSocket.get().send(opAccepted("edit", "edit-op", peer = "mallory"))
        delay(200)
        assertTrue("an ack for another peer consumed the edit", repo.operation("edit-op") != null)

        serverSocket.get().send(opAccepted("edit", "edit-op"))
        serverSocket.get().send(opAccepted("react", "react-fire"))
        serverSocket.get().send(opAccepted("delete", "delete-op"))
        val empty = withTimeoutOrNull(3_000) {
            while (repo.operations(key).isNotEmpty()) delay(10)
            true
        }
        assertTrue("not every matching acknowledgement settled", empty == true)
    }

    @Test
    fun `legacy server keeps successful-write completion behavior`() = runBlocking {
        declareAck.set(false)
        val key = accountKeyOf(session())
        repo.enqueueOperation(operation(key, "legacy-edit", "edit", Payloads.editPayload("changed")))

        start()
        await { received.any { it.opId == "legacy-edit" } }
        val gone = withTimeoutOrNull(3_000) {
            while (repo.operation("legacy-edit") != null) delay(10)
            true
        }
        assertTrue("legacy operation waited for an acknowledgement the server cannot send", gone == true)
    }

    @Test
    fun `missing operation acknowledgement releases the lease with retryable backoff`() = runBlocking {
        val key = accountKeyOf(session())
        repo.enqueueOperation(operation(key, "edit-timeout", "edit", Payloads.editPayload("changed")))
        start()
        await { received.any { it.opId == "edit-timeout" } }
        clock.set(22_000L)

        val retried = withTimeoutOrNull(3_000) {
            while (repo.operation("edit-timeout")?.lastError != "no_operation_ack") delay(10)
            repo.operation("edit-timeout")
        }
        assertTrue("operation ack deadline never released the lease", retried != null)
        assertEquals(1, retried?.attempts)
        assertEquals(ErrorKind.Retryable.ordinal, retried?.errorKind)
        assertTrue("retry must be delayed by backoff", retried!!.nextAttemptAt > clock.get())
    }

    private suspend fun start() {
        engine.start(session())
        await { ephemeral.state.value.link == CloudLink.Online }
    }

    private suspend fun awaitOperationGone(opId: String) {
        val gone = withTimeoutOrNull(3_000) {
            while (repo.operation(opId) != null) delay(10)
            true
        }
        assertTrue("operation $opId remained pending", gone == true)
        assertNull(repo.operation(opId))
    }

    private suspend fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms", settled == true)
    }

    private fun operation(
        accountKey: String,
        opId: String,
        kind: String,
        payload: String,
    ) = PendingOperationEntity(
        opId = opId,
        accountKey = accountKey,
        peer = PEER,
        kind = kind,
        messageId = MESSAGE_ID,
        payloadJson = payload,
        attempts = 0,
        nextAttemptAt = clock.get(),
        lastError = null,
        errorKind = ErrorKind.None.ordinal,
        leaseOwner = null,
        leaseUntil = 0,
        createdAt = clock.get(),
    )

    private fun opAccepted(kind: String, opId: String, peer: String = PEER) =
        """{"k":"op-accepted","peer":"$peer","opKind":"$kind","id":"$MESSAGE_ID","opId":"$opId"}"""

    private fun session() = CloudSession(
        server = server.url("/").toString(),
        token = "token-1",
        user = CloudUser("roman", "Roman"),
    )

    private companion object {
        const val PEER = "bob"
        const val MESSAGE_ID = "message-1"
    }
}
