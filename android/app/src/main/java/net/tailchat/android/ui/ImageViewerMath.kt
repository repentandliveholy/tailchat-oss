package net.tailchat.android.ui

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/*
 * The full-screen viewer's geometry — web/cloud/app.js's lightbox, as pure functions.
 *
 * Everything is in device pixels, and the picture is positioned the way web positions
 * it: by one *scale* (device pixels per picture pixel) and the picture's top-left corner
 * in the viewer's own pixels. Every gesture is then the same three numbers, and none of
 * them touches layout.
 *
 * `1f` is native: one picture pixel on one device pixel. The picture opens fitted and is
 * never enlarged past native, so a small picture stays small and sharp; zoom runs to
 * eight times the fitted size, and never less than native.
 */

/** web's `LIGHTBOX_MAX_ZOOM`. */
internal const val VIEWER_MAX_ZOOM = 8f

/** Where the picture is: [scale] in device pixels per picture pixel, top-left corner at ([x], [y]). */
internal data class ViewerPose(val scale: Float, val x: Float, val y: Float)

/** The scale at which the whole picture is visible in the box — at most native, never an enlargement. */
internal fun viewerFitScale(naturalWidth: Float, naturalHeight: Float, boxWidth: Float, boxHeight: Float): Float {
    if (naturalWidth <= 0f || naturalHeight <= 0f || boxWidth <= 0f || boxHeight <= 0f) return 1f
    return min(1f, min(boxWidth / naturalWidth, boxHeight / naturalHeight))
}

/** Zoom's ceiling: eight times the fitted size, but native at the very least — a picture that
 *  already fits at native can still be looked into. */
internal fun viewerMaxScale(fit: Float): Float = max(fit * VIEWER_MAX_ZOOM, 1f)

/** Where a double tap goes from the fitted view: native, or — when the picture already fits at
 *  native, so native is no zoom at all — twice the fitted size. */
internal fun viewerDoubleTapScale(fit: Float): Float = if (fit < 0.999f) 1f else fit * 2f

/** web's `lightboxAtFit`: a hair of tolerance so float error never reads as "zoomed". */
internal fun viewerAtFit(pose: ViewerPose, fit: Float): Boolean = pose.scale <= fit * 1.001f

/**
 * One axis of the pan limit. A picture smaller than the box is centred; a larger one may not
 * open a gap at either edge, so it is held between "its far edge at the box's far edge" and
 * "its near edge at the box's near edge" — exact, not a heuristic bound.
 */
internal fun viewerClampAxis(position: Float, shown: Float, box: Float): Float =
    if (shown <= box) (box - shown) / 2f else position.coerceIn(box - shown, 0f)

internal fun viewerClamp(pose: ViewerPose, naturalWidth: Float, naturalHeight: Float, boxWidth: Float, boxHeight: Float): ViewerPose =
    pose.copy(
        x = viewerClampAxis(pose.x, naturalWidth * pose.scale, boxWidth),
        y = viewerClampAxis(pose.y, naturalHeight * pose.scale, boxHeight),
    )

/** The picture fitted and centred. */
internal fun viewerFitPose(naturalWidth: Float, naturalHeight: Float, boxWidth: Float, boxHeight: Float): ViewerPose {
    val fit = viewerFitScale(naturalWidth, naturalHeight, boxWidth, boxHeight)
    return viewerClamp(ViewerPose(fit, 0f, 0f), naturalWidth, naturalHeight, boxWidth, boxHeight)
}

/**
 * One step of a pinch, a wheel, a double tap or a drag, all of which are "scale by [zoom] about
 * a point and move that point": the picture pixel that was under ([fromX], [fromY]) ends up under
 * ([toX], [toY]). A pure pan is `zoom = 1`, a zoom about a fixed point `from == to`.
 *
 * The scale stays between the fitted size and [viewerMaxScale], and the result is clamped, so a
 * gesture can neither shrink the picture past fit nor drag it off the screen.
 */
internal fun viewerTransform(
    pose: ViewerPose,
    zoom: Float,
    fromX: Float,
    fromY: Float,
    toX: Float,
    toY: Float,
    fit: Float,
    naturalWidth: Float,
    naturalHeight: Float,
    boxWidth: Float,
    boxHeight: Float,
): ViewerPose {
    val next = (pose.scale * zoom).coerceIn(fit, viewerMaxScale(fit))
    val ratio = if (pose.scale > 0f) next / pose.scale else 1f
    return viewerClamp(
        ViewerPose(next, toX - (fromX - pose.x) * ratio, toY - (fromY - pose.y) * ratio),
        naturalWidth,
        naturalHeight,
        boxWidth,
        boxHeight,
    )
}

/** Whether the point lies on the picture (as opposed to the black around it). */
internal fun viewerHitsImage(pose: ViewerPose, naturalWidth: Float, naturalHeight: Float, pointX: Float, pointY: Float): Boolean =
    pointX >= pose.x && pointX <= pose.x + naturalWidth * pose.scale &&
        pointY >= pose.y && pointY <= pose.y + naturalHeight * pose.scale

/** Linear interpolation between two poses, for the animated jumps (double tap). */
internal fun viewerLerp(from: ViewerPose, to: ViewerPose, t: Float): ViewerPose = ViewerPose(
    scale = from.scale + (to.scale - from.scale) * t,
    x = from.x + (to.x - from.x) * t,
    y = from.y + (to.y - from.y) * t,
)

/**
 * A horizontal swipe at the fitted size: `+1` to the next picture (the finger went left), `-1` to
 * the previous one, `0` to spring back. It takes either a long enough drag ([distancePx]) or a
 * flick ([flingPx] per second) over at least a quarter of that distance, so a quick short flick pages
 * and a slow hesitant drag does not.
 */
internal fun viewerPageDelta(dx: Float, velocityX: Float, distancePx: Float, flingPx: Float): Int {
    val dragged = abs(dx) > distancePx
    val flicked = abs(velocityX) > flingPx && abs(dx) > distancePx / 4f
    if (!dragged && !flicked) return 0
    return if (dx < 0f) 1 else -1
}

/** A downward swipe at the fitted size closes the viewer: far enough, or a flick over part of it. */
internal fun viewerShouldDismiss(dy: Float, velocityY: Float, distancePx: Float, flingPx: Float): Boolean =
    dy > distancePx || (velocityY > flingPx && dy > distancePx / 4f)

/** The scrim's strength while a swipe-down pulls the picture away: web's `max(0.3, 1 - dy / 400)`. */
internal fun viewerScrimFade(swipeY: Float, rangePx: Float): Float =
    max(0.3f, 1f - max(0f, swipeY) / rangePx)
