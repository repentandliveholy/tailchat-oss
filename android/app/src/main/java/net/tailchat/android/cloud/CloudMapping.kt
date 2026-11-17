package net.tailchat.android.cloud

import java.security.MessageDigest

import net.tailchat.android.call.CallEndReason
import net.tailchat.android.call.CallLogEntry
import net.tailchat.android.data.CallOutcome
import net.tailchat.android.data.ConversationEntity
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.MessageEntity
import net.tailchat.android.data.MessageKind
import net.tailchat.android.data.Payloads

/**
 * The one place the durable row shape and the UI row shape are translated into
 * each other.
 *
 * The data layer deliberately does not know about `CloudMessage`: it stores
 * columns, not Compose models, so a UI field can be added without a migration
 * and a column can be renamed without touching a screen. That trade only holds
 * if the translation lives in exactly one file — two of them and the two halves
 * drift, which is the class of bug the whole cutover exists to remove.
 */

fun accountKeyOf(server: String, login: String): String = "$server|$login"

fun accountKeyOf(session: CloudSession): String = accountKeyOf(session.server, session.user.login)

/** Opaque identity carried by FCM; no token, server URL or login leaves the
 * Tailchat API in the push payload. */
fun accountScopeOf(session: CloudSession): String =
    MessageDigest.getInstance("SHA-256")
        .digest(accountKeyOf(session).toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

fun CloudDelivery.toStored(): DeliveryState = when (this) {
    CloudDelivery.Queued -> DeliveryState.Queued
    CloudDelivery.Sending -> DeliveryState.Sending
    CloudDelivery.Accepted -> DeliveryState.Accepted
    CloudDelivery.Delivered -> DeliveryState.Delivered
    CloudDelivery.Read -> DeliveryState.Read
    CloudDelivery.Failed -> DeliveryState.Failed
}

fun DeliveryState.toModel(): CloudDelivery = when (this) {
    DeliveryState.Queued -> CloudDelivery.Queued
    DeliveryState.Sending -> CloudDelivery.Sending
    DeliveryState.Accepted -> CloudDelivery.Accepted
    DeliveryState.Delivered -> CloudDelivery.Delivered
    DeliveryState.Read -> CloudDelivery.Read
    DeliveryState.Failed -> CloudDelivery.Failed
}

fun CloudMessage.toEntity(accountKey: String, kind: String = "msg"): MessageEntity = MessageEntity(
    accountKey = accountKey,
    peer = peer,
    id = id,
    text = text,
    ts = ts,
    author = author,
    mine = mine,
    delivery = delivery.toStored().ordinal,
    system = system,
    kind = kind,
    imageDataUrl = image?.dataUrl,
    imageWidth = image?.width,
    imageHeight = image?.height,
    voiceDataUrl = voice?.dataUrl,
    voiceDurationSec = voice?.durationSec,
    reactionsJson = Payloads.encodeReactions(reactions),
    replyJson = replyTo?.let { Payloads.replyJson(it.id, it.from, it.text, it.media) },
    forwardJson = forwardedFrom?.let { Payloads.forwardJson(it.login, it.name) },
    editedAt = editedAt,
    // The tombstone travels with the row. `/api/history` is asked for deleted
    // records on purpose (`CloudApi.history` sends `deleted=1`) so a stale page
    // can never resurrect an id this device already buried — and the server
    // answers those records with `deletedAt` set and `text: ''`
    // (`accounts.js:358-363`). Dropping it here stored the tombstone as an
    // ordinary empty message: a message deleted from another client while this
    // one was closed came back on first open as a bubble with nothing in it.
    deletedAt = deletedAt,
    serverSeq = null,
    callOutcome = call?.outcome,
    callDurationSec = call?.durationSec,
    buttonsJson = Payloads.encodeButtons(buttons),
)

fun MessageEntity.toModel(): CloudMessage = CloudMessage(
    id = id,
    peer = peer,
    text = text,
    ts = ts,
    author = author,
    mine = mine,
    delivery = DeliveryState.of(delivery).toModel(),
    system = system,
    image = imageDataUrl?.let { url ->
        CloudImage(url, imageWidth ?: 0, imageHeight ?: 0)
    },
    voice = voiceDataUrl?.let { url -> CloudVoice(url, voiceDurationSec ?: 0) },
    reactions = Payloads.decodeReactions(reactionsJson),
    replyTo = Payloads.parseReply(replyJson)?.let { CloudReply(it.id, it.from, it.text, it.media) },
    forwardedFrom = Payloads.parseForward(forwardJson)?.let { CloudForward(it.login, it.name) },
    call = if (kind == MessageKind.CALL) CloudCall(callOutcome ?: CallOutcome.MISSED, callDurationSec ?: 0) else null,
    editedAt = editedAt,
    deletedAt = deletedAt,
    buttons = Payloads.decodeButtons(buttonsJson),
)

/**
 * §4.5: what this device saw happen to a call, turned into the plain
 * [CallOutcome] tag `CloudCall`/the stored row read back with — the one
 * place a raw [CallEndReason] is reinterpreted with direction in mind. A
 * `call-end` reason alone is ambiguous: the same [CallEndReason.Timeout]
 * means "nobody answered me" from the caller's side and "I never answered
 * it" (a missed call) from the callee's — [CallLogEntry.incoming] is what
 * tells the two apart.
 */
private fun CallLogEntry.outcome(): String = when {
    everActive -> CallOutcome.ANSWERED
    reason == CallEndReason.Unsupported -> CallOutcome.UNSUPPORTED
    reason == CallEndReason.Failed -> CallOutcome.FAILED
    reason == CallEndReason.Declined -> CallOutcome.DECLINED
    reason == CallEndReason.Busy -> CallOutcome.BUSY
    reason == CallEndReason.Timeout -> if (incoming) CallOutcome.MISSED else CallOutcome.TIMEOUT
    // `call-taken`: another of this account's own devices answered first —
    // only ever reached for an incoming call (CallTransitions.taken).
    reason == CallEndReason.Unknown && incoming -> CallOutcome.ANSWERED_ELSEWHERE
    incoming -> CallOutcome.MISSED
    else -> CallOutcome.CANCELED
}

/** Only an incoming call nobody on this device answered earns the same
 *  unread bump a message would — an answered call and this device's own
 *  outgoing attempt are not something the user is behind on. */
val CallLogEntry.countsAsUnread: Boolean get() = outcome() == CallOutcome.MISSED

/** [selfName] is this account's own display name — needed only when
 *  [CallLogEntry.incoming] is `false`, since [CallLogEntry.peerName] already
 *  covers the other case. */
fun CallLogEntry.toMessageEntity(accountKey: String, selfName: String): MessageEntity = MessageEntity(
    accountKey = accountKey,
    peer = peer,
    id = "call-$callId",
    text = "",
    ts = endedAtMs,
    author = if (incoming) peerName else selfName,
    mine = !incoming,
    delivery = DeliveryState.Accepted.ordinal,
    system = false,
    kind = MessageKind.CALL,
    imageDataUrl = null,
    imageWidth = null,
    imageHeight = null,
    voiceDataUrl = null,
    voiceDurationSec = null,
    reactionsJson = null,
    replyJson = null,
    forwardJson = null,
    editedAt = null,
    deletedAt = null,
    serverSeq = null,
    callOutcome = outcome(),
    callDurationSec = durationSec,
)

fun ConversationEntity.toUser(): CloudUser = CloudUser(
    login = peer,
    name = name,
    alias = alias?.takeIf(String::isNotBlank),
    online = online,
    lastSeen = lastSeen,
    pending = unread,
    preview = previewFrom?.let {
        CloudPreview(
            from = it,
            text = previewText.orEmpty(),
            media = previewMedia,
            ts = previewTs,
            read = previewTs > 0 && previewTs <= peerReadTs,
            // The rung below `read`, from the delivered watermark this row
            // also keeps. Reading implies delivery, so a row the peer has read
            // is delivered too even when the stored watermark lags; the `read`
            // flag above still wins in the glyph.
            delivered = previewTs > 0 && previewTs <= peerDeliveredTs,
        )
    },
    official = official,
    blocked = blocked,
    bot = bot,
)

/** The `msg` frame payload a queued message is rebuilt from on every attempt,
 *  so a retry re-sends the same bytes under the same id rather than whatever
 *  the composer's state happens to be by then. */
fun messageOperationPayload(message: CloudMessage): String = Payloads.messagePayload(
    text = message.text,
    ts = message.ts,
    author = message.author,
    imageDataUrl = message.image?.dataUrl,
    imageWidth = message.image?.width,
    imageHeight = message.image?.height,
    voiceDataUrl = message.voice?.dataUrl,
    voiceDurationSec = message.voice?.durationSec,
    replyId = message.replyTo?.id,
    replyFrom = message.replyTo?.from,
    replyText = message.replyTo?.text,
    replyMedia = message.replyTo?.media,
    forwardLogin = message.forwardedFrom?.login,
    forwardName = message.forwardedFrom?.name,
)
