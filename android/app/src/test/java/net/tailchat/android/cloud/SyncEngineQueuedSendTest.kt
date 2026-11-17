package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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
 * A send leaves through OkHttp's queue, and OkHttp reports the frame as written
 * the moment it is *enqueued* — so the acceptance deadline used to start
 * counting while a photo or a voice note was still going up a mobile uplink.
 * The acknowledgement cannot exist before the server has the frame, which means
 * a large send was expired mid-upload every time: the operation went back to
 * the queue, the whole attachment was uploaded again, and the bubble kept its
 * clock until eight attempts were spent and «не отправлено» appeared — the
 * ticks people report as missing, with a connection that looks like it keeps
 * dropping.
 *
 * [SyncEngine] therefore re-arms every pending deadline while the socket still
 * holds unsent bytes ([CloudSocket.Connection.queuedBytes]) and only retires an
 * operation once the frame has actually left. This pins both halves: queued
 * bytes keep the operation in flight and on the wire exactly once, and once
 * nothing is queued the same missed acknowledgement still retries, because the
 * rule protects an upload in progress, not a lost frame.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineQueuedSendTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope

    /** Every `msg` frame the mock server received, in order. */
    private val messageFrames = CopyOnWriteArrayList<String>()

    /** The mock server's side of the one connection, so a receipt can be sent
     *  as late as a slow uplink makes it. */
    private var liveSocket: WebSocket? = null

    /** The engine's view of the socket's unsent bytes, and its clock: both are
     *  arguments here so the rule is measured instead of raced. */
    private var queued = 0L
    private var lapseMs = 0L
    private val now get() = CLOCK + lapseMs

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.contains("\"t\":\"msg\"")) messageFrames += text
                        if (text.contains("\"k\":\"auth\"")) liveSocket = webSocket
                        // Deliberately no `message-accepted`: a lost receipt is
                        // what the deadlines below are about.
                        if (text.contains("\"k\":\"auth\"")) {
                            webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[],""" +
                                    """"caps":["durable-ack","sync-v1","addressed-send","read-ack-v1","op-ack-v1"]}""",
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
            MediaCache(File.createTempFile("tailchat-queued-send", "").apply { delete(); mkdirs() }),
        ) { now }
        scope = CoroutineScope(Dispatchers.Unconfined)
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
            clock = { now },
            queuedBytes = { queued },
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

    private suspend fun await(label: String, timeoutMs: Long = 5_000, condition: suspend () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("$label not reached within ${timeoutMs}ms", settled == true)
    }

    @Test
    fun `a receipt that arrives after a slow upload still lands`() = runBlocking {
        val key = accountKeyOf(session)
        repo.enqueueMessage(ownMessage(key, "m-photo"), pendingSend(key, "m-photo"))

        engine.start(session)
        await("online") { ephemeral.state.value.link == CloudLink.Online }
        await("the frame is out") { messageFrames.size == 1 }

        // The frame is large and the uplink is slow, so OkHttp is still holding
        // it. The clock is run at a hundred times real time for three seconds,
        // which covers far more than the acceptance deadline (ACK_TIMEOUT_MS)
        // and the operation's own lease (LEASE_MS) — every pump pass in this
        // state used to retire the operation and hand the lease back, so the
        // receipt the server eventually sent had nothing left to settle: the
        // message kept its clock while the same bytes were re-uploaded.
        queued = 4_000_000L
        val lapse = launch {
            while (isActive) {
                delay(20)
                lapseMs += 2_000
            }
        }
        delay(3_000)
        lapse.cancel()

        assertEquals(
            "a frame that has not left the socket cannot have been answered: it goes out once",
            1,
            messageFrames.size,
        )
        assertEquals("and the operation is still the one queue entry", 1, repo.pendingCount(key).first())
        assertTrue("the clock really did run past the deadline and the lease", now > CLOCK + 2 * 60_000L)

        // The upload finishes and the server answers, as it does: the frame was
        // on the wire, so the receipt is the proof the person is waiting for.
        queued = 0L
        liveSocket?.send(
            """{"k":"message-accepted","peer":"peer","id":"m-photo","ts":1000,"seq":7}""",
        )

        await("accepted") { repo.message(key, "peer", "m-photo")?.deliveryState == DeliveryState.Accepted }
        await("queue drained") { repo.pendingCount(key).first() == 0 }
        assertEquals("and nothing was sent a second time", 1, messageFrames.size)
    }

    private val session
        get() = CloudSession(
            server = server.url("/").toString(),
            token = "token-1",
            user = CloudUser("roman", "Roman"),
        )

    private fun ownMessage(key: String, id: String) = MessageEntity(
        accountKey = key,
        peer = "peer",
        id = id,
        text = "photo",
        ts = 1_000L,
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
        peer = "peer",
        kind = OperationKind.MESSAGE,
        messageId = messageId,
        payloadJson = Payloads.messagePayload(
            text = "photo",
            ts = 1_000L,
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
        // Due immediately: this test is about the deadlines after the write,
        // not about the queue's own backoff.
        nextAttemptAt = CLOCK,
        lastError = null,
        errorKind = ErrorKind.None.ordinal,
        leaseOwner = null,
        leaseUntil = 0L,
        createdAt = CLOCK,
    )

    private companion object {
        const val CLOCK = 10_000L
    }
}
