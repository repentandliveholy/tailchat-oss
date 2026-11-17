package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.ErrorKind
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.MessageEntity
import net.tailchat.android.data.MessageKind
import net.tailchat.android.data.OperationKind
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A send whose acceptance frame never came back — the socket was replaced
 * mid-flight, the app was killed right after the tap, or the hub's frame
 * budget dropped the frame (`hub.js`'s `chargeFrame`) — leaves its row on the
 * clock with a replayable operation behind it. `/api/history` is a third,
 * independent proof that the server holds the message, and `loadHistory` is
 * the one caller that has it: `acceptByServerProof` clears the queue and
 * raises the row on the strength of the server's own copy.
 *
 * Release 131 dropped that call — the statement went while the local variable
 * it fed stayed, so nothing failed to compile and no test covered the call
 * site (`ChatRepositoryTest.serverProofClearsTheQueueAndRaisesDelivery` drives
 * the repository method directly, which still passes). What is left with the
 * call gone is a queue entry that is replayed at every `pump()` for a message
 * the server already committed, answered each time with the receipt the
 * original send missed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineHistoryAcceptanceTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var ephemeral: EphemeralState
    private lateinit var scope: CoroutineScope

    private val session
        get() = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))
    private val account get() = accountKeyOf(session)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    return MockResponse().setResponseCode(200).setBody(
                        """{"messages":[{"id":"m-own","from":"roman","text":"hi","ts":4000}],"peerReadTs":0}""",
                    )
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        webSocket.send(
                            """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
                                """"users":[{"login":"anna","name":"Anna"}]}""",
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
            MediaCache(File.createTempFile("tailchat-history-acceptance", "").apply { delete(); mkdirs() }),
        ) { CLOCK }
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
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
    fun `a history page clears the queue for a send the server already holds`() = runBlocking {
        val key = account
        // The message as the sender left it: on the clock, with the operation
        // that has not been answered yet. `nextAttemptAt` is in the future so
        // the scenario under test is the page, not a `pump()` retry that would
        // have cleaned up by itself.
        repo.enqueueMessage(ownMessage(key, "m-own"), pendingSend(key, "m-own"))
        assertEquals(1, repo.pendingCount(key).first())

        ephemeral = EphemeralState(scope)
        engine = SyncEngine(
            repository = repo,
            api = CloudApi(client),
            socket = CloudSocket(client),
            scope = scope,
            ephemeral = ephemeral,
            listener = object : SyncEngine.Listener {},
            framePacer = FramePacer(),
            cacheEnabled = { true },
            clock = { CLOCK },
        )
        engine.start(session)

        // The outcome, not the page: `historySeeded` is written inside
        // `applyHistoryPage`, while the queue is cleared after it returns, so
        // waiting for the flag and then asserting the queue races the very
        // statement under test. With the call gone this never converges.
        await(timeoutMs = 8_000) {
            repo.pendingCount(key).first() == 0
        }

        assertTrue(
            "the fetch has to have happened for the queue to be cleared by it",
            repo.conversation(key, "anna")?.historySeeded == true,
        )
        assertEquals(
            DeliveryState.Accepted,
            repo.message(key, "anna", "m-own")?.deliveryState,
        )
    }

    private fun ownMessage(key: String, id: String) = MessageEntity(
        accountKey = key,
        peer = "anna",
        id = id,
        text = "hi",
        ts = 4_000L,
        author = "Roman",
        mine = true,
        delivery = DeliveryState.Queued.ordinal,
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

    private fun pendingSend(key: String, messageId: String) = PendingOperationEntity(
        opId = "send:$messageId",
        accountKey = key,
        peer = "anna",
        kind = OperationKind.MESSAGE,
        messageId = messageId,
        payloadJson = Payloads.messagePayload(
            text = "hi",
            ts = 4_000L,
            author = "Roman",
            imageDataUrl = null,
            imageWidth = null,
            imageHeight = null,
            voiceDataUrl = null,
            voiceDurationSec = null,
            replyId = null,
            replyFrom = null,
            replyText = null,
            replyMedia = null,
            forwardLogin = null,
            forwardName = null,
        ),
        attempts = 0,
        nextAttemptAt = CLOCK + 60_000L,
        lastError = null,
        errorKind = ErrorKind.None.ordinal,
        leaseOwner = null,
        leaseUntil = 0L,
        createdAt = CLOCK,
    )

    private suspend fun await(timeoutMs: Long = 5_000, condition: suspend () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(20)
            true
        }
        assertTrue("condition not reached within ${timeoutMs}ms", settled == true)
    }

    private companion object {
        const val CLOCK = 10_000L
    }
}
