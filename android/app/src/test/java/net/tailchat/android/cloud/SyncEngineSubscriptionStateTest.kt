package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The open conversation's subscription, as state the UI can react to.
 *
 * The composer's placeholder is decided by `state.subscribedPeer ==
 * state.selectedPeer` (`CloudScreen.kt`'s `CloudComposer(online = …)`). That
 * value used to be *sampled* out of a private engine field whenever the
 * transcript flow emitted — and the transcript flow emits when rows change,
 * which is before the `subscribed` ack comes back and never again in a
 * conversation nothing writes to while it is open. Saved Messages is exactly
 * that conversation (already seeded, so `selectPeer` fetches no page, and the
 * peer is this account, so no incoming traffic ever lands): the hint stayed on
 * «Message · will send when connected» for the whole visit, GitHub issue #6.
 *
 * So the subscription is published on [EphemeralState], which every state
 * emission already reads, and the ack is what writes it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineSubscriptionStateTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var engine: SyncEngine
    private lateinit var ephemeral: EphemeralState
    private lateinit var scope: CoroutineScope

    private val session
        get() = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    return MockResponse().setResponseCode(200).setBody("""{"messages":[],"peerReadTs":0}""")
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val peer = SUBSCRIBE.find(text)?.groupValues?.get(1)
                        when {
                            // The hub answers a self-subscription like any
                            // other: Saved Messages needs no friendship check
                            // (`hub.js`'s `isSelf`).
                            peer != null && peer.isNotEmpty() ->
                                webSocket.send("""{"k":"subscribed","peer":"$peer","online":true,"pending":0}""")
                            // An empty peer is the unsubscribe; the hub sends
                            // nothing back for it.
                            peer != null -> Unit
                            else -> webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
                                    """"users":[{"login":"anna","name":"Anna"}]}""",
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
            MediaCache(File.createTempFile("tailchat-subscription", "").apply { delete(); mkdirs() }),
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
    fun `the subscription ack reaches the state the composer reads`() = runBlocking {
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
        await { ephemeral.state.value.link == CloudLink.Online }

        // Saved Messages: the peer is this account itself.
        engine.setViewInterest("roman")
        await { ephemeral.state.value.subscribedPeer == "roman" }
        assertEquals("roman", ephemeral.state.value.subscribedPeer)

        // Back to the roster: the hub drops `conn.peer`, so nothing here may
        // still claim a subscription.
        engine.setViewInterest(null)
        await { ephemeral.state.value.subscribedPeer == null }
        assertNull(ephemeral.state.value.subscribedPeer)
    }

    private suspend fun await(timeoutMs: Long = 8_000, condition: suspend () -> Boolean) {
        val met = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(25)
            true
        }
        if (met != true) throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    private companion object {
        const val CLOCK = 10_000L
        val SUBSCRIBE = Regex("""\"k\":\"subscribe\",\"peer\":\"([^\"]*)\"""")
    }
}
