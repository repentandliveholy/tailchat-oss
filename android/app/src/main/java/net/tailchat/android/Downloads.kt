package net.tailchat.android

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import net.tailchat.proto.formatBytes
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.OutputStream

// A received file has to land where the rest of the phone can reach it. App-private
// storage is writable and tidy-looking, but a photo saved there is invisible to the
// gallery, the player and every share sheet: the transfer arrives and then nothing
// can open it. The shared Download folder is the one place both sides reach, and on
// minSdk 29 MediaStore is the only way in without legacy storage permissions.
private const val DOWNLOAD_SUBDIR = "tailchat"
private const val FALLBACK_MIME = "application/octet-stream"
// Big enough that a 100 MB file is a few thousand writes rather than tens of thousands,
// small enough to stay irrelevant next to the transfer itself.
private const val COPY_BUFFER_BYTES = 64 * 1024

private fun mimeOf(name: String): String {
    val ext = name.substringAfterLast('.', "")
    if (ext.isEmpty()) return FALLBACK_MIME
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: FALLBACK_MIME
}

/**
 * The row may have been renamed by MediaStore's own de-duplication, so the location
 * reported to the person has to come back out of the store rather than from [name].
 */
private fun storedName(resolver: ContentResolver, uri: Uri): String? = runCatching {
    resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { row ->
        if (row.moveToFirst() && !row.isNull(0)) row.getString(0) else null
    }
}.getOrNull()

/**
 * Moves the verified spool file [spool] into the shared Download/tailchat folder and
 * returns that human-readable location, or the failure that stopped it. The spool file
 * is consumed either way: it is scratch space, and keeping it after the transfer has
 * been resolved would leave the cache growing by the size of every file ever received.
 *
 * The copy is streamed because a received file may be as large as DEFAULT_MAX_BYTES,
 * and the point of spooling to disk is defeated by loading it back to write it out.
 */
fun saveToDownloads(context: Context, name: String, spool: File): Result<String> {
    val saved = writeToDownloads(context, name) { sink ->
        FileInputStream(spool).use { it.copyTo(sink, COPY_BUFFER_BYTES) }
    }
    spool.delete()
    return saved
}

/**
 * The same, for the handful of things the app composes in memory — a transcript
 * export — where there is no file to move and the payload is a few kilobytes of text.
 */
fun saveToDownloads(context: Context, name: String, bytes: ByteArray): Result<String> =
    writeToDownloads(context, name) { it.write(bytes) }

private fun writeToDownloads(context: Context, name: String, write: (OutputStream) -> Unit): Result<String> {
    val resolver = context.contentResolver
    val pending = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    // MediaStore resolves a colliding DISPLAY_NAME itself by appending " (1)", so no uniquifying loop here.
    val uri = try {
        resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, pending)
    } catch (e: Exception) {
        return Result.failure(e)
    } ?: return Result.failure(IOException("the Download folder refused $name"))

    try {
        val out = resolver.openOutputStream(uri)
            ?: throw IOException("cannot write $name to the Download folder")
        out.use(write)
        // Until IS_PENDING is cleared the file stays invisible to everything else,
        // which is exactly the failure this whole function exists to avoid.
        val cleared = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        if (resolver.update(uri, cleared, null, null) == 0) {
            throw IOException("$name stayed pending in the Download folder")
        }
    } catch (e: Exception) {
        runCatching { resolver.delete(uri, null, null) }
        return Result.failure(e)
    }
    return Result.success("Download/$DOWNLOAD_SUBDIR/${storedName(resolver, uri) ?: name}")
}

private fun tooLarge(size: Long, maxBytes: Long): String =
    "too large: ${formatBytes(size)} exceeds ${formatBytes(maxBytes)}"

/** What the sender needs to describe a picked document, resolved without reading it. */
data class PickedFile(val name: String, val size: Long)

/**
 * Resolves the name the peer should see and how many bytes the document holds, so the
 * caller can offer it and then stream it. It deliberately does not read the file: at
 * DEFAULT_MAX_BYTES, pulling a picked document into a ByteArray is how a send turns
 * into an OutOfMemoryError. Refuses anything past [maxBytes].
 */
fun readForSending(context: Context, uri: Uri, maxBytes: Long): Result<PickedFile> {
    val resolver = context.contentResolver
    var picked: String? = null
    var declared = -1L
    runCatching {
        resolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { row ->
            if (row.moveToFirst()) {
                if (!row.isNull(0)) picked = row.getString(0)
                if (!row.isNull(1)) declared = row.getLong(1)
            }
        }
    }
    val name = picked?.takeIf { it.isNotBlank() }
        ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
        ?: "file"

    // SIZE is optional and providers do omit it, but the offer has to carry a real
    // length, so ask the descriptor before giving up. A provider backed by something
    // that has no length at all — a pipe — reports -1 here and cannot be offered.
    val size = if (declared >= 0) declared else runCatching {
        resolver.openFileDescriptor(uri, "r")?.use { it.statSize }
    }.getOrNull() ?: -1L
    if (size < 0) return Result.failure(IOException("could not measure $name"))
    if (size > maxBytes) {
        return Result.failure(IllegalArgumentException(tooLarge(size, maxBytes)))
    }
    return Result.success(PickedFile(name, size))
}

/** Hands the person off to the system Downloads UI; false when nothing handles it. */
fun openDownloadsFolder(context: Context): Boolean {
    val intent = Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}
