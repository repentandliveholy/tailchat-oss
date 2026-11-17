package net.tailchat.android.ui

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import net.tailchat.android.cloud.ImageEdit

/*
 * The image editor's crop frame — web/cloud/app.js's image sheet (`resizeCropRect`,
 * `moveCropRect`, `setImageCropRatio`, `rotateImageSheet`), as pure functions, ported line
 * for line so the two clients move a handle the same way.
 *
 * The frame is kept as *fractions of the rotated picture*, so a resize of the window or a turn
 * of the picture never has to translate pixels; the drag maths run in frame pixels, which the
 * caller converts at the boundary.
 */

/** A rectangle: fractions of the rotated picture when stored, pixels of the on-screen frame in the drag maths. */
internal data class CropRect(val x: Float, val y: Float, val w: Float, val h: Float) {
    val right: Float get() = x + w
    val bottom: Float get() = y + h

    /** No crop at all. */
    val isWhole: Boolean get() = x <= 0f && y <= 0f && w >= 1f && h >= 1f

    fun scaledBy(width: Float, height: Float) = CropRect(x * width, y * height, w * width, h * height)
    fun dividedBy(width: Float, height: Float) = CropRect(x / width, y / height, w / width, h / height)

    companion object {
        val Whole = CropRect(0f, 0f, 1f, 1f)
    }
}

/** web's `IMAGE_CROP_RATIOS`; [base] is width / height, `0` for a free frame. */
internal enum class CropRatio(val base: Float) {
    Free(0f),
    Square(1f),
    FourThree(4f / 3f),
    SixteenNine(16f / 9f),
}

/** The eight handles of the frame: a corner moves two edges, an edge moves one. */
internal enum class CropHandle(val west: Boolean, val east: Boolean, val north: Boolean, val south: Boolean) {
    NorthWest(true, false, true, false),
    North(false, false, true, false),
    NorthEast(false, true, true, false),
    East(false, true, false, false),
    SouthEast(false, true, false, true),
    South(false, false, false, true),
    SouthWest(true, false, false, true),
    West(true, false, false, false),
}

/** What a touch at a point does to the frame. */
internal sealed interface CropTouch {
    data class Resize(val handle: CropHandle) : CropTouch
    data object Move : CropTouch
    data object None : CropTouch
}

/**
 * The aspect a ratio chip locks the frame to (width / height). 4:3 and 16:9 follow the picture —
 * a portrait screenshot gets 3:4 and 9:16 — and a free frame stays `0`.
 */
internal fun cropAspectFor(ratio: CropRatio, rotatedWidth: Int, rotatedHeight: Int): Float =
    if (ratio.base != 0f && rotatedHeight > rotatedWidth) 1f / ratio.base else ratio.base

/** The largest frame of [aspect]'s shape, centred on a [rotatedWidth]×[rotatedHeight] picture (fractions). */
internal fun cropFrameForAspect(aspect: Float, rotatedWidth: Int, rotatedHeight: Int): CropRect {
    val picture = rotatedWidth.toFloat() / rotatedHeight
    val w = if (aspect < picture) aspect / picture else 1f
    val h = if (aspect < picture) 1f else picture / aspect
    return CropRect((1f - w) / 2f, (1f - h) / 2f, w, h)
}

/** The frame turns clockwise with the picture, so what was selected stays selected. */
internal fun rotateCrop(crop: CropRect): CropRect = CropRect(1f - (crop.y + crop.h), crop.x, crop.h, crop.w)

/**
 * [rect] (frame pixels) with [handle] dragged by ([dx], [dy]): the edge or corner being dragged
 * follows the pointer and the opposite side stays put. With a kept shape ([aspect] > 0) the frame
 * grows to cover the pointer and then shrinks back to fit the picture, so it never leaves it.
 * [minSize] is the smallest side — below that the eight handles sit on top of each other.
 */
internal fun resizeCropRect(
    rect: CropRect,
    handle: CropHandle,
    dx: Float,
    dy: Float,
    aspect: Float,
    boundsWidth: Float,
    boundsHeight: Float,
    minSize: Float,
): CropRect {
    val west = handle.west
    val east = handle.east
    val north = handle.north
    val south = handle.south
    val minWidth = minOf(minSize, boundsWidth, rect.w)
    val minHeight = minOf(minSize, boundsHeight, rect.h)
    var left = rect.x + if (west) dx else 0f
    var right = rect.x + rect.w + if (east) dx else 0f
    var top = rect.y + if (north) dy else 0f
    var bottom = rect.y + rect.h + if (south) dy else 0f
    if (aspect <= 0f) {
        if (west) left = min(max(0f, left), right - minWidth)
        if (east) right = max(min(boundsWidth, right), left + minWidth)
        if (north) top = min(max(0f, top), bottom - minHeight)
        if (south) bottom = max(min(boundsHeight, bottom), top + minHeight)
        return CropRect(left, top, right - left, bottom - top)
    }
    var w = max(minWidth, right - left)
    var h = max(minHeight, bottom - top)
    val horizontal = west || east
    val vertical = north || south
    if (horizontal && vertical) {
        if (w / h > aspect) h = w / aspect else w = h * aspect
    } else if (horizontal) {
        h = w / aspect
    } else {
        w = h * aspect
    }
    val anchorX = if (west) rect.x + rect.w else if (east) rect.x else rect.x + rect.w / 2f
    val anchorY = if (north) rect.y + rect.h else if (south) rect.y else rect.y + rect.h / 2f
    val roomX = if (west) anchorX else if (east) boundsWidth - anchorX else 2f * min(anchorX, boundsWidth - anchorX)
    val roomY = if (north) anchorY else if (south) boundsHeight - anchorY else 2f * min(anchorY, boundsHeight - anchorY)
    val fit = minOf(1f, roomX / w, roomY / h)
    w *= fit
    h *= fit
    return CropRect(
        x = if (west) anchorX - w else if (east) anchorX else anchorX - w / 2f,
        y = if (north) anchorY - h else if (south) anchorY else anchorY - h / 2f,
        w = w,
        h = h,
    )
}

/** [rect] moved by ([dx], [dy]) and held inside the picture; its size is untouched. */
internal fun moveCropRect(rect: CropRect, dx: Float, dy: Float, boundsWidth: Float, boundsHeight: Float): CropRect =
    CropRect(
        x = min(max(0f, rect.x + dx), boundsWidth - rect.w),
        y = min(max(0f, rect.y + dy), boundsHeight - rect.h),
        w = rect.w,
        h = rect.h,
    )

/**
 * What a touch at ([x], [y]) grabs on [rect] (frame pixels). A corner wins within [slop] of it,
 * then an edge within [slop] of its line (along the whole edge, not only at its middle — a thumb
 * lands anywhere on it), then the inside moves the frame. Zones are centred on the frame's real
 * edges, half in and half out, so a frame that fills the picture can still be grabbed from the
 * picture's own margin.
 */
internal fun cropHitTest(rect: CropRect, x: Float, y: Float, slop: Float): CropTouch {
    val corners = listOf(
        CropHandle.NorthWest to (rect.x to rect.y),
        CropHandle.NorthEast to (rect.right to rect.y),
        CropHandle.SouthEast to (rect.right to rect.bottom),
        CropHandle.SouthWest to (rect.x to rect.bottom),
    )
    corners
        .filter { (_, point) -> abs(x - point.first) <= slop && abs(y - point.second) <= slop }
        .minByOrNull { (_, point) -> hypot(x - point.first, y - point.second) }
        ?.let { return CropTouch.Resize(it.first) }

    val withinX = x >= rect.x - slop && x <= rect.right + slop
    val withinY = y >= rect.y - slop && y <= rect.bottom + slop
    val edges = buildList {
        if (withinX) {
            add(CropHandle.North to abs(y - rect.y))
            add(CropHandle.South to abs(y - rect.bottom))
        }
        if (withinY) {
            add(CropHandle.West to abs(x - rect.x))
            add(CropHandle.East to abs(x - rect.right))
        }
    }
    edges.filter { it.second <= slop }.minByOrNull { it.second }?.let { return CropTouch.Resize(it.first) }

    val inside = x >= rect.x && x <= rect.right && y >= rect.y && y <= rect.bottom
    return if (inside) CropTouch.Move else CropTouch.None
}

/** The [ImageEdit] the editor hands back: `None` when nothing was changed, so an untouched picture is not re-cut. */
internal fun imageEditOf(quarterTurns: Int, crop: CropRect): ImageEdit {
    val turns = Math.floorMod(quarterTurns, 4)
    if (turns == 0 && crop.isWhole) return ImageEdit.None
    return ImageEdit(
        quarterTurns = turns,
        left = crop.x.coerceIn(0f, 1f),
        top = crop.y.coerceIn(0f, 1f),
        right = crop.right.coerceIn(0f, 1f),
        bottom = crop.bottom.coerceIn(0f, 1f),
    )
}

/** The pixel budget of the editor's own copy of the picture: 6 megapixels, 24 MB as ARGB_8888. */
private const val EDITOR_MAX_PIXELS = 6_000_000L

/**
 * `inSampleSize` for the editor's screen-sized copy: as sharp as the screen can show — the long
 * side stays at or above [maxSide], the longer edge of the display, because the picture may be
 * turned on its side — and never past [EDITOR_MAX_PIXELS], whatever the screen.
 */
internal fun editorSampleSize(width: Int, height: Int, maxSide: Int): Int {
    if (width <= 0 || height <= 0) return 1
    val longest = max(width, height)
    var sample = 1L
    while (maxSide > 0 && longest / (sample * 2) >= maxSide) sample *= 2
    while ((width / sample) * (height / sample) > EDITOR_MAX_PIXELS) sample *= 2
    return sample.toInt()
}
