package net.tailchat.android.call

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class FakeEngine(private val listener: WebRtcEngineListener) : CallEngine {
    var started = false
    var offers = 0
    var answerCreated = false
    var remoteOfferSdp: String? = null
    var remoteAnswerSdp: String? = null
    var muted: Boolean? = null
    var released = false
    /** What the next [readStats] hands back; a test walks it forward. */
    var stats = CallMediaStats()

    override fun start(iceServers: List<IceServerConfig>) { started = true }
    override fun createOffer() {
        offers += 1
        // Mirrors WebRtcEngine: the local description comes back through the
        // listener, which is what actually puts an offer on the wire.
        listener.onLocalSdpReady("offer:$offers", "offer")
    }
    override fun setRemoteOffer(sdp: String) {
        if (!started || released) return
        remoteOfferSdp = sdp
        // Mirrors WebRtcEngine: the answer belongs to the engine, which
        // creates it once the remote offer is really applied — the controller
        // has no way to know when that is, and must not try.
        answerCreated = true
        listener.onLocalSdpReady("answer:$sdp", "answer")
    }
    override fun setRemoteAnswer(sdp: String) { remoteAnswerSdp = sdp }
    val remoteIce = mutableListOf<IceCandidate>()
    override fun addRemoteIceCandidates(candidates: List<IceCandidate>) { remoteIce.addAll(candidates) }
    override fun setMuted(muted: Boolean) { this.muted = muted }
    var restarts = 0
    override fun restartIce() { restarts += 1 }
    override fun readStats(onStats: (CallMediaStats) -> Unit) = onStats(stats)
    override fun release() { released = true }
}

private class FakeNotifier : CallNotifier {
    val incoming = mutableListOf<String>()
    val ongoing = mutableListOf<String>()
    val incomingNames = mutableListOf<String>()
    val ongoingNames = mutableListOf<String>()
    var cleared = 0
    override fun showIncoming(callId: String, peer: String, peerName: String) {
        incoming.add(callId)
        incomingNames.add(peerName)
    }
    override fun showOngoing(callId: String, peer: String, peerName: String) {
        ongoing.add(callId)
        ongoingNames.add(peerName)
    }
    override fun clear() { cleared += 1 }
}

private class FakeAudio : CallAudioController {
    var started = false
    var stopped = false
    var lastRoute: AudioRoute? = null
    override fun start() { started = true }
    override fun setRoute(route: AudioRoute) { lastRoute = route }
    override fun stop() { stopped = true }
}

private class FakeRinger : CallRingtonePlayer {
    var started = 0
    var outgoing = 0
    var stopped = 0
    val ringing: Boolean get() = started > stopped
    override fun startIncoming() { started += 1 }
    override fun startOutgoing() { outgoing += 1 }
    override fun stop() { stopped += 1 }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallControllerTest {
    private val fakeContext get() = ApplicationProvider.getApplicationContext<Application>()

    private inner class Fixture(
        scope: TestScope,
        engineAvailable: Boolean = true,
        fetchTurnConfig: suspend () -> TurnConfig? = { TurnConfig(600, emptyList()) },
        /** Whether this device is allowed to raise the call screen directly;
         *  `false` is a background process the platform refuses. */
        private val canRaiseUi: Boolean = true,
        engineContext: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext,
        buildEngine: (WebRtcEngineListener) -> FakeEngine = { FakeEngine(it) },
    ) {
        val sent = mutableListOf<Pair<String, JsonObject>>()
        val engines = mutableListOf<FakeEngine>()
        val listeners = mutableListOf<WebRtcEngineListener>()
        val notifier = FakeNotifier()
        val audio = FakeAudio()
        val ringer = FakeRinger()
        val ended = mutableListOf<CallLogEntry>()
        val openedUi = mutableListOf<Pair<String, String>>()
        var clock = 1_000L
        var nextId = 0
        var self = "anna"

        var names = mutableMapOf<String, String>()
        val controller = CallController(
            context = fakeContext,
            scope = scope,
            sendFrame = { peer, frame -> sent.add(peer to frame); true },
            selfLogin = { self },
            fetchTurnConfig = fetchTurnConfig,
            notifications = notifier,
            audio = audio,
            engineFactory = { engineListener ->
                listeners.add(engineListener)
                buildEngine(engineListener).also { engines.add(it) }
            },
            now = { clock },
            idFactory = { "call-${++nextId}" },
            engineAvailable = { engineAvailable },
            onCallEnded = { ended.add(it) },
            openCallUi = { callId, peer -> openedUi.add(callId to peer); canRaiseUi },
            resolveName = { login -> names[login] },
            ringer = ringer,
            isAppForeground = { canRaiseUi },
            engineContext = engineContext,
        )
    }

    private fun Fixture.lastFrameTo(peer: String): JsonObject? = sent.lastOrNull { it.first == peer }?.second
    private fun JsonObject.type(): String? = (this["t"] as? kotlinx.serialization.json.JsonPrimitive)?.content

    /** Places a call and drives it all the way to Active, the only state the
     *  media samples are read in. */
    private fun TestScope.connectedCall(fx: Fixture) {
        fx.controller.placeCall("boris", "Boris")
        // The engine is built on `engineContext` after the TURN fetch, so the
        // listener does not exist until the scheduler has run that out.
        advanceUntilIdle()
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Answer("call-1", "v=0")))
        fx.listeners[0].onIceConnectionChange(connected = true, failed = false)
        advanceUntilIdle()
    }

    @Test
    fun placingACallStartsTheEngineAndEndsUpOutgoingThenConnecting() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()

        assertTrue(fx.controller.state.value.call is CallState.Outgoing || fx.controller.state.value.call is CallState.Ringing)
        assertEquals(1, fx.engines.size)
        assertTrue(fx.engines[0].started)
    }

    /** The caller used to get no feedback at all: no screen, no notification,
     *  nothing to hang up with — only the callee's device showed a call was
     *  happening. */
    @Test
    fun placingACallRaisesTheCallScreenAndItsOngoingNotification() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()

        assertEquals(listOf("call-1" to "boris"), fx.openedUi)
        assertEquals(listOf("call-1"), fx.notifier.ongoing)
        assertEquals("Boris", fx.controller.state.value.peerName)
    }

    @Test
    fun anOfferIsAcceptedAsIncomingRingingAndSendsCallRingBack() = runTest {
        val fx = Fixture(this)
        val offer = CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock))
        fx.controller.onSignalReceived("boris", offer)
        advanceUntilIdle()

        val call = fx.controller.state.value.call
        assertTrue(call is CallState.Ringing && call.isIncoming)
        assertEquals(listOf("c1" to "boris"), fx.openedUi)
        assertEquals("call-ring", fx.lastFrameTo("boris")?.type())
    }

    /**
     * The hub holds a `call-offer` for the caller's ring window and replays
     * it to the next device that connects, so the phone whose socket blipped
     * between taking the offer and its `call-ring` reaching the server is
     * handed the same offer again. Treating it as a second call answered
     * `busy` — and killed the call this device was ringing for.
     */
    @Test
    fun aReplayedOfferForTheRingingCallReRingsInsteadOfDeclining() = runTest {
        val fx = Fixture(this)
        val offer = CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock))
        fx.controller.onSignalReceived("boris", offer)
        advanceUntilIdle()
        fx.controller.onSignalReceived("boris", offer)
        advanceUntilIdle()

        val call = fx.controller.state.value.call
        assertTrue(call is CallState.Ringing && call.isIncoming)
        assertTrue(fx.sent.none { it.second.type() == "call-end" })
        assertEquals(2, fx.sent.count { it.second.type() == "call-ring" })
        assertEquals(listOf("c1" to "boris"), fx.openedUi)
    }

    /**
     * One incoming UI, never two. The full-screen intent is refused while
     * the app is visible (it becomes a heads-up strip), so the call screen
     * is raised directly — and posting the notification anyway put a banner
     * on top of the full-screen call.
     */
    @Test
    fun theIncomingNotificationIsPostedOnlyWhenTheScreenCouldNotBeRaised() = runTest {
        val raised = Fixture(this)
        raised.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", raised.clock)))
        advanceUntilIdle()
        assertEquals(0, raised.notifier.incoming.size)

        val background = Fixture(this, canRaiseUi = false)
        background.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c2", "v=0", "audio", background.clock)))
        advanceUntilIdle()
        assertEquals(listOf("c2"), background.notifier.incoming)
    }

    @Test
    fun backgroundOfferPostsNotificationEvenIfStartActivityReturnsSuccess() = runTest {
        // Simulates Android BAL: startActivity does not throw an exception,
        // so openCallUi would return true if called blindly. When the app is in
        // the background (isAppForeground = false), the notification MUST be
        // posted regardless.
        val fx = Fixture(this, canRaiseUi = true)
        val controller = CallController(
            context = fakeContext,
            scope = this,
            sendFrame = { _, _ -> true },
            selfLogin = { "anna" },
            fetchTurnConfig = { TurnConfig(600, emptyList()) },
            notifications = fx.notifier,
            audio = fx.audio,
            engineFactory = { fx.engines.add(FakeEngine(it)); FakeEngine(it) },
            now = { fx.clock },
            idFactory = { "call-bg" },
            engineAvailable = { true },
            openCallUi = { _, _ -> true },
            ringer = fx.ringer,
            isAppForeground = { false },
            engineContext = kotlin.coroutines.EmptyCoroutineContext,
        )
        controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c-bg", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        assertEquals(listOf("c-bg"), fx.notifier.incoming)
    }

    @Test
    fun anIncomingOfferRingsUntilItIsAnswered() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        assertTrue(fx.ringer.ringing)
        // Taking voice-communication focus while still ringing would route
        // the melody into the earpiece: the callee's audio stack waits.
        assertFalse(fx.audio.started)

        fx.controller.answer()
        advanceUntilIdle()
        assertFalse(fx.ringer.ringing)
        assertTrue(fx.audio.started)
    }

    @Test
    fun aDeclinedCallStopsRinging() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.decline()
        advanceUntilIdle()
        assertFalse(fx.ringer.ringing)
    }

    /** The caller hears the ringback, never the callee's melody, and it
     *  starts only once the callee's own device says it is ringing — a tone
     *  before `call-ring` says "ringing" about a phone nothing has reached. */
    @Test
    fun theRingbackStartsWithTheCalleesRingAndStopsWhenItIsAnswered() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        assertEquals(0, fx.ringer.started)
        assertEquals(0, fx.ringer.outgoing)
        assertEquals(0, fx.ringer.stopped)
        assertTrue(fx.audio.started)

        // The callee's device woke up and is ringing.
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Ring("call-1")))
        advanceUntilIdle()
        assertEquals(1, fx.ringer.outgoing)
        assertEquals(0, fx.ringer.stopped)

        // A repeated `call-ring` for the same call re-rings nothing.
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Ring("call-1")))
        advanceUntilIdle()
        assertEquals(1, fx.ringer.outgoing)

        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Answer("call-1", "v=0")))
        advanceUntilIdle()
        assertTrue(fx.ringer.stopped > 0)
    }

    /** A call that is never answered is never announced as ringing either:
     *  the callee's phone was never reached, so there is no ringback to hear
     *  for it — only "Calling…" on screen, which is what is true. */
    @Test
    fun aCallNobodyRangForPlaysNoRingback() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()

        assertEquals(0, fx.ringer.outgoing)
    }

    /** The engine is built off the main thread (so `PeerConnectionFactory`
     *  cannot ANR the UI), which opens a window where the peer's candidates
     *  arrive before there is anything to hand them to. Dropping them leaves
     *  the call stuck at `Connecting`. */
    @Test
    fun remoteCandidatesArrivingBeforeTheEngineExistsAreAppliedOnceItDoes() = runTest {
        val turn = CompletableDeferred<TurnConfig?>()
        val fx = Fixture(this, fetchTurnConfig = { turn.await() })
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        runCurrent()
        assertTrue(fx.engines.isEmpty())

        val early = IceCandidate("candidate:early", "audio", 0)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.IceCandidates("c1", listOf(early))))
        runCurrent()

        turn.complete(TurnConfig(600, emptyList()))
        advanceUntilIdle()
        assertEquals(listOf(early), fx.engines[0].remoteIce)
    }

    @Test
    fun answeringAppliesTheRemoteOfferAndCreatesAnAnswer() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.answer()
        advanceUntilIdle()

        assertEquals("v=0", fx.engines[0].remoteOfferSdp)
        assertTrue(fx.engines[0].answerCreated)
        assertTrue(fx.audio.started)
        assertEquals(1, fx.notifier.ongoing.size)
    }

    @Test
    fun answeringBeforeTurnConfigIsReadyEmitsOneAnswerAfterStartup() = runTest {
        val turn = CompletableDeferred<TurnConfig?>()
        val fx = Fixture(this, fetchTurnConfig = { turn.await() })
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        runCurrent()

        fx.controller.answer()
        fx.controller.answer()
        runCurrent()
        assertTrue(fx.controller.state.value.call is CallState.Connecting)
        assertTrue(fx.sent.none { it.second.type() == "call-answer" })

        turn.complete(TurnConfig(600, emptyList()))
        runCurrent()
        fx.controller.answer()
        runCurrent()

        assertEquals(
            listOf("boris" to CallFrame.Answer("c1", "answer:v=0")),
            fx.sent.filter { it.second.type() == "call-answer" }.map { it.first to CallSignaling.fromJson(it.second) },
        )
    }

    @Test
    fun cancelledStartupCannotStartAReleasedEngineOrConsumeTheReplacementOffer() = runTest {
        val firstTurn = CompletableDeferred<TurnConfig?>()
        val replacementTurn = CompletableDeferred<TurnConfig?>()
        var fetches = 0
        val fx = Fixture(this, fetchTurnConfig = {
            if (++fetches == 1) {
                // A late network response can arrive even after teardown
                // cancels the startup job. It still belongs to the old call.
                withContext(NonCancellable) { firstTurn.await() }
            } else {
                replacementTurn.await()
            }
        })
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "first", "audio", fx.clock)))
        runCurrent()
        fx.controller.hangup()
        fx.controller.onSignalReceived("roman", CallSignaling.toJson(CallFrame.Offer("c2", "replacement", "audio", fx.clock)))
        fx.controller.answer()
        runCurrent()

        firstTurn.complete(TurnConfig(600, emptyList()))
        runCurrent()
        // The engine is built only after the TURN fetch returns, so a startup
        // whose call is already gone builds nothing at all — there is no
        // released-but-started engine to guard against any more, and no
        // answer for the abandoned call.
        assertTrue(fx.engines.isEmpty())
        assertTrue(fx.sent.none { it.second.type() == "call-answer" })

        replacementTurn.complete(TurnConfig(600, emptyList()))
        runCurrent()
        assertEquals(
            listOf("roman" to CallFrame.Answer("c2", "answer:replacement")),
            fx.sent.filter { it.second.type() == "call-answer" }.map { it.first to CallSignaling.fromJson(it.second) },
        )
    }

    @Test
    fun hangingUpDuringNativeConstructionReleasesTheUnadoptedEngine() = runTest {
        val ownerScope = TestScope(testScheduler)
        val constructed = CompletableDeferred<FakeEngine>()
        val allowReturn = java.util.concurrent.CountDownLatch(1)
        val fx = Fixture(
            ownerScope,
            engineContext = kotlinx.coroutines.Dispatchers.Default,
            buildEngine = { listener ->
                FakeEngine(listener).also {
                    constructed.complete(it)
                    check(allowReturn.await(10, java.util.concurrent.TimeUnit.SECONDS))
                }
            },
        )
        try {
            fx.controller.placeCall("boris", "Boris")
            runCurrent()
            val built = constructed.await()
            val startupJobs = ownerScope.coroutineContext[kotlinx.coroutines.Job]!!.children.toList()
            fx.controller.hangup()
            allowReturn.countDown()
            startupJobs.forEach { it.join() }
            assertTrue("cancelled construction must release its native owner", built.released)
            assertFalse("a cancelled call must not start media", built.started)
        } finally {
            allowReturn.countDown()
            ownerScope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
        }
    }

    @Test
    fun decliningSendsCallEndDeclinedAndReturnsToEnded() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.decline()

        val call = fx.controller.state.value.call
        assertTrue(call is CallState.Ended && call.reason == CallEndReason.Declined)
        assertEquals("call-end", fx.lastFrameTo("boris")?.type())
    }

    @Test
    fun hangupTearsDownTheEngineAndAudio() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        fx.controller.hangup()

        assertTrue(fx.engines[0].released)
        assertTrue(fx.audio.stopped)
        assertTrue(fx.controller.state.value.call is CallState.Ended)
    }

    @Test
    fun aSecondCallIsRefusedWhileOneIsAlreadyInProgress() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        val before = fx.controller.state.value.call
        fx.controller.placeCall("roman", "Roman")
        advanceUntilIdle()

        assertEquals(before, fx.controller.state.value.call)
        assertEquals(1, fx.engines.size)
    }

    @Test
    fun anEngineThatNeverBecomesAvailableEndsTheIncomingCallAsUnsupported() = runTest {
        // CallEngineAvailability.available defaults to false until
        // ensureChecked() runs (never called in this JVM test), so an
        // incoming offer must fail closed rather than construct a real
        // WebRtcEngine, which would throw on this target.
        val fx = Fixture(this, engineAvailable = false)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()

        val call = fx.controller.state.value.call
        assertTrue(call is CallState.Ended && call.reason == CallEndReason.Unsupported)
        assertEquals("call-end", fx.lastFrameTo("boris")?.type())
        assertTrue(fx.engines.isEmpty())
    }

    @Test
    fun callTakenFromAnotherOwnDeviceEndsAnIncomingRing() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.onOwnDeviceTook("c1")

        assertEquals(CallState.Ended("c1", "boris", CallEndReason.Unknown), fx.controller.state.value.call)
    }

    // ---- §4.5: onCallEnded ---------------------------------------------

    @Test
    fun decliningAnIncomingCallReportsItAsDeclinedNotActive() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.decline()

        assertEquals(1, fx.ended.size)
        val entry = fx.ended.single()
        assertEquals("c1", entry.callId)
        assertEquals("boris", entry.peer)
        assertEquals(true, entry.incoming)
        assertEquals(false, entry.everActive)
        assertEquals(CallEndReason.Declined, entry.reason)
    }

    @Test
    fun hangingUpBeforeTheCalleeAnsweredReportsAnOutgoingCallThatNeverConnected() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        fx.controller.hangup()

        assertEquals(1, fx.ended.size)
        val entry = fx.ended.single()
        assertEquals(false, entry.incoming)
        assertEquals(false, entry.everActive)
        assertEquals(CallEndReason.Hangup, entry.reason)
    }

    @Test
    fun onlyOneLogEntryIsReportedPerCallEvenIfEndFiresTwice() = runTest {
        val fx = Fixture(this)
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        fx.controller.hangup()
        fx.controller.hangup()

        assertEquals(1, fx.ended.size)
    }

    /**
     * A connected call can be silent in both directions and look identical to
     * a working one: ICE says connected, the notification is up, and the
     * platform silences a microphone without telling the process. These are
     * the only numbers that distinguish the two.
     */
    @Test
    fun aConnectedCallThatCarriesNothingIsReportedAsSilentInBothDirections() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        // A first sample can never accuse anything: one quiet interval is a
        // pause between words, not a broken call.
        fx.controller.sampleMedia()
        advanceUntilIdle()
        assertEquals(false, fx.controller.state.value.media?.inboundSilent)
        assertEquals(false, fx.controller.state.value.media?.micSilent)

        repeat(4) {
            fx.controller.sampleMedia()
            advanceUntilIdle()
        }
        val media = fx.controller.state.value.media
        assertEquals(true, media?.inboundSilent)
        assertEquals(true, media?.micSilent)
    }

    @Test
    fun aCallThatIsCarryingAudioIsNotReportedAsSilent() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        repeat(5) { sample ->
            fx.engines[0].stats = CallMediaStats(
                bytesSent = 1_000L * (sample + 1),
                bytesReceived = 900L * (sample + 1),
                outboundAudioLevel = 0.2,
                inboundAudioLevel = 0.3,
            )
            fx.controller.sampleMedia()
            advanceUntilIdle()
        }

        val media = fx.controller.state.value.media
        assertEquals(false, media?.inboundSilent)
        assertEquals(false, media?.micSilent)
        assertEquals(5_000L, media?.bytesSent)
    }

    /** Muting is the person's own choice, so it is never reported as a fault. */
    @Test
    fun aMutedMicrophoneIsNotReportedAsSilent() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)
        fx.controller.setMuted(true)

        repeat(5) {
            fx.controller.sampleMedia()
            advanceUntilIdle()
        }

        assertEquals(false, fx.controller.state.value.media?.micSilent)
    }

    /** An offer carries the caller's login; every other screen in this app
     *  shows the roster's name for that login, and the call screen and the
     *  shade used to be the one place that showed the raw login instead. */
    @Test
    fun anIncomingCallIsLabelledWithTheRostersNameNotTheLogin() = runTest {
        // The shade is where the name has to be right when the call screen
        // itself could not be raised.
        val fx = Fixture(this, canRaiseUi = false)
        fx.names["boris"] = "Борис"
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("call-9", "v=0", "audio", 1_000L)))
        advanceUntilIdle()

        assertEquals("Борис", fx.controller.state.value.peerName)
        assertEquals(listOf("Борис"), fx.notifier.incomingNames)
    }

    /** Renaming a contact mid-call used to change the roster only: the call
     *  screen and the shade kept the name resolved when the call started. */
    @Test
    fun renamingTheContactDuringACallUpdatesTheScreenAndTheShade() = runTest {
        val fx = Fixture(this)
        fx.names["boris"] = "Boris"
        connectedCall(fx)
        advanceUntilIdle()
        assertEquals("Boris", fx.controller.state.value.peerName)

        fx.names["boris"] = "Борис Иванов"
        fx.controller.onRosterChanged()

        assertEquals("Борис Иванов", fx.controller.state.value.peerName)
        assertEquals("Борис Иванов", fx.notifier.ongoingNames.last())
    }

    /** A roster update that changes nothing must not re-post the ongoing
     *  notification: that is a foreground-service start per roster frame. */
    @Test
    fun anUnchangedRosterDoesNotRepostTheOngoingNotification() = runTest {
        val fx = Fixture(this)
        fx.names["boris"] = "Boris"
        connectedCall(fx)
        advanceUntilIdle()
        val posts = fx.notifier.ongoing.size

        fx.controller.onRosterChanged()

        assertEquals(posts, fx.notifier.ongoing.size)
    }

    /**
     * «Звонки перестают работать, помогает только перезапуск.» One call at a
     * time, process-wide: a `Connecting` that is never left — the peer's
     * process was killed mid-handshake, so no answer, no `call-end`, and ICE
     * never reaches `failed` — used to refuse every later call silently and
     * answer every incoming offer with `busy` until the app was restarted.
     */
    @Test
    fun aCallStuckInConnectingExpiresAndLeavesTheDeviceAbleToCallAgain() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.answer()
        assertTrue(fx.controller.state.value.call is CallState.Connecting)

        fx.clock += CallController.CONNECT_TIMEOUT_MS
        advanceUntilIdle()

        val ended = fx.controller.state.value.call
        assertTrue(ended is CallState.Ended && ended.reason == CallEndReason.Failed)
        assertEquals("call-end", fx.lastFrameTo("boris")?.type())

        // The point of the timeout: the next call is possible without a restart.
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        assertTrue(fx.controller.state.value.call.activeCallId() != null)
    }

    /** The same trap on the other side: `Ended` is cleared by the call
     *  screen, and that screen never runs when the platform refused the
     *  full-screen intent and the call was handled from the notification. */
    @Test
    fun aFinishedCallNobodyDismissedGoesBackToIdleOnItsOwn() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.decline()
        assertTrue(fx.controller.state.value.call is CallState.Ended)

        fx.clock += CallController.ENDED_RESET_MS
        advanceUntilIdle()

        assertEquals(CallState.Idle, fx.controller.state.value.call)
    }

    /**
     * «Если я перестал звонить, смартфон абонента продолжает звонить»: with
     * no socket the caller's cancel cannot arrive and an answer could not be
     * sent, so a ring outlives the call that caused it. A *connected* call
     * is peer-to-peer and must survive the same event.
     */
    @Test
    fun losingTheLinkStopsAnIncomingRing() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        assertTrue(fx.ringer.ringing)

        fx.controller.onLinkLost()
        assertFalse(fx.ringer.ringing)
        assertTrue(fx.controller.state.value.call is CallState.Ended)
    }

    /** A connected call is peer-to-peer media; the signalling socket going
     *  away must not end it. */
    @Test
    fun losingTheLinkDoesNotEndAConnectedCall() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)
        assertTrue(fx.controller.state.value.call is CallState.Active)

        fx.controller.onLinkLost()

        assertTrue(fx.controller.state.value.call is CallState.Active)
    }

    /**
     * §7.6: «смена сети во время разговора (Wi-Fi → LTE): ICE restart,
     * разговор восстанавливается или честно завершается `failed`». Ending
     * the call the instant ICE gave up is what «бывает, что разговор
     * сбрасывается» was — the audio path broke, the conversation did not.
     */
    @Test
    fun anIceFailureMidConversationRestartsItInsteadOfEndingIt() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()

        assertTrue(fx.controller.state.value.call is CallState.Active)
        assertEquals(1, fx.engines[0].restarts)
        assertEquals(2, fx.engines[0].offers)
        // The re-offer is marked, because it is the same frame a new call
        // uses: unmarked, the server would hold it and ring the peer's phone
        // for the call it is already in.
        val offer = CallSignaling.fromJson(fx.lastFrameTo("boris")!!) as CallFrame.Offer
        assertEquals("call-1", offer.callId)
        assertTrue(offer.restart)
    }

    @Test
    fun aConversationThatDoesNotComeBackAfterARestartEndsAsFailed() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()
        fx.clock += CallController.ICE_RESTART_GRACE_MS
        advanceUntilIdle()

        val ended = fx.controller.state.value.call
        assertTrue(ended is CallState.Ended && ended.reason == CallEndReason.Failed)
    }

    /** A restart that reconnects is the point of the attempt: the deadline
     *  must not end a conversation that is talking again. */
    @Test
    fun aConversationThatComesBackKeepsRunning() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()
        fx.listeners[0].onIceConnectionChange(connected = true, failed = false)
        runCurrent()
        fx.clock += CallController.ICE_RESTART_GRACE_MS
        advanceUntilIdle()

        assertTrue(fx.controller.state.value.call is CallState.Active)
    }

    /** One attempt per call, and only from the caller. Both sides see the
     *  same broken path at the same moment, and two offers crossing leave
     *  both connections in `have-local-offer`, where neither applies. */
    @Test
    fun theCalleeWaitsOutTheRestartWindowWithoutReOffering() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.answer()
        fx.listeners[0].onIceConnectionChange(connected = true, failed = false)
        advanceUntilIdle()
        assertTrue(fx.controller.state.value.call is CallState.Active)
        val offersBefore = fx.engines[0].offers

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()

        assertEquals(0, fx.engines[0].restarts)
        assertEquals(offersBefore, fx.engines[0].offers)
        // And the same deadline still applies: a call whose media path is
        // gone must not sit on screen looking connected.
        fx.clock += CallController.ICE_RESTART_GRACE_MS
        advanceUntilIdle()
        assertTrue(fx.controller.state.value.call is CallState.Ended)
    }

    /** The caller's own re-offer, reaching the callee: the answerer applies
     *  it and answers — it never re-offers back. */
    @Test
    fun theCalleeAppliesAReOfferToItsLiveEngine() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("c1", "v=0", "audio", fx.clock)))
        advanceUntilIdle()
        fx.controller.answer()
        fx.listeners[0].onIceConnectionChange(connected = true, failed = false)
        advanceUntilIdle()

        fx.controller.onSignalReceived(
            "boris",
            CallSignaling.toJson(CallFrame.Offer("c1", "v=1", "audio", fx.clock, restart = true)),
        )
        advanceUntilIdle()

        assertEquals("v=1", fx.engines[0].remoteOfferSdp)
        assertTrue(fx.sent.any { it.second.type() == "call-answer" })
        assertTrue(fx.controller.state.value.call is CallState.Active)
    }

    /** A re-negotiation for a call this device is not in. The hub has no way
     *  to address one device of an account, so every other session of the
     *  recipient is handed the frame too — and a phone that is not in this
     *  call must not start ringing for it. */
    @Test
    fun aReOfferArrivingAtAnIdleDeviceDoesNotRingIt() = runTest {
        val fx = Fixture(this)
        fx.controller.onSignalReceived(
            "boris",
            CallSignaling.toJson(CallFrame.Offer("c1", "v=1", "audio", fx.clock, restart = true)),
        )
        advanceUntilIdle()

        assertEquals(CallState.Idle, fx.controller.state.value.call)
        assertFalse(fx.ringer.ringing)
        assertTrue(fx.sent.isEmpty())
    }

    /** A duplicate of an ordinary offer for a call already in progress is not
     *  a re-negotiation: without the marker it is a frame the hub replayed
     *  for a phone that is no longer ringing, and applying its SDP would
     *  throw away the negotiation the call is actually using. */
    @Test
    fun aRepeatedOrdinaryOfferOnALiveCallIsDropped() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Offer("call-1", "v=stale", "audio", fx.clock)))
        advanceUntilIdle()

        assertEquals(null, fx.engines[0].remoteOfferSdp)
        assertTrue(fx.controller.state.value.call is CallState.Active)
    }

    /** The other half of the restart, from the caller: the answer to its own
     *  re-offer has to be applied to the connection it is already talking
     *  over. `CallTransitions.accept` is a no-op on an `Active` call, so
     *  nothing but this pins that the whole path still reaches the engine. */
    @Test
    fun theCallerAppliesTheAnswerToItsOwnRestartOffer() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()

        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Answer("call-1", "v=restart")))
        // `runCurrent`, not `advanceUntilIdle`: the restart deadline is armed
        // by the failure above, and advancing time would run it and end the
        // call before the answer is read back.
        runCurrent()

        assertEquals("v=restart", fx.engines[0].remoteAnswerSdp)
        assertTrue(fx.controller.state.value.call is CallState.Active)
    }

    /** One attempt per call. A path that failed twice is not rebuilt by
     *  re-offering the same two candidates again, and the deadline armed by
     *  the first failure is what ends the call. */
    @Test
    fun aSecondIceFailureDoesNotReOfferAgain() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()
        assertEquals(1, fx.engines[0].restarts)

        fx.listeners[0].onIceConnectionChange(connected = false, failed = true)
        runCurrent()
        assertEquals(1, fx.engines[0].restarts)
        assertEquals(2, fx.engines[0].offers)

        advanceUntilIdle()
        val ended = fx.controller.state.value.call
        assertTrue(ended is CallState.Ended && ended.reason == CallEndReason.Failed)
    }

    /** The same stale-engine rule on the way out: SDP from the released
     *  engine must not be sent as the replacement call's — the peer would
     *  apply an offer for a call id it has already finished with. */
    @Test
    fun anOldEnginesSdpIsNotSentAsTheNewCalls() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)
        val oldListener = fx.listeners[0]
        fx.controller.hangup()
        advanceUntilIdle()
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()

        val sentBefore = fx.sent.size
        oldListener.onLocalSdpReady("v=stale", "offer")
        oldListener.onLocalSdpReady("v=stale", "answer")
        runCurrent()

        assertEquals(sentBefore, fx.sent.size)
    }

    /**
     * A released engine's native callbacks still arrive — disposal is not what
     * stops them. Read against whatever call is live *now*, an `ice` failure
     * from the previous one ends the new call before it can connect, which is
     * the "calling stops working until the app is restarted" shape the
     * ownership rules elsewhere in this class exist to prevent.
     */
    @Test
    fun anOldEnginesIceFailureDoesNotEndTheCallThatReplacedIt() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)
        val oldListener = fx.listeners[0]
        fx.controller.hangup()
        advanceUntilIdle()

        // A second call, still ringing out.
        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        assertTrue(fx.controller.state.value.call is CallState.Outgoing)
        val offersBefore = fx.engines.last().offers

        oldListener.onIceConnectionChange(connected = false, failed = true)
        runCurrent()

        assertTrue(fx.controller.state.value.call is CallState.Outgoing)
        assertEquals("call-2", fx.controller.state.value.call.activeCallId())
        assertEquals(0, fx.engines.last().restarts)
        assertEquals(offersBefore, fx.engines.last().offers)
    }

    /** The same stale callback cannot end an *established* replacement call
     *  either — it is not this call's media path that failed. */
    @Test
    fun anOldEnginesIceFailureDoesNotRestartAReplacementCall() = runTest {
        val fx = Fixture(this)
        connectedCall(fx)
        val oldListener = fx.listeners[0]
        fx.controller.hangup()
        advanceUntilIdle()

        fx.controller.placeCall("boris", "Boris")
        advanceUntilIdle()
        fx.controller.onSignalReceived("boris", CallSignaling.toJson(CallFrame.Answer("call-2", "v=0")))
        fx.listeners.last().onIceConnectionChange(connected = true, failed = false)
        advanceUntilIdle()
        assertTrue(fx.controller.state.value.call is CallState.Active)

        oldListener.onIceConnectionChange(connected = false, failed = true)
        runCurrent()

        assertTrue(fx.controller.state.value.call is CallState.Active)
        assertEquals("call-2", fx.controller.state.value.call.activeCallId())
        assertEquals(0, fx.engines.last().restarts)
    }
}
