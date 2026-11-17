package net.tailchat.android.ui

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import android.view.accessibility.AccessibilityManager
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.tailchat.android.R
import net.tailchat.android.cloud.CloudImage

/*
 * The full-screen viewer — web/cloud/app.js's lightbox, for a thumb.
 *
 * Nothing but the picture: it opens fitted (never blown up past native), zooms to eight times
 * the fitted size by pinch or a double tap, pans within the picture's own edges, and pages
 * through the pictures of the open conversation. Swiping sideways to the next picture and
 * downward to dismiss both work only at the fitted size; once zoomed a drag is a pan and
 * nothing else, so panning around a detail can never page away or close it.
 *
 * Only ever composed while open, which is what keeps the full-resolution decode lazy: one
 * picture is decoded at a time (FullBitmapCache's single slot), the one on screen, and
 * closing the viewer starts nothing again.
 */

/** web's `LIGHTBOX_IDLE_MS`: how long the controls stay after the last tap. */
private const val CONTROLS_IDLE_MS = 2_000L
/** web's `LIGHTBOX_DOUBLE_TAP_MS`. */
private const val DOUBLE_TAP_MS = 300L

/** Where saved pictures go, under `Pictures/`. */
private const val GALLERY_FOLDER = "Tailchat"

/** What the fingers are doing in one gesture. */
private enum class Touch { Press, Pan, Swipe, Pinch }

/** The picture's own size and the viewer's, with everything that follows from them. */
private class ViewerGeometry(
    val naturalWidth: Float,
    val naturalHeight: Float,
    val boxWidth: Float,
    val boxHeight: Float,
) {
    val ready: Boolean get() = naturalWidth > 0f && naturalHeight > 0f && boxWidth > 0f && boxHeight > 0f
    val fit: Float = viewerFitScale(naturalWidth, naturalHeight, boxWidth, boxHeight)
    val fitPose: ViewerPose = viewerFitPose(naturalWidth, naturalHeight, boxWidth, boxHeight)

    /** The pose in force: the person's own once they have zoomed, the fitted one otherwise. */
    fun poseOf(user: ViewerPose?): ViewerPose =
        user?.let { viewerClamp(it, naturalWidth, naturalHeight, boxWidth, boxHeight) } ?: fitPose

    fun transform(pose: ViewerPose, zoom: Float, fromX: Float, fromY: Float, toX: Float, toY: Float): ViewerPose =
        viewerTransform(pose, zoom, fromX, fromY, toX, toY, fit, naturalWidth, naturalHeight, boxWidth, boxHeight)
}

/**
 * The viewer over [gallery]'s pictures, opened on [startId].
 *
 * [gallery] is the open conversation's pictures in transcript order; when it does not hold
 * [startId] (a caller with nothing to page through) the viewer shows [start] alone. The
 * position is tracked by id, not by index, so a message arriving or being deleted while the
 * viewer is open moves nothing under the reader's eyes; a picture whose message disappears
 * stays on screen until the reader leaves it.
 */
@Composable
internal fun ImageViewer(
    startId: String,
    start: CloudImage,
    gallery: List<GalleryImage>,
    resolveMedia: (String) -> String?,
    contentDescription: String,
    onDismiss: () -> Unit,
) {
    val items = remember(gallery, startId, start) {
        if (gallery.any { it.id == startId }) gallery else listOf(GalleryImage(startId, start))
    }
    var currentId by remember { mutableStateOf(startId) }
    val lastShown = remember { arrayOfNulls<GalleryImage>(1) }
    val index = items.indexOfFirst { it.id == currentId }
    val current = items.getOrNull(index)?.also { lastShown[0] = it } ?: lastShown[0] ?: GalleryImage(startId, start)

    FullscreenDialog(onDismissRequest = onDismiss) {
        // A new page is a new composition: nothing of the last picture's zoom, decode or
        // controls timer can leak into the next.
        key(current.id) {
            ViewerPage(
                item = current,
                position = if (index >= 0 && items.size > 1) index + 1 to items.size else null,
                hasPrevious = index > 0,
                hasNext = index in 0 until items.lastIndex,
                resolveMedia = resolveMedia,
                contentDescription = contentDescription,
                onPage = { delta -> items.getOrNull(index + delta)?.let { currentId = it.id } },
                onDismiss = onDismiss,
            )
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun ViewerPage(
    item: GalleryImage,
    position: Pair<Int, Int>?,
    hasPrevious: Boolean,
    hasNext: Boolean,
    resolveMedia: (String) -> String?,
    contentDescription: String,
    onPage: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val latestResolve by rememberUpdatedState(resolveMedia)
    val latestOnPage by rememberUpdatedState(onPage)
    val latestOnDismiss by rememberUpdatedState(onDismiss)
    val latestHasPrevious by rememberUpdatedState(hasPrevious)
    val latestHasNext by rememberUpdatedState(hasNext)

    // ---- what is on screen ----
    // The thumbnail stands in, upscaled, until the sharp decode lands, so the viewer opens on the
    // same frame as the tap; a failed sharp decode leaves the thumbnail up instead of an empty screen.
    var full by remember { mutableStateOf(FullBitmapCache.get(fullKey(item.id))) }
    var failed by remember { mutableStateOf(false) }
    val thumb = remember { ThumbnailCache.any(item.id) }
    LaunchedEffect(Unit) {
        if (full != null) return@LaunchedEffect
        val resolved = withContext(Dispatchers.IO) { latestResolve(item.image.dataUrl) }
        val loaded = resolved?.let { withContext(Dispatchers.Default) { loadFull(item.id, it) } }
        if (loaded != null) full = loaded else failed = true
    }
    val sharp = full
    val sharpBitmap = remember(sharp) { sharp?.bitmap?.asImageBitmap() }
    val thumbBitmap = remember(thumb) { thumb?.asImageBitmap() }
    val shown = sharpBitmap ?: thumbBitmap

    // ---- geometry ----
    var box by remember { mutableStateOf(IntSize.Zero) }
    val naturalWidth = sharp?.naturalWidth ?: item.image.width.takeIf { it > 0 } ?: thumb?.width ?: 0
    val naturalHeight = sharp?.naturalHeight ?: item.image.height.takeIf { it > 0 } ?: thumb?.height ?: 0
    val geometry = remember(naturalWidth, naturalHeight, box, density.density) {
        ViewerGeometry(naturalWidth * density.density, naturalHeight * density.density, box.width.toFloat(), box.height.toFloat())
    }
    val latestGeometry by rememberUpdatedState(geometry)
    // `null` is "fitted": the pose then follows the picture's size and the window's, so a rotation
    // or the sharp decode revealing the real dimensions refits it without anyone doing anything.
    var userPose by remember { mutableStateOf<ViewerPose?>(null) }
    var swipeX by remember { mutableFloatStateOf(0f) }
    var swipeY by remember { mutableFloatStateOf(0f) }
    var enter by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) { animate(0f, 1f, animationSpec = tween(150)) { value, _ -> enter = value } }

    // ---- controls ----
    var controlsVisible by remember { mutableStateOf(true) }
    var wakes by remember { mutableIntStateOf(0) }
    // With a screen reader running the controls never leave: a control that vanishes while the
    // reader is exploring is one it can no longer find.
    val exploring = remember {
        (context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager)?.isTouchExplorationEnabled == true
    }
    LaunchedEffect(wakes) {
        controlsVisible = true
        if (!exploring) {
            delay(CONTROLS_IDLE_MS)
            controlsVisible = false
        }
    }
    val wake = { wakes += 1 }

    // ---- motion ----
    var motion by remember { mutableStateOf<Job?>(null) }
    var leaving by remember { mutableStateOf(false) }
    val pageDistancePx = with(density) { 64.dp.toPx() }
    val flingPx = with(density) { 600.dp.toPx() }
    val dismissRangePx = with(density) { 400.dp.toPx() }
    val doubleTapSlopPx = with(density) { 32.dp.toPx() }

    fun glideTo(target: ViewerPose) {
        val geo = latestGeometry
        val from = geo.poseOf(userPose)
        motion?.cancel()
        motion = scope.launch {
            animate(0f, 1f, animationSpec = tween(200)) { t, _ -> userPose = viewerLerp(from, target, t) }
            // Arriving at the fitted pose hands it back to the picture's own size.
            if (viewerAtFit(target, geo.fit)) userPose = null
        }
    }

    fun springBack() {
        val fromX = swipeX
        val fromY = swipeY
        motion?.cancel()
        motion = scope.launch {
            animate(0f, 1f, animationSpec = tween(180)) { t, _ ->
                swipeX = fromX * (1f - t)
                swipeY = fromY * (1f - t)
            }
        }
    }

    fun flyAway() {
        if (leaving) return
        leaving = true
        val fromY = swipeY
        val toY = latestGeometry.boxHeight
        motion?.cancel()
        motion = scope.launch {
            animate(0f, 1f, animationSpec = tween(160)) { t, _ -> swipeY = fromY + (toY - fromY) * t }
            latestOnDismiss()
        }
    }

    fun toggleZoom(point: Offset) {
        val geo = latestGeometry
        val pose = geo.poseOf(userPose)
        if (!viewerAtFit(pose, geo.fit)) {
            glideTo(geo.fitPose)
        } else {
            glideTo(geo.transform(pose, viewerDoubleTapScale(geo.fit) / pose.scale, point.x, point.y, point.x, point.y))
        }
    }

    val saveLabel = stringResource(R.string.image_viewer_save)
    val closeLabel = stringResource(R.string.image_viewer_close)
    val nextLabel = stringResource(R.string.image_viewer_next)
    val previousLabel = stringResource(R.string.image_viewer_previous)
    fun save() {
        scope.launch {
            // Once started, a save finishes: leaving the viewer must not strand a half-written file.
            withContext(NonCancellable) {
                val app = context.applicationContext
                val saved = withContext(Dispatchers.IO) {
                    val dataUrl = latestResolve(item.image.dataUrl)
                        ?: return@withContext Result.failure<String>(IOException("the picture is gone"))
                    saveImageToGallery(app, item.ts, dataUrl)
                }
                val message = saved.fold(
                    onSuccess = { app.getString(R.string.image_viewer_saved, it) },
                    onFailure = { app.getString(R.string.image_viewer_save_failed) },
                )
                Toast.makeText(app, message, Toast.LENGTH_SHORT).show()
            }
        }
    }

    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { box = it }
            // The scrim fades as a swipe down pulls the picture away, the way it will leave.
            .drawBehind { drawRect(Color.Black.copy(alpha = 0.92f * viewerScrimFade(swipeY, dismissRangePx))) }
            .semantics {
                testTagsAsResourceId = true
                this.contentDescription = contentDescription
                customActions = buildList {
                    if (hasNext) add(CustomAccessibilityAction(nextLabel) { latestOnPage(1); true })
                    if (hasPrevious) add(CustomAccessibilityAction(previousLabel) { latestOnPage(-1); true })
                }
            }
            .testTag("image_viewer")
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionLeft -> {
                        if (latestHasPrevious) latestOnPage(-1)
                        wake()
                        true
                    }
                    Key.DirectionRight -> {
                        if (latestHasNext) latestOnPage(1)
                        wake()
                        true
                    }
                    Key.Escape -> {
                        latestOnDismiss()
                        true
                    }
                    else -> false
                }
            }
            .pointerInput(Unit) {
                var lastTapUptime = 0L
                var lastTap = Offset.Zero
                val slop = viewConfiguration.touchSlop
                awaitEachGesture {
                    // A press a control already took (the ✕, the save icon) is theirs, not a gesture here.
                    val down = awaitFirstDown()
                    motion?.cancel()
                    var touch = Touch.Press
                    var travelX = 0f
                    var travelY = 0f
                    var horizontal = false
                    val tracker = VelocityTracker()
                    tracker.addPosition(down.uptimeMillis, down.position)
                    do {
                        val event = awaitPointerEvent()
                        val geo = latestGeometry
                        val pressed = event.changes.count { it.pressed }
                        val pan = event.calculatePan()
                        if (!geo.ready) continue
                        if (pressed >= 2) {
                            if (touch != Touch.Pinch) {
                                touch = Touch.Pinch
                                swipeX = 0f
                                swipeY = 0f
                            }
                            val zoom = event.calculateZoom()
                            val centroid = event.calculateCentroid(useCurrent = true)
                            if (zoom != 1f || pan != Offset.Zero) {
                                val from = centroid - pan
                                val next = geo.transform(geo.poseOf(userPose), zoom, from.x, from.y, centroid.x, centroid.y)
                                userPose = next.takeUnless { viewerAtFit(it, geo.fit) }
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } else if (pressed == 1) {
                            val change = event.changes.first { it.pressed }
                            tracker.addPosition(change.uptimeMillis, change.position)
                            if (touch == Touch.Press) {
                                travelX += pan.x
                                travelY += pan.y
                                if (hypot(travelX, travelY) > slop) {
                                    if (viewerAtFit(geo.poseOf(userPose), geo.fit)) {
                                        touch = Touch.Swipe
                                        horizontal = abs(travelX) > abs(travelY)
                                        if (horizontal) swipeX = travelX else swipeY = max(0f, travelY)
                                    } else {
                                        touch = Touch.Pan
                                        userPose = geo.transform(geo.poseOf(userPose), 1f, 0f, 0f, travelX, travelY)
                                    }
                                    change.consume()
                                }
                            } else if (touch == Touch.Swipe) {
                                if (horizontal) {
                                    val to = swipeX + pan.x
                                    // Past the first or last picture the drag gives, so it reads as an edge.
                                    val blocked = (to < 0f && !latestHasNext) || (to > 0f && !latestHasPrevious)
                                    swipeX += if (blocked) pan.x * 0.3f else pan.x
                                } else {
                                    swipeY = max(0f, swipeY + pan.y)
                                }
                                change.consume()
                            } else if (!viewerAtFit(geo.poseOf(userPose), geo.fit)) {
                                // Pan, or the finger left over from a pinch: either way it moves the picture.
                                userPose = geo.transform(geo.poseOf(userPose), 1f, 0f, 0f, pan.x, pan.y)
                                change.consume()
                            }
                        }
                    } while (event.changes.any { it.pressed })

                    val geo = latestGeometry
                    when (touch) {
                        Touch.Press -> {
                            val pose = geo.poseOf(userPose)
                            val now = down.uptimeMillis
                            if (lastTapUptime != 0L && now - lastTapUptime <= DOUBLE_TAP_MS &&
                                (down.position - lastTap).getDistance() <= doubleTapSlopPx
                            ) {
                                lastTapUptime = 0L
                                if (geo.ready && viewerHitsImage(pose, geo.naturalWidth, geo.naturalHeight, down.position.x, down.position.y)) {
                                    toggleZoom(down.position)
                                }
                            } else {
                                lastTapUptime = now
                                lastTap = down.position
                                // The black around a fitted picture is "outside": tapping it closes, as on web.
                                val outside = geo.ready &&
                                    !viewerHitsImage(pose, geo.naturalWidth, geo.naturalHeight, down.position.x, down.position.y)
                                if (outside && viewerAtFit(pose, geo.fit)) latestOnDismiss() else wake()
                            }
                        }
                        Touch.Swipe -> {
                            val velocity = tracker.calculateVelocity()
                            if (horizontal) {
                                val delta = viewerPageDelta(swipeX, velocity.x, pageDistancePx, flingPx)
                                val reachable = (delta > 0 && latestHasNext) || (delta < 0 && latestHasPrevious)
                                if (delta != 0 && reachable) {
                                    swipeX = 0f
                                    latestOnPage(delta)
                                } else {
                                    springBack()
                                }
                            } else if (viewerShouldDismiss(swipeY, velocity.y, pageDistancePx, flingPx)) {
                                flyAway()
                            } else {
                                springBack()
                            }
                        }
                        Touch.Pinch -> {
                            // A pinch that ended at the fitted size is the fitted view again.
                            if (viewerAtFit(geo.poseOf(userPose), geo.fit)) userPose = null
                        }
                        Touch.Pan -> Unit
                    }
                }
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val bitmap = shown ?: return@Canvas
            if (!geometry.ready) return@Canvas
            val pose = geometry.poseOf(userPose)
            withTransform({
                translate(left = pose.x + swipeX, top = pose.y + swipeY)
                // The bitmap on hand may be a thumbnail or a sampled decode: it is stretched
                // to the picture's own size, which is what the pose measures.
                scale(
                    scaleX = geometry.naturalWidth * pose.scale / bitmap.width,
                    scaleY = geometry.naturalHeight * pose.scale / bitmap.height,
                    pivot = Offset.Zero,
                )
            }) {
                drawImage(bitmap, alpha = enter, filterQuality = FilterQuality.Medium)
            }
        }
        if (shown == null) {
            if (failed) {
                Icon(
                    Icons.Filled.BrokenImage,
                    contentDescription = stringResource(R.string.image_viewer_failed),
                    tint = Color.White.copy(alpha = 0.7f),
                    modifier = Modifier.align(Alignment.Center).size(48.dp),
                )
            } else {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center).size(32.dp),
                    color = Color.White.copy(alpha = 0.8f),
                    strokeWidth = 2.dp,
                )
            }
        }

        Box(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(12.dp),
        ) {
            if (position != null) {
                AnimatedVisibility(
                    visible = controlsVisible,
                    modifier = Modifier.align(Alignment.TopCenter),
                    enter = fadeIn(tween(150)),
                    exit = fadeOut(tween(150)),
                ) {
                    Text(
                        stringResource(R.string.image_viewer_counter, position.first, position.second),
                        color = Color.White,
                        style = TextStyle(fontSize = 13.sp, fontFeatureSettings = "tnum"),
                        modifier = Modifier
                            .background(Color.Black.copy(alpha = 0.45f), CircleShape)
                            .padding(horizontal = 10.dp, vertical = 4.dp)
                            .testTag("image_viewer_counter"),
                    )
                }
            }
            AnimatedVisibility(
                visible = controlsVisible,
                modifier = Modifier.align(Alignment.TopEnd),
                enter = fadeIn(tween(150)),
                exit = fadeOut(tween(150)),
            ) {
                Row {
                    IconButton(
                        onClick = { wake(); save() },
                        modifier = Modifier.size(44.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape)
                            .testTag("image_viewer_save"),
                    ) {
                        Icon(Icons.Filled.Download, contentDescription = saveLabel, tint = Color.White, modifier = Modifier.size(22.dp))
                    }
                    Box(Modifier.size(8.dp))
                    IconButton(
                        onClick = { latestOnDismiss() },
                        modifier = Modifier.size(44.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape)
                            .testTag("image_viewer_close"),
                    ) {
                        Icon(Icons.Filled.Close, contentDescription = closeLabel, tint = Color.White, modifier = Modifier.size(22.dp))
                    }
                }
            }
        }
    }
}

/**
 * Writes [dataUrl]'s bytes — the picture exactly as it was sent, not re-encoded — into the
 * shared `Pictures/Tailchat` folder, and returns where it went.
 *
 * Needs no permission and asks for none: on API 29 and later a MediaStore row this app inserts
 * is its own to write, and that is the minimum SDK. `IS_PENDING` keeps the file invisible to the
 * gallery until it is complete, and a failed write takes its row with it, so there is never a
 * half-picture in the gallery.
 *
 * [timestamp] is the message's time and names the file (`tailchat-20261028-153000.webp`) the way
 * web names it; `0` means now.
 */
internal fun saveImageToGallery(context: Context, timestamp: Long, dataUrl: String): Result<String> {
    val mime = dataUrl.substringAfter("data:", "").substringBefore(';').substringBefore(',').lowercase()
        .takeIf { it.startsWith("image/") && it.length > 6 } ?: "image/jpeg"
    val extension = when (val subtype = mime.substringAfter('/').substringBefore('+')) {
        "jpeg", "jpg" -> "jpg"
        else -> subtype.filter { it.isLetterOrDigit() }.ifEmpty { "img" }
    }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(if (timestamp > 0L) timestamp else System.currentTimeMillis()))
    val name = "tailchat-$stamp.$extension"
    val resolver = context.contentResolver
    val pending = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + GALLERY_FOLDER)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    // MediaStore resolves a colliding DISPLAY_NAME itself by appending " (1)", so no uniquifying loop here.
    val uri = try {
        resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, pending)
    } catch (error: Exception) {
        return Result.failure(error)
    } ?: return Result.failure(IOException("the gallery refused $name"))
    try {
        val out = resolver.openOutputStream(uri) ?: throw IOException("cannot write $name to the gallery")
        out.use { it.write(payloadOf(dataUrl)) }
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        if (resolver.update(uri, done, null, null) == 0) throw IOException("$name stayed pending in the gallery")
    } catch (error: Exception) {
        runCatching { resolver.delete(uri, null, null) }
        return Result.failure(error)
    }
    return Result.success(Environment.DIRECTORY_PICTURES + "/" + GALLERY_FOLDER)
}
