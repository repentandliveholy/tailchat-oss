package net.tailchat.android.cloud

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * `GET /api/link-preview` — authenticated like every other route, the URL as a query parameter, and
 * a `null` answer for anything that is not worth a card. Web draws no card without a `title`, so
 * neither does this: a picture on its own does not make one.
 */
class CloudApiLinkPreviewTest {
    private lateinit var server: MockWebServer
    private lateinit var api: CloudApi
    private lateinit var session: CloudSession

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = CloudApi(OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS).build())
        session = CloudSession(server.url("/").toString(), "token-9", CloudUser("roman", "Roman"))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun sendsTheBearerTokenAndTheUrlAsAnEncodedQueryParameter() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"preview":{"url":"https://a.example/x?y=1","title":"T","description":null,"image":null,"siteName":null}}"""))

        val meta = api.linkPreview(session, "https://a.example/x?y=1&z=a b")

        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("GET", request.method)
        assertEquals("Bearer token-9", request.getHeader("Authorization"))
        assertEquals("/tailchat/api/link-preview", request.requestUrl!!.encodedPath)
        // The whole link survives as one parameter: its own `?`, `&` and space did not leak into ours.
        assertEquals("https://a.example/x?y=1&z=a b", request.requestUrl!!.queryParameter("url"))
        assertEquals(1, request.requestUrl!!.querySize)
        assertEquals(LinkPreviewMeta("https://a.example/x?y=1", "T", null, null, null), meta)
    }

    @Test
    fun readsEveryField() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"preview":{"url":"https://a.example/p","title":"Title","description":"Desc","image":"https://a.example/i.png","siteName":"Site"}}""",
            ),
        )
        val meta = api.linkPreview(session, "https://a.example/p")
        assertEquals(LinkPreviewMeta("https://a.example/p", "Title", "Desc", "https://a.example/i.png", "Site"), meta)
    }

    @Test
    fun aNullPreviewIsNoPreview() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"preview":null}"""))
        assertNull(api.linkPreview(session, "https://a.example/p"))
    }

    @Test
    fun noTitleIsNoPreviewHoweverMuchElseThereIs() = runBlocking {
        for (title in listOf("null", "\"\"", "\"   \"")) {
            server.enqueue(
                MockResponse().setBody("""{"preview":{"url":"https://a.example/p","title":$title,"description":"d","image":"https://a.example/i.png","siteName":"s"}}"""),
            )
            assertNull(title, api.linkPreview(session, "https://a.example/p"))
        }
        // …and a page that gave no title key at all.
        server.enqueue(MockResponse().setBody("""{"preview":{"url":"https://a.example/p","image":"https://a.example/i.png"}}"""))
        assertNull(api.linkPreview(session, "https://a.example/p"))
    }

    @Test
    fun aPreviewWhoseUrlIsNotHttpIsNoPreview() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"preview":{"url":"javascript:alert(1)","title":"T"}}"""))
        assertNull(api.linkPreview(session, "https://a.example/p"))
    }

    @Test
    fun aMalformedPreviewIsTheSameAsNone() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"preview":"nonsense"}"""))
        assertNull(api.linkPreview(session, "https://a.example/p"))
        server.enqueue(MockResponse().setBody("""{"preview":{"url":{"a":1},"title":["T"]}}"""))
        assertNull(api.linkPreview(session, "https://a.example/p"))
    }

    @Test
    fun fieldsAreBoundedToWhatTheServerPromises() = runBlocking {
        val long = "x".repeat(600)
        server.enqueue(
            MockResponse().setBody("""{"preview":{"url":"https://a.example/p","title":"$long","description":"$long","image":null,"siteName":"$long"}}"""),
        )
        val meta = api.linkPreview(session, "https://a.example/p")
        assertNotNull(meta)
        assertEquals(200, meta!!.title.length)
        assertEquals(400, meta.description!!.length)
        assertEquals(80, meta.siteName!!.length)
    }

    @Test
    fun aRefusalKeepsTheServersCode() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unknown_token"}"""))
        try {
            api.linkPreview(session, "https://a.example/p")
            fail("a 401 must throw")
        } catch (error: CloudException) {
            assertEquals("unknown_token", error.code)
        }
    }

    @Test
    fun anUnreachableServerThrowsUnreachable() = runBlocking {
        val dead = CloudSession("http://127.0.0.1:1", "t", CloudUser("roman", "Roman"))
        try {
            api.linkPreview(dead, "https://a.example/p")
            fail("nothing listens there")
        } catch (error: CloudException) {
            assertEquals("unreachable", error.code)
        }
    }
}
