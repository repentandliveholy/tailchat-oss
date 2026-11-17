package net.tailchat.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A quoted message, as `replyJson` stores it. Plain data holder: the data
 *  layer does not depend on the cloud package, the integration layer maps. */
data class ReplyPayload(val id: String, val from: String, val text: String, val media: String?)

data class ForwardPayload(val login: String, val name: String)

/**
 * The body of a `"message"` pending operation — everything the sender needs to
 * rebuild the frame after a process death, flat, because that is the shape the
 * message row and the wire frame both have.
 */
data class MessagePayload(
    val text: String,
    val ts: Long,
    val author: String,
    val imageDataUrl: String? = null,
    val imageWidth: Int? = null,
    val imageHeight: Int? = null,
    val voiceDataUrl: String? = null,
    val voiceDurationSec: Int? = null,
    val replyId: String? = null,
    val replyFrom: String? = null,
    val replyText: String? = null,
    val replyMedia: String? = null,
    val forwardLogin: String? = null,
    val forwardName: String? = null,
)

/**
 * The JSON columns, hand-built.
 *
 * No `@Serializable` class anywhere in here: R8 shrinks this app (see
 * `app/build.gradle.kts`), and a reflective serializer is exactly the kind of
 * thing that survives a debug build and dies in release. Same shape and same
 * rules as `cloud/CloudHistoryStore.kt`, deliberately, so a row written by the
 * legacy cache and a row written here read the same.
 *
 * Everything here is total: an unreadable column costs the decoration it
 * carried, never the message it was attached to.
 */
object Payloads {
    private val json = Json { ignoreUnknownKeys = true }

    /** `null` for no reactions, so the column stays NULL instead of holding `{}`. */
    fun encodeReactions(reactions: Map<String, List<String>>): String? {
        val kept = reactions.filterValues { it.isNotEmpty() }
        if (kept.isEmpty()) return null
        return buildJsonObject {
            for ((emoji, logins) in kept) {
                put(emoji, buildJsonArray { for (login in logins.distinct()) add(login) })
            }
        }.toString()
    }

    fun decodeReactions(raw: String?): Map<String, List<String>> {
        val row = parseObject(raw) ?: return emptyMap()
        val out = LinkedHashMap<String, List<String>>(row.size)
        for ((emoji, logins) in row) {
            val list = runCatching {
                logins.jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull }
            }.getOrDefault(emptyList())
            if (list.isNotEmpty()) out[emoji] = list
        }
        return out
    }
    fun encodeButtons(buttons: List<net.tailchat.android.cloud.CloudBotAction>): String? {
        if (buttons.isEmpty()) return null
        return buildJsonArray {
            for (btn in buttons.take(8)) {
                add(buildJsonObject {
                    put("id", btn.id)
                    put("label", btn.label)
                    put("value", btn.value)
                })
            }
        }.toString()
    }

    fun decodeButtons(raw: String?): List<net.tailchat.android.cloud.CloudBotAction> {
        if (raw.isNullOrBlank()) return emptyList()
        val array = runCatching { json.parseToJsonElement(raw).jsonArray }.getOrNull()
            ?: return emptyList()
        return array.take(8).mapNotNull { element ->
            val obj = runCatching { element.jsonObject }.getOrNull() ?: return@mapNotNull null
            val id = obj["id"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val label = obj["label"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val value = obj["value"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            if (id.isEmpty() || id.length > 40 || label.isEmpty() || label.length > 40 ||
                value.isEmpty() || value.length > 200
            ) return@mapNotNull null
            net.tailchat.android.cloud.CloudBotAction(id, label, value)
        }
    }


    fun replyJson(id: String, from: String, text: String, media: String?): String =
        buildJsonObject {
            put("id", id)
            put("from", from)
            put("text", text)
            media?.let { put("media", it) }
        }.toString()

    fun forwardJson(login: String, name: String): String =
        buildJsonObject {
            put("login", login)
            put("name", name.ifEmpty { login })
        }.toString()

    fun parseReply(raw: String?): ReplyPayload? = parseObject(raw)?.let(::readReply)

    fun parseForward(raw: String?): ForwardPayload? = parseObject(raw)?.let(::readForward)

    /** The wire shape `"edit"` operations replay; see `SyncEngine.write`. */
    fun editPayload(text: String): String = buildJsonObject { put("text", text) }.toString()

    /** The wire shape `"react"` operations replay; see `SyncEngine.write`. */
    fun reactPayload(emoji: String, add: Boolean): String = buildJsonObject {
        put("emoji", emoji)
        put("add", add)
    }.toString()

    /** The wire shape `"delete"` operations replay; `scope` is `"self"` or `"all"`. */
    fun deletePayload(scope: String): String = buildJsonObject { put("scope", scope) }.toString()

    fun messagePayload(
        text: String,
        ts: Long,
        author: String,
        imageDataUrl: String?,
        imageWidth: Int?,
        imageHeight: Int?,
        voiceDataUrl: String?,
        voiceDurationSec: Int?,
        replyId: String?,
        replyFrom: String?,
        replyText: String?,
        replyMedia: String?,
        forwardLogin: String?,
        forwardName: String?,
    ): String = buildJsonObject {
        put("text", text)
        put("ts", ts)
        put("author", author)
        if (imageDataUrl != null) {
            put("image", buildJsonObject {
                put("dataUrl", imageDataUrl)
                put("width", imageWidth ?: 0)
                put("height", imageHeight ?: 0)
            })
        }
        if (voiceDataUrl != null) {
            put("voice", buildJsonObject {
                put("dataUrl", voiceDataUrl)
                put("durationSec", voiceDurationSec ?: 0)
            })
        }
        if (replyId != null && replyFrom != null) {
            put("replyTo", buildJsonObject {
                put("id", replyId)
                put("from", replyFrom)
                put("text", replyText.orEmpty())
                replyMedia?.let { put("media", it) }
            })
        }
        if (forwardLogin != null || forwardName != null) {
            val login = forwardLogin.orEmpty()
            val name = forwardName.orEmpty()
            if (login.isNotEmpty() || name.isNotEmpty()) {
                put("forwardedFrom", buildJsonObject {
                    put("login", login)
                    put("name", name.ifEmpty { login })
                })
            }
        }
    }.toString()

    /**
     * `null` only when the payload is unreadable or has no `ts` — a send that
     * cannot say when it was composed cannot be replayed in order, and
     * substituting `now` would file a week-old queued message as new.
     */
    fun parseMessagePayload(raw: String): MessagePayload? {
        val row = parseObject(raw) ?: return null
        val ts = row["ts"]?.jsonPrimitive?.longOrNull ?: return null
        val image = row["image"]?.let { objectOrNull(it) }?.takeIf { it["dataUrl"] != null }
        val voice = row["voice"]?.let { objectOrNull(it) }?.takeIf { it["dataUrl"] != null }
        val reply = row["replyTo"]?.let { objectOrNull(it) }?.let(::readReply)
        val forward = row["forwardedFrom"]?.let { objectOrNull(it) }?.let(::readForward)
        return MessagePayload(
            text = row["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            ts = ts,
            author = row["author"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            imageDataUrl = image?.get("dataUrl")?.jsonPrimitive?.contentOrNull,
            imageWidth = image?.get("width")?.jsonPrimitive?.intOrNull,
            imageHeight = image?.get("height")?.jsonPrimitive?.intOrNull,
            voiceDataUrl = voice?.get("dataUrl")?.jsonPrimitive?.contentOrNull,
            voiceDurationSec = voice?.get("durationSec")?.jsonPrimitive?.intOrNull,
            replyId = reply?.id,
            replyFrom = reply?.from,
            replyText = reply?.text,
            replyMedia = reply?.media,
            forwardLogin = forward?.login,
            forwardName = forward?.name,
        )
    }

    /** Any of the JSON columns as an object, or `null` when the column is
     *  absent, empty, corrupt, or not an object at all. */
    fun parseObject(raw: String?): JsonObject? {
        if (raw.isNullOrEmpty()) return null
        return runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
    }

    /**
     * A list of message ids as one column value — the outstanding backfill
     * debt of a conversation (`ConversationEntity.backfillJson`).
     *
     * JSON rather than a joined string because an id is opaque: it is chosen by
     * whichever client sent the message, and a separator that happened to
     * appear inside one would silently split it into two ids that name nothing.
     */
    fun encodeIds(ids: Collection<String>): String = buildJsonArray {
        for (id in ids) if (id.isNotEmpty()) add(id)
    }.toString()

    /** The other half of [encodeIds]. Unreadable or absent means no debt, never
     *  a guess: a corrupt column is not a reason to re-fetch an account. */
    fun decodeIds(raw: String?): List<String> {
        if (raw.isNullOrEmpty()) return emptyList()
        return runCatching { json.parseToJsonElement(raw).jsonArray }
            .getOrNull()
            ?.mapNotNull { it.jsonPrimitive.contentOrNull?.takeIf(String::isNotEmpty) }
            ?.distinct()
            .orEmpty()
    }

    private fun objectOrNull(element: kotlinx.serialization.json.JsonElement): JsonObject? =
        runCatching { element.jsonObject }.getOrNull()

    /** A quote without an id or an author cannot be rendered or scrolled to. */
    private fun readReply(row: JsonObject): ReplyPayload? {
        val id = row["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val from = row["from"]?.jsonPrimitive?.contentOrNull ?: return null
        return ReplyPayload(
            id = id,
            from = from,
            text = row["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            media = row["media"]?.jsonPrimitive?.contentOrNull,
        )
    }

    private fun readForward(row: JsonObject): ForwardPayload? {
        val login = row["login"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val name = row["name"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (login.isEmpty() && name.isEmpty()) return null
        return ForwardPayload(login = login, name = name.ifEmpty { login })
    }
}
