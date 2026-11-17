package net.tailchat.android.cloud

import androidx.annotation.StringRes
import net.tailchat.android.R

/**
 * One row of the shared slash-command vocabulary. Both the `/help` text and the
 * composer's command palette read this table, so a command can never exist in
 * one of the two and not the other.
 */
data class CloudCommand(
    val name: String,
    val alias: String? = null,
    val args: String? = null,
    @StringRes val help: Int,
) {
    /** `"/theme [green|amber|…]"` — what the palette shows and `/help` lists. */
    val usage: String get() = if (args == null) name else "$name $args"
}

/**
 * The web client's own `COMMANDS` table (`web/cloud/app.js:59-83`), including its
 * aliases, in its order — plus the three the terminal client has and a phone
 * genuinely needs (`/reconnect`, `/status`, `/vibrate`). Deliberately absent:
 * `/paste` (the composer has attach buttons instead of a clipboard command) and
 * `/holiday`/`/saver`, which are screen decorations with no port yet.
 */
val CLOUD_COMMANDS: List<CloudCommand> = listOf(
    CloudCommand("/help", "/h", help = R.string.cloud_cmd_help_help),
    CloudCommand("/clear", "/c", help = R.string.cloud_cmd_clear_help),
    CloudCommand("/theme", "/t", "[green|amber|blue|matrix|mono|paper|light|dark|system]", R.string.cloud_cmd_theme_help),
    CloudCommand("/font", args = "[mono|sans|serif]", help = R.string.cloud_cmd_font_help),
    CloudCommand("/round", args = "[sharp|soft|round]", help = R.string.cloud_cmd_round_help),
    CloudCommand("/scale", args = "[85|100|115|130]", help = R.string.cloud_cmd_scale_help),
    CloudCommand("/ping", "/p", help = R.string.cloud_cmd_ping_help),
    CloudCommand("/logo", help = R.string.cloud_cmd_logo_help),
    CloudCommand("/wake", "/w", help = R.string.cloud_cmd_wake_help),
    CloudCommand("/ai", "/ask", "<question>", R.string.cloud_cmd_ai_help),
    CloudCommand("/version", "/v", help = R.string.cloud_cmd_version_help),
    CloudCommand("/status", help = R.string.cloud_cmd_status_help),
    CloudCommand("/reconnect", help = R.string.cloud_cmd_reconnect_help),
    CloudCommand("/notify", args = "[on|off]", help = R.string.cloud_cmd_notify_help),
    CloudCommand("/sound", args = "[on|off]", help = R.string.cloud_cmd_sound_help),
    CloudCommand("/vibrate", args = "[on|off]", help = R.string.cloud_cmd_vibrate_help),
    CloudCommand("/typing", args = "[on|off]", help = R.string.cloud_cmd_typing_help),
    CloudCommand("/happy", "/a", help = R.string.cloud_cmd_happy_help),
    CloudCommand("/sad", "/d", help = R.string.cloud_cmd_sad_help),
    CloudCommand("/neutral", "/n", help = R.string.cloud_cmd_neutral_help),
    CloudCommand("/asc", args = "[cat|heart|shrug|happy|sad]", help = R.string.cloud_cmd_asc_help),
    CloudCommand("/nick", "/k", "<name>", R.string.cloud_cmd_nick_help),
    CloudCommand("/peer", args = "[login]", help = R.string.cloud_cmd_peer_help),
    CloudCommand("/invite", "/inv", "[create [login]|accept <code>]", R.string.cloud_cmd_invite_help),
    CloudCommand("/time", help = R.string.cloud_cmd_time_help),
    CloudCommand("/history", "/i", help = R.string.cloud_cmd_history_help),
    CloudCommand("/quit", "/q", help = R.string.cloud_cmd_quit_help),
)

/** Canonical name for whatever the composer typed, alias or not. */
fun resolveCloudCommand(name: String): CloudCommand? {
    val clean = name.lowercase()
    return CLOUD_COMMANDS.firstOrNull { it.name == clean || it.alias == clean }
}

/**
 * The palette's filter, matching the web client's (`updateCommandPalette`,
 * `web/cloud/app.js:1454-1461`): a draft that is still one bare `/word` matches
 * by prefix on the name or the alias; anything with an argument already typed
 * closes the palette, since the command itself is settled by then.
 */
fun cloudCommandMatches(draft: String): List<CloudCommand> {
    if (!draft.startsWith("/")) return emptyList()
    val clean = draft.lowercase().trim()
    if (clean.contains(' ')) return emptyList()
    return CLOUD_COMMANDS.filter {
        it.name.startsWith(clean) || it.alias?.startsWith(clean) == true
    }
}

/** `ASCII_ART` from web/cloud/app.js:85-115, verbatim, for `/asc`. */
val CLOUD_ASCII_ART: Map<String, String> = mapOf(
    "cat" to " /\\_/\\ \n( o.o )\n > ^ < ",
    "heart" to " .-''-.  .-''-. \n/   _  \\/  _   \\\n|  (_)     (_) |\n \\            / \n  '-..____..'-  ",
    "shrug" to "¯\\_(ツ)_/¯",
    "happy" to "   .-'''-.   \n  /       \\  \n |  o   o  | \n |    ^    | \n  \\  \\_/  /  \n   '-.....-' ",
    "sad" to "   .-'''-.   \n  /       \\  \n |  o   o  | \n |    ^    | \n  \\  /~\\  /  \n   '-.....-' ",
)

/**
 * `LOGO_PLAIN_RAW` from web/cloud/app.js:117-121, verbatim — the same three rows
 * the terminal client draws in its logo band (`src/logo.js:10-14`), with the web
 * client's tagline. Kept as one string so the splash, the sign-in screen and
 * `/logo` can never drift apart.
 */
val CLOUD_LOGO_ROWS: List<String> = listOf(
    "   /\\_/\\    ▀█▀ ▄▀█ █ █   █▀▀ █ █ ▄▀█ ▀█▀",
    "  ( o.o )    █  █▀█ █ █▄▄ █▄▄ █▀█ █▀█  █ ",
    "   > ^ <    p2p over cloud & tailnet     ",
)

/** The cat with its eyes shut — frame two of the logo's blink. */
val CLOUD_LOGO_BLINK_ROWS: List<String> = CLOUD_LOGO_ROWS.map { it.replace("( o.o )", "( -.- )") }

/** The sweep glyph both reference clients reveal the logo with. */
const val CLOUD_LOGO_CURSOR: String = "▌"
