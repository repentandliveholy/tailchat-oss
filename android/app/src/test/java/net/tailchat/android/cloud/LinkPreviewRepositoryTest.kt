package net.tailchat.android.cloud

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The loader end to end against a mock server: the authenticated request, what counts as a card,
 * and — as important for a screen that recomposes constantly — what is *not* asked twice.
 */
class LinkPreviewRepositoryTest {
    private lateinit var server: MockWebServer
    private lateinit var api: CloudApi
    private lateinit var session: CloudSession
    private var clock = 1_000_000L
    private val fetchedPictures = mutableListOf<String>()

    private val url = "https://example.com/post"
    private val card = """{"preview":{"url":"https://example.com/post","title":"Hello","description":"World","image":null,"siteName":"Example"}}"""

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = CloudApi(OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build())
        session = CloudSession(server.url("/").toString(), "token-1", CloudUser("roman", "Roman"))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun repository(signedIn: Boolean = true) = LinkPreviewRepository(
        api = api,
        session = { if (signedIn) session else null },
        images = LinkPreviewImageSource { pictureUrl, _ ->
            synchronized(fetchedPictures) { fetchedPictures += pictureUrl }
            null
        },
        cache = LinkPreviewCache(),
        now = { clock },
    )

    @Test
    fun asksTheServerWithTheTokenAndBuildsATextCardWhenThereIsNoPicture() = runBlocking {
        server.enqueue(MockResponse().setBody(card))

        val preview = repository().load(url)

        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("GET", request.method)
        assertEquals("Bearer token-1", request.getHeader("Authorization"))
        assertEquals("/tailchat/api/link-preview?url=https%3A%2F%2Fexample.com%2Fpost", request.path)
        assertNotNull(preview)
        assertEquals("Hello", preview!!.title)
        assertEquals("World", preview.description)
        assertEquals("Example", preview.siteName)
        assertEquals("https://example.com/post", preview.url)
        assertEquals(LinkPreviewLayout.Text, preview.layout)
        assertNull(preview.image)
        assertFalse(preview.video)
    }

    @Test
    fun aSettledCardIsServedFromTheCacheWithoutAskingAgain() = runBlocking {
        server.enqueue(MockResponse().setBody(card))
        val repository = repository()

        val first = repository.load(url)
        val second = repository.load(url)

        assertEquals(1, server.requestCount)
        assertSame(first, second)
        // And a bubble scrolled back into view gets it synchronously, for its first frame.
        assertSame(first, repository.cached(url))
        assertSame(first, repository.cached("  $url  "))
    }

    @Test
    fun theSameLinkInTwoBubblesAtOnceIsOneRequest() = runBlocking {
        server.enqueue(MockResponse().setBody(card).setBodyDelay(300, TimeUnit.MILLISECONDS))
        val repository = repository()

        val results = listOf(async { repository.load(url) }, async { repository.load(url) }, async { repository.load(url) }).awaitAll()

        assertEquals(1, server.requestCount)
        assertNotNull(results[0])
        assertSame(results[0], results[1])
        assertSame(results[0], results[2])
    }

    @Test
    fun noCardIsRememberedForAWhileAndThenAskedAgain() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"preview":null}"""))
        val repository = repository()

        assertNull(repository.load(url))
        assertNull(repository.load(url))
        assertEquals(1, server.requestCount) // a page with nothing to show does not improve by the minute

        clock += 11 * 60_000L // past the ten minutes
        server.enqueue(MockResponse().setBody(card))
        assertNotNull(repository.load(url))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun aPreviewWithoutATitleIsNoCardEvenWithAPicture() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"preview":{"url":"https://example.com/post","title":null,"description":"d","image":"https://example.com/i.png","siteName":null}}"""),
        )
        assertNull(repository().load(url))
        // A card without a title never reaches the picture.
        assertTrue(fetchedPictures.isEmpty())
    }

    @Test
    fun aRefusalIsNoCardAndIsNotRetriedOnEveryFrame() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unknown_token"}"""))
        val repository = repository()

        assertNull(repository.load(url))
        assertNull(repository.load(url))
        assertEquals(1, server.requestCount)

        clock += 31_000L // past the thirty seconds: worth another try
        server.enqueue(MockResponse().setBody(card))
        assertNotNull(repository.load(url))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun signedOutThereIsNothingToAskAndNothingIsRemembered() = runBlocking {
        assertNull(repository(signedIn = false).load(url))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun linksTheServerCannotTakeAreNotAsked() = runBlocking {
        val repository = repository()
        assertNull(repository.load("ftp://example.com/file"))
        assertNull(repository.load("not a link"))
        assertNull(repository.load("https://example.com/" + "a".repeat(2100)))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aYoutubeLinkWithoutAPictureOfItsOwnAsksForTheThumbnailAndKeepsItsPill() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"preview":{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","title":"A video","description":null,"image":null,"siteName":"YouTube"}}"""),
        )

        val preview = repository().load("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        assertEquals(listOf("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"), fetchedPictures)
        assertTrue(preview!!.video)
    }

    @Test
    fun theServersOwnPictureIsPreferredToTheYoutubeFallback() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"preview":{"url":"https://youtu.be/dQw4w9WgXcQ","title":"A video","description":null,"image":"https://cdn.example.com/og.jpg","siteName":null}}"""),
        )

        repository().load("https://youtu.be/dQw4w9WgXcQ")

        assertEquals(listOf("https://cdn.example.com/og.jpg"), fetchedPictures)
    }
}
