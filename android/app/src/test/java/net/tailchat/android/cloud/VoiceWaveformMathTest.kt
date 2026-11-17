package net.tailchat.android.cloud

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceWaveformMathTest {
    @Test
    fun bucketForMapsAFullTrackEvenlyAcrossBuckets() {
        // The very first sample belongs to bucket 0, the last to the final
        // bucket, and the midpoint to the middle — the mapping is a plain
        // proportional split of the track's duration, nothing fancier.
        val durationUs = 10_000_000L // 10s
        assertEquals(0, VoiceWaveformMath.bucketFor(0L, durationUs, bucketCount = 10))
        assertEquals(5, VoiceWaveformMath.bucketFor(5_000_000L, durationUs, bucketCount = 10))
        assertEquals(9, VoiceWaveformMath.bucketFor(9_999_999L, durationUs, bucketCount = 10))
    }

    @Test
    fun bucketForClampsATimestampAtOrPastTheTrackEnd() {
        val durationUs = 1_000_000L
        // A rounding slip or a codec reporting a timestamp a hair past its
        // own declared duration must still land inside the array, not throw.
        assertEquals(9, VoiceWaveformMath.bucketFor(durationUs, durationUs, bucketCount = 10))
        assertEquals(9, VoiceWaveformMath.bucketFor(durationUs * 5, durationUs, bucketCount = 10))
    }

    @Test
    fun bucketForTreatsAnUnknownDurationAsBucketZero() {
        assertEquals(0, VoiceWaveformMath.bucketFor(500_000L, durationUs = 0L, bucketCount = 10))
        assertEquals(0, VoiceWaveformMath.bucketFor(500_000L, durationUs = -1L, bucketCount = 10))
    }

    @Test
    fun normalizeAveragesPerBucketBeforeScalingAgainstTheLoudestBucket() {
        // Bucket 0 caught one loud sample; bucket 1 caught two quieter ones
        // whose sum happens to equal bucket 0's — averaging must still tell
        // them apart.
        val sums = doubleArrayOf(100.0, 100.0, 50.0)
        val counts = longArrayOf(1L, 2L, 1L)
        val normalized = VoiceWaveformMath.normalize(sums, counts)
        assertEquals(1f, normalized[0], 0.0001f) // average 100, the loudest
        assertEquals(0.5f, normalized[1], 0.0001f) // average 50
        assertEquals(0.5f, normalized[2], 0.0001f) // average 50
    }

    @Test
    fun normalizeReturnsAllZeroForASilentOrEmptyClip() {
        val silent = VoiceWaveformMath.normalize(doubleArrayOf(0.0, 0.0, 0.0), longArrayOf(0L, 0L, 0L))
        assertArrayEquals(FloatArray(3), silent, 0f)
    }

    @Test
    fun normalizeNeverExceedsOneEvenWithRoundingSlack() {
        val normalized = VoiceWaveformMath.normalize(doubleArrayOf(32767.0), longArrayOf(1L))
        assertTrue(normalized[0] <= 1f)
    }

    @Test
    fun placeholderIsDeterministicForTheSameSeedAndStaysWithinBounds() {
        val a = VoiceWaveformMath.placeholder("msg-123")
        val b = VoiceWaveformMath.placeholder("msg-123")
        assertArrayEquals(a, b, 0f)
        assertEquals(VoiceWaveformMath.BUCKET_COUNT, a.size)
        for (v in a) assertTrue("placeholder bar $v out of [0,1]", v in 0f..1f)
    }

    @Test
    fun placeholderDiffersForDifferentSeeds() {
        val a = VoiceWaveformMath.placeholder("msg-1")
        val b = VoiceWaveformMath.placeholder("msg-2")
        assertTrue("two different message ids produced identical placeholders", !a.contentEquals(b))
    }
}
