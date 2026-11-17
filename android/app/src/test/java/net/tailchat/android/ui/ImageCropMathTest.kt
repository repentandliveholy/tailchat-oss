package net.tailchat.android.ui

import net.tailchat.android.cloud.ImageEdit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The crop frame's maths are web's `resizeCropRect` / `moveCropRect` / `setImageCropRatio` /
 * `rotateImageSheet` ported line for line; these pin the behaviours a person feels — the opposite side
 * stays put, a kept shape stays that shape, nothing leaves the picture — so the two clients cannot drift.
 */
class ImageCropMathTest {
    private val delta = 1e-3f

    private fun assertRect(expected: CropRect, actual: CropRect) {
        assertEquals("x", expected.x, actual.x, delta)
        assertEquals("y", expected.y, actual.y, delta)
        assertEquals("w", expected.w, actual.w, delta)
        assertEquals("h", expected.h, actual.h, delta)
    }

    // ---- ratios ----

    @Test
    fun fourThreeAndSixteenNineFollowThePicturesOrientation() {
        assertEquals(4f / 3f, cropAspectFor(CropRatio.FourThree, 1000, 500), delta)
        assertEquals(3f / 4f, cropAspectFor(CropRatio.FourThree, 500, 1000), delta)
        assertEquals(9f / 16f, cropAspectFor(CropRatio.SixteenNine, 500, 1000), delta)
        assertEquals(1f, cropAspectFor(CropRatio.Square, 500, 1000), delta)
        assertEquals(0f, cropAspectFor(CropRatio.Free, 500, 1000), delta)
        // A square picture is not a portrait.
        assertEquals(4f / 3f, cropAspectFor(CropRatio.FourThree, 800, 800), delta)
    }

    @Test
    fun aRatioChipFramesTheLargestCentredFrameOfThatShape() {
        // 1:1 on a 2:1 picture: the full height, half the width, in the middle.
        assertRect(CropRect(0.25f, 0f, 0.5f, 1f), cropFrameForAspect(1f, 200, 100))
        // 16:9 on a square picture: the full width, 9/16 of the height.
        assertRect(CropRect(0f, 0.21875f, 1f, 0.5625f), cropFrameForAspect(16f / 9f, 100, 100))
        // The same shape as the picture: all of it.
        assertRect(CropRect(0f, 0f, 1f, 1f), cropFrameForAspect(2f, 200, 100))
    }

    // ---- turning ----

    @Test
    fun theFrameTurnsClockwiseWithThePicture() {
        assertRect(CropRect(0.4f, 0.1f, 0.4f, 0.3f), rotateCrop(CropRect(0.1f, 0.2f, 0.3f, 0.4f)))
        // The whole picture stays the whole picture.
        assertRect(CropRect.Whole, rotateCrop(CropRect.Whole))
        // Four quarter turns are no turn.
        var rect = CropRect(0.1f, 0.2f, 0.3f, 0.4f)
        repeat(4) { rect = rotateCrop(rect) }
        assertRect(CropRect(0.1f, 0.2f, 0.3f, 0.4f), rect)
    }

    // ---- resizing, free ----

    private val rect = CropRect(20f, 10f, 80f, 40f) // x, y, w, h: right 100, bottom 50
    private val min = 40f

    @Test
    fun aFreeEdgeFollowsThePointerAndTheOppositeSideStaysPut() {
        assertRect(CropRect(20f, 10f, 130f, 40f), resizeCropRect(rect, CropHandle.East, 50f, 99f, 0f, 200f, 100f, min))
        assertRect(CropRect(0f, 10f, 100f, 40f), resizeCropRect(rect, CropHandle.West, -80f, 0f, 0f, 200f, 100f, min))
        assertRect(CropRect(20f, 0f, 80f, 50f), resizeCropRect(rect, CropHandle.North, 0f, -30f, 0f, 200f, 100f, min))
        assertRect(CropRect(20f, 10f, 80f, 70f), resizeCropRect(rect, CropHandle.South, 0f, 30f, 0f, 200f, 100f, min))
    }

    @Test
    fun aFreeCornerMovesTwoEdges() {
        assertRect(
            CropRect(10f, 5f, 90f, 45f),
            resizeCropRect(rect, CropHandle.NorthWest, -10f, -5f, 0f, 200f, 100f, min),
        )
        assertRect(
            CropRect(20f, 10f, 100f, 60f),
            resizeCropRect(rect, CropHandle.SouthEast, 20f, 20f, 0f, 200f, 100f, min),
        )
    }

    @Test
    fun aFrameCannotLeaveThePicture() {
        assertRect(CropRect(20f, 10f, 180f, 40f), resizeCropRect(rect, CropHandle.East, 5000f, 0f, 0f, 200f, 100f, min))
        assertRect(CropRect(0f, 10f, 100f, 40f), resizeCropRect(rect, CropHandle.West, -5000f, 0f, 0f, 200f, 100f, min))
        assertRect(CropRect(20f, 0f, 80f, 50f), resizeCropRect(rect, CropHandle.North, 0f, -5000f, 0f, 200f, 100f, min))
        assertRect(CropRect(20f, 10f, 80f, 90f), resizeCropRect(rect, CropHandle.South, 0f, 5000f, 0f, 200f, 100f, min))
    }

    @Test
    fun aFrameCannotBeDraggedSmallerThanTheMinimum() {
        // The east edge dragged far left stops 40 px from the west edge.
        assertRect(CropRect(20f, 10f, 40f, 40f), resizeCropRect(rect, CropHandle.East, -5000f, 0f, 0f, 200f, 100f, min))
        assertRect(CropRect(60f, 10f, 40f, 40f), resizeCropRect(rect, CropHandle.West, 5000f, 0f, 0f, 200f, 100f, min))
        // A frame already smaller than the minimum may not be made to grow just by touching it.
        val small = CropRect(20f, 10f, 30f, 30f)
        assertRect(CropRect(20f, 10f, 30f, 30f), resizeCropRect(small, CropHandle.East, -5000f, 0f, 0f, 200f, 100f, min))
    }

    // ---- resizing, with a kept shape ----

    @Test
    fun aKeptShapeGrowsAlongItsAspectFromTheOppositeSide() {
        // 2:1 frame, east handle dragged 40 right: 120 wide, so 60 tall, centred on the frame's own middle.
        val grown = resizeCropRect(rect, CropHandle.East, 40f, 0f, 2f, 400f, 300f, min)
        assertRect(CropRect(20f, 0f, 120f, 60f), grown)
        assertEquals(2f, grown.w / grown.h, delta)
    }

    @Test
    fun aKeptShapeShrinksBackToFitThePicture() {
        // The same drag in a picture only 100 wide: the room to the east is 80, so the frame is 80×40.
        val grown = resizeCropRect(rect, CropHandle.East, 40f, 0f, 2f, 100f, 300f, min)
        assertRect(CropRect(20f, 10f, 80f, 40f), grown)
        assertEquals(2f, grown.w / grown.h, delta)
    }

    @Test
    fun aKeptShapeCornerFollowsTheLongerAxis() {
        val grown = resizeCropRect(rect, CropHandle.SouthEast, 100f, 10f, 2f, 400f, 300f, min)
        assertEquals(2f, grown.w / grown.h, delta)
        assertEquals(20f, grown.x, delta) // the north-west corner is the anchor
        assertEquals(10f, grown.y, delta)
        assertEquals(180f, grown.w, delta) // 80 + 100: the pointer's x decides, since it wants more
    }

    // ---- moving ----

    @Test
    fun movingKeepsTheSizeAndStopsAtTheEdges() {
        assertRect(CropRect(30f, 25f, 80f, 40f), moveCropRect(rect, 10f, 15f, 200f, 100f))
        assertRect(CropRect(120f, 60f, 80f, 40f), moveCropRect(rect, 5000f, 5000f, 200f, 100f))
        assertRect(CropRect(0f, 0f, 80f, 40f), moveCropRect(rect, -5000f, -5000f, 200f, 100f))
    }

    // ---- what a touch grabs ----

    private val frame = CropRect(100f, 100f, 200f, 200f) // corners (100,100) (300,100) (300,300) (100,300)
    private val slop = 28f

    @Test
    fun aTouchNearACornerGrabsTheCorner() {
        assertEquals(CropTouch.Resize(CropHandle.NorthWest), cropHitTest(frame, 105f, 95f, slop))
        assertEquals(CropTouch.Resize(CropHandle.NorthEast), cropHitTest(frame, 310f, 90f, slop))
        assertEquals(CropTouch.Resize(CropHandle.SouthEast), cropHitTest(frame, 290f, 310f, slop))
        assertEquals(CropTouch.Resize(CropHandle.SouthWest), cropHitTest(frame, 100f, 300f, slop))
        // Inside the frame but within reach of a corner: still the corner, not a move.
        assertEquals(CropTouch.Resize(CropHandle.NorthWest), cropHitTest(frame, 120f, 120f, slop))
    }

    @Test
    fun aTouchAnywhereAlongAnEdgeGrabsTheEdge() {
        assertEquals(CropTouch.Resize(CropHandle.North), cropHitTest(frame, 200f, 105f, slop))
        assertEquals(CropTouch.Resize(CropHandle.North), cropHitTest(frame, 150f, 90f, slop)) // not only at its middle
        assertEquals(CropTouch.Resize(CropHandle.East), cropHitTest(frame, 295f, 200f, slop))
        assertEquals(CropTouch.Resize(CropHandle.South), cropHitTest(frame, 200f, 310f, slop))
        assertEquals(CropTouch.Resize(CropHandle.West), cropHitTest(frame, 90f, 250f, slop))
    }

    @Test
    fun theInsideMovesAndEverythingElseIsLeftAlone() {
        assertEquals(CropTouch.Move, cropHitTest(frame, 200f, 200f, slop))
        assertEquals(CropTouch.None, cropHitTest(frame, 10f, 10f, slop))
        assertEquals(CropTouch.None, cropHitTest(frame, 200f, 340f, slop)) // below the south edge by more than the reach
        assertEquals(CropTouch.None, cropHitTest(frame, 340f, 200f, slop))
    }

    // ---- the result ----

    @Test
    fun anUntouchedPictureIsSentAsPicked() {
        assertEquals(ImageEdit.None, imageEditOf(0, CropRect.Whole))
        assertEquals(ImageEdit.None, imageEditOf(4, CropRect.Whole))
    }

    @Test
    fun aTurnOrACropIsReportedAsFractionsOfTheTurnedPicture() {
        assertEquals(ImageEdit(1, 0f, 0f, 1f, 1f), imageEditOf(1, CropRect.Whole))
        assertEquals(ImageEdit(0, 0.25f, 0.125f, 0.75f, 0.875f), imageEditOf(0, CropRect(0.25f, 0.125f, 0.5f, 0.75f)))
        assertEquals(ImageEdit(3, 0.25f, 0.125f, 0.75f, 0.875f), imageEditOf(-1, CropRect(0.25f, 0.125f, 0.5f, 0.75f)))
    }

    @Test
    fun aFrameThatOvershootsByRoundingIsClampedIntoThePicture() {
        val edit = imageEditOf(0, CropRect(-0.0001f, 0.1f, 1.0002f, 0.5f))
        assertTrue(edit.left == 0f && edit.right == 1f)
    }

    // ---- the editor's own copy of the picture ----

    @Test
    fun theEditorCopyIsAsSharpAsTheScreenAndNoMoreThanSixMegapixels() {
        assertEquals(1, editorSampleSize(1000, 800, 2400))
        assertEquals(1, editorSampleSize(2400, 1800, 2400)) // 4.3 MP, under the budget
        assertEquals(2, editorSampleSize(4000, 3000, 2400)) // the screen is satisfied at 1, the budget is not
        assertEquals(4, editorSampleSize(8000, 6000, 2400))
        assertEquals(1, editorSampleSize(0, 0, 2400))
        // A panorama: the long side is what the screen can use, but its pixel count is small.
        assertEquals(2, editorSampleSize(9000, 1000, 2400))
    }
}
