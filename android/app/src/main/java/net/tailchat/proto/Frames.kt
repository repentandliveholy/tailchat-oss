package net.tailchat.proto

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.ByteArrayOutputStream

/**
 * The tailchat wire format: one JSON object per line, UTF-8, newline-terminated.
 * Identical to src/frames.js — a phone and a terminal have to read the same
 * bytes, so this file is a port and not a redesign.
 */

fun encodeFrame(frame: JsonObject): ByteArray =
    (frame.toString() + "\n").toByteArray(Charsets.UTF_8)

/**
 * Splits on the newline BYTE and only then decodes UTF-8. A newline can never
 * appear inside a multi-byte UTF-8 sequence, so this is safe on a chunk boundary
 * that lands mid-character — the case node's StringDecoder exists to handle.
 */
class FrameParser(private val onFrame: (JsonObject) -> Unit) {
    private val buf = ByteArrayOutputStream(8 * 1024)

    fun push(chunk: ByteArray, length: Int = chunk.size) {
        var start = 0
        while (start < length) {
            val nl = chunk.indexOfByte('\n'.code.toByte(), start, length)
            if (nl < 0) {
                buf.write(chunk, start, length - start)
                return
            }
            buf.write(chunk, start, nl - start)
            emit()
            start = nl + 1
        }
    }

    private fun emit() {
        val line = buf.toByteArray()
        buf.reset()
        if (line.isEmpty()) return
        val obj = try {
            Wire.json.parseToJsonElement(String(line, Charsets.UTF_8)) as? JsonObject
        } catch (_: Exception) {
            null // skip malformed frame, exactly as the reference client does
        } ?: return
        onFrame(obj)
    }
}

private fun ByteArray.indexOfByte(needle: Byte, from: Int, until: Int): Int {
    var i = from
    while (i < until) {
        if (this[i] == needle) return i
        i++
    }
    return -1
}

/** Field readers that mirror the reference client's tolerance for junk. */
fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

fun JsonObject.strOr(key: String, fallback: String): String = str(key) ?: fallback

fun JsonObject.long(key: String): Long? {
    val prim = this[key] as? JsonPrimitive ?: return null
    if (prim.isString) return null
    return try {
        prim.long
    } catch (_: Exception) {
        null
    }
}

fun JsonObject.bool(key: String): Boolean {
    val prim = this[key] as? JsonPrimitive ?: return false
    if (prim.isString) return false
    return try {
        prim.boolean
    } catch (_: Exception) {
        false
    }
}

fun JsonObject.element(key: String): JsonElement? = this[key]
