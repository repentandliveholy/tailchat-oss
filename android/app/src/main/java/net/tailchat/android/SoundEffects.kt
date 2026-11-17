package net.tailchat.android

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import android.net.Uri
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import java.io.File

/**
 * The cue packs, played natively.
 *
 * Previously these were `ToneGenerator` DTMF beeps — a phone-dialer noise that
 * had nothing to do with the sound the same account hears in the browser or in
 * the terminal client. [SoundPack.Classic] is byte-identical to the mp3 cues in
 * `web/cloud/sounds` (Mixkit free SFX, see that directory's CREDITS.txt), so one
 * conversation sounds the same on every client; [SoundPack.Soft] and
 * [SoundPack.Terminal] are the WAVs `bin/make-android-cues.js` synthesises.
 *
 * [SoundPool] rather than `MediaPlayer`: these are sub-two-second cues that can
 * fire back to back while a backlog lands, which is exactly the case a pool of
 * pre-decoded samples handles and a per-play MediaPlayer instance does not.
 *
 * All nine built-in samples are decoded in [warmUp] and the pack is resolved per
 * play from [AppPreferences.soundPack]: nine cues of well under 100 KB cost less
 * than a reload on every pack change, and it makes a switch in the settings
 * sheet audible on the next message instead of after a decode.
 */
object SoundEffects {
    /**
     * A cue as a *notification channel* sound: the `Uri` the system plays from
     * outside this process, and the identity that names it in the channel id.
     *
     * The `Uri` is addressed by **name**. `android.resource://<package>/<id>`
     * — the obvious form, and this app's bug — bakes in the compile-time
     * resource id, and a channel's sound is frozen at creation: every later
     * build that inserts a `res/raw` entry ahead of the cue (here
     * `call_ringback`, `call_ring_classic`, `call_ring_pulse` and
     * `call_ring_chime`, added on 2026-09-17, long after the channels already
     * existed) moves every id after the insertion, and the channels created
     * before the move start playing whatever file inherited their id — a call
     * ringtone as the message notification — while the in-app cue, loaded by
     * resource reference at play time, stays correct.
     *
     * `ContentResolver` resolves the two-segment form the other way round
     * (`getIdentifier(name, type, package)` against the installed package, see
     * `ContentResolver.getResourceId`), so a name cannot be moved by anything
     * that happens to the resource table. The framework reads it when the
     * sound is played, which is also why a re-generated cue needs no new
     * channel: the bytes behind a name are re-read on every play.
     *
     * The token is what a channel id is completed with, and it has to differ
     * from what an earlier build wrote — a channel already frozen onto a moved
     * id cannot be corrected, only abandoned.
     */
    class ChannelCue(val uri: Uri, val token: String, val pack: String)

    /** The three raw resources of one built-in pack. */
    private class Raw(val sent: Int, val received: Int, val wake: Int)

    /** The three decoded samples of one built-in pack, as SoundPool ids. */
    private class Pack(val sent: Int, val received: Int, val wake: Int)

    private val CLASSIC = Raw(R.raw.sent, R.raw.received, R.raw.wake)

    /** Built once; a per-call `when` returning a fresh holder would allocate on
     *  every cue, and cues fire in bursts while a backlog lands. */
    private val RAW: Map<SoundPack, Raw> = mapOf(
        SoundPack.Classic to CLASSIC,
        SoundPack.Soft to Raw(R.raw.soft_sent, R.raw.soft_received, R.raw.soft_wake),
        SoundPack.Terminal to Raw(R.raw.term_sent, R.raw.term_received, R.raw.term_wake),
    )

    private var pool: SoundPool? = null
    private val packs = mutableMapOf<SoundPack, Pack>()

    /** The pack name [SoundPack.Custom]'s cues are filed under: no pack of its
     *  own in `res/raw`, but an identity of its own among the channels. */
    private const val CUE_CUSTOM = "custom"

    /** The custom incoming cue is decoded on first use, not in [warmUp]: the
     *  file is picked by the user and can be replaced or deleted at any time, so
     *  the loaded path is remembered and re-checked instead of trusted. */
    private var customId = 0
    private var customPath: String? = null

    /** Called once from [ChatService.onCreate]: decoding happens here, not on
     *  the first message, so the first cue is not the one that arrives late. */
    fun warmUp(context: Context) {
        if (pool != null) return
        val created = SoundPool.Builder()
            .setMaxStreams(4)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .build()
        for ((pack, raw) in RAW) {
            packs[pack] = Pack(
                sent = load(created, context, raw.sent),
                received = load(created, context, raw.received),
                wake = load(created, context, raw.wake),
            )
        }
        pool = created
    }

    /** Played right after a message of ours goes out. */
    fun sent() {
        if (!AppPreferences.sendSound.value) return
        play(current()?.sent ?: 0, 0.55f)
    }

    /** Played when a peer's message arrives in the conversation currently on screen. */
    fun received() = play(incomingSample(), 0.9f)

    private var previewPlayer: MediaPlayer? = null

    /** Plays one pass of the received cue on the media stream for the settings
     *  sheet, so previewing a cue is audible even when the phone is set to
     *  vibrate/silent. */
    fun preview(context: Context) {
        stopPreview()
        val volume = AppPreferences.soundVolume.value.coerceIn(0, 100) / 100f
        if (volume <= 0f) return
        val custom = customFile()
        previewPlayer = runCatching {
            val player = if (custom != null) {
                MediaPlayer().apply {
                    setDataSource(custom.path)
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build(),
                    )
                    prepare()
                }
            } else {
                MediaPlayer.create(
                    context.applicationContext,
                    raw().received,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                    AudioManager.AUDIO_SESSION_ID_GENERATE,
                )
            }
            player?.apply {
                setVolume(volume, volume)
                setOnCompletionListener { stopPreview() }
                start()
            }
        }.onFailure { Log.w("SoundEffects", "preview unavailable", it) }.getOrNull()
    }

    fun stopPreview() {
        previewPlayer?.let { active -> runCatching { if (active.isPlaying) active.stop(); active.release() } }
        previewPlayer = null
    }

    /** Played on both ends of a `/wake` nudge. */
    fun wake() = play(current()?.wake ?: 0, 1f)

    /**
     * The incoming cue as a channel sound — the same sample the in-app cue
     * plays, so a message that arrives with the app closed makes the same noise
     * as one that arrives with it open.
     */
    fun receivedCue(context: Context): ChannelCue {
        val picked = customFile()
        if (picked != null) {
            // The picked file is already a copy in app storage (see
            // `CloudSettingsSheet.copyCustomCue`), and re-picking changes the
            // bytes at that same path — so its timestamp is the revision. This
            // is the one case that needs one: a bundled cue is addressed by
            // name, and the framework re-reads whatever that name holds.
            val stamp = runCatching { picked.lastModified() }.getOrDefault(0L)
            return ChannelCue(Uri.fromFile(picked), "$CUE_CUSTOM-received-$stamp", CUE_CUSTOM)
        }
        return builtInCue(context, "received", raw().received)
    }

    /** The wake channel's sound, resolved the same way. A custom file replaces
     *  only the incoming cue, so `/wake` keeps the pack's own sample — and with
     *  [SoundPack.Custom] picked that is [SoundPack.Classic]'s, `raw()`'s own
     *  fallback, which is why the pack here is read back from the cue rather
     *  than from the setting. */
    fun wakeCue(context: Context): ChannelCue =
        builtInCue(context, "wake", raw().wake)

    /** A bundled cue, addressed by name. See [ChannelCue] for why. */
    private fun builtInCue(context: Context, cue: String, resId: Int): ChannelCue {
        val pack = builtInPack().name.lowercase()
        val name = context.resources.getResourceEntryName(resId)
        return ChannelCue(
            Uri.parse("android.resource://${context.packageName}/raw/$name"),
            "$pack-$cue",
            pack,
        )
    }

    private fun play(sample: Int, base: Float) {
        if (!AppPreferences.cloudSounds.value) return
        if (sample == 0) return
        val active = pool ?: return
        // 0 on the slider means silent, not "inaudible but still occupying one
        // of four streams": SoundPool.play at volume 0 does start a stream.
        val volume = base * (AppPreferences.soundVolume.value.coerceIn(0, 100) / 100f)
        if (volume <= 0f) return
        runCatching { active.play(sample, volume, volume, 1, 0, 1f) }
    }

    /**
     * The incoming cue, the only one [SoundPack.Custom] replaces. Falls back to
     * the built-in sample whenever the picked file has gone away or refuses to
     * decode — a bad pick may cost the cue its sound, never the message.
     */
    private fun incomingSample(): Int {
        val fallback = current()?.received ?: 0
        if (AppPreferences.soundPack.value != SoundPack.Custom) return fallback
        val active = pool ?: return fallback
        val path = customFile()?.path ?: return fallback
        if (path == customPath && customId != 0) return customId
        // A different file (or the same name with new bytes) was picked: the old
        // sample is a wasted pool slot, and there are only so many.
        if (customId != 0) runCatching { active.unload(customId) }
        customPath = path
        customId = runCatching { active.load(path, 1) }.getOrDefault(0)
        return if (customId != 0) customId else fallback
    }

    /** The picked file, or null when nothing is picked, the pack is not
     *  [SoundPack.Custom], or the file is gone / unreadable. */
    private fun customFile(): File? {
        if (AppPreferences.soundPack.value != SoundPack.Custom) return null
        val path = AppPreferences.customSoundPath.value
        if (path.isNullOrEmpty()) return null
        val file = File(path)
        return if (runCatching { file.canRead() }.getOrDefault(false)) file else null
    }

    private fun current(): Pack? = packs[builtInPack()]

    private fun raw(): Raw = RAW[builtInPack()] ?: CLASSIC

    /** [SoundPack.Custom] has no outgoing or wake sample of its own, so it rides
     *  on [SoundPack.Classic]'s — the same fallback a failed decode lands on. */
    private fun builtInPack(): SoundPack {
        val pack = AppPreferences.soundPack.value
        return if (pack == SoundPack.Custom) SoundPack.Classic else pack
    }

    /** A sample that fails to decode comes back as 0 and is skipped in [play];
     *  `runCatching` is for the resource-missing case, which throws instead. */
    private fun load(target: SoundPool, context: Context, resId: Int): Int =
        runCatching { target.load(context, resId, 1) }.getOrDefault(0)
}
