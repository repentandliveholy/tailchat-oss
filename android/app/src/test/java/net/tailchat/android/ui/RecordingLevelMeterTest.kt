package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingLevelMeterTest {
    @Test fun silenceAndOutOfRangePeaksStayAtTheCorrectEnds() {
        assertEquals(0f, recordingLevel(0), 0f)
        assertEquals(0f, recordingLevel(Int.MIN_VALUE), 0f)
        assertEquals(1f, recordingLevel(32767), 0f)
        assertEquals(1f, recordingLevel(Int.MAX_VALUE), 0f)
    }

    @Test fun IncreasingSpeechPeaksGiveIncreasingVisibleLevels() {
        val peaks = intArrayOf(1, 32, 256, 1024, 4096, 8192, 32767)
        var previous = 0f
        for (peak in peaks) {
            val level = recordingLevel(peak)
            assertTrue("peak $peak must be louder than the preceding peak", level > previous)
            assertTrue("peak $peak must remain within the meter", level in 0f..1f)
            previous = level
        }
    }
}
