package net.tailchat.android.cloud

/**
 * In-memory cache of decoded waveform peaks, keyed by account/peer/message id
 * — never by the message's `dataUrl` (`CloudVoice.dataUrl`), which is
 * megabytes of base64 and would make every `remember`/cache lookup hash or
 * compare the whole payload. Bounded LRU: [VoiceWaveformMath.BUCKET_COUNT]
 * floats per entry is a couple hundred bytes, so the cap exists for hygiene,
 * not memory pressure.
 */
object VoiceWaveformCache {
    private const val MAX_ENTRIES = 500

    private val entries = object : LinkedHashMap<String, FloatArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, FloatArray>): Boolean =
            size > MAX_ENTRIES
    }

    fun key(accountKey: String, peer: String, messageId: String) = "$accountKey|$peer|$messageId"

    @Synchronized
    fun get(key: String): FloatArray? = entries[key]

    @Synchronized
    fun put(key: String, peaks: FloatArray) {
        entries[key] = peaks
    }
}
