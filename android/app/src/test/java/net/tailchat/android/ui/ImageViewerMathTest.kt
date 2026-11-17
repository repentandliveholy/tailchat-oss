package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The viewer's geometry: fit that never enlarges, zoom to 8x of fit (native at the least), a pan
 * limit that is exact rather than a heuristic bound, and the page / dismiss thresholds. All in device
 * pixels, `1f` meaning one picture pixel on one device pixel.
 */
class ImageViewerMathTest {
    private val delta = 1e-3f

    @Test
    fun aLargePictureFitsAndASmallOneStaysAtNative() {
        // 1600×1200 on a 1080×2000 screen: width decides.
        assertEquals(0.675f, viewerFitScale(1600f, 1200f, 1080f, 2000f), delta)
        // A tall one: height decides.
        assertEquals(0.5f, viewerFitScale(800f, 4000f, 1080f, 2000f), delta)
        // Smaller than the screen: never enlarged.
        assertEquals(1f, viewerFitScale(300f, 200f, 1080f, 2000f), delta)
        // Unknown sizes are a neutral 1, not a crash.
        assertEquals(1f, viewerFitScale(0f, 0f, 1080f, 2000f), delta)
        assertEquals(1f, viewerFitScale(100f, 100f, 0f, 0f), delta)
    }

    @Test
    fun zoomReachesEightTimesFitAndNativeAtTheLeast() {
        assertEquals(5.4f, viewerMaxScale(0.675f), delta)
        assertEquals(8f, viewerMaxScale(1f), delta)
        // A huge picture that fits at 5%: eight times that is under native, and native is the floor.
        assertEquals(1f, viewerMaxScale(0.05f), delta)
    }

    @Test
    fun aDoubleTapGoesToNativeOrToTwiceFitWhenNativeIsNoZoomAtAll() {
        assertEquals(1f, viewerDoubleTapScale(0.675f), delta)
        assertEquals(1f, viewerDoubleTapScale(0.5f), delta)
        assertEquals(2f, viewerDoubleTapScale(1f), delta)
    }

    @Test
    fun fittedMeansWithinAHairOfFit() {
        val fit = 0.5f
        assertTrue(viewerAtFit(ViewerPose(0.5f, 0f, 0f), fit))
        assertTrue(viewerAtFit(ViewerPose(0.5004f, 0f, 0f), fit))
        assertFalse(viewerAtFit(ViewerPose(0.52f, 0f, 0f), fit))
    }

    @Test
    fun aPictureSmallerThanTheBoxIsCentredAndALargerOneIsHeldToItsEdges() {
        assertEquals(100f, viewerClampAxis(position = 999f, shown = 100f, box = 300f), delta)
        // 500 shown in 300: the position may run from 300 - 500 = -200 up to 0, and no further.
        assertEquals(0f, viewerClampAxis(10f, 500f, 300f), delta)
        assertEquals(-200f, viewerClampAxis(-300f, 500f, 300f), delta)
        assertEquals(-50f, viewerClampAxis(-50f, 500f, 300f), delta)
        // Exactly the box: no room to move, and no gap.
        assertEquals(0f, viewerClampAxis(40f, 300f, 300f), delta)
    }

    @Test
    fun theFittedPoseIsCentredOnBothAxes() {
        val pose = viewerFitPose(1600f, 1200f, 1080f, 2000f)
        assertEquals(0.675f, pose.scale, delta)
        assertEquals(0f, pose.x, delta)
        assertEquals((2000f - 810f) / 2f, pose.y, delta)
    }

    @Test
    fun aPanMovesThePictureAndStopsAtItsEdges() {
        // 1000×1000 at scale 2 in an 800×800 box: 2000 shown, the position runs over [-1200, 0].
        val pose = ViewerPose(2f, -100f, -100f)
        val moved = viewerTransform(pose, 1f, 0f, 0f, 50f, 50f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(2f, moved.scale, delta)
        assertEquals(-50f, moved.x, delta)
        assertEquals(-50f, moved.y, delta)
        val past = viewerTransform(pose, 1f, 0f, 0f, 500f, -5000f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(0f, past.x, delta)
        assertEquals(-1200f, past.y, delta)
    }

    @Test
    fun aZoomKeepsThePointUnderTheFingers() {
        // Fitted at 0.8 (800 shown in 800), zoom x2 about the centre: the centre stays put.
        val fitted = ViewerPose(0.8f, 0f, 0f)
        val zoomed = viewerTransform(fitted, 2f, 400f, 400f, 400f, 400f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(1.6f, zoomed.scale, delta)
        assertEquals(-400f, zoomed.x, delta)
        assertEquals(-400f, zoomed.y, delta)
        // About a corner of the picture, that corner stays where it was.
        val corner = viewerTransform(fitted, 2f, 0f, 0f, 0f, 0f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(0f, corner.x, delta)
        assertEquals(0f, corner.y, delta)
    }

    @Test
    fun aPinchIsHeldBetweenFitAndEightTimesFit() {
        val fitted = ViewerPose(0.8f, 0f, 0f)
        val most = viewerTransform(fitted, 100f, 400f, 400f, 400f, 400f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(6.4f, most.scale, delta)
        // Pinching out below fit does nothing: the picture is never smaller than fitted.
        val least = viewerTransform(fitted, 0.1f, 400f, 400f, 400f, 400f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(0.8f, least.scale, delta)
    }

    @Test
    fun aPinchThatMovesTheFingersAlsoPans() {
        val pose = ViewerPose(2f, -400f, -400f)
        // No zoom, the midpoint dragged 100 right and 60 down.
        val moved = viewerTransform(pose, 1f, 300f, 300f, 400f, 360f, 0.8f, 1000f, 1000f, 800f, 800f)
        assertEquals(-300f, moved.x, delta)
        assertEquals(-340f, moved.y, delta)
    }

    @Test
    fun aTapIsOnThePictureOnlyWhereThePictureIs() {
        val pose = ViewerPose(0.5f, 100f, 200f) // a 1000×800 picture shown 500×400 at (100, 200)
        assertTrue(viewerHitsImage(pose, 1000f, 800f, 300f, 300f))
        assertTrue(viewerHitsImage(pose, 1000f, 800f, 100f, 200f)) // its corner
        assertFalse(viewerHitsImage(pose, 1000f, 800f, 50f, 300f)) // the black to the left
        assertFalse(viewerHitsImage(pose, 1000f, 800f, 300f, 700f)) // below
    }

    @Test
    fun anAnimatedJumpPassesThroughTheMiddle() {
        val from = ViewerPose(1f, 0f, 0f)
        val to = ViewerPose(3f, -100f, -200f)
        assertEquals(from, viewerLerp(from, to, 0f))
        assertEquals(to, viewerLerp(from, to, 1f))
        assertEquals(ViewerPose(2f, -50f, -100f), viewerLerp(from, to, 0.5f))
    }

    @Test
    fun aSidewaysSwipePagesOnlyWhenItGoesFarOrFlicks() {
        val distance = 64f
        val fling = 600f
        assertEquals(1, viewerPageDelta(-100f, 0f, distance, fling)) // dragged left: the next picture
        assertEquals(-1, viewerPageDelta(100f, 0f, distance, fling)) // dragged right: the previous
        assertEquals(0, viewerPageDelta(-30f, 0f, distance, fling)) // too short, too slow
        assertEquals(1, viewerPageDelta(-30f, -1000f, distance, fling)) // a short flick
        assertEquals(0, viewerPageDelta(-10f, -1000f, distance, fling)) // a flick over almost nothing is a twitch
        assertEquals(0, viewerPageDelta(-30f, -100f, distance, fling))
    }

    @Test
    fun aDownwardSwipeClosesOnlyWhenItGoesFarOrFlicks() {
        assertTrue(viewerShouldDismiss(80f, 0f, 64f, 600f))
        assertFalse(viewerShouldDismiss(30f, 0f, 64f, 600f))
        assertTrue(viewerShouldDismiss(30f, 1000f, 64f, 600f))
        assertFalse(viewerShouldDismiss(10f, 1000f, 64f, 600f))
        assertFalse(viewerShouldDismiss(-80f, 0f, 64f, 600f)) // upward never closes
    }

    @Test
    fun theScrimFadesWithThePullButNeverBelowAThird() {
        assertEquals(1f, viewerScrimFade(0f, 400f), delta)
        assertEquals(0.5f, viewerScrimFade(200f, 400f), delta)
        assertEquals(0.3f, viewerScrimFade(400f, 400f), delta)
        assertEquals(0.3f, viewerScrimFade(4000f, 400f), delta)
        assertEquals(1f, viewerScrimFade(-50f, 400f), delta) // an upward drag does not dim
    }
}
