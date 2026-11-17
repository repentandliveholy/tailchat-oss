package net.tailchat.android.cloud


import androidx.compose.runtime.Immutable
import net.tailchat.android.Transfer

const val DEFAULT_CLOUD_SERVER = "https://repentandliveholy.org"

/** Matches web/cloud/app.js and the server's transport clamp
 *  (`src/cloud/accounts.js` normalizeMedia): a ten-minute cap on a single
 *  voice note. */
const val VOICE_MAX_SEC = 600
/** `src/cloud/limits.js`'s `CLOUD_MEDIA_MAX_CHARS`: what the server and the web
 *  client actually allow inline. This used to be a third of it, so a photo the
 *  browser sends happily was refused on the phone — and, once the inbound cap
 *  existed, silently dropped on arrival. */
const val CLOUD_MEDIA_MAX_CHARS = 10 * 1024 * 1024
/** Minus the same 1024-char cushion web/cloud/app.js leaves for the rest of the
 *  `msg` frame around the data URL. */
const val CLOUD_VOICE_MAX_DATA_URL_CHARS = CLOUD_MEDIA_MAX_CHARS - 1024
/** What an *encoder* aims under, with room for the frame's own JSON —
 *  `CLOUD_INLINE_MEDIA_SAFE_CHARS` in web/cloud/app.js. */
const val CLOUD_INLINE_MEDIA_SAFE_CHARS = CLOUD_MEDIA_MAX_CHARS - 8 * 1024

/**
 * Photo encoding, matching web/cloud/app.js: 2560 px on the long side at
 * quality 92. The old 800 px / q75 predates that change and is why a
 * screenshot of text arrived mushy and unreadable on this client while the
 * same screenshot sent from the browser was sharp.
 */
const val IMAGE_MAX_DIM = 2560
const val IMAGE_QUALITY = 92

/** `●`/`○` — the same online/offline status-dot glyphs the terminal client's device
 *  picker uses (`picker.js`'s `MARK`), reused here instead of inventing a new marker. */
fun presenceDot(online: Boolean): String = if (online) "●" else "○"

/**
 * The deployment's announcement-and-menu account — `SERVICE_LOGIN` in
 * `src/cloud/service-account.js`, `OFFICIAL_ACCOUNT_LOGIN` in
 * `web/cloud/app.js`. Both server-side accounts carry `official = true` on the
 * wire, so this is what tells the one that answers *commands* from the
 * assistant: only this one has a menu behind `/help`.
 */
const val SERVICE_ACCOUNT_LOGIN: String = "tailchat"

/**
 * The rows the transcript and the roster are built from are marked
 * `@Immutable` deliberately, not decoratively: [CloudMessage] carries a `Map`
 * of reactions, and Compose treats any `Map` as unstable, so without this every
 * message bubble — and every lambda that captures one — is re-created on every
 * state change the screen sees, including each keystroke's `typing` tick. None
 * of these objects is ever mutated in place; a change is always a `copy`.
 */
@Immutable
data class CloudUser(
    val login: String,
    val name: String,
    /**
     * The *caller's own* nickname for this contact — the server roster's
     * `alias` (issue #28). It is private to this account: the peer is never
     * told, and no other client ever sees it. Where present it wins over
     * [name] everywhere this contact's display name is rendered. `null` (or
     * blank) means this account has not nicknamed the contact.
     */
    val alias: String? = null,
    val online: Boolean = false,
    val lastSeen: Long? = null,
    val pending: Int = 0,
    /** The last thing said in that conversation, for the roster's second line. */
    val preview: CloudPreview? = null,
    /** The deployment's own announcement/AI account (`SERVICE_LOGIN`/`AI_LOGIN`
     *  in `src/cloud/hub.js`) — a real account nobody signs into, always
     *  reachable because it *is* the server. Styled and announced to
     *  accessibility as a service, not a person. */
    val official: Boolean = false,
    /** A program rather than a person: the account's own socket announced
     *  itself as a bot client (server's `bot` flag, `src/cloud/hub.js`'s
     *  `usersFor`, recorded from the `hello` such a client sends). Set only
     *  when true, so an old server simply leaves it `false`. The bottom bar's
     *  «N в сети» counts people, not daemons — an always-connected bot says
     *  nothing about who is around. */
    val bot: Boolean = false,
    /** The signed-in account has blocked this contact (server's roster
     *  `blocked` flag, `src/cloud/hub.js`): live frames between the two —
     *  msg/ai/typing/focus/read/edit/del/react — are rejected either
     *  direction until unblocked. History stays visible; the friendship is
     *  not removed. The reverse (whether this contact blocked the signed-in
     *  account) is never exposed by the server. */
    val blocked: Boolean = false,
    /** A live connection of this contact has declared `call-v1` (server's
     *  roster field of the same name, `src/cloud/hub.js`). `false` for an
     *  old server that never sends it. Android shows the call button only
     *  when this is `true` — calling into it otherwise rings nobody and
     *  times out after 45s for no visible reason. */
    val callable: Boolean = false,
    /** Server-owned unread reaction events; never folded into message unread watermarks. */
    val reactionEvents: List<CloudReactionEvent> = emptyList(),
)

@Immutable
data class CloudReactionEvent(
    val id: String,
    val messageId: String,
    val emoji: String,
    val by: String,
    val ts: Long,

)
/**
 * How this contact is shown, in one place for every screen: this account's
 * own nickname for them ([CloudUser.alias], layered over the account) if one
 * is set, then the account's own [CloudUser.name]. The login is the caller's
 * fallback, not this function's, because a caller that already holds the
 * login knows whether it wants the bare login or a placeholder.
 */
fun CloudUser.displayName(): String =
    alias?.takeIf(String::isNotBlank) ?: name

/**
 * `lastMessage` (`src/cloud/accounts.js:1192`) as the server sends it in every
 * roster entry's `last` — for every client, not only for the browser. Media is
 * named, not carried: a roster line has to say «фото», and a data URL would be
 * megabytes per friend.
 */
@Immutable
data class CloudPreview(
    /** Who said it; the roster prefixes `{вы}` when that is this account. */
    val from: String,
    val text: String,
    val media: String? = null,
    val ts: Long = 0,
    /** Only meaningful when [from] is this account: has the peer read up to
     *  this message? Derived from [net.tailchat.android.data.ConversationEntity.peerReadTs]
     *  in [ConversationEntity.toUser] — the same watermark that drives a
     *  transcript bubble's own ✓✓ (`CloudDelivery.Read`). `false` for a
     *  peer's own message, where it is simply unused. */
    val read: Boolean = false,
    /** Only meaningful when [from] is this account: does the peer's *device*
     *  hold this message, even if their eyes have not reached it? Derived from
     *  [net.tailchat.android.data.ConversationEntity.peerDeliveredTs] in
     *  [ConversationEntity.toUser] — the rung below [read] on the same ladder,
     *  and what lets a delivered-but-unread own message draw ✓✓ in the roster
     *  instead of the single ✓ that only means the server took it. `false` for
     *  a peer's own message, where it is unused. */
    val delivered: Boolean = false,
)

@Immutable
data class CloudSession(
    val server: String,
    val token: String,
    val user: CloudUser,
)

data class CloudAuthResult(
    val session: CloudSession,
    val recoveryKey: String? = null,
)

/**
 * A quote of the message being answered, carried inside the `msg` frame rather
 * than as a live reference — `normalizeReplyTo` in `src/cloud/accounts.js:156`
 * stores exactly this snapshot, because the original can be edited or deleted
 * for one side only and a dangling id would be unresolvable for every reader.
 */
@Immutable
data class CloudReply(
    val id: String,
    val from: String,
    val text: String,
    /** `image`/`voice`/`file` when the quoted message had no text of its own. */
    val media: String? = null,
)

@Immutable
data class CloudForward(val login: String, val name: String)

/**
 * Where one outgoing message actually is, as one value rather than three
 * booleans that could disagree.
 *
 * The ordinals are the same as `net.tailchat.android.data.DeliveryState`'s and
 * are stored on disk, so the order is frozen. `Accepted` means the server
 * committed it to its journal and said so — not that `WebSocket.send()`
 * returned true, and not that the other device has it.
 */
enum class CloudDelivery {
    Queued,
    Sending,
    Accepted,
    Delivered,
    Read,
    Failed,
}

@Immutable
data class CloudMessage(
    val id: String,
    val peer: String,
    val text: String,
    val ts: Long,
    val author: String,
    val mine: Boolean,
    val delivery: CloudDelivery = CloudDelivery.Accepted,
    val system: Boolean = false,
    val attachment: CloudAttachment? = null,
    val image: CloudImage? = null,
    val voice: CloudVoice? = null,
    /** Emoji → the logins that pressed it, the shape `reactHistory`
     *  (`src/cloud/accounts.js:1072`) keeps and `/api/history` returns. */
    val reactions: Map<String, List<String>> = emptyMap(),
    val replyTo: CloudReply? = null,
    /** «Переслано от …»: who said it first. A copy, not a link — the
     *  original may live in a conversation this account cannot open. */
    val forwardedFrom: CloudForward? = null,
    /** Set only for `kind == MessageKind.CALL` — a call this device's own
     *  `CallController` logged locally once it ended, never something the
     *  server sent (see [CloudCall]). */
    val call: CloudCall? = null,
    /** Set once an `edit` frame (or a history record's `editedAt`) rewrote the
     *  text — drawn as `✎` beside the clock, the same marker web uses. */
    val editedAt: Long? = null,
    /** Set once a `del` frame or a history record's `deletedAt` tombstoned
     *  this message — the row survives (its id keeps a stale history page
     *  from resurrecting the content, per `ChatRepository`/`MessageDao.applyDelete`),
     *  but is invisible by default and can render only a content-free marker
     *  when the local setting enables it. */
    val deletedAt: Long? = null,
    /** Persistent inline buttons attached to this message (e.g. from bots). */
    val buttons: List<CloudBotAction> = emptyList(),
)

/** A file offered or received over the live-only `file-offer`/`file-chunk`/`file-done`
 *  relay (`net.tailchat.proto.FileTransfer`) — never queued or kept in server history,
 *  so it only exists for the lifetime of this conversation view, same as the P2P client. */
@Immutable
data class CloudAttachment(
    val id: String,
    val name: String,
    val size: Long,
    val transfer: Transfer,
)

/** Embedded inline in a `msg` frame's `d.image` — same shape web/cloud/app.js's
 *  `compressImage()` produces — so, unlike [CloudAttachment], it is queued and kept in
 *  server history exactly like plain text.
 *
 *  Despite the name, [dataUrl] is a literal `data:` URL only for a message
 *  this device just composed or fetched fresh from the server; a message
 *  read back out of local storage carries `ChatRepository`'s `media://`
 *  reference instead, so that the transcript's whole scroll window is never
 *  held as megabytes of base64 in [CloudState.messages]. Resolve with
 *  `CloudController.resolveMedia` (a file read; call it off the main thread)
 *  before decoding or sending the actual bytes anywhere. */
@Immutable
data class CloudImage(
    val dataUrl: String,
    val width: Int,
    val height: Int,
)

/** Embedded inline in a `msg` frame's `d.voice`, matching web/cloud/app.js's
 *  `sendVoiceMessage()`: persisted and queued the same as text or [CloudImage].
 *  [dataUrl] carries the same `media://`-reference caveat as [CloudImage.dataUrl]. */
@Immutable
data class CloudVoice(
    val dataUrl: String,
    val durationSec: Int,
)

/** A finished call as the compact bubble shows it — direction is not
 *  repeated here, `CloudMessage.mine` already carries it (this device's own
 *  outgoing attempt vs. one it received). [outcome] is one of the
 *  `net.tailchat.android.data.CallOutcome` constants; [durationSec] is only
 *  meaningful once it is `"answered"`. */
@Immutable
data class CloudCall(
    val outcome: String,
    val durationSec: Int,
)

data class CloudUnreadNotification(
    val accountKey: String,
    val peer: String,
    val messageId: String,
    val author: String,
    val text: String,
    val ts: Long,
    /** A reply sent from the notification itself, echoed back into the same
     *  `MessagingStyle` thread so the shade shows it left. */
    val mine: Boolean = false,
)

/**
 * [peer] and [id] are set only for the two error codes the server correlates
 * with one queued message (`store_failed`, `message_id_conflict`). Without them
 * a per-operation state machine has to guess which message failed, and
 * guessing means either a lost message or a duplicate one.
 */
data class CloudFailure(
    val code: String,
    val detail: String? = null,
    val peer: String? = null,
    val id: String? = null,
)

/** A queued operation that stopped trying, and why — so the transcript can
 *  offer one explicit action instead of an eternal clock. */
@Immutable
data class CloudFailedOperation(
    val opId: String,
    val peer: String,
    val messageId: String?,
    val reason: String,
    /** `retryable`/`permanent`/`unsupported`: what the user can actually do. */
    val kind: String,
)

/** `bin/release-android.js`'s published `android-version.json`, fetched by
 *  `AppUpdateApi.fetchLatest` from the connected server — same-origin static
 *  file, not a new API surface, so a self-hosted deployment publishes its own. */
@Immutable
data class AppUpdateInfo(
    val versionCode: Long,
    val versionName: String,
    val url: String,
    /** Lower-case hex SHA-256 of the published APK, checked against the
     *  downloaded bytes before install — null on a deployment that has not
     *  republished with this field yet, in which case [AppUpdateApi.download]
     *  skips the integrity check rather than treating an old server as broken. */
    val sha256: String? = null,
)

/**
 * Decides what update build (if any) should be published to [CloudState.updateAvailable].
 *
 * Rules:
 * 1. An update is only eligible if [latest] has `versionCode > currentCode`.
 * 2. Automatic background/foreground checks ([manual] = false) skip publishing a build
 *    whose `versionCode <= dismissedCode`, preventing a dismissed banner from resurrecting.
 * 3. Manual checks ([manual] = true) always publish any newer build regardless of dismissal.
 * 4. If [latest] is null or not newer, any previously published update matching [latest]'s build is retained.
 */
fun updateToPublish(
    latest: AppUpdateInfo?,
    currentCode: Long,
    dismissedCode: Long,
    manual: Boolean,
    currentlyShown: AppUpdateInfo? = null,
): AppUpdateInfo? {
    val newer = latest?.takeIf { it.versionCode > currentCode }
    val publish = newer?.takeIf { manual || it.versionCode > dismissedCode }
    return publish ?: currentlyShown?.takeIf { cur -> cur.versionCode == newer?.versionCode }
}

/**
 * Outcome of a user-triggered update check ([CloudController.checkForUpdateNow]) —
 * always exactly one of these, so the settings sheet that started it can show a
 * popup either way: a new build, "you're already current", or "the check itself
 * failed" (offline, DNS hiccup, unreachable server). The silent background
 * checks [CloudController.checkForUpdate] runs on connect/reconnect share the
 * same fetch but never surface [Failed] as a dialog, and — critically — never
 * let a transient [Failed] erase an update a previous successful check found.
 */
sealed interface UpdateCheckResult {
    data class Available(val info: AppUpdateInfo) : UpdateCheckResult
    data object UpToDate : UpdateCheckResult
    data object Failed : UpdateCheckResult
}

enum class CloudLink {
    SignedOut,
    Connecting,
    Online,
    Offline,
}

/** A transport-neutral bot action received in `d.t:"actions"`. */
@Immutable
data class CloudBotAction(
    val id: String,
    val label: String,
    val value: String,
)

data class CloudState(
    val server: String = DEFAULT_CLOUD_SERVER,
    val session: CloudSession? = null,
    val link: CloudLink = if (session == null) CloudLink.SignedOut else CloudLink.Offline,
    val users: List<CloudUser> = emptyList(),
    val rosterLoaded: Boolean = false,
    val selectedPeer: String? = null,
    val subscribedPeer: String? = null,
    val messages: List<CloudMessage> = emptyList(),
    /** The open conversation's peer read watermark: when the peer last read it
     *  ([peerReadAt]) and from which client ([peerReadVia], the server's
     *  `web`/`cli`/`android/<build>`). `0`/`''` mean unknown — a snapshot from
     *  before the server tracked them — and the message menu then shows no
     *  client, never a guessed one. Per conversation, not per message: the
     *  client that last moved the watermark is the client that read the run. */
    val peerReadAt: Long = 0,
    val peerReadVia: String = "",
    val loadingHistory: Boolean = false,
    val recoveryKey: String? = null,
    val failure: CloudFailure? = null,
    /** Logins the peer socket said are mid-keystroke, cleared a few seconds
     *  after the last `typing` frame from each one. */
    val typingPeers: Set<String> = emptySet(),
    /** Message ids (server ids, unique across conversations) this account has
     *  a «напомнить ответить» pending on. Straight from [EphemeralState]: the
     *  server re-sends what is pending on every `auth`, so the mark on a
     *  bubble means «a reminder is pending» rather than «one was set at some
     *  point» — it goes away when the reminder comes due. */
    val reminderIds: Set<String> = emptySet(),
    /** Latest transient controls for [selectedPeer]; never persisted to Room. */
    val botActions: List<CloudBotAction> = emptyList(),
    /** A code just created by [net.tailchat.android.cloud.CloudController.createInvite], shown until dismissed. */
    val inviteCode: String? = null,
    /** The friend a redeemed invite code just added, shown once as a toast. */
    val lastAcceptedFriend: CloudUser? = null,
    /** The login a friend request was just sent to, shown until dismissed. The
     *  `friends` outcome has no entry here — it lands in [lastAcceptedFriend],
     *  because a contact that already exists is the same fact a redeemed
     *  invite produces. */
    val friendRequestSent: String? = null,
    /** Seconds elapsed in an in-progress voice-note capture, or null when not recording.
     *  Capped at [net.tailchat.android.cloud.VOICE_MAX_SEC], same as web/cloud/app.js. */
    val voiceRecordingElapsedSec: Int? = null,
    /** Messages accepted from the composer for the open conversation that the
     *  server has not committed yet. */
    val queuedHere: Int = 0,
    /** The same count across every conversation, for the ongoing notification. */
    val queuedTotal: Int = 0,
    /** Operations that have exhausted their retries and now need a decision
     *  from the user, with the reason they stopped. */
    val failed: List<CloudFailedOperation> = emptyList(),
    /** Set when the server cannot honour the durable contract — an old
     *  deployment. The queue is kept; the limitation is shown rather than
     *  hidden behind an optimistic tick. */
    val degraded: String? = null,
    /**
     * The local store refused a durable write — a full disk, in practice. Shown
     * separately from [degraded] because it is not the server's limitation: it
     * is this device's, and the banner that says "server update needed" would be
     * a lie about whose fault it is. Sticky until the process restarts.
     */
    val storeFailed: Boolean = false,
    /** Whether the on-device cache holds messages older than the window on
     *  screen — what the transcript's "earlier messages" control keys off, and
     *  the only way to read further back with no network at all. */
    val olderAvailable: Boolean = false,
    /** A newer Android build than this install, from `AppUpdateApi.fetchLatest`
     *  — null until checked, already current, or dismissed for this session. */
    val updateAvailable: AppUpdateInfo? = null,
    /** In-flight download/install of [updateAvailable]'s APK; null when idle. */
    val updateDownload: Transfer? = null,
    /** Capabilities the connected server announced during the handshake —
     *  empty when offline or when it predates the handshake. Diagnostics-only:
     *  nothing in this client branches its own behaviour on a specific entry
     *  here beyond what [EphemeralState] already gates by [link]. */
    val serverCaps: Set<String> = emptySet(),
    /** `System.currentTimeMillis()` the oldest still-queued operation for this
     *  account was created, or null with an empty queue — the diagnostics
     *  panel's "is the outbox actually stuck" number. */
    val oldestPendingCreatedAt: Long? = null,
    /**
     * The account being signed in has an additional password, and the server
     * has just said so (`extra_password_required`, only ever after the primary
     * password was proven correct). The sign-in screen reveals its second field
     * on this and keeps the first two as they were, because the same
     * credentials have to be submitted again together with the new one.
     *
     * Deliberately not cleared by a failed attempt: the field stays where the
     * user can see and correct it rather than disappearing with the error.
     */
    val extraPasswordRequired: Boolean = false,
) {
    val signedIn: Boolean get() = session != null
    val selectedUser: CloudUser?
        get() = users.firstOrNull { it.login == selectedPeer }
            ?: session?.user?.takeIf { it.login == selectedPeer }
    val peerIsTyping: Boolean get() = selectedPeer != null && selectedPeer in typingPeers
}

class CloudException(
    val code: String,
    message: String? = null,
    cause: Throwable? = null,
) : Exception(message ?: code, cause)
