package net.tailchat.android.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Where a message is on its way to the other side.
 *
 * The ordinals are stored, so they are frozen by `LOCAL_FIRST_CONTRACT.md` §2:
 * a reordering here silently rewrites the meaning of every row already on a
 * user's phone. Append only.
 *
 * [Accepted] is the server having committed the message, not the peer having
 * received it, and [Delivered] is the peer's device, not the peer's eyes — the
 * whole point of splitting them is that a clock icon means "no proof of
 * acceptance" and nothing else.
 */
enum class DeliveryState {
    Queued,
    Sending,
    Accepted,
    Delivered,
    Read,
    Failed;

    companion object {
        private val BY_ORDINAL = entries.toTypedArray()

        /** Unknown ordinals come from a newer build's rows after a downgrade;
         *  they read back as [Queued] rather than crashing the conversation. */
        fun of(ordinal: Int): DeliveryState = BY_ORDINAL.getOrElse(ordinal) { Queued }
    }
}

/** Why a pending operation stopped, deciding whether a retry is even sane.
 *  Ordinals stored, frozen by contract §2. */
enum class ErrorKind {
    None,
    Retryable,
    Permanent,
    Unsupported;

    companion object {
        private val BY_ORDINAL = entries.toTypedArray()

        fun of(ordinal: Int): ErrorKind = BY_ORDINAL.getOrElse(ordinal) { None }
    }
}

/** `kind` values for [PendingOperationEntity], contract §2. */
object OperationKind {
    const val MESSAGE = "message"
    const val EDIT = "edit"
    const val DELETE = "delete"
    const val REACT = "react"
    const val READ = "read"
}

/** `kind` values for [MessageEntity]: what the bubble is made of. */
object MessageKind {
    const val TEXT = "text"
    const val IMAGE = "image"
    const val VOICE = "voice"
    /** A finished call, logged locally by `CallController` — never sent to
     *  or received from the server (`call-*` frames are never queued or
     *  journalled, see `src/cloud/hub.js`), so this row only ever comes from
     *  `ChatRepository.recordCall` on this device. */
    const val CALL = "call"
}

/** [MessageEntity.callOutcome] values for a `kind == MessageKind.CALL` row —
 *  what this device itself saw happen to the call, already direction-aware
 *  (a call this device placed and a call it received use different labels
 *  for the same [net.tailchat.android.call.CallEndReason]; see
 *  `CloudMapping.kt`'s `CallLogEntry.outcome()`, the one place that decides
 *  which of these a finished call maps to). Plain strings, not an ordinal
 *  enum, the same choice already made for [MessageKind]: this is a tag the
 *  UI switches on, not a value SQL ever computes with. */
object CallOutcome {
    /** Reached [net.tailchat.android.call.CallState.Active] at least once —
     *  [MessageEntity.callDurationSec] is the connected time. */
    const val ANSWERED = "answered"
    /** Incoming, never answered by this device (declined implicitly by
     *  letting it ring out, or by a bare hangup instead of decline). */
    const val MISSED = "missed"
    /** This device (incoming) or the peer (outgoing) explicitly declined. */
    const val DECLINED = "declined"
    /** Outgoing, hung up by this device before the peer answered. */
    const val CANCELED = "canceled"
    /** Outgoing, the peer was already on another call. */
    const val BUSY = "busy"
    /** Outgoing, nobody answered before the ring timeout. */
    const val TIMEOUT = "timeout"
    const val FAILED = "failed"
    const val UNSUPPORTED = "unsupported"
    /** Incoming, answered on another of this account's own devices first
     *  (`call-taken`). */
    const val ANSWERED_ELSEWHERE = "answered_elsewhere"
}

/**
 * One authenticated identity on one server.
 *
 * [accountKey] is `"<normalised server origin>|<login>"`. Nothing in this
 * database is keyed by login alone: the same `alice` on two servers is two
 * people, and a row that cannot tell them apart is a conversation shown to the
 * wrong account. Tokens stay in the session store — copying them into every
 * row would multiply the number of places a leak can happen.
 */
@Entity(tableName = "accounts")
data class AccountEntity(
    @PrimaryKey val accountKey: String,
    val server: String,
    val login: String,
    val name: String,
)

/**
 * A conversation as the list screen needs it, without touching `messages`.
 *
 * [historySeeded] is false until `/api/history` has actually answered once for
 * this peer, which is how the UI can say "not loaded yet" instead of showing an
 * empty transcript that looks like a deleted one.
 */
@Entity(
    tableName = "conversations",
    primaryKeys = ["accountKey", "peer"],
    indices = [Index(value = ["accountKey", "previewTs"])],
)
data class ConversationEntity(
    val accountKey: String,
    val peer: String,
    val name: String,
    val self: Boolean,
    val previewFrom: String?,
    val previewText: String?,
    val previewMedia: String?,
    val previewTs: Long,
    val unread: Int,
    val readWatermarkTs: Long,
    val peerReadTs: Long,
    val online: Boolean,
    val lastSeen: Long?,
    val historySeeded: Boolean,
    val updatedAt: Long,
    /** The deployment's own service/AI account (`official` in the server's
     *  roster entry) — added in schema version 2, `MIGRATION_1_2`. */
    val official: Boolean = false,
    /** This account has blocked [peer] (`blocked` in the server's roster
     *  entry) — added in schema version 5, `MIGRATION_4_5`. Persisted so the
     *  roster row still shows the blocked state on a cold start, before the
     *  next roster envelope arrives. */
    val blocked: Boolean = false,
    /** A program rather than a person (`bot` in the server's roster entry,
     *  learned from the bot's own `hello` — `markBot` in `src/cloud/accounts.js`).
     *  Persisted for the same reason `blocked` and `alias` are: the roster
     *  counts who is around from this table, and a cold start must not count a
     *  daemon as a person before the next roster envelope arrives. Added in
     *  schema version 10, `MIGRATION_9_10`. */
    val bot: Boolean = false,
    /** This account's own nickname for [peer] — the server roster's `alias`
     *  (issue #28), carried on the conversation row so the roster shows it on
     *  a cold start, before the next roster envelope arrives. `NULL` for a
     *  contact this account has not nicknamed. Added in schema version 9,
     *  `MIGRATION_8_9`. */
    val alias: String? = null,
    /** Message ids the account feed named that this device does not hold, as a
     *  JSON array of strings, or null when there are none.
     *
     *  An obligation, not a hint: the feed says *that* a message exists and
     *  never *what* it says, so between the event and the page arriving this
     *  list is the only record that anything is missing. It is written in the
     *  same transaction as the cursor that covered the event — a crash after
     *  the cursor and before the fetch must leave the debt, not forget it — and
     *  cleared only once the id is actually in `messages`, so a failed or
     *  interrupted backfill simply retries. Added in schema version 8,
     *  `MIGRATION_7_8`. */
    val backfillJson: String? = null,
    /** When the peer reached [peerReadTs], as the server's `readAt`. Kept
     *  beside the watermark because the message menu's «Прочитано: …» line
     *  needs the moment and a `MAX(peerReadTs)` alone cannot recover it — the
     *  timestamp a receipt named is the message's, not the reading's. `0` for
     *  every snapshot written before this existed, which that line must render
     *  as no detail at all rather than as the epoch. Added in schema version
     *  11, `MIGRATION_10_11`. */
    val peerReadAt: Long = 0,
    /** Which client last moved [peerReadTs] — the server's `clientKind`, one
     *  of `web`, `cli`, `android/<build>`. Empty when the snapshot predates
     *  it or the advance was never labelled, and the menu then shows the time
     *  alone, never a guessed client. Added in schema version 11,
     *  `MIGRATION_10_11`. */
    val peerReadVia: String = "",
    /** How far the peer's *device* holds this conversation — the server's
     *  `deliveries[reader][key]`, mirrored one-for-one from [peerReadTs].
     *  It is the rung below the read watermark: `markOwnDeliveredUpTo` raises
     *  this account's own rows up to it, so a message the peer's phone has but
     *  has not yet opened can draw ✓✓ instead of one ✓ without pretending the
     *  peer has read it. `0` when unknown — an older server, or a peer whose
     *  client never sends an `ack` — and it must never be read as "nothing
     *  delivered", only as "not known here", because anything at or below
     *  [peerReadTs] is delivered by definition. Added in schema version 12,
     *  `MIGRATION_11_12`. */
    val peerDeliveredTs: Long = 0,
)

/**
 * One message, identified by `(accountKey, peer, id)` — the client-generated id
 * is only unique inside a conversation on one account, and the composite key is
 * what stops two servers' `msg-1` from being the same row.
 */
@Entity(
    tableName = "messages",
    primaryKeys = ["accountKey", "peer", "id"],
    indices = [Index(value = ["accountKey", "peer", "ts"])],
)
data class MessageEntity(
    val accountKey: String,
    val peer: String,
    val id: String,
    val text: String,
    val ts: Long,
    val author: String,
    val mine: Boolean,
    /** [DeliveryState] ordinal; see the enum for why it is stored as an Int. */
    val delivery: Int,
    val system: Boolean,
    val kind: String,
    val imageDataUrl: String?,
    val imageWidth: Int?,
    val imageHeight: Int?,
    val voiceDataUrl: String?,
    val voiceDurationSec: Int?,
    val reactionsJson: String?,
    val replyJson: String?,
    val forwardJson: String?,
    val editedAt: Long?,
    val deletedAt: Long?,
    val serverSeq: Long?,
    /** Non-null only for `kind == MessageKind.CALL` — one of [CallOutcome].
     *  Direction is not a separate column: `mine` already says whether this
     *  device placed the call (`true`) or received it (`false`). Added in
     *  schema v6, `TailchatDatabase.MIGRATION_5_6`. */
    val callOutcome: String? = null,
    /** Seconds the call was actually connected; 0 unless [callOutcome] is
     *  [CallOutcome.ANSWERED]. Added in schema v6. */
    val callDurationSec: Int? = null,
    /** Serialized inline buttons for bot messages; added in schema v7, [TailchatDatabase.MIGRATION_6_7]. */
    val buttonsJson: String? = null,
) {
    val deliveryState: DeliveryState get() = DeliveryState.of(delivery)
}

/**
 * Something the user asked for that the server has not confirmed yet.
 *
 * [opId] is stable across every retry: a resend that invents a new id is a
 * duplicate waiting for the first ack to arrive late. [leaseOwner]/[leaseUntil]
 * exist so a process death mid-send leaves a row that another sender can pick
 * up once the lease expires, instead of a row nobody owns or two senders
 * writing the same frame.
 */
@Entity(
    tableName = "pending_ops",
    indices = [Index(value = ["accountKey", "nextAttemptAt"]), Index(value = ["accountKey", "peer"])],
)
data class PendingOperationEntity(
    @PrimaryKey val opId: String,
    val accountKey: String,
    val peer: String,
    val kind: String,
    val messageId: String?,
    val payloadJson: String,
    val attempts: Int,
    val nextAttemptAt: Long,
    val lastError: String?,
    /** [ErrorKind] ordinal. */
    val errorKind: Int,
    val leaseOwner: String?,
    val leaseUntil: Long,
    val createdAt: Long,
)

/** Unsent typing, kept per conversation so switching peers cannot lose it. */
@Entity(tableName = "drafts", primaryKeys = ["accountKey", "peer"])
data class DraftEntity(
    val accountKey: String,
    val peer: String,
    val text: String,
    val replyJson: String?,
    val editingId: String?,
    val updatedAt: Long,
)

/**
 * How far the account-level sync log has been applied, and whether the pre-Room
 * files were ever imported. Both live in one row because both are answers to
 * "what does this device already know", and both must move inside the same
 * transaction as the changes they describe.
 */
@Entity(tableName = "sync_state", primaryKeys = ["accountKey"])
data class SyncCheckpointEntity(
    val accountKey: String,
    val cursor: Long,
    val importedLegacy: Boolean,
    val updatedAt: Long,
)

/**
 * Durable decision for one system notification.
 *
 * Message content stays in [MessageEntity]; this row stores identity and the
 * claim lease only. A process dying after claim but before posting can retry
 * once [claimedAt] is stale, while a posted/suppressed row is terminal.
 */
@Entity(
    tableName = "notification_deliveries",
    primaryKeys = ["accountKey", "peer", "messageId"],
    indices = [Index(value = ["accountKey", "status"])],
)
data class NotificationDeliveryEntity(
    val accountKey: String,
    val peer: String,
    val messageId: String,
    val status: Int,
    val claimedAt: Long,
    val updatedAt: Long,
)

object NotificationDeliveryStatus {
    const val PENDING = 0
    const val CLAIMED = 1
    const val POSTED = 2
    const val SUPPRESSED = 3
}

/** The newest incoming row of one conversation — what an `unread` envelope's
 *  preview refers to when no subscription delivered the message itself. */
data class IncomingRef(val id: String, val ts: Long)

/** Projection for the merge path: what the device already believes about a row
 *  the server has just described again. */
data class DeliveryRow(val id: String, val delivery: Int, val deletedAt: Long?, val buttonsJson: String? = null)

/**
 * Small projections used only to repair a row whose media alone is too big
 * for any `SELECT *` to return — see `ChatRepository.repairOversizedRows`.
 * Neither ever names the oversized column: `LENGTH(payloadJson)` /
 * `LENGTH(imageDataUrl)` is computed by SQLite and never materializes the
 * column's actual content into a `CursorWindow`, which is what lets a row too
 * big to `SELECT *` still be found and repaired instead of only ever crashing.
 */
data class PendingOpRef(val peer: String, val messageId: String?)

data class OversizedMediaRow(val peer: String, val id: String, val mine: Boolean)
