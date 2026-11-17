package net.tailchat.android.cloud

import android.content.Context
import android.os.SystemClock
import android.widget.Toast
import androidx.core.content.pm.PackageInfoCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.reflect.KMutableProperty0
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import net.tailchat.android.AppFont
import net.tailchat.android.AppPalette
import net.tailchat.android.AppRoundness
import net.tailchat.android.R
import net.tailchat.android.Settings
import net.tailchat.android.SoundEffects
import net.tailchat.android.TEXT_SCALES
import net.tailchat.android.ThemeMode
import net.tailchat.android.nearestTextScale

/** What `/version` prints for a field the package manager would not answer —
 *  unreadable package info is a broken install, not a number worth inventing. */
private const val UNKNOWN_VERSION = "?"

/**
 * The terminal-style slash commands, as their own object rather than a tail of
 * methods on the controller.
 *
 * The split is not cosmetic: every one of these commands is pure text in and
 * text out, and none of them needs a socket, a session store or a service to
 * decide what to say — so kept here they can be exercised on the JVM, which is
 * where a two-column `/help` layout or `/scale 115` vs `/scale 1.15` actually
 * wants to be checked. Anything that does need the live client arrives through
 * [Host]; preferences go straight to [Settings], exactly as the settings sheet
 * writes them.
 */
class CloudCommandRunner(
    private val context: Context,
    private val host: Host,
) {
    /** Everything a command needs that is not a preference. */
    interface Host {
        /** The conversation the command was typed into, or null. */
        fun selectedPeer(): String?
        fun session(): CloudSession?

        /** Roster, for /peer and /status. */
        fun contacts(): List<CloudUser>

        /** Transcript of the open conversation, for /history. */
        fun transcript(): List<CloudMessage>
        fun link(): CloudLink
        fun subscribedToSelected(): Boolean

        /** How many messages are still owed across every conversation. */
        fun queuedTotal(): Int

        /** Client-local output; not a message, never sent, never stored. */
        fun pushSystemNote(peer: String?, text: String)

        /** Queues plain text for the open conversation. The runner plays the
         *  outgoing cue itself, so this must not play it again. */
        fun sendMessage(text: String)
        fun selectPeer(login: String)
        fun renameSelf(name: String)
        fun reconnect()
        fun logout()
        fun clearTranscript()

        /** Live-only frames; false when the socket refused. */
        fun sendPing(peer: String, id: String, ts: Long): Boolean
        fun sendWake(peer: String): Boolean
        fun notePingSent(peer: String, id: String, startedAt: Long)
        suspend fun createInvite(session: CloudSession, login: String?): Result<String>
        suspend fun acceptInvite(session: CloudSession, code: String): Result<CloudUser>
        fun onInviteCreated(code: String)
        fun onFriendAccepted(friend: CloudUser)
        fun saveTranscript(filename: String, bytes: ByteArray): Result<String>
    }

    /** True when [raw] was a command and has been handled. */
    fun run(raw: String, scope: CoroutineScope): Boolean {
        val clean = raw.trim()
        if (!clean.startsWith("/")) return false
        execute(clean, scope)
        return true
    }

    private fun execute(raw: String, scope: CoroutineScope) {
        val spaceIndex = raw.indexOf(' ')
        val typed = (if (spaceIndex == -1) raw else raw.substring(0, spaceIndex)).lowercase()
        val arg = if (spaceIndex == -1) "" else raw.substring(spaceIndex + 1).trim()
        val peer = host.selectedPeer()
        // Aliases resolve through the shared table, so `/t`, `/w`, `/q` and the
        // rest work here exactly as they do in the web client and in the palette.
        val name = resolveCloudCommand(typed)?.name
        when (name) {
            "/help" -> note(helpText())
            "/clear" -> host.clearTranscript()
            "/theme" -> commandTheme(arg)
            "/font" -> commandFont(arg)
            "/round" -> commandRound(arg)
            "/scale" -> commandScale(arg)
            "/ping" -> commandPing(peer)
            "/wake" -> commandWake(peer)
            "/ai" -> commandAi(arg)
            "/version" -> commandVersion()
            "/status" -> commandStatus()
            "/reconnect" -> commandReconnect()
            "/notify" -> commandToggle(arg, R.string.cloud_cmd_notify_set, Settings(context)::cloudNotifications)
            "/sound" -> commandToggle(arg, R.string.cloud_cmd_sound_set, Settings(context)::cloudSounds)
            "/vibrate" -> commandToggle(arg, R.string.cloud_cmd_vibrate_set, Settings(context)::cloudVibration)
            "/typing" -> commandToggle(arg, R.string.cloud_cmd_typing_set, Settings(context)::cloudTypingIndicator)
            "/nick" -> commandNick(arg)
            "/happy" -> sendEmoticon("(^_^)")
            "/sad" -> sendEmoticon("(;_;)")
            "/neutral" -> sendEmoticon("(._.)")
            "/asc" -> commandAsc(arg)
            "/time" -> commandTime()
            "/history" -> commandHistory(peer)
            "/peer" -> commandPeer(arg)
            "/invite" -> commandInvite(arg, scope)
            "/logo" -> note(context.getString(R.string.cloud_cmd_logo_text))
            "/quit" -> host.logout()
            else -> note(context.getString(R.string.cloud_cmd_unknown, typed))
        }
    }

    /**
     * Rendered from the one shared [CLOUD_COMMANDS] table, in two aligned
     * columns the way the terminal client's `/help` lays its own out
     * (`src/cli.js:435-466`): usage, then the alias, then the description.
     */
    private fun helpText(): String {
        val usageWidth = CLOUD_COMMANDS.maxOf { it.name.length }
        // `── label ──────` is the same section-bar convention `ui.js`'s addSection() uses
        // for /help — a solid box-drawing rule around the heading rather than a plain line,
        // sized for a phone bubble's width instead of a full terminal row.
        val header = sectionBar(context.getString(R.string.cloud_cmd_help_header).trimEnd(':'))
        val rows = CLOUD_COMMANDS.map { command ->
            val alias = command.alias?.let { " ($it)" } ?: ""
            val head = command.name.padEnd(usageWidth) + alias
            val args = command.args?.let { " $it" } ?: ""
            "$head$args\n    ${context.getString(command.help)}"
        }
        return (listOf(header) + rows).joinToString("\n")
    }

    private fun sectionBar(label: String): String {
        val body = " $label "
        val dashes = (28 - body.length).coerceAtLeast(4)
        return "──$body" + "─".repeat(dashes)
    }

    /**
     * `/theme` now spans both appearance axes, because the appearance itself
     * does: `light`/`dark`/`system` set the mode, a scheme name sets the
     * palette, and either can be given alone — the same split web makes
     * between `data-mode` and `data-theme`.
     */
    private fun commandTheme(arg: String) {
        val settings = Settings(context)
        if (arg.isBlank()) {
            note(context.getString(
                R.string.cloud_cmd_theme_current,
                "${modeName(settings.themeMode)} · ${paletteName(settings.palette)}",
            ))
            return
        }
        val mode = Settings.readMode(arg)
        val palette = Settings.readPalette(arg)
        when {
            palette != null -> {
                settings.palette = palette
                note(context.getString(R.string.cloud_cmd_theme_set, paletteName(palette)))
            }
            mode != null -> {
                settings.themeMode = mode
                note(context.getString(R.string.cloud_cmd_theme_set, modeName(mode)))
            }
            else -> note(context.getString(R.string.cloud_cmd_theme_usage))
        }
    }

    private fun modeName(mode: ThemeMode): String = context.getString(when (mode) {
        ThemeMode.Auto -> R.string.cloud_theme_system
        ThemeMode.Light -> R.string.cloud_theme_light
        ThemeMode.Dark -> R.string.cloud_theme_dark
    })

    private fun paletteName(palette: AppPalette): String = context.getString(when (palette) {
        AppPalette.Green -> R.string.cloud_theme_green
        AppPalette.Amber -> R.string.cloud_theme_amber
        AppPalette.Blue -> R.string.cloud_theme_blue
        AppPalette.Matrix -> R.string.cloud_theme_matrix
        AppPalette.Mono -> R.string.cloud_theme_mono
        AppPalette.Paper -> R.string.cloud_theme_paper
    })

    private fun commandFont(arg: String) {
        val settings = Settings(context)
        if (arg.isBlank()) {
            note(context.getString(R.string.cloud_cmd_font_current, fontName(settings.appFont)))
            return
        }
        val font = Settings.readFont(arg)
        if (font == null) {
            note(context.getString(R.string.cloud_cmd_font_usage))
            return
        }
        settings.appFont = font
        note(context.getString(R.string.cloud_cmd_font_set, fontName(font)))
    }

    private fun fontName(font: AppFont): String = context.getString(when (font) {
        AppFont.Mono -> R.string.cloud_font_mono
        AppFont.Sans -> R.string.cloud_font_sans
        AppFont.Serif -> R.string.cloud_font_serif
    })

    private fun commandRound(arg: String) {
        val settings = Settings(context)
        if (arg.isBlank()) {
            note(context.getString(R.string.cloud_cmd_round_current, roundName(settings.roundness)))
            return
        }
        val round = Settings.readRoundness(arg)
        if (round == null) {
            note(context.getString(R.string.cloud_cmd_round_usage))
            return
        }
        settings.roundness = round
        note(context.getString(R.string.cloud_cmd_round_set, roundName(round)))
    }

    private fun roundName(round: AppRoundness): String = context.getString(when (round) {
        AppRoundness.Sharp -> R.string.cloud_round_sharp
        AppRoundness.Soft -> R.string.cloud_round_soft
        AppRoundness.Round -> R.string.cloud_round_round
    })

    /** `/scale 115` or `/scale 1.15` — both spellings, because a phone keyboard
     *  makes a decimal point a two-tap detour and the percentage is what the
     *  settings sheet shows. */
    private fun commandScale(arg: String) {
        val settings = Settings(context)
        if (arg.isBlank()) {
            note(context.getString(
                R.string.cloud_cmd_scale_current,
                (settings.textScale * 100).toInt(),
            ))
            return
        }
        val raw = arg.trim().removeSuffix("%").replace(',', '.').toFloatOrNull()
        if (raw == null || raw <= 0f) {
            note(context.getString(
                R.string.cloud_cmd_scale_usage,
                TEXT_SCALES.joinToString(", ") { "${(it * 100).toInt()}" },
            ))
            return
        }
        val asked = if (raw > 3f) raw / 100f else raw
        val snapped = nearestTextScale(asked)
        settings.textScale = snapped
        note(context.getString(R.string.cloud_cmd_scale_set, (snapped * 100).toInt()))
    }

    /** The round-trip is timed by the host: only it can cancel the timeout when
     *  the `pong` lands, so it owns the pending record this hands it. */
    private fun commandPing(peer: String?) {
        if (peer == null) {
            note(context.getString(R.string.cloud_cmd_no_peer))
            return
        }
        if (host.link() != CloudLink.Online || !host.subscribedToSelected()) {
            host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_ping_offline))
            return
        }
        val id = UUID.randomUUID().toString().replace("-", "").take(16)
        val startedAt = SystemClock.elapsedRealtime()
        if (host.sendPing(peer, id, System.currentTimeMillis())) {
            host.notePingSent(peer, id, startedAt)
            // A brief popup, not a transcript line — see CloudController's
            // onPong/notePingSent, which made the matching change for the
            // result and the timeout.
            Toast.makeText(context, context.getString(R.string.cloud_cmd_ping_sent), Toast.LENGTH_SHORT).show()
        } else {
            host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_ping_offline))
        }
    }

    private fun commandWake(peer: String?) {
        if (peer == null) {
            note(context.getString(R.string.cloud_cmd_no_peer))
            return
        }
        val name = host.contacts().firstOrNull { it.login == peer }?.displayName() ?: peer
        if (host.sendWake(peer)) {
            SoundEffects.wake()
            host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_wake_sent, name))
        } else {
            host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_ping_offline))
        }
    }

    private fun commandToggle(arg: String, labelRes: Int, prop: KMutableProperty0<Boolean>) {
        val next = when (arg.lowercase()) {
            "on" -> true
            "off" -> false
            else -> !prop.get()
        }
        prop.set(next)
        val state = context.getString(if (next) R.string.cloud_state_on else R.string.cloud_state_off)
        note(context.getString(labelRes, state))
    }

    private fun commandNick(arg: String) {
        if (arg.isBlank()) {
            note(context.getString(R.string.cloud_cmd_nick_usage))
            return
        }
        val newName = arg.take(24).trim()
        host.session() ?: return
        host.renameSelf(newName)
        note(context.getString(R.string.cloud_cmd_nick_set, newName))
    }

    private fun sendEmoticon(face: String) = send(face)

    /** Same shape as web/cloud/app.js's `/ai` (`app.js:1640-1648`): the question is
     *  sent to the open conversation addressed to the bridge by name, and the server's
     *  ai-bridge answers it as an `ai` frame in the same thread. */
    private fun commandAi(arg: String) {
        if (arg.isBlank()) {
            note(context.getString(R.string.cloud_cmd_ai_usage))
            return
        }
        send("tailik, $arg")
    }

    private fun commandAsc(arg: String) {
        val key = arg.trim().lowercase().ifBlank { "cat" }
        val art = CLOUD_ASCII_ART[key]
        if (art == null) {
            note(context.getString(
                R.string.cloud_cmd_asc_usage,
                CLOUD_ASCII_ART.keys.joinToString(", "),
            ))
            return
        }
        send(art)
    }

    /** The terminal client's `/version` (`src/cli.js:4129`) and the web's
     *  (`app.js` `/version`), as much of it as a phone can be honest about: the
     *  installed build's own name and number. There is no peer half to report —
     *  the cloud protocol carries no client versions — so this is the one
     *  question a phone actually asks of it: what exactly am I running, and
     *  against which code does the self-update compare me. */
    private fun commandVersion() {
        val info = runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
        val name = info?.versionName ?: UNKNOWN_VERSION
        val code = info?.let { PackageInfoCompat.getLongVersionCode(it).toString() } ?: UNKNOWN_VERSION
        note(context.getString(R.string.cloud_cmd_version_result, name, code))
    }

    /** The terminal client's `/status` (`src/cli.js` `/status`), trimmed to what this
     *  client actually knows: where it is connected, whether the open conversation is
     *  subscribed, and how much is still waiting to go out. */
    private fun commandStatus() {
        val session = host.session()
        val link = context.getString(when (host.link()) {
            CloudLink.Online -> R.string.cloud_status_online
            CloudLink.Connecting -> R.string.cloud_status_connecting
            CloudLink.Offline -> R.string.cloud_status_offline
            CloudLink.SignedOut -> R.string.cloud_status_signed_out
        })
        val selected = host.selectedPeer()
        val peer = host.contacts().firstOrNull { it.login == selected }
            ?: session?.user?.takeIf { it.login == selected }
        val subscribed = context.getString(
            if (host.subscribedToSelected()) R.string.cloud_state_on else R.string.cloud_state_off,
        )
        val rows = listOfNotNull(
            sectionBar(context.getString(R.string.cloud_cmd_status_header).trimEnd(':')),
            context.getString(R.string.cloud_cmd_status_server, session?.server ?: DEFAULT_CLOUD_SERVER),
            context.getString(R.string.cloud_cmd_status_link, link),
            session?.user?.let { context.getString(R.string.cloud_cmd_status_self, it.name, it.login) },
            peer?.let {
                context.getString(
                    R.string.cloud_cmd_status_peer,
                    it.name,
                    presenceDot(it.online),
                    subscribed,
                )
            },
            context.getString(R.string.cloud_cmd_status_queued, host.queuedTotal()),
        )
        note(rows.joinToString("\n"))
    }

    private fun commandReconnect() {
        if (host.session() == null) {
            note(context.getString(R.string.cloud_status_signed_out))
            return
        }
        note(context.getString(R.string.cloud_cmd_reconnect_now))
        host.reconnect()
    }

    private fun commandTime() {
        val now = Date()
        val local = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(now)
        val utc = SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.getDefault()).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(now)
        note(context.getString(R.string.cloud_cmd_time_result, local, utc))
    }

    private fun commandHistory(peer: String?) {
        if (peer == null) {
            note(context.getString(R.string.cloud_cmd_no_peer))
            return
        }
        val messages = host.transcript().filterNot { it.system }
        if (messages.isEmpty()) {
            host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_history_empty))
            return
        }
        val stamp = SimpleDateFormat("HH:mm", Locale.getDefault())
        val text = messages.joinToString("\n") { "[${stamp.format(Date(it.ts))}] ${it.author}: ${it.text}" }
        val filename = "tailchat-cloud-$peer-${System.currentTimeMillis()}.txt"
        val result = host.saveTranscript(filename, text.toByteArray(Charsets.UTF_8))
        result.fold(
            onSuccess = { location -> host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_history_saved, location)) },
            onFailure = { error -> host.pushSystemNote(peer, context.getString(R.string.cloud_cmd_history_failed, error.message ?: "")) },
        )
    }

    private fun commandPeer(arg: String) {
        val contacts = host.contacts()
        val self = host.session()?.user
        if (arg.isBlank()) {
            val others = contacts.filterNot { it.login == self?.login }
            if (others.isEmpty()) {
                note(context.getString(R.string.cloud_cmd_peer_no_contacts))
                return
            }
            val status = { u: CloudUser ->
                if (u.official) context.getString(R.string.cloud_official_account)
                else "${presenceDot(u.online)} " + context.getString(if (u.online) R.string.cloud_peer_online else R.string.cloud_peer_offline)
            }
            val rows = others.map { context.getString(R.string.cloud_cmd_peer_row, it.name, it.login, status(it)) }
            val header = sectionBar(context.getString(R.string.cloud_cmd_peer_header, others.size).trimEnd(':'))
            note((listOf(header) + rows).joinToString("\n"))
            return
        }
        val match = contacts.firstOrNull {
            it.login.equals(arg, ignoreCase = true) || it.name.equals(arg, ignoreCase = true)
        }
        if (match == null) {
            note(context.getString(R.string.cloud_cmd_peer_not_found, arg))
            return
        }
        host.selectPeer(match.login)
    }

    private fun commandInvite(arg: String, scope: CoroutineScope) {
        val parts = arg.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val action = parts.getOrNull(0)?.lowercase()
        val session = host.session() ?: return
        when {
            action == null || action == "create" -> {
                // A second word names the account the code is minted for —
                // whoever redeems it becomes *their* friend — which the server
                // grants to the deployment owner alone. Absent, the code is
                // this account's own, exactly as it always was.
                val login = parts.getOrNull(1)
                note(context.getString(R.string.cloud_cmd_invite_creating))
                scope.launch {
                    host.createInvite(session, login).fold(
                        onSuccess = { code ->
                            host.onInviteCreated(code)
                            // The note is a plain `Text` — nothing in it can be
                            // copied or tapped — so it has to carry the link the
                            // person actually shares, not the bare code the state
                            // keeps. The dialog that opened on this command shows
                            // and copies the same string.
                            val link = CloudApi.inviteUrl(session.server, code) ?: code
                            note(context.getString(R.string.cloud_cmd_invite_created, link))
                        },
                        onFailure = { error -> note(cloudCommandErrorText(error)) },
                    )
                }
            }
            action == "accept" && parts.size >= 2 -> {
                val code = parts[1]
                note(context.getString(R.string.cloud_cmd_invite_checking))
                scope.launch {
                    host.acceptInvite(session, code).fold(
                        onSuccess = { friend ->
                            host.onFriendAccepted(friend)
                            note(context.getString(R.string.cloud_cmd_invite_accepted, friend.name))
                        },
                        onFailure = { error -> note(cloudCommandErrorText(error)) },
                    )
                }
            }
            else -> note(context.getString(R.string.cloud_cmd_invite_usage))
        }
    }

    /** The invite refusals worth a sentence of their own; anything else keeps
     *  whatever the server said. */
    private fun cloudCommandErrorText(error: Throwable): String = when ((error as? CloudException)?.code) {
        "invalid_invite" -> context.getString(R.string.cloud_error_invalid_invite)
        "self_invite" -> context.getString(R.string.cloud_error_self_invite)
        "invite_not_found" -> context.getString(R.string.cloud_error_invite_not_found)
        // Minting for a named account: the three answers a typed login can
        // actually produce, each in this client's own words rather than the
        // server's single-language sentence.
        "forbidden" -> context.getString(R.string.cloud_error_forbidden)
        "official_invite" -> context.getString(R.string.cloud_error_official_invite)
        "unknown_user" -> context.getString(R.string.cloud_error_unknown_user)
        else -> error.message ?: context.getString(R.string.cloud_error_server)
    }

    private fun send(text: String) {
        host.sendMessage(text)
        SoundEffects.sent()
    }

    private fun note(text: String) = host.pushSystemNote(host.selectedPeer(), text)
}
