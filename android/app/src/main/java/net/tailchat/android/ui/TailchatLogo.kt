package net.tailchat.android.ui

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.random.Random
import net.tailchat.android.cloud.CLOUD_LOGO_BLINK_ROWS
import net.tailchat.android.cloud.CLOUD_LOGO_CURSOR
import net.tailchat.android.cloud.CLOUD_LOGO_ROWS

/** One column of the sweep, or a settled/blinking hold — see [logoFrames]. */
private typealias LogoFrame = List<String>

/**
 * `buildLogoFrames` from web/cloud/app.js:143-163, and `logoFrames` from
 * src/logo.js:90-132: the wordmark is revealed one column at a time behind a
 * `▌` cursor, holds, blinks the cat's eyes, then holds again.
 */
private fun logoFrames(): List<LogoFrame> {
    val width = CLOUD_LOGO_ROWS.maxOf(String::length)
    val frames = mutableListOf<LogoFrame>()
    for (column in 1..width) {
        frames += CLOUD_LOGO_ROWS.map { row -> row.take(column - 1) + CLOUD_LOGO_CURSOR }
    }
    repeat(4) { frames += CLOUD_LOGO_ROWS }
    repeat(4) { frames += CLOUD_LOGO_BLINK_ROWS }
    repeat(4) { frames += CLOUD_LOGO_ROWS }
    return frames
}

private val Frames = logoFrames()

/** How long one full reveal takes, for a caller that has to know when the band
 *  has settled — the roster uses it to stop asking for the sweep again. */
val TAILCHAT_LOGO_SWEEP_MS: Long = Frames.size * FRAME_MS

/**
 * The shared ASCII wordmark, drawn to fit whatever width it is given.
 *
 * The size is computed rather than picked: a monospace face advances every glyph
 * by a fixed fraction of its em (0.6 for JetBrains Mono), so the one font size
 * at which 41 columns exactly fill the available width is arithmetic. Both
 * reference clients get this for free — a terminal cell and a `pre` block are
 * already grid-aligned — and a phone is the only place it has to be worked out,
 * because guessing it either clips the wordmark or leaves it floating in the
 * middle of the screen.
 *
 * The division by `fontScale` is what keeps that true when the user has scaled
 * system text: `sp` follows that setting and `dp` does not.
 */
@Composable
fun TailchatLogo(
    modifier: Modifier = Modifier,
    animate: Boolean = true,
    /** Change this to replay the reveal — `/logo` and a tap on the band do. */
    replay: Int = 0,
) {
    val columns = CLOUD_LOGO_ROWS.maxOf(String::length) + 1
    var frame by remember { mutableStateOf(if (animate) 0 else Frames.lastIndex) }
    LaunchedEffect(animate, replay) {
        if (!animate) {
            frame = Frames.lastIndex
            return@LaunchedEffect
        }
        for (index in Frames.indices) {
            frame = index
            delay(FRAME_MS)
        }
    }
    // Once settled, the band is otherwise a static block of text forever —
    // this is the only thing still alive on it, the way a resting cat's eyes
    // still move: an occasional, brief close, on no fixed metronome, never
    // while the sweep/reveal itself is running (that sequence already has
    // its own scripted blink baked into `Frames`).
    var idleBlink by remember { mutableStateOf(false) }
    LaunchedEffect(animate) {
        if (animate) return@LaunchedEffect
        while (true) {
            delay(Random.nextLong(IDLE_BLINK_MIN_MS, IDLE_BLINK_MAX_MS))
            idleBlink = true
            delay(IDLE_BLINK_CLOSED_MS)
            idleBlink = false
        }
    }
    val accents = LocalTailchatAccents.current
    val density = LocalDensity.current
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val size = (maxWidth.value / (columns * MONO_ADVANCE) / density.fontScale)
            .coerceIn(MIN_SP, MAX_SP)
        Text(
            text = (if (!animate && idleBlink) CLOUD_LOGO_BLINK_ROWS else Frames[frame]).joinToString("\n"),
            style = TextStyle(
                fontFamily = TailchatMono,
                fontSize = size.sp,
                // Block-element glyphs of JetBrains Mono are drawn from -0.300
                // to 1.020 em (measured off the bundled `glyf` table), i.e. they
                // fill a 1.320 em line box, not a 1.000 em one. `line-height: 1`
                // therefore overlaps consecutive rows by 0.320 em and the upper
                // and lower halves of every block letter stop meeting — the
                // "halves are offset" the wordmark was reported with. Baseline
                // pitch of exactly one block height is what tiles them.
                lineHeight = (size * BLOCK_LINE_EM).sp,
                lineHeightStyle = LineHeightStyle(
                    alignment = LineHeightStyle.Alignment.Bottom,
                    trim = LineHeightStyle.Trim.None,
                ),
                platformStyle = PlatformTextStyle(includeFontPadding = false),
                letterSpacing = 0.sp,
                color = MaterialTheme.colorScheme.primary,
                shadow = Shadow(accents.glow, Offset.Zero, size * 1.2f),
                textAlign = TextAlign.Start,
            ),
            softWrap = false,
            maxLines = CLOUD_LOGO_ROWS.size,
        )
    }
}

/** 35 ms on web (`app.js:186`), 24 ms in the terminal (`ui.js:38`) — split. */
private const val FRAME_MS = 30L
/** How rarely the settled band's cat blinks — a real cat's resting blink
 *  interval, not a metronome. */
private const val IDLE_BLINK_MIN_MS = 4_000L
private const val IDLE_BLINK_MAX_MS = 9_000L
private const val IDLE_BLINK_CLOSED_MS = 140L
private const val MONO_ADVANCE = 0.6f

/** Height of `█` in ems: `(1020 + 300) / 1000` from the bundled font. */
private const val BLOCK_LINE_EM = 1.32f
private const val MIN_SP = 5f
private const val MAX_SP = 15f
