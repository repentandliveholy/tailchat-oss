package net.tailchat.android

import android.content.Context
import android.os.Build
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject

/**
 * The appearance axes the web client carries (`web/cloud/index.html`'s settings
 * dialog), ported one for one so a person who set up their look in the browser
 * finds the same three questions here.
 *
 * `data-mode` in the browser: light and dark are not colour schemes, they are
 * the *other* axis — somebody who likes Matrix green keeps it when they walk
 * outside. Before this the two were one flat list, so "light" meant giving up
 * your palette.
 */
enum class ThemeMode { Auto, Light, Dark }

/** `data-theme` in the browser: the six colour schemes. Paper is light-only. */
enum class AppPalette { Green, Amber, Blue, Matrix, Mono, Paper }

/** `data-font`: терминал / гротеск / гарамон, the same three the web client offers. */
enum class AppFont { Mono, Sans, Serif }

/** `data-round`: острые / мягкие / круглые. Drives every corner in the app. */
enum class AppRoundness { Sharp, Soft, Round }

/**
 * `data-wallpaper`: the decorative pattern drawn behind a conversation — on the
 * whole conversation column since 1.128, so the glass header and the floating
 * composer sit over it. [Aurora] is what an install that never picked one gets
 * (owner's decision, the web client's `DEFAULT_WALLPAPER` too); a choice made
 * in the settings is stored and kept, [None] included.
 *
 * The dot/rule patterns take their colour from the current palette's `--line` /
 * `--line-soft`; [Aurora] is the palette's three accents; [Waves], [Topo] and
 * [Doodle] are the web client's SVG tiles in white or black ink over an accent
 * tint (`TailchatAccents`). None of them needs tokens of its own.
 *
 * The lowercase names are the words web stores (`aurora|waves|topo|doodle|
 * none|dots|ruled|diamond`), which [Settings.readWallpaper] accepts.
 */
enum class ChatWallpaper { None, Dots, Ruled, Diamond, Aurora, Waves, Topo, Doodle }

/**
 * Which set of cues a message makes. `Classic` is the Mixkit sample pair the web
 * client plays (`web/cloud/sounds`); the other two are generated on the same
 * grid by `bin/make-android-cues.js` — a soft sine chime and a terminal blip.
 * `Custom` plays whatever file the person picked instead of the incoming cue.
 */
enum class SoundPack { Classic, Soft, Terminal, Custom }

/**
 * Which melody an incoming call plays. Four, resolved to `res/raw` in
 * [net.tailchat.android.call.CallRinger] — nothing outside that file needs to
 * know a raw id. Three are synthesised by `bin/make-android-cues.js`
 * (`call_ring_*.wav`): a wooden mallet figure, the analogue telephone warble,
 * and a short digital arpeggio. [Phone] is not synthesised: the owner supplied
 * a recording of a ringing telephone and asked for it to be the ring, so it is
 * a shipped asset (`assets/sounds/`, see its `CREDITS.txt`) and the generator
 * deliberately keeps its hands off that file.
 *
 * The enum name is what lands on disk in the preference; a value this build
 * cannot resolve folds back to the default in [readRingtone]. `Bell` (0.76.13's
 * default, a struck-bell phrase) was replaced by [Chime] and its stored name
 * folds onto it.
 */
enum class CallRingtone { Phone, Chime, Classic, Pulse }

/** In-app language override; `System` follows the device. Web's `data-lang`. */
enum class AppLang { System, Ru, En }

/**
 * The steps the text-scale control offers, as multipliers over the type scale
 * in `ui/Theme.kt`. Discrete rather than a free slider: every step has to stay
 * legible next to a fixed-height composer and a two-line bar.
 */
val TEXT_SCALES = listOf(0.85f, 1f, 1.15f, 1.3f)

/** Snaps whatever is on disk onto [TEXT_SCALES] — a hand-edited or migrated
 *  value must not produce a scale no control can represent. */
fun nearestTextScale(value: Float): Float =
    TEXT_SCALES.minByOrNull { kotlin.math.abs(it - value) } ?: 1f

/** Playback-speed steps the voice-note speed picker offers — discrete like
 *  [TEXT_SCALES], not a slider. */
val VOICE_PLAYBACK_SPEEDS = listOf(1f, 1.25f, 1.5f, 1.75f, 2f)

/** Snaps whatever is on disk onto [VOICE_PLAYBACK_SPEEDS] — same reasoning
 *  as [nearestTextScale]. */
fun nearestVoicePlaybackSpeed(value: Float): Float =
    VOICE_PLAYBACK_SPEEDS.minByOrNull { kotlin.math.abs(it - value) } ?: 1f

/**
 * Everything this client remembers between launches: who to talk to, what to
 * call ourselves, how the app should look, and how loud it is allowed to be.
 * Deliberately a plain SharedPreferences file — the desktop client keeps a
 * hand-editable config.json for the same reason, and there is nothing here
 * worth a database.
 */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("tailchat", Context.MODE_PRIVATE)

    var displayName: String
        get() = prefs.getString(KEY_NAME, null)?.takeIf { it.isNotBlank() } ?: defaultName()
        set(value) = prefs.edit().putString(KEY_NAME, value.trim()).apply()

    /** A MagicDNS name, a full tailnet DNS name, or a bare 100.x address. */
    var peerHost: String
        get() = prefs.getString(KEY_PEER, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PEER, value.trim()).apply()

    var peerPort: Int
        get() = prefs.getInt(KEY_PEER_PORT, DEFAULT_PORT)
        set(value) = prefs.edit().putInt(KEY_PEER_PORT, value).apply()

    var listenPort: Int
        get() = prefs.getInt(KEY_LISTEN_PORT, DEFAULT_PORT)
        set(value) = prefs.edit().putInt(KEY_LISTEN_PORT, value).apply()

    var keepTranscript: Boolean
        get() = prefs.getBoolean(KEY_TRANSCRIPT, true)
        set(value) = prefs.edit().putBoolean(KEY_TRANSCRIPT, value).apply()

    /** This device's last-known FCM registration token — read by
     *  [net.tailchat.android.cloud.ServiceCloudController] to register it
     *  with the server once a session exists, since `onNewToken` can fire
     *  before login (a fresh install) or while the app has no bound
     *  controller to hand it to directly. */
    var fcmToken: String?
        get() = prefs.getString(KEY_FCM_TOKEN, null)?.takeIf(String::isNotBlank)
        set(value) = prefs.edit().putString(KEY_FCM_TOKEN, value).apply()

    // ---- appearance ------------------------------------------------------

    var themeMode: ThemeMode
        get() = readMode(prefs.getString(KEY_MODE, null)) ?: legacyMode()
        set(value) {
            prefs.edit().putString(KEY_MODE, value.name).apply()
            AppPreferences.themeMode.value = value
        }

    var palette: AppPalette
        get() = readPalette(prefs.getString(KEY_PALETTE, null)) ?: legacyPalette()
        set(value) {
            val usePaperDefaultFont = value == AppPalette.Paper && !prefs.contains(KEY_FONT)
            val editor = prefs.edit().putString(KEY_PALETTE, value.name)
            if (usePaperDefaultFont) editor.putString(KEY_FONT, AppFont.Serif.name)
            editor.apply()
            AppPreferences.palette.value = value
            if (usePaperDefaultFont) AppPreferences.font.value = AppFont.Serif
        }

    var appFont: AppFont
        // A fresh install (no `appFont` on disk) gets the face its palette was
        // designed with: the antiqua for Paper — the same rule the palette
        // setter applies when Paper is *picked* — and the terminal face for
        // every other palette, the default Green included. Anyone who chose a
        // font keeps it.
        get() = readFont(prefs.getString(KEY_FONT, null))
            ?: if (palette == AppPalette.Paper) AppFont.Serif else AppFont.Mono
        set(value) {
            prefs.edit().putString(KEY_FONT, value.name).apply()
            AppPreferences.font.value = value
        }

    var roundness: AppRoundness
        get() = readRoundness(prefs.getString(KEY_ROUND, null)) ?: AppRoundness.Round
        set(value) {
            prefs.edit().putString(KEY_ROUND, value.name).apply()
            AppPreferences.roundness.value = value
        }

    /** Web's «data-wallpaper»: the pattern behind a conversation, one choice
     *  for the whole app rather than one per conversation. Written only when a
     *  person picks one in the settings — nothing on start-up writes it — so a
     *  stored value is always a choice and is kept, `None` included. Nothing
     *  stored, or a value no longer offered, reads as [ChatWallpaper.Aurora]. */
    var wallpaper: ChatWallpaper
        get() = readWallpaper(prefs.getString(KEY_WALLPAPER, null)) ?: ChatWallpaper.Aurora
        set(value) {
            prefs.edit().putString(KEY_WALLPAPER, value.name).apply()
            AppPreferences.wallpaper.value = value
        }

    /** Web's «Обводки»: every decorative edge — bubble, card, field, avatar
     *  ring, glass sheet — drawn in the palette's line, or transparent. One
     *  global switch, independent of [depthDesign]. The persisted key stays
     *  `bubbleOutline` (it was «Рамки сообщений» until the switch widened), so
     *  a value chosen by hand under the old name is kept as made.
     *
     *  Off unless this account turned it on: an install that never touched
     *  the toggle has no stored value at all, so the default reaches it. */
    var outlines: Boolean
        get() = prefs.getBoolean(KEY_BUBBLE_OUTLINE, false)
        set(value) {
            prefs.edit().putBoolean(KEY_BUBBLE_OUTLINE, value).apply()
            AppPreferences.outlines.value = value
        }

    /** Web's «Объёмный дизайн» (`data-depth`): the elevation scale, sheen and
     *  glow of [net.tailchat.android.ui.TailchatDepth], or the flat look. On
     *  unless this account switched it off — only a stored `false`, which the
     *  toggle alone writes, keeps the flat look. */
    var depthDesign: Boolean
        get() = prefs.getBoolean(KEY_DEPTH_DESIGN, true)
        set(value) {
            prefs.edit().putBoolean(KEY_DEPTH_DESIGN, value).apply()
            AppPreferences.depthDesign.value = value
        }

    /** Web's link-preview switch (`tailchat-cloud-link-preview`): a card under
     *  a message that carries a URL. On unless switched off. */
    var linkPreviews: Boolean
        get() = prefs.getBoolean(KEY_LINK_PREVIEWS, true)
        set(value) {
            prefs.edit().putBoolean(KEY_LINK_PREVIEWS, value).apply()
            AppPreferences.linkPreviews.value = value
        }

    /** How many lines a roster row's message preview may wrap to before
     *  eliding — 1/2/3, default 2. Presence/offline text and the Saved
     *  Messages hint never use this; they stay single-line regardless. */
    var rosterPreviewLines: Int
        get() = prefs.getInt(KEY_ROSTER_PREVIEW_LINES, 2).coerceIn(1, 3)
        set(value) {
            val clamped = value.coerceIn(1, 3)
            prefs.edit().putInt(KEY_ROSTER_PREVIEW_LINES, clamped).apply()
            AppPreferences.rosterPreviewLines.value = clamped
        }

    var textScale: Float
        get() = nearestTextScale(prefs.getFloat(KEY_TEXT_SCALE, 1f))
        set(value) {
            val snapped = nearestTextScale(value)
            prefs.edit().putFloat(KEY_TEXT_SCALE, snapped).apply()
            AppPreferences.textScale.value = snapped
        }

    /** Persists across notes and across conversations: the whole point of a
     *  real picker over a per-note toggle is a speed that survives past the
     *  note it was changed on. Read by [net.tailchat.android.cloud.VoicePlaybackController],
     *  which owns the live [android.media.MediaPlayer] this actually drives. */
    var voicePlaybackSpeed: Float
        get() = nearestVoicePlaybackSpeed(prefs.getFloat(KEY_VOICE_SPEED, 1f))
        set(value) {
            prefs.edit().putFloat(KEY_VOICE_SPEED, nearestVoicePlaybackSpeed(value)).apply()
        }

    var language: AppLang
        get() = readLang(prefs.getString(KEY_LANG, null)) ?: AppLang.System
        set(value) {
            prefs.edit().putString(KEY_LANG, value.name).apply()
            AppPreferences.language.value = value
        }

    // ---- feedback --------------------------------------------------------

    var cloudSounds: Boolean
        get() = prefs.getBoolean(KEY_CLOUD_SOUNDS, true)
        set(value) {
            prefs.edit().putBoolean(KEY_CLOUD_SOUNDS, value).apply()
            AppPreferences.cloudSounds.value = value
        }

    /** Web's «Звук отправки», separate from the master switch: the incoming cue
     *  is information, the outgoing one is confirmation, and people want the
     *  first without the second far more often than the other way round. */
    var sendSound: Boolean
        get() = prefs.getBoolean(KEY_SEND_SOUND, true)
        set(value) {
            prefs.edit().putBoolean(KEY_SEND_SOUND, value).apply()
            AppPreferences.sendSound.value = value
        }

    var soundPack: SoundPack
        get() {
            val stored = readPack(prefs.getString(KEY_SOUND_PACK, null)) ?: SoundPack.Classic
            // A custom pack with no file behind it any more (picked, then the
            // copy was cleared) would be silence dressed up as a choice.
            return if (stored == SoundPack.Custom && customSoundPath == null) SoundPack.Classic else stored
        }
        set(value) {
            prefs.edit().putString(KEY_SOUND_PACK, value.name).apply()
            AppPreferences.soundPack.value = value
        }

    /** 0..100, applied to every cue — web's own volume slider. */
    var soundVolume: Int
        get() = prefs.getInt(KEY_SOUND_VOLUME, 100).coerceIn(0, 100)
        set(value) {
            val clamped = value.coerceIn(0, 100)
            prefs.edit().putInt(KEY_SOUND_VOLUME, clamped).apply()
            AppPreferences.soundVolume.value = clamped
        }

    /** Absolute path of the copy this app made of the picked audio file. A path,
     *  not the picked `content://` Uri: a document permission is not durable
     *  across reboots, and a notification channel needs a readable Uri years
     *  later. Null means no custom cue is available. */
    var customSoundPath: String?
        get() = prefs.getString(KEY_SOUND_FILE, null)?.takeIf { it.isNotBlank() }
        set(value) {
            prefs.edit().putString(KEY_SOUND_FILE, value).apply()
            AppPreferences.customSoundPath.value = value
        }

    var cloudNotifications: Boolean
        get() = prefs.getBoolean(KEY_CLOUD_NOTIFICATIONS, true)
        set(value) {
            prefs.edit().putBoolean(KEY_CLOUD_NOTIFICATIONS, value).apply()
            AppPreferences.cloudNotifications.value = value
        }

    var cloudVibration: Boolean
        get() = prefs.getBoolean(KEY_CLOUD_VIBRATION, true)
        set(value) {
            prefs.edit().putBoolean(KEY_CLOUD_VIBRATION, value).apply()
            AppPreferences.cloudVibration.value = value
        }

    var cloudTypingIndicator: Boolean
        get() = prefs.getBoolean(KEY_CLOUD_TYPING, true)
        set(value) {
            prefs.edit().putBoolean(KEY_CLOUD_TYPING, value).apply()
            AppPreferences.cloudTypingIndicator.value = value
        }

    /** Off by default: deleting a message leaves no visual trace unless the
     * account explicitly chooses to see content-free deletion markers. */
    var showDeletedMessages: Boolean
        get() = prefs.getBoolean(KEY_SHOW_DELETED_MESSAGES, false)
        set(value) {
            prefs.edit().putBoolean(KEY_SHOW_DELETED_MESSAGES, value).apply()
            AppPreferences.showDeletedMessages.value = value
        }

    // ---- storage & power -------------------------------------------------

    /** Keeps every conversation's tail on this device, so a thread opens
     *  instantly and can be read with no network at all. */
    var offlineCache: Boolean
        get() = prefs.getBoolean(KEY_OFFLINE_CACHE, true)
        set(value) {
            prefs.edit().putBoolean(KEY_OFFLINE_CACHE, value).apply()
            AppPreferences.offlineCache.value = value
        }

    /**
     * Off by default, and that default is the battery fix: with it off the
     * liveness probe only runs while the app is on screen, and a backgrounded
     * phone leans on the server's own WebSocket ping plus the 15-minute alarm
     * instead of waking the radio every 25 seconds. On, it probes around the
     * clock — the pre-0.55 behaviour, for anyone who would rather spend the
     * battery than wait for a reconnect.
     */
    var keepLinkHot: Boolean
        get() = prefs.getBoolean(KEY_KEEP_HOT, false)
        set(value) {
            prefs.edit().putBoolean(KEY_KEEP_HOT, value).apply()
            AppPreferences.keepLinkHot.value = value
        }

    /**
     * Whether the chat keeps a socket — and therefore a permanent notification
     * in the shade — while the app is not on screen. Off by default: an
     * ongoing foreground-service row that can never be dismissed is exactly
     * what «не нужно чтобы висел все время в шторке» asks to be rid of, and
     * with it off the account also stops being shown online on everyone
     * else's roster while the phone sits in a pocket. Messages sent meanwhile
     * are queued by the server and delivered the moment the app is reopened.
     */
    var backgroundService: Boolean
        get() = prefs.getBoolean(KEY_BACKGROUND_SERVICE, false)
        set(value) {
            prefs.edit().putBoolean(KEY_BACKGROUND_SERVICE, value).apply()
            AppPreferences.backgroundService.value = value
        }

    /** Whether the battery-exemption dialog has ever been shown. Asked once
     *  per install rather than once per launch: repeating it every time the
     *  app opened is the «часто выводит уведомление о батарее». */
    var batteryPromptShown: Boolean
        get() = prefs.getBoolean(KEY_BATTERY_PROMPT, false)
        set(value) { prefs.edit().putBoolean(KEY_BATTERY_PROMPT, value).apply() }

    /** Whether the «show calls on the lock screen» trip to system settings
     *  has been offered. API 34 stopped granting `USE_FULL_SCREEN_INTENT` at
     *  install time to anything that is not a dialer or an alarm clock, so an
     *  incoming call could only raise a heads-up a locked phone never showed.
     *  Asked once per install, like [batteryPromptShown]. */
    var fullScreenPromptShown: Boolean
        get() = prefs.getBoolean(KEY_FSI_PROMPT, false)
        set(value) { prefs.edit().putBoolean(KEY_FSI_PROMPT, value).apply() }

    /** Whether the user dismissed the roster prompt to allow installing updates.
     *  Once dismissed, the roster prompt stays hidden; the settings row remains. */
    var installPermissionPromptDismissed: Boolean
        get() = prefs.getBoolean(KEY_INSTALL_PERM_DISMISSED, false)
        set(value) { prefs.edit().putBoolean(KEY_INSTALL_PERM_DISMISSED, value).apply() }

    /** Whether the user dismissed the roster prompt to allow notifications.
     *  Once dismissed, the roster prompt stays hidden; the settings row remains. */
    var notificationPermissionPromptDismissed: Boolean
        get() = prefs.getBoolean(KEY_NOTIF_PERM_DISMISSED, false)
        set(value) { prefs.edit().putBoolean(KEY_NOTIF_PERM_DISMISSED, value).apply() }

    /** Version code of an update the user dismissed via the banner close icon.
     *  Automatic / periodic update checks skip re-surfacing this build so the
     *  banner does not un-dismiss itself; manual checks still report it, and
     *  any newer build will show again immediately. */
    var dismissedUpdateVersionCode: Long
        get() = prefs.getLong(KEY_DISMISSED_UPDATE_VERSION, 0L)
        set(value) { prefs.edit().putLong(KEY_DISMISSED_UPDATE_VERSION, value).apply() }

    /**
     * The nicknames this device set *before* issue #28 moved them to the
     * server — kept only as the source for the one-time migration in
     * [net.tailchat.android.cloud.CloudController], which pushes each entry to
     * `POST /api/alias` and then clears it. **Not** the source of truth for
     * display any more: the roster row's own `alias` (server-authoritative) is
     * what every screen renders. Keyed by login; a blank/absent entry means
     * "show the account's real name".
     */
    var contactAliases: Map<String, String>
        get() = decodeAliases(prefs.getString(KEY_CONTACT_ALIASES, null))
        set(value) {
            prefs.edit().putString(KEY_CONTACT_ALIASES, encodeAliases(value)).apply()
        }

    /** Whether the legacy [contactAliases] map has been migrated to the server.
     *  Set only once every eligible local entry has been pushed (or dropped
     *  because the server already had an authoritative nickname), so a failed
     *  or offline `POST /api/alias` is retried on the next connect instead of
     *  the nickname being lost. */
    var contactAliasesMigrated: Boolean
        get() = prefs.getBoolean(KEY_CONTACT_ALIASES_MIGRATED, false)
        set(value) { prefs.edit().putBoolean(KEY_CONTACT_ALIASES_MIGRATED, value).apply() }

    var mutedContacts: Set<String>
        get() = prefs.getStringSet(KEY_MUTED_CONTACTS, emptySet()).orEmpty().toSet()
        set(value) {
            val copy = value.filter(String::isNotBlank).toSet()
            prefs.edit().putStringSet(KEY_MUTED_CONTACTS, copy).apply()
            AppPreferences.mutedContacts.value = copy
        }

    fun setContactMuted(login: String, muted: Boolean) {
        mutedContacts = if (muted) mutedContacts + login else mutedContacts - login
    }

    /** Which [CallRingtone] a ringing call plays. */
    var callRingtone: CallRingtone
        get() = readRingtone(prefs.getString(KEY_CALL_RINGTONE, null)) ?: CallRingtone.Phone
        set(value) {
            prefs.edit().putString(KEY_CALL_RINGTONE, value.name).apply()
            AppPreferences.callRingtone.value = value
        }

    init {
        AppPreferences.ensureLoaded(this)
    }

    val configured: Boolean get() = peerHost.isNotBlank()

    private fun defaultName(): String {
        val model = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        return if (model.isBlank()) "android" else model
    }

    /**
     * Pre-0.55 kept one flat `appTheme` name where there are now two axes. The
     * old value is folded rather than reset: `light` was a mode, everything else
     * was a dark palette, and `system` was the mode question with the default
     * palette. Read-only — the first write of either axis lands under its own key
     * and this stops being consulted.
     */
    private fun legacyMode(): ThemeMode = when (prefs.getString(KEY_LEGACY_THEME, null)?.lowercase()) {
        null -> ThemeMode.Auto
        "system" -> ThemeMode.Auto
        "light" -> ThemeMode.Light
        else -> ThemeMode.Dark
    }

    private fun legacyPalette(): AppPalette = when (prefs.getString(KEY_LEGACY_THEME, null)?.lowercase()) {
        "amber" -> AppPalette.Amber
        // Pre-0.52 `ocean` became `blue` when the palettes were aligned with web.
        "blue", "ocean" -> AppPalette.Blue
        "matrix" -> AppPalette.Matrix
        "mono" -> AppPalette.Mono
        "green" -> AppPalette.Green
        // Nothing stored, or a value no longer offered: the Green default
        // (owner's decision for 184, the web client's default since 1.128).
        // `palette` is written only when a scheme is picked, so an install
        // that ever chose Paper or anything else has it under its own key and
        // never reaches this line.
        else -> AppPalette.Green
    }

    companion object {
        const val DEFAULT_PORT = 4747
        private const val KEY_NAME = "name"
        private const val KEY_PEER = "peer"
        private const val KEY_PEER_PORT = "peerPort"
        private const val KEY_LISTEN_PORT = "listenPort"
        private const val KEY_TRANSCRIPT = "transcript"
        private const val KEY_FCM_TOKEN = "fcmToken"
        private const val KEY_LEGACY_THEME = "appTheme"
        private const val KEY_MODE = "themeMode"
        private const val KEY_PALETTE = "palette"
        private const val KEY_FONT = "appFont"
        private const val KEY_ROUND = "roundness"
        private const val KEY_WALLPAPER = "wallpaper"
        private const val KEY_BUBBLE_OUTLINE = "bubbleOutline"
        private const val KEY_DEPTH_DESIGN = "depthDesign"
        private const val KEY_LINK_PREVIEWS = "linkPreviews"
        private const val KEY_ROSTER_PREVIEW_LINES = "rosterPreviewLines"
        private const val KEY_TEXT_SCALE = "textScale"
        private const val KEY_VOICE_SPEED = "voicePlaybackSpeed"
        private const val KEY_LANG = "language"
        private const val KEY_CLOUD_SOUNDS = "cloudSounds"
        private const val KEY_SEND_SOUND = "sendSound"
        private const val KEY_SOUND_PACK = "soundPack"
        private const val KEY_SOUND_VOLUME = "soundVolume"
        private const val KEY_SOUND_FILE = "soundFile"
        private const val KEY_CLOUD_NOTIFICATIONS = "cloudNotifications"
        private const val KEY_CLOUD_VIBRATION = "cloudVibration"
        private const val KEY_CLOUD_TYPING = "cloudTypingIndicator"
        private const val KEY_SHOW_DELETED_MESSAGES = "showDeletedMessages"
        private const val KEY_OFFLINE_CACHE = "offlineCache"
        private const val KEY_KEEP_HOT = "keepLinkHot"
        private const val KEY_BACKGROUND_SERVICE = "backgroundService"
        private const val KEY_BATTERY_PROMPT = "batteryPromptShown"
        private const val KEY_FSI_PROMPT = "fullScreenPromptShown"
        private const val KEY_INSTALL_PERM_DISMISSED = "installPermissionPromptDismissed"
        private const val KEY_NOTIF_PERM_DISMISSED = "notificationPermissionPromptDismissed"
        private const val KEY_DISMISSED_UPDATE_VERSION = "dismissedUpdateVersionCode"
        private const val KEY_CONTACT_ALIASES = "contactAliases"
        private const val KEY_CONTACT_ALIASES_MIGRATED = "contactAliasesMigrated"
        private const val KEY_MUTED_CONTACTS = "mutedContacts"
        private const val KEY_CALL_RINGTONE = "callRingtone"

        /** Every spelling `/theme` and the sheet may hand in, so the command,
         *  the disk and the UI speak one vocabulary. */
        fun readMode(stored: String?): ThemeMode? = when (stored?.lowercase()) {
            "auto", "system" -> ThemeMode.Auto
            "light" -> ThemeMode.Light
            "dark" -> ThemeMode.Dark
            else -> null
        }

        fun readPalette(stored: String?): AppPalette? = when (stored?.lowercase()) {
            "green" -> AppPalette.Green
            "amber" -> AppPalette.Amber
            "blue", "ocean" -> AppPalette.Blue
            "matrix" -> AppPalette.Matrix
            "mono" -> AppPalette.Mono
            "paper" -> AppPalette.Paper
            else -> null
        }

        fun readFont(stored: String?): AppFont? = when (stored?.lowercase()) {
            "mono", "terminal" -> AppFont.Mono
            "sans" -> AppFont.Sans
            "serif" -> AppFont.Serif
            else -> null
        }

        fun readRoundness(stored: String?): AppRoundness? = when (stored?.lowercase()) {
            "sharp" -> AppRoundness.Sharp
            "soft" -> AppRoundness.Soft
            "round" -> AppRoundness.Round
            else -> null
        }

        /** The eight words `<html data-wallpaper=…>` carries, so the sheet,
         *  the disk and the web client name the same patterns. Android
         *  persists the enum name (`Aurora`); either spelling resolves. */
        fun readWallpaper(stored: String?): ChatWallpaper? = when (stored?.lowercase()) {
            "none" -> ChatWallpaper.None
            "dots" -> ChatWallpaper.Dots
            "ruled" -> ChatWallpaper.Ruled
            "diamond" -> ChatWallpaper.Diamond
            "aurora" -> ChatWallpaper.Aurora
            "waves" -> ChatWallpaper.Waves
            "topo" -> ChatWallpaper.Topo
            "doodle" -> ChatWallpaper.Doodle
            else -> null
        }

        fun readPack(stored: String?): SoundPack? = when (stored?.lowercase()) {
            "classic" -> SoundPack.Classic
            "soft" -> SoundPack.Soft
            "terminal" -> SoundPack.Terminal
            "custom" -> SoundPack.Custom
            else -> null
        }

        fun readRingtone(stored: String?): CallRingtone? = when (stored?.lowercase()) {
            // `bell` is 0.76.13's default, whose melody this replaces.
            "chime", "bell" -> CallRingtone.Chime
            "classic" -> CallRingtone.Classic
            "pulse" -> CallRingtone.Pulse
            "phone" -> CallRingtone.Phone
            else -> null
        }

        fun readLang(stored: String?): AppLang? = when (stored?.lowercase()) {
            "system" -> AppLang.System
            "ru" -> AppLang.Ru
            "en" -> AppLang.En
            else -> null
        }

        /** A flat `{"login":"alias"}` object — a `JSONObject` rather than a
         *  handwritten delimiter format, since a login or an alias
         *  containing that delimiter would otherwise corrupt every entry
         *  after it. */
        private fun encodeAliases(map: Map<String, String>): String =
            JSONObject(map as Map<*, *>).toString()

        /** Never throws on a corrupt/foreign value in the preferences file —
         *  the aliases are a display nicety, not durable data worth crashing
         *  the roster over. */
        private fun decodeAliases(stored: String?): Map<String, String> {
            if (stored.isNullOrBlank()) return emptyMap()
            return try {
                val obj = JSONObject(stored)
                obj.keys().asSequence().associateWith { obj.getString(it) }
            } catch (e: Exception) {
                emptyMap()
            }
        }
    }
}

/**
 * A process-wide, reactive mirror of the [Settings] fields something outside a
 * settings screen has to react to live — the theme axes while a composed screen
 * is already holding [net.tailchat.android.ui.TailchatTheme], the sound fields
 * from inside a service that never sees a Compose tree. [Settings] stays the
 * single source of truth on disk; this only caches the current value so it can
 * be `collectAsState()`d and read from any thread.
 */
object AppPreferences {
    val themeMode = MutableStateFlow(ThemeMode.Auto)
    val palette = MutableStateFlow(AppPalette.Green)
    val font = MutableStateFlow(AppFont.Mono)
    val roundness = MutableStateFlow(AppRoundness.Round)
    val wallpaper = MutableStateFlow(ChatWallpaper.Aurora)
    val outlines = MutableStateFlow(false)
    val depthDesign = MutableStateFlow(true)
    val linkPreviews = MutableStateFlow(true)
    val rosterPreviewLines = MutableStateFlow(2)
    val textScale = MutableStateFlow(1f)
    val language = MutableStateFlow(AppLang.System)
    val cloudSounds = MutableStateFlow(true)
    val sendSound = MutableStateFlow(true)
    val soundPack = MutableStateFlow(SoundPack.Classic)
    val soundVolume = MutableStateFlow(100)
    val customSoundPath = MutableStateFlow<String?>(null)
    val cloudNotifications = MutableStateFlow(true)
    val cloudVibration = MutableStateFlow(true)
    val cloudTypingIndicator = MutableStateFlow(true)
    val showDeletedMessages = MutableStateFlow(false)
    val offlineCache = MutableStateFlow(true)
    val keepLinkHot = MutableStateFlow(false)
    val backgroundService = MutableStateFlow(false)
    val mutedContacts = MutableStateFlow<Set<String>>(emptySet())
    val callRingtone = MutableStateFlow(CallRingtone.Phone)

    private val loaded = AtomicBoolean(false)

    fun ensureLoaded(settings: Settings) {
        if (!loaded.compareAndSet(false, true)) return
        themeMode.value = settings.themeMode
        palette.value = settings.palette
        font.value = settings.appFont
        roundness.value = settings.roundness
        wallpaper.value = settings.wallpaper
        outlines.value = settings.outlines
        depthDesign.value = settings.depthDesign
        linkPreviews.value = settings.linkPreviews
        rosterPreviewLines.value = settings.rosterPreviewLines
        textScale.value = settings.textScale
        language.value = settings.language
        cloudSounds.value = settings.cloudSounds
        sendSound.value = settings.sendSound
        soundPack.value = settings.soundPack
        soundVolume.value = settings.soundVolume
        customSoundPath.value = settings.customSoundPath
        cloudNotifications.value = settings.cloudNotifications
        cloudVibration.value = settings.cloudVibration
        cloudTypingIndicator.value = settings.cloudTypingIndicator
        showDeletedMessages.value = settings.showDeletedMessages
        offlineCache.value = settings.offlineCache
        keepLinkHot.value = settings.keepLinkHot
        backgroundService.value = settings.backgroundService
        mutedContacts.value = settings.mutedContacts
        callRingtone.value = settings.callRingtone
    }
}
