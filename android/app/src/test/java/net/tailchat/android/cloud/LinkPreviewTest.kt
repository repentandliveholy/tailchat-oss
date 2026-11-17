package net.tailchat.android.cloud

import java.net.InetAddress
import java.net.UnknownHostException
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The decisions that make a card: its shape, the YouTube thumbnail, the decode budget, and the address guard. */
class LinkPreviewTest {
    // ---- shape ----

    @Test
    fun aPictureTooSmallOnEitherSideIsNotShown() {
        assertEquals(LinkPreviewLayout.Text, linkPreviewLayout(23, 500, video = false))
        assertEquals(LinkPreviewLayout.Text, linkPreviewLayout(500, 23, video = false))
        assertEquals(LinkPreviewLayout.Text, linkPreviewLayout(0, 0, video = false))
        // Even a video: the play pill needs a picture under it, and this is a tracking pixel.
        assertEquals(LinkPreviewLayout.Text, linkPreviewLayout(20, 20, video = true))
    }

    @Test
    fun aWideEnoughNotTooFlatPictureIsAHero() {
        assertEquals(LinkPreviewLayout.Hero, linkPreviewLayout(1200, 630, video = false))
        assertEquals(LinkPreviewLayout.Hero, linkPreviewLayout(240, 110, video = false)) // 2.18:1
        assertEquals(LinkPreviewLayout.Hero, linkPreviewLayout(600, 1200, video = false)) // a portrait is not a banner
    }

    @Test
    fun aNarrowOrBannerPictureIsAThumbnail() {
        assertEquals(LinkPreviewLayout.Thumb, linkPreviewLayout(239, 120, video = false))
        assertEquals(LinkPreviewLayout.Thumb, linkPreviewLayout(240, 109, video = false)) // 2.202:1, just past the limit
        assertEquals(LinkPreviewLayout.Thumb, linkPreviewLayout(1200, 300, video = false)) // 4:1
        assertEquals(LinkPreviewLayout.Thumb, linkPreviewLayout(56, 56, video = false))
    }

    @Test
    fun aVideoStaysAHeroWhateverItsThumbnailSize() {
        assertEquals(LinkPreviewLayout.Hero, linkPreviewLayout(120, 90, video = true))
        assertEquals(LinkPreviewLayout.Hero, linkPreviewLayout(1200, 100, video = true))
    }

    // ---- YouTube ----

    @Test
    fun youtubeLinksYieldTheirVideoId() {
        val id = "dQw4w9WgXcQ"
        assertEquals(id, youtubeVideoId("https://youtu.be/$id"))
        assertEquals(id, youtubeVideoId("https://youtu.be/$id?t=42"))
        assertEquals(id, youtubeVideoId("https://www.youtube.com/watch?v=$id&list=PL1"))
        assertEquals(id, youtubeVideoId("https://youtube.com/watch?v=$id"))
        assertEquals(id, youtubeVideoId("https://m.youtube.com/watch?v=$id"))
        assertEquals(id, youtubeVideoId("https://www.youtube.com/shorts/$id"))
        assertEquals(id, youtubeVideoId("https://www.youtube.com/embed/$id"))
        assertEquals(id, youtubeVideoId("https://www.youtube.com/live/$id"))
    }

    @Test
    fun otherLinksYieldNoVideoId() {
        assertNull(youtubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ"))
        assertNull(youtubeVideoId("https://youtu.be/short"))
        assertNull(youtubeVideoId("https://www.youtube.com/watch?v=has spaces!"))
        assertNull(youtubeVideoId("https://www.youtube.com/channel/UCxyz"))
        assertNull(youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"))
        assertNull(youtubeVideoId("not a url"))
    }

    // ---- what is worth asking the server ----

    @Test
    fun onlyRealHttpUrlsUnderTheServersLengthAreAsked() {
        assertTrue(isPreviewableUrl("https://example.com/a"))
        assertTrue(isPreviewableUrl("http://example.com"))
        assertFalse(isPreviewableUrl("ftp://example.com/a"))
        assertFalse(isPreviewableUrl("example.com/a"))
        assertFalse(isPreviewableUrl("javascript:alert(1)"))
        assertFalse(isPreviewableUrl("https://example.com/" + "a".repeat(2048)))
    }

    // ---- decode budget ----

    @Test
    fun aHeroIsDecodedNoLargerThanACardCanShow() {
        assertEquals(1000 to 500, heroDecodeTarget(2000, 1000))
        assertEquals(800 to 600, heroDecodeTarget(800, 600)) // never enlarged
        assertEquals(250 to 840, heroDecodeTarget(1000, 3360)) // a tall one is held to the card's height
    }

    @Test
    fun sampleSizeKeepsBothAxesAtOrAboveTheTarget() {
        assertEquals(1, linkImageSample(800, 600, 800, 600))
        assertEquals(2, linkImageSample(2000, 1000, 1000, 500))
        assertEquals(4, linkImageSample(4000, 2000, 1000, 500))
        assertEquals(2, linkImageSample(4000, 1000, 1000, 500)) // the short axis decides
        assertEquals(1, linkImageSample(0, 0, 100, 100))
        assertEquals(1, linkImageSample(4000, 2000, 0, 0))
    }

    // ---- the address guard ----

    private fun address(literal: String): InetAddress = InetAddress.getByName(literal)

    @Test
    fun publicAddressesPass() {
        for (literal in listOf("8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111")) {
            assertTrue(literal, isPublicAddress(address(literal)))
        }
    }

    @Test
    fun everyKindOfNonPublicAddressIsRefused() {
        val refused = listOf(
            "127.0.0.1", "127.255.255.254", // loopback
            "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", // the LAN
            "169.254.169.254", // link-local: where a cloud provider's metadata service lives
            "100.64.0.1", "100.100.100.100", "100.127.255.255", // CGNAT, and Tailscale's own range
            "0.0.0.0", "0.1.2.3", // "this network"
            "224.0.0.1", "239.255.255.250", "255.255.255.255", // multicast and the reserved tail
            "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", // IPv6 loopback, link-local, unique local
            "::ffff:127.0.0.1", "::ffff:192.168.0.1", // IPv4 wearing an IPv6 coat
        )
        for (literal in refused) assertFalse(literal, isPublicAddress(address(literal)))
    }

    @Test
    fun anIpLiteralInAUrlIsCheckedBeforeAnyRequestIsBuilt() {
        // OkHttp never resolves a literal, so DNS pinning cannot see one: this is the other half.
        for (literal in listOf("127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "100.64.0.9", "::1", "fd00::5", "999.1.1.1")) {
            assertTrue(literal, isNonPublicLiteral(literal))
        }
        for (literal in listOf("8.8.8.8", "2606:4700:4700::1111", "example.com", "cdn.example.org")) {
            assertFalse(literal, isNonPublicLiteral(literal))
        }
    }

    @Test
    fun aNameThatResolvesToTheLoopbackIsRefusedAtTheConnection() {
        try {
            PublicOnlyDns.lookup("localhost")
            fail("localhost resolved for a public fetch")
        } catch (expected: UnknownHostException) {
            assertNotNull(expected.message)
        }
    }

    @Test
    fun theFetcherRefusesWhatIsNotHttpsOrNotPublicWithoutTouchingTheNetwork() {
        val fetcher = LinkPreviewImageFetcher(OkHttpClient())
        val deadline = System.nanoTime() + 5_000_000_000L
        assertNull(fetcher.fetch("http://example.com/a.png", deadline)) // web's CSP allows https images only
        assertNull(fetcher.fetch("https://127.0.0.1/a.png", deadline))
        assertNull(fetcher.fetch("https://192.168.0.10/a.png", deadline))
        assertNull(fetcher.fetch("https://[::1]/a.png", deadline))
        assertNull(fetcher.fetch("ftp://example.com/a.png", deadline))
        assertNull(fetcher.fetch("not a url", deadline))
        assertNull(fetcher.fetch("https://example.com/a.png", System.nanoTime() - 1)) // no time left
    }

    // ---- cache ----

    private fun preview(title: String) = LinkPreview(
        url = "https://example.com/$title", title = title, siteName = null, description = null,
        layout = LinkPreviewLayout.Text, image = null, imageWidth = 0, imageHeight = 0, video = false,
    )

    @Test
    fun theCacheKeepsAnAnswerUntilItExpires() {
        val cache = LinkPreviewCache()
        val card = preview("a")
        cache.put("a", card, expiresAt = 100)
        assertTrue(cache.get("a", now = 99)?.preview === card)
        assertNull(cache.get("a", now = 100))
        assertNull(cache.get("a", now = 101)) // and it was dropped, not merely hidden
    }

    @Test
    fun aCachedNoCardIsAnAnswerToo() {
        val cache = LinkPreviewCache()
        assertNull(cache.get("nothing", now = 0)) // never asked: a miss…
        cache.put("nothing", null, expiresAt = Long.MAX_VALUE)
        val hit = cache.get("nothing", now = 0)
        assertNotNull(hit) // …asked, and there is no card: a hit whose preview is null
        assertNull(hit!!.preview)
    }

    @Test
    fun theCacheEvictsTheLeastRecentlyUsedWhenFull() {
        // Each card without a picture costs a flat 1024 bytes, so 2500 holds two.
        val cache = LinkPreviewCache(maxBytes = 2500, maxEntries = 100)
        cache.put("a", preview("a"), Long.MAX_VALUE)
        cache.put("b", preview("b"), Long.MAX_VALUE)
        assertNotNull(cache.get("a", 0)) // a is now more recent than b
        cache.put("c", preview("c"), Long.MAX_VALUE)
        assertNotNull(cache.get("a", 0))
        assertNull(cache.get("b", 0))
        assertNotNull(cache.get("c", 0))
    }

    @Test
    fun theCacheIsAlsoBoundedInEntriesAndClears() {
        val cache = LinkPreviewCache(maxBytes = Long.MAX_VALUE, maxEntries = 2)
        for (name in listOf("a", "b", "c")) cache.put(name, preview(name), Long.MAX_VALUE)
        assertNull(cache.get("a", 0))
        assertNotNull(cache.get("c", 0))
        cache.clear()
        assertNull(cache.get("c", 0))
    }

    @Test
    fun theNewestEntryIsKeptEvenWhenItAloneIsOverTheCap() {
        val cache = LinkPreviewCache(maxBytes = 10, maxEntries = 100)
        cache.put("big", preview("big"), Long.MAX_VALUE)
        assertNotNull(cache.get("big", 0))
    }
}
