package net.tailchat.android.cloud

/**
 * One playback slot per open conversation — a [VoicePlaybackController] never
 * holds more than one of these live at a time. Every mutation the controller
 * makes goes through [VoicePlaybackTransitions] so the rules here are
 * testable without a real `MediaPlayer` (see `VoicePlaybackTransitionsTest`).
 */
sealed interface VoicePlaybackState {
    data object Idle : VoicePlaybackState
    data class Loading(val messageId: String) : VoicePlaybackState
    data class Playing(val messageId: String, val positionMs: Int, val durationMs: Int) : VoicePlaybackState
    data class Paused(val messageId: String, val positionMs: Int, val durationMs: Int) : VoicePlaybackState
    data class Failed(val messageId: String, val reason: VoiceFailureReason) : VoicePlaybackState
}

enum class VoiceFailureReason { Decode, Prepare, Playback, AudioFocus }

/** The message id a state is "about", or null for [VoicePlaybackState.Idle]. */
fun VoicePlaybackState.messageIdOrNull(): String? = when (this) {
    is VoicePlaybackState.Idle -> null
    is VoicePlaybackState.Loading -> messageId
    is VoicePlaybackState.Playing -> messageId
    is VoicePlaybackState.Paused -> messageId
    is VoicePlaybackState.Failed -> messageId
}

/** Pure transition table for [VoicePlaybackState]. No `MediaPlayer`,
 *  `AudioManager` or coroutine in sight — [VoicePlaybackController] is the
 *  only caller, and every rule about what one user action or one player
 *  callback does to the state lives here instead of inline in it. */
object VoicePlaybackTransitions {
    /** User pressed play. Resuming the same paused message keeps its
     *  position; anything else (a different message, idle, a failed one)
     *  starts a fresh load — the caller is responsible for actually tearing
     *  down whatever `MediaPlayer` belonged to the previous message before
     *  calling this. */
    fun requestPlay(current: VoicePlaybackState, messageId: String): VoicePlaybackState = when {
        current is VoicePlaybackState.Playing && current.messageId == messageId -> current
        current is VoicePlaybackState.Paused && current.messageId == messageId ->
            VoicePlaybackState.Playing(messageId, current.positionMs, current.durationMs)
        else -> VoicePlaybackState.Loading(messageId)
    }

    /** `MediaPlayer.OnPreparedListener` landing. Returns null for a prepare
     *  callback about a message the user already moved away from — a stale
     *  callback must never resurrect a state nobody asked for anymore; the
     *  caller releases that `MediaPlayer` instead of starting it. */
    fun prepared(current: VoicePlaybackState, messageId: String, durationMs: Int): VoicePlaybackState? =
        if (current is VoicePlaybackState.Loading && current.messageId == messageId) {
            VoicePlaybackState.Playing(messageId, 0, durationMs)
        } else {
            null
        }

    fun paused(current: VoicePlaybackState): VoicePlaybackState = when (current) {
        is VoicePlaybackState.Playing -> VoicePlaybackState.Paused(current.messageId, current.positionMs, current.durationMs)
        else -> current
    }

    fun tick(current: VoicePlaybackState, positionMs: Int): VoicePlaybackState = when (current) {
        is VoicePlaybackState.Playing -> current.copy(positionMs = positionMs)
        else -> current
    }

    /** Playback reached the end: rewound to the start and left paused there,
     *  ready for one tap to play again — not [VoicePlaybackState.Idle],
     *  which would drop the waveform's "played" progress back to looking no
     *  different from a note nobody ever opened. */
    fun completed(current: VoicePlaybackState): VoicePlaybackState = when (current) {
        is VoicePlaybackState.Playing -> VoicePlaybackState.Paused(current.messageId, 0, current.durationMs)
        else -> current
    }

    fun failed(messageId: String, reason: VoiceFailureReason): VoicePlaybackState =
        VoicePlaybackState.Failed(messageId, reason)

    fun seeked(current: VoicePlaybackState, positionMs: Int): VoicePlaybackState = when (current) {
        is VoicePlaybackState.Playing -> current.copy(positionMs = positionMs)
        is VoicePlaybackState.Paused -> current.copy(positionMs = positionMs)
        else -> current
    }

    /** A seek target is never allowed outside the track: a drag past either
     *  edge of the waveform clamps to it instead of erroring, wrapping, or
     *  handing `MediaPlayer.seekTo` a negative or out-of-range value. */
    fun clampSeek(targetMs: Int, durationMs: Int): Int = targetMs.coerceIn(0, durationMs.coerceAtLeast(0))

    fun stopped(): VoicePlaybackState = VoicePlaybackState.Idle
}
