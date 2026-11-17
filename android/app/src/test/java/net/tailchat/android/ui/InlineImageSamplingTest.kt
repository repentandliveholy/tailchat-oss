package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [sampleSizeFor] is the only decision in InlineImage.kt that can be wrong
 * without anything failing loudly: too small a sample size and the LRU holds
 * bitmaps several times the size it budgeted for, too large a one and every
 * photo in the thread is permanently soft. Both are invisible in a screenshot
 * of a 260dp box, so the contract is pinned here instead — `BitmapFactory`'s
 * own rule: the largest power of two that keeps *both* axes at or above the
 * requested box.
 */
class InlineImageSamplingTest {
    @Test
    fun sourceAtTargetSizeIsNotSampled() {
        assertEquals(1, sampleSizeFor(780, 585, 780, 585))
    }

    @Test
    fun exactlyDoubleTargetHalves() {
        assertEquals(2, sampleSizeFor(1560, 1170, 780, 585))
    }

    @Test
    fun threeTimesTargetStopsAtTwo() {
        // 4 would decode to 0.75x the box and the thumbnail would be upscaled to
        // fill it; 2 overshoots by 1.5x, which is the correct side to err on.
        assertEquals(2, sampleSizeFor(2340, 1755, 780, 585))
    }

    @Test
    fun fiveTimesTargetStopsAtFour() {
        assertEquals(4, sampleSizeFor(3900, 2925, 780, 585))
    }

    @Test
    fun cameraSizedSourceCollapsesToAQuarter() {
        // A 12MP capture against the 780x585 box: 4 lands at 1008x756, and 8
        // would fall to 504x378 — under the box on both axes.
        assertEquals(4, sampleSizeFor(4032, 3024, 780, 585))
    }

    @Test
    fun hugeSourceSamplesByALargePowerOfTwo() {
        // 20000x15000 is 77x the 260dp box at 1x density; 64 leaves 312x234,
        // 128 would leave 156x117.
        assertEquals(64, sampleSizeFor(20000, 15000, 260, 195))
    }

    @Test
    fun theLimitingAxisDecidesAlone() {
        // A panorama is 20x the box wide and only 2x tall; sampling by width
        // would render the height at an eighth of what the box needs.
        assertEquals(2, sampleSizeFor(15600, 1170, 780, 585))
    }

    @Test
    fun targetLargerThanSourceNeverUpsamples() {
        assertEquals(1, sampleSizeFor(120, 90, 780, 585))
    }

    @Test
    fun undecodableAndDegenerateDimensionsFallBackToOne() {
        // BitmapFactory reports -1/-1 for a payload it could not parse, and a
        // zero-sized target would otherwise loop up to a sample that decodes
        // nothing at all.
        assertEquals(1, sampleSizeFor(-1, -1, 780, 585))
        assertEquals(1, sampleSizeFor(0, 0, 780, 585))
        assertEquals(1, sampleSizeFor(4032, 3024, 0, 0))
        assertEquals(1, sampleSizeFor(4032, 3024, -780, -585))
    }
}
