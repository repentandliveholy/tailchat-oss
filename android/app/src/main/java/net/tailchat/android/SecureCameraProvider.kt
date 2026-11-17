package net.tailchat.android

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.os.ProxyFileDescriptorCallback
import android.os.storage.StorageManager
import android.provider.OpenableColumns
import android.system.ErrnoException
import android.system.OsConstants
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import net.tailchat.android.data.DeviceDataKey
import net.tailchat.android.data.EncryptedFile

/** External camera sees a seekable content URI; all of its writes stay in RAM until
 * close publishes authenticated ciphertext. A JPEG is never staged to app storage. */
class SecureCameraProvider : ContentProvider() {
    private val thread = HandlerThread("tailchat-camera-proxy").apply { start() }
    private val captures = HashMap<String, Capture>()

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "image/jpeg"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val token = token(uri)
        val app = context ?: throw FileNotFoundException("Camera storage unavailable")
        val file = File(app.cacheDir, "camera-encrypted/$token.jpg.enc")
        val crypto = EncryptedFile(DeviceDataKey.get(app))
        val storage = app.getSystemService(StorageManager::class.java)
        val writing = mode.contains('w')
        val capture = synchronized(captures) {
            if (writing) Capture().also { captures[token] = it }
            else captures[token]
        }
        if (!writing && !file.exists()) capture?.awaitCompletion()
        if (!writing && !file.isFile) throw FileNotFoundException("Camera capture not complete")
        val source = if (writing) capture!! else Capture(crypto.read(file))
        val callback = object : ProxyFileDescriptorCallback() {
            override fun onGetSize(): Long = source.size().toLong()
            override fun onRead(offset: Long, size: Int, data: ByteArray): Int = source.read(offset, size, data)
            override fun onWrite(offset: Long, size: Int, data: ByteArray): Int {
                if (!writing) throw ErrnoException("read-only camera", OsConstants.EBADF)
                return source.write(offset, size, data)
            }
            override fun onFsync() = Unit
            override fun onRelease() {
                if (writing) {
                    try {
                        val bytes = source.bytes()
                        if (bytes.isNotEmpty()) crypto.write(file, bytes)
                    } catch (_: Exception) {
                        // No finished ciphertext: the reader reports a failed capture.
                    } finally {
                        source.complete()
                        synchronized(captures) { captures.remove(token) }
                    }
                }
            }
        }
        return storage.openProxyFileDescriptor(
            if (writing) ParcelFileDescriptor.MODE_READ_WRITE else ParcelFileDescriptor.MODE_READ_ONLY,
            callback,
            Handler(thread.looper),
        )
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                       selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val token = token(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            addRow(columns.map { column -> when (column) {
                OpenableColumns.DISPLAY_NAME -> "$token.jpg"
                OpenableColumns.SIZE -> File(context!!.cacheDir, "camera-encrypted/$token.jpg.enc").length()
                else -> null
            } }.toTypedArray())
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    private fun token(uri: Uri): String {
        if (uri.authority != "${context?.packageName}.camera-secure" ||
            uri.pathSegments.size != 2 || uri.pathSegments[0] != "capture")
            throw FileNotFoundException("Unknown camera URI")
        val id = uri.pathSegments[1]
        if (runCatching { UUID.fromString(id).toString() }.getOrNull() != id)
            throw FileNotFoundException("Unknown camera capture")
        return id
    }

    private class Capture(initial: ByteArray = ByteArray(0)) {
        private var data = initial.copyOf(maxOf(initial.size, 64 * 1024))
        private var length = initial.size
        private val closed = CountDownLatch(1)
        fun awaitCompletion() { closed.await(5, TimeUnit.SECONDS) }
        fun complete() { closed.countDown() }
        @Synchronized fun size(): Int = length
        @Synchronized fun bytes(): ByteArray = data.copyOf(length)
        @Synchronized fun read(offset: Long, size: Int, target: ByteArray): Int {
            if (offset < 0 || offset >= length) return 0
            val count = minOf(size, length - offset.toInt())
            System.arraycopy(data, offset.toInt(), target, 0, count)
            return count
        }
        @Synchronized fun write(offset: Long, size: Int, source: ByteArray): Int {
            if (offset < 0 || size < 0 || offset > MAX_BYTES || size > MAX_BYTES - offset)
                throw ErrnoException("camera memory limit", OsConstants.ENOSPC)
            val end = offset.toInt() + size
            if (end > data.size) data = data.copyOf(minOf(MAX_BYTES, maxOf(end, data.size * 2)))
            System.arraycopy(source, 0, data, offset.toInt(), size)
            length = maxOf(length, end)
            return size
        }
    }

    companion object {
        private const val MAX_BYTES = 64 * 1024 * 1024
        fun uri(context: android.content.Context): Uri = Uri.Builder().scheme("content")
            .authority("${context.packageName}.camera-secure")
            .appendPath("capture").appendPath(UUID.randomUUID().toString()).build()
    }
}
