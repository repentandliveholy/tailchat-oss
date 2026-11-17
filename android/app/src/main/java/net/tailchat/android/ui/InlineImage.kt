package net.tailchat.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.tailchat.android.R
import net.tailchat.android.cloud.CloudImage
import net.tailchat.android.cloud.IMAGE_PLACEHOLDER_TEXTS
import net.tailchat.android.cloud.LinkPreviewCache

/*
 * Inline photos, decoded once per conversation instead of once per scroll pass.
 *
 * The version this replaces (CloudScreen.kt:1201-1236) did three things that
 * cost a frame every time a bubble came back into view: it keyed `remember` on
 * `image.dataUrl` — hashing a multi-megabyte base64 string on the composition
 * thread — then base64-decoded and `BitmapFactory.decodeByteArray`'d the JPEG
 * at full resolution on that same thread, and threw the result away as soon as
 * the item left the `LazyColumn`'s reuse window. A 3000x4000 photo is 48 MB as
 * ARGB_8888 and the thread doing that work is the one that has 16 ms to draw.
 *
 * So: key on the message id (a short stable string), decode on
 * `Dispatchers.Default`, sample down to the box the bubble actually shows, and
 * keep the small result in a process-wide LRU so the second pass is a map hit.
 * The full-resolution bitmap only ever exists while the viewer is open
 * (ImageViewer.kt).
 */

/** web's `IMAGE_PREVIEW_MAX_PX`: the long side of a photo in the thread, and so of its decode. */
internal val InlineImageMaxSide = 480.dp

/** The long side an undeclared photo is laid out at before its bytes say what it is: 4:3, the
 *  shape web/cloud/app.js's `compressImage()` gives a camera capture, so the placeholder is wrong
 *  by the least on the common case. In pixels of a picture that is never the cap. */
private const val UNKNOWN_NATURAL_WIDTH = 4096
private const val UNKNOWN_NATURAL_HEIGHT = 3072

/**
 * 16 MB of RGB_565 thumbnails is ~20 photos at the 480dp box on a 3x screen — more than a
 * conversation shows at once, and small enough that it is never the reason the app is
 * killed. Bounded in bytes rather than in entries because entry count says nothing about
 * the cost: one landscape panorama and one square avatar decode to wildly different
 * allocations.
 */
private const val THUMBNAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024

/** Both caches key on the message id plus the decode that produced the bitmap, so a re-decode
 *  at a different box (rotation, density, text size) cannot be served a bitmap of the wrong
 *  size, and the two never collide. */
internal fun thumbnailKey(cacheKey: String, width: Int, height: Int) = "$cacheKey@${width}x$height"

internal fun fullKey(cacheKey: String) = "full:$cacheKey"

/**
 * `inSampleSize` as `BitmapFactory` defines it: the largest power of two that
 * still leaves both axes at or above the requested size. Pure and internal-free
 * on purpose — this is the one part of the decode worth testing on the JVM
 * (InlineImageSamplingTest), and getting it wrong is silent: too small a sample
 * wastes the memory this file exists to save, too large one renders a blurry
 * thumbnail that no cache invalidation will ever fix.
 *
 * Any non-positive input returns 1: `outWidth`/`outHeight` are -1 for a payload
 * `BitmapFactory` could not parse, and a zero-sized target would otherwise loop
 * up to a sample size that decodes nothing at all.
 */
fun sampleSizeFor(sourceWidth: Int, sourceHeight: Int, targetWidth: Int, targetHeight: Int): Int {
    if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return 1
    // Long arithmetic only so the doubling cannot overflow on a bogus dimension
    // near Int.MAX_VALUE; the result is bounded by sourceWidth, so it always fits.
    var sample = 1L
    while (sourceWidth / (sample * 2) >= targetWidth && sourceHeight / (sample * 2) >= targetHeight) {
        sample *= 2
    }
    return sample.toInt()
}

/**
 * The box a photo takes in the thread, in pixels.
 *
 * Natural dimensions are web CSS pixels — logical dp here. [density] converts them to device
 * pixels before applying the physical long-side and row bounds. Small pictures keep their
 * logical size on dense screens too; the decoder never allocates an upscaled bitmap.
 */
internal fun inlineImageSize(naturalWidth: Int, naturalHeight: Int, maxLongSidePx: Int, availableWidthPx: Int, density: Float): IntSize {
    val width = max(naturalWidth, 1).toFloat() * density
    val height = max(naturalHeight, 1).toFloat() * density
    val capped = min(1f, maxLongSidePx.coerceAtLeast(1) / max(width, height))
    var shownWidth = width * capped
    var shownHeight = height * capped
    if (availableWidthPx in 1 until Int.MAX_VALUE && shownWidth > availableWidthPx) {
        val fit = availableWidthPx / shownWidth
        shownWidth = availableWidthPx.toFloat()
        shownHeight *= fit
    }
    return IntSize(shownWidth.roundToInt().coerceAtLeast(1), shownHeight.roundToInt().coerceAtLeast(1))
}

/**
 * Access-ordered [LinkedHashMap] under a lock, rather than androidx's `LruCache`
 * or a third-party loader: the whole policy is four lines, and the one rule that
 * is not `LruCache`'s default matters — an evicted bitmap is dropped, never
 * `recycle()`d. Compose hands the same [Bitmap] to the render thread inside an
 * `ImageBitmap`, and a composition that is still drawing an evicted entry would
 * take a "Canvas: trying to use a recycled bitmap" crash. GC frees it once the
 * last composition lets go, which is exactly the lifetime we want.
 */
internal object ThumbnailCache {
    private val entries = LinkedHashMap<String, Bitmap>(16, 0.75f, /* accessOrder = */ true)
    private var bytes = 0L

    fun get(key: String): Bitmap? = synchronized(this) { entries[key] }

    /** Any thumbnail of [cacheKey]'s message, whatever box it was decoded for — what the
     *  viewer shows while the sharp bitmap is still being decoded. Does not touch the LRU order. */
    fun any(cacheKey: String): Bitmap? = synchronized(this) {
        val prefix = "$cacheKey@"
        entries.entries.firstOrNull { it.key.startsWith(prefix) }?.value
    }

    fun put(key: String, bitmap: Bitmap) = synchronized(this) {
        entries.put(key, bitmap)?.let { bytes -= it.allocationByteCount }
        bytes += bitmap.allocationByteCount
        // Access order makes iteration least-recently-used first; the entry just
        // inserted is the most recent, and `size > 1` keeps it even if it alone
        // is over the cap, because the caller is about to draw it.
        val stale = entries.entries.iterator()
        while (bytes > THUMBNAIL_CACHE_MAX_BYTES && entries.size > 1 && stale.hasNext()) {
            bytes -= stale.next().value.allocationByteCount
            stale.remove()
        }
    }

    fun clear() = synchronized(this) {
        entries.clear()
        bytes = 0L
    }
}

/** A full-resolution picture, and the natural size of the *file* it came from — which differs
 *  from [bitmap]'s own when the decode was sampled to stay inside the pixel budget. */
internal class FullImage(val bitmap: Bitmap, val naturalWidth: Int, val naturalHeight: Int)

/**
 * One slot, deliberately: a full-resolution photo is tens of megabytes, so
 * "back out and reopen the same picture" gets to be instant while two of them
 * are never alive at once. Opening a second photo drops the first.
 */
internal object FullBitmapCache {
    private var key: String? = null
    private var image: FullImage? = null

    fun get(wanted: String): FullImage? = synchronized(this) { image?.takeIf { key == wanted } }

    fun put(wanted: String, value: FullImage) = synchronized(this) {
        key = wanted
        image = value
    }

    fun clear() = synchronized(this) {
        key = null
        image = null
    }
}

/**
 * Every decoded bitmap this app is holding, dropped at once.
 *
 * All of these caches are process-lifetime by design — a photo you scrolled past is
 * worth keeping — but nothing about that design knows when the *system* is
 * short of memory, and a chat with photos is the app the low-memory killer
 * reaches for first. `ChatService.onTrimMemory` is what knows; it calls this.
 * Nothing is recycled: a composition may still be drawing any of these, and the
 * GC frees them as soon as it lets go (see [ThumbnailCache]).
 */
fun clearImageCaches() {
    FullBitmapCache.clear()
    ThumbnailCache.clear()
    LinkPreviewCache.shared.clear()
}

internal fun payloadOf(dataUrl: String): ByteArray =
    Base64.decode(dataUrl.substringAfter(',', ""), Base64.DEFAULT)

/** The sharp bitmap's budget: 4096 px on a side and 12.6 megapixels — 48 MB as ARGB_8888, the
 *  same ceiling a 12 MP phone photo always had. A picture from this app is never near it (the
 *  encoder stops at 2560 px); a hostile peer's is not obliged to be. */
private const val FULL_MAX_SIDE = 4096
private const val FULL_MAX_PIXELS = 4096L * 3072L

/** `inSampleSize` that brings a [width]×[height] decode inside the sharp bitmap's budget. */
internal fun fullSampleSize(width: Int, height: Int): Int {
    if (width <= 0 || height <= 0) return 1
    var sample = 1L
    while (max(width, height) / sample > FULL_MAX_SIDE || (width / sample) * (height / sample) > FULL_MAX_PIXELS) {
        sample *= 2
    }
    return sample.toInt()
}

private class Decoded(val bitmap: Bitmap, val naturalWidth: Int, val naturalHeight: Int)

/**
 * Never throws: a truncated data URL, a payload that is not an image, or an OOM
 * on a hostile size all have to land as the placeholder box, because this runs
 * for whatever a peer chose to send. [runCatching] catches `Throwable`, which is
 * what makes `OutOfMemoryError` a missing thumbnail rather than a dead process.
 *
 * A power-of-two sample can still be larger than the box, so shrink that intermediate before
 * caching it. Keep smaller originals untouched and let the renderer handle device density.
 * Bounds come from the bytes, not the declared metadata.
 */
private fun loadThumbnail(cacheKey: String, dataUrl: String, longSidePx: Int, availableWidthPx: Int, density: Float): Decoded? = runCatching {
    val bytes = payloadOf(dataUrl)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val naturalWidth = bounds.outWidth
    val naturalHeight = bounds.outHeight
    if (naturalWidth <= 0 || naturalHeight <= 0) return@runCatching null
    val box = inlineImageSize(naturalWidth, naturalHeight, longSidePx, availableWidthPx, density)
    val key = thumbnailKey(cacheKey, box.width, box.height)
    // Second lookup, for the case the composable could not predict the box because the
    // sender omitted `d.image.w`/`h`: the bounds pass is cheap next to a full decode, so a
    // hit here still saves the expensive half.
    ThumbnailCache.get(key)?.let { return@runCatching Decoded(it, naturalWidth, naturalHeight) }
    val decoded = BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(naturalWidth, naturalHeight, box.width, box.height)
            // A JPEG thumbnail has no alpha to keep, and 16 bits per pixel
            // halves both the allocation and the bytes the cache accounts for.
            inPreferredConfig = Bitmap.Config.RGB_565
        },
    ) ?: return@runCatching null
    val exact = if (decoded.width > box.width || decoded.height > box.height) {
        // Nobody else holds `decoded` yet, so recycling the intermediate is safe here.
        Bitmap.createScaledBitmap(decoded, box.width, box.height, true).also { if (it !== decoded) decoded.recycle() }
    } else {
        decoded
    }
    ThumbnailCache.put(key, exact)
    Decoded(exact, naturalWidth, naturalHeight)
}.getOrNull()

/** The sharp bitmap for the viewer; sampled only when the picture is past the budget above. */
internal fun loadFull(cacheKey: String, dataUrl: String): FullImage? = runCatching {
    val bytes = payloadOf(dataUrl)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val naturalWidth = bounds.outWidth
    val naturalHeight = bounds.outHeight
    if (naturalWidth <= 0 || naturalHeight <= 0) return@runCatching null
    BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inSampleSize = fullSampleSize(naturalWidth, naturalHeight)
        },
    )?.let { FullImage(it, naturalWidth, naturalHeight) }?.also { FullBitmapCache.put(fullKey(cacheKey), it) }
}.getOrNull()

/**
 * One picture of the open conversation, as the viewer pages through them: [id] is the message
 * id (the same value an [InlineImage] gets as `cacheKey`), [image] its picture — `dataUrl` is
 * resolved by the `resolveMedia` the viewer is given — and [ts] the message time, which only
 * names the file when the picture is saved (`0` means "now").
 */
@Immutable
class GalleryImage(val id: String, val image: CloudImage, val ts: Long = 0L)

/**
 * The text of a picture's message when it *is* a caption: `null` for a blank one or for any of
 * the placeholders a picture sent without a caption carries (web's `pastedImage` in every
 * language). A picture with no caption is drawn without a bubble; one with a caption is
 * the picture over a compact bubble holding it.
 */
fun imageCaptionOf(text: String): String? =
    text.trim().takeIf { it.isNotEmpty() && it !in IMAGE_PLACEHOLDER_TEXTS }

/** Sizes the box from the picture's shape *before* any decode, so a bitmap arriving mid-scroll
 *  never relayouts the `LazyColumn` under the user's finger. */
private fun Modifier.inlineImageBox(naturalWidth: Int, naturalHeight: Int, longSide: Dp): Modifier =
    layout { measurable, constraints ->
        val box = inlineImageSize(naturalWidth, naturalHeight, longSide.roundToPx(), constraints.maxWidth, density)
        val placeable = measurable.measure(Constraints.fixed(box.width, box.height))
        layout(box.width, box.height) { placeable.place(0, 0) }
    }

/**
 * The in-thread photo: a box sized from the picture itself — long side up to
 * [InlineImageMaxSide], never wider than the room the row gives it, never larger than the
 * picture's logical dp dimensions — filled with `surfaceVariant` until the sampled bitmap lands, and
 * tapped open into the full-screen viewer (ImageViewer.kt), where the whole of [gallery] can
 * be paged through.
 *
 * It sizes **itself**: pass no width, height or aspect ratio. [modifier] lands on the *frame* —
 * exactly the picture's box — so a depth shadow or a selection ring the caller puts there follows
 * the picture and nothing else. [shape] clips the picture, and only the picture: the bubble's own
 * shape for one with no bubble around it, the top corners only for one over a caption. [overlay] is
 * drawn over the frame and is **not** clipped to it, for the time and delivery mark a captionless
 * picture carries — a mark wider than a tiny picture hangs past its edge instead of being cut off
 * (align it with `Modifier.align`, and give it `wrapContentSize(unbounded = true)` if it can be
 * larger than the frame). A selection tint over the picture belongs there too, clipped by the
 * caller to the same shape.
 *
 * The box is sized from [CloudImage.width]/[CloudImage.height] *before* any decode; once the
 * bytes are read their own size wins, as on web. [cacheKey] must be the message id: it is the
 * key of both the state and the bitmap cache, and hashing the data URL is the cost this
 * composable exists to remove. A changed [cacheKey] starts from that key's cached bitmap or
 * from nothing — never from the previous message's picture.
 *
 * [onLongClick] exists so the surrounding message bubble's own long-press menu
 * (reply/forward/copy/delete) stays reachable on an image message: a plain
 * `clickable` here would consume every touch — long or short — before the
 * bubble's `combinedClickable` ever saw it. [onClickOverride] does the same for a short tap
 * while a selection is up: the tap then toggles the message instead of opening the viewer.
 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
fun InlineImage(
    cacheKey: String,
    image: CloudImage,
    shape: Shape,
    contentDescription: String,
    /** Resolves [CloudImage.dataUrl] to the real `data:` URL — a file read,
     *  hence [Dispatchers.IO] below, never called on the composition thread. */
    resolveMedia: (String) -> String?,
    modifier: Modifier = Modifier,
    onLongClick: () -> Unit = {},
    onClickOverride: (() -> Unit)? = null,
    gallery: List<GalleryImage> = emptyList(),
    onNaturalSize: ((IntSize) -> Unit)? = null,
    overlay: @Composable BoxScope.() -> Unit = {},
) {
    val density = LocalDensity.current
    val screenWidthDp = LocalConfiguration.current.screenWidthDp
    val screenWidthPx = with(density) { screenWidthDp.dp.roundToPx() }
    val longSidePx = with(density) { InlineImageMaxSide.roundToPx() }
    val declared = image.width > 0 && image.height > 0

    // Predicted from the declared dimensions, which lets a cache hit be served synchronously as
    // the initial state: scrolling back to a photo already decoded shows it in the first frame,
    // with no placeholder flash. The box a photo can take is at most the screen wide.
    val plannedKey = if (declared) {
        val box = inlineImageSize(image.width, image.height, longSidePx, screenWidthPx, density.density)
        thumbnailKey(cacheKey, box.width, box.height)
    } else {
        null
    }
    var thumb by remember(cacheKey, plannedKey) {
        mutableStateOf(
            plannedKey?.let { ThumbnailCache.get(it) }?.let { Decoded(it, image.width, image.height) },
        )
    }
    var failed by remember(cacheKey) { mutableStateOf(false) }
    val resolve by rememberUpdatedState(resolveMedia)
    LaunchedEffect(cacheKey, image.dataUrl, longSidePx, screenWidthPx) {
        if (thumb != null) return@LaunchedEffect
        failed = false
        val resolved = withContext(Dispatchers.IO) { resolve(image.dataUrl) }
        val loaded = resolved?.let {
            withContext(Dispatchers.Default) { loadThumbnail(cacheKey, it, longSidePx, screenWidthPx, density.density) }
        }
        if (loaded != null) thumb = loaded else failed = true
    }

    var expanded by remember { mutableStateOf(false) }
    val shown = thumb
    val bitmap = remember(shown) { shown?.bitmap?.asImageBitmap() }
    // Real dimensions win once the bytes have been read; until then the declared ones, and for a
    // sender that declared none a 4:3 placeholder.
    val naturalWidth = shown?.naturalWidth ?: if (declared) image.width else UNKNOWN_NATURAL_WIDTH
    val naturalHeight = shown?.naturalHeight ?: if (declared) image.height else UNKNOWN_NATURAL_HEIGHT
    if (onNaturalSize != null) {
        val report by rememberUpdatedState(onNaturalSize)
        LaunchedEffect(cacheKey, shown?.naturalWidth, shown?.naturalHeight) {
            shown?.let { report(IntSize(it.naturalWidth, it.naturalHeight)) }
        }
    }

    // Two boxes, on purpose. The outer one is the frame — sized from the picture, carrying the
    // caller's own [modifier] (a depth shadow, a selection ring) — and is *not* clipped; only the
    // inner one, the picture itself, takes [shape]. So [overlay] is free to hang past the frame: the
    // time and delivery mark of a 40×10 sticker is wider than the sticker, and clipping it to the
    // picture would cut it off entirely.
    Box(modifier = modifier.inlineImageBox(naturalWidth, naturalHeight, InlineImageMaxSide)) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(shape)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .semantics { testTagsAsResourceId = true }
                .testTag("inline_image")
                .combinedClickable(
                    onClickLabel = if (onClickOverride == null) stringResource(R.string.image_viewer_open) else null,
                    onClick = onClickOverride ?: { expanded = true },
                    onLongClick = onLongClick,
                ),
            contentAlignment = Alignment.Center,
        ) {
            // Same box for every state: the placeholder is this Box's background, and the
            // bitmap fills it exactly rather than sizing to its own pixels.
            if (bitmap != null) {
                Image(
                    bitmap = bitmap,
                    contentDescription = contentDescription,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else if (failed) {
                // A payload that will not decode is a visible fact, not an empty grey box.
                Icon(
                    Icons.Filled.BrokenImage,
                    contentDescription = contentDescription,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }
        }
        overlay()
    }
    if (expanded) {
        ImageViewer(
            startId = cacheKey,
            start = image,
            gallery = gallery,
            resolveMedia = { resolve(it) },
            contentDescription = contentDescription,
            onDismiss = { expanded = false },
        )
    }
}
