package net.tailchat.android.cloud

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Base64
import android.media.MediaDataSource
import net.tailchat.android.Settings
import net.tailchat.android.nearestVoicePlaybackSpeed
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One [MediaPlayer] for the whole open conversation — never one per voice
 * bubble. Starting a different note tears down whatever was playing first;
 * the row that started the previous one can scroll off-screen, recompose, or
 * be replaced entirely and playback keeps going regardless, because nothing
 * about it lives inside that row's own Composable scope — it lives here,
 * owned by `CloudConversation` in `ui/CloudScreen.kt` for exactly as long as
 * that conversation is open. [release] is the only thing that stops playback
 * for a reason other than the user's own action or the system's (audio focus
 * loss, headphones unplugged), and it is meant to be called exactly once,
 * when the conversation itself closes.
 */
class VoicePlaybackController(private val context: Context, private val resolveMedia: (String) -> String?) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _state = MutableStateFlow<VoicePlaybackState>(VoicePlaybackState.Idle)
    val state: StateFlow<VoicePlaybackState> = _state.asStateFlow()

    // Seeded from disk so a freshly opened conversation starts at whatever
    // speed was last picked, not always 1x — see Settings.voicePlaybackSpeed.
    private val _speed = MutableStateFlow(Settings(context).voicePlaybackSpeed)
    val speed: StateFlow<Float> = _speed.asStateFlow()

    private var mediaPlayer: MediaPlayer? = null
    private var audioSource: MediaDataSource? = null
    private var tickerJob: Job? = null
    private var loadJob: Job? = null

    private val audioManager = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var noisyReceiverRegistered = false

    // Deliberately no AUDIOFOCUS_GAIN handling below: this controller never
    // resumes playback on its own after any pause — manual, or because focus
    // or the audio route was taken away. A voice note starting to talk again
    // on its own, with nobody having touched anything, is the surprising
    // behaviour here, not the safe default.
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
            -> pause()
        }
    }

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(receivedContext: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) pause()
        }
    }

    /** Plays [messageId]'s voice note. [dataUrl] may be a `media://` reference
     *  rather than the real bytes (see [net.tailchat.android.cloud.CloudVoice.dataUrl]);
     *  it is resolved on the same background dispatcher as the base64 decode
     *  it feeds. Resuming an already-paused message keeps its position;
     *  anything else stops whatever was playing and starts a fresh
     *  resolve + decode + prepare. */
    fun play(messageId: String, dataUrl: String) {
        val current = _state.value
        if (current is VoicePlaybackState.Playing && current.messageId == messageId) return
        if (current is VoicePlaybackState.Paused && current.messageId == messageId) {
            resumeCurrent()
            return
        }
        loadJob?.cancel()
        stopPlayer()
        _state.value = VoicePlaybackTransitions.requestPlay(VoicePlaybackState.Idle, messageId)
        loadJob = scope.launch {
            val source = withContext(Dispatchers.IO) {
                resolveMedia(dataUrl)?.let(::decodeDataUrlToSource)
            }
            if (!isActive) {
                source?.close()
                return@launch
            }
            if (source == null) {
                _state.value = VoicePlaybackTransitions.failed(messageId, VoiceFailureReason.Decode)
                return@launch
            }
            audioSource = source
            startPlayer(messageId, source)
        }
    }

    fun pause() {
        val player = mediaPlayer ?: return
        if (_state.value !is VoicePlaybackState.Playing) return
        stopTicker()
        runCatching { player.pause() }
        abandonAudioFocus()
        unregisterNoisyReceiver()
        _state.value = VoicePlaybackTransitions.paused(_state.value)
    }

    fun seekTo(messageId: String, positionMs: Int) {
        val player = mediaPlayer ?: return
        val current = _state.value
        if (current.messageIdOrNull() != messageId) return
        val duration = when (current) {
            is VoicePlaybackState.Playing -> current.durationMs
            is VoicePlaybackState.Paused -> current.durationMs
            else -> return
        }
        val clamped = VoicePlaybackTransitions.clampSeek(positionMs, duration)
        runCatching { player.seekTo(clamped) }
        _state.value = VoicePlaybackTransitions.seeked(current, clamped)
    }

    fun retry(messageId: String, dataUrl: String) = play(messageId, dataUrl)

    /** Applies immediately to whatever this controller currently has
     *  prepared/playing/paused, and persists for every voice note after —
     *  the picker's whole point is a speed that survives past the note it
     *  was changed on. Setting it while nothing is loaded (or before
     *  `prepareAsync` has finished) just updates the stored value;
     *  [startPlayer]'s `onPreparedListener` applies it to the next note. */
    fun setSpeed(value: Float) {
        val snapped = nearestVoicePlaybackSpeed(value)
        _speed.value = snapped
        Settings(context).voicePlaybackSpeed = snapped
        mediaPlayer?.let { player ->
            runCatching { player.playbackParams = player.playbackParams.setSpeed(snapped) }
        }
    }

    /** Releases the player, audio focus, route listeners and memory data source
     * when the conversation closes. */
    fun release() {
        loadJob?.cancel()
        stopPlayer()
        _state.value = VoicePlaybackState.Idle
        scope.cancel()
    }

    private fun resumeCurrent() {
        val player = mediaPlayer ?: return
        val current = _state.value
        if (current !is VoicePlaybackState.Paused) return
        if (!requestAudioFocus()) return
        registerNoisyReceiver()
        runCatching { player.start() }
        _state.value = VoicePlaybackState.Playing(current.messageId, current.positionMs, current.durationMs)
        startTicker()
    }

    private fun startPlayer(messageId: String, source: MediaDataSource) {
        val player = MediaPlayer()
        mediaPlayer = player
        try {
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource(source)
            player.setOnPreparedListener { prepared ->
                val next = VoicePlaybackTransitions.prepared(_state.value, messageId, prepared.duration)
                if (next == null) {
                    // The user moved on to something else before this finished
                    // preparing — nothing to start, just clean up.
                    releasePlayerOnly()
                    return@setOnPreparedListener
                }
                if (!requestAudioFocus()) {
                    _state.value = VoicePlaybackTransitions.failed(messageId, VoiceFailureReason.AudioFocus)
                    releasePlayerOnly()
                    return@setOnPreparedListener
                }
                registerNoisyReceiver()
                runCatching { prepared.playbackParams = prepared.playbackParams.setSpeed(_speed.value) }
                prepared.start()
                _state.value = next
                startTicker()
            }
            player.setOnCompletionListener {
                stopTicker()
                abandonAudioFocus()
                unregisterNoisyReceiver()
                runCatching { it.seekTo(0) }
                _state.value = VoicePlaybackTransitions.completed(_state.value)
            }
            player.setOnErrorListener { _, _, _ ->
                stopTicker()
                abandonAudioFocus()
                unregisterNoisyReceiver()
                _state.value = VoicePlaybackTransitions.failed(messageId, VoiceFailureReason.Playback)
                true
            }
            player.prepareAsync()
        } catch (_: Exception) {
            _state.value = VoicePlaybackTransitions.failed(messageId, VoiceFailureReason.Prepare)
            releasePlayerOnly()
        }
    }

    private fun stopPlayer() {
        stopTicker()
        unregisterNoisyReceiver()
        abandonAudioFocus()
        releasePlayerOnly()
    }

    private fun releasePlayerOnly() {
        mediaPlayer?.let { player ->
            runCatching { player.stop() }
            runCatching { player.release() }
        }
        mediaPlayer = null
        audioSource?.close()
        audioSource = null
    }

    private fun startTicker() {
        stopTicker()
        tickerJob = scope.launch {
            while (isActive) {
                delay(200)
                val player = mediaPlayer ?: break
                val position = runCatching { player.currentPosition }.getOrNull() ?: break
                _state.value = VoicePlaybackTransitions.tick(_state.value, position)
            }
        }
    }

    private fun stopTicker() {
        tickerJob?.cancel()
        tickerJob = null
    }

    private fun requestAudioFocus(): Boolean {
        val manager = audioManager ?: return true
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener(focusListener)
            .build()
        val granted = manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (granted) focusRequest = request
        return granted
    }

    private fun abandonAudioFocus() {
        val manager = audioManager ?: return
        focusRequest?.let { manager.abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    private fun registerNoisyReceiver() {
        if (noisyReceiverRegistered) return
        runCatching {
            context.registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
            noisyReceiverRegistered = true
        }
    }

    private fun unregisterNoisyReceiver() {
        if (!noisyReceiverRegistered) return
        runCatching { context.unregisterReceiver(noisyReceiver) }
        noisyReceiverRegistered = false
    }

    private fun decodeDataUrlToSource(dataUrl: String): MediaDataSource? = runCatching {
        VoiceMemorySource(Base64.decode(dataUrl.substringAfter(',', ""), Base64.DEFAULT))
    }.getOrNull()
}
