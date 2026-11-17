package net.tailchat.android.cloud

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.runtime.Immutable
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlin.math.ceil
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/*
 * Link previews — web/cloud/app.js's `fetchLinkPreviewClient` /
 * `buildLinkPreviewCard`, for the phone.
 *
 * The page's title and description come from the *server* (`GET
 * /api/link-preview`, `src/cloud/link-preview.js`: it fetches the HTML, which
 * is why the reader's device never reaches that host for it, and it refuses
 * anything but the public web). The picture is the one exception, here as on
 * web: it loads on the reader's own device. Two things keep that from being an
 * open door — https only (web's CSP `img-src … https:`), and an address check
 * on every connection ([PublicOnlyDns]), because a contact can put any URL in
 * an `og:image` and this phone sits on someone's home network.
 *
 * Like web, nothing is shown until the picture has settled: the card's shape
 * depends on the picture's own size, and inserting first and rearranging after
 * the decode is exactly the jump under the reader it avoids. So [load] resolves
 * to the finished preview, or to `null` — "no card", never a half-built one.
 */

/** `preview` of `GET /api/link-preview`: what the server could read from the page. */
@Immutable
data class LinkPreviewMeta(
    /** The page's final URL, after the server followed redirects. */
    val url: String,
    val title: String,
    val description: String?,
    /** Absolute `og:image` URL, as the server resolved it. */
    val image: String?,
    val siteName: String?,
)

/** The three shapes of a card — web's `link-preview--hero|thumb|text`. */
enum class LinkPreviewLayout { Hero, Thumb, Text }

/**
 * A card that is ready to draw: the layout is already decided from the picture's
 * natural size and [image] is already decoded, bounded to what that layout can show.
 */
@Immutable
class LinkPreview(
    val url: String,
    val title: String,
    val siteName: String?,
    val description: String?,
    val layout: LinkPreviewLayout,
    /** `null` exactly when [layout] is [LinkPreviewLayout.Text]. */
    val image: Bitmap?,
    /** The picture's natural size, before any sampling. */
    val imageWidth: Int,
    val imageHeight: Int,
    /** A YouTube link: its hero carries the `▶ YouTube` pill. */
    val video: Boolean,
) {
    /** What this keeps alive in a [LinkPreviewCache]: the bitmap, plus a flat cushion for the strings. */
    internal val cost: Int get() = (image?.allocationByteCount ?: 0) + 1024
}

/**
 * The one thing a message bubble needs to show a card. A single instance lives as
 * long as the controller — it owns the HTTP clients, the cache and the in-flight
 * table — so a bubble asks it and never builds anything of its own.
 */
interface LinkPreviewLoader {
    /** What is already settled for [url], without waiting. A bubble scrolled back into
     *  view draws its card in the first frame, and the list does not jump under the reader. */
    fun cached(url: String): LinkPreview?

    /** The finished preview for [url], or `null` when there is nothing worth a card:
     *  no title, a failed lookup, signed out. Suspends for the lookup and the picture;
     *  concurrent callers for the same URL share one request. */
    suspend fun load(url: String): LinkPreview?
}

// ---- layout ---------------------------------------------------------------

/** Wide enough to fill the bubble without turning to mush… */
internal const val LINK_PREVIEW_HERO_MIN_WIDTH = 240
/** …and not a banner: a 4:1 strip across the top is a sliver, not a picture. */
internal const val LINK_PREVIEW_HERO_MAX_RATIO = 2.2f
/** Below this on either side the `og:image` is a favicon or a tracking pixel. */
internal const val LINK_PREVIEW_MIN_IMAGE = 24
/** The thumbnail's square, in dp; a picture smaller than this is shown at its own size. */
internal const val LINK_PREVIEW_THUMB_DP = 56
/** The hero's height ceiling, in dp. */
internal const val LINK_PREVIEW_HERO_MAX_HEIGHT_DP = 280

/**
 * `linkPreviewLayout` of web/cloud/app.js. A YouTube link stays a hero whatever size
 * its thumbnail turns out to be: the play pill is what says «video», and it needs
 * the picture under it.
 */
internal fun linkPreviewLayout(width: Int, height: Int, video: Boolean): LinkPreviewLayout {
    if (width <= 0 || height <= 0 || minOf(width, height) < LINK_PREVIEW_MIN_IMAGE) return LinkPreviewLayout.Text
    if (video) return LinkPreviewLayout.Hero
    if (width >= LINK_PREVIEW_HERO_MIN_WIDTH && width.toFloat() / height <= LINK_PREVIEW_HERO_MAX_RATIO) {
        return LinkPreviewLayout.Hero
    }
    return LinkPreviewLayout.Thumb
}

private val YOUTUBE_ID = Regex("^[a-zA-Z0-9_-]{11}$")

/** `youtubeVideoId` of web/cloud/app.js: `youtu.be/ID`, `youtube.com/watch?v=ID`, `/shorts|embed|live/ID`. */
internal fun youtubeVideoId(url: String): String? {
    val parsed = url.toHttpUrlOrNull() ?: return null
    val host = parsed.host.lowercase().removePrefix("www.")
    val segments = parsed.pathSegments
    var id: String? = null
    if (host == "youtu.be") id = segments.firstOrNull()
    if (host == "youtube.com" || host == "m.youtube.com") {
        id = parsed.queryParameter("v")
        if (id == null && segments.size >= 2 && segments[0] in setOf("shorts", "embed", "live")) id = segments[1]
    }
    return id?.takeIf { YOUTUBE_ID.matches(it) }
}

/** Server-side limit (`target.length > 2048` in `handleLinkPreview`) and a real http(s) URL. */
internal fun isPreviewableUrl(url: String): Boolean = url.length <= 2048 && url.toHttpUrlOrNull() != null

// Decode ceilings, in pixels. A hero shows at most the card's width — about 330 dp, 1000 px on a
// 3x screen — by 280 dp; a thumbnail is 56 dp. Past these the extra pixels are never on screen.
private const val HERO_DECODE_MAX_WIDTH = 1000
private const val HERO_DECODE_MAX_HEIGHT = 840
private const val THUMB_DECODE_PX = 192

/** The smallest size a hero of this shape needs: its own proportions, fitted into 1000×840 and never enlarged. */
internal fun heroDecodeTarget(width: Int, height: Int): Pair<Int, Int> {
    val scale = minOf(1f, HERO_DECODE_MAX_WIDTH.toFloat() / width, HERO_DECODE_MAX_HEIGHT.toFloat() / height)
    return ceil(width * scale).toInt().coerceAtLeast(1) to ceil(height * scale).toInt().coerceAtLeast(1)
}

/** The largest power of two that leaves both axes at or above the target — `BitmapFactory`'s own rule. */
internal fun linkImageSample(width: Int, height: Int, targetWidth: Int, targetHeight: Int): Int {
    if (width <= 0 || height <= 0 || targetWidth <= 0 || targetHeight <= 0) return 1
    var sample = 1L
    while (width / (sample * 2) >= targetWidth && height / (sample * 2) >= targetHeight) sample *= 2
    return sample.toInt()
}

/** A decoded picture and the layout its natural size chose. */
internal class LinkImage(val layout: LinkPreviewLayout, val bitmap: Bitmap?, val width: Int, val height: Int)

/**
 * Decides the layout from the picture's natural size and decodes only as much of it as
 * that layout can show. `null` when [bytes] are not a picture at all — a card with no
 * picture is the answer then, not an error.
 */
internal fun decodeLinkImage(bytes: ByteArray, video: Boolean): LinkImage? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0) return null
    val layout = linkPreviewLayout(width, height, video)
    if (layout == LinkPreviewLayout.Text) return LinkImage(layout, null, width, height)
    val (targetWidth, targetHeight) = if (layout == LinkPreviewLayout.Hero) {
        heroDecodeTarget(width, height)
    } else {
        THUMB_DECODE_PX to THUMB_DECODE_PX
    }
    val bitmap = BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply { inSampleSize = linkImageSample(width, height, targetWidth, targetHeight) },
    ) ?: return null
    return LinkImage(layout, bitmap, width, height)
}

// ---- cache ----------------------------------------------------------------

/**
 * Settled previews, bounded in bytes rather than entries — one hero costs a few
 * megabytes and a text-only card nothing, so a count says nothing about the bill —
 * and least-recently-used out first. An evicted bitmap is dropped, never `recycle()`d:
 * a composition may still be drawing it, and the GC frees it when that lets go
 * (the same rule `InlineImage.kt`'s thumbnail cache lives by).
 *
 * A `null` preview is an answer too — "this URL has no card" — and is kept, with an
 * expiry, so scrolling through a conversation does not ask the server again for every
 * bubble each time it comes back into view.
 */
internal class LinkPreviewCache(
    private val maxBytes: Long = 16L * 1024 * 1024,
    private val maxEntries: Int = 160,
) {
    /** A cached answer; [preview] is `null` for a cached "no card". */
    class Hit(val preview: LinkPreview?)

    private class Entry(val preview: LinkPreview?, val cost: Int, val expiresAt: Long)

    private val entries = LinkedHashMap<String, Entry>(32, 0.75f, /* accessOrder = */ true)
    private var bytes = 0L

    @Synchronized
    fun get(url: String, now: Long): Hit? {
        val entry = entries[url] ?: return null
        if (entry.expiresAt <= now) {
            entries.remove(url)?.let { bytes -= it.cost }
            return null
        }
        return Hit(entry.preview)
    }

    @Synchronized
    fun put(url: String, preview: LinkPreview?, expiresAt: Long) {
        val cost = preview?.cost ?: 0
        entries.put(url, Entry(preview, cost, expiresAt))?.let { bytes -= it.cost }
        bytes += cost
        // Access order makes iteration least-recently-used first, and the entry just put is
        // the most recent: `size > 1` keeps it even if it alone is over the cap.
        val stale = entries.entries.iterator()
        while ((bytes > maxBytes || entries.size > maxEntries) && entries.size > 1 && stale.hasNext()) {
            bytes -= stale.next().value.cost
            stale.remove()
        }
    }

    @Synchronized
    fun clear() {
        entries.clear()
        bytes = 0L
    }

    companion object {
        /** One per process, like the bitmap caches in `InlineImage.kt`; `clearImageCaches()` empties it. */
        val shared = LinkPreviewCache()
    }
}

// ---- fetching -------------------------------------------------------------

/** Where a settled card's picture comes from. A seam: tests answer it with bytes, production with the network. */
internal fun interface LinkPreviewImageSource {
    /** Blocking. The bytes of the picture at [url] — or `null` for anything that is not an
     *  acceptable picture within [deadlineNanos] (a `System.nanoTime()` instant). */
    fun fetch(url: String, deadlineNanos: Long): ByteArray?
}

// How long the card waits for its picture before settling for text. Web's LINK_PREVIEW_IMAGE_WAIT_MS.
private const val IMAGE_WAIT_MS = 5_000L
private const val IMAGE_STEP_TIMEOUT_MS = 4_000L
private const val IMAGE_MAX_BYTES = 4 * 1024 * 1024
private const val IMAGE_MAX_REDIRECTS = 3

/** Metadata lookups in flight at once: opening a thread full of links must not be a burst of twenty. */
private const val MAX_CONCURRENT_LOOKUPS = 3
/** "The server read the page and found nothing" — that answer does not improve in minutes. */
private const val EMPTY_TTL_MS = 10 * 60_000L
/** Offline, signed out, a timeout: worth trying again soon, not on every frame. */
private const val FAILURE_TTL_MS = 30_000L

/**
 * [LinkPreviewLoader] over the authenticated `GET /api/link-preview`.
 *
 * Everything that varies is injected so the one real instance per controller and the
 * tests share the code: the session (the account can change under a long-lived
 * controller), the picture source, the cache and the clock.
 */
internal class LinkPreviewRepository(
    private val api: CloudApi,
    private val session: () -> CloudSession?,
    private val images: LinkPreviewImageSource,
    private val cache: LinkPreviewCache = LinkPreviewCache.shared,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val now: () -> Long = System::currentTimeMillis,
) : LinkPreviewLoader {
    private val lock = Any()
    private val inFlight = HashMap<String, Deferred<LinkPreview?>>()
    private val slots = Semaphore(MAX_CONCURRENT_LOOKUPS)

    override fun cached(url: String): LinkPreview? = cache.get(url.trim(), now())?.preview

    override suspend fun load(url: String): LinkPreview? {
        val key = url.trim()
        if (!isPreviewableUrl(key)) return null
        cache.get(key, now())?.let { return it.preview }
        // The lookup belongs to the repository's scope, not to whichever bubble asked first:
        // that bubble scrolling away must not throw the answer the next one is waiting for.
        // LAZY, and started only once it is in the table, so a lookup that finishes at once
        // cannot remove an entry that was not put there yet.
        val (job, created) = synchronized(lock) {
            val running = inFlight[key]
            if (running != null) {
                running to false
            } else {
                val started = scope.async(start = CoroutineStart.LAZY) { fetch(key) }
                inFlight[key] = started
                started to true
            }
        }
        if (created) job.start()
        return job.await()
    }

    private suspend fun fetch(key: String): LinkPreview? = try {
        slots.withPermit { resolve(key) }
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        // A malformed answer, a decode that failed: no card — and no crash in whoever is waiting.
        cache.put(key, null, now() + FAILURE_TTL_MS)
        null
    } catch (_: OutOfMemoryError) {
        cache.put(key, null, now() + FAILURE_TTL_MS)
        null
    } finally {
        synchronized(lock) { inFlight.remove(key) }
    }

    private suspend fun resolve(key: String): LinkPreview? {
        // Not cached: nobody is signed in *now*, which says nothing about the URL.
        val signedIn = session() ?: return null
        val meta = try {
            api.linkPreview(signedIn, key)
        } catch (_: CloudException) {
            cache.put(key, null, now() + FAILURE_TTL_MS)
            return null
        }
        if (meta == null) {
            cache.put(key, null, now() + EMPTY_TTL_MS)
            return null
        }
        val preview = build(meta)
        cache.put(key, preview, Long.MAX_VALUE)
        return preview
    }

    private suspend fun build(meta: LinkPreviewMeta): LinkPreview {
        val videoId = youtubeVideoId(meta.url)
        // A YouTube page's own `og:image` is not always there; its thumbnail always is.
        val imageUrl = meta.image ?: videoId?.let { "https://i.ytimg.com/vi/$it/hqdefault.jpg" }
        val settled = imageUrl?.let { settle(it, video = videoId != null) }
        return LinkPreview(
            url = meta.url,
            title = meta.title,
            siteName = meta.siteName,
            description = meta.description,
            layout = settled?.layout ?: LinkPreviewLayout.Text,
            image = settled?.bitmap,
            imageWidth = settled?.width ?: 0,
            imageHeight = settled?.height ?: 0,
            video = videoId != null,
        )
    }

    /** The picture, or `null` for "show text": slow, refused, not a picture, too small. */
    private suspend fun settle(imageUrl: String, video: Boolean): LinkImage? {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(IMAGE_WAIT_MS)
        return withTimeoutOrNull(IMAGE_WAIT_MS + 1_000) {
            runInterruptible(Dispatchers.IO) {
                images.fetch(imageUrl, deadline)?.let { decodeLinkImage(it, video) }
            }
        }
    }
}

/**
 * Fetches a card's picture on the reader's device, and only a *public* one.
 *
 * A contact chooses the URL, so this is the one place a stranger decides what this
 * phone requests — and the phone is inside a home or office network the stranger
 * cannot reach. So: https only; redirects followed by hand (at most three), each hop
 * re-checked; every connection's address checked in [PublicOnlyDns] (names) or before
 * the request (literals, which OkHttp never resolves); a 4 MB body cap; nothing whose
 * content type is not an image one. No `Referer` is sent: OkHttp does not add one, which is
 * web's `referrerpolicy="no-referrer"`.
 */
internal class LinkPreviewImageFetcher(client: OkHttpClient) : LinkPreviewImageSource {
    private val http: OkHttpClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .dns(PublicOnlyDns)
        .connectTimeout(IMAGE_STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(IMAGE_STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        // The call's own budget is set per request, from what is left of the card's wait.
        .callTimeout(0, TimeUnit.MILLISECONDS)
        // The shared client pings for its WebSocket; nothing here is one.
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .build()

    override fun fetch(url: String, deadlineNanos: Long): ByteArray? {
        var current = url.toHttpUrlOrNull() ?: return null
        for (hop in 0..IMAGE_MAX_REDIRECTS) {
            if (!isFetchable(current)) return null
            val remainingMs = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime())
            if (remainingMs <= 0) return null
            val call = http.newCall(Request.Builder().url(current).header("Accept", "image/*").get().build())
            call.timeout().timeout(remainingMs, TimeUnit.MILLISECONDS)
            val response = try {
                call.execute()
            } catch (_: IOException) {
                return null
            }
            try {
                if (response.isRedirect) {
                    current = response.header("Location")?.let { response.request.url.resolve(it) } ?: return null
                    continue
                }
                if (!response.isSuccessful) return null
                val type = response.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
                // `BitmapFactory` cannot draw an SVG, so there is no point downloading one.
                if (!type.startsWith("image/") || type == "image/svg+xml") return null
                val body = response.body ?: return null
                if (body.contentLength() > IMAGE_MAX_BYTES) return null
                return readCapped(body.byteStream(), IMAGE_MAX_BYTES)
            } finally {
                response.close()
            }
        }
        return null
    }

    private fun isFetchable(url: HttpUrl): Boolean = url.scheme == "https" && !isNonPublicLiteral(url.host)

    private fun readCapped(input: InputStream, max: Int): ByteArray? {
        val out = ByteArrayOutputStream(64 * 1024)
        val buffer = ByteArray(16 * 1024)
        var total = 0
        try {
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > max) return null
                out.write(buffer, 0, read)
            }
        } catch (_: IOException) {
            return null
        }
        return out.toByteArray()
    }
}

// ---- addresses ------------------------------------------------------------

/**
 * Refuses a connection to anything that is not the public internet — loopback, the
 * LAN, link-local (where a cloud provider's metadata service lives), CGNAT (also
 * Tailscale's range, and this deployment's own), multicast, unique-local IPv6 — the
 * same set `isPrivateAddress` in `src/cloud/link-preview.js` keeps the *server* out of.
 *
 * OkHttp asks its [Dns] for every connection, a redirect's included, and connects to
 * exactly the addresses it is handed, so there is no gap between this check and the
 * socket for a rebinding name to slip through. A name that resolves to even one
 * non-public address is refused whole: a public site has no reason to ever answer with one.
 */
internal object PublicOnlyDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val addresses = Dns.SYSTEM.lookup(hostname)
        if (addresses.isEmpty() || addresses.any { !isPublicAddress(it) }) {
            throw UnknownHostException("$hostname does not resolve to a public address")
        }
        return addresses
    }
}

internal fun isPublicAddress(address: InetAddress): Boolean {
    if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
        address.isSiteLocalAddress || address.isMulticastAddress
    ) {
        return false
    }
    val raw = address.address
    val first = raw[0].toInt() and 0xFF
    if (raw.size == 4) {
        val second = raw[1].toInt() and 0xFF
        if (first == 0) return false // "this network"
        if (first == 100 && second in 64..127) return false // 100.64.0.0/10: CGNAT, Tailscale
        if (first >= 224) return false // multicast and the reserved tail
        return true
    }
    // fc00::/7, unique local. (An IPv4-mapped `::ffff:a.b.c.d` is already an `Inet4Address` by now.)
    return (first and 0xFE) != 0xFC
}

private val IPV4_LITERAL = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

/**
 * `true` when [host] is an IP literal that is not public. OkHttp never resolves a literal,
 * so [PublicOnlyDns] never sees one; this is the other half of the guard. A name is `false`
 * here and left to [PublicOnlyDns]. A literal that does not parse is refused.
 */
internal fun isNonPublicLiteral(host: String): Boolean {
    val v4 = IPV4_LITERAL.matchEntire(host)
    if (v4 != null) {
        val octets = v4.groupValues.drop(1).map { it.toInt() }
        if (octets.any { it > 255 }) return true
        return !isPublicAddress(InetAddress.getByAddress(ByteArray(4) { octets[it].toByte() }))
    }
    // OkHttp has already validated an IPv6 host (it is the bracketed form of the URL), so
    // `getByName` parses it without a lookup.
    if (host.contains(':')) {
        return try {
            !isPublicAddress(InetAddress.getByName(host))
        } catch (_: UnknownHostException) {
            true
        }
    }
    return false
}
