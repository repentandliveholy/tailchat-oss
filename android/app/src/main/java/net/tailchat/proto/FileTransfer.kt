package net.tailchat.proto

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64

const val CHUNK_BYTES = 48 * 1024

// Matches FILE_MAX_BYTES in web/cloud/app.js, so a file the web client accepts is
// not silently smaller than what this client will take. A ceiling this high is only
// safe because both directions stream: the sender reads the document in CHUNK_BYTES
// passes and the receiver spools to disk, so no transfer ever costs more than a few
// chunks of heap regardless of how large the file is.
const val DEFAULT_MAX_BYTES = 100L * 1024 * 1024

fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/**
 * Digests [input] without ever holding it, and refuses to digest more than [size]
 * bytes: returns null unless the stream held exactly that many. A content provider's
 * reported size is advisory — it may be stale or plainly wrong — and an offer that
 * disagrees with the bytes that follow is a transfer the far side will reject after
 * the fact, so the disagreement is caught here, before anything is sent, and at a
 * cost bounded by the size the caller already accepted.
 */
fun sha256HexOfExactly(input: InputStream, size: Long): String? {
    val digest = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(CHUNK_BYTES)
    var seen = 0L
    while (true) {
        val read = input.read(buf)
        if (read < 0) break
        seen += read
        if (seen > size) return null
        digest.update(buf, 0, read)
    }
    if (seen != size) return null
    return digest.digest().toHex()
}

fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "%.1f MB".format(bytes / (1024.0 * 1024))
}

/**
 * A peer controls this string, so reduce it to a bare name. Without this a
 * transfer could write outside the download directory.
 */
fun safeFileName(name: String?): String {
    val raw = (name ?: "").replace('\\', '/')
    val base = raw.substringAfterLast('/')
    if (base.isEmpty() || base == "." || base == "..") return "file"
    return base.filter { it.code >= 0x20 && it.code != 0x7f }.ifEmpty { "file" }
}

fun fileOfferFrame(id: String, name: String, size: Long, sha256: String): JsonObject = buildJsonObject {
    put("t", "file-offer")
    put("id", id)
    put("name", name)
    put("size", size)
    put("sha256", sha256)
}

fun fileChunkFrame(id: String, seq: Int, data: String): JsonObject = buildJsonObject {
    put("t", "file-chunk")
    put("id", id)
    put("seq", seq)
    put("data", data)
}

fun fileDoneFrame(id: String): JsonObject = buildJsonObject {
    put("t", "file-done")
    put("id", id)
}

fun fileDenyFrame(id: String, reason: String): JsonObject = buildJsonObject {
    put("t", "file-deny")
    put("id", id)
    put("reason", reason)
}

/**
 * Spools an inbound transfer to a scratch file under [spoolDir] and only yields it
 * once the digest checks out, so a failed or hostile transfer never leaves a partial
 * file behind. Port of createFileReceiver in src/files.js: the bytes go to disk as
 * they arrive rather than into a buffer, because at DEFAULT_MAX_BYTES a buffered
 * transfer is an OutOfMemoryError waiting for a big enough file. Where the verified
 * file finally lands is still the platform's business, not the protocol's.
 */
class FileReceiver(
    private val spoolDir: File,
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
) {

    private class Transfer(
        val name: String,
        val size: Long,
        val sha256: String,
        val file: File,
        val sink: OutputStream,
    ) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var received: Long = 0

        /** Every way a transfer can end short of a verified file runs through here. */
        fun discard() {
            runCatching { sink.close() }
            file.delete()
        }
    }

    private val active = mutableMapOf<String, Transfer>()

    init {
        // Anything already in here belongs to a process that died mid-transfer: nothing
        // can resume it and nothing will ever read it, so it is only wasted cache.
        spoolDir.listFiles()?.forEach { it.delete() }
    }

    sealed interface Offer {
        data class Accepted(val name: String, val size: Long) : Offer
        data class Refused(val reason: String) : Offer
    }

    sealed interface Chunk {
        data class Progress(val received: Long, val size: Long) : Chunk
        data class Failed(val reason: String) : Chunk
    }

    sealed interface Done {
        /** [file] is a verified scratch file the caller owns: move it or delete it. */
        data class Complete(val name: String, val file: File) : Done
        data class Failed(val reason: String) : Done
    }

    fun offer(frame: JsonObject): Offer {
        val id = frame.str("id") ?: return Offer.Refused("bad id")
        val declared = frame.long("size") ?: return Offer.Refused("bad size")
        if (declared < 0) return Offer.Refused("bad size")
        if (declared > maxBytes) {
            return Offer.Refused("too large: ${formatBytes(declared)} exceeds ${formatBytes(maxBytes)}")
        }
        val name = safeFileName(frame.str("name"))
        // A second offer on a live id abandons the first one, whose spool file would
        // otherwise be leaked with no id left pointing at it.
        active.remove(id)?.discard()
        val transfer = try {
            // The cache directory can be cleared by the system between transfers, so it
            // is created here rather than once at construction. The spool name is ours,
            // never the peer's: the offered name only decides where the file lands later.
            spoolDir.mkdirs()
            val file = File.createTempFile("in-", ".part", spoolDir)
            Transfer(name, declared, frame.str("sha256") ?: "", file, FileOutputStream(file).buffered())
        } catch (e: IOException) {
            return Offer.Refused("cannot store it: ${e.message ?: "no room for it"}")
        }
        active[id] = transfer
        return Offer.Accepted(name, declared)
    }

    fun chunk(frame: JsonObject): Chunk {
        val id = frame.str("id") ?: return Chunk.Failed("unknown transfer")
        val transfer = active[id] ?: return Chunk.Failed("unknown transfer")
        val buf = try {
            Base64.getMimeDecoder().decode(frame.str("data") ?: "")
        } catch (_: IllegalArgumentException) {
            active.remove(id)?.discard()
            return Chunk.Failed("corrupt chunk")
        }
        if (transfer.received + buf.size > transfer.size) {
            active.remove(id)?.discard()
            return Chunk.Failed("stream exceeds the offered size")
        }
        try {
            transfer.sink.write(buf)
        } catch (e: IOException) {
            active.remove(id)?.discard()
            return Chunk.Failed("cannot store it: ${e.message ?: "the write failed"}")
        }
        transfer.digest.update(buf)
        transfer.received += buf.size
        return Chunk.Progress(transfer.received, transfer.size)
    }

    fun done(frame: JsonObject): Done {
        val id = frame.str("id") ?: return Done.Failed("unknown transfer")
        val transfer = active.remove(id) ?: return Done.Failed("unknown transfer")
        try {
            transfer.sink.close()
        } catch (e: IOException) {
            transfer.discard()
            return Done.Failed("cannot store it: ${e.message ?: "the write failed"}")
        }
        if (transfer.received != transfer.size) {
            transfer.discard()
            return Done.Failed("truncated transfer")
        }
        if (transfer.digest.digest().toHex() != transfer.sha256) {
            transfer.discard()
            return Done.Failed("checksum mismatch")
        }
        return Done.Complete(transfer.name, transfer.file)
    }

    fun inFlight(): Int = active.size

    fun abortAll() {
        active.values.forEach { it.discard() }
        active.clear()
    }
}

/**
 * Pushes a file down an established channel. Chunks go through the bulk path,
 * which parks this thread once a few are still in flight — that is the
 * backpressure the reference client gets from drain events, so this must never
 * run on the engine or UI thread.
 *
 * The file is read twice — once to digest it for the offer, once to send it — rather
 * than held: [openStream] therefore has to be able to hand out a fresh stream on each
 * call, and returns null when the document has become unreadable.
 *
 * Returns null on success, or the reason the transfer stopped.
 */
fun sendFile(
    rz: Rendezvous,
    id: String,
    name: String,
    size: Long,
    openStream: () -> InputStream?,
    onProgress: (sent: Long, total: Long) -> Unit = { _, _ -> },
): String? {
    val digest = try {
        openStream()?.use { sha256HexOfExactly(it, size) }
    } catch (e: IOException) {
        return e.message ?: "could not read that file"
    } ?: return "could not read that file"

    if (!rz.sendFrame(fileOfferFrame(id, safeFileName(name), size, digest))) return "channel gone"

    val encoder = Base64.getEncoder()
    val buf = ByteArray(CHUNK_BYTES)
    var seq = 0
    var sent = 0L
    val input = try {
        openStream()
    } catch (e: IOException) {
        return e.message ?: "could not read that file"
    } ?: return "could not read that file"
    input.use { stream ->
        while (sent < size) {
            // Never read past the offered size: a document that grew after the digest
            // pass would otherwise put bytes on the wire the receiver has to reject.
            val want = minOf(buf.size.toLong(), size - sent).toInt()
            val read = try {
                stream.readAtMost(buf, want)
            } catch (e: IOException) {
                return e.message ?: "could not read that file"
            }
            if (read <= 0) return "could not read that file"
            val chunk = if (read == buf.size) buf else buf.copyOf(read)
            if (!rz.putFrame(fileChunkFrame(id, seq++, encoder.encodeToString(chunk)))) return "channel gone"
            sent += read
            onProgress(sent, size)
        }
    }
    if (!rz.sendFrame(fileDoneFrame(id))) return "channel gone"
    // The last word on a transfer is that the bytes have left, not that they
    // were handed to a queue.
    return if (rz.flushed()) null else "channel gone"
}

/**
 * Fills the first [len] bytes of [buf] as far as the stream allows before returning, so
 * a provider that hands out short reads cannot turn one 48 KiB chunk into a flood of
 * tiny frames — the hub counts frames, not bytes. Returns less than [len] only at end
 * of stream.
 */
internal fun InputStream.readAtMost(buf: ByteArray, len: Int = buf.size): Int {
    var filled = 0
    while (filled < len) {
        val read = read(buf, filled, len - filled)
        if (read < 0) break
        filled += read
    }
    return filled
}
