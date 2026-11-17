package net.tailchat.android.ui

import androidx.compose.ui.unit.IntSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Natural dimensions use CSS-pixel/dp units, the long side is held to 480 dp, and the row bounds
 * the result. Density only converts that layout to device pixels.
 */
class InlineImageSizeTest {
    private val unbounded = Int.MAX_VALUE

    @Test
    fun aLargePictureIsHeldToTheLongSideCap() {
        assertEquals(IntSize(480, 360), inlineImageSize(800, 600, 480, unbounded, 1f))
        assertEquals(IntSize(240, 480), inlineImageSize(600, 1200, 480, unbounded, 1f))
        assertEquals(IntSize(480, 270), inlineImageSize(4000, 2250, 480, unbounded, 1f))
    }

    @Test
    fun aSmallPictureIsNeverEnlarged() {
        assertEquals(IntSize(200, 100), inlineImageSize(200, 100, 480, unbounded, 1f))
        assertEquals(IntSize(40, 10), inlineImageSize(40, 10, 480, unbounded, 1f))
        assertEquals(IntSize(480, 480), inlineImageSize(480, 480, 480, unbounded, 1f))
    }

    @Test
    fun theRowsWidthBoundsTheBoxAndTheShapeIsKept() {
        // The row's pixel bound takes precedence even with a larger long-side cap.
        assertEquals(IntSize(300, 225), inlineImageSize(1600, 1200, 1320, 300, 1f))
        // Already narrower than the row: untouched.
        assertEquals(IntSize(200, 100), inlineImageSize(200, 100, 1320, 300, 1f))
        // A portrait is bounded by width too.
        assertEquals(IntSize(150, 300), inlineImageSize(1000, 2000, 1320, 150, 1f))
    }

    @Test
    fun denseScreensKeepTheWebsLogicalImageSize() {
        assertEquals(IntSize(550, 275), inlineImageSize(200, 100, 1320, 900, 2.75f))
        assertEquals(IntSize(990, 557), inlineImageSize(640, 360, 1320, 990, 2.75f))
        assertEquals(IntSize(576, 1440), inlineImageSize(240, 600, 1440, 1080, 3f))
    }

    @Test
    fun aRowThatReportsNoWidthDoesNotBoundIt() {
        assertEquals(IntSize(480, 360), inlineImageSize(800, 600, 480, 0, 1f))
        assertEquals(IntSize(480, 360), inlineImageSize(800, 600, 480, -5, 1f))
    }

    @Test
    fun roundingNeverProducesAnEmptyBox() {
        assertEquals(IntSize(480, 160), inlineImageSize(1000, 333, 480, unbounded, 1f))
        // A needle: its short side rounds to under half a pixel and is held at one.
        assertEquals(IntSize(480, 1), inlineImageSize(4800, 1, 480, unbounded, 1f))
        // No dimensions at all is a 1×1 box, never a crash or a divide by zero.
        assertEquals(IntSize(1, 1), inlineImageSize(0, 0, 480, unbounded, 1f))
        assertEquals(IntSize(1, 1), inlineImageSize(-4, -4, 0, unbounded, 1f))
    }

    @Test
    fun theFullDecodeStaysInsideItsPixelBudget() {
        assertEquals(1, fullSampleSize(2560, 1920))
        assertEquals(1, fullSampleSize(4096, 3072)) // exactly the budget
        assertEquals(2, fullSampleSize(4097, 3072)) // one pixel past the longest side
        assertEquals(2, fullSampleSize(5000, 5000)) // 25 MP -> 6.25 MP
        assertEquals(8, fullSampleSize(20000, 15000))
        assertEquals(1, fullSampleSize(0, 0))
        assertEquals(1, fullSampleSize(-1, 100))
    }

    @Test
    fun aCaptionIsEverythingThatIsNotAPlaceholder() {
        assertNull(imageCaptionOf(""))
        assertNull(imageCaptionOf("   "))
        for (placeholder in listOf("🖼 [Изображение]", "🖼 [Image]")) {
            assertNull(placeholder, imageCaptionOf(placeholder))
            assertNull(placeholder, imageCaptionOf("  $placeholder \n"))
        }
        assertEquals("Sunset at the pier", imageCaptionOf("  Sunset at the pier "))
        assertEquals("Фото", imageCaptionOf("Фото"))
        // A caption that merely *contains* a placeholder is a caption.
        assertEquals("Photo of my cat", imageCaptionOf("Photo of my cat"))
        assertEquals("🖼 [Image] again", imageCaptionOf("🖼 [Image] again"))
    }
}
