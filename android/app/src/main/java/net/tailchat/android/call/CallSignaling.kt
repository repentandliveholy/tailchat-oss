package net.tailchat.android.call

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The `call-*` namespace (docs/specs/2026-09-15-android-calls-plan.md §2):
 * plain `{"k":"frame","to":<login>,"d":{...}}` envelopes routed through the
 * hub's existing `relay()`, never `rtc-*` — that namespace already belongs to
 * the web client's data-channel upgrade (`web/cloud/app.js:8672,8708,8743`)
 * and mixing the two would put a voice-call SDP where a data-channel SDP is
 * expected.
 *
 * Every `toFrame()`/`fromFrame()` here tolerates unknown fields on the way in
 * (a future server or client may add one) and never throws — a malformed or
 * partial frame decodes to `null` and is dropped, exactly like the hub drops
 * a malformed `d` in `relay()`.
 */
sealed interface CallFrame {
    val callId: String

    /** [restart] marks a re-offer that rebuilds a broken media path on a call
     *  both sides are already in (`CallController.onIceFailed`), not a new
     *  call. The hub reads it to keep such an offer out of the new-call path
     *  — no ring leg, no held offer, no push — and answers one only for a
     *  call it watched get answered. */
    data class Offer(
        override val callId: String,
        val sdp: String,
        val media: String,
        val ts: Long,
        val restart: Boolean = false,
    ) : CallFrame
    data class Ring(override val callId: String) : CallFrame
    data class Answer(override val callId: String, val sdp: String) : CallFrame
    data class IceCandidates(override val callId: String, val candidates: List<IceCandidate>) : CallFrame
    data class End(override val callId: String, val reason: CallEndReason) : CallFrame
    data class Taken(override val callId: String) : CallFrame
}

data class IceCandidate(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int?)

/** Mirrors the `reason` values in §2 exactly; `Unknown` is what a future
 *  reason this client has never heard of decodes to, so a newer server can
 *  never fail to parse on an old client — it just shows a generic ended
 *  state instead of the specific one. */
enum class CallEndReason(val wire: String) {
    Hangup("hangup"),
    Declined("declined"),
    Busy("busy"),
    Timeout("timeout"),
    Failed("failed"),
    Unsupported("unsupported"),
    Unknown("unknown"),
    ;

    companion object {
        fun fromWire(value: String?): CallEndReason = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

private const val T_OFFER = "call-offer"
private const val T_RING = "call-ring"
private const val T_ANSWER = "call-answer"
private const val T_ICE = "call-ice"
private const val T_END = "call-end"
private const val T_TAKEN = "call-taken"

/** Every frame type this namespace defines — what `SyncEngine`/`CloudSocket`
 *  check an incoming `d.t` against before handing it to [CallSignaling]. */
val CALL_FRAME_TYPES: Set<String> = setOf(T_OFFER, T_RING, T_ANSWER, T_ICE, T_END, T_TAKEN)

object CallSignaling {
    fun toJson(frame: CallFrame): JsonObject = buildJsonObject {
        put("callId", frame.callId)
        when (frame) {
            is CallFrame.Offer -> {
                put("t", T_OFFER)
                put("sdp", frame.sdp)
                put("media", frame.media)
                put("ts", frame.ts)
                // Written only when set: an absent field is what every older
                // client and server already reads as a new call.
                if (frame.restart) put("restart", true)
            }
            is CallFrame.Ring -> put("t", T_RING)
            is CallFrame.Answer -> {
                put("t", T_ANSWER)
                put("sdp", frame.sdp)
            }
            is CallFrame.IceCandidates -> {
                put("t", T_ICE)
                putJsonArray("candidates") {
                    for (c in frame.candidates) {
                        addJsonObject {
                            put("candidate", c.candidate)
                            c.sdpMid?.let { put("sdpMid", it) }
                            c.sdpMLineIndex?.let { put("sdpMLineIndex", it) }
                        }
                    }
                }
            }
            is CallFrame.End -> {
                put("t", T_END)
                put("reason", frame.reason.wire)
            }
            is CallFrame.Taken -> put("t", T_TAKEN)
        }
    }

    /** `null` for anything not shaped like a `call-*` frame this client
     *  understands — an unrecognised `t`, a missing `callId`, or a payload
     *  whose required fields are the wrong type. The caller (`CloudSocket`)
     *  is expected to have already checked `d.t` against [CALL_FRAME_TYPES]. */
    fun fromJson(json: JsonObject): CallFrame? {
        val callId = json["callId"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) ?: return null
        return when (json["t"]?.jsonPrimitive?.contentOrNull) {
            T_OFFER -> {
                val sdp = json["sdp"]?.jsonPrimitive?.contentOrNull ?: return null
                val media = json["media"]?.jsonPrimitive?.contentOrNull ?: "audio"
                val ts = json["ts"]?.jsonPrimitive?.longOrNull ?: 0L
                // Only a literal `true` is a restart: anything else on the
                // wire (a string, a number, an absent field) is a new call,
                // which is the safe reading — a mis-read restart would be a
                // ring nobody withdraws.
                val restart = json["restart"]?.jsonPrimitive?.booleanOrNull == true
                CallFrame.Offer(callId, sdp, media, ts, restart)
            }
            T_RING -> CallFrame.Ring(callId)
            T_ANSWER -> {
                val sdp = json["sdp"]?.jsonPrimitive?.contentOrNull ?: return null
                CallFrame.Answer(callId, sdp)
            }
            T_ICE -> {
                val candidates = json["candidates"]?.jsonArray
                    ?.mapNotNull { element -> runCatching { element.jsonObject.toIceCandidate() }.getOrNull() }
                    .orEmpty()
                if (candidates.isEmpty()) return null
                CallFrame.IceCandidates(callId, candidates)
            }
            T_END -> CallFrame.End(callId, CallEndReason.fromWire(json["reason"]?.jsonPrimitive?.contentOrNull))
            T_TAKEN -> CallFrame.Taken(callId)
            else -> null
        }
    }

    private fun JsonObject.toIceCandidate(): IceCandidate? {
        val candidate = this["candidate"]?.jsonPrimitive?.contentOrNull ?: return null
        return IceCandidate(
            candidate = candidate,
            sdpMid = this["sdpMid"]?.jsonPrimitive?.contentOrNull,
            sdpMLineIndex = this["sdpMLineIndex"]?.jsonPrimitive?.intOrNull,
        )
    }
}

// --- small JsonObjectBuilder helpers, matching the style already used
// elsewhere for hand-built frames (CloudSocket.sendFileFrame and friends). ---

private fun kotlinx.serialization.json.JsonObjectBuilder.put(key: String, value: String) {
    put(key, JsonPrimitive(value))
}

private fun kotlinx.serialization.json.JsonObjectBuilder.put(key: String, value: Long) {
    put(key, JsonPrimitive(value))
}

private fun kotlinx.serialization.json.JsonObjectBuilder.put(key: String, value: Int) {
    put(key, JsonPrimitive(value))
}

private fun kotlinx.serialization.json.JsonObjectBuilder.put(key: String, value: Boolean) {
    put(key, JsonPrimitive(value))
}

private inline fun kotlinx.serialization.json.JsonObjectBuilder.putJsonArray(
    key: String,
    builder: kotlinx.serialization.json.JsonArrayBuilder.() -> Unit,
) {
    put(key, buildJsonArray(builder))
}

private inline fun kotlinx.serialization.json.JsonArrayBuilder.addJsonObject(
    builder: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
) {
    add(buildJsonObject(builder))
}
