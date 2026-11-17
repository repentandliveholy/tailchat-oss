package net.tailchat.android.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import android.util.Log

/** Speaker vs. earpiece/BT — the two the UI toggles between; a wired
 *  headset routes itself and needs no button either way. */
enum class AudioRoute { Earpiece, Speaker, Bluetooth }

/** What [CallController] needs from the audio stack — extracted so
 *  `CallControllerTest` can supply a plain fake instead of a real
 *  [CallAudio], which touches `AudioManager`/`PowerManager` and is not
 *  worth standing up (real or Robolectric) just to test call state. */
interface CallAudioController {
    fun start()
    fun setRoute(route: AudioRoute)
    fun stop()
}

/**
 * Everything a live call needs from the audio stack: exclusive focus,
 * `MODE_IN_COMMUNICATION`, the speaker/earpiece switch, and the proximity
 * wake lock that turns the screen off at the ear. Owns nothing about
 * WebRTC — [CallController] starts/stops this alongside [WebRtcEngine],
 * never through it, the same separation `VoicePlaybackController` keeps
 * from its own `MediaPlayer`.
 */
class CallAudio(context: Context) : CallAudioController {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    private val powerManager = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
    private var focusRequest: AudioFocusRequest? = null
    private var proximityLock: PowerManager.WakeLock? = null
    private var previousMode: Int? = null

    /** Called once when the call becomes [net.tailchat.android.call.CallState.Active]
     *  (or as soon as local media starts, for the caller's own ringback) —
     *  never earlier, matching §4.2's "microphone only after an interactive
     *  Answer" rule, which this mirrors for the speaker path even though
     *  Android does not gate it the same way RECORD_AUDIO is gated. */
    override fun start() {
        val manager = audioManager ?: return
        previousMode = manager.mode
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(attributes)
            .build()
        focusRequest = request
        manager.requestAudioFocus(request)
        setRoute(AudioRoute.Earpiece)
        acquireProximityLock()
    }

    override fun setRoute(route: AudioRoute) {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val type = when (route) {
                AudioRoute.Speaker -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                AudioRoute.Bluetooth -> AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                AudioRoute.Earpiece -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            }
            val device = manager.availableCommunicationDevices.firstOrNull { it.type == type }
            if (device != null) manager.setCommunicationDevice(device)
        } else {
            @Suppress("DEPRECATION")
            manager.isSpeakerphoneOn = route == AudioRoute.Speaker
            if (route == AudioRoute.Bluetooth) {
                @Suppress("DEPRECATION")
                manager.startBluetoothSco()
            } else {
                @Suppress("DEPRECATION")
                runCatching { manager.stopBluetoothSco() }
            }
        }
        // Speaker on is a hand away from the ear by definition — the
        // proximity lock exists only to blank the screen when the phone is
        // actually against a face.
        if (route == AudioRoute.Speaker) releaseProximityLock() else acquireProximityLock()
    }

    override fun stop() {
        val manager = audioManager ?: return
        releaseProximityLock()
        focusRequest?.let { manager.abandonAudioFocusRequest(it) }
        focusRequest = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            manager.isSpeakerphoneOn = false
            @Suppress("DEPRECATION")
            runCatching { manager.stopBluetoothSco() }
        }
        manager.mode = previousMode ?: AudioManager.MODE_NORMAL
        previousMode = null
    }

    private fun acquireProximityLock() {
        if (proximityLock != null) return
        val manager = powerManager ?: return
        if (!manager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
        proximityLock = runCatching {
            manager.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "$TAG:proximity").apply { acquire(PROXIMITY_LOCK_TIMEOUT_MS) }
        }.onFailure { Log.w(TAG, "proximity wake lock unavailable", it) }.getOrNull()
    }

    private fun releaseProximityLock() {
        val lock = proximityLock ?: return
        runCatching { if (lock.isHeld) lock.release() }
        proximityLock = null
    }

    companion object {
        private const val TAG = "CallAudio"
        // A held call should never leave the screen dark forever if the wake
        // lock is somehow never released (a crash between start() and stop());
        // ten minutes comfortably exceeds any real call's ear-to-phone stretch
        // while still bounding the worst case.
        private const val PROXIMITY_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
    }
}
