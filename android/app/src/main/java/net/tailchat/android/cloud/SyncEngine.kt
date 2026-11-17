package net.tailchat.android.cloud

import android.os.SystemClock
import android.util.Log
import java.security.MessageDigest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import net.tailchat.android.data.ChatRepository
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.ErrorKind
import net.tailchat.android.data.MessageEntity
import net.tailchat.android.data.Payloads
import net.tailchat.android.data.PendingOperationEntity
import kotlin.random.Random

/**
 * The single owner of network synchronisation for one account.
 *
 * Everything that used to be spread across the controller lives here: the
 * socket, the reconnect schedule, the liveness probe, the outbox pump and the
 * reconciliation loop. That concentration is the point of the cutover. In the
 * old shape the open conversation decided what could be sent (`flushOutbox`
 * keyed off `subscribedPeer`), a notification reply had to *borrow* the
 * server-side subscription and hand it back, and a queue for a peer nobody had
 * opened could sit untouched for as long as somebody stayed in another thread.
 * None of those are network conditions; they were view conditions leaking into
 * delivery.
 *
 * Three rules this class must never break:
 *  - nothing is announced as accepted on the strength of `WebSocket.send()`
 *    returning true; acceptance is the server's journal-backed
 *    `message-accepted` and nothing else;
 *  - the open conversation gets no privileged access to the queue: peers are
 *    served round-robin, so A cannot hold up Saved or B;
 *  - a durable row is written before a frame is attempted, never after.
 */
class SyncEngine(
    private val repository: ChatRepository,
    private val api: CloudApi,
    private val socket: CloudSocket,
    private val scope: CoroutineScope,
    private val ephemeral: EphemeralState,
    private val listener: Listener,
    private val framePacer: FramePacer,
    /**
     * Whether this device is keeping conversation history at all — the
     * «Conversation cache» setting. With it off the prefetch walk never runs
     * and a request already in flight when it was switched off writes nothing;
     * an interactive open still merges, because with the cache off the
     * transcript the screen reads is still the one in Room.
     */
    private val cacheEnabled: () -> Boolean = { true },
    private val clock: () -> Long = System::currentTimeMillis,
    /**
     * Whether the background service is on — the «фоновая служба» setting. A
     * dial is a *lurk* when the app is not on screen **and** this is false: the
     * socket then exists only because an FCM wake brought the process up, and
     * the hub must count it for neither presence nor callability (issue #29,
     * `lurk-v1`). Injected as the reactive mirror of the setting, exactly like
     * [cacheEnabled], so this class never touches SharedPreferences to answer;
     * the default (off) matches [net.tailchat.android.Settings.backgroundService].
     */
    private val backgroundServiceEnabled: () -> Boolean = { false },
    /**
     * Monotonic milliseconds, for the one thing here that is a *duration*
     * rather than a moment: [earliestConnectAt]. Injectable for the same reason
     * [clock] is — a test has to be able to make time an argument instead of a
     * race, and on the JVM `SystemClock` is the test framework's own virtual
     * clock.
     */
    private val monotonicMs: () -> Long = SystemClock::elapsedRealtime,
    /**
     * How long a `rate_limited` close silences this engine — see
     * [RETRY_RATE_LIMITED_MS] and [earliestConnectAt]. A parameter only so the
     * test can measure the floor without waiting out ten real seconds; nothing
     * in the app passes it.
     */
    private val rateLimitedPauseMs: Long = RETRY_RATE_LIMITED_MS,
    /**
     * How much of the current connection's output OkHttp has not put on the
     * wire yet — [CloudSocket.Connection.queuedBytes] in the app. A parameter
     * for the same reason [clock] is one: the rule it feeds ("a frame that has
     * not left cannot have been acknowledged") is otherwise a race between a
     * real socket's buffers and the test's own timing. Null means "read the
     * live connection".
     */
    private val queuedBytes: (() -> Long)? = null,
) {

    /**
     * The parts of an inbound frame that are not durable state and therefore
     * are not this class's business: notifications, sounds, live file
     * transfers, and the terminal-style `/ping`/`/wake` answers.
     */
    interface Listener {
        fun onUnreadNotification(notification: CloudUnreadNotification) = Unit
        fun onNotificationsCleared(peer: String) = Unit
        fun onWake(from: String) = Unit
        fun onIncomingMessageForOpenPeer(peer: String, own: Boolean) = Unit
        fun onBotActions(peer: String, actions: List<CloudBotAction>) = Unit
        fun onReplyReminder(reminder: CloudSocket.ReplyReminder) = Unit
        fun onFileFrame(kind: String, from: String, frame: JsonObject) = Unit
        /** A `call-*` frame, unparsed — delivered live-or-not exactly like
         *  every other kind here; [net.tailchat.android.call.CallSignaling]
         *  decodes it. Unlike file/message frames this reaches its listener
         *  even while this connection is not the [live] one — a call must be
         *  answerable from whichever conversation the phone happens to have
         *  open (docs/specs/2026-09-15-android-calls-plan.md §2, §4.4). */
        fun onCallSignal(from: String, frame: JsonObject) = Unit
        fun onPing(from: String, id: String) = Unit
        fun onPong(from: String, id: String) = Unit
        /** A named, non-terminal problem worth showing: rate limits, an old
         *  server, a permanently failed operation. */
        fun onEngineFailure(failure: CloudFailure) = Unit
        /** Terminal auth failure: the session is gone and the caller must sign out. */
        fun onSessionRejected(failure: CloudFailure) = Unit
        fun onSelfUpdated(self: CloudUser) = Unit
        /**
         * A complete server roster just arrived (`ready` or a `users` frame),
         * carrying whatever nicknames this account has set (`CloudUser.alias`).
         * Used by the one-time local-nickname migration (issue #28): the raw
         * server list, so the caller can tell a peer with no server nickname
         * from one the frame simply did not mention.
         */
        fun onRoster(users: List<CloudUser>) = Unit
        /** The conversation this device is looking at is not in the roster that
         *  just arrived, which only happens one way: this account deleted the
         *  contact (`/contact/remove`), from this device or another. The server
         *  would keep answering an empty history page for the pair forever, so
         *  there is nothing left to show — the caller closes the conversation
         *  and drops its local copy. */
        fun onContactRemoved(peer: String) = Unit
    }

    private var session: CloudSession? = null
    private var accountKey: String? = null
    private var connection: CloudSocket.Connection? = null

    /** The conversation the UI is looking at. Used for typing scope, for read
     *  receipts and for the transport subscription — never for delivery. */
    @Volatile private var viewInterest: String? = null
    @Volatile private var foreground = false
    @Volatile private var standingDown = false
    @Volatile private var closed = false

    /** Whether the currently live socket was dialled as a *lurk* — a wake-only
     *  connection (see [backgroundServiceEnabled] and `CloudSocket.CAP_LURK`).
     *  Read by [setForeground] so that opening the app re-dials as a present
     *  socket instead of leaving the owner invisible while looking at it. */
    @Volatile private var liveIsLurk = false

    /** The peers the last *complete* server roster listed — `k:"ready"` and
     *  every `k:"users"` frame carry the whole set, so either is a replacement
     *  of it. `null` until one arrives: an unknown roster is not evidence of a
     *  deletion, and neither is a partial or optimistic list, which is why
     *  nothing but those two frames ever writes this. Cleared by [forget],
     *  whose account it describes. See [rosterLists]. */
    @Volatile private var rosterPeers: Set<String>? = null

    private var reconnectJob: Job? = null
    private var stabilityJob: Job? = null
    private var watchdogJob: Job? = null
    private var pumpJob: Job? = null
    private var syncJob: Job? = null
    private var prefetchJob: Job? = null
    private var reactionReadJob: Job? = null
    private val pendingReactionReads = mutableMapOf<String, MutableSet<String>>()
    private val sentReactionReads = mutableMapOf<String, MutableSet<String>>()

    /**
     * Conversations this connection has already been asked for history of.
     * Cleared with the generation (`invalidate`), so a reconnect may try again
     * while two roster updates on the same connection do not fetch the same
     * transcript twice.
     *
     * Only a fetch that *succeeded* is added: a failure is a transcript that is
     * still missing, and the copy that recorded the attempt before making it
     * was the reason a single dropped request left a conversation empty until
     * the next reconnect. What keeps the walk from spinning on a store that
     * keeps failing is [prefetchRetryAt] — the failure is retried, but not
     * immediately.
     */
    private val prefetched = mutableSetOf<String>()

    /** When a failed prefetch of a conversation may be tried again, in
     *  [monotonicMs]. Per connection, like [prefetched]. */
    private val prefetchRetryAt = mutableMapOf<String, Long>()

    /** One feed pass at a time, and at most one more owed — see
     *  `Observer.onSyncAvailable`. */
    private var syncActive = false
    private var syncAgain = false

    private var retryDelay = RETRY_MS

    /**
     * Monotonic wall-clock floor before which no socket may be dialled — set by
     * a `rate_limited` close, honoured by [connect] itself so that no caller
     * (however eager) can bypass it. `elapsedRealtime` rather than the wall
     * clock: this is a duration, and a device whose clock is corrected mid-penalty
     * must not answer either way.
     */
    @Volatile private var earliestConnectAt = 0L
    @Volatile private var lastInboundAt = 0L

    /** Operations written to the wire and waiting for the server's answer,
     *  keyed by message id because that is what `message-accepted` and the
     *  correlated error envelopes carry. */
    private val inFlight = mutableMapOf<String, InFlight>()
    private data class InFlight(
        val opId: String,
        val peer: String,
        val generation: Long,
        val deadline: Long,
        val attempts: Int,
    )

    /** A durable `read` (bulk mark-read) op written to the wire, waiting for
     *  `read-accepted` — only populated when the server declared
     *  `read-ack-v1`; against an older server a mark-read still completes on
     *  a successful write, exactly as before (see [write]). Keyed by opId,
     *  which for a mark-read is the deterministic `read:$key:$peer`, so at
     *  most one entry exists per peer. */
    private val pendingReadAcks = mutableMapOf<String, ReadAckWait>()
    private data class ReadAckWait(
        val opId: String,
        val peer: String,
        val generation: Long,
        val deadline: Long,
        val attempts: Int,
    )

    /** Per-message read receipts (`d.t:'read'`) sent while the server
     *  declared `read-ack-v1`, keyed by message id, awaiting `read-accepted`
     *  before [flushReadReceipts] is allowed to record them as read. No
     *  separate durable row is needed for this: the id simply stays in
     *  Room's `unreadIncoming` set until the ack names it, so a connection
     *  that dies before the ack lands loses only this in-memory map — the
     *  next [flushReads] for this peer (on reconnect and resubscribe, or on
     *  reopening the conversation) re-sends exactly what was never
     *  confirmed. Against an older server this map is never touched and
     *  [drainReceipts] keeps today's throttle-heuristic behaviour. */
    private val pendingMessageReadAcks = mutableMapOf<String, String>()
    /** Edit/reaction/delete operations waiting for `op-accepted`. Kept
     * separate from message acceptance because these mutations have no
     * journal sequence yet; Stage B §3b closes transit loss first, while WAL
     * durability remains the explicitly separate follow-up. */
    private val pendingOperationAcks = mutableMapOf<String, OperationAckWait>()
    private data class OperationAckWait(
        val opId: String,
        val peer: String,
        val kind: String,
        val messageId: String,
        val deadline: Long,
        val attempts: Int,
    )

    /** Shared with [ServiceCloudController]'s file-transfer chunk loop —
     *  see [FramePacer]: the hub's 60-frames/second close is per connection,
     *  not per feature. */

    /**
     * The receipts owed to peers, and the keys already queued.
     *
     * Both are guarded by [receiptLock], and both have to be: the queue is
     * filled from whichever thread an inbound frame arrived on
     * (`queueReceipt` is called straight out of `Observer.onMessage`), while the
     * pump drains it from whichever thread the last suspension resumed on —
     * Room's executor for a database write, OkHttp's for a send. Neither
     * `ArrayDeque` nor a `LinkedHashSet` is thread-safe, and the corruption this
     * produced was invisible until a batch write put a real suspension inside
     * the drain loop: `first()` then read a null out of the deque's backing
     * array and the pump died mid-flush, leaving every later receipt owed
     * forever. Plain `synchronized` — no suspension ever happens while the lock
     * is held.
     */
    private val receiptQueue = ArrayDeque<Receipt>()
    private val queuedReceipts = mutableSetOf<String>()
    private val receiptLock = Any()

    /**
     * Bumped once per `k:"throttle"` the hub sends — see
     * [CloudSocket.Observer.onThrottle]. [drainReceipts] snapshots this
     * before sending a receipt and compares after: a change means the hub
     * may have just dropped exactly that frame, which is the one signal this
     * client gets for a receipt it cannot otherwise tell apart from one that
     * actually landed. `@Volatile`, not the receipt lock: it is read and
     * written from different coroutines with nothing else serialising them.
     */
    @Volatile
    private var throttleEvents: Int = 0

    private data class Receipt(val peer: String, val id: String, val read: Boolean)

    private fun receiptKey(receipt: Receipt): String =
        "${if (receipt.read) "r" else "a"}\u0000${receipt.peer}\u0000${receipt.id}"

    /** Returns false when this receipt is already queued. */
    private fun enqueueReceipt(receipt: Receipt): Boolean = synchronized(receiptLock) {
        if (!queuedReceipts.add(receiptKey(receipt))) return false
        receiptQueue.addLast(receipt)
        true
    }

    private fun peekReceipt(): Receipt? = synchronized(receiptLock) { receiptQueue.firstOrNull() }

    /** The head, which only the pump ever removes. The key stays in
     *  [queuedReceipts]: one receipt per message per connection is the whole
     *  point of the set, and dropping the key on send is what let two triggers
     *  for the same peer — opening a conversation subscribes *and* the
     *  server's answer re-runs the flush — put the same receipt on the wire
     *  twice. Nothing needs the key back: a second read receipt for one message
     *  is never useful, an ack and a read have different keys, and the
     *  connection's own end clears both. */
    private fun dropReceipt() = synchronized(receiptLock) { receiptQueue.removeFirst() }

    private fun forgetReceipts() = synchronized(receiptLock) {
        receiptQueue.clear()
        queuedReceipts.clear()
    }

    private var typingLeaseJob: Job? = null
    private var typingPeer: String? = null

    // ---- lifecycle -------------------------------------------------------

    fun start(session: CloudSession) {
        if (closed) return
        if (accountKey != null && accountKey != accountKeyOf(session)) {
            pendingReactionReads.clear()
            sentReactionReads.clear()
        }
        this.session = session
        this.accountKey = accountKeyOf(session)
        standingDown = false
        retryDelay = RETRY_MS
        connect(session)
    }

    /** Deliberately offline until something asks again — the background service
     *  being switched off. Reversible, unlike [close]. */
    fun standDown() {
        standingDown = true
        stopOwnTyping()
        invalidate()
        ephemeral.setLink(CloudLink.Offline)
        ephemeral.clearAllTyping()
    }

    fun reconnectNow() {
        val session = session ?: return
        if (closed) return
        reconnectJob?.cancel()
        reconnectJob = null
        standingDown = false
        retryDelay = RETRY_MS
        connect(session)
    }

    /**
     * Ask the server whether this socket is still alive, and reconnect if it
     * is not. For the callers that know something happened to the transport
     * (a network became available, the network the socket was on went away)
     * but see a link that still reads `Online`, which is exactly what a
     * half-open TCP connection looks like from here.
     */
    fun probeLinkNow() {
        val session = session ?: return
        if (closed || standingDown) return
        if (ephemeral.state.value.link != CloudLink.Online) {
            if (ephemeral.state.value.link == CloudLink.Offline) reconnectNow()
            return
        }
        probeNow(session)
    }

    /**
     * Reconciles one data-only FCM wake through the existing engine. HTTP
     * history is owned by this engine just like interactive history; no worker
     * or callback creates another socket/network owner.
     */
    fun processPush(peer: String, messageId: String, accountScope: String, done: (Boolean) -> Unit) {
        scope.launch { done(processPushOnce(peer, messageId, accountScope)) }
    }

    internal suspend fun processPushOnce(peer: String, messageId: String, accountScope: String): Boolean {
        val currentSession = session
        val key = accountKey
        if (closed || currentSession == null || key == null || accountScopeOf(currentSession) != accountScope) {
            return true
        }
        // A wake for a peer the roster no longer lists is a contact this account
        // deleted: there is no page to merge (the server answers the pair
        // with `messages: []` forever) and nothing to alert about, so the wake
        // is as handled as it will ever be — see [rosterLists]. Reported as
        // processed, or WorkManager would retry a fetch that cannot succeed.
        if (!rosterLists(peer)) return true
        val loaded = runCatching {
            loadHistory(key, currentSession, peer, generation = null, prefetch = false)
        }.getOrDefault(false)
        val processed = loaded && runCatching {
            notifyIfEligible(key, peer, messageId, foreground && viewInterest == peer)
        }.isSuccess
        if (!closed && session === currentSession && accountKey == key) reconnectNow()
        return processed
    }

    fun close() {
        closed = true
        stopOwnTyping()
        invalidate()
        abortHistory(all = true)
        session = null
        accountKey = null
    }

    /** Logout: the socket goes, the ephemeral state goes, and the durable rows
     *  are the caller's decision — never this class's. */
    fun forget() {
        invalidate()
        // The account is gone, so its push fetches are too.
        abortHistory(all = true)
        session = null
        accountKey = null
        // The roster this described belonged to the account that just went
        // away; the next one's first complete roster replaces it.
        rosterPeers = null
        standingDown = false
        retryDelay = RETRY_MS
        ephemeral.reset()
        pendingReactionReads.clear()
        sentReactionReads.clear()
    }

    fun setForeground(visible: Boolean) {
        foreground = visible
        if (!visible) return
        pumpReactionReads()
        val session = session ?: return
        viewInterest?.let { flushReads(it) }
        // The user is actually looking at the app now. A lurk socket (woken by
        // a push, background service off) is invisible to everyone's roster, so
        // it is replaced by a present one — otherwise the owner would never
        // appear online while the app is open in front of them (issue #29).
        if (liveIsLurk && !backgroundServiceEnabled()) {
            reconnectNow()
            return
        }
        when (ephemeral.state.value.link) {
            CloudLink.Offline -> if (!standingDown) reconnectNow()
            // A socket that merely *looks* alive after a Doze window is the
            // most common way a message "only arrives when the app is
            // reopened": the carrier dropped the TCP connection while the
            // phone slept and nothing has tried to use it since.
            CloudLink.Online -> probeNow(session)
            else -> Unit
        }
    }

    /**
     * The UI opened (or left) a conversation. This buys typing scope, read
     * receipts and the transport subscription that live-only frames such as
     * file transfers still need — and nothing else. Sending is unaffected.
     *
     * Leaving (`peer == null`) sends an explicit unsubscribe, not just a
     * local state change: without it the hub's own `conn.peer` stayed
     * pointed at whichever conversation was open last ("sticky"), so it kept
     * routing every later message from that peer as delivered-to-an-open-
     * client and silently skipped the unread count for it — a message that
     * arrived while back on the roster looked, to this device, already read.
     */
    fun setViewInterest(peer: String?) {
        if (viewInterest == peer) return
        val previous = viewInterest
        viewInterest = peer
        if (previous != null && previous != peer) {
            stopOwnTyping()
            // The history banner names the conversation it is about; once that one is
            // no longer on screen it would only be a strip over the roster about a
            // thread nobody is looking at.
            ephemeral.clearFailure(CloudFailure(HISTORY_FAILED, peer = previous))
        }
        if (ephemeral.state.value.link != CloudLink.Online) return
        if (peer != null) {
            connection?.subscribe(peer)
            flushReads(peer)
        } else {
            connection?.unsubscribe()
            // The hub drops `conn.peer` on this frame, so the subscription is
            // over the moment it is sent — leaving the field set claimed a
            // viewer of a conversation nobody is looking at any more.
            subscribedPeer = null
        }
        pumpReactionReads()
    }

    fun subscribedTo(peer: String): Boolean = subscribedPeer == peer

    /** Mirrored into [EphemeralState] on every write: the composer's hint is
     *  drawn from that snapshot, and a value only readable through
     *  [subscribedTo] could not tell the UI when the ack finally arrived. */
    private var subscribedPeer: String? = null
        set(value) {
            field = value
            ephemeral.setSubscribed(value)
        }

    /**
     * Whether the last complete roster still lists [peer]; `true` before any
     * roster has been seen, because an unknown roster is not evidence of a
     * deletion.
     *
     * Every writer of conversation rows is gated on this, and the case it
     * exists for is narrow but real. Deleting a contact is one-sided: the
     * server keeps the friendship, answers `messages: []` for that pair
     * forever, and its `sync-v1` feed can still name messages that were
     * written before the deletion. Merging any of those re-creates the
     * conversation the deletion just purged — `ConversationDao.touchPreview`
     * inserts on first sight of a peer, so an empty page is enough to put a
     * thread back on the roster — which is how a deleted contact returned as
     * an empty conversation.
     *
     * This account's own login always counts as listed: Saved Messages is a
     * conversation with no roster entry anywhere (`walkRoster`).
     */
    private fun rosterLists(peer: String): Boolean {
        if (peer == session?.user?.login) return true
        return rosterPeers?.contains(peer) ?: true
    }

    /** The conversation on screen, when the complete roster that just arrived
     *  no longer lists its peer — see [Listener.onContactRemoved]. */
    private fun closeAbsentView() {
        val peer = viewInterest ?: return
        if (rosterLists(peer)) return
        listener.onContactRemoved(peer)
    }

    /**
     * [peer] is out of this account's roster for good: the server answered a
     * deletion this device just made (`/contact/remove`, `CloudApi.removeContact`).
     *
     * The `k:"users"` frame carrying the same fact is a round trip away, and
     * until it arrives [rosterLists] would still let a feed event naming that
     * peer re-create the conversation row the deletion has just purged — the
     * very failure the roster check exists to prevent. Applying it here closes
     * that window; it is idempotent with the frame that follows, and with the
     * one a deletion made on this account's *other* devices produces.
     *
     * A roster this engine has never seen stays unknown rather than becoming
     * empty: "this one peer is gone" is not "nobody is a contact", and [peer]
     * needs no closing here — the caller does that with [setViewInterest].
     */
    fun forgetPeer(peer: String) {
        rosterPeers = rosterPeers?.minus(peer)
    }

    fun liveConnection(): CloudSocket.Connection? =
        if (ephemeral.state.value.link == CloudLink.Online) connection else null

    // ---- connection ------------------------------------------------------

    private fun connect(session: CloudSession) {
        // The floor is checked here, in the one place a socket is actually
        // opened, so it holds for every caller — a foreground return, a
        // network callback, a login — and not only for the backoff timer.
        if (earliestConnectAt - monotonicMs() > 0) {
            scheduleReconnect(session)
            return
        }
        invalidate()
        val generation = ephemeral.newGeneration()
        ephemeral.setLink(CloudLink.Connecting)
        ephemeral.setFailure(null)
        // A wake-only dial is one the app itself did not ask for: the process
        // is up because a push arrived while the app is off screen and the
        // background service is off. Such a socket still gets every frame, but
        // must not make the account look online (issue #29).
        val lurk = !foreground && !backgroundServiceEnabled()
        liveIsLurk = lurk
        connection = try {
            socket.connect(session, Observer(session, generation), lurk = lurk)
        } catch (error: CloudException) {
            ephemeral.setLink(CloudLink.Offline)
            ephemeral.setFailure(CloudFailure(error.code, error.message))
            scheduleReconnect(session)
            null
        }
    }

    private fun invalidate() {
        ephemeral.newGeneration()
        connection?.cancel()
        connection = null
        liveIsLurk = false
        subscribedPeer = null
        inFlight.clear()
        pendingReadAcks.clear()
        pendingMessageReadAcks.clear()
        pendingOperationAcks.clear()
        forgetReceipts()
        reactionReadJob?.cancel(); reactionReadJob = null
        for ((peer, ids) in sentReactionReads) pendingReactionReads.getOrPut(peer) { linkedSetOf() }.addAll(ids)
        sentReactionReads.clear()
        framePacer.reset()
        reconnectJob?.cancel(); reconnectJob = null
        stabilityJob?.cancel(); stabilityJob = null
        watchdogJob?.cancel(); watchdogJob = null
        pumpJob?.cancel(); pumpJob = null
        syncJob?.cancel(); syncJob = null
        syncActive = false
        syncAgain = false
        prefetchJob?.cancel(); prefetchJob = null
        prefetched.clear()
        prefetchRetryAt.clear()
        // Whatever this socket's walks were downloading is for a generation nobody will
        // merge: abort the transfers rather than let them finish into a discarded page.
        abortHistory(all = false)
        typingLeaseJob?.cancel(); typingLeaseJob = null
        typingPeer = null
    }

    /**
     * The store refused a durable write. Never fatal, never silent: the process
     * keeps running and the UI is told this device can no longer be trusted to
     * keep what it shows. Marked here rather than at the throw site because the
     * repository answers `false` instead of throwing — see `ChatRepository.write`.
     */
    private fun storeRefused() = ephemeral.setStoreFailed()

    /**
     * The next dial-in, delayed by the current backoff and never earlier than
     * [earliestConnectAt].
     *
     * That floor is what a `rate_limited` close sets. Without it, every one of
     * the four paths that call [reconnectNow] — a network callback, a return to
     * the foreground, `/reconnect`, a login — reset `retryDelay` to a single
     * second and redialled straight into the penalty the server had just handed
     * out, which is how one disconnect became a reconnect storm and a storm
     * became a permanent one.
     */
    private fun scheduleReconnect(session: CloudSession) {
        if (closed || standingDown) return
        reconnectJob?.cancel()
        val floor = earliestConnectAt - monotonicMs()
        val wait = maxOf(retryDelay, floor, 0L)
        retryDelay = minOf(retryDelay * 2, RETRY_MAX_MS)
        reconnectJob = scope.launch {
            // Jitter, as in [backoffFor]: a hundred devices that lost their
            // sockets to the same server hiccup must not all come back in the
            // same millisecond and reproduce it.
            delay(wait + Random.nextLong(wait / 4 + 1))
            reconnectJob = null
            if (!closed && !standingDown) connect(session)
        }
    }

    private inner class Observer(
        private val session: CloudSession,
        private val generation: Long,
    ) : CloudSocket.Observer {

        private fun live() = !closed && ephemeral.current(generation)

        override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) {
            if (!live()) return
            reconnectJob?.cancel(); reconnectJob = null
            // The fast retry is earned by a connection that lasted, not by one
            // that merely handshook: resetting here made every post-auth drop
            // retry once a second forever.
            stabilityJob?.cancel()
            stabilityJob = scope.launch {
                delay(STABLE_AFTER_MS)
                retryDelay = RETRY_MS
            }
            ephemeral.setLink(CloudLink.Online)
            ephemeral.setCaps(caps)
            // Liveness, so it rides the ephemeral holder and not Room: the frame
            // carries the whole roster, so this is a replacement of the set.
            ephemeral.setCallable(users.filter { it.callable }.map { it.login }.toSet())
            acceptReactionRoster(users)
            ephemeral.setFailure(null)
            listener.onSelfUpdated(self)
            listener.onRoster(users)
            val key = accountKey ?: return
            rosterPeers = users.map { it.login }.toSet()
            scope.launch {
                if (!repository.applyRoster(key, users.map { it.toConversationRow(key) })) storeRefused()
                closeAbsentView()
                // The background walk excludes the open peer. If its first
                // HTTP load failed during a server restart, an empty sync feed
                // owes no backfill; reconnect must retry that unseeded view.
                val openPeer = viewInterest
                if (live() && openPeer != null && rosterLists(openPeer) &&
                    repository.conversation(key, openPeer)?.historySeeded != true
                ) {
                    refreshHistory(openPeer, generation)
                }
                // Only once the roster is durable: the walk reads those rows to
                // decide what is still missing, and a device that has never
                // opened a conversation gets its transcripts loaded here.
                prefetch(generation)
            }
            viewInterest?.let { connection?.subscribe(it) }
            startWatchdog(session, generation)
            resync(generation)
            pump(generation)
            pumpReactionReads()
            // Debt left behind by an interrupted backfill — a process killed
            // between the cursor commit and the fetch, a connection lost
            // mid-walk — is picked up here from the rows on disk rather than
            // from any event. The feed will never name those ids again: the
            // cursor has already moved past them, which is exactly why the debt
            // had to be written down at the same moment the cursor was.
            scope.launch { drainBackfill(key, session, generation) }
        }

        override fun onUsers(users: List<CloudUser>) {
            if (!live()) return
            listener.onRoster(users)
            ephemeral.setCallable(users.filter { it.callable }.map { it.login }.toSet())
            acceptReactionRoster(users)
            val key = accountKey ?: return
            rosterPeers = users.map { it.login }.toSet()
            scope.launch {
                if (!repository.applyRoster(key, users.map { it.toConversationRow(key) })) storeRefused()
                // How this account's *other* devices learn about a deletion:
                // their roster arrives without the peer, and a conversation
                // they are looking at has nothing left on the server to show.
                closeAbsentView()
                // A friend added after the first roster lands here: the walk is
                // idempotent, so calling it again only ever adds work.
                prefetch(generation)
            }
        }

        override fun onPresence(peer: String, online: Boolean, lastSeen: Long?) {
            if (!live()) return
            val key = accountKey ?: return
            scope.launch { if (!repository.applyPresence(key, peer, online, lastSeen)) storeRefused() }
        }

        override fun onSubscribed(peer: String) {
            if (!live()) return
            subscribedPeer = peer
            if (peer == viewInterest) {
                flushReads(peer)
                // Rule 4: send hello upon initial peer subscription, never in response to hello.
                if (peer != session.user.login) {
                    connection?.sendHello(
                        peer = peer,
                        name = session.user.name.ifBlank { session.user.login },
                        tz = java.util.TimeZone.getDefault().id,
                        lang = java.util.Locale.getDefault().language,
                    )
                }
            }
            pump(generation)
        }

        override fun onMessage(message: CloudSocket.IncomingMessage) {
            if (!live()) return
            val key = accountKey ?: return
            val self = session.user.login
            // `self: true` is the server echoing our own message to our other
            // sessions: proof it was committed, which is what the queue was
            // holding it for.
            if (message.self) settle(message.id, DeliveryState.Accepted, null)
            // An AI reply is delivered under the owning account's own login
            // (`ai-bridge.js`'s `ack()` defaults `from` to the account that
            // configured it, so its self-sync copy legitimately carries
            // `self: true`/`from == self`) — `kind` is what actually says who
            // wrote it, the same check web's client makes (`app.js`:
            // `isAi ? false : message.from === self`).
            val mine = message.kind != "ai" && (message.self || message.from == self)
            val viewable = foreground && viewInterest == message.from
            // A peer the last complete roster no longer lists is a contact this
            // account deleted: storing the frame would re-create the
            // conversation row the deletion purged, and alerting for it would
            // announce a conversation that no longer exists. Dropped whole —
            // including its receipts, which are for a thread this device no
            // longer has. See [rosterLists]: the server refuses frames between
            // the pair anyway, so this only ever catches what was written
            // before the deletion and delivered late.
            if (!rosterLists(message.from)) return
            if (message.hidden) {
                // An edit's carrier: held under its id (the feed names it, and the
                // backfill would otherwise walk history for it) but never a bubble,
                // a preview, an unread, a receipt or a notification.
                scope.launch {
                    if (!repository.storeHidden(
                        key, message.from,
                        MessageEntity(
                            accountKey = key, peer = message.from, id = message.id, text = "", ts = message.ts,
                            author = message.from, mine = mine, delivery = DeliveryState.Accepted.ordinal,
                            system = false, kind = message.kind, imageDataUrl = null, imageWidth = null,
                            imageHeight = null, voiceDataUrl = null, voiceDurationSec = null, reactionsJson = null,
                            replyJson = null, forwardJson = null, editedAt = null, deletedAt = message.ts,
                            serverSeq = null, buttonsJson = null,
                        ),
                    )) storeRefused()
                }
                return
            }
            scope.launch {
                // The server's own time, verbatim. Incoming used to be pushed
                // to `previewTs + 1` when it arrived with an older timestamp,
                // which reordered a delayed or repeated message to the end of
                // the thread and — worse — left it permanently out of step with
                // the peer's read watermark, which is measured against the
                // stored `ts`. The feed, the live frame and HTTP history all
                // carry one number for a message; the transcript now keeps it.
                if (!repository.applyIncoming(
                    accountKey = key,
                    peer = message.from,
                    message = MessageEntity(
                        accountKey = key,
                        peer = message.from,
                        id = message.id,
                        text = message.text,
                        ts = message.ts,
                        author = message.author ?: message.from,
                        mine = mine,
                        delivery = DeliveryState.Accepted.ordinal,
                        system = false,
                        kind = message.kind,
                        imageDataUrl = message.image?.dataUrl,
                        imageWidth = message.image?.width,
                        imageHeight = message.image?.height,
                        voiceDataUrl = message.voice?.dataUrl,
                        voiceDurationSec = message.voice?.durationSec,
                        reactionsJson = null,
                        replyJson = message.replyTo?.let {
                            Payloads.replyJson(it.id, it.from, it.text, it.media)
                        },
                        forwardJson = message.forwardedFrom?.let {
                            Payloads.forwardJson(it.login, it.name)
                        },
                        editedAt = null,
                        deletedAt = null,
                        serverSeq = null,
                        buttonsJson = Payloads.encodeButtons(message.buttons),
                    ),
                    countUnread = !mine && !viewable,
                )) {
                    // Nothing was stored, so nothing may be acknowledged: an
                    // `ack` (let alone a `read`) sent for a message this device
                    // does not hold is the server being told "delivered" about
                    // a message nobody has, and the row is then never fetched
                    // again, because the debt is only recorded by the feed.
                    storeRefused()
                    return@launch
                }
                notifyIfEligible(key, message.from, message.id, viewable)
                // Ordered after the commit on purpose — the responsibility for
                // the message is taken only once it is on disk. A failure above
                // skips both receipts, so the next flush (the reconnect's
                // `unreadIncoming` walk, or `flushReads` when the thread opens)
                // offers them again instead of leaving a gap that the server
                // believes was delivered and read.
                if (!mine) {
                    queueReceipt(message.from, message.id, read = false)
                    if (viewable && foreground && viewInterest == message.from) queueReceipt(message.from, message.id, read = true)
                }
                listener.onIncomingMessageForOpenPeer(message.from, mine)
            }
        }

        override fun onMessageAccepted(accepted: CloudSocket.MessageAccepted) {
            if (!live()) return
            // The server's time, not this device's: every client sorts by `ts`
            // and the peer's copy carries the committed number, so adopting it
            // here is what keeps the two transcripts in one order and lets a
            // peer's read watermark actually reach this row.
            settle(accepted.id, DeliveryState.Accepted, accepted.seq, accepted.ts)
        }

        override fun onReceipt(receipt: CloudSocket.IncomingReceipt) {
            if (!live()) return
            val state = if (receipt.read) DeliveryState.Read else DeliveryState.Delivered
            settle(receipt.id, state, null)
            val key = accountKey ?: return
            val readTs = receipt.readTs
            val deliveredTs = receipt.deliveredTs
            scope.launch {
                repository.markDelivery(key, receipt.from, receipt.id, state)
                // A receipt is a watermark, so the named bubble is not the only
                // one it settles: everything of ours at or before `readTs` is
                // read too. Advancing just the id left the earlier ones on one
                // ✓ until the conversation was reloaded — a receipt lost to a
                // reconnect (or to the paced queue) could never be made up,
                // which is exactly the «галочки не совпадают» the browser had
                // already fixed this way (`applyReceipt` in app.js).
                if (receipt.read && readTs != null && readTs > 0L) {
                    repository.peerReadWatermark(key, receipt.from, readTs, receipt.readAt ?: 0L, receipt.via)
                }
                // The delivered rung below it, on the same terms: an `ack` names
                // a message but carries the peer's whole delivered watermark, so
                // the earlier ones climb too rather than waiting for a
                // conversation reload. Reading implies delivery, so this branch
                // is only for a non-read receipt: a read one already raised the
                // delivered watermark through `peerReadWatermark`'s own ladder.
                if (!receipt.read && deliveredTs != null && deliveredTs > 0L) {
                    repository.peerDeliveredWatermark(key, receipt.from, deliveredTs)
                }
            }
        }

        override fun onReadSync(readSync: CloudSocket.ReadSync) {
            if (!live()) return
            val key = accountKey ?: return
            scope.launch {
                repository.readWatermark(key, readSync.peer, readSync.readTs)
                repository.suppressReadNotifications(key, readSync.peer, readSync.readTs)
                listener.onNotificationsCleared(readSync.peer)
            }
        }

        /** `read-accepted` — the server's durable confirmation of this
         *  account's own outgoing read receipt. A `null` id is the bulk
         *  `mark-read` path; a real id is the per-message receipt path — the
         *  two are architecturally distinct (see [pendingReadAcks] and
         *  [pendingMessageReadAcks]) and are settled independently. */
        override fun onReadAccepted(accepted: CloudSocket.ReadAccepted) {
            if (!live()) return
            val id = accepted.id
            if (id == null) {
                val done = pendingReadAcks.values.filter { it.peer == accepted.peer }
                if (done.isEmpty()) return
                for (entry in done) pendingReadAcks.remove(entry.opId)
                scope.launch {
                    for (entry in done) repository.completeOperation(entry.opId, null, DeliveryState.Accepted, null)
                    pump()
                }
                return
            }
            val peer = pendingMessageReadAcks[id] ?: return
            if (peer != accepted.peer) return
            pendingMessageReadAcks.remove(id)
            val key = accountKey ?: return
            scope.launch { if (!repository.markIncomingRead(key, listOf(id))) storeRefused() }
        }

        override fun onOperationAccepted(accepted: CloudSocket.OperationAccepted) {
            if (!live()) return
            val entry = accepted.opId
                ?.let(pendingOperationAcks::get)
                ?: pendingOperationAcks.values.singleOrNull {
                    it.peer == accepted.peer &&
                        it.kind == accepted.opKind &&
                        it.messageId == accepted.id
                }
                ?: return
            if (entry.peer != accepted.peer ||
                entry.kind != accepted.opKind ||
                entry.messageId != accepted.id
            ) return
            pendingOperationAcks.remove(entry.opId)
            scope.launch {
                repository.completeOperation(entry.opId, null, DeliveryState.Accepted, null)
                pump()
            }
        }

        override fun onSyncPage(page: CloudSocket.SyncPage) {
            if (!live()) return
            applySyncPage(page, generation)
        }

        /**
         * `k:"sync-nudge"` — this account's feed moved while this socket was
         * up. This is the piece `sync-v1` alone was missing: without it a
         * session that was not subscribed to the conversation (the phone in the
         * background, the tab on the roster, the second device of the sender)
         * learned nothing until something unrelated forced a reconnect, so a
         * message written on the browser stayed invisible on the phone for as
         * long as the socket lived.
         *
         * One pass at a time: a nudge that lands while a page is being applied
         * is not a reason to start a second walk — the page in hand may be the
         * one it is about — so it is folded into a single owed re-run that
         * happens when the current pass finishes, from the cursor as it stands
         * then. Nothing is asked twice, and nothing that arrived mid-pass is
         * skipped.
         */
        override fun onSyncAvailable() {
            if (!live()) return
            if (syncActive) {
                syncAgain = true
                return
            }
            resync(generation)
        }

        override fun onReaction(reaction: CloudSocket.IncomingReaction) {
            if (!live()) return
            val key = accountKey ?: return
            scope.launch {
                repository.applyReaction(key, reaction.from, reaction.id, reaction.emoji, reaction.by, reaction.add)
            }
        }

        override fun onEdit(edit: CloudSocket.IncomingEdit) {
            if (!live()) return
            val key = accountKey ?: return
            scope.launch { repository.applyEdit(key, edit.from, edit.id, edit.text, clock()) }
        }

        override fun onDelete(delete: CloudSocket.IncomingDelete) {
            if (!live()) return
            val key = accountKey ?: return
            scope.launch { repository.applyDelete(key, delete.from, delete.ids) }
        }

        override fun onReplyReminder(reminder: CloudSocket.ReplyReminder) {
            if (!live()) return
            ephemeral.clearReminder(reminder.messageId)
            listener.onReplyReminder(reminder)
            connection?.acknowledgeReplyReminder(reminder.id)
        }

        override fun onReplyReminderSet(reminder: CloudSocket.ReplyReminder) {
            if (!live()) return
            ephemeral.markReminder(reminder.messageId)
        }
        override fun onUnread(unread: CloudSocket.Unread) {
            if (!live()) return
            val key = accountKey ?: return
            // An `unread` envelope for a peer the roster no longer lists is a
            // contact this account deleted — and `setUnreadSnapshot` reaches
            // the conversation row through `touchPreview`, which inserts one on
            // first sight of the peer. See [rosterLists].
            if (!rosterLists(unread.from)) return
            val active = foreground && viewInterest == unread.from
            scope.launch {
                if (!repository.setUnreadSnapshot(
                    accountKey = key,
                    peer = unread.from,
                    previewText = unread.text,
                    previewTs = unread.ts ?: clock(),
                    // The server's absolute total, not "+1": a conversation
                    // that is open right now reads as caught up regardless of
                    // what the server queued while it was catching up.
                    count = if (active) 0 else unread.count,
                )) {
                    storeRefused()
                    return@launch
                }
                if (active || unread.text.isNullOrBlank()) return@launch
                // Nothing is subscribed to this peer, so the message itself was
                // queued rather than delivered and this envelope is the only
                // signal that it exists. Fetch it through the same history path
                // every other caller uses, then alert through the same claim —
                // a second trigger for one message is what the claim is for.
                val announcedAt = unread.ts ?: clock()
                val known = repository.newestIncoming(key, unread.from)
                if (known == null || known.ts < announcedAt) {
                    loadHistory(key, session, unread.from, generation, prefetch = false)
                }
                repository.newestIncoming(key, unread.from)?.let { newest ->
                    notifyIfEligible(key, unread.from, newest.id, visible = false)
                }
            }
        }

        override fun onWake(wake: CloudSocket.IncomingWake) {
            if (live()) listener.onWake(wake.from)
        }

        override fun onTyping(typing: CloudSocket.IncomingTyping) {
            if (!live()) return
            if (typing.typing) ephemeral.markTyping(typing.from, generation)
            else ephemeral.clearTyping(typing.from)
        }

        override fun onActions(actions: CloudSocket.IncomingActions) {
            if (live()) listener.onBotActions(actions.from, actions.actions)
        }

        override fun onPing(ping: CloudSocket.IncomingPing) {
            if (live()) listener.onPing(ping.from, ping.id)
        }

        override fun onPong(pong: CloudSocket.IncomingPong) {
            if (live()) listener.onPong(pong.from, pong.id)
        }

        override fun onFileOffer(offer: CloudSocket.IncomingFileFrame) {
            if (live()) listener.onFileFrame("file-offer", offer.from, offer.frame)
        }

        override fun onFileChunk(chunk: CloudSocket.IncomingFileFrame) {
            if (live()) listener.onFileFrame("file-chunk", chunk.from, chunk.frame)
        }

        override fun onFileDone(done: CloudSocket.IncomingFileFrame) {
            if (live()) listener.onFileFrame("file-done", done.from, done.frame)
        }

        override fun onCallSignal(from: String, frame: JsonObject) {
            // Not gated on live(): a call must reach CallController whichever
            // generation/connection it arrives on, the same reasoning §2
            // gives for the server delivering it to every connection of the
            // recipient regardless of subscription.
            listener.onCallSignal(from, frame)
        }

        override fun onFileDeny(deny: CloudSocket.IncomingFileFrame) {
            if (live()) listener.onFileFrame("file-deny", deny.from, deny.frame)
        }

        override fun onThrottle() {
            throttleEvents++
            for ((peer, ids) in sentReactionReads) pendingReactionReads.getOrPut(peer) { linkedSetOf() }.addAll(ids)
            sentReactionReads.clear()
            pumpReactionReads()
        }

        override fun onTraffic() {
            if (live()) lastInboundAt = SystemClock.elapsedRealtime()
        }

        override fun onFailure(failure: CloudFailure) {
            if (!live()) return
            when {
                failure.code in TERMINAL_AUTH_CODES -> {
                    standingDown = true
                    invalidate()
                    ephemeral.setLink(CloudLink.SignedOut)
                    ephemeral.setFailure(failure)
                    listener.onSessionRejected(failure)
                }
                // Correlated per-message errors: exactly one queued operation is
                // affected, and it must not be retried blindly.
                failure.code == "message_id_conflict" -> {
                    failure.id?.let { id -> failOperation(id, failure.code, ErrorKind.Permanent) }
                    listener.onEngineFailure(failure)
                }
                failure.code == "store_failed" -> {
                    // The server refused to commit: the message is genuinely not
                    // accepted, so it goes back to the queue with backoff rather
                    // than being shown as sent.
                    failure.id?.let { id -> requeue(id, ErrorKind.Retryable, failure.code) }
                    listener.onEngineFailure(failure)
                }
                else -> {
                    if (failure.code == "rate_limited") {
                        retryDelay = maxOf(retryDelay, rateLimitedPauseMs)
                        // The server closed the socket because this client was
                        // too loud; redialling inside its own window is what
                        // made the penalty permanent. The floor outlives
                        // `reconnectNow`'s reset, by design.
                        earliestConnectAt = monotonicMs() + rateLimitedPauseMs
                    }
                    ephemeral.setLink(CloudLink.Offline)
                    ephemeral.setFailure(failure)
                    releaseAllInFlight()
                    listener.onEngineFailure(failure)
                    scheduleReconnect(session)
                }
            }
        }

        override fun onClosed() {
            if (!live()) return
            ephemeral.setLink(CloudLink.Offline)
            subscribedPeer = null
            releaseAllInFlight()
            scheduleReconnect(session)
        }
    }

    // ---- outbox pump -----------------------------------------------------

    /**
     * Serves the durable queue for every conversation, fairly.
     *
     * Fairness is not a nicety here: the previous shape drained whatever the
     * open conversation owed and left the rest to a "background drain" that
     * borrowed the server subscription one peer at a time, at most once per
     * socket. A reply typed into a notification for a peer nobody opened could
     * therefore wait for the next reconnect. Round-robin over the claimed
     * batch removes the whole mechanism.
     */
    fun pump(generation: Long = ephemeral.generation) {
        if (closed || !ephemeral.current(generation)) return
        if (pumpJob?.isActive == true) return
        val key = accountKey ?: return
        pumpJob = scope.launch {
            try {
                while (ephemeral.current(generation) && ephemeral.state.value.link == CloudLink.Online) {
                    // A frame still in OkHttp's queue has not been seen by the
                    // server, so nothing can be *missing* an acknowledgement
                    // yet — see [deadlinesDeferred].
                    if (!deadlinesDeferred(generation, clock())) {
                        expireInFlight(generation)
                        expireReadAcks(generation)
                        expireOperationAcks(generation)
                    }
                    val room = MAX_IN_FLIGHT -
                        inFlight.size -
                        pendingReadAcks.size -
                        pendingOperationAcks.size
                    if (room <= 0) {
                        delay(IN_FLIGHT_POLL_MS)
                        continue
                    }
                    val owner = "$generation"
                    val claimed = repository.claimDue(key, owner, clock(), CLAIM_BATCH)
                    if (claimed.isEmpty()) {
                        if (inFlight.isEmpty() && pendingReadAcks.isEmpty() && pendingOperationAcks.isEmpty()) break
                        delay(IN_FLIGHT_POLL_MS)
                        continue
                    }
                    for (op in interleaveByPeer(claimed).take(room)) {
                        if (!ephemeral.current(generation)) return@launch
                        pace()
                        if (!write(op, generation)) {
                            // The frame never left: hand the lease back at once
                            // so a reconnect can try it rather than waiting out
                            // a lease timeout.
                            repository.releaseLease(op.opId, clock() + backoffFor(op.attempts), "unreachable", ErrorKind.Retryable.ordinal)
                            return@launch
                        }
                    }
                }
            } finally {
                pumpJob = null
            }
        }
    }

    /**
     * Round-robin across peers. A 200-message backlog for one contact yields
     * one frame per pass, so every other conversation gets served in the same
     * window instead of behind it.
     */
    private fun interleaveByPeer(ops: List<PendingOperationEntity>): List<PendingOperationEntity> {
        val byPeer = LinkedHashMap<String, ArrayDeque<PendingOperationEntity>>()
        for (op in ops) byPeer.getOrPut(op.peer) { ArrayDeque() }.addLast(op)
        val out = ArrayList<PendingOperationEntity>(ops.size)
        while (byPeer.isNotEmpty()) {
            val iterator = byPeer.entries.iterator()
            while (iterator.hasNext()) {
                val queue = iterator.next().value
                out += queue.removeFirst()
                if (queue.isEmpty()) iterator.remove()
            }
        }
        return out
    }

    /** Writes one operation. Returns false when the socket refused the frame. */
    private suspend fun write(op: PendingOperationEntity, generation: Long): Boolean {
        val conn = connection ?: return false
        val session = session ?: return false
        val addressed = CloudSocket.CAP_ADDRESSED_SEND in ephemeral.state.value.serverCaps
        if (!addressed && subscribedPeer != op.peer) {
            // An old server can only route to the subscribed peer. Borrowing the
            // subscription is what this design removed, so the honest move is to
            // wait for the UI's own subscription rather than fight it — and to
            // say why, once.
            repository.releaseLease(op.opId, clock() + OLD_SERVER_RETRY_MS, "addressed_send_unsupported", ErrorKind.Unsupported.ordinal)
            return true
        }
        val wrote = when (op.kind) {
            "message" -> {
                val payload = Payloads.parseMessagePayload(op.payloadJson) ?: run {
                    failOperation(op.messageId ?: op.opId, "corrupt_payload", ErrorKind.Permanent)
                    return true
                }
                conn.sendMessage(
                    peer = op.peer,
                    id = op.messageId ?: op.opId,
                    text = payload.text,
                    ts = payload.ts,
                    name = payload.author.ifBlank { session.user.name },
                    image = payload.imageDataUrl?.let {
                        CloudImage(it, payload.imageWidth ?: 0, payload.imageHeight ?: 0)
                    },
                    voice = payload.voiceDataUrl?.let {
                        CloudVoice(it, payload.voiceDurationSec ?: 0)
                    },
                    replyTo = payload.replyId?.let {
                        CloudReply(it, payload.replyFrom.orEmpty(), payload.replyText.orEmpty(), payload.replyMedia)
                    },
                    forwardedFrom = payload.forwardLogin?.let {
                        CloudForward(it, payload.forwardName ?: it)
                    },
                )
            }
            "edit" -> {
                val payload = Payloads.parseObject(op.payloadJson)
                val text = payload?.get("text")?.let { it.toString().trim('"') }.orEmpty()
                conn.sendEdit(op.peer, op.messageId ?: return true, text, op.opId)
            }
            "react" -> {
                val payload = Payloads.parseObject(op.payloadJson)
                val emoji = payload?.get("emoji")?.let { it.toString().trim('"') } ?: return true
                val add = payload["add"]?.toString() != "false"
                conn.sendReaction(op.peer, op.messageId ?: return true, emoji, add, op.opId)
            }
            "delete" -> {
                val payload = Payloads.parseObject(op.payloadJson)
                val scope = payload?.get("scope")?.let { it.toString().trim('"') } ?: "self"
                conn.sendDelete(op.peer, listOf(op.messageId ?: return true), scope, op.opId)
            }
            "read" -> conn.sendMarkRead(op.peer)
            else -> {
                failOperation(op.messageId ?: op.opId, "unknown_operation", ErrorKind.Permanent)
                return true
            }
        }
        if (!wrote) return false
        when {
            op.kind == "message" -> {
                val messageId = op.messageId ?: op.opId
                inFlight[messageId] = InFlight(
                    opId = op.opId,
                    peer = op.peer,
                    generation = generation,
                    deadline = clock() + ACK_TIMEOUT_MS,
                    attempts = op.attempts,
                )
                accountKey?.let { key ->
                    repository.markDelivery(key, op.peer, messageId, DeliveryState.Sending)
                }
            }
            op.kind == "read" && CloudSocket.CAP_READ_ACK in ephemeral.state.value.serverCaps -> {
                // A capable server actually confirms a bulk mark-read; hold the
                // op open under its own id until `read-accepted` arrives (or
                // the deadline in [expireReadAcks] retries it) instead of
                // trusting the write alone.
                pendingReadAcks[op.opId] = ReadAckWait(
                    opId = op.opId,
                    peer = op.peer,
                    generation = generation,
                    deadline = clock() + ACK_TIMEOUT_MS,
                    attempts = op.attempts,
                )
            }
            op.kind in OP_ACK_KINDS && CloudSocket.CAP_OP_ACK in ephemeral.state.value.serverCaps -> {
                val messageId = op.messageId ?: return true
                pendingOperationAcks[op.opId] = OperationAckWait(
                    opId = op.opId,
                    peer = op.peer,
                    kind = op.kind,
                    messageId = messageId,
                    deadline = clock() + ACK_TIMEOUT_MS,
                    attempts = op.attempts,
                )
            }
            else -> {
                // Compatibility is capability-scoped. An older server cannot
                // acknowledge these mutations, so edit/reaction/delete and
                // bulk read retain their previous successful-write completion;
                // messages still require `message-accepted`.
                repository.completeOperation(op.opId, null, DeliveryState.Accepted, null)
            }
        }
        return true
    }

    /** The hub's 60-frames-per-second ceiling and the socket's own send queue,
     *  shared with the file-transfer chunk loop through [framePacer] — see
     *  [FramePacer]. The drain is waited on first: a frame handed to a full
     *  queue is a frame whose arrival time nobody controls, and the budget is
     *  only meaningful for frames that actually left. */
    private suspend fun pace() {
        connection.awaitDrain()
        framePacer.acquire()
    }

    /**
     * Whether the frames behind the pending deadlines have even reached the
     * server yet.
     *
     * A send leaves through OkHttp's queue, and one large frame — a photo, a
     * voice note — can occupy that queue for minutes on a slow uplink. No
     * acknowledgement can exist for a frame the server has not received, so
     * counting that window against [ACK_TIMEOUT_MS] expired the operation
     * mid-upload — and the operation's *lease* ran out under it for the same
     * reason, [ChatRepository.LEASE_MS] of real time being shorter than the
     * upload itself. Either way the message went back to the queue and the
     * whole attachment was uploaded a second time, while the clock the person
     * was looking at stayed on the bubble until eight attempts were spent and
     * «не отправлено» appeared. While anything is still queued both are
     * re-armed instead; a socket that really died fails the write or the
     * connection, and [Observer.onFailure] releases everything in flight.
     */
    private suspend fun deadlinesDeferred(generation: Long, now: Long): Boolean {
        val queued = queuedBytes?.invoke() ?: connection?.queuedBytes() ?: 0L
        if (queued <= 0L) return false
        val held = inFlight.values.map { it.opId } +
            pendingReadAcks.values.map { it.opId } +
            pendingOperationAcks.values.map { it.opId }
        repository.renewLease(held, "$generation")
        for (key in inFlight.keys.toList()) {
            inFlight[key] = inFlight.getValue(key).copy(deadline = now + ACK_TIMEOUT_MS)
        }
        for (key in pendingReadAcks.keys.toList()) {
            pendingReadAcks[key] = pendingReadAcks.getValue(key).copy(deadline = now + ACK_TIMEOUT_MS)
        }
        for (key in pendingOperationAcks.keys.toList()) {
            pendingOperationAcks[key] = pendingOperationAcks.getValue(key).copy(deadline = now + ACK_TIMEOUT_MS)
        }
        return true
    }

    /**
     * A per-operation deadline, not a per-socket one.
     *
     * Inbound traffic on a healthy socket says nothing about one particular
     * outgoing message: the old shape treated "the link is fine" as progress,
     * which is how a message kept a clock next to it for an hour while
     * receipts for other conversations flowed past it.
     */
    private suspend fun expireInFlight(generation: Long) {
        if (inFlight.isEmpty()) return
        val now = clock()
        val expired = inFlight.entries.filter { it.value.deadline <= now }
        for ((messageId, entry) in expired) {
            inFlight.remove(messageId)
            if (!ephemeral.current(generation)) continue
            if (entry.attempts + 1 >= MAX_ATTEMPTS) {
                failOperation(messageId, "no_acceptance", ErrorKind.Retryable)
            } else {
                repository.releaseLease(
                    entry.opId,
                    now + backoffFor(entry.attempts + 1),
                    "no_acceptance",
                    ErrorKind.Retryable.ordinal,
                )
                accountKey?.let { repository.markDelivery(it, entry.peer, messageId, DeliveryState.Queued) }
            }
        }
    }

    /** The bulk-mark-read counterpart of [expireInFlight]. Unlike a message, a
     *  `mark-read` carries no message identity to fail permanently against and
     *  re-applying it is harmless, so a missed `read-accepted` always retries
     *  with backoff rather than ever parking the op as failed. */
    private suspend fun expireReadAcks(generation: Long) {
        if (pendingReadAcks.isEmpty()) return
        val now = clock()
        val expired = pendingReadAcks.entries.filter { it.value.deadline <= now }
        for ((opId, entry) in expired) {
            pendingReadAcks.remove(opId)
            if (!ephemeral.current(generation)) continue
            repository.releaseLease(
                entry.opId,
                now + backoffFor(entry.attempts + 1),
                "no_read_ack",
                ErrorKind.Retryable.ordinal,
            )
        }
    }

    /** Transit-loss retry for edit/reaction/delete. These mutations are
     * idempotent at the current store boundary, so an unobserved acceptance
     * returns to the queue rather than being declared permanently failed. */
    private suspend fun expireOperationAcks(generation: Long) {
        if (pendingOperationAcks.isEmpty()) return
        val now = clock()
        val expired = pendingOperationAcks.entries.filter { it.value.deadline <= now }
        for ((opId, entry) in expired) {
            pendingOperationAcks.remove(opId)
            if (!ephemeral.current(generation)) continue
            repository.releaseLease(
                entry.opId,
                now + backoffFor(entry.attempts + 1),
                "no_operation_ack",
                ErrorKind.Retryable.ordinal,
            )
        }
    }

    /** A socket that went away takes its leases with it: every in-flight
     *  operation returns to a claimable state under its original id. */
    private fun releaseAllInFlight() {
        if (inFlight.isEmpty() && pendingReadAcks.isEmpty() && pendingOperationAcks.isEmpty()) return
        val snapshot = inFlight.toMap()
        inFlight.clear()
        val readSnapshot = pendingReadAcks.toMap()
        pendingReadAcks.clear()
        val operationSnapshot = pendingOperationAcks.toMap()
        pendingOperationAcks.clear()
        val key = accountKey ?: return
        scope.launch {
            for ((messageId, entry) in snapshot) {
                repository.releaseLease(entry.opId, clock() + backoffFor(entry.attempts), "socket_lost", ErrorKind.Retryable.ordinal)
                repository.markDelivery(key, entry.peer, messageId, DeliveryState.Queued)
            }
            for (entry in readSnapshot.values) {
                repository.releaseLease(entry.opId, clock() + backoffFor(entry.attempts), "socket_lost", ErrorKind.Retryable.ordinal)
            }
            for (entry in operationSnapshot.values) {
                repository.releaseLease(entry.opId, clock() + backoffFor(entry.attempts), "socket_lost", ErrorKind.Retryable.ordinal)
            }
        }
    }

    private fun settle(messageId: String, state: DeliveryState, seq: Long?, ts: Long? = null) {
        val entry = inFlight.remove(messageId)
        val key = accountKey ?: return
        scope.launch {
            if (entry != null) {
                repository.completeOperation(entry.opId, messageId, state, seq, ts)
            } else {
                // Acceptance for something no longer in flight: a duplicate
                // receipt, or an ack that outlived a lease. Advancing delivery is
                // still correct and is monotonic in the repository.
                repository.markDeliveryAnywhere(key, messageId, state)
            }
            pump()
        }
    }

    private fun requeue(messageId: String, kind: ErrorKind, error: String) {
        val entry = inFlight.remove(messageId) ?: return
        val key = accountKey ?: return
        scope.launch {
            repository.releaseLease(entry.opId, clock() + backoffFor(entry.attempts + 1), error, kind.ordinal)
            repository.markDelivery(key, entry.peer, messageId, DeliveryState.Queued)
        }
    }

    private fun failOperation(messageId: String, error: String, kind: ErrorKind) {
        val entry = inFlight.remove(messageId)
        val key = accountKey ?: return
        scope.launch {
            val opId = entry?.opId ?: repository.operationForMessage(key, messageId)?.opId ?: return@launch
            repository.failOperation(opId, error, kind.ordinal)
            entry?.let { repository.markDelivery(key, it.peer, messageId, DeliveryState.Failed) }
        }
    }

    /**
     * The user pressed "retry" on a failed operation. The id is deliberately
     * reused: a message whose acceptance is merely *unknown* must not be sent
     * again under a new id, or the server's idempotency key cannot recognise it
     * and the peer sees two copies.
     */
    fun retryFailed(opId: String) {
        scope.launch {
            repository.releaseLease(opId, clock(), null, ErrorKind.None.ordinal)
            accountKey?.let { key ->
                repository.operation(opId)?.let { op ->
                    op.messageId?.let { repository.markDelivery(key, op.peer, it, DeliveryState.Queued) }
                }
            }
            pump()
        }
    }

    private fun backoffFor(attempts: Int): Long {
        val exponential = RETRY_MS shl minOf(attempts, 6)
        val capped = minOf(exponential, OP_RETRY_MAX_MS)
        // Jitter so a hundred queued operations released by one reconnect do not
        // all come due in the same millisecond.
        return capped + Random.nextLong(capped / 4 + 1)
    }

    // ---- reconciliation --------------------------------------------------

    /**
     * Catches up on everything that happened while this device was away, from
     * the durable cursor, and only then advances the cursor — in the same
     * transaction as the changes it covers, so an interrupted page is replayed
     * rather than skipped.
     */
    private fun resync(generation: Long) {
        val key = accountKey ?: return
        if (CloudSocket.CAP_SYNC !in ephemeral.state.value.serverCaps) {
            // Old server: no change feed. The open conversation is still
            // reconciled from HTTP history, and the queue is untouched.
            viewInterest?.let { refreshHistory(it, generation) }
            return
        }
        syncJob?.cancel()
        syncAgain = false
        syncActive = true
        syncJob = scope.launch {
            val since = repository.cursor(key)
            connection?.sendSync(since, SYNC_PAGE)
        }
    }

    /**
     * The last page of a pass arrived: the feed is quiet from here until
     * somebody says otherwise.
     *
     * A nudge that landed while this pass was running owes one more walk — the
     * page it is about may have been committed after this pass read the feed —
     * so it is honoured here rather than dropped. Starting it from the stored
     * cursor is safe by construction: a page applied twice is a no-op, and a
     * page skipped is the one thing this whole path exists to prevent.
     */
    private fun finishSyncPass(generation: Long) {
        syncActive = false
        if (!syncAgain) return
        syncAgain = false
        if (!ephemeral.current(generation)) return
        if (ephemeral.state.value.link != CloudLink.Online) return
        resync(generation)
    }

    private fun applySyncPage(page: CloudSocket.SyncPage, generation: Long) {
        val key = accountKey ?: return
        scope.launch {
            if (page.reset) {
                // The cursor fell out of the server's window. Re-seed what the
                // user can see; the outbox is never part of a resync.
                repository.markConversationsUnseeded(key)
                viewInterest?.let { refreshHistory(it, generation) }
            }
            // Peers with an incoming "message" event this device had never
            // seen — arrived while the socket was down and never delivered by
            // push either, so this catch-up feed is the only signal it exists
            // at all. Collected here, not acted on inside the transaction
            // below: the backfill fetch is real HTTP I/O and must not run
            // with the cursor commit held open. The id rides along because
            // `loadHistory` has to walk back to the page that contains it
            // rather than trust the newest one to have it.
            val missed = LinkedHashMap<String, MissedPeer>()
            // The newest incoming message the page names, per peer. A message
            // reaches a socket that is not subscribed to its author only
            // through this feed (or `unread`, or a push), never as a live
            // frame, so the live `ack` in [Observer.onMessage] never runs for
            // it and the author stayed on ✓ until this side opened the
            // conversation. One `ack` for the newest is enough: the server
            // keeps a delivered watermark, not a per-message flag.
            val newestIncoming = LinkedHashMap<String, String>()
            repository.advanceCursorWith(key, page.cursor) {
                for (event in page.events) {
                    if (event.kind == "message" && !event.self) event.id?.let { newestIncoming[event.peer] = it }
                    val missing = applyEvent(key, event) ?: continue
                    val existing = missed[missing.peer]
                    missed[missing.peer] = MissedPeer(
                        peer = missing.peer,
                        incoming = (existing?.incoming ?: false) || missing.incoming,
                        ids = (existing?.ids ?: emptyList()) + missing.id,
                    )
                }
            }
            val session = session
            for (peer in missed.keys) {
                if (session == null || !ephemeral.current(generation)) break
                // Unconditional: the transaction above already proved a
                // specific message id for this peer is missing locally — an
                // *older* message already present (`newestIncoming != null`)
                // says nothing about that one, so skipping the fetch on that
                // basis silently dropped the very message this exists to
                // catch. The ids are handed over so the walk can go past the
                // newest page when the gap is deeper than one page.
                loadHistory(
                    key = key,
                    session = session,
                    peer = peer,
                    generation = generation,
                    prefetch = false,
                    backfill = repository.backfillIds(key, peer),
                )
            }
            // After the backfill, so the receipt only ever names a message this
            // device actually holds — the rule [Observer.onMessage] follows.
            for ((peer, id) in newestIncoming) {
                if (!ephemeral.current(generation)) break
                if (repository.hasMessage(key, peer, id)) queueReceipt(peer, id, read = false)
            }
            if (page.more && ephemeral.current(generation)) {
                connection?.sendSync(page.cursor, SYNC_PAGE)
                return@launch
            }
            finishSyncPass(generation)
            for ((peer, entry) in missed) {
                if (!entry.incoming) continue
                if (!ephemeral.current(generation)) return@launch
                // Looking at it right now: the open screen is the honest
                // signal, same as `onUnread`'s own `active` check — a
                // notification for a conversation already on screen would be
                // announcing what is already visible. The content still had
                // to be fetched above regardless: this device was offline for
                // the whole gap, so nothing delivered it live either.
                if (foreground && viewInterest == peer) continue
                repository.newestIncoming(key, peer)?.let { newest ->
                    notifyIfEligible(key, peer, newest.id, visible = false)
                }
            }
            // Whatever the feed could not close — a fetch that failed, a
            // process that died before it ran — is still owed on disk; this is
            // where a connection picks that debt up again. Nothing to fetch
            // through without a session, and the debt survives to the next one.
            if (session != null) drainBackfill(key, session, generation)
        }
    }

    /** What one peer is owed out of a sync page: that it owes a fetch at all,
     *  whether the news is worth an alert, and the ids that proved it. */
    private data class MissedPeer(val peer: String, val incoming: Boolean, val ids: List<String>)

    /**
     * Fetches history for every conversation still owing a backfill, oldest
     * recorded debt first.
     *
     * The list is durable, so this is what closes a gap that survived a lost
     * connection, a killed process or a crash between the cursor commit and the
     * HTTP request — the three cases a purely in-memory worklist forgets.
     * Bounded per call: the rest is picked up by the next sync pass, which is
     * the same condition that created the debt.
     */
    private suspend fun drainBackfill(key: String, session: CloudSession, generation: Long) {
        val peers = repository.backfillPeers(key)
        for (peer in peers.take(BACKFILL_PEERS_PER_PASS)) {
            if (!ephemeral.current(generation)) return
            val owed = repository.backfillIds(key, peer)
            if (owed.isEmpty()) continue
            // A peer the roster no longer lists is a deleted contact: the
            // server answers an empty page for the pair forever, so the ids can
            // never be found and the debt is genuinely unpayable. Dropped
            // rather than retried on every connection for the life of the
            // install.
            if (!rosterLists(peer)) {
                if (!repository.clearBackfill(key, peer, owed)) storeRefused()
                continue
            }
            loadHistory(key, session, peer, generation, prefetch = false, backfill = owed)
        }
    }

    /** A message the feed named that this device does not hold: which
     *  conversation it belongs to, whether the other side wrote it, and the id
     *  itself — the id is what the backfill has to walk history for.
     *
     *  [incoming] is what separates the two obligations the feed creates. Both
     *  are owed a fetch — the feed says *that* a message exists, never *what*
     *  it says, so the id is all the content this device has until the page
     *  arrives. Only the other side's is owed an alert. */
    private data class MissingMessage(val peer: String, val incoming: Boolean, val id: String)

    /** Returns what the caller owes for [event]: a message this device has
     *  never seen, and whose it is. */
    private suspend fun applyEvent(key: String, event: CloudSocket.SyncEvent): MissingMessage? {
        var missed: MissingMessage? = null
        when (event.kind) {
            "message" -> {
                val id = event.id ?: return null
                // A message this device already has (its own, or one seen live)
                // is only advanced, never rewritten from the feed: the feed
                // carries no media payload.
                if (repository.hasMessage(key, event.peer, id)) {
                    repository.markDelivery(key, event.peer, id, DeliveryState.Accepted)
                    repository.noteServerSeq(key, event.peer, id, event.seq)
                } else {
                    // The debt, written in the same transaction as the cursor
                    // that covered this event (`applySyncPage`): the feed names
                    // an id and never its content, so "the cursor has moved past
                    // it" is only honest while the obligation to fetch it is
                    // recorded on disk. It replaces a coarse `markUnseeded`,
                    // which promised a re-fetch of the newest page — a page that
                    // by definition does *not* contain an older gap.
                    if (!repository.addBackfill(key, event.peer, listOf(id))) storeRefused()
                    // `self` here is not "this device already has it" — it is
                    // "this account wrote it, from another device": the
                    // browser, the terminal, a second phone. That copy is
                    // never queued for the account's other devices (the queue
                    // is per recipient login, `hub.js`'s `deliverFrame`) and
                    // reaches them only live, on a subscription to exactly
                    // this conversation, or through a push wake-up. A socket
                    // that was down for the second it was written loses both,
                    // which is precisely how a message written in the web
                    // never appeared on the phone — so the fetch is owed
                    // either way. The alert is not: the person wrote it.
                    missed = MissingMessage(event.peer, incoming = !event.self, id = id)
                }
                if (event.self) settle(id, DeliveryState.Accepted, event.seq, event.ts)
            }
            "edit" -> event.id?.let {
                repository.applyEdit(key, event.peer, it, event.text.orEmpty(), event.ts ?: clock())
            }
            "delete" -> repository.applyDelete(key, event.peer, event.ids.ifEmpty { listOfNotNull(event.id) })
            "react" -> {
                val id = event.id ?: return null
                val emoji = event.emoji ?: return null
                repository.applyReaction(key, event.peer, id, emoji, event.by.orEmpty(), event.add)
            }
            "read" -> {
                val readTs = event.readTs ?: event.ts ?: 0L
                // `self` is what tells the two directions of one server event
                // apart (`accounts.js`'s `recordEvent`): the reader's own devices
                // see `self: true` and this is *their* read watermark — their
                // roster badge for this conversation is settled and a
                // notification for something they have already seen is moot.
                // The author's devices see no `self`, and for them the same
                // event says the opposite thing: the peer has read this
                // account's own messages up to `readTs`. Treating the second as
                // the first — which is what one undivided branch did — advanced
                // the author's own read watermark instead of its ✓✓, so a
                // receipt that arrived through the feed never turned a single
                // tick into a double one, and a peer's reading could silently
                // suppress this device's notification for a message it had not
                // seen.
                if (event.self) {
                    repository.readWatermark(key, event.peer, readTs)
                    repository.suppressReadNotifications(key, event.peer, readTs)
                    listener.onNotificationsCleared(event.peer)
                } else {
                    repository.peerReadWatermark(key, event.peer, readTs, event.readAt ?: 0L, event.via)
                }
            }
        }
        return missed
    }

    /**
     * Fetches the server's page for one conversation. This is what fills a
     * conversation whose local history has a hole — after a `reset`, or the
     * first time it is opened on this device. It never blocks opening the
     * conversation: the screen reads Room, and this only adds to it.
     *
     * Opening a conversation also takes it out of the prefetch walk's
     * candidate set ([prefetched]): the person is looking at it now, so it is
     * fetched here, immediately, instead of waiting behind the roster.
     */
    fun refreshHistory(peer: String, generation: Long = ephemeral.generation) {
        val session = session ?: return
        val key = accountKey ?: return
        prefetched += peer
        scope.launch {
            loadHistory(key, session, peer, generation, prefetch = false, interactive = true)
            pump()
        }
    }

    /** How one [walkHistory] ended. [GaveUp] is the only outcome a person is told about:
     *  asking for less could not help (see [loadHistory]). */
    private enum class HistoryOutcome { Merged, Failed, GaveUp }

    /**
     * One `/api/history` walk in flight for a conversation, and the question it is
     * answering — what decides whether a second caller can simply wait for its answer.
     */
    private class HistoryFlight(
        val job: Deferred<HistoryOutcome>,
        val generation: Long?,
        val prefetch: Boolean,
        val backfill: Set<String>,
    ) {
        /**
         * Whether this walk's merge is everything the other caller would have done:
         * bound to the same socket (or to none — a push fetch survives a reconnect),
         * not a prefetch the open conversation would discard, and walking for at least
         * the ids the other caller owes. Every walk merges at least the newest
         * [HISTORY_PAGE] rows first ([walkHistory]), so a caller with no ids is covered
         * by any of them.
         */
        fun covers(generation: Long?, prefetch: Boolean, backfill: Collection<String>): Boolean =
            (this.generation == null || this.generation == generation) &&
                (!this.prefetch || prefetch) &&
                this.backfill.containsAll(backfill)
    }

    /** At most one [walkHistory] per (account, peer) — see [loadHistory]. Guarded by itself:
     *  the walks complete on whatever thread their last request returned on. */
    private val historyFlights = HashMap<Pair<String, String>, HistoryFlight>()

    /** The page size that last worked for an (account, peer), for this connection: the
     *  next walk starts there instead of re-learning it by downloading pages that cannot
     *  be transferred. Cleared with the generation ([invalidate]). Guarded by
     *  [historyFlights]. */
    private val historyLimits = HashMap<Pair<String, String>, Int>()

    /**
     * Aborts history walks — and through [CloudApi.history]'s cancellation, their HTTP
     * calls. A reconnect aborts the ones bound to the socket that went away; a logout or
     * [close] ([all]) also the account-scoped push fetches, whose account is gone.
     * Cancelled outside the lock: a walk that never started completes synchronously,
     * and its completion handler takes the lock again.
     */
    private fun abortHistory(all: Boolean) {
        val aborted = synchronized(historyFlights) {
            historyLimits.clear()
            historyFlights.values.filter { all || it.generation != null }
        }
        for (flight in aborted) flight.job.cancel()
    }

    /**
     * The one body that turns server history pages into local rows, shared by
     * the open conversation, the background prefetch, the push fetch and the
     * backfill so they cannot diverge. Returns whether the walk completed.
     *
     * **Single flight.** A conversation is walked by at most one request at a
     * time. A caller whose question the running walk already answers
     * ([HistoryFlight.covers]) waits for that walk and shares its outcome — the
     * open conversation asked for at `selectPeer`, again at `ready` and again by
     * a `reset` is one download, not three copies of tens of megabytes. Any
     * other caller waits for the running walk to end and then starts its own.
     *
     * **The banner.** `history_failed` is shown only when the walk gave up for a
     * reason asking for less cannot fix, only to an [interactive] caller (the
     * open conversation, never prefetch, push or backfill), only while that
     * conversation is still the open one on the same account and socket — and
     * it is withdrawn by the next walk of that conversation that succeeds,
     * whoever started it. A network failure is not a banner: the link state and
     * the reconnect already say it.
     *
     * A walk cancelled under its callers (a reconnect or a logout, through
     * [abortHistory]) is a failed load to them, not a crash; a caller that is
     * itself cancelled gets its [CancellationException].
     */
    private suspend fun loadHistory(
        key: String,
        session: CloudSession,
        peer: String,
        generation: Long?,
        prefetch: Boolean,
        backfill: List<String> = emptyList(),
        interactive: Boolean = false,
    ): Boolean {
        // A peer the last complete roster no longer lists is a contact this
        // account deleted. The server keeps the friendship and answers an empty
        // page for the pair forever, and merging even that empty page re-creates
        // the conversation row the deletion purged — `applyHistoryPage` reaches
        // it through `touchPreview`, which inserts on first sight of a peer.
        // Asked before the request, so a thread that can only come back empty
        // is not fetched at all. See [rosterLists]. This is the gate every
        // history path shares — open, prefetch and push — because this is the
        // one body all three fetch through.
        if (!rosterLists(peer)) return false
        val flightKey = key to peer
        var outcome: HistoryOutcome
        while (true) {
            // Checked on every pass, not only the first: a caller that waited out a walk
            // which a reconnect or a logout then aborted must not start a fresh walk for
            // the generation (or account) that abort was about — nothing would ever
            // cancel it.
            if (historyStale(key, generation)) return false
            val (flight, own) = synchronized(historyFlights) {
                val running = historyFlights[flightKey]
                if (running != null) return@synchronized running to false
                val created = HistoryFlight(
                    job = scope.async(start = CoroutineStart.LAZY) {
                        walkHistory(key, session, peer, generation, prefetch, backfill)
                    },
                    generation = generation,
                    prefetch = prefetch,
                    backfill = backfill.toSet(),
                )
                historyFlights[flightKey] = created
                created.job.invokeOnCompletion {
                    synchronized(historyFlights) {
                        if (historyFlights[flightKey] === created) historyFlights.remove(flightKey)
                    }
                }
                created to true
            }
            if (!own && !flight.covers(generation, prefetch, backfill)) {
                // A different question about the same conversation is on the wire:
                // let it finish rather than download the same pages side by side —
                // unless it is a prefetch of the conversation that is now open, which
                // would discard its page at the merge anyway (see [walkHistory]).
                if (flight.prefetch && !prefetch && peer == viewInterest) flight.job.cancel()
                flight.job.join()
                continue
            }
            if (own) flight.job.start()
            outcome = try {
                flight.job.await()
            } catch (cancelled: CancellationException) {
                currentCoroutineContext().ensureActive()
                HistoryOutcome.Failed
            }
            break
        }
        val failure = CloudFailure(HISTORY_FAILED, peer = peer)
        when (outcome) {
            HistoryOutcome.Merged -> if (accountKey == key) ephemeral.clearFailure(failure)
            HistoryOutcome.GaveUp -> if (
                interactive && viewInterest == peer && !historyStale(key, generation)
            ) {
                // Never over a failure that matters more (a rejected session, a lost
                // link): this strip is about one conversation, those about all of them.
                ephemeral.offerFailure(failure)
            }
            HistoryOutcome.Failed -> Unit
        }
        return outcome == HistoryOutcome.Merged
    }

    /**
     * [loadHistory]'s walk.
     *
     * [prefetch] additionally requires that the cache is still on: the user can
     * switch it off while a page is in flight, and a request that started
     * under the old setting must not be the one thing that writes to a disk
     * they just asked to keep empty. An interactive open has no such guard —
     * the transcript it merges is the very thing the screen reads.
     *
     * Every walk first fills the conversation with its newest [HISTORY_PAGE]
     * rows — one request, unless pages had to shrink, in which case it keeps
     * walking back until it has that many (or the beginning). A backfill walk
     * does this too: a caller that only wants the newest rows may be sharing
     * its flight. The conversation is marked *seeded* only by the page that
     * completes that fill (or reaches the beginning) — never by a shrunk page
     * on the way. Every path that loads a conversation (`selectPeer`,
     * `loadOlder`, `ready`, the prefetch) skips a seeded one, so a walk
     * interrupted after its first fifty rows — a reconnect, a 5xx, a prefetch
     * page discarded because the person just opened the conversation — must
     * leave it unseeded, or those fifty rows would be all it ever gets.
     *
     * [backfill] extends this into "walk back until these ids are here". It is
     * how a gap deeper than one page is closed: the feed named a message, and
     * by definition the newest page is exactly where an older one is *not*. The
     * walk uses the same `before`/`beforeId` pair the server already pages with
     * — a timestamp alone would loop forever on the identical-`ts` boundary a
     * burst of queued messages produces — and it stops at the beginning of the
     * server's history, after `MAX_BACKFILL_PAGES * HISTORY_PAGE` rows, or the
     * moment every id is found, whichever comes first. Ids that were found, and
     * ids the walk proved absent, are cleared from the durable debt; anything
     * else stays owed and is retried by the next pass (from the newest page
     * again — see [MAX_BACKFILL_PAGES]).
     *
     * A page that cannot be *transferred* — `too_large` (over
     * [CloudApi.HISTORY_MAX_BODY_BYTES], or more than the heap could hold) or
     * `transfer_failed` (cut off mid-body, typically the read timeout on a slow
     * link) — is asked for again at the same position with half the page size
     * ([HISTORY_MIN_PAGE] floors it). The Rust core halves on `TooLarge` only;
     * this client also halves on a cut-off body, because on a phone that is
     * what a page too big for the link looks like, and a smaller page is the
     * only thing that gets through it — the cost on a merely flaky link is a
     * few smaller requests, bounded by [MAX_PAGE_ATTEMPTS] per position. The
     * size a walk shrank to is remembered at once — on the halving, and on
     * giving up — for the rest of the walk and for the next walk of this
     * conversation on this connection ([historyLimits]): the next walk (the
     * prefetch retries every [PREFETCH_RETRY_MS]) does not pay for the whole
     * ladder again. "Fewer rows than asked for" is judged against the size
     * actually asked for, so it keeps meaning "the beginning", not "half a
     * page". A network or server failure keeps today's behaviour — this pass
     * gives up, the reconnect/retry cadence tries again.
     */
    private suspend fun walkHistory(
        key: String,
        session: CloudSession,
        peer: String,
        generation: Long?,
        prefetch: Boolean,
        backfill: List<String>,
    ): HistoryOutcome {
        val flightKey = key to peer
        // A push fetch is account-scoped and survives a reconnect generation;
        // interactive/prefetch callers remain bound to their socket generation.
        fun stale() = historyStale(key, generation)
        var before: Long? = null
        var beforeId: String? = null
        val owed = LinkedHashSet(backfill)
        var rows = 0
        var reachedBeginning = false
        // The page size this walk asks for. It only ever shrinks, and only after a body
        // that could not be transferred whole; see the `too_large`/`transfer_failed` arms
        // below. Every "is this page full?" question compares against this, never against
        // [HISTORY_PAGE]: after one halving a full page is half the rows.
        var limit = synchronized(historyFlights) { historyLimits[flightKey] } ?: HISTORY_PAGE
        // Attempts at the current position; a merged page moves the walk and resets it.
        var attempts = 0
        fun remember(size: Int) = synchronized(historyFlights) { historyLimits[flightKey] = size }
        // A page that could not be transferred or held: `null` to ask again at the same
        // position with half the page, or the outcome to end the walk with. Nothing has
        // been merged and `before`/`beforeId` are untouched, so a retry is the same
        // question asked more cheaply rather than a new step of the walk.
        fun shrink(code: String): HistoryOutcome? {
            if (stale()) return HistoryOutcome.Failed
            if (limit <= HISTORY_MIN_PAGE || attempts >= MAX_PAGE_ATTEMPTS) {
                remember(limit)
                logHistoryFailure(peer, code, limit, permanent = true)
                return HistoryOutcome.GaveUp
            }
            limit = maxOf(HISTORY_MIN_PAGE, limit / 2)
            remember(limit)
            return null
        }
        while (true) {
            // Never a request for a socket or an account that is already gone: an abort
            // can land between two pages, and a walk that kept going would be one
            // nothing cancels any more.
            if (stale()) return HistoryOutcome.Failed
            attempts += 1
            val page = try {
                api.history(session, peer, limit = limit, before = before, beforeId = beforeId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: CloudException) {
                when (error.code) {
                    "too_large", "transfer_failed" -> {
                        shrink(error.code)?.let { return it }
                        continue
                    }
                    else -> {
                        // Network, auth, 5xx, a page this client cannot read: the cadence
                        // that already exists — this pass gives up, the reconnect/retry
                        // tries again. Logged so the failure is diagnosable at all: it
                        // used to be swallowed whole.
                        logHistoryFailure(peer, error.code, limit, permanent = false)
                        return HistoryOutcome.Failed
                    }
                }
            } catch (_: OutOfMemoryError) {
                // [CloudApi.history] already answers its own allocation failures with
                // `too_large`; this is the backstop for one that escapes it. The page is
                // unreachable garbage by now, so asking for half of it is safe.
                shrink("too_large")?.let { return it }
                continue
            } catch (_: Exception) {
                logHistoryFailure(peer, "exception", limit, permanent = false)
                return HistoryOutcome.Failed
            }
            if (stale()) return HistoryOutcome.Failed
            if (prefetch && (!cacheEnabled() || peer == viewInterest)) return HistoryOutcome.Failed
            val stored = try {
                repository.applyHistoryPage(
                    accountKey = key,
                    peer = peer,
                    messages = page.messages.map { it.toEntity(key) },
                    peerReadTs = page.peerReadTs,
                    peerReadAt = page.peerReadAt,
                    peerReadVia = page.peerReadVia,
                    peerDeliveredTs = page.peerDeliveredTs,
                    // Seeded only by the page that completes the newest-rows fill or
                    // reaches the beginning; see the KDoc above.
                    seed = page.messages.size < limit || rows + page.messages.size >= HISTORY_PAGE,
                )
            } catch (_: OutOfMemoryError) {
                // The merge holds the page a second time (every data URL decoded and
                // encrypted into the media cache, up to the body bound's worth): out of
                // heap there is the same answer as out of heap while reading. No row of
                // the page is committed — the media stage runs before the transaction,
                // and the transaction rolls back on any throw — so ask again for less,
                // rather than let an `Error` reach every caller sharing this walk (and
                // skip the sync pass's `finishSyncPass`).
                shrink("too_large")?.let { return it }
                continue
            }
            if (!stored) {
                storeRefused()
                return HistoryOutcome.Failed
            }
            rows += page.messages.size
            attempts = 0
            remember(limit)
            // The page itself is proof of acceptance: every own message in it was
            // committed by the server, so a send whose acceptance frame never came
            // back has an answer here. Without this the operation behind it stays
            // queued and is replayed at every `pump()` for a message the server
            // already holds — answered each time with the receipt the original send
            // missed, which is a retry that can never make progress.
            val accepted = page.messages.asSequence().filter { it.mine }.map { it.id }.toList()
            if (accepted.isNotEmpty()) repository.acceptByServerProof(key, peer, accepted)
            for (id in owed.toList()) if (repository.hasMessage(key, peer, id)) owed.remove(id)
            val wanted = rows < HISTORY_PAGE || owed.isNotEmpty()
            if (!wanted) break
            // "Fewer rows than asked for" is the server saying there is nothing
            // older — the same signal the open conversation's scroll uses to
            // stop asking. "Asked for" is the size this request actually named:
            // after a halving, a full page is [limit] rows, not [HISTORY_PAGE].
            reachedBeginning = page.messages.isEmpty() || page.messages.size < limit
            if (reachedBeginning || rows >= MAX_BACKFILL_PAGES * HISTORY_PAGE) break
            val oldest = page.messages.minByOrNull { it.ts } ?: break
            if (oldest.id == beforeId) break
            before = oldest.ts
            beforeId = oldest.id
        }
        if (backfill.isNotEmpty()) {
            // Closed either way: found, or — when the walk reached the start of
            // the server's history for this pair — provably not there at all (a
            // tombstone past the retention window, or a message this account
            // hid from its own side). Leaving the second kind owed would keep
            // the conversation on the worklist for the life of the install.
            val settled = backfill.filter { it !in owed } + if (reachedBeginning) owed.toList() else emptyList()
            if (settled.isNotEmpty() && !repository.clearBackfill(key, peer, settled)) storeRefused()
        }
        return HistoryOutcome.Merged
    }

    /** Whether a walk for [key] bound to [generation] is for a socket or an account that is
     *  already gone. A push fetch ([generation] `null`) is account-scoped and survives a
     *  reconnect; every other caller is bound to the socket generation it started on. */
    private fun historyStale(key: String, generation: Long?): Boolean =
        (generation != null && !ephemeral.current(generation)) || accountKey != key

    /** One history walk gave up: the reason's code and the page size, and the peer only as
     *  a short one-way digest — enough to tell one conversation's repeated failures from
     *  another's in a device log, without a login in it (nothing in this package logs one).
     *  Before this, every failure here was `runCatching { … }.getOrNull()` and a frozen
     *  conversation could not be diagnosed from a device at all. */
    private fun logHistoryFailure(peer: String, code: String, limit: Int, permanent: Boolean) {
        Log.w(TAG, "history fetch failed: peer#${peerDigest(peer)} code=$code limit=$limit permanent=$permanent")
    }

    private fun peerDigest(peer: String): String =
        MessageDigest.getInstance("SHA-256").digest(peer.toByteArray(Charsets.UTF_8))
            .take(4).joinToString("") { "%02x".format(it) }

    private suspend fun notifyIfEligible(key: String, peer: String, messageId: String, visible: Boolean) {
        val candidate = repository.claimNotification(key, peer, messageId, visible) ?: return
        listener.onUnreadNotification(
            CloudUnreadNotification(
                accountKey = candidate.accountKey,
                peer = candidate.peer,
                messageId = candidate.messageId,
                author = candidate.author,
                text = candidate.text,
                ts = candidate.ts,
            ),
        )
    }

    // ---- prefetch --------------------------------------------------------

    /** One conversation the walk still owes history for, with the two numbers
     *  that decide its turn. */
    private data class Candidate(val peer: String, val unread: Int, val previewTs: Long)

    /**
     * Loads the transcripts this device does not hold yet, in the background.
     *
     * Until this existed, the roster arrived complete and every thread under it
     * was empty until somebody opened it — a freshly logged-in phone paid one
     * round trip per conversation, in the order they were tapped, and a
     * conversation nobody opened was not cached at all, which is not what
     * «Conversation cache» promises. This is that missing half: after the
     * roster is durable, walk it.
     *
     * What the walk is careful about:
     *  - the open conversation is never a candidate — [refreshHistory] serves
     *    it at once, and nothing here may make it wait;
     *  - unread first, then newest activity ([Candidate.previewTs]), because a
     *    badge the user can see matters more than a thread scrolled past;
     *  - at most [HISTORY_CONCURRENCY] requests in flight, one attempt per
     *    conversation per connection ([prefetched] — a transcript that is still
     *    missing after one try is not hammered);
     *  - anything already seeded is skipped;
     *  - it stops on the first sign that it is no longer wanted: a new
     *    generation (reconnect, logout, account switch — `invalidate` cancels
     *    this job as well) or the cache being switched off;
     *  - it writes only history and the preview it implies. No unread count,
     *    no read receipt, no subscription, no view interest: those are the
     *    user's own state and a background walk has no business inventing it.
     */
    private fun prefetch(generation: Long) {
        if (closed || !ephemeral.current(generation) || !cacheEnabled()) return
        if (prefetchJob?.isActive == true) return
        val key = accountKey ?: return
        val session = session ?: return
        prefetchJob = scope.launch {
            try {
                walkRoster(key, session, generation)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // A background convenience must never be the reason the app
                // dies: whatever went wrong here is retried by the next
                // connection's own walk.
            } finally {
                prefetchJob = null
            }
        }
    }

    private suspend fun walkRoster(key: String, session: CloudSession, generation: Long) {
        val self = session.user.login
        while (ephemeral.current(generation) && cacheEnabled()) {
            if (ephemeral.state.value.link != CloudLink.Online) return
            val now = monotonicMs()
            val rows = repository.conversationSnapshot(key)
            val candidates = ArrayList<Candidate>(rows.size + 1)
            for (row in rows) {
                if (row.historySeeded || row.peer in prefetched || row.peer == viewInterest) continue
                val retryAt = prefetchRetryAt[row.peer]
                if (retryAt != null && retryAt > now) continue
                candidates += Candidate(row.peer, row.unread, row.previewTs)
            }
            // Saved Messages is this account talking to itself, so the server
            // never lists it among the friends and it has no roster row to be
            // found by — the thread is named here instead.
            if (self !in prefetched && self != viewInterest && candidates.none { it.peer == self }) {
                candidates += Candidate(self, 0, 0L)
            }
            if (candidates.isEmpty()) {
                // Everything either has its history or is waiting out its own
                // backoff. Waiting is the honest answer: a walk that retried
                // immediately would be a loop against a server that is already
                // refusing, and one that gave up would never heal a single
                // dropped request.
                val earliest = prefetchRetryAt.values.minOrNull() ?: return
                val wait = earliest - monotonicMs()
                if (wait <= 0) continue
                delay(minOf(wait, PREFETCH_RETRY_MS))
                continue
            }
            candidates.sortWith(
                compareByDescending<Candidate> { it.unread > 0 }.thenByDescending { it.previewTs },
            )
            for (batch in candidates.chunked(HISTORY_CONCURRENCY)) {
                if (!ephemeral.current(generation) || !cacheEnabled()) return
                coroutineScope {
                    // Results are collected and the bookkeeping is written after
                    // the batch settles: the set is shared with the coroutines
                    // above it, and a peer is only recorded as done when its page
                    // actually arrived.
                    val results = batch.map { candidate ->
                        async {
                            candidate to loadHistory(key, session, candidate.peer, generation, prefetch = true)
                        }
                    }.awaitAll()
                    for ((candidate, fetched) in results) {
                        if (fetched) {
                            prefetched += candidate.peer
                            prefetchRetryAt.remove(candidate.peer)
                        } else {
                            prefetchRetryAt[candidate.peer] = monotonicMs() + PREFETCH_RETRY_MS
                        }
                    }
                }
            }
        }
    }

    // ---- receipts --------------------------------------------------------

    private fun queueReceipt(peer: String, id: String, read: Boolean) {
        if (!enqueueReceipt(Receipt(peer, id, read))) return
        pumpReceipts()
    }

    /**
     * One drain at a time.
     *
     * This started as a `receiptJob?.isActive` guard, which is not a guard at
     * all: the flag is written on one thread and read on another, with nothing
     * ordering the two, and the failure it produced was subtle rather than
     * loud — two drains running side by side, both peeking the same head, so
     * the peer received some receipts twice and in the wrong order. A coroutine
     * [Mutex] serialises them regardless of which thread or dispatcher resumes
     * either one, and every caller simply waits its turn and then drains
     * whatever is left.
     */
    private val drainLock = Mutex()

    private fun pumpReceipts() {
        if (closed) return
        scope.launch {
            drainLock.withLock { drainReceipts() }
        }
    }

    /** Server-owned events survive reconnects; only the visible peer may acknowledge them. */
    fun readReactionEvents(peer: String, ids: List<String>) {
        if (peer != viewInterest || ids.isEmpty()) return
        pendingReactionReads.getOrPut(peer) { linkedSetOf() }.addAll(ids)
        pumpReactionReads()
    }

    private fun acceptReactionRoster(users: List<CloudUser>) {
        ephemeral.setReactionEvents(users)
        val unread = users.associate { user -> user.login to user.reactionEvents.mapTo(HashSet()) { it.id } }
        for ((peer, ids) in pendingReactionReads) ids.retainAll(unread[peer].orEmpty())
        for ((peer, ids) in sentReactionReads) ids.retainAll(unread[peer].orEmpty())
    }

    private fun pumpReactionReads() {
        val peer = viewInterest ?: return
        if (closed || !foreground || ephemeral.state.value.link != CloudLink.Online ||
            CloudSocket.CAP_REACTION_READ !in ephemeral.state.value.serverCaps ||
            pendingReactionReads[peer].isNullOrEmpty() || reactionReadJob?.isActive == true) return
        val generation = ephemeral.generation
        reactionReadJob = scope.launch {
            while (foreground && viewInterest == peer && ephemeral.current(generation)) {
                val waiting = pendingReactionReads[peer] ?: break
                if (waiting.isEmpty()) break
                val ids = waiting.take(100)
                val conn = connection ?: break
                pace()
                if (!foreground || viewInterest != peer || !ephemeral.current(generation) || connection !== conn) break
                if (!conn.readReactionEvents(peer, ids)) break
                waiting.removeAll(ids.toSet())
                sentReactionReads.getOrPut(peer) { linkedSetOf() }.addAll(ids)
            }
            reactionReadJob = null
            if (viewInterest != peer) pumpReactionReads()
        }
    }

    /**
     * Sends every receipt the queue holds, recording the incoming rows whose
     * read receipt has actually left the socket **and whose batch was not
     * reported throttled while it was going out**.
     *
     * `conn.sendReceipt` returning `true` only means OkHttp accepted the
     * frame into its own send queue, not that the hub processed it: the
     * frame-budget soft-drop (`k:"throttle"`, `hub.js`'s `chargeFrame`) lets
     * an over-budget frame through OkHttp and then silently discards it
     * server-side — with no id in the notice to say which one. There is no
     * way to blame a single frame in [readAcked] for a throttle notice that
     * arrives asynchronously some time later, so [commitOrDiscardReceipts]
     * judges a whole accumulating batch at once: if [throttleEvents] moved at
     * all since the batch started, the hub may have dropped any frame in it,
     * so none of them are marked read. Their rows stay `delivery < Read` in
     * Room, which is what makes the next drain — this connection's, once the
     * server has room again, or the next connection's replay of
     * `unreadIncoming` — send them again instead of losing them forever. A
     * whole batch (at most [RECEIPT_READ_BATCH]) is coarser than one frame,
     * but it is the granularity a notice with no id in it actually supports.
     *
     * Collecting the rows and writing them in batches keeps the disk off the
     * per-frame path without ever claiming a receipt that was merely *queued*.
     * The loop re-checks the queue on every pass, which is what makes it safe
     * for more than one caller to have asked for a drain: whoever gets the lock
     * last finds an empty queue and does nothing.
     */
    private suspend fun drainReceipts() {
        val generation = ephemeral.generation
        val readAcked = ArrayList<String>(RECEIPT_READ_BATCH)
        var batchStartedAt = throttleEvents
        while (ephemeral.current(generation)) {
            // Taken under the queue's own lock, because filling it runs on the
            // frame's thread: see [receiptQueue].
            val next = peekReceipt() ?: break
            val conn = connection ?: break
            // Receipts are only routable to the subscribed peer on any server;
            // an addressed-send server takes them anywhere.
            val addressed = CloudSocket.CAP_ADDRESSED_SEND in ephemeral.state.value.serverCaps
            if (!addressed && subscribedPeer != next.peer) break
            pace()
            if (!conn.sendReceipt(next.peer, next.id, next.read)) break
            dropReceipt()
            if (next.read) {
                if (CloudSocket.CAP_READ_ACK in ephemeral.state.value.serverCaps) {
                    // A capable server owns the durable fact now: this id
                    // stays unread in Room — and so eligible for the next
                    // [flushReads] — until `read-accepted` actually names it,
                    // not merely because the frame left unthrottled.
                    pendingMessageReadAcks[next.id] = next.peer
                } else {
                    readAcked += next.id
                    if (readAcked.size >= RECEIPT_READ_BATCH) batchStartedAt = commitOrDiscardReceipts(readAcked, batchStartedAt)
                }
            }
        }
        // Whatever the loop stopped on, the trailing partial batch is judged
        // the same way as every full one above.
        commitOrDiscardReceipts(readAcked, batchStartedAt)
    }

    /**
     * Flushes [ids] as read unless a throttle notice landed while they were
     * being sent (`throttleEvents` moved since [since]) — see [drainReceipts]
     * for why that makes the whole batch unconfirmed rather than just one
     * frame of it. Clears [ids] either way and returns the current
     * [throttleEvents] count for the next batch to compare against.
     */
    private suspend fun commitOrDiscardReceipts(ids: MutableList<String>, since: Int): Int {
        if (throttleEvents == since) flushReadReceipts(ids) else ids.clear()
        return throttleEvents
    }

    /**
     * Records that these incoming rows have been read as far as the peer is
     * concerned — the write that makes [flushReads] finite. See
     * `MessageDao.markIncomingRead`.
     */
    private suspend fun flushReadReceipts(ids: MutableList<String>) {
        val key = accountKey ?: return
        if (ids.isEmpty()) return
        val batch = ids.toList()
        ids.clear()
        if (!repository.markIncomingRead(key, batch)) storeRefused()
    }

    /** Automatic receipts require a foreground viewer, including after Room
     *  resumes: a retained subscription is not somebody reading the thread. */
    private fun flushReads(peer: String, explicit: Boolean = false, visibleIds: List<String>? = null) {
        if (!explicit && (!foreground || viewInterest != peer)) return
        val key = accountKey ?: return
        scope.launch {
            val ids = if (visibleIds == null) repository.unreadIncoming(key, peer, RECEIPT_LIMIT)
            else repository.unreadIncomingAmong(key, peer, visibleIds)
            if (accountKey != key || (!explicit && (!foreground || viewInterest != peer))) return@launch
            for (id in ids) queueReceipt(peer, id, read = true)
            pumpReceipts()
        }
    }

    /** A Compose update may run while the activity is stopped. Read only the
     *  displayed ids, never a bulk server watermark that could include unseen
     *  messages committed after that update. Explicit actions use the method below. */
    fun markVisibleMessagesRead(peer: String, ids: List<String>) {
        flushReads(peer, visibleIds = ids)
    }

    /** The bulk watermark jump, queued durably so it survives being offline. */
    fun markConversationRead(peer: String) {
        val key = accountKey ?: return
        scope.launch {
            val now = clock()
            repository.setUnread(key, peer, 0)
            repository.suppressReadNotifications(key, peer, Long.MAX_VALUE)
            listener.onNotificationsCleared(peer)
            repository.enqueueOperation(
                PendingOperationEntity(
                    opId = "read:$key:$peer",
                    accountKey = key,
                    peer = peer,
                    kind = "read",
                    messageId = null,
                    payloadJson = "{}",
                    attempts = 0,
                    nextAttemptAt = now,
                    lastError = null,
                    errorKind = ErrorKind.None.ordinal,
                    leaseOwner = null,
                    leaseUntil = 0,
                    createdAt = now,
                ),
            )
            flushReads(peer, explicit = true)
            pump()
        }
    }

    // ---- typing ----------------------------------------------------------

    /**
     * One keystroke. The lease is renewed well inside the receiver's TTL for as
     * long as the composer keeps moving, which is the half that was missing:
     * a single `start` frame plus a four-second timeout cannot survive somebody
     * thinking mid-sentence.
     */
    fun keystroke(peer: String) {
        if (ephemeral.state.value.link != CloudLink.Online) return
        if (typingPeer != null && typingPeer != peer) stopOwnTyping()
        typingPeer = peer
        if (typingLeaseJob?.isActive == true) return
        typingLeaseJob = scope.launch {
            var idle = 0L
            pace()
            connection?.sendTyping(peer, "start")
            while (idle < TYPING_MAX_IDLE_MS) {
                delay(TYPING_RENEW_MS)
                if (typingPeer != peer) return@launch
                idle = SystemClock.elapsedRealtime() - lastKeystrokeAt
                if (idle >= TYPING_MAX_IDLE_MS) break
                pace()
                connection?.sendTyping(peer, "start")
            }
            stopOwnTyping()
        }
    }

    @Volatile private var lastKeystrokeAt = 0L

    fun noteKeystroke() {
        lastKeystrokeAt = SystemClock.elapsedRealtime()
    }

    /** Ends this side's indicator: composer quiet, message sent, peer switched,
     *  or the link standing down. Never sends a stop to a different peer. */
    fun stopOwnTyping() {
        val peer = typingPeer ?: return
        typingPeer = null
        typingLeaseJob?.cancel()
        typingLeaseJob = null
        // A single frame, not a loop — still goes through the shared budget
        // (FramePacer's own invariant is "every outbound frame"), fired via
        // scope.launch rather than making this whole function suspend, since
        // it is called synchronously from view/peer-switch/foreground paths
        // that must update `typingPeer`/cancel the lease immediately.
        scope.launch { pace(); connection?.sendTyping(peer, "stop") }
    }

    // ---- liveness --------------------------------------------------------

    private fun startWatchdog(session: CloudSession, generation: Long) {
        watchdogJob?.cancel()
        lastInboundAt = SystemClock.elapsedRealtime()
        watchdogJob = scope.launch {
            while (ephemeral.current(generation)) {
                val wait = if (foreground) PROBE_INTERVAL_MS else BACKGROUND_PROBE_INTERVAL_MS
                delay(wait)
                if (!ephemeral.current(generation)) return@launch
                if (ephemeral.state.value.link != CloudLink.Online) continue
                if (SystemClock.elapsedRealtime() - lastInboundAt < wait) continue
                probe(session, generation)
            }
        }
    }

    private fun probeNow(session: CloudSession) {
        val generation = ephemeral.generation
        scope.launch { probe(session, generation) }
    }

    private suspend fun probe(session: CloudSession, generation: Long, retry: Boolean = true) {
        if (!ephemeral.current(generation)) return
        val before = lastInboundAt
        if (connection?.sendWho() != true) {
            if (ephemeral.current(generation) && !standingDown) connect(session)
            return
        }
        val sentAt = SystemClock.elapsedRealtime()
        delay(PROBE_TIMEOUT_MS)
        if (!ephemeral.current(generation)) return
        // `delay` does not run while the device sleeps, so a Doze window makes
        // the wall clock overshoot by minutes while no answer ever had a chance
        // to arrive. Reconnecting on that is a burst on every screen-on — but
        // *abandoning* the question is how a dead socket survived a screen-on:
        // the probe that was supposed to catch it slept through its own
        // window, returned without a verdict, and in the background the next
        // one was five minutes away. So ask again, once, now that the device
        // is actually awake.
        if (SystemClock.elapsedRealtime() - sentAt > PROBE_TIMEOUT_MS * 3) {
            if (retry && !standingDown) probe(session, generation, retry = false)
            return
        }
        if (lastInboundAt == before && !standingDown) {
            ephemeral.setLink(CloudLink.Offline)
            connect(session)
        }
    }

    private fun CloudUser.toConversationRow(accountKey: String) = ChatRepository.RosterRow(
        accountKey = accountKey,
        peer = login,
        name = name,
        online = online,
        lastSeen = lastSeen,
        unread = pending,
        previewFrom = preview?.from,
        previewText = preview?.text,
        previewMedia = preview?.media,
        previewTs = preview?.ts ?: 0L,
        official = official,
        blocked = blocked,
        bot = bot,
        alias = alias?.takeIf(String::isNotBlank),
    )

    private companion object {
        val OP_ACK_KINDS = setOf("edit", "react", "delete")
        val TERMINAL_AUTH_CODES = setOf("auth_failed", "auth_required", "unknown_token")

        /** Logcat tag for the one thing this class now reports: a history fetch that gave
         *  up, so a frozen conversation is diagnosable from a device at all. */
        const val TAG = "TailchatSync"

        /** [CloudFailure.code] of the one banner a history walk can raise; `cloudFailureText`
         *  names the conversation from [CloudFailure.peer]. See [loadHistory]. */
        const val HISTORY_FAILED = "history_failed"

        const val RETRY_MS = 1_000L
        const val RETRY_MAX_MS = 30_000L
        const val RETRY_RATE_LIMITED_MS = 10_000L
        const val STABLE_AFTER_MS = 30_000L
        const val OP_RETRY_MAX_MS = 5 * 60_000L
        /** How long an old server is given before the same operation is
         *  reconsidered; long enough not to spin, short enough that opening the
         *  conversation is not the only way out. */
        const val OLD_SERVER_RETRY_MS = 20_000L
        /** How long one message may wait for `message-accepted` before it goes
         *  back to the queue. Generous: a slow mobile link that answers in four
         *  seconds is healthy. */
        const val ACK_TIMEOUT_MS = 20_000L
        const val MAX_ATTEMPTS = 8
        const val MAX_IN_FLIGHT = 8
        const val CLAIM_BATCH = 32
        /** How many history pages the prefetch walk keeps in flight. Two is
         *  enough to hide one round trip behind another and few enough that a
         *  long roster does not open a dozen sockets' worth of work at once. */
        const val HISTORY_CONCURRENCY = 2
        const val IN_FLIGHT_POLL_MS = 1_000L
        const val SYNC_PAGE = 200

        /**
         * How many messages one history request asks for first.
         *
         * The server's own default (`HISTORY_DEFAULT_LIMIT`), named here because
         * the paging loop below reasons about it: a page that comes back shorter
         * than the `limit` that request named is the server saying there is
         * nothing older, which is how the backfill walk knows it has reached the
         * beginning of the pair's history rather than merely run out of pages.
         * That `limit` is this number until a page too large to transfer made the
         * walk ask for fewer ([HISTORY_MIN_PAGE]); it is also how many of the
         * newest rows an opened conversation is filled with, however many
         * requests that takes.
         */
        const val HISTORY_PAGE = CloudApi.HISTORY_PAGE_DEFAULT

        /**
         * The smallest page a walk may shrink to. One message is the floor because that is
         * the smallest question the endpoint can answer, and a single message is the one
         * page size the server's own media ceiling guarantees fits (`CLOUD_MEDIA_MAX_CHARS`).
         */
        const val HISTORY_MIN_PAGE = 1

        /**
         * How many attempts one history *position* may cost while shrinking the page —
         * reset by every page that is merged. 200 → 100 → 50 → … → 1 is eight, so this
         * only ever stops a broken loop, never a real halving walk.
         */
        const val MAX_PAGE_ATTEMPTS = 12

        /**
         * The bound on a backfill walk, in default-sized pages — five thousand
         * rows walked back per gap (`MAX_BACKFILL_PAGES * HISTORY_PAGE`), counted
         * in rows so a walk whose pages had to shrink covers the same depth with
         * more requests instead of a twelfth of it. Not a limit on what a
         * conversation may contain: this exists so that one very old, very deep
         * gap cannot turn a reconnect into an unbounded HTTP walk. Whatever is
         * left after this is still owed on disk; the next pass walks again from
         * the newest page — the position a walk reached is not persisted, so a
         * gap deeper than this bound is never reached by any number of passes.
         */
        const val MAX_BACKFILL_PAGES = 25

        /** How many conversations one sync pass will pay off backfill debt for.
         *  The rest wait for the next pass rather than delaying this one. */
        const val BACKFILL_PEERS_PER_PASS = 5

        /**
         * How long a conversation whose history fetch failed waits before the
         * same connection tries it again. Long enough not to hammer a server
         * that is refusing, short enough that a single dropped request heals
         * inside the session rather than at the next reconnect.
         */
        const val PREFETCH_RETRY_MS = 30_000L

        /**
         * How many owed read receipts one [flushReads] may collect — the bound
         * on what a single reconnect can replay. Two hundred frames at the
         * pacer's 37.5/second is a few seconds of a connection's budget, and
         * `MessageDao.markIncomingRead` means the next flush starts from zero
         * instead of from the whole conversation.
         */
        const val RECEIPT_LIMIT = 200

        /**
         * How many of those receipts are sent before their rows are recorded as
         * read. A disk write per frame would put the store on the hot path of a
         * burst; one per thirty-two is a handful of writes for a full flush.
         */
        const val RECEIPT_READ_BATCH = 32
        const val PROBE_INTERVAL_MS = 25_000L
        const val BACKGROUND_PROBE_INTERVAL_MS = 5 * 60_000L
        const val PROBE_TIMEOUT_MS = 8_000L
        /** Renewed well inside [EphemeralState.TYPING_TTL_MS]. */
        const val TYPING_RENEW_MS = 3_000L
        const val TYPING_MAX_IDLE_MS = 4_000L
    }
}
