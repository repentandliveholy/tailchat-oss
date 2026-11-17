package net.tailchat.android.cloud

import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/*
 * Numbers on the wire that this client stores as whole `Int`s, read once for both inbound
 * paths — `/api/history` ([CloudApi]) and the live socket ([CloudSocket]) — so the two cannot
 * disagree about one message depending on which of them delivered it.
 *
 * Both are read as numbers, not integers. Senders write what they measured: the CLI reports
 * a recording as `totalSamples / sampleRate` (`src/voice.js`), routinely 3.46, and the server
 * keeps the float (`accounts.js`'s `normalizeMedia`); `intOrNull` answered "not a number" for
 * that, and a `null` here drops the whole payload — the bubble arrived with nothing to play.
 * A finite value is therefore never dropped; only something that is not a number at all is.
 * Rounding is to the nearest whole number, the rule web (`Math.round`) and the CLI already
 * use for the same field (AGENTS.md §11: one surface, one rule).
 */

/**
 * A voice note's duration as whole seconds, `1..VOICE_MAX_SEC`.
 *
 * Zero is an ordinary value — web and CLI write `0` when a recording's length is unknown,
 * and the server accepts `0..600` — and so is anything a sender rounded oddly. The clamp is
 * the one the live path always applied to an integer duration, now shared by history too,
 * so the same note shows the same length however it reached this device (history used to
 * keep a raw `0`; the player treats both the same, `CloudScreen`'s `durationMs > 0`).
 */
internal fun JsonPrimitive.voiceSecondsOrNull(): Int? {
    val value = doubleOrNull?.takeIf(Double::isFinite) ?: return null
    return value.roundToInt().coerceIn(1, VOICE_MAX_SEC)
}

/**
 * An image's declared dimension in whole pixels. `0` stays `0`: it is how a sender says
 * "unknown", and `InlineImage` reads it as exactly that (a 4:3 placeholder until the bytes
 * are decoded) — turning it into `1` would declare a one-pixel-wide image instead.
 */
internal fun JsonPrimitive.pixelsOrNull(): Int? {
    val value = doubleOrNull?.takeIf(Double::isFinite) ?: return null
    return value.roundToInt().coerceAtLeast(0)
}
