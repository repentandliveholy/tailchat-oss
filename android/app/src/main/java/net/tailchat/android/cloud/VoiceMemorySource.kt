package net.tailchat.android.cloud

import android.media.MediaDataSource

/** Decoder reads the complete encoded clip in RAM; no plaintext temp file is created. */
internal class VoiceMemorySource(private val encoded: ByteArray) : MediaDataSource() {
    override fun getSize(): Long = encoded.size.toLong()

    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (position < 0 || position >= encoded.size) return -1
        val count = minOf(size, encoded.size - position.toInt())
        System.arraycopy(encoded, position.toInt(), buffer, offset, count)
        return count
    }

    override fun close() = Unit
}
