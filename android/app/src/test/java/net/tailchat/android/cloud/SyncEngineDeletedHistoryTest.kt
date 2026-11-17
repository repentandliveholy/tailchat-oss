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
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A message deleted from another client while this one was closed.
 *
 * `/api/history` is asked for deleted records on purpose (`deleted=1`), so the
 * page that seeds a freshly opened conversation contains the tombstone: an
 * empty `text` with `deletedAt` set (`accounts.js`'s `applyTombstoneMutation`).
 * Both halves of what the device then shows hang on that flag surviving the
 * trip into Room — the transcript hides tombstoned rows
 * (`CloudScreen`'s `state.messages.filter { … it.deletedAt == null }`) and the
 * roster preview must keep naming the newest message that still exists.
 *
 * `CloudMessage.toEntity` used to hard-code `deletedAt = null`, so the record
 * landed as an ordinary message whose text happened to be empty: the deleted
 * message reappeared on first open as a bubble with nothing in it, and — since
 * `updatePreview` only moves forward — its empty preview outranked the live
 * message behind it for good.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineDeletedHistoryTest {
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
                        """{"messages":[""" +
                            """{"id":"m-live","from":"anna","text":"hi","ts":4000,"author":"Anna"},""" +
                            """{"id":"m-gone","from":"roman","text":"","ts":5000,"author":"Roman","deletedAt":5001}""" +
                            """],"peerReadTs":0}""",
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
            MediaCache(File.createTempFile("tailchat-deleted-history", "").apply { delete(); mkdirs() }),
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
    fun `a deleted record in a history page stays deleted on this device`() = runBlocking {
        val key = account
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

        // `markSeeded` is the last write of `applyHistoryPage`'s own
        // transaction, so the flag being up means the rows and the preview it
        // wrote are committed too — nothing below races the page.
        await(timeoutMs = 8_000) { repo.conversation(key, "anna")?.historySeeded == true }

        assertNotNull(
            "the tombstone must survive the trip into Room, or the transcript renders an empty bubble",
            repo.message(key, "anna", "m-gone")?.deletedAt,
        )
        assertEquals(5001L, repo.message(key, "anna", "m-gone")?.deletedAt)
        assertEquals(
            "the roster preview must name the newest message that still exists",
            "hi",
            repo.conversation(key, "anna")?.previewText,
        )
    }

    private suspend fun await(timeoutMs: Long = 5_000, condition: suspend () -> Boolean) {
        val met = withTimeoutOrNull(timeoutMs) {
            while (!condition()) delay(25)
            true
        }
        if (met != true) throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    private companion object {
        const val CLOCK = 10_000L
    }
}
