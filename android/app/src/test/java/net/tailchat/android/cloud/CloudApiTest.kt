
package net.tailchat.android.cloud

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class CloudApiTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var api: CloudApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS).build()
        api = CloudApi(client)
    }

    @After
    fun tearDown() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    @Test
    fun registerUsesExistingServerContract() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"token":"token-1","user":{"login":"roman","name":"Roman"},"recoveryKey":"RECOVERY","cert":null}""",
            ),
        )

        val result = api.register(server.url("/").toString(), "roman", "secret", "Roman")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/register", request.path)
        assertEquals("POST", request.method)
        assertEquals("roman", body.getValue("login").jsonPrimitive.content)
        assertEquals("secret", body.getValue("password").jsonPrimitive.content)
        assertEquals("Roman", body.getValue("name").jsonPrimitive.content)
        assertEquals(JsonNull, body.getValue("pubKey"))
        assertEquals("token-1", result.session.token)
        assertEquals("roman", result.session.user.login)
        assertEquals("Roman", result.session.user.name)
        assertEquals("RECOVERY", result.recoveryKey)
    }

    @Test
    fun loginUsesExistingServerContract() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"token":"token-2","user":{"login":"roman","name":"Roman"},"cert":null}""",
            ),
        )

        val result = api.login(server.url("/").toString(), "roman", "secret")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/login", request.path)
        assertEquals("roman", body.getValue("login").jsonPrimitive.content)
        assertEquals("secret", body.getValue("password").jsonPrimitive.content)
        assertNull(body["name"])
        assertEquals(JsonNull, body.getValue("pubKey"))
        assertEquals("token-2", result.session.token)
        assertNull(result.recoveryKey)
    }

    @Test
    fun serverErrorCodeIsPreserved() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"error":"login_taken","message":"Этот логин уже занят."}""",
            ),
        )

        try {
            api.register(server.url("/").toString(), "roman", "secret", "Roman")
            fail("Expected CloudException")
        } catch (error: CloudException) {
            assertEquals("login_taken", error.code)
            assertEquals("Этот логин уже занят.", error.message)
        }
    }

    @Test
    fun normalizesSupportedServerFormsAndRejectsPaths() {
        assertEquals("https://example.com", CloudApi.normalizeServerUrl("example.com/tailchat/"))
        assertEquals("http://example.com:7683", CloudApi.normalizeServerUrl("http://example.com:7683/"))
        assertNull(CloudApi.normalizeServerUrl("https://example.com/other"))
        assertNull(CloudApi.normalizeServerUrl("ftp://example.com"))
    }

    /**
     * The link is what a person actually hands over — pasted whole into "Add a
     * friend" on any client, each of which pulls the code back out of it — so it
     * has to be the shape the web client prints (`web/cloud/app.js`:
     * `${location.origin}/tailchat/?invite=…`) and sit on the normalised origin:
     * a server typed without a scheme, or with `/tailchat` already in it, must
     * land on that same origin rather than a doubled path.
     */
    @Test
    fun inviteUrlBuildsTheLinkTheWebClientPrints() {
        val code = "0123456789abcdef".repeat(4)

        assertEquals(
            "https://cloud.example.test/tailchat/?invite=$code",
            CloudApi.inviteUrl("https://cloud.example.test", code),
        )
        // The address a person types at sign-in, as it was typed.
        assertEquals(
            "https://cloud.example.test/tailchat/?invite=$code",
            CloudApi.inviteUrl("https://cloud.example.test/tailchat/", code),
        )
        assertEquals(
            "https://cloud.example.test:7683/tailchat/?invite=$code",
            CloudApi.inviteUrl("cloud.example.test:7683", code),
        )
        // An address this client refuses is not silently dressed up into a link.
        assertNull(CloudApi.inviteUrl("https://cloud.example.test/other", code))
    }
    @Test
    fun historyUsesBearerAndMapsMessages() = runBlocking {
        server.enqueue(MockResponse().setBody(
            """{"messages":[{"id":"m-1","from":"anna","text":"hello","ts":1000,"kind":"human","author":"Anna"},{"id":"m-2","from":"roman","text":"","ts":2000,"kind":"human","author":"Roman","deletedAt":2001}],""" +
                """"peerReadTs":1000,"peerReadAt":9000,"peerReadVia":"android/450","peerDeliveredTs":800}""",
        ))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-history",
            user = CloudUser("roman", "Roman"),
        )

        val page = api.history(session, "anna")
        val messages = page.messages
        val request = server.takeRequest()

        assertEquals(
            "the page size is named rather than assumed: the paging walk decides " +
                "`nothing older` from a page shorter than this",
            "/tailchat/api/history?peer=anna&deleted=1&limit=200",
            request.path,
        )
        assertEquals("Bearer token-history", request.getHeader("Authorization"))
        assertEquals(2, messages.size)
        assertEquals(false, messages[0].mine)
        assertEquals(true, messages[1].mine)
        assertEquals("Anna", messages[0].author)
        assertEquals(2001L, messages[1].deletedAt)
        // The same answer explains the peer's read watermark: when it was
        // reached and from which client, both needed by the message menu and
        // neither derivable from `peerReadTs` alone.
        assertEquals(1000L, page.peerReadTs)
        assertEquals(9000L, page.peerReadAt)
        assertEquals("android/450", page.peerReadVia)
        // The rung below the read watermark, delivered on the same answer.
        assertEquals(800L, page.peerDeliveredTs)
    }

    /** E3: an encrypted edit's carrier, the stub of an older server or the tombstone of a
     *  newer one, is held as a tombstone, so the id is found and nothing is drawn. */
    @Test
    fun historyHoldsAnEditCarrierAsATombstone() = runBlocking {
        server.enqueue(MockResponse().setBody(
            """{"messages":[{"id":"e-stub","from":"anna","text":"stub","ts":1000,"kind":"human","sealedEdit":true},""" +
                """{"id":"e-tomb","from":"anna","text":"","ts":2000,"kind":"human","deletedAt":2000,"sealedEdit":true},""" +
                """{"id":"m-1","from":"anna","text":"hello","ts":3000,"kind":"human"}],"peerReadTs":0}""",
        ))
        val session = CloudSession(server.url("/").toString(), "t", CloudUser("roman", "Roman"))

        val byId = api.history(session, "anna").messages.associateBy { it.id }

        assertEquals(1000L, byId.getValue("e-stub").deletedAt)
        assertEquals("", byId.getValue("e-stub").text)
        assertEquals(2000L, byId.getValue("e-tomb").deletedAt)
        assertNull(byId.getValue("m-1").deletedAt)
        assertEquals("hello", byId.getValue("m-1").text)
    }

    /**
     * Walking back needs both halves of the boundary: `before` for the bulk of
     * the walk and `beforeId` for the page edge, because a burst of messages
     * queued while offline routinely shares one timestamp and a bare timestamp
     * would either repeat that page forever or step over it.
     */
    @Test
    fun historyPagesBackWithBothHalvesOfTheBoundary() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"messages":[],"peerReadTs":0}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-page",
            user = CloudUser("roman", "Roman"),
        )

        val page = api.history(session, "anna", limit = 200, before = 1000L, beforeId = "m-edge")
        val request = server.takeRequest()

        assertEquals(
            "/tailchat/api/history?peer=anna&deleted=1&limit=200&before=1000&beforeId=m-edge",
            request.path,
        )
        assertEquals(
            "an older server has no delivered watermark; that is unknown, not zero",
            0L,
            page.peerDeliveredTs,
        )
    }

    /**
     * A page with inline media is tens of megabytes, and the shared client's eight-second
     * `callTimeout` budgets the *whole* call — headers and body. On a link slower than the
     * page, every attempt aborts at the same point and the conversation never fills in:
     * the history read needs its own budget (no total, a per-read one) so a slow but
     * progressing download is allowed to finish.
     *
     * The body below takes about four seconds to arrive while the client it is given
     * allows only 1.5 s for the entire call — the old wiring therefore fails this test
     * with `unreachable`, and a regression to the shared client fails it again.
     */
    @Test
    fun historySurvivesABodyThatOutlastsTheSharedCallBudget() = runBlocking {
        val filler = "x".repeat(2 * 1024 * 1024)
        val body = """{"messages":[{"id":"m-big","from":"anna","text":"$filler","ts":1000}],"peerReadTs":0}"""
        server.enqueue(
            MockResponse()
                .throttleBody(512 * 1024, 1, TimeUnit.SECONDS)
                .setBody(body),
        )
        val impatientClient = OkHttpClient.Builder().callTimeout(1500, TimeUnit.MILLISECONDS).build()
        try {
            val impatient = CloudApi(impatientClient)
            val session = CloudSession(server.url("/").toString(), "token-slow", CloudUser("roman", "Roman"))

            val page = impatient.history(session, "anna")

            assertEquals(1, page.messages.size)
            assertEquals(2 * 1024 * 1024, page.messages.single().text.length)
        } finally {
            impatientClient.dispatcher.executorService.shutdown()
            impatientClient.connectionPool.evictAll()
        }
    }

    /** A client that counts every body byte pulled off the response stream — a network
     *  interceptor, i.e. beneath everything [CloudApi] does with the body. */
    private fun countingClient(pulled: AtomicLong): OkHttpClient = client.newBuilder().addNetworkInterceptor { chain ->
        val response = chain.proceed(chain.request())
        val original = response.body!!
        val source = object : ForwardingSource(original.source()) {
            override fun read(sink: Buffer, byteCount: Long): Long =
                super.read(sink, byteCount).also { if (it > 0) pulled.addAndGet(it) }
        }.buffer()
        response.newBuilder().body(source.asResponseBody(original.contentType(), original.contentLength())).build()
    }.build()

    /**
     * The body is bounded, and exceeding the bound is its own failure code: a caller that
     * is told `too_large` asks again for a smaller page, while `unreachable` would put it
     * on the reconnect cadence and never make progress.
     *
     * A body of unannounced length (chunked here) is bounded *while reading*, not after:
     * the page is parsed from the stream, which refuses to go past the bound, so of a
     * megabyte-long body the client pulls off the connection only about the bound's worth.
     * Reading the whole body first (as a string, then a copy, then the tree) is what turned
     * a page that was merely too big into an `OutOfMemoryError`.
     */
    @Test
    fun historyRefusesAPageOverTheBodyBoundWithoutReadingTheRest() = runBlocking {
        val body = """{"messages":[{"id":"m-1","from":"anna","text":"${"x".repeat(1024 * 1024)}","ts":1}],"peerReadTs":0}"""
        server.enqueue(MockResponse().setChunkedBody(body, 16 * 1024))
        val pulled = AtomicLong()
        val bounded = CloudApi(countingClient(pulled), historyMaxBodyBytes = 8 * 1024)
        val session = CloudSession(server.url("/").toString(), "token-bound", CloudUser("roman", "Roman"))

        val error = try {
            bounded.history(session, "anna")
            null
        } catch (thrown: CloudException) {
            thrown
        }

        assertEquals("too_large", error?.code)
        assertTrue(
            "only about the bound is read off a ${body.length}-byte body, not all of it (read ${pulled.get()})",
            pulled.get() < 64 * 1024,
        )
    }

    /**
     * A page whose `Content-Length` (which the deployment always sends for `/history`)
     * is already over the bound is refused on its headers: not one byte of the body is
     * read. Each step down the halving ladder then costs a round trip, not the bound's
     * worth of a page that was never going to be accepted.
     */
    @Test
    fun historyRefusesAnAnnouncedOversizedPageOnItsHeaders() = runBlocking {
        val body = """{"messages":[{"id":"m-1","from":"anna","text":"${"x".repeat(1024 * 1024)}","ts":1}],"peerReadTs":0}"""
        server.enqueue(MockResponse().setBody(body))
        val pulled = AtomicLong()
        val bounded = CloudApi(countingClient(pulled), historyMaxBodyBytes = 8 * 1024)
        val session = CloudSession(server.url("/").toString(), "token-header", CloudUser("roman", "Roman"))

        val error = try {
            bounded.history(session, "anna")
            null
        } catch (thrown: CloudException) {
            thrown
        }

        assertEquals("too_large", error?.code)
        assertEquals("no body byte is read for a page refused by its length", 0L, pulled.get())
    }

    /** A body that stops halfway is `transfer_failed` — the page exists, it did not make it
     *  through — which the walk answers with a smaller page. Not a raw `IOException` that
     *  escapes every caller's `CloudException` handling. */
    @Test
    fun historyReportsABodyCutOffMidTransfer() = runBlocking {
        val body = """{"messages":[{"id":"m-1","from":"anna","text":"${"x".repeat(256 * 1024)}","ts":1}],"peerReadTs":0}"""
        server.enqueue(MockResponse().setBody(body).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val session = CloudSession(server.url("/").toString(), "token-cut", CloudUser("roman", "Roman"))

        val error = try {
            api.history(session, "anna")
            null
        } catch (thrown: CloudException) {
            thrown
        }

        assertEquals("transfer_failed", error?.code)
    }

    /**
     * The heap running out while a page is read is the page not fitting this device — the
     * same answer as a page over the bound, `too_large`, so the walk asks for less. It used
     * to be caught only around the parse of an already-materialised string; an
     * `OutOfMemoryError` from the read itself escaped as an `Error` and killed the walk
     * (and the sync pass that ran it). Raised here from inside the response stream.
     */
    @Test
    fun historyAnswersAnAllocationFailureWhileReadingAsTooLarge() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"messages":[],"peerReadTs":0}"""))
        val starving = client.newBuilder().addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val original = response.body!!
            val source = object : ForwardingSource(original.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long = throw OutOfMemoryError("test heap")
            }.buffer()
            response.newBuilder().body(source.asResponseBody(original.contentType(), original.contentLength())).build()
        }.build()
        val session = CloudSession(server.url("/").toString(), "token-oom", CloudUser("roman", "Roman"))

        val error = try {
            CloudApi(starving).history(session, "anna")
            null
        } catch (thrown: CloudException) {
            thrown
        }

        assertEquals("too_large", error?.code)
    }

    /**
     * Without a total call budget, the history call has to stop when its caller does: a
     * reconnect, a logout or a superseded walk cancels the coroutine, and the download
     * behind it must go with it rather than keep pulling tens of megabytes into a page
     * nobody will merge. `withContext(IO) { execute() }` alone does not do that — the
     * blocking read ignores the coroutine until the body ends (here: minutes).
     *
     * The proof is OkHttp's own `canceled` event for the call, and that the cancelled
     * caller finishes promptly instead of waiting out the body.
     */
    @Test
    fun cancellingAHistoryFetchAbortsTheCallMidBody() = runBlocking {
        val body = """{"messages":[{"id":"m-1","from":"anna","text":"${"x".repeat(4 * 1024 * 1024)}","ts":1}],"peerReadTs":0}"""
        server.enqueue(MockResponse().throttleBody(16 * 1024, 1, TimeUnit.SECONDS).setBody(body))
        val canceled = CountDownLatch(1)
        val watched = client.newBuilder().eventListener(object : EventListener() {
            override fun canceled(call: Call) = canceled.countDown()
        }).build()
        val session = CloudSession(server.url("/").toString(), "token-cancel", CloudUser("roman", "Roman"))
        val fetch = launch(Dispatchers.Default) { CloudApi(watched).history(session, "anna") }
        assertTrue("the request reached the server", server.takeRequest(5, TimeUnit.SECONDS) != null)
        delay(500) // the body is streaming now

        val finished = withTimeoutOrNull(3_000) { fetch.cancelAndJoin() }

        assertTrue("the cancelled caller is not held until the body ends", finished != null)
        assertTrue("the HTTP call itself was cancelled", canceled.await(1, TimeUnit.SECONDS))
        assertTrue(fetch.isCancelled)
    }

    /**
     * A voice note's duration is a number, not an integer: the CLI reports
     * `totalSamples / sampleRate` (`src/voice.js`), routinely fractional, and the server
     * keeps the float (`accounts.js`'s `normalizeMedia`). Read with `intOrNull` it answered
     * "not a number" and the whole voice payload was dropped — the message arrived as an
     * empty bubble with nothing to play. `0` is just as ordinary (web and CLI write it for
     * an unknown length; the server keeps `0..600`) and must not be dropped either. Every
     * finite value is kept: rounded like web/CLI round it, clamped like the live path.
     */
    @Test
    fun historyKeepsAVoiceNoteWhateverItsFiniteDuration() = runBlocking {
        val voice = """"dataUrl":"data:audio/wav;base64,QQ==""""
        server.enqueue(
            MockResponse().setBody(
                """{"messages":[""" +
                    """{"id":"m-frac","from":"anna","text":"","ts":1000,"voice":{$voice,"duration":3.46}},""" +
                    """{"id":"m-zero","from":"anna","text":"","ts":2000,"voice":{$voice,"duration":0}},""" +
                    """{"id":"m-zero-f","from":"anna","text":"","ts":3000,"voice":{$voice,"duration":0.0}},""" +
                    """{"id":"m-neg","from":"anna","text":"","ts":4000,"voice":{$voice,"duration":-1}}""" +
                    """],"peerReadTs":0}""",
            ),
        )
        val session = CloudSession(server.url("/").toString(), "token-voice", CloudUser("roman", "Roman"))

        val byId = api.history(session, "anna").messages.associateBy { it.id }

        assertEquals("3.46 s rounds to 3, as web and the CLI round it", 3, byId.getValue("m-frac").voice?.durationSec)
        assertEquals("0 is a voice note, at the live path's floor", 1, byId.getValue("m-zero").voice?.durationSec)
        assertEquals("0.0 likewise", 1, byId.getValue("m-zero-f").voice?.durationSec)
        assertEquals("a negative duration is clamped, not dropped", 1, byId.getValue("m-neg").voice?.durationSec)
    }

    /** An image's declared size is a number too, and `0` means "unknown" to `InlineImage`
     *  (a placeholder until decoded) — it must stay `0`, not become a one-pixel image. */
    @Test
    fun historyReadsImageDimensionsAsNumbersAndKeepsZero() = runBlocking {
        val image = """"dataUrl":"data:image/png;base64,QQ==""""
        server.enqueue(
            MockResponse().setBody(
                """{"messages":[""" +
                    """{"id":"m-frac","from":"anna","text":"","ts":1000,"image":{$image,"width":640.4,"height":480}},""" +
                    """{"id":"m-zero","from":"anna","text":"","ts":2000,"image":{$image,"width":0,"height":0}}""" +
                    """],"peerReadTs":0}""",
            ),
        )
        val session = CloudSession(server.url("/").toString(), "token-image", CloudUser("roman", "Roman"))

        val byId = api.history(session, "anna").messages.associateBy { it.id }

        assertEquals(640, byId.getValue("m-frac").image?.width)
        assertEquals(480, byId.getValue("m-frac").image?.height)
        assertEquals(0, byId.getValue("m-zero").image?.width)
        assertEquals(0, byId.getValue("m-zero").image?.height)
    }

    /**
     * The one rejection that is a request for more information rather than a
     * refusal: a protected account's primary password was proven correct and
     * the server names the second field it wants. The APK has to be able to
     * send it, or an account whose additional password was set in the browser
     * could never be signed into from a phone again.
     */
    @Test
    fun loginCarriesTheAdditionalPasswordAndOmitsItWhenThereIsNone() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"token":"token-3","user":{"login":"roman","name":"Roman"}}"""))
        val session = CloudSession(server.url("/").toString(), "token-3", CloudUser("roman", "Roman"))

        api.login(session.server, "roman", "secret", "дополнительный")
        val withExtra = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

        assertEquals("дополнительный", withExtra.getValue("extraPassword").jsonPrimitive.content)

        server.enqueue(MockResponse().setBody("""{"token":"token-4","user":{"login":"roman","name":"Roman"}}"""))
        api.login(session.server, "roman", "secret")
        val without = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

        // Absent, not empty: to an account that has one, `extraPassword: ""` is
        // a wrong additional password rather than "we have not asked yet".
        assertNull(without["extraPassword"])
    }

    @Test
    fun serverAnsweringExtraPasswordRequiredKeepsItsCode() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"extra_password_required"}"""))

        try {
            api.login("${server.url("/")}", "roman", "secret")
            fail("Expected CloudException")
        } catch (error: CloudException) {
            assertEquals(CloudApi.EXTRA_PASSWORD_REQUIRED, error.code)
        }
    }

    /**
     * `tailik` answers under the account owner's own login (`ai-bridge.js`'s
     * `ack()` defaults `from` to the owner) and is told apart only by
     * `kind:"ai"` — the owner's own device reading `from` alone would render
     * the bot's reply as its own outgoing message.
     */
    @Test
    fun anAiRecordFromTheOwnersOwnLoginIsNotMine() = runBlocking {
        server.enqueue(MockResponse().setBody(
            """{"messages":[{"id":"m-ai","from":"roman","text":"tailik says hi","ts":1000,"kind":"ai","author":"tailik"}]}""",
        ))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-ai",
            user = CloudUser("roman", "Roman"),
        )

        val messages = api.history(session, "roman").messages

        assertEquals(false, messages[0].mine)
        assertEquals("tailik", messages[0].author)
    }

    /**
     * `history()` (`src/cloud/accounts.js:1160`) returns reactions, the reply
     * snapshot and `editedAt` to every client, not only to the browser — so a
     * thread reopened on a phone has to come back with its badges and quotes
     * rather than as bare text.
     */
    @Test
    fun historyRestoresReactionsRepliesAndEdits() = runBlocking {
        server.enqueue(MockResponse().setBody(
            """{"messages":[{"id":"m-1","from":"anna","text":"hello","ts":1000,"kind":"human","author":"Anna",""" +
                """"reactions":{"👍":["roman","anna"],"🔥":["anna"]},"editedAt":1500},""" +
                """{"id":"m-2","from":"roman","text":"hi","ts":2000,"kind":"human","author":"Roman",""" +
                """"replyTo":{"id":"m-1","from":"anna","text":"hello","media":"voice"}}]}""",
        ))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-history",
            user = CloudUser("roman", "Roman"),
        )

        val messages = api.history(session, "anna").messages
        server.takeRequest()

        assertEquals(listOf("roman", "anna"), messages[0].reactions["👍"])
        assertEquals(listOf("anna"), messages[0].reactions["🔥"])
        assertEquals(1500L, messages[0].editedAt)
        assertNull(messages[1].editedAt)
        assertEquals("m-1", messages[1].replyTo?.id)
        assertEquals("voice", messages[1].replyTo?.media)
        assertEquals(emptyMap<String, List<String>>(), messages[1].reactions)
    }

    @Test
    fun blockUsesBearerAndSendsLogin() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"blocked":true}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-block",
            user = CloudUser("roman", "Roman"),
        )

        api.block(session, "anna")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/block", request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer token-block", request.getHeader("Authorization"))
        assertEquals("anna", body.getValue("login").jsonPrimitive.content)
    }

    @Test
    fun unblockUsesBearerAndSendsLogin() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"blocked":false}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-unblock",
            user = CloudUser("roman", "Roman"),
        )

        api.unblock(session, "anna")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/unblock", request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer token-unblock", request.getHeader("Authorization"))
        assertEquals("anna", body.getValue("login").jsonPrimitive.content)
    }

    /**
     * `not_friends` (block requires an existing friendship, per
     * `src/cloud/accounts.js`) travels through [CloudException] unchanged,
     * the same as every other server-validation error this client already
     * handles — see [serverErrorCodeIsPreserved].
     */
    @Test
    fun blockPropagatesNotFriendsError() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(403).setBody(
                """{"error":"not_friends","message":"Вы ещё не друзья."}""",
            ),
        )
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-block",
            user = CloudUser("roman", "Roman"),
        )

        try {
            api.block(session, "stranger")
            fail("Expected CloudException")
        } catch (error: CloudException) {
            assertEquals("not_friends", error.code)
            assertEquals("Вы ещё не друзья.", error.message)
        }
    }

    @Test
    fun removeContactUsesBearerAndSendsLogin() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-remove",
            user = CloudUser("roman", "Roman"),
        )

        api.removeContact(session, "anna")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/contact/remove", request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer token-remove", request.getHeader("Authorization"))
        assertEquals("anna", body.getValue("login").jsonPrimitive.content)
    }

    /**
     * `official_contact` (403) is the answer a deletion must never actually
     * receive: the roster hides the action on an official account, so seeing
     * this code at all means the request did not come from the menu — and the
     * user-visible line is this client's own, not the server's sentence, the
     * way every other code in `cloudFailureText` is translated.
     */
    @Test
    fun removeContactPropagatesOfficialContactError() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(403).setBody(
                """{"error":"official_contact","message":"Официальный контакт удалить нельзя."}""",
            ),
        )
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-remove",
            user = CloudUser("roman", "Roman"),
        )

        try {
            api.removeContact(session, "tailik")
            fail("Expected CloudException")
        } catch (error: CloudException) {
            assertEquals("official_contact", error.code)
            assertEquals("Официальный контакт удалить нельзя.", error.message)
        }
    }

    /**
     * A login turns `POST /invite` into "mint the code for *that* account":
     * whoever redeems it becomes their friend, not the caller's. The server
     * (`handleCreateInvite`) trims and lowercases the login itself and answers
     * `forbidden` to anyone but the deployment owner, so the body has to carry
     * exactly what the command was typed with.
     */
    @Test
    fun createInviteSendsTheLoginItWasGiven() = runBlocking {
        val code = "0123456789abcdef".repeat(4)
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"invite":"$code"}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-invite",
            user = CloudUser("roman", "Roman"),
        )

        val invite = api.createInvite(session, "remindka_bot")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/invite", request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer token-invite", request.getHeader("Authorization"))
        assertEquals("remindka_bot", body.getValue("login").jsonPrimitive.content)
        assertEquals(code, invite)
    }

    /** No login is the invocation every build before this one made, and the
     *  body has to stay the empty object the server has always read as "my own
     *  link" — not `{"login":null}`, which would be a different request. */
    @Test
    fun createInviteWithoutALoginKeepsTheEmptyBody() = runBlocking {
        val code = "fedcba9876543210".repeat(4)
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"invite":"$code"}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-invite",
            user = CloudUser("roman", "Roman"),
        )

        val invite = api.createInvite(session)
        val request = server.takeRequest()

        assertEquals("/tailchat/api/invite", request.path)
        assertEquals("Bearer token-invite", request.getHeader("Authorization"))
        assertEquals("{}", request.body.readUtf8())
        assertEquals(code, invite)
    }

    /**
     * Issue #28: the nickname endpoint takes `{login, name}` verbatim — free
     * text, not the account-name sanitiser — and answers with the stored
     * `alias` (empty when cleared).
     */
    @Test
    fun setAliasPostsTheNicknameVerbatimAndReturnsTheStoredValue() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"login":"anna","alias":"Аня 🙂"}"""))
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-alias",
            user = CloudUser("roman", "Roman"),
        )

        val alias = api.setAlias(session, "anna", "Аня 🙂")
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/tailchat/api/alias", request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer token-alias", request.getHeader("Authorization"))
        assertEquals("anna", body.getValue("login").jsonPrimitive.content)
        assertEquals("Аня 🙂", body.getValue("name").jsonPrimitive.content)
        assertEquals("Аня 🙂", alias)
    }

    @Test
    fun setAliasSurfacesAnInvalidAliasRefusal() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(400).setBody("""{"error":"invalid_alias","message":"no"}"""),
        )
        val session = CloudSession(
            server = server.url("/").toString(),
            token = "token-alias",
            user = CloudUser("roman", "Roman"),
        )

        try {
            api.setAlias(session, "anna", "   ")
            fail("an invalid_alias refusal must throw")
        } catch (error: CloudException) {
            assertEquals("invalid_alias", error.code)
        }
    }
}
