package net.tailchat.android.cloud

/**
 * Pure math behind the waveform: which of [BUCKET_COUNT] on-screen bars a
 * decoded audio frame's timestamp belongs to, and how raw per-bucket
 * amplitude sums become the 0..1 bar heights `VoicePlayer` (in
 * `ui/CloudScreen.kt`) actually draws. No Android dependency — see
 * `VoiceWaveformDecoder` for the `MediaExtractor`/`MediaCodec` side that
 * calls into this, and `VoiceWaveformMathTest` for the pure unit coverage.
 */
object VoiceWaveformMath {
    const val BUCKET_COUNT = 36

    /** Which bar a sample at [presentationTimeUs] belongs to, given the
     *  track's total [durationUs]. A track with no known duration (zero or
     *  negative) puts everything in the first bucket rather than dividing by
     *  zero; a timestamp past the end clamps to the last bucket instead of
     *  throwing. */
    fun bucketFor(presentationTimeUs: Long, durationUs: Long, bucketCount: Int = BUCKET_COUNT): Int {
        if (durationUs <= 0L || bucketCount <= 0) return 0
        val fraction = presentationTimeUs.toDouble() / durationUs.toDouble()
        return (fraction * bucketCount).toInt().coerceIn(0, bucketCount - 1)
    }

    /** [sums] is the running total of per-sample peak amplitude assigned to
     *  each bucket by [bucketFor]; [counts] is how many samples landed in
     *  it. Averaged first — a bucket that happened to catch fewer decoded
     *  frames must not look quieter just because it had less material to
     *  sum — then every bar is scaled against the single loudest bucket in
     *  the whole clip, so the tallest bar in a quiet voice note still reads
     *  as "loud for this note" instead of "quiet in absolute terms". A
     *  silent or fully undecodable clip (every bucket at zero) returns
     *  all-zero bars rather than dividing by zero.
     */
    fun normalize(sums: DoubleArray, counts: LongArray): FloatArray {
        require(sums.size == counts.size) { "sums and counts must be the same length" }
        val n = sums.size
        val averages = DoubleArray(n) { i -> if (counts[i] > 0) sums[i] / counts[i] else 0.0 }
        val globalMax = averages.maxOrNull() ?: 0.0
        if (globalMax <= 0.0) return FloatArray(n)
        return FloatArray(n) { i -> (averages[i] / globalMax).toFloat().coerceIn(0f, 1f) }
    }

    /** A deterministic placeholder shown the instant a voice bubble renders,
     *  before real peaks are decoded — or forever, if decoding fails
     *  outright. Derived from [seed] (the message id) so the same message
     *  always draws the same placeholder instead of reshuffling every
     *  recomposition, without needing to remember a randomly generated array
     *  anywhere. Not real audio data — just enough visual variation that
     *  [bucketCount] bars don't render as one flat brick while the real
     *  waveform decodes in the background. */
    fun placeholder(seed: String, bucketCount: Int = BUCKET_COUNT): FloatArray {
        var state = seed.fold(0x9E3779B97F4A7C15uL) { acc, c -> (acc xor c.code.toULong()) * 0x100000001B3uL }
        return FloatArray(bucketCount) {
            state = (state xor (state shr 33)) * 0xFF51AFD7ED558CCDuL
            state = (state xor (state shr 33)) * 0xC4CEB9FE1A85EC53uL
            state = state xor (state shr 33)
            val unit = (state and 0xFFFFuL).toInt() / 65535f
            // Kept away from the extremes: a placeholder bar at exactly 0 or 1
            // would look like real silence or real clipping instead of "this
            // note's real shape is not known yet".
            0.2f + unit * 0.6f
        }
    }
}
