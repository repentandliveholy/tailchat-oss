package net.tailchat.android.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallTransitionsTest {
    @Test
    fun placeStartsOutgoingFromIdle() {
        val next = CallTransitions.place(CallState.Idle, "c1", "boris", 1000L)
        assertEquals(CallState.Outgoing("c1", "boris", 1000L), next)
    }

    @Test
    fun placeIsRefusedWhileAnotherCallIsInProgress() {
        val ringing = CallState.Ringing("c1", "boris", isIncoming = true, startedAtMs = 0L)
        assertEquals(ringing, CallTransitions.place(ringing, "c2", "roman", 1000L))
    }

    @Test
    fun placeIsAllowedAgainOnceTheLastCallHasEnded() {
        val ended = CallState.Ended("c1", "boris", CallEndReason.Hangup)
        assertEquals(CallState.Outgoing("c2", "roman", 500L), CallTransitions.place(ended, "c2", "roman", 500L))
    }

    @Test
    fun receiveOfferStartsIncomingRinging() {
        val next = CallTransitions.receiveOffer(CallState.Idle, "c1", "boris", 100L)
        assertEquals(CallState.Ringing("c1", "boris", isIncoming = true, startedAtMs = 100L), next)
    }

    @Test
    fun theLexicographicallySmallerLoginWinsGlare() {
        assertTrue(CallTransitions.shouldYieldToIncoming("roman", "anna"))
        assertTrue(!CallTransitions.shouldYieldToIncoming("anna", "roman"))
    }

    @Test
    fun ringMovesOutgoingToRinging() {
        val outgoing = CallState.Outgoing("c1", "boris", 1000L)
        val next = CallTransitions.ring(outgoing, "c1")
        assertEquals(CallState.Ringing("c1", "boris", isIncoming = false, startedAtMs = 1000L), next)
    }

    @Test
    fun ringForAMismatchedCallIdIsIgnored() {
        val outgoing = CallState.Outgoing("c1", "boris", 1000L)
        assertEquals(outgoing, CallTransitions.ring(outgoing, "stale-call"))
    }

    @Test
    fun acceptMovesEitherDirectionToConnecting() {
        val outgoing = CallState.Outgoing("c1", "boris", 0L)
        assertEquals(CallState.Connecting("c1", "boris", isIncoming = false), CallTransitions.accept(outgoing, "c1"))

        val incomingRinging = CallState.Ringing("c1", "boris", isIncoming = true, startedAtMs = 0L)
        assertEquals(CallState.Connecting("c1", "boris", isIncoming = true), CallTransitions.accept(incomingRinging, "c1"))
    }

    @Test
    fun connectedMovesConnectingToActive() {
        val connecting = CallState.Connecting("c1", "boris", isIncoming = true)
        assertEquals(
            CallState.Active("c1", "boris", isIncoming = true, connectedAtMs = 9000L),
            CallTransitions.connected(connecting, "c1", 9000L),
        )
    }

    @Test
    fun endClosesFromAnyLiveState() {
        val active = CallState.Active("c1", "boris", isIncoming = false, connectedAtMs = 0L)
        assertEquals(CallState.Ended("c1", "boris", CallEndReason.Hangup), CallTransitions.end(active, "c1", CallEndReason.Hangup))
    }

    @Test
    fun endWithAMismatchedCallIdIsIgnored_aStaleFrameMustNotStopTheCallThatSupersededIt() {
        val active = CallState.Active("c2", "roman", isIncoming = false, connectedAtMs = 0L)
        assertEquals(active, CallTransitions.end(active, "c1-stale", CallEndReason.Hangup))
    }

    @Test
    fun takenEndsAnIncomingRingOrConnectNeverTouchedOtherwise() {
        val ringing = CallState.Ringing("c1", "boris", isIncoming = true, startedAtMs = 0L)
        assertEquals(CallState.Ended("c1", "boris", CallEndReason.Unknown), CallTransitions.taken(ringing, "c1"))

        // Never applies to a call this device placed itself.
        val outgoing = CallState.Outgoing("c1", "boris", 0L)
        assertEquals(outgoing, CallTransitions.taken(outgoing, "c1"))
    }

    @Test
    fun engineUnavailableIsModelledAsAnImmediateUnsupportedEnd() {
        // The controller is expected to call receiveOffer then immediately
        // end(...) with Unsupported when the engine never came up (§9.1) —
        // exercised here as the state the UI actually renders: no call ever
        // reaches Ringing/Connecting for this device.
        val offered = CallTransitions.receiveOffer(CallState.Idle, "c1", "boris", 0L)
        val unsupported = CallTransitions.end(offered, "c1", CallEndReason.Unsupported)
        assertEquals(CallState.Ended("c1", "boris", CallEndReason.Unsupported), unsupported)
        assertEquals(null, unsupported.activeCallId())
    }

    @Test
    fun dismissReturnsToIdleOnlyFromEnded() {
        val ended = CallState.Ended("c1", "boris", CallEndReason.Hangup)
        assertEquals(CallState.Idle, CallTransitions.dismiss(ended))
        val active = CallState.Active("c1", "boris", isIncoming = false, connectedAtMs = 0L)
        assertEquals(active, CallTransitions.dismiss(active))
    }

    @Test
    fun ringTimeoutFiresAt45sAndNotBefore() {
        val outgoing = CallState.Outgoing("c1", "boris", 0L)
        assertEquals(outgoing, CallTransitions.ringTimeout(outgoing, "c1", nowMs = 44_999L))
        assertEquals(
            CallState.Ended("c1", "boris", CallEndReason.Timeout),
            CallTransitions.ringTimeout(outgoing, "c1", nowMs = 45_000L),
        )
    }

    @Test
    fun ringTimeoutIgnoresAMismatchedCallIdOrAnAlreadyConnectedCall() {
        val outgoing = CallState.Outgoing("c1", "boris", 0L)
        assertEquals(outgoing, CallTransitions.ringTimeout(outgoing, "different-call", nowMs = 100_000L))

        val active = CallState.Active("c1", "boris", isIncoming = false, connectedAtMs = 0L)
        assertEquals(active, CallTransitions.ringTimeout(active, "c1", nowMs = 100_000L))
    }

    // ---- §4.5: CallTransitions.callLogEntry --------------------------------

    @Test
    fun logEntryOfAnAnsweredCallCarriesItsConnectedDuration() {
        val active = CallState.Active("c1", "boris", isIncoming = false, connectedAtMs = 10_000L)
        val ended = CallState.Ended("c1", "boris", CallEndReason.Hangup)
        val entry = CallTransitions.callLogEntry(active, ended, "Boris", endedAtMs = 40_000L)
        assertEquals(
            CallLogEntry(
                callId = "c1",
                peer = "boris",
                peerName = "Boris",
                incoming = false,
                everActive = true,
                reason = CallEndReason.Hangup,
                durationSec = 30,
                endedAtMs = 40_000L,
            ),
            entry,
        )
    }

    @Test
    fun logEntryOfAnIncomingCallNeverAnsweredIsMissedNotFailed() {
        val ringing = CallState.Ringing("c1", "boris", isIncoming = true, startedAtMs = 0L)
        val ended = CallState.Ended("c1", "boris", CallEndReason.Timeout)
        val entry = CallTransitions.callLogEntry(ringing, ended, "Boris", endedAtMs = 45_000L)
        assertEquals(false, entry?.everActive)
        assertEquals(true, entry?.incoming)
        assertEquals(0, entry?.durationSec)
        assertEquals(CallEndReason.Timeout, entry?.reason)
    }

    @Test
    fun logEntryOfAnOutgoingCallNobodyAnsweredIsStillOutgoing() {
        val outgoing = CallState.Outgoing("c1", "boris", 0L)
        val ended = CallState.Ended("c1", "boris", CallEndReason.Timeout)
        val entry = CallTransitions.callLogEntry(outgoing, ended, "Boris", endedAtMs = 45_000L)
        assertEquals(false, entry?.incoming)
        assertEquals(false, entry?.everActive)
    }

    @Test
    fun logEntryIsNullWhenThePreviousStateWasAlreadyTerminal() {
        val ended = CallState.Ended("c1", "boris", CallEndReason.Hangup)
        assertEquals(null, CallTransitions.callLogEntry(CallState.Idle, ended, "Boris", 0L))
        assertEquals(null, CallTransitions.callLogEntry(ended, ended, "Boris", 0L))
    }

    @Test
    fun logEntryOfATakenIncomingCallReportsWhichCallAndPeer() {
        val connecting = CallState.Connecting("c1", "boris", isIncoming = true)
        val ended = CallTransitions.taken(connecting, "c1") as CallState.Ended
        val entry = CallTransitions.callLogEntry(connecting, ended, "Boris", endedAtMs = 5_000L)
        assertEquals("c1", entry?.callId)
        assertEquals("boris", entry?.peer)
        assertEquals(CallEndReason.Unknown, entry?.reason)
        assertEquals(true, entry?.incoming)
        assertEquals(false, entry?.everActive)
    }
}
