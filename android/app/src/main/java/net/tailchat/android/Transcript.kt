package net.tailchat.android

import android.content.Context
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import net.tailchat.proto.Wire
import net.tailchat.proto.bool
import net.tailchat.proto.long
import net.tailchat.android.data.DeviceDataKey
import net.tailchat.android.data.DeviceMigration
import net.tailchat.android.data.EncryptedFile
import net.tailchat.proto.str
import java.io.File
import java.io.IOException

/** The active transcript is authenticated and encrypted. The original NDJSON source
 * is kept untouched for recovery after the explicit migration. */
class Transcript(private val context: Context) {
    private val file = File(context.filesDir, "transcript.ndjson.enc")
    private val cipher = EncryptedFile(DeviceDataKey.get(context))
    private val lock = Any()

    fun append(entry: Entry) {
        val line = encode(entry) ?: return
        synchronized(lock) {
            if (DeviceMigration.needed(context)) throw IOException("Transcript migration required")
            val existing = if (file.isFile) String(cipher.read(file), Charsets.UTF_8) else ""
            cipher.write(file, (existing + line + "\n").toByteArray(Charsets.UTF_8))
        }
    }

    fun load(): List<Entry> = synchronized(lock) {
        val lines = try {
            if (DeviceMigration.needed(context)) throw IOException("Transcript migration required")
            if (!file.isFile) return emptyList()
            String(cipher.read(file), Charsets.UTF_8).lineSequence().toList()
        } catch (error: IOException) {
            throw error
        }
        // A settled transfer is appended a second time to record its outcome, so
        // the last line for a key is the true one.
        val byKey = LinkedHashMap<String, Entry>()
        for (line in lines) {
            val entry = decode(line) ?: continue
            byKey.remove(entry.key)
            byKey[entry.key] = entry
        }
        val entries = byKey.values.toList()
        val kept = if (entries.size > KEEP) entries.subList(entries.size - KEEP, entries.size) else entries
        // Rewriting only when the file has genuinely bloated keeps the common
        // launch to a single sequential read.
        if (lines.size > KEEP * 2) rewrite(kept)
        kept
    }

    fun clear() = synchronized(lock) {
        try {
            file.delete()
        } catch (_: SecurityException) {
        }
        Unit
    }

    private fun rewrite(entries: List<Entry>) {
        cipher.write(file, entries.mapNotNull { encode(it)?.toString() }
            .joinToString("\n", postfix = "\n").toByteArray(Charsets.UTF_8))
    }

    private fun encode(entry: Entry): JsonObject? = when (entry) {
        is Entry.Msg -> buildJsonObject {
            put("k", "msg")
            put("key", entry.key)
            entry.id?.let { put("id", it) }
            put("mine", entry.mine)
            put("author", entry.author)
            put("text", entry.text)
            put("ts", entry.ts)
            put("r", entry.receipt.name)
        }

        is Entry.FileEntry -> buildJsonObject {
            put("k", "file")
            put("key", entry.key)
            put("id", entry.id)
            put("mine", entry.mine)
            put("name", entry.name)
            put("size", entry.size)
            put("ts", entry.ts)
            when (val transfer = entry.transfer) {
                is Transfer.Complete -> {
                    put("state", "complete")
                    transfer.location?.let { put("loc", it) }
                }

                is Transfer.Failed -> {
                    put("state", "failed")
                    put("reason", transfer.reason)
                }
                // An unfinished transfer is not history yet; on reload it would
                // be a progress bar that can never move again.
                is Transfer.Progress -> return null
            }
        }

        is Entry.Note -> null
    }

    private fun decode(line: String): Entry? {
        if (line.isBlank()) return null
        val obj = try {
            Wire.json.parseToJsonElement(line) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        val key = obj.str("key") ?: return null
        val ts = obj.long("ts") ?: return null
        return when (obj.str("k")) {
            "msg" -> Entry.Msg(
                key = key,
                id = obj.str("id"),
                mine = obj.bool("mine"),
                author = obj.str("author") ?: "?",
                text = obj.str("text") ?: "",
                ts = ts,
                receipt = runCatching { Receipt.valueOf(obj.str("r") ?: "") }.getOrDefault(Receipt.Sent),
            )

            "file" -> Entry.FileEntry(
                key = key,
                id = obj.str("id") ?: return null,
                mine = obj.bool("mine"),
                name = obj.str("name") ?: "file",
                size = obj.long("size") ?: 0,
                ts = ts,
                transfer = if (obj.str("state") == "complete") {
                    Transfer.Complete(obj.str("loc"))
                } else {
                    Transfer.Failed(obj.str("reason") ?: "failed")
                },
            )

            else -> null
        }
    }

    private companion object {
        const val KEEP = 2000
    }
}
