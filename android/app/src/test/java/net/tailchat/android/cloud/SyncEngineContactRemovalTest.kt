package net.tailchat.android.cloud

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.TailchatDatabase
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Deleting a contact is one-sided: the server drops the peer from *this*
 * account's roster and refuses frames between the pair, while keeping the
 * friendship and answering `messages: []` for that conversation forever.
 *
 * Two consequences this pins down, both of which re-create what the deletion
 * purged otherwise:
 *  - a complete roster without the open conversation is the signal this
 *    account's other devices learn the deletion from, so the engine reports it
 *    (`Listener.onContactRemoved`) rather than leaving a thread on screen that
 *    can never have content again;
 *  - a later feed event, wake or history page for that peer must not put the
 *    conversation row back — `applyHistoryPage`/`setUnreadSnapshot` both reach
 *    the row through `ConversationDao.touchPreview`, which inserts one on
 *    first sight of a peer.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineContactRemovalTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private lateinit var ephemeral: EphemeralState
    private lateinit var engine: SyncEngine
    private lateinit var scope: CoroutineScope
    private val removed = CopyOnWriteArrayList<String>()
    private var socket: WebSocket? = null
    private var historyRequests = 0
    private val session get() = CloudSession(server.url("/").toString(), "token", CloudUser("roman", "Roman"))

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.encodedPath == "/tailchat/api/history") {
                    historyRequests++
                    return MockResponse().setResponseCode(200).setBody(
                        """{"messages":[{"id":"h1","from":"anna","text":"old","ts":1000}]}""",
                    )
                }
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        socket = webSocket
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.contains("\"k\":\"auth\"")) {
                            // The complete roster this session opens with lists
                            // carol — never anna, whose absence is what every
                            // test here is about. Whatever else each frame
                            // does, this one is the world as the server sees it
                            // before anything is pushed on top.
                            webSocket.send(
                                """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
                                    """"users":[{"login":"carol","name":"Carol"}]}""",
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
            MediaCache(File.createTempFile("tailchat-contact-removal", "").apply { delete(); mkdirs() }),
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
                override fun onContactRemoved(peer: String) {
                    removed += peer
                    engine.setViewInterest(null)
                }
            },
            framePacer = FramePacer(),
            // The prefetch walk stays out of the way: what is under test here
            // is the interactive/wake path, not the background one.
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
    fun `the open conversation of a peer the roster dropped is reported for closing`() = runBlocking {
        engine.start(session)
        awaitOnline()
        engine.setViewInterest("anna")

        push("""{"k":"users","users":[]}""")

        awaitUntil("the roster without anna to be applied") { removed.contains("anna") }
    }

    @Test
    fun `a roster that still lists the peer leaves the conversation alone`() = runBlocking {
        engine.start(session)
        awaitOnline()
        engine.setViewInterest("anna")

        push("""{"k":"users","users":[$ANNA, $DAVE]}""")
        awaitUntil("the roster to be applied") { repo.conversation(accountKeyOf(session), "dave") != null }

        assertEquals(emptyList<String>(), removed)
    }

    @Test
    fun `a wake for a contact the roster dropped stores nothing and fetches nothing`() = runBlocking {
        val key = accountKeyOf(session)
        engine.start(session)
        awaitOnline()

        // A complete roster from the server with nobody this device knows in
        // it — the shape a deletion leaves behind.
        push("""{"k":"users","users":[]}""")
        awaitRosterApplied()
        assertNull("nothing is on screen for anna", repo.conversation(key, "anna"))

        assertTrue(
            "a wake whose fetch can only come back empty is done, not retried",
            engine.processPushOnce("anna", "h1", accountScopeOf(session)),
        )

        assertNull("no message row", repo.message(key, "anna", "h1"))
        assertNull("and no conversation row to hold it", repo.conversation(key, "anna"))
        assertEquals("the server was not asked for a page it cannot have", 0, historyRequests)
    }

    @Test
    fun `a live message from a contact the roster dropped is not stored`() = runBlocking {
        val key = accountKeyOf(session)
        engine.start(session)
        awaitOnline()
        awaitRosterApplied()

        push("""{"k":"frame","from":"anna","d":{"t":"msg","id":"late","text":"were you there?","ts":2000}}""")

        // The barrier is the two frames below, not a sleep: one socket applies
        // its frames in order, so the roster that names anna again followed by
        // a stored row for "later" means "late" was already decided.
        push("""{"k":"users","users":[$ANNA]}""")
        push("""{"k":"frame","from":"anna","d":{"t":"msg","id":"later","text":"back","ts":3000}}""")
        awaitUntil("the second message to land") { repo.message(key, "anna", "later") != null }

        assertNull("a message from a deleted contact is not delivered", repo.message(key, "anna", "late"))
        assertNotNull("while the same peer, once listed again, is delivered normally", repo.message(key, "anna", "later"))
    }

    @Test
    fun `a deletion made here stops the feed before the broadcast arrives`() = runBlocking {
        val key = accountKeyOf(session)
        engine.start(session)
        awaitOnline()
        // A roster that lists anna, so the `forgetPeer` below is the only thing
        // that can drop her: the opening one names carol alone.
        push("""{"k":"users","users":[$ANNA]}""")
        awaitUntil("anna to be listed") { repo.conversation(key, "anna") != null }

        // What `ServiceCloudController.removeContact` does on the server's
        // answer, before the `k:"users"` frame that carries the same fact has
        // had time to arrive.
        engine.forgetPeer("anna")
        push("""{"k":"frame","from":"anna","d":{"t":"msg","id":"stale","text":"old copy","ts":2000}}""")

        push("""{"k":"users","users":[$DAVE]}""")
        awaitUntil("the roster pushed after it") { repo.conversation(key, "dave") != null }

        assertNull("a frame for a just-deleted contact is not stored", repo.message(key, "anna", "stale"))
    }

    private suspend fun awaitOnline() {
        awaitUntil("the socket to come up") { ephemeral.state.value.link == CloudLink.Online }
        awaitUntil("the session to be dialled") { socket != null }
    }

    /**
     * A roster naming dave — someone no other assertion here touches — and
     * then dave's own row as the bar: the engine applies one socket's frames in
     * order, so a row for him is proof that every frame pushed before him has
     * been processed too.
     */
    private suspend fun awaitRosterApplied() {
        push("""{"k":"users","users":[$DAVE]}""")
        awaitUntil("the roster pushed after it") { repo.conversation(accountKeyOf(session), "dave") != null }
    }

    private fun push(frame: String) {
        val live = socket ?: throw IllegalStateException("the socket never opened")
        assertTrue("the frame was not handed to the socket", live.send(frame))
    }

    private suspend fun awaitUntil(what: String, condition: suspend () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            delay(20)
        }
        fail("timed out waiting for $what")
    }

    private companion object {
        /** Roster entries as `k:"users"` carries them. */
        const val ANNA = """{"login":"anna","name":"Anna"}"""
        const val DAVE = """{"login":"dave","name":"Dave"}"""
    }
}
