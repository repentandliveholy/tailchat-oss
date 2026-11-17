package net.tailchat.android.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoicePlaybackTransitionsTest {
    @Test
    fun requestPlayFromIdleStartsLoading() {
        val next = VoicePlaybackTransitions.requestPlay(VoicePlaybackState.Idle, "m1")
        assertEquals(VoicePlaybackState.Loading("m1"), next)
    }

    @Test
    fun requestPlayOnTheAlreadyPlayingMessageIsANoOp() {
        val playing = VoicePlaybackState.Playing("m1", positionMs = 1200, durationMs = 5000)
        val next = VoicePlaybackTransitions.requestPlay(playing, "m1")
        assertEquals(playing, next)
    }

    @Test
    fun requestPlayResumesAPausedMessageAtItsSavedPosition() {
        val paused = VoicePlaybackState.Paused("m1", positionMs = 3000, durationMs = 5000)
        val next = VoicePlaybackTransitions.requestPlay(paused, "m1")
        assertEquals(VoicePlaybackState.Playing("m1", positionMs = 3000, durationMs = 5000), next)
    }

    @Test
    fun requestPlayOnADifferentMessageAlwaysStartsAFreshLoad() {
        val playingOther = VoicePlaybackState.Playing("m1", positionMs = 1000, durationMs = 5000)
        assertEquals(VoicePlaybackState.Loading("m2"), VoicePlaybackTransitions.requestPlay(playingOther, "m2"))

        val pausedOther = VoicePlaybackState.Paused("m1", positionMs = 1000, durationMs = 5000)
        assertEquals(VoicePlaybackState.Loading("m2"), VoicePlaybackTransitions.requestPlay(pausedOther, "m2"))

        val failed = VoicePlaybackState.Failed("m1", VoiceFailureReason.Playback)
        assertEquals(VoicePlaybackState.Loading("m1"), VoicePlaybackTransitions.requestPlay(failed, "m1"))
    }

    @Test
    fun preparedLandingForTheLoadingMessageStartsPlayingAtZero() {
        val loading = VoicePlaybackState.Loading("m1")
        val next = VoicePlaybackTransitions.prepared(loading, "m1", durationMs = 4200)
        assertEquals(VoicePlaybackState.Playing("m1", positionMs = 0, durationMs = 4200), next)
    }

    @Test
    fun aStalePreparedCallbackForAnAbandonedMessageIsDropped() {
        // The user moved on to m2 before m1 finished preparing.
        val loadingOther = VoicePlaybackState.Loading("m2")
        assertNull(VoicePlaybackTransitions.prepared(loadingOther, "m1", durationMs = 4200))
        assertNull(VoicePlaybackTransitions.prepared(VoicePlaybackState.Idle, "m1", durationMs = 4200))
    }

    @Test
    fun pausedFreezesTheCurrentPositionOfAPlayingMessage() {
        val playing = VoicePlaybackState.Playing("m1", positionMs = 2500, durationMs = 5000)
        assertEquals(
            VoicePlaybackState.Paused("m1", positionMs = 2500, durationMs = 5000),
            VoicePlaybackTransitions.paused(playing),
        )
    }

    @Test
    fun pausedIsANoOpWhenNothingIsPlaying() {
        assertEquals(VoicePlaybackState.Idle, VoicePlaybackTransitions.paused(VoicePlaybackState.Idle))
        val loading = VoicePlaybackState.Loading("m1")
        assertEquals(loading, VoicePlaybackTransitions.paused(loading))
    }

    @Test
    fun tickAdvancesPositionOnlyWhilePlaying() {
        val playing = VoicePlaybackState.Playing("m1", positionMs = 100, durationMs = 5000)
        assertEquals(
            VoicePlaybackState.Playing("m1", positionMs = 900, durationMs = 5000),
            VoicePlaybackTransitions.tick(playing, 900),
        )
        val paused = VoicePlaybackState.Paused("m1", positionMs = 100, durationMs = 5000)
        assertEquals(paused, VoicePlaybackTransitions.tick(paused, 900))
    }

    @Test
    fun completedRewindsToZeroAndLeavesItPaused() {
        val playing = VoicePlaybackState.Playing("m1", positionMs = 4999, durationMs = 5000)
        assertEquals(
            VoicePlaybackState.Paused("m1", positionMs = 0, durationMs = 5000),
            VoicePlaybackTransitions.completed(playing),
        )
    }

    @Test
    fun seekedUpdatesPositionForPlayingOrPausedAndIsInertOtherwise() {
        val playing = VoicePlaybackState.Playing("m1", positionMs = 0, durationMs = 5000)
        assertEquals(
            VoicePlaybackState.Playing("m1", positionMs = 3000, durationMs = 5000),
            VoicePlaybackTransitions.seeked(playing, 3000),
        )
        assertEquals(VoicePlaybackState.Idle, VoicePlaybackTransitions.seeked(VoicePlaybackState.Idle, 3000))
    }

    @Test
    fun clampSeekNeverLeavesTheTrack() {
        assertEquals(0, VoicePlaybackTransitions.clampSeek(-500, durationMs = 5000))
        assertEquals(5000, VoicePlaybackTransitions.clampSeek(9000, durationMs = 5000))
        assertEquals(2500, VoicePlaybackTransitions.clampSeek(2500, durationMs = 5000))
        // A duration that has not been established yet (0 or negative) still
        // clamps to a single valid point rather than accepting anything.
        assertEquals(0, VoicePlaybackTransitions.clampSeek(2500, durationMs = 0))
    }

    @Test
    fun failedIsReachableFromAnyState() {
        assertEquals(
            VoicePlaybackState.Failed("m1", VoiceFailureReason.Decode),
            VoicePlaybackTransitions.failed("m1", VoiceFailureReason.Decode),
        )
    }

    @Test
    fun messageIdOrNullIdentifiesTheStatesSubject() {
        assertNull(VoicePlaybackState.Idle.messageIdOrNull())
        assertEquals("m1", VoicePlaybackState.Loading("m1").messageIdOrNull())
        assertEquals("m1", VoicePlaybackState.Playing("m1", 0, 1000).messageIdOrNull())
        assertEquals("m1", VoicePlaybackState.Paused("m1", 0, 1000).messageIdOrNull())
        assertEquals("m1", VoicePlaybackState.Failed("m1", VoiceFailureReason.Playback).messageIdOrNull())
    }

    @Test
    fun aFullLifecycleThroughEveryStateEndsBackAtAPausedZero() {
        var state: VoicePlaybackState = VoicePlaybackState.Idle
        state = VoicePlaybackTransitions.requestPlay(state, "m1")
        assertTrue(state is VoicePlaybackState.Loading)
        state = VoicePlaybackTransitions.prepared(state, "m1", durationMs = 2000)!!
        assertEquals(VoicePlaybackState.Playing("m1", 0, 2000), state)
        state = VoicePlaybackTransitions.tick(state, 1000)
        state = VoicePlaybackTransitions.paused(state)
        assertEquals(VoicePlaybackState.Paused("m1", 1000, 2000), state)
        state = VoicePlaybackTransitions.requestPlay(state, "m1")
        assertEquals(VoicePlaybackState.Playing("m1", 1000, 2000), state)
        state = VoicePlaybackTransitions.completed(state)
        assertEquals(VoicePlaybackState.Paused("m1", 0, 2000), state)
    }
}
