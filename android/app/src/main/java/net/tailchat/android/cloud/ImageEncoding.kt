package net.tailchat.android.cloud

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Matrix
import android.graphics.Rect
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64

/** The largest file read into memory to be sent as a picture. A phone photo is a few
 *  megabytes; anything past this is not a photo, and `readBytes()` on it is how a send
 *  turns into an `OutOfMemoryError`. */
internal const val IMAGE_SOURCE_MAX_BYTES = 48 * 1024 * 1024

/** What a frame-sized decode of a whole picture may cost when the region decoder cannot
 *  be used: 12 megapixels of ARGB_8888, the same ceiling a 12 MP phone photo always had. */
private const val FULL_FRAME_MAX_PIXELS = 12_000_000L

/** How preparing a picked picture for sending ended. */
internal sealed interface ImageOutcome {
    data class Ready(val image: CloudImage) : ImageOutcome

    /** The file could not be read, or is not a picture `BitmapFactory` understands. */
    data object Unreadable : ImageOutcome

    /** A picture, but no encoding of it fits a frame even at the lowest size and quality. */
    data object TooLarge : ImageOutcome
}

/**
 * The picture that leaves: a picked file, with the editor's rotation and crop
 * applied, encoded the way web/cloud/app.js's `compressImage()` does — full
 * resolution at high quality first ([IMAGE_MAX_DIM], [IMAGE_QUALITY]) and backed
 * off only when the result genuinely does not fit a frame, instead of ruining
 * every picture up front to fit the worst case.
 *
 * Everything here is blocking and allocation-heavy: call it on `Dispatchers.IO`.
 *
 * Memory is bounded by what the *result* needs, not by the file: the decode is
 * sampled (`inSampleSize`) so it stays under twice the target, and a crop is cut
 * with `BitmapRegionDecoder`, which decodes only that region. A 12-megapixel
 * photo as ARGB_8888 is ~48 MB of heap, and a 50-megapixel one would be 200 MB.
 */
internal object ImageEncoder {
    /** Reads the picture at [uri], applies [edit] and encodes it — everything a send does before the message is queued. */
    fun prepare(resolver: ContentResolver, uri: Uri, edit: ImageEdit): ImageOutcome {
        val bytes = readBytes(resolver, uri)
        if (bytes == null || !isDecodable(bytes)) return ImageOutcome.Unreadable
        val image = compress(bytes, edit) ?: return ImageOutcome.TooLarge
        return ImageOutcome.Ready(image)
    }

    /** The file at [uri], or `null` when it cannot be read or is larger than [IMAGE_SOURCE_MAX_BYTES]. */
    fun readBytes(resolver: ContentResolver, uri: Uri): ByteArray? = runCatching {
        resolver.openInputStream(uri)?.use { readBounded(it, IMAGE_SOURCE_MAX_BYTES) }
    }.getOrNull()

    private fun readBounded(input: InputStream, max: Int): ByteArray? {
        val out = ByteArrayOutputStream(minOf(maxOf(input.available(), 8 * 1024), max))
        val buffer = ByteArray(64 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > max) return null
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    /** `true` when [bytes] hold a picture `BitmapFactory` can size — cheap, nothing is decoded. */
    fun isDecodable(bytes: ByteArray): Boolean {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        return bounds.outWidth > 0 && bounds.outHeight > 0
    }

    /** `ExifInterface.TAG_ORIENTATION` of [bytes], `ORIENTATION_NORMAL` when there is none. */
    fun exifOrientation(bytes: ByteArray): Int = runCatching {
        ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
        )
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

    /**
     * [bytes] with [edit] applied, encoded to fit one frame ([CLOUD_INLINE_MEDIA_SAFE_CHARS]),
     * or `null` when no encoding of it does. Five attempts, each at half the
     * long side (never under 640) and twelve points less quality (never under 55).
     */
    fun compress(bytes: ByteArray, edit: ImageEdit = ImageEdit.None): CloudImage? {
        val orientation = orientationFromExif(exifOrientation(bytes))
        var dim = IMAGE_MAX_DIM
        var quality = IMAGE_QUALITY
        repeat(5) {
            // `runCatching` catches `Throwable`, which is what makes an `OutOfMemoryError`
            // on a hostile size one more failed attempt at a smaller one.
            val encoded = runCatching { encode(bytes, orientation, edit, dim, quality) }.getOrNull()
            if (encoded != null && encoded.dataUrl.length <= CLOUD_INLINE_MEDIA_SAFE_CHARS) return encoded
            dim = (dim / 2).coerceAtLeast(640)
            quality = (quality - 12).coerceAtLeast(55)
        }
        return null
    }

    private fun encode(bytes: ByteArray, base: Orientation, edit: ImageEdit, dim: Int, quality: Int): CloudImage? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val rawWidth = bounds.outWidth
        val rawHeight = bounds.outHeight
        if (rawWidth <= 0 || rawHeight <= 0) return null

        // EXIF first, the editor's turn on top of it: one orientation for the whole trip.
        val total = base.plus(edit.turns)
        val frameWidth = if (total.swapsAxes) rawHeight else rawWidth
        val frameHeight = if (total.swapsAxes) rawWidth else rawHeight
        val region = toRawRect(cropRectOf(edit, frameWidth, frameHeight), rawWidth, rawHeight, total)

        val decoded = decodeRegion(bytes, region, rawWidth, rawHeight, encodeSampleSize(maxOf(region.width, region.height), dim))
            ?: return null
        val longest = maxOf(decoded.width, decoded.height)
        val scale = if (longest > dim) dim.toFloat() / longest else 1f
        val matrix = Matrix()
        if (total.flipped) matrix.postScale(-1f, 1f)
        if (total.turns != 0) matrix.postRotate(total.turns * 90f)
        if (scale < 1f) matrix.postScale(scale, scale)
        // One allocation for mirror, turn and downscale together; the sample above keeps
        // the residual scale in (0.5, 1], where one bilinear step does not alias.
        val upright = if (matrix.isIdentity) decoded
        else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
        if (upright !== decoded) decoded.recycle()
        try {
            val output = ByteArrayOutputStream()
            // WebP at the same quality is roughly half the bytes of JPEG, which is
            // what buys the extra resolution within the same frame ceiling. The
            // lossy enum only exists from API 30; on 29 the plain `WEBP` value is
            // the lossy encoder anyway.
            val format = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Bitmap.CompressFormat.WEBP_LOSSY
            } else {
                @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
            }
            if (!upright.compress(format, quality, output)) return null
            val encoded = Base64.getEncoder().encodeToString(output.toByteArray())
            return CloudImage("data:image/webp;base64,$encoded", upright.width, upright.height)
        } finally {
            upright.recycle()
        }
    }

    /** The whole frame, or — for a crop — only [region], both sampled by [sample]. */
    private fun decodeRegion(bytes: ByteArray, region: PixelRect, rawWidth: Int, rawHeight: Int, sample: Int): Bitmap? {
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val whole = region.left == 0 && region.top == 0 && region.right == rawWidth && region.bottom == rawHeight
        if (whole) return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        val viaRegionDecoder = runCatching {
            @Suppress("DEPRECATION") // the 3-argument overload is API 31; this app runs from 29
            val decoder = BitmapRegionDecoder.newInstance(bytes, 0, bytes.size, false)
            try {
                decoder?.decodeRegion(Rect(region.left, region.top, region.right, region.bottom), options)
            } finally {
                decoder?.recycle()
            }
        }.getOrNull()
        return viaRegionDecoder ?: decodeCropOfFullFrame(bytes, region, rawWidth, rawHeight, sample)
    }

    /**
     * For a format the region decoder refuses: decode the whole frame, but sampled
     * hard enough that it stays under [FULL_FRAME_MAX_PIXELS] — a crop of a huge
     * picture comes out softer here rather than taking the process down with it.
     */
    private fun decodeCropOfFullFrame(bytes: ByteArray, region: PixelRect, rawWidth: Int, rawHeight: Int, sample: Int): Bitmap? {
        var step = sample
        while (rawWidth.toLong() * rawHeight / (step.toLong() * step) > FULL_FRAME_MAX_PIXELS) step *= 2
        val frame = BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = step },
        ) ?: return null
        val left = (region.left / step).coerceIn(0, frame.width - 1)
        val top = (region.top / step).coerceIn(0, frame.height - 1)
        val right = ((region.right + step - 1) / step).coerceIn(left + 1, frame.width)
        val bottom = ((region.bottom + step - 1) / step).coerceIn(top + 1, frame.height)
        val cut = Bitmap.createBitmap(frame, left, top, right - left, bottom - top)
        if (cut !== frame) frame.recycle()
        return cut
    }
}

/**
 * `inSampleSize` for an encode: the largest power of two that still leaves the long
 * side at or above [dim]. Powers of two only, and never past the target — sampling to
 * 1/4 when 1/2 was needed would throw away detail the target asked for.
 */
internal fun encodeSampleSize(longest: Int, dim: Int): Int {
    var sample = 1
    while (longest > 0 && longest / (sample * 2) >= dim) sample *= 2
    return sample
}
