package net.tailchat.android.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.VibrationAttributes
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import net.tailchat.android.AppPreferences
import net.tailchat.android.CallRingtone
import net.tailchat.android.R

/** What [CallController] needs from the ringer — a seam for
 *  `CallControllerTest`, exactly like [CallAudioController]. */
interface CallRingtonePlayer {
    /** An offer arrived: ring, and light the screen up so a phone lying face
     *  down and locked is not a phone that silently missed a call. */
    fun startIncoming()

    /** The callee's own device has confirmed it is ringing (`call-ring`) —
     *  the only moment a ringback is true: play the tone the caller listens
     *  to while the other phone rings. */
    fun startOutgoing()

    /** Stop whichever tone is playing and release the screen wake. */
    fun stop()
}

/**
 * The incoming-call melody, plus the screen wake that has to happen with it.
 *
 * Why the app plays this instead of leaving it to the notification channel:
 * a channel sound is a *one-shot*, a few hundred milliseconds long, played
 * once when the notification is posted. A call rings for 45 seconds. Before
 * this class there was no ringtone at all in practice — one short default
 * blip, easily missed, and nothing afterwards. So `calls_v3` is deliberately
 * a silent *and vibration-free* channel (see [CallNotifications]) and both the
 * looping sound and the repeating waveform are ours: a channel's one-shot does
 * not merely overlap the vibration below, it supersedes it on the same motor
 * and cancels it when it ends, which is how a call came to buzz once and then
 * stay still for the rest of its ring.
 *
 * The bundled tone is `res/raw/call_ring.wav`, synthesised by
 * `bin/make-android-cues.js` from sine partials — no third-party asset, no
 * licence or credit to carry, and re-generatable byte for byte.
 *
 * Ringer mode is honoured: a phone set to silent stays quiet *and* still, a
 * phone set to vibrate gets the repeating waveform below and no sound. Volume
 * follows `STREAM_RING`, which is what `USAGE_NOTIFICATION_RINGTONE` maps to,
 * so the person's ring volume is the volume.
 */
class CallRinger(context: Context) : CallRingtonePlayer {
    private val appContext = context.applicationContext
    private var player: MediaPlayer? = null
    private var screenLock: PowerManager.WakeLock? = null
    private var vibrating = false

    private val vibrator: Vibrator? by lazy {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val manager = appContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                manager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                appContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        }.getOrNull()
    }

    override fun startIncoming() {
        wakeScreen()
        startVibration()
        val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        // Silent/vibrate: no sound, by the person's own explicit choice.
        if (audioManager != null && audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
        play(
            ringtoneResource(),
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
    }

    /**
     * The caller's ringback — the periodic tone that says the other phone is
     * being rung. There was none: the caller heard silence from the moment
     * the button was pressed until the call either connected or timed out,
     * with only «Calling…» on screen to go by.
     *
     * `USAGE_VOICE_COMMUNICATION_SIGNALLING` is what makes it audible here at
     * all: the caller's audio stack is already in `MODE_IN_COMMUNICATION`
     * holding exclusive `USAGE_VOICE_COMMUNICATION` focus
     * ([CallAudio.start]), so a ringtone- or notification-usage stream would
     * be ducked or routed away. Signalling usage is the platform's own
     * category for exactly this tone and plays on the call stream, in the
     * earpiece, at call volume — and it is deliberately *not* gated on ringer
     * mode: a phone set to silent still plays call progress tones to the
     * person who placed the call.
     */
    override fun startOutgoing() {
        play(
            R.raw.call_ringback,
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
    }

    private fun play(resource: Int, attributes: AudioAttributes) {
        if (player != null) return
        player = runCatching {
            MediaPlayer.create(
                appContext,
                resource,
                attributes,
                AudioManager.AUDIO_SESSION_ID_GENERATE,
            )?.apply {
                isLooping = true
                start()
            }
        }.onFailure { Log.w(TAG, "call tone unavailable", it) }.getOrNull()
    }

    override fun stop() {
        player?.let { active ->
            runCatching {
                if (active.isPlaying) active.stop()
                active.release()
            }
        }
        player = null
        stopVibration()
        releaseScreenLock()
    }

    private fun startVibration() {
        if (vibrating) return
        val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager != null && audioManager.ringerMode == AudioManager.RINGER_MODE_SILENT) return
        val vib = vibrator ?: return
        if (!vib.hasVibrator()) return
        // Pattern matches the ~2.1s ringtone period: wait 0, vibrate 1000ms, pause 1100ms, repeating from index 1.
        val pattern = longArrayOf(0, 1000, 1100)
        val effect = VibrationEffect.createWaveform(pattern, 1)
        runCatching {
            // Both overloads land on the platform as `Usage=RINGTONE` — the
            // deprecated `AudioAttributes` one maps to it, and a dump of the
            // device's vibrator history shows the two differing only in the
            // informational `Audio Usage` field. Which one is used decides
            // nothing about how long the pattern plays; measured on the
            // RMX3624 (Android 13, 2026-09-21) a repeating waveform runs for
            // as long as nothing else on the same vibrator supersedes it.
            // What used to cut it short was the `calls_v2` channel's own
            // default vibration 192ms in — see [CallNotifications].
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val vibrationAttributes = VibrationAttributes.Builder()
                    .setUsage(VibrationAttributes.USAGE_RINGTONE)
                    .build()
                vib.vibrate(effect, vibrationAttributes)
            } else {
                val attributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                @Suppress("DEPRECATION")
                vib.vibrate(effect, attributes)
            }
            vibrating = true
        }.onFailure { Log.w(TAG, "call vibration unavailable", it) }
    }

    private fun stopVibration() {
        if (!vibrating) return
        runCatching { vibrator?.cancel() }
        vibrating = false
    }

    /**
     * Turns the display on for an incoming call.
     *
     * The full-screen intent is supposed to do this on its own, and on API
     * 34+ it frequently does not: `USE_FULL_SCREEN_INTENT` is no longer
     * granted at install time to an app that is not the dialer or an alarm
     * clock, so the notification degrades to a heads-up that a locked, dark
     * phone never shows. This wake lock is the floor under that — deprecated
     * as an API, still the only thing that reliably lights a screen from a
     * background service, and bounded so a missed call cannot hold the
     * display on.
     */
    private fun wakeScreen() {
        if (screenLock != null) return
        val power = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        if (power.isInteractive) return
        screenLock = runCatching {
            @Suppress("DEPRECATION")
            power.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                    PowerManager.ACQUIRE_CAUSES_WAKEUP or
                    PowerManager.ON_AFTER_RELEASE,
                "$TAG:incoming",
            ).apply { acquire(SCREEN_WAKE_MS) }
        }.onFailure { Log.w(TAG, "screen wake lock unavailable", it) }.getOrNull()
    }

    private fun releaseScreenLock() {
        val lock = screenLock ?: return
        runCatching { if (lock.isHeld) lock.release() }
        screenLock = null
    }

    private fun ringtoneResource(): Int = resourceFor(AppPreferences.callRingtone.value)

    companion object {
        private const val TAG = "CallRinger"

        /** Slightly over the caller's own ring window
         *  ([CallController.RING_TOTAL_TIMEOUT_MS]); the lock is released the
         *  moment the call is answered, declined or times out anyway. */
        const val SCREEN_WAKE_MS = 50_000L

        /** The melody the person picked in the settings sheet. Three of the
         *  files are the ones `bin/make-android-cues.js` writes, the fourth
         *  ([CallRingtone.Phone]) is the shipped recording — the enum name is
         *  what is on disk, this is the only place it becomes a raw resource
         *  id. */
        fun resourceFor(choice: CallRingtone): Int = when (choice) {
            CallRingtone.Phone -> R.raw.call_ring_phone
            CallRingtone.Chime -> R.raw.call_ring_chime
            CallRingtone.Classic -> R.raw.call_ring_classic
            CallRingtone.Pulse -> R.raw.call_ring_pulse
        }

        /** True when this build may raise a full-screen call screen over the
         *  lock screen by itself. API 34 revoked the install-time grant, and
         *  `CloudScreen` uses this to offer the one-tap settings trip that
         *  gets it back. */
        fun canUseFullScreenIntent(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
            val manager = context.getSystemService(android.app.NotificationManager::class.java)
                ?: return true
            return manager.canUseFullScreenIntent()
        }
    }
}

/**
 * Plays one pass of a melody for the settings sheet — picking a ringtone you
 * only hear the next time somebody calls is a guess, not a choice, the same
 * reasoning the sound packs already play on tap.
 *
 * Not looping, and never more than one player alive: tapping through the
 * three chips has to replace the tone, not stack three of them.
 */
object CallRingPreview {
    private const val TAG = "CallRingPreview"
    private var player: MediaPlayer? = null

    fun play(context: Context, choice: CallRingtone) {
        stop()
        player = runCatching {
            MediaPlayer.create(
                context.applicationContext,
                CallRinger.resourceFor(choice),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
                AudioManager.AUDIO_SESSION_ID_GENERATE,
            )?.apply {
                setOnCompletionListener { stop() }
                start()
            }
        }.onFailure { Log.w(TAG, "ringtone preview unavailable", it) }.getOrNull()
    }

    fun stop() {
        player?.let { active -> runCatching { if (active.isPlaying) active.stop(); active.release() } }
        player = null
    }
}
