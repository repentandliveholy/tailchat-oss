package net.tailchat.android.cloud

import android.media.MediaDataSource
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Base64
import java.nio.ByteOrder

/**
 * Decodes one voice note's audio into [VoiceWaveformMath.BUCKET_COUNT] peak
 * values, off the main thread, without ever holding the full decoded PCM in
 * memory: each `MediaCodec` output buffer's peak amplitude and timestamp are
 * recorded and the buffer itself is released immediately, never accumulated.
 * Handles anything the device's `MediaExtractor`/`MediaCodec` stack can open
 * — AAC in M4A (this app's own recordings) and Opus in WebM (the web
 * client's) alike — because neither the container nor the codec is named
 * here; the platform picks the decoder from the track's own format.
 *
 * Returns null on any failure: unsupported container, corrupt file, no audio
 * track, decoder error. The caller keeps showing the placeholder waveform in
 * that case — a decode failure is cosmetic, never fatal to playback, which
 * uses `MediaPlayer` independently of this class.
 */
object VoiceWaveformDecoder {
    private const val TIMEOUT_US = 10_000L

    /** Decodes directly from the authenticated cache's in-memory media, never
     *  from a plaintext on-disk staging file. */
    fun decodeFromDataUrl(dataUrl: String): FloatArray? {
        val bytes = runCatching { Base64.decode(dataUrl.substringAfter(',', ""), Base64.DEFAULT) }.getOrNull()
            ?: return null
        return VoiceMemorySource(bytes).use(::decode)
    }

    private fun decode(source: MediaDataSource): FloatArray? {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        return try {
            extractor.setDataSource(source)
            val trackIndex = (0 until extractor.trackCount).firstOrNull { i ->
                extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: return null
            val format = extractor.getTrackFormat(trackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: return null
            // Not every container reports this in the track format (WebM in
            // particular sometimes omits it) — `formatDurationUs` is a hint
            // used only if nothing better turns up; the real fallback is the
            // highest presentation timestamp actually seen while decoding,
            // computed once decoding finishes (see below).
            val formatDurationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
            } else {
                -1L
            }
            extractor.selectTrack(trackIndex)

            val decoder = MediaCodec.createDecoderByType(mime)
            codec = decoder
            decoder.configure(format, null, null, 0)
            decoder.start()

            // One (timestamp, peak) pair per decoded output frame — not the
            // PCM samples themselves, which are discarded the instant their
            // peak is folded in. A ten-minute note at a typical ~20ms decoder
            // output frame is on the order of tens of thousands of these,
            // comfortably under a megabyte.
            val samples = ArrayList<PeakSample>()
            val bufferInfo = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false

            while (!outputDone) {
                if (!inputDone) {
                    val inputIndex = decoder.dequeueInputBuffer(TIMEOUT_US)
                    if (inputIndex >= 0) {
                        val inputBuffer = decoder.getInputBuffer(inputIndex)
                        val sampleSize = inputBuffer?.let { extractor.readSampleData(it, 0) } ?: -1
                        if (sampleSize < 0) {
                            decoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val presentationTimeUs = extractor.sampleTime
                            decoder.queueInputBuffer(inputIndex, 0, sampleSize, presentationTimeUs, 0)
                            extractor.advance()
                        }
                    }
                }
                val outputIndex = decoder.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
                if (outputIndex >= 0) {
                    if (bufferInfo.size > 0) {
                        val outputBuffer = decoder.getOutputBuffer(outputIndex)
                        if (outputBuffer != null) {
                            outputBuffer.order(ByteOrder.nativeOrder())
                            outputBuffer.position(bufferInfo.offset)
                            outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
                            val shorts = outputBuffer.asShortBuffer()
                            var peak = 0
                            while (shorts.hasRemaining()) {
                                val v = kotlin.math.abs(shorts.get().toInt())
                                if (v > peak) peak = v
                            }
                            samples += PeakSample(bufferInfo.presentationTimeUs, peak)
                        }
                    }
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    decoder.releaseOutputBuffer(outputIndex, false)
                }
            }

            if (samples.isEmpty()) return FloatArray(VoiceWaveformMath.BUCKET_COUNT)
            val observedMaxUs = samples.maxOf(PeakSample::timeUs)
            val durationUs = if (formatDurationUs > 0) formatDurationUs else observedMaxUs.coerceAtLeast(1L)

            val bucketCount = VoiceWaveformMath.BUCKET_COUNT
            val sums = DoubleArray(bucketCount)
            val counts = LongArray(bucketCount)
            for (sample in samples) {
                val bucket = VoiceWaveformMath.bucketFor(sample.timeUs, durationUs, bucketCount)
                sums[bucket] += sample.peak
                counts[bucket] += 1
            }
            VoiceWaveformMath.normalize(sums, counts)
        } catch (_: Exception) {
            null
        } finally {
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            runCatching { extractor.release() }
        }
    }

    private data class PeakSample(val timeUs: Long, val peak: Int)
}
