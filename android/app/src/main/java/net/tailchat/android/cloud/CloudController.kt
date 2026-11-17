package net.tailchat.android.cloud

import android.content.Context
import android.database.sqlite.SQLiteException
import android.media.MediaRecorder
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.io.IOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import net.tailchat.android.AppPreferences
import net.tailchat.android.R
import net.tailchat.android.Settings
import net.tailchat.android.SoundEffects
import net.tailchat.android.Transfer
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.DraftEntity
import net.tailchat.android.data.ErrorKind
import net.tailchat.android.data.LegacyImporter
import net.tailchat.android.data.MediaCache
import net.tailchat.android.data.PendingOperationEntity
import net.tailchat.android.data.Payloads
import net.tailchat.android.data.TailchatDatabase
import net.tailchat.android.readForSending
import net.tailchat.android.saveToDownloads
import net.tailchat.android.canInstallPackages
import net.tailchat.android.currentVersionCode
import net.tailchat.android.installApk
import net.tailchat.android.verifyDownloadedApk
import net.tailchat.proto.CHUNK_BYTES
import net.tailchat.proto.DEFAULT_MAX_BYTES
import net.tailchat.proto.FileReceiver
import net.tailchat.proto.fileChunkFrame
import net.tailchat.proto.fileDenyFrame
import net.tailchat.proto.fileDoneFrame
import net.tailchat.proto.fileOfferFrame
import net.tailchat.proto.readAtMost
import net.tailchat.proto.safeFileName
import net.tailchat.proto.sha256HexOfExactly
import net.tailchat.proto.str
import okhttp3.OkHttpClient

/** Explicit `:shortcode:`/`:shortcode` emoji substitution — the unconditional half of
 *  `src/emoji.js` (`COLON_EMOJIS`/`replaceColonEmojis`), ported verbatim. The word-level
 *  auto-substitution half (`EMOJI_DICT`/`replaceEmojis`, e.g. bare `good` → 👍) is a
 *  settings-gated term feature (`autoEmoji`) with no toggle surface here yet, so only the
 *  always-on, unambiguous colon syntax is ported. */
private val COLON_EMOJIS = mapOf(
    ":ok" to "👌", ":ok:" to "👌",
    ":good" to "👍", ":good:" to "👍",
    ":bad" to "👎", ":bad:" to "👎",
    ":love" to "💖", ":love:" to "💖",
    ":please" to "🙏", ":please:" to "🙏",
    ":smile" to "😊", ":smile:" to "😊",
    ":cry" to "😢", ":cry:" to "😢",
    ":laugh" to "😂", ":laugh:" to "😂",
    ":yes" to "✔️", ":yes:" to "✔️",
    ":no" to "❌", ":no:" to "❌",
)

private fun replaceColonEmojis(text: String): String = text.split(' ').joinToString(" ") { word ->
    COLON_EMOJIS[word] ?: word
}

interface CloudController {
    val state: StateFlow<CloudState>
    /** Live microphone peak (0..32767), separate from chat state; zero outside a recording. */
    val voiceRecordingAmplitude: StateFlow<Int>

    fun login(server: String, login: String, password: String, extraPassword: String = "")
    fun register(server: String, login: String, name: String, password: String)
    fun connect()
    fun selectPeer(login: String)
    fun closeConversation()

    /**
     * Reveals the previous page of the on-device transcript for the open
     * conversation. It is a widening of the local window, not a request: the
     * rows come from the database, so scrolling back works with no network at
     * all, and the server is only asked when the conversation has never been
     * seeded on this device.
     */
    fun loadOlder()

    /** Forgets cached transcripts on this device. Never touches the outbox: a
     *  message nobody has taken yet is not a cache. */
    fun clearHistoryCache()

    /** A plain message, or — starting with `/` — a terminal-style command.
     *  The local commit runs off the main thread; [onResult] fires once it
     *  settles — true once the row is durably in Room, false when the write
     *  failed — which is the caller's signal to keep the draft rather than
     *  clear it. Calling this never blocks: everything past the initial,
     *  synchronous capture of account/peer/content happens in a coroutine. */
    fun send(text: String, replyTo: CloudReply? = null, onResult: (Boolean) -> Unit = {})
    /** Sends a bot action as an ordinary message and retires that transient set. */
    fun performBotAction(action: CloudBotAction)

    /**
     * A button's `value` — «/friend accept <login>», «/help», «/bug»… — as an
     * ordinary message to the open conversation.
     *
     * It is *not* one of this client's terminal-style commands, whatever it
     * looks like: a bot's value is a command for the server's service account,
     * and only the server can answer it. The web client draws exactly this
     * line (`sendPlainMessage(action.value)` for buttons versus
     * `executeCommand` for what the composer typed); running a button through
     * [send] instead meant the local runner printed «unknown command» and the
     * server never heard the answer.
     */
    fun sendBotValue(value: String)

    /** Toggles [emoji] on the message [id] in the open conversation. */
    fun react(id: String, emoji: String, add: Boolean)

    /** Reports reaction chips actually visible in the foreground transcript. */
    fun readReactions(ids: List<String>)

    /** Rewrites one of this account's own messages, in place, for both sides. */
    fun editMessage(id: String, text: String)

    /** Removes messages: for everyone (own messages only) or just this side.
     *  A list because a selection can be deleted as a whole — «Удалить (3)».
     *  One message is a list of one. */
    fun deleteMessages(ids: List<String>, forEveryone: Boolean)

    /** One per keystroke in the composer: renewed into a typing lease underneath. */
    fun keystroke()

    /** Re-attempts one failed operation under its original id, because a
     *  message whose acceptance is merely unknown must never be re-sent as a
     *  new one. */
    fun retryFailed(opId: String)

    fun setForeground(visible: Boolean)
    fun logout()
    fun clearRecoveryKey()

    /** Creates a one-time invite code, published to [CloudState.inviteCode].
     *  [login] mints the code for that account rather than this one — the
     *  deployment owner's privilege — and a refusal (forbidden, official
     *  contact, no such account) surfaces through [CloudState.failure] the same
     *  way every other failure here does. */
    fun createInvite(login: String? = null)
    fun clearInviteCode()

    /** Redeems a code from [createInvite], publishing the new friend to [CloudState.lastAcceptedFriend]. */
    fun acceptInvite(code: String)
    fun clearLastAcceptedFriend()

    /** Asks the account behind [login] (a `@`-prefixed form is accepted) to
     *  become a contact. The answer arrives where the invite path already puts
     *  it: an accepted request leaves the new contact in
     *  [CloudState.lastAcceptedFriend], one still awaiting its answer sets
     *  [CloudState.friendRequestSent], and a refusal surfaces through
     *  [CloudState.failure] — the same as [acceptInvite]. Suspends for the
     *  round trip so the caller can keep its button disabled until it ends. */
    suspend fun requestFriend(login: String)
    fun clearFriendRequestSent()

    /** Blocks [login]: the server rejects live frames between the two
     *  accounts either direction until [unblockContact] undoes it. Requires
     *  an existing friendship. A failure (not a friend, unreachable server)
     *  surfaces through [CloudState.failure], the same as [acceptInvite]. */
    suspend fun blockContact(login: String)

    /** Undoes [blockContact]. */
    suspend fun unblockContact(login: String)

    /**
     * Deletes [login] together with this account's own side of the
     * conversation: the contact leaves this roster (server-side, so on every
     * device of this account at once), the local copy of the thread is purged
     * and, if it is the open one, closed. One-sided and permanent — the other
     * person keeps the contact and the whole history and is never told. Never
     * offered for an official contact, which the server refuses with
     * `official_contact`. Answers `true` when the deletion went through, so
     * the caller can confirm it; a failure surfaces through
     * [CloudState.failure], the same as [blockContact].
     */
    suspend fun removeContact(login: String): Boolean

    /**
     * Sets this account's own private nickname for [peer] — the server roster's
     * `alias` (issue #28). A server round trip (`POST /api/alias`): [name] is
     * free text, trimmed and sent as typed, and an empty value clears the
     * nickname. The nickname is never disclosed to the peer. On success the
     * returned `alias` is applied to the roster row at once (the server also
     * re-sends the roster); a refusal surfaces through [CloudState.failure].
     */
    fun renameContact(peer: String, name: String)

    /** Sends any file over the live-only `file-offer`/`file-chunk`/`file-done` relay —
     *  requires the peer online right now, same restriction as the P2P client. */
    fun sendFile(uri: Uri)

    /**
     * Sends the picture at [uri] — with [edit]'s rotation and crop applied — inline in a `msg`
     * frame, the way web/cloud/app.js's image sheet does: queued and kept like text.
     *
     * [caption] is the frame's `text`; empty, it becomes the placeholder web writes
     * (`🖼 [Image]`), so every client has something to show and web draws the picture without
     * a bubble. [edit] is applied to the *original* bytes off the main thread, never to a
     * screen-sized preview, so a crop keeps the resolution it really has.
     *
     * Every entry — gallery, camera, file picker, paste, keyboard — shows the editor first and
     * calls this only on "send": cancelling the editor never reaches it, so nothing is queued
     * and no draft is touched.
     */
    fun sendImage(uri: Uri, caption: String, edit: ImageEdit)

    /** Starts capturing a voice note for the open conversation, publishing elapsed
     *  seconds to [CloudState.voiceRecordingElapsedSec]. */
    fun startVoiceRecording()

    /** Stops an in-progress capture. `send = false` discards it. */
    fun stopVoiceRecording(send: Boolean)

    /**
     * Sends to [peer] without that conversation being open — the direct-reply
     * action on a message notification. It is the ordinary send path: the queue
     * is addressed, not subscription-scoped, so nothing has to be borrowed and
     * handed back.
     */
    fun sendTo(peer: String, text: String)

    /** «Переслать»: the messages are said again in [peer]'s conversation,
     *  carrying the name of whoever said them first. A copy, media included.
     *  A list because a whole selection can be forwarded at once; they go out
     *  in the order [ids] holds them, which is conversation order. */
    fun forward(ids: List<String>, peer: String)

    /** The "mark read" action on a message notification: clears the badge and
     *  owes the sender the read receipts collected while away. */
    fun markConversationRead(peer: String)
    /** Automatic transcript reading, bounded to the bubbles it presented and
     *  ignored while the activity is not in the foreground. */
    fun markVisibleMessagesRead(peer: String, ids: List<String>)
    /** Adds a local inbox badge without moving the peer-visible read watermark backwards. */
    fun markConversationUnread(peer: String)
    fun scheduleReplyReminder(peer: String, messageId: String, dueAt: Long)

    /** The persisted composer state for [peer] — text, reply target and an
     *  unfinished edit — so Back, rotation and process death do not lose it. */
    suspend fun draft(peer: String): CloudDraft?
    fun saveDraft(peer: String, draft: CloudDraft)
    /** Clears the draft only if it still holds [sentText]; newer typing wins. */
    fun clearDraft(peer: String, sentText: String?)

    /** Silently re-polls the connected server's `android-version.json` and
     *  publishes a newer build to [CloudState.updateAvailable] — called once
     *  per session start and on every reconnect. Never shows a popup, and a
     *  failed/unreachable check leaves any update already found untouched:
     *  see [checkForUpdateNow] for the settings sheet's explicit variant. */
    fun checkForUpdate()

    /** The settings sheet's manual "check for updates" button: same fetch as
     *  [checkForUpdate], but always resolves to a result the caller can show
     *  a popup for — found, already current, or the check itself failed. */
    suspend fun checkForUpdateNow(): UpdateCheckResult

    /** Downloads [CloudState.updateAvailable]'s APK and hands it to the
     *  system installer, publishing progress to [CloudState.updateDownload].
     *  A no-op if there is nothing to update or a download is already
     *  running; redirects to the "allow installs" settings screen instead of
     *  downloading when that permission is not yet granted. */
    fun downloadUpdate()

    /** Hides [CloudState.updateAvailable] for the rest of this session
     *  without dismissing it as "seen" — the next [checkForUpdate] (a fresh
     *  reconnect, or the settings sheet's manual check) surfaces it again. */
    fun dismissUpdate()

    /**
     * Resolves an image/voice value carried by a [CloudMessage] in
     * [CloudState.messages] back to its real `data:` URL: a message drawn
     * from local storage carries a `media://` reference (see
     * `ChatRepository.resolveMedia`), a value that is already a literal
     * `data:` URL — a message this device just composed, or one just
     * fetched fresh from the server — is returned unchanged. A file read;
     * call it off the main thread.
     */
    fun resolveMedia(ref: String): String?

    /** Link-preview cards for message bubbles. One instance for the controller's lifetime: it
     *  owns the authenticated lookups, the picture fetch and the caches, so no bubble builds
     *  an API or a client of its own. See [LinkPreviewLoader]. */
    val linkPreviews: LinkPreviewLoader

    /** The one live-or-ended call this device knows about — see
     *  `net.tailchat.android.call.CallController`. */
    val callState: StateFlow<net.tailchat.android.call.CallUiState>
    fun placeCall(peer: String)
    fun answerCall()
    fun declineCall()
    fun hangupCall()
    fun setCallMuted(muted: Boolean)
    fun setCallAudioRoute(route: net.tailchat.android.call.AudioRoute)

    /** One stats sample of the live call — see `CallController.sampleMedia`.
     *  Driven by the call screen, which is the only place the result is
     *  shown. */
    fun sampleCallMedia()

    /** Ended/Idle acknowledged by the UI — see `CallTransitions.dismiss`. */
    fun dismissCall()
}

/** What the composer had, durably. */
data class CloudDraft(
    val text: String,
    val replyTo: CloudReply? = null,
    val editingId: String? = null,
)

/**
 * Stamps the live call-capability onto roster rows read back from the database.
 *
 * `callable` is the one roster field Room deliberately does not keep — it is
 * true only while the peer holds a connection that announced the call
 * capability, and a stored copy would ring into a phone that went offline
 * hours ago. It therefore travels on [EphemeralState.Snapshot.callablePeers]
 * and is re-applied here, exactly like `typingPeers`. Without this step the
 * flag parsed off the wire is dropped on the floor and every contact looks
 * uncallable forever.
 */
internal fun List<CloudUser>.withLiveRoster(live: EphemeralState.Snapshot): List<CloudUser> =
    map { it.copy(callable = it.login in live.callablePeers, reactionEvents = live.reactionEvents[it.login].orEmpty()) }

/**
 * One pass of the legacy local-nickname migration (issue #28): drains
 * `Settings.contactAliases` against one complete roster.
 *
 * Per peer:
 *  - **absent from the roster**: the entry is kept and the pass stays
 *    unresolved — there is nothing to compare against and no one to POST for,
 *    and the migration must not finish while a nickname is still owed (the
 *    local map is no longer a display fallback, so an entry left behind with
 *    the flag set would be lost forever). Retried on a later roster.
 *  - the roster entry **already carries a server `alias`**: the server value
 *    wins and the local entry is dropped **without** an API call — a stale
 *    local value can never shadow an authoritative one anyway;
 *  - otherwise the local value is pushed, and the entry is cleared only after
 *    the call returns (a 200; [setAlias] throws otherwise). A refusal leaves the
 *    entry in place.
 *
 * The durable flag is set **only** when the map is empty after the pass.
 * Returns the failure to surface for a value the server will never accept
 * (`invalid_alias`), or null; that value's entry is still kept.
 */
internal suspend fun migrateLegacyAliases(
    settings: Settings,
    users: List<CloudUser>,
    setAlias: suspend (login: String, name: String) -> Unit,
): CloudFailure? {
    val local = settings.contactAliases
    if (local.isEmpty()) {
        settings.contactAliasesMigrated = true
        return null
    }
    val byLogin = users.associateBy { it.login }
    val remaining = local.toMutableMap()
    var invalidAlias: CloudFailure? = null
    for ((login, alias) in local) {
        val user = byLogin[login] ?: continue
        if (!user.alias.isNullOrBlank()) {
            remaining.remove(login)
            continue
        }
        try {
            setAlias(login, alias.trim())
            remaining.remove(login)
        } catch (error: CloudException) {
            // Keep the entry so a later pass retries it; surface the one value
            // the server will never accept rather than looping silently.
            if (error.code == "invalid_alias") invalidAlias = CloudFailure(error.code, error.message)
        }
    }
    settings.contactAliases = remaining
    if (remaining.isEmpty()) settings.contactAliasesMigrated = true
    return invalidAlias
}

@OptIn(ExperimentalCoroutinesApi::class)
class ServiceCloudController(
    context: Context,
    private val notifyUnread: (CloudUnreadNotification) -> Unit = {},
    private val notifyWake: (from: String, name: String) -> Unit = { _, _ -> },
    private val clearUnreadNotifications: (peer: String?) -> Unit = {},
) : CloudController {
    private val appContext = context.applicationContext
    // The explicit type is not style: the handler below reads [ephemeral], and
    // [ephemeral] is built on this scope, so an inferred type here is a cycle
    // the compiler refuses to resolve.
    private val scope: CoroutineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
            // Every launch in this class and in [SyncEngine] lands here: the
            // socket's inbound frames, the outbox pump, the receipt flush, the
            // roster and transcript writes. A `SupervisorJob` keeps one from
            // cancelling its siblings, but an *uncaught* exception still reaches
            // the thread's default handler, which on Android is process death —
            // so a single bad frame or a disk that refused a write took the app
            // with it and looked, from the outside, exactly like the "keeps
            // stopping" crash loop. Losing one frame is recoverable (the next
            // resync re-delivers it); losing the process is not.
            //
            // A store that threw rather than answering `false` is still the one
            // failure worth showing: `ChatRepository` turns its own failures
            // into that answer, so anything reaching here means the local
            // database is not doing what the app assumes, and the queue banner
            // is the honest thing to put in front of the person.
            if (error is SQLiteException) ephemeral.setStoreFailed()
            Log.e(TAG, "cloud work failed", error)
        },
    )
    private val store = CloudSessionStore(appContext)
    /** The durable prefs this controller reads and writes — the background
     *  service flag, the legacy nickname map the one-time migration drains. */
    private val settings = Settings(appContext)
    /** Guards the one-time local-nickname migration (issue #28) against a
     *  `ready` and a `users` frame arriving together and both draining the
     *  same map. */
    private var aliasMigrationRunning = false
    private val client = OkHttpClient.Builder()
        .callTimeout(8, TimeUnit.SECONDS)
        .connectTimeout(8, TimeUnit.SECONDS)
        // Transport-level liveness for the cloud socket, and the reason a
        // phone used to sit on a dead connection until it was restarted.
        // Relying on the server's own 12s ping only works when the socket
        // dies *visibly*: on mobile networks (NAT timeout, Wi-Fi↔cellular
        // handover, carrier middlebox) TCP dies half-open — no FIN, no RST —
        // so the server's ping and its later `terminate()` never arrive, and
        // OkHttp's reader thread blocks on a stream nothing will ever come
        // down again. No `onFailure`, no `onClosed`, `link` stays `Online`,
        // and messages (both directions) stop while the app looks connected:
        // «не обновляются сообщения … и теряет связь с сервером».
        // With a ping interval OkHttp sends its own pings and fails the
        // socket when a pong does not come back inside that window, which is
        // exactly the `onFailure` the reconnect loop already handles.
        .pingInterval(PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
        .build()
    private val api = CloudApi(client)
    private val updateApi = AppUpdateApi(client)
    private val cloudSocket = CloudSocket(
        client,
        dispatch = CloudSocket.mainThread(),
        // The install's own build, for the server's per-build notes
        // (`announceAppBuild`): read once here, at the same place every other
        // piece of app state comes from. An APK update restarts the process,
        // so this cannot go stale.
        appVersion = { net.tailchat.android.currentVersionCode(appContext) },
    )
    /** One frame budget for the whole connection — see [FramePacer]. Shared
     *  by [engine]'s outbox/receipt queue and [sendFile]'s chunk loop below,
     *  so neither can push the connection past the hub's 60-frames/second
     *  close while thinking it is safely within its own slice of it. */
    private val framePacer = FramePacer()
    private val repository = ChatRepository(
        TailchatDatabase.get(appContext),
        MediaCache(MediaCache.rootDir(appContext.filesDir), net.tailchat.android.data.DeviceDataKey.get(appContext)),
    ) { System.currentTimeMillis() }
    private val importer = LegacyImporter(appContext, repository)
    private val ephemeral = EphemeralState(scope)
    private val engine = SyncEngine(
        repository = repository,
        api = api,
        socket = cloudSocket,
        scope = scope,
        ephemeral = ephemeral,
        listener = EngineListener(),
        framePacer = framePacer,
        // The reactive mirror of Settings.offlineCache, not the Settings object
        // itself: the prefetch walk asks this on every pass, and it must not
        // touch SharedPreferences to answer.
        cacheEnabled = { AppPreferences.offlineCache.value },
        // The reactive mirror of Settings.backgroundService, so a dial can tell
        // a wake-only lurk from a real one without touching SharedPreferences
        // (issue #29).
        backgroundServiceEnabled = { AppPreferences.backgroundService.value },
    )

    private val callTurnApi = net.tailchat.android.call.CallTurnApi(client)
    private val callController = net.tailchat.android.call.CallController(
        context = appContext,
        scope = scope,
        sendFrame = { peer, frame -> sendSingleFrame { it.sendCallFrame(peer, frame) } },
        selfLogin = { sessionFlow.value?.user?.login },
        fetchTurnConfig = {
            val session = sessionFlow.value ?: return@CallController null
            runCatching { callTurnApi.fetch(session.server, session.token) }.getOrNull()
        },
        onCallEnded = { entry ->
            val session = sessionFlow.value ?: return@CallController
            val key = accountKeyOf(session)
            scope.launch {
                val stored = repository.recordCall(
                    key,
                    entry.peer,
                    entry.toMessageEntity(key, session.user.name),
                    countUnread = entry.countsAsUnread,
                )
                // §4.5 of the plan: "a missed call = a log row + a normal
                // notification in the existing message channel" — reuses
                // `notifyUnread`/`ChatService.postConversation` exactly as an
                // unread message would, not the separate `calls_` ringing
                // channel. Bypasses `claimNotification`'s dedup on purpose:
                // that gate requires non-blank `MessageEntity.text` (a call
                // row's text is deliberately empty, see `CallLogEntry`'s
                // doc), and a call only ever ends once per device, so there
                // is no redelivery race to dedup against in the first place.
                if (stored && entry.countsAsUnread) {
                    val displayName = displayNameOf(entry.peer) ?: entry.peerName
                    notifyUnread(
                        CloudUnreadNotification(
                            accountKey = key,
                            peer = entry.peer,
                            messageId = "call-${entry.callId}",
                            author = displayName,
                            text = appContext.getString(R.string.call_log_missed),
                            ts = entry.endedAtMs,
                        ),
                    )
                }
            }
        },
        resolveName = { login -> displayNameOf(login) },
        isAppForeground = {
            appForeground || runCatching {
                ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            }.getOrDefault(false)
        },
    )

    /**
     * What this device calls a contact, in the same order every screen
     * resolves it: this account's own nickname for them (the server roster's
     * `alias`, private to this account — issue #28), then the roster name,
     * then nothing. The login is left to the caller, which knows whether it
     * wants the bare login or a placeholder. The call screen and the call
     * notification used the roster name alone, so a contact nicknamed here
     * kept their old name for the whole call while the chat header already
     * showed the new one.
     */
    private fun displayNameOf(login: String): String? =
        mutableState.value.users.firstOrNull { it.login == login }?.displayName()

    private val initialSession = store.load()
    private val sessionFlow = MutableStateFlow(initialSession)
    private val selectedPeerFlow = MutableStateFlow<String?>(null)
    private val windowFlow = MutableStateFlow(HISTORY_WINDOW)
    /** Client-local rows: command output and live file transfers. Neither is a
     *  fact about the conversation — a `/help` listing is true of a moment, and
     *  a `Transfer` cannot outlive the socket — so neither is written to Room,
     *  and both are merged into the transcript on the way out. */
    private val transientRows = MutableStateFlow<Map<String, List<CloudMessage>>>(emptyMap())
    private val botActionsByPeer = MutableStateFlow<Map<String, List<CloudBotAction>>>(emptyMap())
    private val localState = MutableStateFlow(LocalState())

    private data class LocalState(
        val server: String = DEFAULT_CLOUD_SERVER,
        val recoveryKey: String? = null,
        val inviteCode: String? = null,
        val lastAcceptedFriend: CloudUser? = null,
        val friendRequestSent: String? = null,
        val voiceRecordingElapsedSec: Int? = null,
        val authFailure: CloudFailure? = null,
        val authBusy: Boolean = false,
        val updateAvailable: AppUpdateInfo? = null,
        val updateDownload: Transfer? = null,
        /** See [CloudState.extraPasswordRequired]: the account being signed in
         *  has an additional password and the server has asked for it. Held
         *  here rather than in the merged state because it is a property of the
         *  sign-in attempt, which outlives no session. */
        val extraPasswordRequired: Boolean = false,
    )

    private val mutableState = MutableStateFlow(
        CloudState(
            server = initialSession?.server ?: DEFAULT_CLOUD_SERVER,
            session = initialSession,
            link = if (initialSession == null) CloudLink.SignedOut else CloudLink.Offline,
            rosterLoaded = initialSession == null,
        ),
    )
    override val state: StateFlow<CloudState> = mutableState.asStateFlow()
    private val mutableVoiceRecordingAmplitude = MutableStateFlow(0)
    override val voiceRecordingAmplitude: StateFlow<Int> = mutableVoiceRecordingAmplitude.asStateFlow()

    private var authJob: Job? = null
    private val fileReceiver = FileReceiver(File(appContext.cacheDir, "cloud-file-in"))
    private var voiceRecorder: MediaRecorder? = null
    private var voiceFile: File? = null
    private var voiceTickJob: Job? = null
    private var voiceStartedAt = 0L
    private var pendingPing: PendingPing? = null
    private data class PendingPing(val peer: String, val id: String, val startedAt: Long, val timeoutJob: Job)

    @Volatile private var closed = false

    private val connectivityManager =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    // A phone changes network far more often than a desktop: a Wi-Fi/cellular
    // handoff would otherwise wait out whatever the current backoff happens to
    // be. Reacting to "network available" makes reconnection immediate.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch {
                if (sessionFlow.value == null) return@launch
                // A believed-Online link is the case that actually matters
                // here: the socket was bound to the interface that just went
                // away, so it is dead while nothing on this device knows it.
                // Only asking when the link already reads Offline is what let
                // a handover strand the app on a socket that answers nothing.
                if (ephemeral.state.value.link == CloudLink.Offline) engine.reconnectNow()
                else engine.probeLinkNow()
            }
        }

        override fun onLost(network: Network) {
            scope.launch {
                if (sessionFlow.value == null) return@launch
                // Losing the network the socket was on does not surface as a
                // close either; the probe is what turns it into a reconnect.
                if (ephemeral.state.value.link != CloudLink.Offline) engine.probeLinkNow()
            }
        }
    }

    private val commands = CloudCommandRunner(appContext, CommandHost())

    init {
        // Purge any orphan recording scratch files left behind by an abrupt process kill.
        runCatching {
            appContext.cacheDir.listFiles { _, name -> name.startsWith("voice-") && name.endsWith(".m4a") }
                ?.forEach { it.delete() }
        }
        collectRoster()
        // A ring is only answerable while there is a socket to answer over:
        // the `call-answer` has to reach the caller. When the link goes away
        // mid-ring the caller's own cancel can no longer arrive either, so
        // the phone kept ringing for the whole 45-second window — «как будто
        // я продолжаю звонить». Losing the link drops the ring.
        scope.launch {
            state.collect { snapshot ->
                if (snapshot.link == CloudLink.Offline || snapshot.link == CloudLink.SignedOut) {
                    callController.onLinkLost()
                }
            }
        }
        collectTranscript()
        if (initialSession != null) {
            localState.update { it.copy(server = initialSession.server) }
            scope.launch {
                // The old JSON outbox and transcript cache are imported once,
                // before the first connection: an unsent message from the
                // previous build must not be invisible while a new queue runs
                // beside it. The source files are left alone until the import
                // has been proved.
                importer.importOnce(accountKeyOf(initialSession))
                engine.start(initialSession)
                registerPendingFcmToken(initialSession)
                checkForUpdate()
            }
        }
        runCatching { connectivityManager?.registerDefaultNetworkCallback(networkCallback) }
    }

    // ---- state assembly --------------------------------------------------

    /**
     * The roster, the queue depth and the link, straight out of the database
     * and the ephemeral holder.
     *
     * There is deliberately no merge step here. The previous shape had the
     * server's roster, the `unread` envelopes' previews and the local outbox
     * count living in three places that were folded together on every frame,
     * and every one of those folds was a chance for a preview to be wiped by a
     * liveness probe. The database is now the only bookkeeper.
     */
    private fun collectRoster() {
        scope.launch {
            sessionFlow
                .flatMapLatest { session ->
                    if (session == null) flowOf(RosterSnapshot()) else {
                        val key = accountKeyOf(session)
                        combine(
                            repository.conversations(key),
                            repository.pendingCount(key),
                            repository.failedOperations(key),
                            repository.oldestPendingCreatedAt(key),
                        ) { conversations, queued, failed, oldestPendingCreatedAt ->
                            RosterSnapshot(
                                users = conversations.map { it.toUser() },
                                queuedTotal = queued,
                                failed = failed.map { op ->
                                    CloudFailedOperation(
                                        opId = op.opId,
                                        peer = op.peer,
                                        messageId = op.messageId,
                                        reason = op.lastError ?: "unknown",
                                        kind = ErrorKind.of(op.errorKind).name.lowercase(),
                                    )
                                },
                                oldestPendingCreatedAt = oldestPendingCreatedAt,
                            )
                        }
                    }
                }
                .let { roster ->
                    combine(roster, ephemeral.state, localState, sessionFlow, botActionsByPeer) { snapshot, live, local, session, actionsMap ->
                        RosterEmission(snapshot, live, local, session, actionsMap)
                    }
                }
                .collect { (snapshot, live, local, session, actionsMap) ->
                    mutableState.update { current ->
                        current.copy(
                            server = session?.server ?: local.server,
                            session = session,
                            link = when {
                                session == null -> CloudLink.SignedOut
                                local.authBusy -> CloudLink.Connecting
                                else -> live.link
                            },
                            users = snapshot.users.withLiveRoster(live).sortedUsers(),
                            rosterLoaded = true,
                            queuedTotal = snapshot.queuedTotal,
                            failed = snapshot.failed,
                            oldestPendingCreatedAt = snapshot.oldestPendingCreatedAt,
                            typingPeers = live.typingPeers,
                            reminderIds = live.reminderIds,
                            // Straight from the socket's own acknowledgement,
                            // so the composer learns of the subscription when
                            // it happens — see [EphemeralState.Snapshot.subscribedPeer].
                            subscribedPeer = live.subscribedPeer,
                            serverCaps = live.serverCaps,
                            degraded = live.degraded,
                            storeFailed = live.storeFailed,
                            failure = local.authFailure ?: live.failure,
                            recoveryKey = local.recoveryKey,
                            inviteCode = local.inviteCode,
                            lastAcceptedFriend = local.lastAcceptedFriend,
                            friendRequestSent = local.friendRequestSent,
                            voiceRecordingElapsedSec = local.voiceRecordingElapsedSec,
                            updateAvailable = local.updateAvailable,
                            updateDownload = local.updateDownload,
                            extraPasswordRequired = local.extraPasswordRequired,
                            botActions = current.selectedPeer?.let { actionsMap[it] }.orEmpty(),
                        )
                    }
                    // A live call holds the name it resolved when it started;
                    // a rename (or a roster that only just loaded) has to
                    // reach the call screen and the shade too.
                    callController.onRosterChanged()
                }
        }
    }

    private data class RosterEmission(
        val snapshot: RosterSnapshot,
        val live: EphemeralState.Snapshot,
        val local: LocalState,
        val session: CloudSession?,
        val actionsMap: Map<String, List<CloudBotAction>>,
    )

    private data class RosterSnapshot(
        val users: List<CloudUser> = emptyList(),
        val queuedTotal: Int = 0,
        val failed: List<CloudFailedOperation> = emptyList(),
        val oldestPendingCreatedAt: Long? = null,
    )

    /**
     * The open conversation's rows.
     *
     * Opening a conversation is a database query and nothing else: no HTTP
     * round-trip stands between the tap and the transcript, which is what made
     * an offline thread unopenable before. The server pass, when there is one,
     * only adds rows to the same query.
     */
    private fun collectTranscript() {
        scope.launch {
            combine(sessionFlow, selectedPeerFlow, windowFlow) { session, peer, window ->
                Triple(session, peer, window)
            }
                .distinctUntilChanged()
                .flatMapLatest { (session, peer, window) ->
                    if (session == null || peer == null) flowOf(emptyList()) else {
                        repository.messages(accountKeyOf(session), peer, window)
                    }
                }
                .combine(transientRows) { rows, transient ->
                    val peer = selectedPeerFlow.value
                    val extra = if (peer == null) emptyList() else transient[peer].orEmpty()
                    (rows.map { it.toModel() } + extra).sortedBy(CloudMessage::ts)
                }
                .combine(selectedPeerFlow) { rows, peer -> rows to peer }
                .collect { (rows, peer) ->
                    val session = sessionFlow.value
                    val conversation = if (session == null || peer == null) null else {
                        repository.conversation(accountKeyOf(session), peer)
                    }
                    val seeded = if (session == null || peer == null) true else {
                        conversation?.historySeeded ?: false
                    }
                    val queuedHere = if (session == null || peer == null) 0 else {
                        rows.count { it.mine && it.delivery.ordinal <= CloudDelivery.Sending.ordinal }
                    }
                    mutableState.update {
                        it.copy(
                            selectedPeer = peer,
                            messages = rows,
                            peerReadAt = conversation?.peerReadAt ?: 0L,
                            peerReadVia = conversation?.peerReadVia.orEmpty(),
                            queuedHere = queuedHere,
                            // The spinner means "nothing to show yet", not
                            // "waiting for the network": with rows on screen the
                            // thread is readable whatever the link is doing.
                            loadingHistory = peer != null && rows.isEmpty() && !seeded,
                            olderAvailable = rows.size >= windowFlow.value,
                            botActions = peer?.let { p -> botActionsByPeer.value[p] }.orEmpty(),
                        )
                    }
                }
        }
    }
    /**
     * Most recent conversation first, exactly like the web client's
     * `compareUsers`, with anyone still owed a read ahead of everyone else.
     * Presence is on the row itself; it is not what decides where a
     * conversation belongs — sorting by it put the service account's release
     * note below every live contact.
     */
    private fun List<CloudUser>.sortedUsers() = sortedWith(
        compareByDescending<CloudUser> { it.pending > 0 || it.reactionEvents.isNotEmpty() }
            .thenByDescending { it.preview?.ts ?: 0L }
            .thenByDescending { it.online }
            .thenBy { it.name.lowercase() }
            .thenBy { it.login },
    )

    // ---- authentication --------------------------------------------------

    override fun login(server: String, login: String, password: String, extraPassword: String) {
        authenticate(server) { origin ->
            api.login(origin, login.trim().lowercase(), password, extraPassword.ifEmpty { null })
        }
    }

    override fun register(server: String, login: String, name: String, password: String) {
        val cleanLogin = login.trim().lowercase()
        authenticate(server) { origin ->
            api.register(origin, cleanLogin, password, name.trim().ifBlank { cleanLogin })
        }
    }

    private fun authenticate(server: String, request: suspend (String) -> CloudAuthResult) {
        if (closed) return
        val origin = CloudApi.normalizeServerUrl(server)
        if (origin == null) {
            localState.update { it.copy(server = server, authFailure = CloudFailure("invalid_server")) }
            return
        }
        authJob?.cancel()
        engine.forget()
        localState.update {
            it.copy(server = origin, authFailure = null, authBusy = true, recoveryKey = null)
        }
        authJob = scope.launch {
            try {
                val result = request(origin)
                if (closed) return@launch
                store.save(result.session)
                sessionFlow.value = result.session
                localState.update {
                    it.copy(
                        server = result.session.server,
                        recoveryKey = result.recoveryKey,
                        authBusy = false,
                        authFailure = null,
                        // Whatever the last attempt needed, a session now
                        // exists: a later sign-out must start from a plain
                        // login form, not from the previous account's second
                        // field.
                        extraPasswordRequired = false,
                    )
                }
                val key = accountKeyOf(result.session)
                repository.upsertAccount(
                    net.tailchat.android.data.AccountEntity(
                        accountKey = key,
                        server = result.session.server,
                        login = result.session.user.login,
                        name = result.session.user.name,
                    ),
                )
                importer.importOnce(key)
                engine.start(result.session)
                registerPendingFcmToken(result.session)
                checkForUpdate()
            } catch (error: CloudException) {
                localState.update {
                    it.copy(
                        server = origin,
                        authBusy = false,
                        authFailure = CloudFailure(error.code, error.message.takeUnless { m -> m == error.code }),
                        // The server proved the primary password and asked for
                        // the second one. The screen reveals a field for it and
                        // the user submits the same three values again — this is
                        // the normal second step of signing in to a protected
                        // account, not an error to dismiss.
                        extraPasswordRequired = it.extraPasswordRequired || error.code == CloudApi.EXTRA_PASSWORD_REQUIRED,
                    )
                }
            }
        }
    }

    override fun connect() {
        if (closed) return
        val session = sessionFlow.value ?: store.load()
        if (session == null) {
            sessionFlow.value = null
            return
        }
        sessionFlow.value = session
        engine.reconnectNow()
        registerPendingFcmToken(session)
    }

    /** Sends this device's last-known FCM token to the server for the
     *  session that just became active — covers both "token arrived before
     *  login" (fresh install) and "server never heard about a token this
     *  device already has" (reinstall onto an existing session). Best-effort:
     *  a failure here just means `TailchatFirebaseMessagingService.onNewToken`
     *  or the next `connect()` gets another chance. */
    private fun registerPendingFcmToken(session: CloudSession) {
        val token = Settings(appContext).fcmToken ?: return
        scope.launch { runCatching { api.registerFcmToken(session, token) } }
    }

    fun processPush(peer: String, messageId: String, accountScope: String, done: (Boolean) -> Unit) =
        engine.processPush(peer, messageId, accountScope, done)

    fun completeNotification(notification: CloudUnreadNotification, posted: Boolean) {
        scope.launch {
            repository.completeNotification(
                notification.accountKey,
                notification.peer,
                notification.messageId,
                posted,
            )
        }
    }

    // ---- self-update -------------------------------------------------------

    /** Shared by [checkForUpdate] and [checkForUpdateNow] — the server to poll
     *  is [mutableState]'s, not [sessionFlow]'s: it defaults to
     *  [DEFAULT_CLOUD_SERVER] before any sign-in, so the check (a same-origin
     *  static-file fetch, no auth involved) works for a signed-out or
     *  P2P-only install too, not only an active cloud account. */
    private suspend fun refreshUpdateState(manual: Boolean = false): UpdateCheckResult {
        val info = updateApi.fetchLatest(mutableState.value.server) ?: return UpdateCheckResult.Failed
        val publish = updateToPublish(
            latest = info,
            currentCode = currentVersionCode(appContext),
            dismissedCode = settings.dismissedUpdateVersionCode,
            manual = manual,
            currentlyShown = localState.value.updateAvailable,
        )
        localState.update { it.copy(updateAvailable = publish) }
        val newer = info.takeIf { it.versionCode > currentVersionCode(appContext) }
        return newer?.let(UpdateCheckResult::Available) ?: UpdateCheckResult.UpToDate
    }

    override fun checkForUpdate() {
        scope.launch { refreshUpdateState(manual = false) }
    }

    override suspend fun checkForUpdateNow(): UpdateCheckResult = refreshUpdateState(manual = true)

    override fun downloadUpdate() {
        val info = localState.value.updateAvailable ?: return
        if (localState.value.updateDownload is Transfer.Progress) return
        if (!canInstallPackages(appContext)) return
        scope.launch {
            localState.update { it.copy(updateDownload = Transfer.Progress(0, 0)) }
            try {
                val file = updateApi.download(appContext, info) { progress ->
                    localState.update { it.copy(updateDownload = progress) }
                }
                if (!verifyDownloadedApk(appContext, file, info)) {
                    file.delete()
                    localState.update { it.copy(updateDownload = Transfer.Failed("update_mismatch")) }
                    return@launch
                }
                localState.update { it.copy(updateDownload = Transfer.Complete(file.absolutePath)) }
                installApk(appContext, file)
            } catch (error: Exception) {
                localState.update { it.copy(updateDownload = Transfer.Failed(error.message ?: "download_failed")) }
            }
        }
    }

    override fun dismissUpdate() {
        val info = localState.value.updateAvailable
        if (info != null) {
            settings.dismissedUpdateVersionCode = info.versionCode
        }
        localState.update { it.copy(updateAvailable = null) }
    }

    override fun resolveMedia(ref: String): String? = repository.resolveMedia(ref)

    override val linkPreviews: LinkPreviewLoader = LinkPreviewRepository(
        api = api,
        session = { sessionFlow.value },
        images = LinkPreviewImageFetcher(client),
    )

    // ---- voice calls -------------------------------------------------------

    override val callState = callController.state
    override fun placeCall(peer: String) {
        val name = displayNameOf(peer) ?: peer
        callController.placeCall(peer, name)
    }
    override fun answerCall() = callController.answer()
    override fun declineCall() = callController.decline()
    override fun hangupCall() = callController.hangup()
    override fun setCallMuted(muted: Boolean) = callController.setMuted(muted)
    override fun setCallAudioRoute(route: net.tailchat.android.call.AudioRoute) = callController.setAudioRoute(route)
    override fun sampleCallMedia() = callController.sampleMedia()
    override fun dismissCall() = callController.dismiss()

    // ---- conversation ----------------------------------------------------

    override fun selectPeer(login: String) {
        val session = sessionFlow.value ?: return
        if (selectedPeerFlow.value != login) stopVoiceRecording(send = false)
        clearPendingPing()
        windowFlow.value = HISTORY_WINDOW
        selectedPeerFlow.value = login
        mutableState.update { it.copy(botActions = botActionsByPeer.value[login].orEmpty()) }
        engine.setViewInterest(login)
        scope.launch {
            val key = accountKeyOf(session)
            repository.setUnread(key, login, 0)
            // The server is only asked when this device genuinely has a hole:
            // a thread it has never opened, or one a `reset` invalidated.
            if (repository.conversation(key, login)?.historySeeded != true) {
                engine.refreshHistory(login)
            }
        }
        engine.markConversationRead(login)
    }

    override fun closeConversation() {
        stopVoiceRecording(send = false)
        clearPendingPing()
        engine.stopOwnTyping()
        engine.setViewInterest(null)
        selectedPeerFlow.value = null
        windowFlow.value = HISTORY_WINDOW
        mutableState.update {
            it.copy(
                selectedPeer = null,
                subscribedPeer = null,
                messages = emptyList(),
                queuedHere = 0,
                botActions = emptyList(),
            )
        }
    }

    override fun loadOlder() {
        val peer = selectedPeerFlow.value ?: return
        windowFlow.value += HISTORY_WINDOW
        // Widening past what the database holds is the one case worth a
        // request, and only for a conversation the server has more of.
        scope.launch {
            val session = sessionFlow.value ?: return@launch
            if (repository.conversation(accountKeyOf(session), peer)?.historySeeded != true) {
                engine.refreshHistory(peer)
            }
        }
    }

    override fun clearHistoryCache() {
        val session = sessionFlow.value ?: return
        scope.launch { repository.clearTranscripts(accountKeyOf(session)) }
    }

    // ---- sending ---------------------------------------------------------

    override fun send(text: String, replyTo: CloudReply?, onResult: (Boolean) -> Unit) {
        val clean = text.trim()
        if (clean.isEmpty()) { onResult(false); return }
        if (clean.startsWith("/")) {
            commands.run(clean, scope)
            onResult(true)
            return
        }
        // accountKey/peer/content are fixed synchronously inside `enqueue`,
        // before its first suspension point — an account switch or a further
        // keystroke mid-commit can never redirect or overwrite this attempt.
        // `scope` runs on `Dispatchers.Main.immediate`, so this body executes up
        // to that first suspension point synchronously and returns here without
        // ever blocking the caller on the write itself.
        scope.launch {
            val committed = enqueue(replaceColonEmojis(clean), replyTo = replyTo)
            if (committed) {
                // The message itself is the end of typing; leaving the indicator up
                // for its timeout showed the peer «печатает…» under a message that
                // had already arrived.
                engine.stopOwnTyping()
                SoundEffects.sent()
            }
            onResult(committed)
        }
    }

    override fun performBotAction(action: CloudBotAction) {
        val peer = selectedPeerFlow.value ?: return
        botActionsByPeer.update { it - peer }
        mutableState.update { state ->
            if (state.selectedPeer == peer) state.copy(botActions = emptyList()) else state
        }
        sendBotValue(action.value)
    }

    override fun sendBotValue(value: String) {
        val clean = value.trim()
        if (clean.isEmpty()) return
        // Deliberately not [send]: its `/` branch is for what the composer
        // typed, and a bot's value is addressed to the server's service
        // account. Answering an incoming friend request was impossible on the
        // phone while this went through [send] — the request arrives as a
        // message from `{tailchat}` carrying `/friend accept <login>`, which
        // the local runner swallowed as an unknown command.
        scope.launch {
            if (enqueue(clean)) SoundEffects.sent()
        }
    }

    override fun sendTo(peer: String, text: String) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        scope.launch {
            if (enqueue(replaceColonEmojis(clean), target = peer)) SoundEffects.sent()
        }
    }

    override fun forward(ids: List<String>, peer: String) {
        val current = mutableState.value
        val self = current.session?.user ?: return
        // Conversation order, never the order the bubbles were tapped: a
        // selection marked bottom-up still forwards top-down. `messages` is
        // chronological, so reading them back through it *is* that order —
        // the same rule web's `selectedIdsInOrder` enforces (`app.js:9802`).
        val ordered = current.messages.filter { it.id in ids }
        if (ordered.isEmpty()) return
        // One coroutine for the whole list, not one per message: two forwards
        // launched side by side (one `scope.launch` each) would race their
        // `enqueue` timestamps and could land the copies out of order.
        //
        // Off the main thread, because a forwarded photo or voice clip carries
        // its media with it and `enqueue` writes that to the media cache before
        // it commits — up to ten megabytes of base64 on a disk that may be
        // busy, which is an ANR when it happens between the tap and the frame.
        // A forward is fire-and-forget: nothing is waiting on its answer but
        // the sound.
        //
        // `message.image`/`message.voice` may hold a `media://` reference
        // rather than the real bytes — see `CloudImage.dataUrl` — so it has to
        // be resolved here before it becomes a *new* message's payload.
        // Copying the reference string itself would point the forwarded
        // message at the original's cache file forever, which breaks the
        // moment that original is deleted, and would send the literal
        // `media://…` string to the peer over the wire instead of a photo.
        scope.launch(Dispatchers.IO) {
            var sent = false
            for (message in ordered) {
                if (message.system) continue
                if (message.text.isBlank() && message.image == null && message.voice == null) continue
                val origin = message.forwardedFrom ?: CloudForward(
                    login = if (message.mine) self.login else message.peer,
                    name = message.author.ifBlank { if (message.mine) self.login else message.peer },
                )
                val image = message.image?.let { img -> repository.resolveMedia(img.dataUrl)?.let { img.copy(dataUrl = it) } }
                val voice = message.voice?.let { v -> repository.resolveMedia(v.dataUrl)?.let { v.copy(dataUrl = it) } }
                val written = enqueue(
                    text = message.text,
                    image = image,
                    voice = voice,
                    target = peer,
                    forwardedFrom = origin,
                )
                if (written) sent = true
            }
            if (sent) withContext(Dispatchers.Main) { SoundEffects.sent() }
        }
    }

    /**
     * Accepts a message by committing it, and only by committing it.
     *
     * The row, its pending operation and the roster preview go in as one
     * transaction: there is no state in which the transcript shows a message
     * the queue does not own, or the queue owns one the transcript never drew.
     * A failed write returns false, and the caller keeps the draft — the one
     * thing that must never happen is a composer that clears itself on a write
     * that did not land.
     *
     * Suspends for the length of that transaction, on Room's own transaction
     * dispatcher — never the caller's. Every caller drives this from a
     * coroutine (`scope.launch`, already on `Dispatchers.Main.immediate`, or
     * an explicit background dispatcher for a caller like [forward] that also
     * resolves media), so none of them block a thread on the write: the
     * coroutine simply suspends here and resumes once the transaction lands.
     */
    private suspend fun enqueue(
        text: String,
        image: CloudImage? = null,
        voice: CloudVoice? = null,
        target: String? = null,
        replyTo: CloudReply? = null,
        forwardedFrom: CloudForward? = null,
    ): Boolean {
        val session = sessionFlow.value ?: return false
        val peer = target ?: selectedPeerFlow.value ?: return false
        val key = accountKeyOf(session)
        val id = "m-${UUID.randomUUID().toString().replace("-", "").take(24)}"
        val now = System.currentTimeMillis()
        val message = CloudMessage(
            id = id,
            peer = peer,
            text = text,
            ts = now,
            author = session.user.name,
            mine = true,
            delivery = CloudDelivery.Queued,
            image = image,
            voice = voice,
            replyTo = replyTo,
            forwardedFrom = forwardedFrom,
        )
        val op = PendingOperationEntity(
            opId = "msg:$id",
            accountKey = key,
            peer = peer,
            kind = "message",
            messageId = id,
            payloadJson = messageOperationPayload(message),
            attempts = 0,
            nextAttemptAt = now,
            lastError = null,
            errorKind = ErrorKind.None.ordinal,
            leaseOwner = null,
            leaseUntil = 0,
            createdAt = now,
        )
        val committed = runCatching { repository.enqueueMessage(message.toEntity(key), op) }.getOrDefault(false)
        if (!committed) {
            pushSystemNoteFor(peer, appContext.getString(R.string.cloud_error_queue_full))
            return false
        }
        engine.pump()
        CloudOutboxWorker.schedule(appContext)
        return true
    }

    /**
     * One outbound `k:"frame"`, under the connection's shared budget.
     *
     * The `/ping` command and its answer, `/wake`, and a refused file offer are
     * single frames each, which is exactly why they used to bypass
     * [FramePacer]: one frame per manual invocation cannot be a runaway rate.
     * That reasoning missed the half that matters — [EngineListener.onPing] is
     * not a manual invocation, it is a *remote* one. A peer looping `/ping`
     * spent our budget, and the hub closed *our* socket with `rate_limited`;
     * the frames that went through the pacer were fine, and the connection
     * died anyway.
     *
     * Returning `true` means "there is a live connection and this frame is on
     * its way", not "OkHttp accepted it just now": the send happens a paced
     * moment later, so the socket can still refuse it. Callers that need
     * delivery have one already — `/ping` has its own timeout and reports an
     * unanswered ping to the person who sent it.
     */
    private fun sendSingleFrame(block: (CloudSocket.Connection) -> Boolean): Boolean {
        val conn = engine.liveConnection() ?: return false
        scope.launch {
            conn.awaitDrain()
            framePacer.acquire()
            block(conn)
        }
        return true
    }

    override fun readReactions(ids: List<String>) {
        val peer = selectedPeerFlow.value ?: return
        engine.readReactionEvents(peer, ids)
    }

    override fun react(id: String, emoji: String, add: Boolean) {
        val session = sessionFlow.value ?: return
        val peer = selectedPeerFlow.value ?: return
        val self = session.user.login
        val key = accountKeyOf(session)
        val now = System.currentTimeMillis()
        scope.launch {
            repository.applyReaction(key, peer, id, emoji, self, add)
            repository.enqueueOperation(
                PendingOperationEntity(
                    opId = "react:$id:${UUID.randomUUID()}",
                    accountKey = key,
                    peer = peer,
                    kind = "react",
                    messageId = id,
                    payloadJson = Payloads.reactPayload(emoji, add),
                    attempts = 0,
                    nextAttemptAt = now,
                    lastError = null,
                    errorKind = ErrorKind.None.ordinal,
                    leaseOwner = null,
                    leaseUntil = 0,
                    createdAt = now,
                ),
            )
            engine.pump()
            CloudOutboxWorker.schedule(appContext)
        }
    }

    override fun editMessage(id: String, text: String) {
        val session = sessionFlow.value ?: return
        val peer = selectedPeerFlow.value ?: return
        val target = mutableState.value.messages.firstOrNull { it.id == id } ?: return
        if (!target.mine || target.system) return
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val rewritten = if (target.image == null) replaceColonEmojis(trimmed) else trimmed
        val clean = if (target.image != null) imageMessageText(rewritten, appContext.getString(R.string.cloud_image_placeholder)) else rewritten
        if (clean.isEmpty() || clean == target.text) return
        val key = accountKeyOf(session)
        val now = System.currentTimeMillis()
        scope.launch {
            repository.applyEdit(key, peer, id, clean, now)
            repository.enqueueOperation(
                PendingOperationEntity(
                    opId = "edit:$id:${UUID.randomUUID()}",
                    accountKey = key,
                    peer = peer,
                    kind = "edit",
                    messageId = id,
                    payloadJson = Payloads.editPayload(clean),
                    attempts = 0,
                    nextAttemptAt = now,
                    lastError = null,
                    errorKind = ErrorKind.None.ordinal,
                    leaseOwner = null,
                    leaseUntil = 0,
                    createdAt = now,
                ),
            )
            engine.pump()
            CloudOutboxWorker.schedule(appContext)
        }
    }

    /**
     * «Удалить (3)»: the whole selection, under one scope.
     *
     * Every id keeps the exact single-message path — its own queued `delete`
     * operation, so the outbox can retry one without the others and
     * [ChatRepository.cancelOperationsFor] still finds a message that has not
     * gone out yet. That is why this loops rather than widening one frame to
     * carry a list: the queue's unit is a message, and an operation that
     * tombstoned several rows at once could not be retried or cancelled
     * per message. The scope is the caller's decision and reaches each
     * message on the same terms as before — «у всех» only ever applies to a
     * message this account wrote (see [deleteOne]).
     */
    override fun deleteMessages(ids: List<String>, forEveryone: Boolean) {
        val session = sessionFlow.value ?: return
        val peer = selectedPeerFlow.value ?: return
        val key = accountKeyOf(session)
        for (id in ids) deleteOne(key, peer, id, forEveryone)
    }

    private fun deleteOne(key: String, peer: String, id: String, forEveryone: Boolean) {
        val target = mutableState.value.messages.firstOrNull { it.id == id } ?: return
        val now = System.currentTimeMillis()
        // Command output and live file transfers never reached the server, so
        // there is nothing there to ask it to drop.
        if (target.system || target.attachment != null) {
            transientRows.update { rows ->
                rows + (peer to rows[peer].orEmpty().filterNot { it.id == id })
            }
            return
        }
        scope.launch {
            // A message still in the queue must stop being owed, or the next
            // pass would put back what was just deleted.
            repository.cancelOperationsFor(key, id)
            repository.applyDelete(key, peer, listOf(id))
            repository.enqueueOperation(
                PendingOperationEntity(
                    opId = "del:$id:${UUID.randomUUID()}",
                    accountKey = key,
                    peer = peer,
                    kind = "delete",
                    messageId = id,
                    payloadJson = Payloads.deletePayload(if (forEveryone && target.mine) "all" else "self"),
                    attempts = 0,
                    nextAttemptAt = now,
                    lastError = null,
                    errorKind = ErrorKind.None.ordinal,
                    leaseOwner = null,
                    leaseUntil = 0,
                    createdAt = now,
                ),
            )
            engine.pump()
            CloudOutboxWorker.schedule(appContext)
        }
    }

    override fun retryFailed(opId: String) {
        engine.retryFailed(opId)
        CloudOutboxWorker.schedule(appContext)
    }

    override fun keystroke() {
        if (!AppPreferences.cloudTypingIndicator.value) return
        val peer = selectedPeerFlow.value ?: return
        engine.noteKeystroke()
        engine.keystroke(peer)
    }

    override fun markConversationRead(peer: String) = engine.markConversationRead(peer)
    override fun markVisibleMessagesRead(peer: String, ids: List<String>) = engine.markVisibleMessagesRead(peer, ids)
    override fun markConversationUnread(peer: String) {
        sendSingleFrame { it.markConversationUnread(peer) }
    }
    override fun scheduleReplyReminder(peer: String, messageId: String, dueAt: Long) {
        // The mark goes up with the request, exactly as the web client's does
        // (`app.js:9129`): the hub repeats it in its own `reply-reminder-set`,
        // and waiting for that round trip would leave the choice invisible on
        // the bubble that was just answered. With no live socket nothing is
        // sent and nothing is marked.
        if (sendSingleFrame { it.scheduleReplyReminder(peer, messageId, dueAt) }) {
            ephemeral.markReminder(messageId)
        }
    }

    // ---- drafts ----------------------------------------------------------

    override suspend fun draft(peer: String): CloudDraft? {
        val session = sessionFlow.value ?: return null
        val row = repository.draft(accountKeyOf(session), peer) ?: return null
        return CloudDraft(
            text = row.text,
            replyTo = Payloads.parseReply(row.replyJson)?.let { CloudReply(it.id, it.from, it.text, it.media) },
            editingId = row.editingId,
        )
    }

    override fun saveDraft(peer: String, draft: CloudDraft) {
        val session = sessionFlow.value ?: return
        val key = accountKeyOf(session)
        scope.launch {
            repository.saveDraft(
                DraftEntity(
                    accountKey = key,
                    peer = peer,
                    text = draft.text,
                    replyJson = draft.replyTo?.let { Payloads.replyJson(it.id, it.from, it.text, it.media) },
                    editingId = draft.editingId,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    override fun clearDraft(peer: String, sentText: String?) {
        val session = sessionFlow.value ?: return
        val key = accountKeyOf(session)
        scope.launch { repository.clearDraft(key, peer, sentText) }
    }

    // ---- lifecycle -------------------------------------------------------

    private var appForeground = false

    override fun setForeground(visible: Boolean) {
        appForeground = visible
        engine.setForeground(visible)
    }

    override fun logout() {
        stopVoiceRecording(send = false)
        fileReceiver.abortAll()
        authJob?.cancel()
        clearPendingPing()
        val session = sessionFlow.value
        engine.forget()
        store.clear()
        sessionFlow.value = null
        LinkPreviewCache.shared.clear()
        selectedPeerFlow.value = null
        transientRows.value = emptyMap()
        botActionsByPeer.value = emptyMap()
        localState.value = LocalState(server = session?.server ?: DEFAULT_CLOUD_SERVER)
        clearUnreadNotifications(null)
        // The unsent queue is the user's data, not a cache: signing out drops
        // this device's session and its transcripts, and deliberately keeps
        // anything the server has not taken yet.
        session?.let { scope.launch { repository.forgetAccount(accountKeyOf(it), keepPending = true) } }
        val token = Settings(appContext).fcmToken
        if (session != null && token != null) scope.launch { runCatching { api.unregisterFcmToken(session, token) } }
    }

    override fun clearRecoveryKey() {
        localState.update { it.copy(recoveryKey = null) }
    }

    fun standDown() = engine.standDown()

    fun close() {
        if (closed) return
        closed = true
        stopVoiceRecording(send = false)
        fileReceiver.abortAll()
        authJob?.cancel()
        clearPendingPing()
        engine.close()
        runCatching { connectivityManager?.unregisterNetworkCallback(networkCallback) }
        scope.cancel()
        // An idle HTTPS connection still writes TLS close_notify on eviction.
        // Service.onDestroy runs on main; drain this cleanup on the client's
        // own executor, which shutdown lets finish even after our scope ended.
        val executor = client.dispatcher.executorService
        executor.execute { client.connectionPool.evictAll() }
        executor.shutdown()
    }

    // ---- invites ---------------------------------------------------------

    override fun createInvite(login: String?) {
        val session = sessionFlow.value ?: return
        scope.launch {
            try {
                val code = api.createInvite(session, login)
                localState.update { it.copy(inviteCode = code, authFailure = null) }
            } catch (error: CloudException) {
                localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
            }
        }
    }

    override fun clearInviteCode() {
        localState.update { it.copy(inviteCode = null) }
    }

    override fun acceptInvite(code: String) {
        val session = sessionFlow.value ?: return
        val clean = code.trim()
        if (clean.isEmpty()) return
        scope.launch {
            try {
                publishNewFriend(session, api.acceptInvite(session, clean))
            } catch (error: CloudException) {
                localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
            }
        }
    }

    override fun clearLastAcceptedFriend() {
        localState.update { it.copy(lastAcceptedFriend = null) }
    }

    override suspend fun requestFriend(login: String) {
        val session = sessionFlow.value ?: return
        // The `@` is how the name is written and pasted everywhere else; the
        // server drops one itself, and dropping it here too keeps the note the
        // screen shows from printing it twice.
        val clean = login.trim().removePrefix("@").trim()
        if (clean.isEmpty()) return
        try {
            when (val outcome = api.requestFriend(session, clean)) {
                // Already — or now — a contact: that is the very fact a redeemed
                // invite produces, so it reaches the screen the same way instead
                // of through a second channel of its own.
                is CloudApi.FriendRequest.Friends -> publishNewFriend(session, outcome.friend)
                CloudApi.FriendRequest.Requested -> localState.update {
                    it.copy(friendRequestSent = clean, lastAcceptedFriend = null, authFailure = null)
                }
            }
        } catch (error: CloudException) {
            localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
        }
    }

    override fun clearFriendRequestSent() {
        localState.update { it.copy(friendRequestSent = null) }
    }

    /** The roster row and the one-off note a new contact leaves behind,
     *  whichever path produced it: a code redeemed by [acceptInvite] or a
     *  [requestFriend] the server answered with `friends`. The row is written
     *  now rather than waited for, so the contact is on the list before the
     *  broadcast carrying the same fact arrives. */
    private suspend fun publishNewFriend(session: CloudSession, friend: CloudUser) {
        repository.applyRoster(
            accountKeyOf(session),
            listOf(
                ChatRepository.RosterRow(
                    accountKey = accountKeyOf(session),
                    peer = friend.login,
                    name = friend.name,
                    online = friend.online,
                    lastSeen = friend.lastSeen,
                    unread = 0,
                    previewFrom = null,
                    previewText = null,
                    previewMedia = null,
                    previewTs = 0,
                    official = friend.official,
                    bot = friend.bot,
                    alias = friend.alias,
                ),
            ),
        )
        localState.update { it.copy(lastAcceptedFriend = friend, friendRequestSent = null, authFailure = null) }
    }

    override suspend fun blockContact(login: String) {
        val session = sessionFlow.value ?: return
        try {
            api.block(session, login)
            persistBlocked(session, login, blocked = true)
            localState.update { it.copy(authFailure = null) }
        } catch (error: CloudException) {
            localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
        }
    }

    override suspend fun unblockContact(login: String) {
        val session = sessionFlow.value ?: return
        try {
            api.unblock(session, login)
            persistBlocked(session, login, blocked = false)
            localState.update { it.copy(authFailure = null) }
        } catch (error: CloudException) {
            localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
        }
    }

    override suspend fun removeContact(login: String): Boolean {
        val session = sessionFlow.value ?: return false
        return try {
            api.removeContact(session, login)
            // The answer to the call is the server's own statement that this
            // peer is off the roster, so the engine drops it now rather than
            // when the broadcast carrying the same fact arrives — otherwise a
            // sync-feed event in the meantime could re-create the row the purge
            // below removes.
            engine.forgetPeer(login)
            // No roster row is updated to say so: the row itself goes. The
            // server broadcasts the new roster to every device of this account,
            // which is what closes the conversation on the others
            // (`SyncEngine`'s roster check) — that broadcast must not be the
            // only thing standing between this device and a stale thread, so
            // the purge is done here, on the answer of the call itself.
            purgeRemovedContact(accountKeyOf(session), login)
            localState.update { it.copy(authFailure = null) }
            true
        } catch (error: CloudException) {
            localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
            false
        }
    }

    /**
     * The local half of a deleted contact, run both by [removeContact] and by
     * the roster-absence path in [EngineListener] — the two ways this account
     * learns of a deletion, on the device that asked for it and on the others.
     *
     * The open conversation goes first: a transcript whose rows are about to
     * disappear must not keep rendering, and [closeConversation] is also what
     * clears the client-local rows and the transport subscription for it.
     * Then the peer's notifications (held by `ChatService`, not Room) and the
     * durable copy — `ChatRepository.purgeContact` takes the messages, the
     * conversation row, the draft and the outbox rows in one transaction.
     */
    private suspend fun purgeRemovedContact(key: String, peer: String) {
        if (selectedPeerFlow.value == peer) closeConversation()
        transientRows.update { it + (peer to emptyList()) }
        botActionsByPeer.update { it - peer }
        clearUnreadNotifications(peer)
        repository.purgeContact(key, peer)
    }

    /** Applies a block toggle to the persisted roster row, keeping what this
     *  device already knows about [login] (name, presence, `official`)
     *  rather than reconstructing a blank one — [repository.conversations]
     *  is what feeds [mutableState], so this alone is enough for the roster
     *  row to reflect the change; see [acceptInvite] for the same shape. */
    private suspend fun persistBlocked(session: CloudSession, login: String, blocked: Boolean) {
        val known = mutableState.value.users.firstOrNull { it.login == login } ?: CloudUser(login = login, name = login)
        repository.applyRoster(
            accountKeyOf(session),
            listOf(
                ChatRepository.RosterRow(
                    accountKey = accountKeyOf(session),
                    peer = login,
                    name = known.name,
                    online = known.online,
                    lastSeen = known.lastSeen,
                    unread = known.pending,
                    previewFrom = null,
                    previewText = null,
                    previewMedia = null,
                    previewTs = 0,
                    official = known.official,
                    blocked = blocked,
                    bot = known.bot,
                    alias = known.alias,
                ),
            ),
        )
    }

    override fun renameContact(peer: String, name: String) {
        val session = sessionFlow.value ?: return
        // Free text, and only trimmed: the server does the cleaning (NFKC,
        // controls/bidi removed, whitespace collapsed, capped at 32 code
        // points), so anything else here would make the stored nickname differ
        // from what the user typed — and a migrated legacy value has to arrive
        // byte-identical to what the owner saw before.
        val trimmed = name.trim()
        scope.launch {
            try {
                val alias = api.setAlias(session, peer, trimmed)
                // The server re-sends the roster, but applying the answer now
                // makes the header update the moment the sheet closes.
                repository.setAlias(accountKeyOf(session), peer, alias)
                localState.update { it.copy(authFailure = null) }
            } catch (error: CloudException) {
                localState.update { it.copy(authFailure = CloudFailure(error.code, error.message)) }
            }
        }
    }

    // ---- media -----------------------------------------------------------

    /**
     * The one-time move of the legacy local nickname map (issue #28) to the
     * server, run on every complete roster until it is finished. The durable
     * [Settings.contactAliasesMigrated] flag is written only once the local map
     * is empty after a pass — see [migrateLegacyAliases] for the per-peer rule.
     * A peer that is not in the current roster keeps its entry, so the pass
     * stays unresolved and the migration is retried on a later roster.
     */
    private suspend fun migrateContactAliases(session: CloudSession, users: List<CloudUser>) {
        if (aliasMigrationRunning) return
        aliasMigrationRunning = true
        try {
            val invalidAlias = migrateLegacyAliases(settings, users) { login, name ->
                api.setAlias(session, login, name)
            }
            invalidAlias?.let { failure -> localState.update { it.copy(authFailure = failure) } }
        } finally {
            aliasMigrationRunning = false
        }
    }

    override fun sendImage(uri: Uri, caption: String, edit: ImageEdit) {
        val peer = selectedPeerFlow.value ?: return
        val text = imageMessageText(caption, appContext.getString(R.string.cloud_image_placeholder))
        scope.launch(Dispatchers.IO) {
            // Read, decode, crop, rotate and encode: all off the main thread, bounded by what the
            // result needs (see ImageEncoder), and nothing is queued unless all of it succeeded.
            val outcome = ImageEncoder.prepare(appContext.contentResolver, uri, edit)
            withContext(Dispatchers.Main) {
                if (outcome !is ImageOutcome.Ready) {
                    val note = if (outcome == ImageOutcome.Unreadable) R.string.cloud_image_unreadable
                    else R.string.cloud_image_too_big
                    pushSystemNoteFor(peer, appContext.getString(note))
                    return@withContext
                }
                if (enqueue(text, image = outcome.image, target = peer)) SoundEffects.sent()
            }
        }
    }

    /** Sends any file over the live-only relay: unlike [sendImage], the peer must
     *  already be online, since a `file-chunk` frame is never queued for later
     *  delivery (`QUEUEABLE` in `src/cloud/hub.js` — only `msg`/`ai`/`ack`/`read`). */
    override fun sendFile(uri: Uri) {
        val current = mutableState.value
        val peer = selectedPeerFlow.value ?: return
        val self = current.session?.user ?: return
        val conn = engine.liveConnection()
        if (conn == null || !engine.subscribedTo(peer)) {
            pushSystemNoteFor(peer, appContext.getString(R.string.cloud_error_not_subscribed))
            return
        }
        val isSelf = peer == self.login
        val peerOnline = isSelf || current.users.firstOrNull { it.login == peer }?.online == true
        if (!peerOnline) {
            pushSystemNoteFor(peer, appContext.getString(R.string.cloud_file_needs_online))
            return
        }
        scope.launch(Dispatchers.IO) {
            val picked = readForSending(appContext, uri, DEFAULT_MAX_BYTES).getOrElse { error ->
                withContext(Dispatchers.Main) {
                    pushSystemNoteFor(peer, appContext.getString(R.string.cloud_file_read_failed, error.message ?: ""))
                }
                return@launch
            }
            val name = safeFileName(picked.name)
            val id = "f-${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val total = picked.size
            // The offer carries the digest, so the document is read once to hash
            // it and once again to send it. Holding it instead would cost up to
            // DEFAULT_MAX_BYTES of heap.
            val sha256 = try {
                appContext.contentResolver.openInputStream(uri)?.use { sha256HexOfExactly(it, total) }
            } catch (_: IOException) {
                null
            }
            if (sha256 == null) {
                withContext(Dispatchers.Main) {
                    pushSystemNoteFor(peer, appContext.getString(R.string.cloud_file_read_failed, name))
                }
                return@launch
            }
            withContext(Dispatchers.Main) {
                putTransient(
                    peer,
                    CloudMessage(
                        id = "file-out-$id", peer = peer, text = "", ts = System.currentTimeMillis(),
                        author = self.name, mine = true, delivery = CloudDelivery.Read,
                        attachment = CloudAttachment(id, name, total, Transfer.Progress(0, total)),
                    ),
                )
            }
            conn.awaitDrain()
            framePacer.acquire()
            if (!conn.sendFileFrame(peer, fileOfferFrame(id, name, total, sha256))) {
                withContext(Dispatchers.Main) {
                    updateAttachment(id) { Transfer.Failed(appContext.getString(R.string.cloud_error_unreachable)) }
                }
                return@launch
            }
            val source = try {
                appContext.contentResolver.openInputStream(uri)
            } catch (_: IOException) {
                null
            }
            if (source == null) {
                withContext(Dispatchers.Main) {
                    updateAttachment(id) { Transfer.Failed(appContext.getString(R.string.cloud_file_read_failed, name)) }
                }
                return@launch
            }
            // The hub drops a connection outright once it exceeds 60 frames a
            // second, counted across the whole socket, not per feature — see
            // FramePacer. `awaitDrain` is the other half of that guard: it
            // pauses while bytes already accepted have not left, so the frame
            // budget below is spent on frames that actually reached the wire
            // rather than on frames OkHttp is still holding.
            val encoder = Base64.getEncoder()
            val buf = ByteArray(CHUNK_BYTES)
            var sent = 0L
            var seq = 0
            source.use { input ->
                while (sent < total) {
                    conn.awaitDrain()
                    framePacer.acquire()
                    // Never read past the offered size: a document that grew
                    // after the digest pass would put bytes on the wire the
                    // receiver has to reject.
                    val want = minOf(buf.size.toLong(), total - sent).toInt()
                    val read = try {
                        input.readAtMost(buf, want)
                    } catch (_: IOException) {
                        0
                    }
                    if (read <= 0) {
                        withContext(Dispatchers.Main) {
                            updateAttachment(id) { Transfer.Failed(appContext.getString(R.string.cloud_file_read_failed, name)) }
                        }
                        return@launch
                    }
                    val chunk = if (read == buf.size) buf else buf.copyOf(read)
                    if (!conn.sendFileFrame(peer, fileChunkFrame(id, seq++, encoder.encodeToString(chunk)))) {
                        withContext(Dispatchers.Main) {
                            updateAttachment(id) { Transfer.Failed(appContext.getString(R.string.cloud_error_unreachable)) }
                        }
                        return@launch
                    }
                    sent += read
                    val sentSoFar = sent
                    withContext(Dispatchers.Main) { updateAttachment(id) { Transfer.Progress(sentSoFar, total) } }
                }
            }
            framePacer.acquire()
            if (!conn.sendFileFrame(peer, fileDoneFrame(id))) {
                withContext(Dispatchers.Main) {
                    updateAttachment(id) { Transfer.Failed(appContext.getString(R.string.cloud_error_unreachable)) }
                }
                return@launch
            }
            withContext(Dispatchers.Main) {
                updateAttachment(id) { Transfer.Complete(appContext.getString(R.string.cloud_file_sent)) }
            }
        }
    }

    override fun startVoiceRecording() {
        if (voiceRecorder != null) return
        val peer = selectedPeerFlow.value ?: return
        val file = try {
            File.createTempFile("voice-", ".m4a", appContext.cacheDir)
        } catch (_: Exception) {
            pushSystemNoteFor(peer, appContext.getString(R.string.cloud_voice_failed))
            return
        }
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(appContext)
        } else {
            @Suppress("DEPRECATION") MediaRecorder()
        }
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioEncodingBitRate(24_000)
            recorder.setAudioSamplingRate(16_000)
            recorder.setAudioChannels(1)
            recorder.setOutputFile(file.absolutePath)
            // A hard backstop under `VOICE_MAX_SEC`'s own tick-based stop
            // below: the tick job needs the coroutine scope alive and a timer
            // firing every second, neither of which Doze guarantees for a
            // backgrounded recording. This never lets the file grow past the
            // limit even if that loop never runs again; `onInfo` below still
            // performs the same clean stop-and-send the tick job would have.
            recorder.setMaxDuration(VOICE_MAX_SEC * 1000)
            recorder.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                    stopVoiceRecording(send = true)
                }
            }
            recorder.prepare()
            recorder.start()
        } catch (_: Exception) {
            recorder.release()
            file.delete()
            pushSystemNoteFor(peer, appContext.getString(R.string.cloud_voice_failed))
            return
        }
        voiceRecorder = recorder
        voiceFile = file
        voiceStartedAt = SystemClock.elapsedRealtime()
        mutableVoiceRecordingAmplitude.value = 0
        localState.update { it.copy(voiceRecordingElapsedSec = 0) }
        voiceTickJob = scope.launch {
            // MediaRecorder's peak is reset by each read. Keep recorder access on Main
            // with start/stop; only this small flow runs at 20 Hz, not CloudState/Room.
            while (true) {
                delay(50)
                val elapsed = ((SystemClock.elapsedRealtime() - voiceStartedAt) / 1000).toInt()
                if (elapsed >= VOICE_MAX_SEC) {
                    stopVoiceRecording(send = true)
                    break
                }
                mutableVoiceRecordingAmplitude.value = recorder.maxAmplitude
                localState.update {
                    if (it.voiceRecordingElapsedSec == elapsed) it else it.copy(voiceRecordingElapsedSec = elapsed)
                }
            }
        }
    }

    override fun stopVoiceRecording(send: Boolean) {
        val recorder = voiceRecorder ?: return
        val file = voiceFile
        val peer = selectedPeerFlow.value
        val elapsedSec = ((SystemClock.elapsedRealtime() - voiceStartedAt) / 1000).toInt().coerceIn(1, VOICE_MAX_SEC)
        voiceTickJob?.cancel()
        voiceTickJob = null
        voiceRecorder = null
        voiceFile = null
        mutableVoiceRecordingAmplitude.value = 0
        localState.update { it.copy(voiceRecordingElapsedSec = null) }
        val stopped = try {
            recorder.stop()
            true
        } catch (_: Exception) {
            false
        }
        recorder.release()
        if (!send || !stopped || file == null || peer == null) {
            file?.delete()
            return
        }
        scope.launch(Dispatchers.IO) {
            val bytes = runCatching { file.readBytes() }.getOrNull()
            file.delete()
            if (bytes == null) {
                withContext(Dispatchers.Main) {
                    pushSystemNoteFor(peer, appContext.getString(R.string.cloud_voice_failed))
                }
                return@launch
            }
            val dataUrl = "data:audio/mp4;base64," + Base64.getEncoder().encodeToString(bytes)
            if (dataUrl.length > CLOUD_VOICE_MAX_DATA_URL_CHARS) {
                withContext(Dispatchers.Main) {
                    pushSystemNoteFor(peer, appContext.getString(R.string.cloud_file_too_large))
                }
                return@launch
            }
            // Committed here, on IO, not on Main: `enqueue` writes the clip to
            // the media cache before it commits the row, and doing that between
            // the release of the record button and the next frame is an ANR on
            // a clip of any real length. The sound still belongs to the main
            // thread.
            val text = appContext.getString(R.string.cloud_voice_caption)
            val sent = enqueue(text, voice = CloudVoice(dataUrl, elapsedSec), target = peer)
            if (sent) withContext(Dispatchers.Main) { SoundEffects.sent() }
        }
    }
    // ---- transient rows --------------------------------------------------

    private fun putTransient(peer: String, message: CloudMessage) {
        transientRows.update { rows -> rows + (peer to (rows[peer].orEmpty() + message)) }
    }

    private fun pushSystemNoteFor(peer: String?, text: String) {
        val target = peer ?: selectedPeerFlow.value ?: return
        putTransient(
            target,
            CloudMessage(
                id = "note-${UUID.randomUUID()}",
                peer = target,
                text = text,
                ts = System.currentTimeMillis(),
                author = "",
                mine = false,
                delivery = CloudDelivery.Read,
                system = true,
            ),
        )
    }

    private fun updateAttachment(id: String, transform: (Transfer) -> Transfer) {
        transientRows.update { rows ->
            rows.mapValues { (_, messages) ->
                messages.map { message ->
                    val attachment = message.attachment
                    if (attachment?.id != id) message
                    else message.copy(attachment = attachment.copy(transfer = transform(attachment.transfer)))
                }
            }
        }
    }

    private fun clearPendingPing() {
        pendingPing?.timeoutJob?.cancel()
        pendingPing = null
    }

    // ---- engine callbacks ------------------------------------------------

    private inner class EngineListener : SyncEngine.Listener {
        override fun onRoster(users: List<CloudUser>) {
            val session = sessionFlow.value ?: return
            if (settings.contactAliasesMigrated || aliasMigrationRunning) return
            scope.launch { migrateContactAliases(session, users) }
        }

        override fun onCallSignal(from: String, frame: JsonObject) {
            if (from == mutableState.value.session?.user?.login) {
                // A `call-taken` this account addressed to itself, echoed
                // back by the hub to every *other* device (§3.1) — never
                // to the sender, so seeing our own login here can only be
                // that broadcast.
                val callId = frame["callId"]?.jsonPrimitive?.contentOrNull
                if (frame["t"]?.jsonPrimitive?.contentOrNull == "call-taken" && callId != null) {
                    callController.onOwnDeviceTook(callId)
                }
                return
            }
            callController.onSignalReceived(from, frame)
        }

        override fun onUnreadNotification(notification: CloudUnreadNotification) {
            val author = mutableState.value.users
                .firstOrNull { it.login == notification.peer }?.displayName() ?: notification.author
            notifyUnread(notification.copy(author = author))
        }

        override fun onNotificationsCleared(peer: String) {
            clearUnreadNotifications(peer)
        }
        override fun onReplyReminder(reminder: CloudSocket.ReplyReminder) {
            val name = mutableState.value.users.firstOrNull { it.login == reminder.peer }?.displayName() ?: reminder.peer
            pushSystemNoteFor(
                reminder.peer,
                appContext.getString(R.string.cloud_reply_reminder_due, name),
            )
        }

        override fun onWake(from: String) {
            val name = mutableState.value.users.firstOrNull { it.login == from }?.displayName() ?: from
            pushSystemNoteFor(from, appContext.getString(R.string.cloud_cmd_wake_received, name))
            SoundEffects.wake()
            notifyWake(from, name)
        }

        override fun onIncomingMessageForOpenPeer(peer: String, own: Boolean) {
            // A message this device is actually looking at gets no system
            // notification (see the engine's `viewable` rule), so the sound is
            // the only feedback it would otherwise have.
            if (!own && selectedPeerFlow.value == peer) SoundEffects.received()
        }

        override fun onBotActions(peer: String, actions: List<CloudBotAction>) {
            botActionsByPeer.update { map -> if (actions.isEmpty()) map - peer else map + (peer to actions) }
            mutableState.update { state ->
                if (state.selectedPeer == peer) state.copy(botActions = actions) else state
            }
        }

        override fun onContactRemoved(peer: String) {
            // A complete roster that no longer lists the open conversation:
            // this account deleted the contact somewhere — here, or on another
            // device — and the server has no history left for the pair. Same
            // purge [removeContact] runs, minus the API call.
            scope.launch {
                val session = sessionFlow.value ?: return@launch
                purgeRemovedContact(accountKeyOf(session), peer)
            }
        }

        override fun onFileFrame(kind: String, from: String, frame: JsonObject) {
            val id = frame.str("id") ?: return
            when (kind) {
                "file-offer" -> when (val result = fileReceiver.offer(frame)) {
                    is FileReceiver.Offer.Accepted -> {
                        val author = mutableState.value.users.firstOrNull { it.login == from }?.displayName() ?: from
                        putTransient(
                            from,
                            CloudMessage(
                                id = "file-in-$id", peer = from, text = "",
                                ts = System.currentTimeMillis(), author = author, mine = false,
                                delivery = CloudDelivery.Read,
                                attachment = CloudAttachment(id, result.name, result.size, Transfer.Progress(0, result.size)),
                            ),
                        )
                    }
                    is FileReceiver.Offer.Refused ->
                        sendSingleFrame { it.sendFileFrame(from, fileDenyFrame(id, result.reason)) }
                }
                "file-chunk" -> when (val result = fileReceiver.chunk(frame)) {
                    is FileReceiver.Chunk.Progress -> updateAttachment(id) { Transfer.Progress(result.received, result.size) }
                    is FileReceiver.Chunk.Failed -> updateAttachment(id) { Transfer.Failed(result.reason) }
                }
                "file-done" -> when (val result = fileReceiver.done(frame)) {
                    is FileReceiver.Done.Failed -> updateAttachment(id) { Transfer.Failed(result.reason) }
                    is FileReceiver.Done.Complete -> scope.launch(Dispatchers.IO) {
                        // The spool file is verified but app-private, so it is
                        // streamed into shared storage and consumed there.
                        saveToDownloads(appContext, result.name, result.file).fold(
                            onSuccess = { location ->
                                withContext(Dispatchers.Main) { updateAttachment(id) { Transfer.Complete(location) } }
                            },
                            onFailure = { error ->
                                withContext(Dispatchers.Main) {
                                    updateAttachment(id) { Transfer.Failed(error.message ?: "could not save it") }
                                }
                            },
                        )
                    }
                }
                "file-deny" -> updateAttachment(id) { Transfer.Failed(frame.str("reason") ?: "refused") }
            }
        }

        override fun onPing(from: String, id: String) {
            // Answered through the shared budget, deliberately. This frame is
            // not under our control: a peer that loops `/ping` used to be able
            // to push *our* connection over the hub's ceiling and get us
            // closed with `rate_limited` — the cost of somebody else's bug paid
            // by us. One paced frame per ping, and the pacer's own window is
            // what stops the loop from being a burst.
            sendSingleFrame { it.sendPong(from, id, System.currentTimeMillis()) }
        }

        override fun onPong(from: String, id: String) {
            val pending = pendingPing ?: return
            if (pending.peer != from || pending.id != id) return
            pending.timeoutJob.cancel()
            pendingPing = null
            val rtt = SystemClock.elapsedRealtime() - pending.startedAt
            val name = mutableState.value.users.firstOrNull { it.login == from }?.displayName() ?: from
            // A brief popup rather than a transcript line: the same fix web's
            // app.js made (showToast) — a latency readout is not something
            // either side "said", and it used to sit in the chat forever.
            Toast.makeText(
                appContext,
                appContext.getString(R.string.cloud_cmd_ping_result, name, rtt),
                Toast.LENGTH_SHORT,
            ).show()
        }

        override fun onEngineFailure(failure: CloudFailure) {
            // Already published through the ephemeral holder; the sound of a
            // permanently failed message is the only extra signal worth giving.
            if (failure.code == "message_id_conflict") {
                failure.peer?.let { pushSystemNoteFor(it, appContext.getString(R.string.cloud_error_server)) }
            }
        }

        override fun onSessionRejected(failure: CloudFailure) {
            store.clear()
            sessionFlow.value = null
            selectedPeerFlow.value = null
            localState.update { it.copy(authFailure = failure) }
        }

        override fun onSelfUpdated(self: CloudUser) {
            // `onReady` calls this on every successful (re)connect, not only
            // when `self` actually changed — the one signal this controller
            // gets for "the socket just came back up" without a dedicated
            // Listener method for it. checkForUpdate() piggybacks on it so a
            // release published while the app was already running (session
            // surviving for days without a cold start) is still seen on the
            // next network hiccup, not only at the process's first launch —
            // which is what dismissUpdate()'s own doc already promised
            // ("the next checkForUpdate — a fresh reconnect...") but nothing
            // actually triggered before this.
            checkForUpdate()
            val session = sessionFlow.value ?: return
            if (session.user == self) return
            val updated = session.copy(user = self)
            store.save(updated)
            sessionFlow.value = updated
        }
    }

    // ---- commands --------------------------------------------------------

    private inner class CommandHost : CloudCommandRunner.Host {
        override fun selectedPeer(): String? = selectedPeerFlow.value
        override fun session(): CloudSession? = sessionFlow.value
        override fun contacts(): List<CloudUser> = mutableState.value.users
        override fun transcript(): List<CloudMessage> = mutableState.value.messages
        override fun link(): CloudLink = mutableState.value.link
        override fun subscribedToSelected(): Boolean =
            selectedPeerFlow.value?.let(engine::subscribedTo) == true
        override fun queuedTotal(): Int = mutableState.value.queuedTotal
        override fun pushSystemNote(peer: String?, text: String) = pushSystemNoteFor(peer, text)
        override fun sendMessage(text: String) {
            scope.launch {
                if (enqueue(text)) SoundEffects.sent()
            }
        }
        override fun selectPeer(login: String) = this@ServiceCloudController.selectPeer(login)
        override fun renameSelf(name: String) {
            val session = sessionFlow.value ?: return
            val updated = session.copy(user = session.user.copy(name = name))
            store.save(updated)
            sessionFlow.value = updated
        }
        override fun reconnect() = engine.reconnectNow()
        override fun logout() = this@ServiceCloudController.logout()
        override fun clearTranscript() {
            val session = sessionFlow.value ?: return
            val peer = selectedPeerFlow.value ?: return
            transientRows.update { it + (peer to emptyList()) }
            scope.launch { repository.clearTranscript(accountKeyOf(session), peer) }
        }
        override fun sendPing(peer: String, id: String, ts: Long): Boolean =
            sendSingleFrame { it.sendPing(peer, id, ts) }
        override fun sendWake(peer: String): Boolean =
            sendSingleFrame { it.sendWake(peer) }
        override fun notePingSent(peer: String, id: String, startedAt: Long) {
            clearPendingPing()
            val timeoutJob = scope.launch {
                delay(PING_TIMEOUT_MS)
                if (pendingPing?.id != id) return@launch
                pendingPing = null
                val name = mutableState.value.users.firstOrNull { it.login == peer }?.displayName() ?: peer
                Toast.makeText(
                    appContext,
                    appContext.getString(R.string.cloud_cmd_ping_timeout, name),
                    Toast.LENGTH_SHORT,
                ).show()
            }
            pendingPing = PendingPing(peer, id, startedAt, timeoutJob)
        }
        override suspend fun createInvite(session: CloudSession, login: String?): Result<String> =
            runCatching { api.createInvite(session, login) }
        override suspend fun acceptInvite(session: CloudSession, code: String): Result<CloudUser> =
            runCatching { api.acceptInvite(session, code) }
        override fun onInviteCreated(code: String) {
            localState.update { it.copy(inviteCode = code) }
        }
        override fun onFriendAccepted(friend: CloudUser) {
            val session = sessionFlow.value ?: return
            val key = accountKeyOf(session)
            scope.launch {
                repository.applyRoster(
                    key,
                    listOf(
                        ChatRepository.RosterRow(
                            accountKey = key, peer = friend.login, name = friend.name,
                            online = friend.online, lastSeen = friend.lastSeen, unread = 0,
                            previewFrom = null, previewText = null, previewMedia = null, previewTs = 0,
                            official = friend.official,
                            bot = friend.bot,
                            alias = friend.alias,
                        ),
                    ),
                )
            }
        }
        override fun saveTranscript(filename: String, bytes: ByteArray): Result<String> =
            saveToDownloads(appContext, filename, bytes)
    }

    private companion object {
        const val TAG = "TailchatCloud"
        const val PING_TIMEOUT_MS = 5_000L
        /** OkHttp's own WebSocket ping period, and therefore the worst case
         *  for noticing a half-open socket: a pong that does not come back
         *  inside one interval fails the socket. Short enough that a person
         *  waiting for a message does not sit on a dead link for minutes,
         *  long enough not to wake the radio pointlessly (the server pings at
         *  12s anyway, so this adds no meaningful traffic). */
        const val PING_INTERVAL_SECONDS = 20L
        /**
         * How many rows a conversation opens with. Roughly three screens of
         * bubbles: enough that scrolling back is rare, few enough that a thread
         * with photographs in it lays out in one frame. `loadOlder` widens it.
         */
        const val HISTORY_WINDOW = 120
    }
}
