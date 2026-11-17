package net.tailchat.android.data

import android.content.Context
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** What one import actually moved, for the log and for the tests. */
data class ImportReport(
    val conversations: Int = 0,
    val messages: Int = 0,
    val pending: Int = 0,
    val skipped: Int = 0,
)

/**
 * Imports the pre-Room queue and history from authenticated encrypted copies
 * created by the explicit device migration. The original cloud-outbox.json and
 * history/<peer>.json remain untouched for recovery; app reads never return
 * to those plaintext sources after migration.
 *
 * The queue survives only if every queued entry parses and commits. A malformed
 * entry or refused transaction prevents the imported marker from being written,
 * and retrying retains the same operation id rather than sending a duplicate.
 * The marker is written only after every import commits, so a crash simply
 * retries with the original message and operation ids. Neither source nor
 * encrypted copy is removed automatically.
 */
class LegacyImporter(
    private val context: Context,
    private val repository: ChatRepository,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun importOnce(accountKey: String): ImportReport {
        if (repository.legacyImported(accountKey)) return ImportReport()

        val filesDir = context.filesDir
        // Our own login: the outbox only ever held messages this account sent,
        // and the legacy file has no author field because it never needed one.
        val login = accountKey.substringAfterLast('|')

        val outbox = withContext(Dispatchers.IO) { readOutbox(File(filesDir, "legacy-encrypted/$OUTBOX_FILE.enc")) }
        val transcripts = withContext(Dispatchers.IO) { readHistory(File(filesDir, "legacy-encrypted/$HISTORY_DIR")) }

        val queuedIds = outbox.entries.mapTo(HashSet()) { it.id }
        val peers = HashSet<String>()
        var messages = 0
        var pending = 0
        var skipped = outbox.unreadable + transcripts.unreadable

        for ((peer, rows) in transcripts.byPeer) {
            // An id still in the outbox is unsent, whatever the cache says
            // about it: the cache does not record pending state (see
            // `CloudHistoryStore.decode`), so importing its copy would bury
            // the queued message under an Accepted one.
            val importable = rows.filter { it.id !in queuedIds }
            skipped += rows.size - importable.size
            if (importable.isEmpty()) continue
            if (!repository.applyHistoryPage(
                    accountKey = accountKey,
                    peer = peer,
                    messages = importable.map { it.toEntity(accountKey, peer) },
                    peerReadTs = 0L,
                )) throw java.io.IOException("Legacy history import did not commit for $peer")
            peers += peer
            messages += importable.size
        }

        for (entry in outbox.entries) {
            val now = clock()
            val message = MessageEntity(
                accountKey = accountKey,
                peer = entry.peer,
                id = entry.id,
                text = entry.text,
                ts = entry.ts,
                author = login,
                mine = true,
                delivery = DeliveryState.Queued.ordinal,
                system = false,
                kind = MessageKind.TEXT,
                imageDataUrl = null,
                imageWidth = null,
                imageHeight = null,
                voiceDataUrl = null,
                voiceDurationSec = null,
                reactionsJson = null,
                replyJson = entry.replyJson,
                forwardJson = entry.forwardJson,
                editedAt = null,
                deletedAt = null,
                serverSeq = null,
            )
            val reply = Payloads.parseReply(entry.replyJson)
            val forward = Payloads.parseForward(entry.forwardJson)
            val op = PendingOperationEntity(
                // Derived from the message id, not random: a repeat of an
                // interrupted import must collide with the operation the first
                // attempt already wrote instead of queueing a second send.
                opId = "send:${entry.id}",
                accountKey = accountKey,
                peer = entry.peer,
                kind = OperationKind.MESSAGE,
                messageId = entry.id,
                payloadJson = Payloads.messagePayload(
                    text = entry.text,
                    ts = entry.ts,
                    author = login,
                    imageDataUrl = null,
                    imageWidth = null,
                    imageHeight = null,
                    voiceDataUrl = null,
                    voiceDurationSec = null,
                    replyId = reply?.id,
                    replyFrom = reply?.from,
                    replyText = reply?.text,
                    replyMedia = reply?.media,
                    forwardLogin = forward?.login,
                    forwardName = forward?.name,
                ),
                attempts = 0,
                nextAttemptAt = now,
                lastError = null,
                errorKind = ErrorKind.None.ordinal,
                leaseOwner = null,
                leaseUntil = 0L,
                createdAt = entry.ts,
            )
            if (!repository.enqueueMessage(message, op))
                throw java.io.IOException("Legacy pending operation did not commit: ${entry.id}")
            peers += entry.peer
            pending++
        }

        // Last, and only after every write above committed: a marker written
        // first would turn a crash mid-import into permanent data loss.
        repository.markLegacyImported(accountKey)
        return ImportReport(conversations = peers.size, messages = messages, pending = pending, skipped = skipped)
    }

    private class OutboxEntryRow(
        val peer: String,
        val id: String,
        val text: String,
        val ts: Long,
        val replyJson: String?,
        val forwardJson: String?,
    )

    private class Outbox(val entries: List<OutboxEntryRow>, val unreadable: Int)

    private class HistoryRow(
        val id: String,
        val text: String,
        val ts: Long,
        val author: String,
        val mine: Boolean,
        val delivery: Int,
        val reactionsJson: String?,
        val replyJson: String?,
        val forwardJson: String?,
        val imageDataUrl: String?,
        val imageWidth: Int?,
        val imageHeight: Int?,
        val voiceDataUrl: String?,
        val voiceDurationSec: Int?,
        val editedAt: Long?,
    ) {
        fun toEntity(accountKey: String, peer: String) = MessageEntity(
            accountKey = accountKey,
            peer = peer,
            id = id,
            text = text,
            ts = ts,
            author = author,
            mine = mine,
            delivery = delivery,
            system = false,
            kind = when {
                imageDataUrl != null -> MessageKind.IMAGE
                voiceDataUrl != null -> MessageKind.VOICE
                else -> MessageKind.TEXT
            },
            imageDataUrl = imageDataUrl,
            imageWidth = imageWidth,
            imageHeight = imageHeight,
            voiceDataUrl = voiceDataUrl,
            voiceDurationSec = voiceDurationSec,
            reactionsJson = reactionsJson,
            replyJson = replyJson,
            forwardJson = forwardJson,
            editedAt = editedAt,
            deletedAt = null,
            serverSeq = null,
        )
    }

    private class History(val byPeer: Map<String, List<HistoryRow>>, val unreadable: Int)

    private fun readOutbox(file: File): Outbox {
        val raw = file.takeIf(File::isFile)?.let { readEncrypted(it) } ?: return Outbox(emptyList(), 0)
        val array = runCatching { json.parseToJsonElement(raw).jsonArray }.getOrElse {
            throw java.io.IOException("Legacy outbox cannot be parsed; unsent messages are still in the source", it)
        }
        val entries = ArrayList<OutboxEntryRow>(array.size)
        var unreadable = 0
        for (element in array) {
            val row = runCatching { element.jsonObject }.getOrNull()
            val peer = row?.get("peer")?.jsonPrimitive?.contentOrNull
            val id = row?.get("id")?.jsonPrimitive?.contentOrNull
            val text = row?.get("text")?.jsonPrimitive?.contentOrNull
            val ts = row?.get("ts")?.jsonPrimitive?.longOrNull
            if (row == null || peer == null || id == null || text == null || ts == null) {
                unreadable++
                continue
            }
            entries += OutboxEntryRow(
                peer = peer,
                id = id,
                text = text,
                ts = ts,
                replyJson = replyJsonOf(row),
                forwardJson = forwardJsonOf(row),
            )
        }
        if (unreadable > 0) throw java.io.IOException("Legacy outbox has $unreadable unreadable queued messages")
        return Outbox(entries, unreadable)
    }

    private fun readHistory(dir: File): History {
        val files = dir.takeIf(File::isDirectory)?.listFiles().orEmpty()
            .filter { it.isFile && it.name.endsWith("$SUFFIX.enc") }
        if (files.isEmpty()) return History(emptyMap(), 0)
        val byPeer = LinkedHashMap<String, List<HistoryRow>>(files.size)
        var unreadable = 0
        for (file in files) {
            // The file name is the peer: that is how `CloudHistoryStore` keys
            // the cache, and the `peer` field inside a row is only ever a copy
            // of it.
            val peer = file.name.removeSuffix("$SUFFIX.enc")
            if (peer.isEmpty()) continue
            val raw = readEncrypted(file)
            val array = runCatching { json.parseToJsonElement(raw).jsonArray }.getOrElse {
                throw java.io.IOException("Legacy history cannot be parsed: ${file.name}", it)
            }
            val rows = ArrayList<HistoryRow>(array.size)
            for (element in array) {
                val row = runCatching { element.jsonObject }.getOrNull()
                val parsed = row?.let(::historyRow)
                if (parsed == null) {
                    unreadable++
                    continue
                }
                rows += parsed
            }
            if (rows.isNotEmpty()) byPeer[peer] = rows
        }
        if (unreadable > 0) throw java.io.IOException("Legacy history has $unreadable unreadable messages")
        return History(byPeer, unreadable)
    }

    private fun historyRow(row: JsonObject): HistoryRow? {
        val id = row["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val ts = row["ts"]?.jsonPrimitive?.longOrNull ?: return null
        val author = row["author"]?.jsonPrimitive?.contentOrNull ?: return null
        val read = row["read"]?.jsonPrimitive?.booleanOrNull ?: false
        val acknowledged = row["acknowledged"]?.jsonPrimitive?.booleanOrNull ?: false
        // The same mapping `CloudMessage.delivery` made: a cached row is never
        // pending (the cache does not store that), so the floor is Accepted.
        val delivery = when {
            read -> DeliveryState.Read
            acknowledged -> DeliveryState.Delivered
            else -> DeliveryState.Accepted
        }
        val image = row["image"]?.let { runCatching { it.jsonObject }.getOrNull() }
            ?.takeIf { it["dataUrl"] != null }
        val voice = row["voice"]?.let { runCatching { it.jsonObject }.getOrNull() }
            ?.takeIf { it["dataUrl"] != null }
        val reactions = row["reactions"]?.let { runCatching { it.jsonObject }.getOrNull() }
        return HistoryRow(
            id = id,
            text = row["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            ts = ts,
            author = author,
            mine = row["mine"]?.jsonPrimitive?.booleanOrNull ?: false,
            delivery = delivery.ordinal,
            reactionsJson = reactions?.let { Payloads.encodeReactions(Payloads.decodeReactions(it.toString())) },
            replyJson = replyJsonOf(row),
            forwardJson = forwardJsonOf(row),
            imageDataUrl = image?.get("dataUrl")?.jsonPrimitive?.contentOrNull,
            imageWidth = image?.get("width")?.jsonPrimitive?.intOrNull,
            imageHeight = image?.get("height")?.jsonPrimitive?.intOrNull,
            voiceDataUrl = voice?.get("dataUrl")?.jsonPrimitive?.contentOrNull,
            voiceDurationSec = voice?.get("durationSec")?.jsonPrimitive?.intOrNull,
            editedAt = row["editedAt"]?.jsonPrimitive?.longOrNull,
        )
    }

    /** Re-encoded through [Payloads] rather than copied verbatim, so an
     *  imported column is byte-identical to one this layer writes itself. */
    private fun replyJsonOf(row: JsonObject): String? {
        val quote = row["replyTo"]?.let { runCatching { it.jsonObject }.getOrNull() } ?: return null
        val reply = Payloads.parseReply(quote.toString()) ?: return null
        return Payloads.replyJson(reply.id, reply.from, reply.text, reply.media)
    }

    private fun forwardJsonOf(row: JsonObject): String? {
        val origin = row["forwardedFrom"]?.let { runCatching { it.jsonObject }.getOrNull() } ?: return null
        val forward = Payloads.parseForward(origin.toString()) ?: return null
        return Payloads.forwardJson(forward.login, forward.name)
    }

    private fun readEncrypted(file: File): String =
        String(EncryptedFile(DeviceDataKey.get(context)).read(file), Charsets.UTF_8)

    companion object {
        const val OUTBOX_FILE = "cloud-outbox.json"
        const val HISTORY_DIR = "history"
        private const val SUFFIX = ".json"
    }
}
