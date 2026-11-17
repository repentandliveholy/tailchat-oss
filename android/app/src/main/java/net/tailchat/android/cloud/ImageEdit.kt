package net.tailchat.android.cloud

import androidx.compose.runtime.Immutable
import kotlin.math.roundToInt

/**
 * What the image editor did to a picture before it was sent: a clockwise
 * rotation and a crop, both described against the picture the person *saw* —
 * the EXIF-upright one — and never against raw sensor pixels.
 *
 * The edit is deliberately a description and not a bitmap. The editor shows a
 * screen-sized copy; the picture that leaves is cut from the original bytes by
 * [ImageEncoder], so cropping a corner of a 12-megapixel photo keeps the
 * detail that corner really has, and no full-size bitmap ever has to cross
 * the UI.
 *
 * [left]/[top]/[right]/[bottom] are fractions of the *rotated* picture, the
 * same space web's `imageSheet.crop` uses, so a resize of the window or a turn
 * of the picture never has to translate pixels.
 */
@Immutable
data class ImageEdit(
    /** Clockwise quarter turns, applied after the picture is made upright. Any integer; see [turns]. */
    val quarterTurns: Int = 0,
    val left: Float = 0f,
    val top: Float = 0f,
    val right: Float = 1f,
    val bottom: Float = 1f,
) {
    /** [quarterTurns] folded into 0..3. */
    val turns: Int get() = Math.floorMod(quarterTurns, 4)

    /** No crop at all: the whole rotated picture. */
    val isWhole: Boolean get() = left <= 0f && top <= 0f && right >= 1f && bottom >= 1f

    /** Nothing changed — the picture is sent exactly as it was picked. */
    val isIdentity: Boolean get() = turns == 0 && isWhole

    companion object {
        val None = ImageEdit()
    }
}

/** A pixel rectangle, edges in continuous coordinates: [right]/[bottom] are exclusive. */
internal data class PixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
}

/**
 * How a stored picture has to be moved to be upright: mirror it left-right
 * first when [flipped], then turn it clockwise by [turns] quarter turns. Every
 * one of the eight EXIF orientations is exactly one such pair, and so is an
 * orientation plus the editor's own rotation — which is why the encoder can
 * apply both in a single matrix.
 */
internal data class Orientation(val turns: Int, val flipped: Boolean) {
    /** The same orientation with [extraTurns] more clockwise quarter turns on top. */
    fun plus(extraTurns: Int): Orientation = copy(turns = Math.floorMod(turns + extraTurns, 4))

    /** Whether width and height trade places once the orientation is applied. */
    val swapsAxes: Boolean get() = turns % 2 == 1
}

/**
 * `ExifInterface.TAG_ORIENTATION` as an [Orientation]. 1 (normal) and anything
 * undefined or out of range are the identity, so a picture with no or garbled
 * EXIF is sent as stored.
 *
 * The mirrored four are the reason this is not a plain "degrees" lookup: 5 is
 * a transpose (reflect over the main diagonal) and 7 a transverse, which a
 * rotation alone gets wrong by a mirror image.
 */
internal fun orientationFromExif(exif: Int): Orientation = when (exif) {
    2 -> Orientation(turns = 0, flipped = true)
    3 -> Orientation(turns = 2, flipped = false)
    4 -> Orientation(turns = 2, flipped = true)
    5 -> Orientation(turns = 3, flipped = true)
    6 -> Orientation(turns = 1, flipped = false)
    7 -> Orientation(turns = 1, flipped = true)
    8 -> Orientation(turns = 3, flipped = false)
    else -> Orientation(turns = 0, flipped = false)
}

/**
 * [edit]'s crop as pixels of a rotated picture [width]×[height], rounded to
 * whole pixels the way web does (`Math.round` on each edge) and never smaller
 * than one pixel either way, so a degenerate frame still names a real area.
 * Non-finite fractions fall back to the uncropped edge.
 */
internal fun cropRectOf(edit: ImageEdit, width: Int, height: Int): PixelRect {
    require(width > 0 && height > 0) { "empty picture" }
    fun fraction(value: Float, fallback: Float) = if (value.isFinite()) value.coerceIn(0f, 1f) else fallback
    val left = (fraction(edit.left, 0f) * width).roundToInt().coerceIn(0, width - 1)
    val top = (fraction(edit.top, 0f) * height).roundToInt().coerceIn(0, height - 1)
    val right = (fraction(edit.right, 1f) * width).roundToInt().coerceIn(left + 1, width)
    val bottom = (fraction(edit.bottom, 1f) * height).roundToInt().coerceIn(top + 1, height)
    return PixelRect(left, top, right, bottom)
}

/**
 * Carries [rect], given in the frame a stored picture ends up in once
 * [orientation] has been applied, back to the stored picture's own pixels.
 * That is what lets the encoder decode only the cropped region of the file
 * instead of the whole frame: `BitmapRegionDecoder` addresses the stored
 * pixels, but the person cropped the upright ones.
 *
 * Undoes the steps in reverse: each clockwise quarter turn of a frame that is
 * now `w` wide sends the rectangle `(l, t, r, b)` back to `(t, w - r, b, w - l)`
 * in a frame that is `h` wide, and the mirror — applied first going forward —
 * is undone last.
 */
internal fun toRawRect(rect: PixelRect, rawWidth: Int, rawHeight: Int, orientation: Orientation): PixelRect {
    var current = rect
    var frameWidth = if (orientation.swapsAxes) rawHeight else rawWidth
    var frameHeight = if (orientation.swapsAxes) rawWidth else rawHeight
    repeat(orientation.turns) {
        current = PixelRect(
            left = current.top,
            top = frameWidth - current.right,
            right = current.bottom,
            bottom = frameWidth - current.left,
        )
        val width = frameWidth
        frameWidth = frameHeight
        frameHeight = width
    }
    if (orientation.flipped) {
        current = PixelRect(
            left = frameWidth - current.right,
            top = current.top,
            right = frameWidth - current.left,
            bottom = current.bottom,
        )
    }
    return current
}
