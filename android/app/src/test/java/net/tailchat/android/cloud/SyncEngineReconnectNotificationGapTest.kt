package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.SupervisorJob
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.DeliveryState
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * User report: a message that arrived while the socket was down, and which
 * push never delivered either (FCM misconfigured, quota, or simply absent),
 * produced no notification at all once the app reconnected — `applyEvent`'s
 * "message" branch for an unknown id only called `markConversationUnseeded`,
 * the resumable `sync`/`sync-page` catch-up feed (`LOCAL_FIRST_CONTRACT.md`
 * §1.3) has no content of its own to show, and the live `onUnread` envelope
 * that normally covers this only reaches connections subscribed *right now*
 * — not one that was offline for the whole gap and is only now replaying
 * missed history. This drives the same mock-server harness as
 * `SyncEnginePushNotificationTest` but through the reconnect/resync path
 * instead of a push: `ready` advertises `sync-v1`, and the socket answers the
 * engine's own `{k:"sync"}` catch-up request with one `sync-page` event for a
 * message this fresh account has never seen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineReconnectNotificationGapTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope
    private lateinit var ephemeral: EphemeralState
    private val notifications = CopyOnWriteArrayList<CloudUnreadNotification>()
    private val session get() = CloudSession(server.url("/").toString(), "token", CloudUser("roman", "Roman"))

    /** What `/api/history` answers with; a test overrides it before `start`. */
    private var historyBody = """{"messages":[{"id":"m1","from":"anna","text":"missed while offline","ts":5000}]}"""
    private val refuseNextHistory = AtomicBoolean(false)
    private val historyRequests = AtomicInteger()

    /** The one `sync-page` this socket replays for any `{k:"sync"}`. */
    private var syncBody = """{"k":"sync-page","events":[
        {"seq":1,"kind":"message","peer":"anna","id":"m1","ts":5000,"self":false}
    ],"cursor":1,"more":false,"reset":false}"""

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    historyRequests.incrementAndGet()
                    if (refuseNextHistory.getAndSet(false)) return MockResponse().setResponseCode(503).setBody("{}")
                    return MockResponse().setResponseCode(200).setBody(historyBody)
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        when {
                            text.contains("\"k\":\"auth\"") -> webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},
                                    "users":[{"login":"anna","name":"Anna"}],"caps":["sync-v1"]}""",
                            )
                            text.contains("\"k\":\"sync\"") -> webSocket.send(syncBody)
                            // Everything else this client sends after auth
                            // (capability pings, presence, …) is not part of
                            // this scenario; answering it would re-trigger
                            // `onReady`'s own resync and loop forever.
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
            MediaCache(File.createTempFile("tailchat-resync-media", "").apply { delete(); mkdirs() }),
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
    }

    @After
    fun tearDown() {
        engine.close()
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
    fun `a message missed while the socket was down is backfilled and alerted on reconnect`() = runBlocking {
        engine.start(session)
        await { notifications.isNotEmpty() }

        assertEquals(listOf("m1"), notifications.map { it.messageId })
        assertEquals("missed while offline", repo.message(accountKeyOf(session), "anna", "m1")?.text)
    }

    @Test
    fun `the same gap is not alerted while that conversation is already open`() = runBlocking {
        engine.setViewInterest("anna")
        engine.setForeground(true)
        engine.start(session)
        await { repo.message(accountKeyOf(session), "anna", "m1") != null }

        assertTrue("the open screen is the honest signal, not a second alert", notifications.isEmpty())
        // The content still has to reach the screen that is open on it.
        assertEquals("missed while offline", repo.message(accountKeyOf(session), "anna", "m1")?.text)
    }

    @Test
    fun `an older message already present for that peer does not block fetching the missed newer one`() = runBlocking {
        val key = accountKeyOf(session)
        // The bug this guards: `newestIncoming(peer) != null` was read as
        // "nothing is missing for this peer" and skipped the fetch entirely
        // — true only when the *specific* missing id happens to be the
        // newest one. Here it never is: m0 already sits in Room, untouched,
        // before the sync feed ever mentions the actually-missing m1.
        repo.applyIncoming(
            key, "anna",
            MessageEntity(
                accountKey = key, peer = "anna", id = "m0", text = "already here", ts = 1_000L,
                author = "anna", mine = false, delivery = DeliveryState.Delivered.ordinal, system = false,
                kind = MessageKind.TEXT, imageDataUrl = null, imageWidth = null, imageHeight = null,
                voiceDataUrl = null, voiceDurationSec = null, reactionsJson = null, replyJson = null,
                forwardJson = null, editedAt = null, deletedAt = null, serverSeq = null,
            ),
            countUnread = false,
        )

        engine.start(session)
        await { notifications.isNotEmpty() }

        assertEquals(listOf("m1"), notifications.map { it.messageId })
        assertEquals("missed while offline", repo.message(key, "anna", "m1")?.text)
        assertEquals("already here", repo.message(key, "anna", "m0")?.text)
    }

    /**
     * User report: «то, что в вебе написал, перестало приходить в APK» — and a
     * restart of the app did not help either. A message written on another
     * device of the same account arrives in the catch-up feed as `self:true`,
     * and `applyEvent` read that flag as "this device already has it" — the
     * same reading that makes `settle` correct for a message this device
     * actually sent. For a copy written elsewhere the id is unknown locally,
     * so nothing was fetched: own-device copies are never queued server-side
     * (`hub.js`'s `deliverFrame` queues per recipient login) and reach another
     * device only live, on a subscription to exactly this conversation, or
     * through a push wake-up. A phone whose socket was down for that second
     * showed nothing, in the open conversation or after a relaunch, until the
     * conversation was left and re-opened — which is not what «reopening the
     * app» does.
     */
    @Test
    fun `a message written on another device of this account is fetched on reconnect`() = runBlocking {
        historyBody = """{"messages":[{"id":"m1","from":"roman","text":"written in the web","ts":5000}]}"""
        syncBody = """{"k":"sync-page","events":[
            {"seq":1,"kind":"message","peer":"anna","id":"m1","ts":5000,"self":true}
        ],"cursor":1,"more":false,"reset":false}"""
        val key = accountKeyOf(session)

        engine.start(session)
        await { repo.message(key, "anna", "m1") != null }

        assertEquals("written in the web", repo.message(key, "anna", "m1")?.text)
        assertTrue(
            "the person wrote it themselves — the fetch is owed, an alert is not",
            notifications.isEmpty(),
        )
    }

    /** The same copy, with the conversation on screen the whole time. */
    @Test
    fun `the copy from another device reaches the conversation already open`() = runBlocking {
        historyBody = """{"messages":[{"id":"m1","from":"roman","text":"written in the web","ts":5000}]}"""
        syncBody = """{"k":"sync-page","events":[
            {"seq":1,"kind":"message","peer":"anna","id":"m1","ts":5000,"self":true}
        ],"cursor":1,"more":false,"reset":false}"""
        val key = accountKeyOf(session)

        engine.setViewInterest("anna")
        engine.setForeground(true)
        engine.start(session)
        await { repo.message(key, "anna", "m1") != null }

        assertEquals("written in the web", repo.message(key, "anna", "m1")?.text)
        assertTrue(notifications.isEmpty())
    }

    @Test
    fun `an open history load refused before restart is retried even with an empty feed`() = runBlocking {
        syncBody = """{"k":"sync-page","events":[],"cursor":0,"more":false,"reset":false}"""
        refuseNextHistory.set(true)
        engine.start(session)
        await { ephemeral.state.value.link == CloudLink.Online }
        engine.setViewInterest("anna")
        engine.refreshHistory("anna")
        await { historyRequests.get() == 1 }
        assertEquals(null, repo.message(accountKeyOf(session), "anna", "m1"))

        engine.reconnectNow()
        await { repo.message(accountKeyOf(session), "anna", "m1") != null }
        assertEquals("missed while offline", repo.message(accountKeyOf(session), "anna", "m1")?.text)
        assertEquals(true, repo.conversation(accountKeyOf(session), "anna")?.historySeeded)
    }

    private suspend fun await(timeoutMs: Long = 5_000, condition: suspend () -> Boolean) {
        val settled = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(10)
            true
        }
        assertTrue("condition never became true within ${timeoutMs}ms", settled == true)
    }
}
