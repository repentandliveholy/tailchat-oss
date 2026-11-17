package net.tailchat.android.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The editor describes a crop against the picture the person *saw* — EXIF-upright, then turned —
 * and the encoder has to cut that region out of the *stored* pixels. Everything between those two
 * spaces is arithmetic that is wrong silently: a crop that lands on the mirror image of what was
 * framed looks like a perfectly good photo. So it is pinned pixel by pixel, against a plain
 * forward mapping written the obvious way.
 */
class ImageEditGeometryTest {
    /** Where the stored pixel ([x], [y]) of a [w]×[h] picture lands once [o] is applied: mirrored first, then turned clockwise. */
    private fun forward(x: Int, y: Int, w: Int, h: Int, o: Orientation): Pair<Int, Int> {
        var px = x
        var py = y
        var frameWidth = w
        var frameHeight = h
        if (o.flipped) px = frameWidth - 1 - px
        repeat(o.turns) {
            // One clockwise quarter turn of a frameWidth×frameHeight picture: (x, y) -> (frameHeight - 1 - y, x).
            val nextX = frameHeight - 1 - py
            val nextY = px
            px = nextX
            py = nextY
            val swap = frameWidth
            frameWidth = frameHeight
            frameHeight = swap
        }
        return px to py
    }

    /** Gives a pixel mapping lambda its parameter types, which `1 to { x, y -> … }` has no way to infer. */
    private fun pixelMap(block: (Int, Int) -> Pair<Int, Int>): (Int, Int) -> Pair<Int, Int> = block

    @Test
    fun theEightExifOrientationsMoveAPixelTheWayTheSpecSays() {
        // A 4×2 picture: W = 4, H = 2, so the corners are easy to follow.
        val w = 4
        val h = 2
        val expected = mapOf(
            1 to pixelMap { x, y -> x to y },
            2 to pixelMap { x, y -> (w - 1 - x) to y }, // mirrored left-right
            3 to pixelMap { x, y -> (w - 1 - x) to (h - 1 - y) }, // 180°
            4 to pixelMap { x, y -> x to (h - 1 - y) }, // mirrored top-bottom
            5 to pixelMap { x, y -> y to x }, // transpose
            6 to pixelMap { x, y -> (h - 1 - y) to x }, // 90° clockwise
            7 to pixelMap { x, y -> (h - 1 - y) to (w - 1 - x) }, // transverse
            8 to pixelMap { x, y -> y to (w - 1 - x) }, // 270° clockwise
        )
        for ((exif, mapping) in expected) {
            val orientation = orientationFromExif(exif)
            for (y in 0 until h) for (x in 0 until w) {
                assertEquals("exif $exif at ($x, $y)", mapping(x, y), forward(x, y, w, h, orientation))
            }
        }
    }

    @Test
    fun anUndefinedOrOutOfRangeOrientationIsTheIdentity() {
        for (exif in listOf(0, -1, 9, 255)) {
            assertEquals(Orientation(0, false), orientationFromExif(exif))
        }
    }

    @Test
    fun theEditorsTurnsAddOnTopOfExifAndWrapAround() {
        assertEquals(Orientation(3, true), Orientation(1, true).plus(2))
        assertEquals(Orientation(1, false), Orientation(3, false).plus(2))
        assertEquals(Orientation(2, false), Orientation(0, false).plus(-2))
        assertTrue(Orientation(1, false).swapsAxes)
        assertFalse(Orientation(2, true).swapsAxes)
    }

    @Test
    fun theRawRectIsExactlyTheStoredPixelsTheCropShows() {
        for ((w, h) in listOf(5 to 3, 3 to 5, 4 to 4, 1 to 6)) {
            for (turns in 0..3) for (flipped in listOf(false, true)) {
                val orientation = Orientation(turns, flipped)
                val frameWidth = if (orientation.swapsAxes) h else w
                val frameHeight = if (orientation.swapsAxes) w else h
                // Every crop rectangle there is of the upright, turned picture.
                for (left in 0 until frameWidth) for (right in left + 1..frameWidth) {
                    for (top in 0 until frameHeight) for (bottom in top + 1..frameHeight) {
                        val rect = PixelRect(left, top, right, bottom)
                        val shown = mutableSetOf<Pair<Int, Int>>()
                        for (y in 0 until h) for (x in 0 until w) {
                            val (fx, fy) = forward(x, y, w, h, orientation)
                            if (fx in left until right && fy in top until bottom) shown += x to y
                        }
                        val raw = toRawRect(rect, w, h, orientation)
                        val cut = mutableSetOf<Pair<Int, Int>>()
                        for (y in raw.top until raw.bottom) for (x in raw.left until raw.right) cut += x to y
                        assertEquals("${w}x$h turns=$turns flipped=$flipped rect=$rect", shown, cut)
                    }
                }
            }
        }
    }

    @Test
    fun anIdentityEditIsRecognisedAndAnythingElseIsNot() {
        assertTrue(ImageEdit.None.isIdentity)
        assertTrue(ImageEdit(quarterTurns = 4).isIdentity)
        assertTrue(ImageEdit(quarterTurns = -8).isIdentity)
        assertFalse(ImageEdit(quarterTurns = 1).isIdentity)
        assertFalse(ImageEdit(left = 0.1f).isIdentity)
        assertFalse(ImageEdit(bottom = 0.9f).isIdentity)
        assertTrue(ImageEdit(quarterTurns = 1).isWhole)
    }

    @Test
    fun quarterTurnsFoldIntoZeroToThree() {
        assertEquals(0, ImageEdit(quarterTurns = 4).turns)
        assertEquals(3, ImageEdit(quarterTurns = -1).turns)
        assertEquals(1, ImageEdit(quarterTurns = 5).turns)
    }

    @Test
    fun aCropRoundsEachEdgeTheWayWebDoes() {
        assertEquals(PixelRect(0, 0, 100, 50), cropRectOf(ImageEdit.None, 100, 50))
        assertEquals(PixelRect(25, 0, 75, 50), cropRectOf(ImageEdit(left = 0.25f, right = 0.75f), 100, 50))
        assertEquals(PixelRect(33, 10, 100, 40), cropRectOf(ImageEdit(left = 0.333f, top = 0.2f, bottom = 0.8f), 100, 50))
    }

    @Test
    fun aDegenerateCropStillNamesARealArea() {
        // Left and right on the same edge: one pixel wide, not zero.
        assertEquals(PixelRect(50, 0, 51, 50), cropRectOf(ImageEdit(left = 0.5f, right = 0.5f), 100, 50))
        // Inverted, or outside the picture, or not a number: clamped into it.
        assertEquals(PixelRect(60, 0, 61, 50), cropRectOf(ImageEdit(left = 0.6f, right = 0.2f), 100, 50))
        assertEquals(PixelRect(0, 0, 100, 50), cropRectOf(ImageEdit(left = -3f, right = 9f, top = -1f, bottom = 4f), 100, 50))
        assertEquals(PixelRect(0, 0, 100, 50), cropRectOf(ImageEdit(left = Float.NaN, right = Float.NaN, top = Float.NaN, bottom = Float.NaN), 100, 50))
        // A one-pixel-wide picture can only be cropped to itself.
        assertEquals(PixelRect(0, 0, 1, 7), cropRectOf(ImageEdit(left = 0.4f, right = 0.6f), 1, 7))
    }

    @Test
    fun encodeSampleSizeNeverGoesPastTheTarget() {
        assertEquals(1, encodeSampleSize(2560, 2560))
        assertEquals(1, encodeSampleSize(5119, 2560)) // halving would leave 2559, under the target
        assertEquals(2, encodeSampleSize(5120, 2560))
        assertEquals(2, encodeSampleSize(6000, 2560))
        assertEquals(4, encodeSampleSize(20000, 2560))
        assertEquals(1, encodeSampleSize(0, 2560))
        assertEquals(1, encodeSampleSize(-5, 2560))
    }
}
