package net.tailchat.android.cloud

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Everything true of a moment rather than of the conversation: the link, who is
 * typing, who is online, and which peer the UI has declared an interest in.
 *
 * None of it is written to Room. A typing tick is not a fact about the
 * conversation — persisting one would put a disk write on every keystroke, and
 * restoring one after a restart would show an indicator for a peer who stopped
 * typing yesterday. Every entry is therefore scoped to a [generation] (the
 * socket that produced it) and carries its own TTL: a lost `stop` frame expires
 * on its own instead of leaving «печатает…» on screen forever.
 */
class EphemeralState(private val scope: CoroutineScope) {

    data class Snapshot(
        val link: CloudLink = CloudLink.SignedOut,
        /** Capabilities the connected server announced; empty when offline or
         *  when the server predates the handshake. */
        val serverCaps: Set<String> = emptySet(),
        val typingPeers: Set<String> = emptySet(),
        /**
         * Logins the server currently sees on a connection that announced the
         * call capability. Liveness, not a property of the account: it is never
         * written to Room, because a stored `callable` would ring into a phone
         * that went offline hours ago.
         */
        val callablePeers: Set<String> = emptySet(),
        /** Unread reaction state is durable on the server and replaced by each full roster. */
        val reactionEvents: Map<String, List<CloudReactionEvent>> = emptyMap(),
        /**
         * The conversation this connection is actually subscribed to on the
         * server — the hub's own `conn.peer`, as acknowledged by `subscribed`.
         *
         * Published here rather than left inside [SyncEngine] because the
         * composer's hint reads it: a private field can only be *sampled*, and
         * the sample used to be taken when the transcript flow emitted, which
         * is before the ack comes back. A conversation nothing writes to while
         * it is open (Saved Messages, any already-seeded thread) therefore
         * never got a second sample and kept saying «will send when
         * connected» for the whole visit.
         */
        val subscribedPeer: String? = null,
        /**
         * Message ids with a «напомнить ответить» pending on them, as the hub
         * reports them: the id the setting client was answered with, and the
         * whole pending set again on every `auth` (`src/cloud/hub.js`'s
         * `authenticate`). Ephemeral for the same reason a typing tick is —
         * it is state of *now*, and the server is the one that knows it — but
         * not scoped to a socket: a mark only means «pending», so a fired
         * reminder clears it and a reconnect is answered from the store.
         */
        val reminderIds: Set<String> = emptySet(),
        val failure: CloudFailure? = null,
        /** Set when the server cannot honour the durable contract, so the UI can
         *  say so instead of showing a queue that looks like it is moving. */
        val degraded: String? = null,
        /**
         * The local store refused a durable write — a full disk, in practice.
         * Sticky for the life of the process: a disk that filled up once is not
         * evidence that it stopped being full, and a banner that flickered with
         * every retry would be worse than one that stays until a restart.
         */
        val storeFailed: Boolean = false,
    )

    private val mutable = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = mutable.asStateFlow()

    private val typingJobs = mutableMapOf<String, Job>()

    @Volatile
    var generation: Long = 0L
        private set

    /** A new socket: every ephemeral fact from the old one is void. */
    fun newGeneration(): Long {
        generation += 1
        typingJobs.values.forEach(Job::cancel)
        typingJobs.clear()
        mutable.update {
            it.copy(
                typingPeers = emptySet(),
                serverCaps = emptySet(),
                callablePeers = emptySet(),
                subscribedPeer = null,
            )
        }
        return generation
    }

    fun current(generation: Long): Boolean = generation == this.generation

    /**
     * Anything other than an established link voids [Snapshot.callablePeers]
     * and [Snapshot.subscribedPeer]: both are only as good as the socket that
     * reported them, and a subscription does not survive its connection.
     */
    fun setLink(link: CloudLink) = mutable.update { snapshot ->
        if (link == CloudLink.Online) snapshot.copy(link = link)
        else snapshot.copy(link = link, callablePeers = emptySet(), subscribedPeer = null)
    }

    /** The hub acknowledged `subscribe` for [peer] — or, with `null`, this
     *  connection is no longer a viewer of any conversation. */
    fun setSubscribed(peer: String?) = mutable.update { it.copy(subscribedPeer = peer) }

    /**
     * Replaces the callable set wholesale — both frames that carry it (`ready`
     * and `users`) carry the entire roster, so merging would keep a peer who
     * just dropped their call-capable connection.
     */
    fun setCallable(peers: Set<String>) = mutable.update { it.copy(callablePeers = peers) }

    fun setReactionEvents(users: List<CloudUser>) = mutable.update { snapshot ->
        snapshot.copy(reactionEvents = users.associate { it.login to it.reactionEvents })
    }

    /**
     * A «напомнить ответить» this account has set: the hub's own
     * `reply-reminder-set`, or the one this client just asked for — the mark
     * is worth showing before the round trip lands, and the hub's answer
     * repeats it rather than contradicting it.
     *
     * Deliberately *not* cleared with the socket ([newGeneration]): a pending
     * reminder does not stop being pending because the link dropped, and every
     * reconnect is answered with the whole pending set again. What a
     * disconnect can therefore leave behind is only a mark for a reminder that
     * fired and was acknowledged by another device while this one was away —
     * which is the same lifetime the web client's mark has.
     */
    fun markReminder(messageId: String) = mutable.update { it.copy(reminderIds = it.reminderIds + messageId) }

    /** The reminder came due: the mark means «pending», not «was ever set»
     *  (`web/cloud/app.js`'s `markMessageReminded`). */
    fun clearReminder(messageId: String) = mutable.update { it.copy(reminderIds = it.reminderIds - messageId) }

    fun setCaps(caps: Set<String>) = mutable.update { snapshot ->
        snapshot.copy(
            serverCaps = caps,
            degraded = MISSING_CAP_TEXT.entries.firstOrNull { it.key !in caps }?.value,
        )
    }

    /** The local store refused a write — see [Snapshot.storeFailed]. */
    fun setStoreFailed() = mutable.update { it.copy(storeFailed = true) }

    fun setFailure(failure: CloudFailure?) = mutable.update { it.copy(failure = failure) }

    /** Clears [failure] only if it is still the one shown: a success that answers one
     *  failure must not wipe a different one that has replaced it since. */
    fun clearFailure(failure: CloudFailure) = mutable.update {
        if (it.failure == failure) it.copy(failure = null) else it
    }

    /** Shows [failure] only where nothing else is shown, or where the one shown is of the
     *  same kind (the same banner about another conversation): a strip about one thread
     *  must not hide one about the session or the link. */
    fun offerFailure(failure: CloudFailure) = mutable.update {
        val shown = it.failure
        if (shown == null || shown.code == failure.code) it.copy(failure = failure) else it
    }

    /**
     * Marks [peer] as typing until the TTL runs out. Re-marking restarts the
     * timer, which is what keeps a continuing typist's indicator alive: the
     * sender renews its lease well inside [TYPING_TTL_MS], and the TTL only
     * fires when the `stop` frame was genuinely lost.
     */
    fun markTyping(peer: String, generation: Long) {
        if (!current(generation)) return
        typingJobs.remove(peer)?.cancel()
        mutable.update { it.copy(typingPeers = it.typingPeers + peer) }
        typingJobs[peer] = scope.launch {
            delay(TYPING_TTL_MS)
            if (!current(generation)) return@launch
            typingJobs.remove(peer)
            mutable.update { it.copy(typingPeers = it.typingPeers - peer) }
        }
    }

    fun clearTyping(peer: String) {
        typingJobs.remove(peer)?.cancel()
        mutable.update { it.copy(typingPeers = it.typingPeers - peer) }
    }

    fun clearAllTyping() {
        typingJobs.values.forEach(Job::cancel)
        typingJobs.clear()
        mutable.update { it.copy(typingPeers = emptySet()) }
    }

    fun reset() {
        newGeneration()
        mutable.value = Snapshot()
    }

    companion object {
        /**
         * How long a typing indicator survives without renewal. Longer than the
         * sender's own renewal interval so an ordinary pause between words does
         * not flicker the line, short enough that a dropped `stop` is not
         * visible for more than a breath.
         */
        const val TYPING_TTL_MS = 6_000L

        private val MISSING_CAP_TEXT = linkedMapOf(
            CloudSocket.CAP_DURABLE_ACK to "durable_ack_unsupported",
            CloudSocket.CAP_SYNC to "sync_unsupported",
            CloudSocket.CAP_ADDRESSED_SEND to "addressed_send_unsupported",
        )
    }
}
