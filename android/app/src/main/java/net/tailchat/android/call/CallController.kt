package net.tailchat.android.call

import android.content.Context
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** What [CallController] shows the UI beyond the bare [CallState] — the
 *  peer's display name (the roster may not have loaded it by the time a
 *  push wakes the process) and whether the mic is muted right now. */
data class CallUiState(
    val call: CallState = CallState.Idle,
    val peerName: String = "",
    val muted: Boolean = false,
    val route: AudioRoute = AudioRoute.Earpiece,
    /** Null until the call is connected and the first sample has been read. */
    val media: CallMediaHealth? = null,
)

/**
 * What the last stats samples say about a connected call, in the only two
 * terms a person cares about: is anything arriving, and is this device
 * actually sending sound.
 *
 * A call whose ICE is «connected» can be silent both ways — the platform
 * silences a microphone whenever the app is neither visible nor holding a
 * `microphone` foreground service, and that looks exactly like a working call
 * from every other signal this app has. Both flags need several consecutive
 * quiet samples, so a single lost packet or a pause in speech cannot raise
 * them.
 */
data class CallMediaHealth(
    val bytesSent: Long,
    val bytesReceived: Long,
    /** No RTP at all has arrived for [CallController.SILENCE_AFTER_MS]. */
    val inboundSilent: Boolean,
    /** The microphone is delivering exactly nothing while unmuted. */
    val micSilent: Boolean,
)

/**
 * Process-wide owner of the one call this device may be in — everything
 * [CallTransitions] describes, turned into actual `WebRtcEngine`/`CallAudio`
 * side effects and actual `call-*` frames. One instance lives for the
 * process (constructed by `ServiceCloudController`), the same way
 * `SyncEngine` is a single long-lived owner rather than one per screen.
 *
 * [engineFactory] and [now]/[idFactory] are seams for
 * `CallControllerTest` — nothing else in this file reaches into
 * `org.webrtc` or `System.currentTimeMillis()` directly.
 */
class CallController(
    context: Context,
    private val scope: CoroutineScope,
    /** `{ from, to, d } -> was a live connection asked to send it}` — see
     *  `ServiceCloudController.sendSingleFrame`. Not delivery proof, same
     *  contract every other caller of that method already accepts. */
    private val sendFrame: (peer: String, frame: JsonObject) -> Boolean,
    private val selfLogin: () -> String?,
    private val fetchTurnConfig: suspend () -> TurnConfig?,
    private val notifications: CallNotifier = CallNotifications(context),
    private val audio: CallAudioController = CallAudio(context),
    private val engineFactory: (WebRtcEngineListener) -> CallEngine = { WebRtcEngine(context, it) },
    private val now: () -> Long = System::currentTimeMillis,
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
    private val engineAvailable: () -> Boolean = { CallEngineAvailability.available },
    /** §4.5: fired once per finished call, with what this device saw happen
     *  to it — `CloudController` turns this into a `messages` row via
     *  `ChatRepository.recordCall`. This package never touches Room itself,
     *  the same seam `sendFrame`/`notifications`/`audio` already are. */
    private val onCallEnded: (CallLogEntry) -> Unit = {},
    /** Raises the one call screen — for a call this device places *and* for
     *  one it receives — and reports whether it actually came up. A
     *  background activity start is refused by the platform (API 29+), and
     *  `false` is what makes `CallNotifications`' full-screen intent the
     *  fallback instead of a second, redundant UI. A seam, not a direct
     *  `startActivity`, so `CallControllerTest` stays a JVM test. */
    private val openCallUi: (callId: String, peer: String) -> Boolean = { callId, peer ->
        runCatching { context.startActivity(CallActivity.activeIntent(context, callId, peer)) }
            .onFailure { Log.i(TAG, "call screen not raised directly; notification only", it) }
            .isSuccess
    },
    /** The roster's display name for a login, or `null` while the roster has
     *  not resolved one. An incoming offer carries only the caller's login,
     *  and a login is not what the person is called anywhere else in this app
     *  — resolving it here is what keeps the call screen and the shade saying
     *  the same name the roster does, including after a rename. */
    private val resolveName: (login: String) -> String? = { null },
    /** The incoming-call melody and the screen wake that comes with it —
     *  a seam for the same reason [audio] is one. */
    private val ringer: CallRingtonePlayer = CallRinger(context),
    /**
     * Where the engine is *built*. `PeerConnectionFactory.create` loads and
     * initialises libwebrtc's audio device module, which on a real phone
     * takes seconds — and `scope` is `Dispatchers.Main.immediate`, so doing
     * it inline froze the UI thread from the moment the call button was
     * pressed: «ANR in net.tailchat.android … Input dispatching timed out»,
     * with `WebRtcAudioManager.isLowLatencyOutputSupported` on top of the
     * main thread's stack. `CallControllerTest` passes
     * [EmptyCoroutineContext] so construction stays on the test dispatcher.
     */
    private val engineContext: CoroutineContext = Dispatchers.Default,
    /** Whether this app currently has a visible window (in foreground).
     *  When false, Android BAL (API 29+) blocks startActivity, and the
     *  full-screen intent notification is the only way to show the call. */
    private val isAppForeground: () -> Boolean = {
        runCatching {
            ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        }.getOrDefault(false)
    },
) {
    private val _ui = MutableStateFlow(CallUiState())
    val state: StateFlow<CallUiState> = _ui.asStateFlow()

    private var engine: CallEngine? = null
    private var engineReady = false
    private var engineStartJob: Job? = null
    private var ringTimeoutJob: Job? = null
    private var iceFlushJob: Job? = null
    /** The deadline that turns "the media path broke and is being rebuilt"
     *  back into an honest failure — see [onIceFailed]. */
    private var iceRestartJob: Job? = null
    /** ICE restarts this device has attempted for the live call, reset by
     *  [armStart] with the rest of the per-call state. */
    private var iceRestarts = 0
    /** Set for the instant between [restartIce] and the offer it produces:
     *  the offer that comes back is the restart, and the caller has to say so
     *  or the hub would ring the peer for a call that is already up. */
    private var iceRestartOfferPending = false
    private var quietInboundSamples = 0
    private var quietOutboundSamples = 0
    private var lastBytesReceived = -1L
    private val pendingLocalIce = mutableListOf<IceCandidate>()
    /** Remote candidates that arrived before this device's own engine
     *  existed. `WebRtcEngine` buffers candidates that arrive before the
     *  remote SDP, but it cannot buffer what reaches the controller before
     *  there is an engine at all — and since the engine is now built off the
     *  main thread, that window is real. Dropping them stranded the call at
     *  `Connecting`, the exact defect held offers were added for. */
    private val pendingRemoteIce = mutableListOf<IceCandidate>()

    /** When [transition] last changed [CallUiState.call], on the same clock
     *  [now] reads — the watchdog below compares against it rather than
     *  trusting that a `delay` of N ms means N ms of wall clock passed. */
    private var stateEnteredAtMs = now()
    private var watchdogJob: Job? = null

    private fun transition(next: CallState) {
        val previous = _ui.value.call
        _ui.value = _ui.value.copy(call = next)
        // Anything that is no longer a ring — in either direction — stops the
        // tone: answered, declined, taken by another device, timed out or
        // failed. `Outgoing` and `Ringing` are the two states a tone belongs
        // to (ringback for the caller, melody for the callee). One place, so
        // no exit path can leave a phone ringing at itself.
        if (next !is CallState.Ringing && next !is CallState.Outgoing) ringer.stop()
        if (next is CallState.Ended || next is CallState.Idle) {
            if (previous !is CallState.Ended && previous !is CallState.Idle) teardown()
            notifications.clear()
        }
        if (next is CallState.Ended) {
            CallTransitions.callLogEntry(previous, next, _ui.value.peerName, now())?.let(onCallEnded)
        }
        armWatchdog(next)
    }

    /**
     * The floor under «звонки перестают работать, помогает только
     * перезапуск».
     *
     * This controller lives as long as the process and allows exactly one
     * call, so any state that is neither [CallState.Idle] nor
     * [CallState.Ended] is a state in which [placeCall] returns silently and
     * every incoming offer is answered with `busy`. Two states could be
     * entered and never left: [CallState.Connecting] has no deadline of its
     * own (the ring timeout only covers `Outgoing`/`Ringing`, and libwebrtc
     * reports `failed` only if ICE actually gets that far — a peer whose
     * process was killed mid-handshake leaves it checking forever), and
     * [CallState.Ended] is only cleared by `dismiss()` from the call screen,
     * which never runs when the full-screen intent was refused and the
     * person only ever saw a notification. Either one bricks calling until
     * the app is restarted, which is exactly what was reported.
     *
     * So both are bounded here. The elapsed check is on [now], not on the
     * `delay` alone, for the same reason [CallTransitions.ringTimeout] is:
     * a window slept through in Doze must not end a call that has since
     * moved on.
     */
    private fun armWatchdog(state: CallState) {
        watchdogJob?.cancel()
        watchdogJob = null
        stateEnteredAtMs = now()
        val timeout = when (state) {
            is CallState.Connecting -> CONNECT_TIMEOUT_MS
            is CallState.Ended -> ENDED_RESET_MS
            else -> return
        }
        val enteredAt = stateEnteredAtMs
        watchdogJob = scope.launch {
            delay(timeout)
            watchdogJob = null
            if (_ui.value.call != state) return@launch
            if (now() - enteredAt < timeout) return@launch
            when (state) {
                is CallState.Connecting -> {
                    Log.w(TAG, "call ${state.callId} stuck in Connecting for ${timeout}ms; ending it")
                    sendFrame(
                        state.peer,
                        CallSignaling.toJson(CallFrame.End(state.callId, CallEndReason.Failed)),
                    )
                    transition(CallTransitions.end(state, state.callId, CallEndReason.Failed))
                }
                is CallState.Ended -> {
                    Log.i(TAG, "clearing a finished call nobody dismissed")
                    transition(CallTransitions.dismiss(state))
                }
                else -> Unit
            }
        }
    }

    /**
     * Reads one stats sample, so «connected but silent» becomes visible
     * instead of being indistinguishable from a working call. Driven by the
     * call screen once every [STATS_INTERVAL_MS] rather than by a timer here:
     * the numbers exist to be *shown*, and a self-driving loop in a
     * process-lifetime owner is a loop that keeps sampling a call nobody is
     * looking at.
     *
     * Nothing here touches the state machine — a call is never ended because a
     * phone stopped sending for a few seconds.
     */
    fun sampleMedia() {
        val callId = _ui.value.call.activeCallId() ?: return
        if (_ui.value.call !is CallState.Active) return
        val eng = engine ?: return
        eng.readStats { stats ->
            scope.launch {
                if (_ui.value.call.activeCallId() != callId) return@launch
                quietInboundSamples = if (stats.bytesReceived == lastBytesReceived) quietInboundSamples + 1 else 0
                lastBytesReceived = stats.bytesReceived
                quietOutboundSamples =
                    if (stats.outboundAudioLevel <= 0.0 && !_ui.value.muted) quietOutboundSamples + 1 else 0
                val quietSamples = (SILENCE_AFTER_MS / STATS_INTERVAL_MS).toInt()
                Log.i(
                    TAG,
                    "call $callId sent=${stats.bytesSent} received=${stats.bytesReceived} " +
                        "outLevel=${stats.outboundAudioLevel} inLevel=${stats.inboundAudioLevel}",
                )
                _ui.value = _ui.value.copy(
                    media = CallMediaHealth(
                        bytesSent = stats.bytesSent,
                        bytesReceived = stats.bytesReceived,
                        inboundSilent = quietInboundSamples >= quietSamples,
                        micSilent = quietOutboundSamples >= quietSamples,
                    ),
                )
            }
        }
    }

    // ---- outward actions -------------------------------------------------

    fun placeCall(peer: String, peerName: String) {
        if (_ui.value.call !is CallState.Idle && _ui.value.call !is CallState.Ended) {
            // Silent before this: the one symptom of a state that was never
            // left was a call button that did nothing at all.
            Log.w(TAG, "call button refused: already in ${_ui.value.call}")
            return
        }
        val me = selfLogin() ?: return
        val callId = idFactory()
        transition(CallTransitions.place(CallState.Idle, callId, peer, now()))
        _ui.value = _ui.value.copy(peerName = peerName, muted = false)
        // armStart's onLocalSdpReady sends the real call-offer once the
        // engine has produced an SDP — createOffer is async, so there is
        // nothing to send synchronously here.
        armStart(callId, peer, isCaller = true)
        armRingTimeout(callId, me)
        // No ringback here. It starts when the callee's own device answers
        // `call-ring` (see onSignalReceived) — a tone before that says
        // "ringing" about a phone nothing has reached yet.
        // The caller's own feedback: the same ongoing notification the callee
        // gets after answering (so leaving the screen still leaves a way
        // back and a Hang up), plus the call screen itself.
        notifications.showOngoing(callId, peer, peerName)
        openCallUi(callId, peer)
    }

    /** Incoming `call-offer` reached this device. */
    fun onSignalReceived(from: String, frame: JsonObject) {
        val call = CallSignaling.fromJson(frame) ?: return
        val me = selfLogin() ?: return
        when (call) {
            is CallFrame.Offer -> {
                val current = _ui.value.call
                // The same offer again. The hub holds an offer for the ring
                // window and replays it to the next device that connects, so
                // a socket that dropped between taking the offer and its own
                // `call-ring` reaching the server is handed it a second time
                // after the push wakes it. Answering `busy` here would kill
                // the very call this device is already ringing for; the ring
                // is re-sent instead, because the one the caller never got is
                // exactly why the offer was still being held.
                if (current.activeCallId() == call.callId) {
                    if (current is CallState.Ringing && current.isIncoming) {
                        // The same offer again, while this device is ringing.
                        if (!call.restart) sendFrame(from, CallSignaling.toJson(CallFrame.Ring(call.callId)))
                        return
                    }
                    // A re-negotiation of the live call, from the peer that
                    // call is with: the caller rebuilding its media path
                    // after ICE failed (`onIceFailed`). The callee is the
                    // answerer and never re-offers — the engine applies the
                    // offer and answers it, or both sides would end up in
                    // `have-local-offer` with neither SDP applicable. A
                    // repeat of an ordinary offer for a call already in
                    // progress, or one claiming this call's id from somebody
                    // else, is dropped rather than applied.
                    val live = current is CallState.Active || current is CallState.Connecting
                    if (call.restart && live && peerOf(current) == from) {
                        engine?.setRemoteOffer(call.sdp)
                    }
                    return
                }
                // A re-negotiation for a call this device is not in. The hub
                // has no way to address one device of an account, so every
                // other session of the recipient gets the re-offer too — and
                // a phone that is not in this call must not start ringing for
                // it. Nothing to negotiate with, nothing to do.
                if (call.restart) return
                if (current !is CallState.Idle && current !is CallState.Ended) {
                    // Busy, or glare. Glare: only the callee ever receives an
                    // Offer while it also has an Outgoing of its own — the
                    // deterministic tiebreak decides who yields.
                    if (current is CallState.Outgoing && CallTransitions.shouldYieldToIncoming(me, from)) {
                        teardown()
                        acceptIncoming(call, from)
                    } else {
                        sendFrame(from, CallSignaling.toJson(CallFrame.End(call.callId, CallEndReason.Busy)))
                    }
                    return
                }
                acceptIncoming(call, from)
            }
            is CallFrame.Ring -> {
                val wasRinging = _ui.value.call is CallState.Ringing
                transition(CallTransitions.ring(_ui.value.call, call.callId))
                // The ringback starts here and nowhere else: this frame is the
                // callee's own device saying it is ringing. Started at the
                // button press, as it used to be, the caller listened to
                // "ringing" for a phone that had not been reached at all — a
                // tone for a call that was not happening.
                if (!wasRinging && _ui.value.call is CallState.Ringing) ringer.startOutgoing()
            }
            is CallFrame.Answer -> {
                if (_ui.value.call.activeCallId() != call.callId) return
                transition(CallTransitions.accept(_ui.value.call, call.callId))
                engine?.setRemoteAnswer(call.sdp)
            }
            is CallFrame.IceCandidates -> {
                if (_ui.value.call.activeCallId() != call.callId) return
                val eng = engine
                if (eng == null) pendingRemoteIce.addAll(call.candidates)
                else eng.addRemoteIceCandidates(call.candidates)
            }
            is CallFrame.End -> transition(CallTransitions.end(_ui.value.call, call.callId, call.reason))
            is CallFrame.Taken -> transition(CallTransitions.taken(_ui.value.call, call.callId))
        }
    }

    private fun acceptIncoming(offer: CallFrame.Offer, from: String) {
        transition(CallTransitions.receiveOffer(CallState.Idle, offer.callId, from, now()))
        if (!engineAvailable()) {
            sendFrame(from, CallSignaling.toJson(CallFrame.End(offer.callId, CallEndReason.Unsupported)))
            transition(CallTransitions.end(_ui.value.call, offer.callId, CallEndReason.Unsupported))
            return
        }
        // The offer carries a login; the roster is what knows what that
        // person is called. Falling back to the login only when the roster
        // genuinely has no name for them.
        _ui.value = _ui.value.copy(peerName = resolveName(from)?.takeIf { it.isNotBlank() } ?: from)
        pendingRemoteOfferSdp = offer.sdp
        armStart(offer.callId, from, isCaller = false)
        armRingTimeout(offer.callId, selfLogin().orEmpty())
        // Raise the call screen ourselves first when the app is already
        // visible in the foreground, and post the incoming notification only
        // if the app is in the background or direct start failed.
        // The full-screen intent is the only mechanism available to a
        // background process, but it degrades to a heads-up strip when the
        // app is visible — posting both produced what the owner saw: the
        // full-screen call *and* a notification banner over it.
        // A background activity start is blocked by the platform (API 29+ BAL)
        // without throwing an exception, so checking isAppForeground() is
        // what ensures a background/closed app gets showIncoming's
        // full-screen intent instead of silently dropping the UI.
        val raised = if (isAppForeground()) openCallUi(offer.callId, from) else false
        if (!raised) notifications.showIncoming(offer.callId, from, _ui.value.peerName)
        // The melody: a channel sound is one short blip, and a call has to
        // keep ringing. `CallRinger` also lights the screen, which is what a
        // locked phone needs when the platform refuses the full-screen
        // intent (API 34+).
        ringer.startIncoming()
        // Tells the caller this device woke up and is actually ringing —
        // §2's call-ring, sent callee-to-caller.
        sendFrame(from, CallSignaling.toJson(CallFrame.Ring(offer.callId)))
    }

    private var pendingRemoteOfferSdp: String? = null

    /** User tapped Answer, or the notification action fired. */
    fun answer() {
        val ringing = _ui.value.call as? CallState.Ringing ?: return
        if (!ringing.isIncoming) return
        ringTimeoutJob?.cancel()
        transition(CallTransitions.accept(ringing, ringing.callId))
        audio.start()
        answerPendingRemoteOffer()
        notifications.showOngoing(ringing.callId, ringing.peer, _ui.value.peerName)
    }

    /**
     * The socket is gone. An *incoming* ring is dead the moment it is: the
     * `call-answer` it would need to send has nowhere to go, and the caller's
     * own cancel can no longer arrive — which is how a phone ended up
     * ringing on its own after the caller had already stopped. An already
     * connected call is left alone: its media path is peer-to-peer and does
     * not need the signalling socket.
     */
    fun onLinkLost() {
        val ringing = _ui.value.call as? CallState.Ringing ?: return
        if (!ringing.isIncoming) return
        transition(CallTransitions.end(ringing, ringing.callId, CallEndReason.Failed))
    }

    /**
     * ICE gave up on a call that was up — the Wi-Fi↔LTE handover, the dead
     * NAT binding, the tunnel change of §7.6.
     *
     * Ending the call there and then is what «бывает, что разговор
     * сбрасывается» was: the audio path is broken, not the conversation, and
     * ICE can build a new one from the same peer connection. So the caller
     * restarts ICE and re-offers, and the call is only declared failed if
     * that has not reconnected it by [ICE_RESTART_GRACE_MS].
     *
     * The caller is the *only* side that re-offers. Both sides detect the
     * same broken path at the same moment, and two `restartIce()+createOffer`
     * racing each other leave both peer connections in `have-local-offer`,
     * where neither offer applies — a deadlock the retry would not clear. The
     * callee therefore only waits out the deadline and takes the re-offer the
     * caller sends.
     *
     * A call that never connected is a different case: there is no working
     * state to rebuild and [CONNECT_TIMEOUT_MS] already bounds [CallState.Connecting],
     * so it fails as it always did.
     *
     * [callId] is the call the *engine that reported this* was built for, not
     * whatever is live now. A released engine's native callbacks still land —
     * the disposal is not what stops them — so an `ice` failure from the
     * previous call would otherwise be read as this one's and end it on the
     * spot, which is the same "calling stops working" shape the ownership
     * rules around [CallTransitions.end] exist to prevent.
     */
    private fun onIceFailed(callId: String) {
        val call = _ui.value.call
        if (call.activeCallId() != callId) return
        if (call !is CallState.Active) {
            transition(CallTransitions.end(call, callId, CallEndReason.Failed))
            return
        }
        if (!call.isIncoming && iceRestarts < MAX_ICE_RESTARTS) {
            iceRestarts += 1
            Log.w(TAG, "call $callId lost its media path; restarting ICE")
            iceRestartOfferPending = true
            engine?.restartIce()
            engine?.createOffer()
        }
        armIceDeadline(callId)
    }

    /** Give the rebuilt path [ICE_RESTART_GRACE_MS] to carry audio before the
     *  call is called lost. Re-armed by every failure, since each one is a
     *  fresh attempt — and cancelled the moment ICE connects again. */
    private fun armIceDeadline(callId: String) {
        iceRestartJob?.cancel()
        iceRestartJob = scope.launch {
            delay(ICE_RESTART_GRACE_MS)
            iceRestartJob = null
            val current = _ui.value.call
            if (current.activeCallId() != callId || current !is CallState.Active) return@launch
            Log.w(TAG, "call $callId did not come back after an ICE restart")
            transition(CallTransitions.end(current, callId, CallEndReason.Failed))
        }
    }

    private fun answerPendingRemoteOffer() {
        if (!engineReady || _ui.value.call !is CallState.Connecting) return
        val eng = engine ?: return
        val sdp = pendingRemoteOfferSdp ?: return
        pendingRemoteOfferSdp = null
        // The engine answers it once the remote SDP is really applied — see
        // CallEngine.setRemoteOffer.
        eng.setRemoteOffer(sdp)
    }

    fun decline() {
        val ringing = _ui.value.call as? CallState.Ringing ?: return
        sendFrame(ringing.peer, CallSignaling.toJson(CallFrame.End(ringing.callId, CallEndReason.Declined)))
        transition(CallTransitions.end(ringing, ringing.callId, CallEndReason.Declined))
    }

    fun hangup() {
        val callId = _ui.value.call.activeCallId() ?: return
        val peer = peerOf(_ui.value.call) ?: return
        sendFrame(peer, CallSignaling.toJson(CallFrame.End(callId, CallEndReason.Hangup)))
        transition(CallTransitions.end(_ui.value.call, callId, CallEndReason.Hangup))
    }

    fun setMuted(muted: Boolean) {
        engine?.setMuted(muted)
        _ui.value = _ui.value.copy(muted = muted)
    }

    fun setAudioRoute(route: AudioRoute) {
        audio.setRoute(route)
        _ui.value = _ui.value.copy(route = route)
    }

    fun dismiss() {
        transition(CallTransitions.dismiss(_ui.value.call))
    }

    /**
     * The roster changed (a rename, or a name that had not loaded yet when a
     * push woke this process). Re-resolves the live call's display name and
     * re-posts the ongoing notification when it actually changed — without
     * this, a renamed contact kept the old name on the call screen and in the
     * shade until the app restarted, while the roster already showed the new
     * one. Cheap and a no-op when no call is live.
     */
    fun onRosterChanged() {
        val peer = peerOf(_ui.value.call) ?: return
        val callId = _ui.value.call.activeCallId() ?: return
        val resolved = resolveName(peer)?.takeIf { it.isNotBlank() } ?: return
        if (resolved == _ui.value.peerName) return
        _ui.value = _ui.value.copy(peerName = resolved)
        // Only the ongoing notification is re-posted: re-issuing the incoming
        // one would make a ringing call ring again from the top.
        if (_ui.value.call !is CallState.Ringing) notifications.showOngoing(callId, peer, resolved)
    }

    /** Another of this account's own devices answered first — see `call-taken`
     *  in §2/§3.1.6; ServiceCloudController forwards its own login's frames
     *  here the same way it forwards a peer's. */
    fun onOwnDeviceTook(callId: String) {
        transition(CallTransitions.taken(_ui.value.call, callId))
    }

    // ---- engine wiring -----------------------------------------------------

    private fun armStart(callId: String, peer: String, isCaller: Boolean) {
        if (!engineAvailable()) {
            transition(CallTransitions.end(_ui.value.call, callId, CallEndReason.Unsupported))
            return
        }
        // Caller only. Taking exclusive voice-communication focus and
        // `MODE_IN_COMMUNICATION` while the callee's phone is still *ringing*
        // routes the ringtone into the earpiece at call volume — audibly
        // nothing. The callee's `answer()` starts the audio stack instead,
        // right after the melody stops.
        if (isCaller) audio.start()
        quietInboundSamples = 0
        quietOutboundSamples = 0
        lastBytesReceived = -1L
        iceRestarts = 0
        iceRestartOfferPending = false
        val listener = object : WebRtcEngineListener {
            override fun onLocalIceCandidate(candidate: IceCandidate) {
                queueLocalIce(peer, callId, candidate)
            }

            override fun onIceConnectionChange(connected: Boolean, failed: Boolean) {
                scope.launch {
                    if (connected) {
                        iceRestartJob?.cancel()
                        iceRestartJob = null
                        transition(CallTransitions.connected(_ui.value.call, callId, now()))
                    } else if (failed) {
                        onIceFailed(callId)
                    }
                }
            }

            override fun onLocalSdpReady(sdp: String, type: String) {
                // An engine that has been released is still a live native
                // object until it is disposed, and its SDP callbacks land
                // afterwards: a frame from the previous call must not be sent
                // as this one's, and must not clear the marker the *current*
                // re-offer is waiting on either.
                if (_ui.value.call.activeCallId() != callId) return
                // The re-offer that rebuilds a broken media path carries the
                // marker the hub reads: it is the same `call-offer` frame, and
                // without the flag the server would treat it as a new call —
                // holding it, ringing the peer's phone a second time for the
                // call it is already in.
                val restart = type == "offer" && iceRestartOfferPending
                iceRestartOfferPending = false
                val frame = when {
                    type != "offer" -> CallFrame.Answer(callId, sdp)
                    else -> CallFrame.Offer(callId, sdp, "audio", now(), restart = restart)
                }
                sendFrame(peer, CallSignaling.toJson(frame))
            }

            override fun onLocalSdpError(reason: String) {
                scope.launch { transition(CallTransitions.end(_ui.value.call, callId, CallEndReason.Failed)) }
            }
        }
        engine = null
        engineReady = false
        pendingRemoteIce.clear()
        engineStartJob = scope.launch {
            val turn = runCatching { fetchTurnConfig() }.getOrNull()
            coroutineContext.ensureActive()
            if (_ui.value.call.activeCallId() != callId) return@launch
            // Off the main thread: see [engineContext].
            // Prompt cancellation can discard withContext's return value
            // after the native constructor completed. Retain ownership until
            // Main can adopt it, so a hung-up call cannot orphan its factory.
            var constructed: CallEngine? = null
            val eng = try {
                withContext(engineContext) {
                    engineFactory(listener).also { constructed = it }
                }.also { coroutineContext.ensureActive() }
            } catch (error: Throwable) {
                constructed?.release()
                throw error
            }
            // The call this engine was built for is over (hung up or replaced
            // while libwebrtc was initialising): release it instead of
            // adopting it, or its audio device module outlives the call.
            if (_ui.value.call.activeCallId() != callId) {
                eng.release()
                return@launch
            }
            engine = eng
            eng.start(turn?.iceServers.orEmpty())
            engineReady = true
            if (pendingRemoteIce.isNotEmpty()) {
                val queued = pendingRemoteIce.toList()
                pendingRemoteIce.clear()
                eng.addRemoteIceCandidates(queued)
            }
            if (isCaller) {
                eng.createOffer()
            } else {
                // Answer may have been tapped while TURN configuration was
                // loading. Only consume its offer once the peer exists.
                answerPendingRemoteOffer()
            }
        }
    }

    private fun queueLocalIce(peer: String, callId: String, candidate: IceCandidate) {
        pendingLocalIce.add(candidate)
        if (pendingLocalIce.size >= ICE_BATCH_MAX) {
            flushLocalIce(peer, callId)
            return
        }
        if (iceFlushJob?.isActive == true) return
        iceFlushJob = scope.launch {
            delay(ICE_BATCH_WINDOW_MS)
            flushLocalIce(peer, callId)
        }
    }

    private fun flushLocalIce(peer: String, callId: String) {
        if (pendingLocalIce.isEmpty()) return
        val batch = pendingLocalIce.toList()
        pendingLocalIce.clear()
        sendFrame(peer, CallSignaling.toJson(CallFrame.IceCandidates(callId, batch)))
    }

    private fun armRingTimeout(callId: String, myLogin: String) {
        ringTimeoutJob?.cancel()
        ringTimeoutJob = scope.launch {
            delay(RING_TOTAL_TIMEOUT_MS)
            val next = CallTransitions.ringTimeout(_ui.value.call, callId, now(), RING_TOTAL_TIMEOUT_MS)
            if (next is CallState.Ended) {
                peerOf(_ui.value.call)?.let { sendFrame(it, CallSignaling.toJson(CallFrame.End(callId, CallEndReason.Timeout))) }
                transition(next)
            }
        }
    }

    private fun peerOf(state: CallState): String? = when (state) {
        is CallState.Outgoing -> state.peer
        is CallState.Ringing -> state.peer
        is CallState.Connecting -> state.peer
        is CallState.Active -> state.peer
        is CallState.Ended -> state.peer
        CallState.Idle -> null
    }

    private fun teardown() {
        ringTimeoutJob?.cancel()
        iceFlushJob?.cancel()
        iceRestartJob?.cancel()
        iceRestartJob = null
        iceRestartOfferPending = false
        engineStartJob?.cancel()
        engineStartJob = null
        engineReady = false
        pendingLocalIce.clear()
        pendingRemoteIce.clear()
        pendingRemoteOfferSdp = null
        engine?.release()
        engine = null
        audio.stop()
        _ui.value = _ui.value.copy(media = null)
    }

    companion object {
        // §2: batch ICE candidates instead of one frame each (60/s budget),
        // max 20 per frame.
        const val ICE_BATCH_WINDOW_MS = 150L
        const val ICE_BATCH_MAX = 20
        const val RING_TOTAL_TIMEOUT_MS = 45_000L

        /**
         * How long a call may sit in [CallState.Connecting] before it is
         * declared failed. Generous — TURN allocation plus ICE over a mobile
         * network is seconds, not milliseconds — but finite, because a
         * `Connecting` that never ends is a phone that cannot call or be
         * called until it is restarted.
         */
        const val CONNECT_TIMEOUT_MS = 40_000L

        /**
         * How long a finished call stays [CallState.Ended] when nothing
         * dismisses it. The call screen clears it after
         * [CallActivity.ENDED_LINGER_MS]; this is the case where that screen
         * never ran at all (full-screen intent refused, call handled entirely
         * from the notification), so the state has to expire by itself.
         */
        const val ENDED_RESET_MS = 30_000L
        /** How often the connected call's counters are sampled. */
        const val STATS_INTERVAL_MS = 2_000L

        /**
         * How long a rebuilt media path has to carry audio before the call is
         * declared failed. ICE restart on a mobile network — the new
         * candidates gathered through TURN, the checks run against them — is
         * seconds, so this is generous; it is finite because a call that has
         * already lost its path must not sit on screen looking connected.
         */
        const val ICE_RESTART_GRACE_MS = 12_000L

        /**
         * ICE restarts this device attempts per call. One is the honest count:
         * a restart either rebuilds the path or the two phones no longer have
         * one in common, and a second attempt from the same state only adds
         * another re-offer to the signalling path that is already suspect.
         */
        const val MAX_ICE_RESTARTS = 1

        /**
         * How long one direction has to stay completely quiet before it is
         * called silent. Long enough that a pause between words or a brief
         * network stall cannot trigger it, short enough that a person is not
         * left talking into nothing for half a minute.
         */
        const val SILENCE_AFTER_MS = 6_000L
        private const val TAG = "CallController"
    }
}
