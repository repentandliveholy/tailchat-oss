package net.tailchat.android.call

/**
 * One call at a time, process-wide — [CallController] never holds more than
 * one of these live. Every mutation goes through [CallTransitions] so the
 * rules are testable without `PeerConnection`/`AudioManager` in sight, the
 * same split [VoicePlaybackTransitions] already uses for playback.
 *
 * `Idle → Outgoing → Ringing → Connecting → Active → Ended(reason)`, plus the
 * callee-side path that never has an `Outgoing` state of its own
 * (`Idle → Ringing → Connecting → Active → Ended`).
 */
sealed interface CallState {
    data object Idle : CallState

    /** This device placed the call; waiting for the callee's `call-ring` or
     *  `call-answer` (or nothing, until [CallTransitions.ringTimeout]). */
    data class Outgoing(val callId: String, val peer: String, val placedAtMs: Long) : CallState

    /** Either direction: the callee has been told, nobody has answered yet.
     *  [isIncoming] distinguishes the two UIs (full-screen "incoming call"
     *  vs. the caller's own "ringing…") without a second state. */
    data class Ringing(val callId: String, val peer: String, val isIncoming: Boolean, val startedAtMs: Long) : CallState

    /** SDP exchanged, ICE gathering/connecting — ends in [Active] or
     *  [Ended] with reason [CallEndReason.Failed]. */
    data class Connecting(val callId: String, val peer: String, val isIncoming: Boolean) : CallState

    data class Active(val callId: String, val peer: String, val isIncoming: Boolean, val connectedAtMs: Long) : CallState

    data class Ended(val callId: String, val peer: String, val reason: CallEndReason) : CallState
}

/** The call a state is "about", or null for [CallState.Idle]/[CallState.Ended]
 *  — an ended call is already over, so nothing should keep addressing it. */
fun CallState.activeCallId(): String? = when (this) {
    is CallState.Outgoing -> callId
    is CallState.Ringing -> callId
    is CallState.Connecting -> callId
    is CallState.Active -> callId
    CallState.Idle, is CallState.Ended -> null
}

/**
 * What actually happened to one call, as this device saw it — the raw
 * material `CallController` hands its `onCallEnded` callback so §4.5's call
 * log can be written without this package knowing `MessageEntity` exists.
 * [peerName] is best-effort (whatever the roster had resolved by the time the
 * call ended, or the bare login if it never did) since this is the only
 * moment the name is still at hand — once the call is over, `CallController`
 * forgets it.
 */
data class CallLogEntry(
    val callId: String,
    val peer: String,
    val peerName: String,
    /** `true` for a call this device received, `false` for one it placed. */
    val incoming: Boolean,
    /** Reached [CallState.Active] at least once. */
    val everActive: Boolean,
    val reason: CallEndReason,
    /** Seconds between [CallState.Active.connectedAtMs] and [endedAtMs]; 0
     *  when [everActive] is `false`. */
    val durationSec: Int,
    val endedAtMs: Long,
)

/**
 * Pure transition table. No socket, no `PeerConnection`, no timer — every
 * rule about what one signal or one user action does to [CallState] lives
 * here; [CallController] only calls this and then acts on the WebRTC/audio
 * side effects the result implies.
 */
object CallTransitions {
    /** User (or another of this account's own devices, via `call-taken`)
     *  places a call. Refused — returns `current` unchanged — when a call is
     *  already in progress: this device answers or ends one call at a time,
     *  same as the phone app it replaces. */
    fun place(current: CallState, callId: String, peer: String, atMs: Long): CallState =
        if (current is CallState.Idle || current is CallState.Ended) {
            CallState.Outgoing(callId, peer, atMs)
        } else {
            current
        }

    /** An incoming `call-offer` for a call this device knows nothing about.
     *  If a call is already active/ringing, the caller (not this function)
     *  is expected to have already resolved glare via [shouldYieldToIncoming]
     *  or sent `call-end{reason:"busy"}` — reaching this function while busy
     *  is a bug, so it is refused the same as [place]. */
    fun receiveOffer(current: CallState, callId: String, peer: String, atMs: Long): CallState =
        if (current is CallState.Idle || current is CallState.Ended) {
            CallState.Ringing(callId, peer, isIncoming = true, startedAtMs = atMs)
        } else {
            current
        }

    /** Two offers crossed: both sides called each other at once. The
     *  deterministic tiebreak already used by web (`isDirectInitiator`,
     *  `web/cloud/app.js:8690`) — the lexicographically smaller login's
     *  offer survives. Returns `true` when *my* outgoing offer must be torn
     *  down in favour of the incoming one. */
    fun shouldYieldToIncoming(myLogin: String, peerLogin: String): Boolean = myLogin > peerLogin

    /** Caller side: the callee's device woke up and is ringing. */
    fun ring(current: CallState, callId: String): CallState =
        if (current is CallState.Outgoing && current.callId == callId) {
            CallState.Ringing(callId, current.peer, isIncoming = false, startedAtMs = current.placedAtMs)
        } else {
            current
        }

    /** Either side accepted (callee tapped Answer, or the caller received
     *  `call-answer`): SDP is now being exchanged. */
    fun accept(current: CallState, callId: String): CallState = when (current) {
        is CallState.Outgoing -> if (current.callId == callId) {
            CallState.Connecting(callId, current.peer, isIncoming = false)
        } else current
        is CallState.Ringing -> if (current.callId == callId) {
            CallState.Connecting(callId, current.peer, current.isIncoming)
        } else current
        else -> current
    }

    /** ICE connected: audio is flowing. */
    fun connected(current: CallState, callId: String, atMs: Long): CallState =
        if (current is CallState.Connecting && current.callId == callId) {
            CallState.Active(callId, current.peer, current.isIncoming, atMs)
        } else {
            current
        }

    /** A `call-end`, a local hangup/decline, an ICE failure, or a ring/answer
     *  timeout — anything that closes the call. Ignored (returns `current`
     *  unchanged) for a `callId` that is not the call this device thinks is
     *  live: a stale `call-end` for a call already superseded must not
     *  reach back in and stop the new one — see §2's "a frame with a
     *  mismatched callId is dropped without an answer" rule. */
    fun end(current: CallState, callId: String, reason: CallEndReason): CallState {
        val peer = when (current) {
            is CallState.Outgoing -> current.peer.takeIf { current.callId == callId }
            is CallState.Ringing -> current.peer.takeIf { current.callId == callId }
            is CallState.Connecting -> current.peer.takeIf { current.callId == callId }
            is CallState.Active -> current.peer.takeIf { current.callId == callId }
            CallState.Idle, is CallState.Ended -> null
        } ?: return current
        return CallState.Ended(callId, peer, reason)
    }

    /** `call-taken`: another of this account's own devices answered the
     *  incoming call this one was also ringing for. Only meaningful for an
     *  *incoming* ring/connect this device never actually accepted itself —
     *  its own accepted call is never torn down by its own `call-taken`
     *  echo (the hub excludes the sender; this guard is the second line of
     *  defence against a client bug or a race). */
    fun taken(current: CallState, callId: String): CallState = when (current) {
        is CallState.Ringing -> if (current.callId == callId && current.isIncoming) {
            CallState.Ended(callId, current.peer, CallEndReason.Unknown)
        } else current
        is CallState.Connecting -> if (current.callId == callId && current.isIncoming) {
            CallState.Ended(callId, current.peer, CallEndReason.Unknown)
        } else current
        else -> current
    }

    /** Explicit reset once the ended/failed state has been shown — the UI's
     *  own "dismiss" rather than a timer, matching how [VoicePlaybackState]
     *  is only ever left by another user action or a fresh load. */
    fun dismiss(current: CallState): CallState = when (current) {
        is CallState.Ended -> CallState.Idle
        else -> current
    }

    /**
     * §4.5: what to log, once [end] gives up and [transition][CallController]
     * lands on [CallState.Ended]. `null` when [previous] was not actually a
     * live call ([CallState.Idle] or already [CallState.Ended]) — a repeated
     * Ended (a stale frame the transition table already ignored, so `next`
     * and `previous` are the same value) describes nothing new to log; the
     * caller is expected to pass the state *before* the transition that
     * produced [next], never `next` itself for both.
     */
    fun callLogEntry(previous: CallState, next: CallState.Ended, peerName: String, endedAtMs: Long): CallLogEntry? {
        val incoming = when (previous) {
            is CallState.Outgoing -> false
            is CallState.Ringing -> previous.isIncoming
            is CallState.Connecting -> previous.isIncoming
            is CallState.Active -> previous.isIncoming
            CallState.Idle, is CallState.Ended -> return null
        }
        val durationSec = if (previous is CallState.Active) {
            ((endedAtMs - previous.connectedAtMs).coerceAtLeast(0) / 1000).toInt()
        } else {
            0
        }
        return CallLogEntry(
            callId = next.callId,
            peer = next.peer,
            peerName = peerName,
            incoming = incoming,
            everActive = previous is CallState.Active,
            reason = next.reason,
            durationSec = durationSec,
            endedAtMs = endedAtMs,
        )
    }

    /** §2's timeouts: the caller waits 10s for `call-ring`/`call-answer`
     *  before treating the callee as unreachable-for-now, but keeps ringing
     *  until 45s total for a device woken by push. Returns the state
     *  unchanged once the deadline has not passed, or once the call has
     *  moved past waiting for an answer. */
    fun ringTimeout(current: CallState, callId: String, nowMs: Long, totalTimeoutMs: Long = 45_000): CallState {
        val startedAt = when (current) {
            is CallState.Outgoing -> current.placedAtMs.takeIf { current.callId == callId }
            is CallState.Ringing -> current.startedAtMs.takeIf { current.callId == callId }
            else -> null
        } ?: return current
        return if (nowMs - startedAt >= totalTimeoutMs) end(current, callId, CallEndReason.Timeout) else current
    }
}
