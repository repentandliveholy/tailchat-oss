package net.tailchat.android.ui

import android.app.Activity
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Shapes
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import net.tailchat.android.AppFont
import net.tailchat.android.AppPalette
import net.tailchat.android.AppRoundness
import net.tailchat.android.R
import net.tailchat.android.ThemeMode

/**
 * One palette, expressed in the same token names `web/cloud/app.css` uses, so a
 * colour can be compared across the two clients by reading one line in each
 * rather than by guessing which Material role a CSS variable became. Every
 * scheme below is the web client's own `[data-theme=…]` block, verbatim.
 */
private data class Tokens(
    val dark: Boolean,
    /** `--paper`: the page behind everything. */
    val paper: Color,
    /** `--surface`: bars, bubbles, cards. */
    val surface: Color,
    /** `--raised`: an input or a row that has to read as sitting on the surface. */
    val raised: Color,
    /** `--ink`/`--muted`: body text and its quieter half. */
    val ink: Color,
    val muted: Color,
    /** `--line`/`--line-soft`: every edge in this design is still a hairline —
     *  a colour, not a blur. What a hairline cannot say is which of two
     *  surfaces is the nearer one, and that is the whole job of
     *  [TailchatDepth]: a shadow measured in dp, on top of the same hairlines
     *  the web client draws. */
    val line: Color,
    val lineSoft: Color,
    /** `--cobalt`: the second accent — authorship, links, secondary actions. */
    val cobalt: Color,
    val cobaltInk: Color,
    /** `--signal`: the accent that means "this is alive" — presence, read marks. */
    val signal: Color,
    val signalInk: Color,
    val signalSoft: Color,
    val signalLine: Color,
    /** `--amber`: in-between states (connecting, queued) — never taste, always status. */
    val amber: Color,
    val danger: Color,
    val ai: Color,
    val aiSoft: Color,
    val glow: Color,
)

/**
 * The handful of colours Material 3's own roles have no slot for, and which the
 * web client does carry as first-class tokens: the sender's own bubble, the AI
 * voice, and the amber "in between" status colour — plus the few the canvas
 * drawings need outside a composition (the wallpaper and the ambient light are
 * [androidx.compose.ui.graphics.drawscope.DrawScope] code, which cannot ask
 * `MaterialTheme` for `primary`).
 */
@Immutable
data class TailchatAccents(
    /** `--own-bubble-bg`: `signal` at [Tokens.ownTone] over `surface` — the
     *  own bubble and the open roster row. The incoming bubble is `raised`
     *  (`colorScheme.surfaceVariant`). One rule for every palette, no gradient
     *  over it. */
    val ownBubble: Color,
    /** The own bubble's edge: `Transparent` with «Обводки» off, the palette
     *  line with it on, and with «Объёмный дизайн» too web's accent edge
     *  (`--own-bubble-border`, `signal` 36% over [ownBubble]). */
    val ownBubbleBorder: Color,
    /** `--own-accent` (`signal` 70% towards `ink`): the own-side label and the
     *  quote author on [ownBubble], where the raw accent drops under 4.5:1. */
    val ownAccent: Color,
    /** The grey (time, status) on [ownBubble]: `muted`, except dark Mono whose
     *  `muted` is 3.55:1 on its own tone — there halfway to `ink`. */
    val ownMuted: Color,
    val peerMuted: Color = ownMuted,
    /** «Обводки». Every decorative edge — bubble, card, field, avatar ring —
     *  reads [edge]/[edgeSoft] (also `colorScheme.outline`/`outlineVariant`) and
     *  keeps its width either way, so the switch never moves a pixel. Focus,
     *  selection, pending and delivery state do not read them; they take [line]. */
    val outlines: Boolean,
    val edge: Color,
    val edgeSoft: Color,
    val ai: Color,
    val aiSoft: Color,
    val warning: Color,
    val glow: Color,
    /** The palette's raw hairlines: always opaque, for the wallpaper and for
     *  anything that *means* something (a status dot, a progress track, a
     *  pending bubble's dashed edge) rather than decorates. */
    val line: Color,
    val lineSoft: Color,
    /** Whether the palette in force is the dark half of the mode axis. Carried
     *  here because the transcript wallpaper is the one decoration that has to
     *  ask: a light hairline on black reads louder than a dark one on white, so
     *  the pattern is drawn at a lower alpha in a dark scheme (see
     *  [net.tailchat.android.ui.drawChatWallpaper]). Same question
     *  `Tokens.dark` answers for the system bars. */
    val dark: Boolean,
    /** `--signal` and `--cobalt` (Material's `primary`/`secondary`), repeated
     *  for the canvas: the `aurora` wallpaper, the tint under the line
     *  drawings and the ambient light are made of them. */
    val signal: Color,
    val cobalt: Color,
    /** `--aurora-strength`: how much of each accent glows through `aurora` —
     *  30% dark / 16% light, and 32% / 20% for Paper, whose accents are muted
     *  on purpose and barely tint the page at the terminal palettes' strength
     *  (web/cloud/app.css, «1.128: объёмные обои»). */
    val auroraStrength: Float,
    /** `--wp-tint`: the accent wash under `waves`/`topo`/`doodle`, 9% dark and
     *  7% light. */
    val wallpaperTint: Float,
    /** `--glass` / `--glass-strong` / `--glass-line` («1.128: студия»): the
     *  translucent sheets every bar and panel is made of, so the room behind
     *  (ambient light, wallpaper) reads through them — `surface` at 72% / 84%
     *  and `line` at 70%. Translucency, not a backdrop blur: Compose can blur
     *  what is *behind* a node only from API 31, and this app runs from 29. */
    val glass: Color,
    val glassStrong: Color,
    val glassLine: Color,
    /** The glass of a sheet — settings, user info, the forward picker. Web's
     *  dialogs are `--glass-strong` *with* a backdrop blur, which is what
     *  keeps the conversation behind them from reading through. Without the
     *  blur (API 31+ only, this app runs from 29) message text stayed legible
     *  under the sheet's own text at 84%, and still faintly at 95% — checked
     *  on the emulator — so a sheet is `surface` at 98%: the room barely tints
     *  it and the words behind it do not show. */
    val glassSheet: Color,
)

private fun Tokens.ownTone(): Float = when {
    this === PaperTokens -> 0.20f
    this === LightMonoTokens -> 0.12f
    else -> 0.14f
}

private fun Tokens.accents(depthDesign: Boolean, outlines: Boolean): TailchatAccents {
    val ownBubble = signal.copy(alpha = ownTone()).compositeOver(surface)
    return TailchatAccents(
        ownBubble = ownBubble,
        ownBubbleBorder = when {
            !outlines -> Color.Transparent
            depthDesign -> signal.copy(alpha = 0.36f).compositeOver(ownBubble)
            else -> line
        },
        ownAccent = signal.copy(alpha = 0.70f).compositeOver(ink),
        ownMuted = when {
            this === PaperTokens || this === PaperDarkTokens -> ink
            this === MonoTokens -> ink.copy(alpha = 0.5f).compositeOver(muted)
            else -> muted
        },
        peerMuted = if (this === PaperTokens || this === PaperDarkTokens) ink else muted,
        outlines = outlines,
        edge = if (outlines) line else Color.Transparent,
        edgeSoft = if (outlines) lineSoft else Color.Transparent,
        ai = ai,
        aiSoft = aiSoft,
        warning = amber,
        glow = glow,
        line = line,
        lineSoft = lineSoft,
        dark = dark,
        signal = signal,
        cobalt = cobalt,
        auroraStrength = when {
            this === PaperTokens -> 0.20f
            this === PaperDarkTokens -> 0.32f
            dark -> 0.30f
            else -> 0.16f
        },
        wallpaperTint = if (dark) 0.09f else 0.07f,
        glass = surface.copy(alpha = 0.72f),
        glassStrong = surface.copy(alpha = 0.84f),
        glassLine = if (outlines) line.copy(alpha = 0.70f) else Color.Transparent,
        glassSheet = surface.copy(alpha = 0.98f),
    )
}

/** A decorative [color] when «Обводки» is on, `Transparent` otherwise — the
 *  avatar ring, which keeps its width and so never shifts the layout. */
fun TailchatAccents.ring(color: Color): Color = if (outlines) color else Color.Transparent

private fun Tokens.scheme(outlines: Boolean): ColorScheme = ColorScheme(
    primary = signal,
    onPrimary = signalInk,
    primaryContainer = signalSoft,
    onPrimaryContainer = ink,
    inversePrimary = signalLine,
    secondary = cobalt,
    onSecondary = cobaltInk,
    secondaryContainer = raised,
    onSecondaryContainer = ink,
    tertiary = ai,
    onTertiary = if (dark) Color.Black else Color.White,
    tertiaryContainer = aiSoft,
    onTertiaryContainer = ink,
    background = paper,
    onBackground = ink,
    surface = surface,
    onSurface = ink,
    surfaceVariant = raised,
    onSurfaceVariant = muted,
    surfaceTint = signal,
    inverseSurface = ink,
    inverseOnSurface = paper,
    error = danger,
    onError = if (dark) Color.Black else Color.White,
    errorContainer = danger.copy(alpha = 0.16f),
    onErrorContainer = danger,
    outline = if (outlines) line else Color.Transparent,
    outlineVariant = if (outlines) lineSoft else Color.Transparent,
    scrim = Color.Black,
    surfaceBright = raised,
    surfaceDim = paper,
    surfaceContainer = surface,
    surfaceContainerHigh = if (this === PaperTokens) surface else raised,
    surfaceContainerHighest = raised,
    surfaceContainerLow = surface,
    surfaceContainerLowest = paper,
)

// `:root` in web/cloud/app.css — the default there and the default here.
private val GreenTokens = Tokens(
    dark = true,
    paper = Color(0xFF090C10),
    surface = Color(0xFF0D1117),
    raised = Color(0xFF161B22),
    ink = Color(0xFFE6EDF3),
    muted = Color(0xFF8B949E),
    line = Color(0xFF30363D),
    lineSoft = Color(0xFF21262D),
    cobalt = Color(0xFF58A6FF),
    cobaltInk = Color(0xFF090C10),
    signal = Color(0xFF3FB950),
    signalInk = Color(0xFF000000),
    signalSoft = Color(0xFF0E2716),
    signalLine = Color(0xFF238636),
    amber = Color(0xFFD29922),
    danger = Color(0xFFF85149),
    ai = Color(0xFFBC8CFF),
    aiSoft = Color(0xFF26193B),
    glow = Color(0x483FB950),
)

private val AmberTokens = GreenTokens.let {
    Tokens(
        dark = true,
        paper = Color(0xFF120C02),
        surface = Color(0xFF1C1305),
        raised = Color(0xFF2A1E0B),
        ink = Color(0xFFFFDDA8),
        muted = Color(0xFFA67C46),
        line = Color(0xFF453014),
        lineSoft = Color(0xFF30210B),
        cobalt = Color(0xFFFFAA33),
        cobaltInk = Color(0xFF120C02),
        signal = Color(0xFFFFB833),
        signalInk = Color(0xFF000000),
        signalSoft = Color(0xFF2E1D05),
        signalLine = Color(0xFFCC8014),
        amber = Color(0xFFFFCC00),
        danger = Color(0xFFFF5533),
        ai = it.ai,
        aiSoft = it.aiSoft,
        glow = Color(0x52FFB833),
    )
}

private val BlueTokens = GreenTokens.let {
    Tokens(
        dark = true,
        paper = Color(0xFF001220),
        surface = Color(0xFF001B30),
        raised = Color(0xFF002847),
        ink = Color(0xFFD0E7FF),
        muted = Color(0xFF5E8AB5),
        line = Color(0xFF0E3B66),
        lineSoft = Color(0xFF082947),
        cobalt = Color(0xFF38A5FF),
        cobaltInk = Color(0xFF001220),
        signal = Color(0xFF38B6FF),
        signalInk = Color(0xFF000000),
        signalSoft = Color(0xFF032B47),
        signalLine = Color(0xFF1C75B8),
        amber = Color(0xFFFFD000),
        danger = Color(0xFFFF5566),
        ai = it.ai,
        aiSoft = it.aiSoft,
        glow = Color(0x5238B6FF),
    )
}

private val MatrixTokens = Tokens(
    dark = true,
    paper = Color(0xFF000000),
    surface = Color(0xFF040D04),
    raised = Color(0xFF081908),
    ink = Color(0xFF00FF66),
    muted = Color(0xFF009933),
    line = Color(0xFF004D1A),
    lineSoft = Color(0xFF002E0F),
    cobalt = Color(0xFF00FFAA),
    cobaltInk = Color(0xFF000000),
    signal = Color(0xFF00FF66),
    signalInk = Color(0xFF000000),
    signalSoft = Color(0xFF00260B),
    signalLine = Color(0xFF00CC44),
    amber = Color(0xFFFFEE00),
    danger = Color(0xFFFF2222),
    ai = Color(0xFF00FFAA),
    aiSoft = Color(0xFF00260B),
    glow = Color(0x6600FF66),
)

private val MonoTokens = Tokens(
    dark = true,
    paper = Color(0xFF101010),
    surface = Color(0xFF181818),
    raised = Color(0xFF222222),
    ink = Color(0xFFF0F0F0),
    muted = Color(0xFF808080),
    line = Color(0xFF383838),
    lineSoft = Color(0xFF262626),
    cobalt = Color(0xFFCCCCCC),
    cobaltInk = Color(0xFF101010),
    signal = Color(0xFFFFFFFF),
    signalInk = Color(0xFF000000),
    signalSoft = Color(0xFF2A2A2A),
    signalLine = Color(0xFF888888),
    amber = Color(0xFFDDDDDD),
    danger = Color(0xFFFF5555),
    ai = Color(0xFFCCCCCC),
    aiSoft = Color(0xFF2A2A2A),
    glow = Color(0x38FFFFFF),
)

/**
 * The light half of the axis — `html[data-mode="light"]` in
 * web/cloud/app.css:2761, verbatim. Paper, not a lightbox: pure white at
 * full-screen size is glare, and it leaves nothing for `--surface` to be
 * lighter than, so the three steps run the other way round here.
 */
private val LightGreenTokens = Tokens(
    dark = false,
    paper = Color(0xFFFAFBFC),
    surface = Color(0xFFF2F4F7),
    raised = Color(0xFFE7EBF0),
    ink = Color(0xFF1C1F24),
    muted = Color(0xFF57606B),
    line = Color(0xFFDBE0E6),
    lineSoft = Color(0xFFE6E9EE),
    cobalt = Color(0xFF0969DA),
    cobaltInk = Color(0xFFFFFFFF),
    signal = Color(0xFF1A7F37),
    signalInk = Color(0xFFFFFFFF),
    signalSoft = Color(0xFFDAFBE1),
    signalLine = Color(0xFF2DA44E),
    amber = Color(0xFF9A6700),
    danger = Color(0xFFCF222E),
    ai = Color(0xFF8250DF),
    aiSoft = Color(0xFFF6EEFF),
    glow = Color(0x401A7F37),
)

private val PaperTokens = Tokens(
    dark = false,
    paper = Color(0xFFF7F2E9),
    surface = Color(0xFFFCF8F1),
    raised = Color(0xFFEFE7D9),
    ink = Color(0xFF2E2A24),
    muted = Color(0xFF766C5E),
    line = Color(0xFFE1D7C6),
    lineSoft = Color(0xFFEBE3D5),
    cobalt = Color(0xFF42627F),
    cobaltInk = Color(0xFFFCF8F1),
    signal = Color(0xFF4A6B4E),
    signalInk = Color(0xFFFCF8F1),
    signalSoft = Color(0xFFE4EDE2),
    signalLine = Color(0xFF7D9A80),
    amber = Color(0xFF8A6A2F),
    danger = Color(0xFFA8463C),
    ai = Color(0xFF6B5A8A),
    aiSoft = Color(0xFFEDE7F2),
    glow = Color(0x384A6B4E),
)

/**
 * The dark half of the book theme (`html[data-theme="paper"][data-mode="dark"]`
 * in web/cloud/app.css, verbatim) — warm graphite, not the blue-black the
 * other palettes use, with the same serif default. `danger` sits at a
 * slightly lighter hue than the light table's exact value: at Paper's own
 * hue angle it clears 4.5:1 on `paper`/`surface` but misses on `raised`
 * (3.99:1); nudged to `#EA8072` (4.87:1) — nothing else moved.
 */
private val PaperDarkTokens = Tokens(
    dark = true,
    paper = Color(0xFF211E1A),
    surface = Color(0xFF2A2622),
    raised = Color(0xFF35302A),
    ink = Color(0xFFEDE6D9),
    muted = Color(0xFFA89A85),
    line = Color(0xFF453F37),
    lineSoft = Color(0xFF3A352E),
    cobalt = Color(0xFF7FA3C4),
    cobaltInk = Color(0xFF12202E),
    signal = Color(0xFF86B48A),
    signalInk = Color(0xFF16241A),
    signalSoft = Color(0xFF24312A),
    signalLine = Color(0xFF4F7357),
    amber = Color(0xFFD9A94D),
    danger = Color(0xFFEA8072),
    ai = Color(0xFFA995C4),
    aiSoft = Color(0xFF2C2534),
    glow = Color(0x3886B48A),
)

// Each light scheme re-states only its accents, exactly as the CSS does: the
// dark accents are tuned for contrast against black and turn to mud on white.
// (`html[data-mode="light"][data-theme=…]`, app.css:2796-2841.)
private val LightAmberTokens = LightGreenTokens.copy(
    cobalt = Color(0xFF875E00),
    signal = Color(0xFF875E00),
    signalSoft = Color(0xFFFFF5C2),
    signalLine = Color(0xFFC99A24),
    amber = Color(0xFF7D4E00),
    glow = Color(0x38875E00),
)

private val LightBlueTokens = LightGreenTokens.copy(
    cobalt = Color(0xFF0969DA),
    signal = Color(0xFF0B62B8),
    signalSoft = Color(0xFFDDF1FF),
    signalLine = Color(0xFF4AA3EA),
    glow = Color(0x380B62B8),
)

private val LightMatrixTokens = LightGreenTokens.copy(
    cobalt = Color(0xFF0A7A2F),
    signal = Color(0xFF0A7A2F),
    signalSoft = Color(0xFFDCF7E3),
    signalLine = Color(0xFF1C9A45),
    amber = Color(0xFF7D6A00),
    glow = Color(0x3D0A7A2F),
)

private val LightMonoTokens = LightGreenTokens.copy(
    cobalt = Color(0xFF57606A),
    signal = Color(0xFF24292F),
    signalSoft = Color(0xFFE6E9EE),
    signalLine = Color(0xFF8C959F),
    amber = Color(0xFF4C4F53),
    glow = Color(0x2924292F),
)

/**
 * JetBrains Mono, bundled rather than borrowed from the platform: Android's
 * built-in `monospace` is Droid Sans Mono, which is both wider and rounder than
 * anything either reference client renders in, and — the reason it actually
 * matters here — draws the block-element glyphs (`▀ █ ▄`) of the ASCII logo at
 * a different advance than the box-drawing glyphs beside them, which tears the
 * wordmark apart. This face draws all of them on one grid, and covers Cyrillic.
 */
private val Mono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
    Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
)

/** The monospace family every screen renders in, exposed for ASCII blocks. */
val TailchatMono: FontFamily = Mono

/**
 * The three faces the web client offers under «Шрифт», mapped onto what a
 * phone actually has: the bundled terminal face, and the platform's own
 * grotesque and serif. Bundling three more families would add ~1.5 MB to an
 * APK for two options that Android already ships in every locale this app is
 * translated into.
 */
private fun familyFor(font: AppFont): FontFamily = when (font) {
    AppFont.Mono -> Mono
    AppFont.Sans -> FontFamily.SansSerif
    AppFont.Serif -> FontFamily.Serif
}

/**
 * Sized off the web client's own rem scale (`app.css`: bubble text `0.88rem`,
 * meta `0.66rem`, author `0.68rem`, roster name `0.88rem`, status `0.72rem`) at
 * the same 16px root, so a phone shows the same amount of conversation per
 * screen as the browser does — Material's defaults are 2-4sp larger in every
 * role, which is what made the old build feel padded out.
 *
 * [scale] is the app's own text-size control, on top of whatever the system
 * font scale already does: `sp` follows the OS setting, and somebody who wants
 * bigger text *in this app only* — or smaller than the OS gives them — has no
 * other way to ask. Line height is scaled with the size, or a 1.3× body would
 * overlap itself.
 */
private fun face(
    family: FontFamily,
    scale: Float,
    size: Int,
    height: Int,
    weight: FontWeight = FontWeight.Normal,
    tracking: Double = -0.1,
) = TextStyle(
    fontFamily = family,
    fontSize = (size * scale).sp,
    lineHeight = (height * scale).sp,
    fontWeight = weight,
    letterSpacing = tracking.sp,
)

private fun typographyFor(font: AppFont, scale: Float): Typography {
    val family = familyFor(font)
    return Typography(
        titleLarge = face(family, scale, 17, 22, FontWeight.Bold, -0.3),
        titleMedium = face(family, scale, 15, 19, FontWeight.Bold, -0.2),
        titleSmall = face(family, scale, 13, 17, FontWeight.Bold),
        bodyLarge = face(family, scale, 14, 19, FontWeight.Medium),
        bodyMedium = face(family, scale, 14, 20),
        bodySmall = face(family, scale, 12, 16),
        labelLarge = face(family, scale, 13, 17, FontWeight.Bold),
        labelMedium = face(family, scale, 12, 15, FontWeight.Medium, 0.2),
        labelSmall = face(family, scale, 11, 14, FontWeight.Medium, 0.2),
    )
}

/**
 * Web's «Скругление», as three corner scales instead of one. `Sharp` is the
 * web client's own `--radius-s/m/l` (4/6/8px) — a terminal's straight edges;
 * `Round` is what 0.54 shipped for «округлое»; `Soft` sits between them for a
 * phone screen that is itself one rounded rectangle. Everything a finger lands
 * on — roster card, bubble, field, pill — is sized from the chosen scale, and
 * the genuinely circular things (avatars, badges, reaction pills) keep
 * `CircleShape`, so they stay capsules at any height.
 */
@Immutable
data class TailchatCorners(
    /** The bubble's own radius, and the notch on the corner nearest the speaker. */
    val bubble: Dp,
    val bubbleTail: Dp,
    /** The composer field's capsule; half its 38dp minimum at the round end. */
    val field: Dp,
    /** Media inside a bubble, always a step tighter than the bubble itself. */
    val media: Dp,
    /** The floating composer dock's corner, concentric with the 44dp round
     *  buttons inside it: half the field plus the dock's 6dp padding, scaled
     *  down with «Скругление» but never past round — web's
     *  `calc((var(--field) / 2 + var(--step-2)) * min(var(--round), 1))`, with
     *  `--round` 0.28 / 1 / 1.55 for sharp / soft / round. */
    val dock: Dp,
)

private fun shapesFor(roundness: AppRoundness): Shapes = when (roundness) {
    AppRoundness.Sharp -> Shapes(
        extraSmall = RoundedCornerShape(4.dp),
        small = RoundedCornerShape(6.dp),
        medium = RoundedCornerShape(8.dp),
        large = RoundedCornerShape(10.dp),
        extraLarge = RoundedCornerShape(12.dp),
    )
    AppRoundness.Soft -> Shapes(
        extraSmall = RoundedCornerShape(8.dp),
        small = RoundedCornerShape(12.dp),
        medium = RoundedCornerShape(16.dp),
        large = RoundedCornerShape(20.dp),
        extraLarge = RoundedCornerShape(24.dp),
    )
    // The default. Noticeably rounder than a typical Material screen on
    // purpose — bubbles, cards and fields read as soft capsules rather than
    // rounded rectangles, closer to the "even more rounded" look the app is
    // meant to have (session 2026-09-11, direct user request).
    AppRoundness.Round -> Shapes(
        extraSmall = RoundedCornerShape(14.dp),
        small = RoundedCornerShape(18.dp),
        medium = RoundedCornerShape(24.dp),
        large = RoundedCornerShape(30.dp),
        extraLarge = RoundedCornerShape(40.dp),
    )
}

private fun cornersFor(roundness: AppRoundness): TailchatCorners = when (roundness) {
    AppRoundness.Sharp -> TailchatCorners(bubble = 8.dp, bubbleTail = 3.dp, field = 8.dp, media = 6.dp, dock = 8.dp)
    AppRoundness.Soft -> TailchatCorners(bubble = 16.dp, bubbleTail = 5.dp, field = 16.dp, media = 12.dp, dock = 28.dp)
    AppRoundness.Round -> TailchatCorners(bubble = 26.dp, bubbleTail = 8.dp, field = 28.dp, media = 20.dp, dock = 28.dp)
}

val LocalTailchatAccents = staticCompositionLocalOf { GreenTokens.accents(depthDesign = true, outlines = false) }
val LocalTailchatCorners = staticCompositionLocalOf { cornersFor(AppRoundness.Round) }

/**
 * An outlined text field that stays a field with «Обводки» off: a tonal `raised`
 * fill under the (then transparent) edge — web's `--raised` input — and the
 * accent edge when focused, which is a state and so always drawn.
 */
@Composable
fun tailchatFieldColors(): TextFieldColors = MaterialTheme.colorScheme.let { scheme ->
    OutlinedTextFieldDefaults.colors(
        focusedBorderColor = scheme.primary,
        unfocusedBorderColor = scheme.outline,
        cursorColor = scheme.primary,
        focusedContainerColor = scheme.surfaceVariant,
        unfocusedContainerColor = scheme.surfaceVariant,
    )
}

/**
 * One layer of a CSS `box-shadow`, in dp: a vertical offset, a blur, a spread
 * (negative pulls the shadow in under the surface) and a colour. Painted by
 * [dropShadows] / [insetShadows] in Depth.kt.
 */
@Immutable
data class TailchatShadow(val y: Dp, val blur: Dp, val spread: Dp, val color: Color)

/**
 * One step of the elevation scale — web's `--elev-1/2/3`: a 1dp highlight on
 * the top edge ([edge], light catching the rim) over a tight contact shadow and
 * a soft ambient one ([shadows], in that order).
 */
@Immutable
data class TailchatElevation(val edge: Color, val shadows: List<TailchatShadow>)

/**
 * How far a surface sits above the page — web 1.128's elevation scale
 * (`--elev-1/2/3`, `--elev-inset`, `--sheen`, «1.128: объём» in
 * web/cloud/app.css), restated here number for number so the two clients cast
 * the same shadow. A hairline says where two surfaces meet; this says which of
 * them is nearer, which the owner asked for twice («объёмнее, как в WhatsApp»,
 * then «ещё глубже»).
 *
 * The four roles stay what they were, so every surface is still placed by
 * naming what it is; each now names a step of the scale rather than a bare dp:
 * chrome the room sits under ([bar], `--elev-2`), a card or round control
 * resting on the page ([card], `--elev-1`), a message ([bubble], `--elev-1`),
 * and anything drawn over everything else ([floating], `--elev-3`).
 *
 * In daylight a shadow is a hint of slate (`rgb(16,24,40)`) and the rim is
 * white; in the dark both are black-and-white at the web client's alphas.
 *
 * A full-bleed strip — the banners in CloudScreen, the call screen's own
 * background — stays flat: it is not an object sitting on the page, it *is* the
 * page. With «Объёмный дизайн» off ([enabled]) every in-flow step is flat and
 * only [floating] keeps its lift; «Обводки» is independent of all of this.
 */
@Immutable
data class TailchatDepth(
    /** `--elev-2`: chrome over the room — the conversation header, the
     *  roster's bars, the composer dock. */
    val bar: TailchatElevation,
    /** `--elev-1`: a card or a raised control resting on the page — a roster
     *  row, a status card, a round button, an avatar. */
    val card: TailchatElevation,
    /** `--elev-1`: a message bubble over the wallpaper. */
    val bubble: TailchatElevation,
    /** `--elev-3`: drawn over everything else — menus, sheets, the command
     *  palette, the emoji panel. */
    val floating: TailchatElevation,
    /** `--elev-inset`: a field pressed into its panel (the composer draft). */
    val inset: List<TailchatShadow>,
    /** `--sheen`: a faint top-down light on a fill — [sheen] at the top edge,
     *  gone by [sheenStop] of the height. */
    val sheen: Color,
    val sheenStop: Float,
    /** `--accent-glow`: the accent's own light under the primary action. */
    val accentGlow: TailchatShadow,
    /** For surfaces Compose puts in a window of their own (a `DropdownMenu`
     *  popup), where a hand-painted shadow would be clipped at the popup's
     *  edge: the platform's elevation at the height that reads as `--elev-3`. */
    val popup: Dp,
    /** «Объёмный дизайн». Off, [bar], [card] and [bubble] carry no shadow and no
     *  rim, [inset] is empty, [sheen] and [accentGlow] are transparent
     *  ([sheenBrush] then draws nothing): the flat 1.130 look, with no
     *  in-flow shadow, sheen, glow or inset. [floating] and [popup] stay — a
     *  menu over the page is lifted in either design. */
    val enabled: Boolean,
)

private fun fullDepthFor(tokens: Tokens): TailchatDepth {
    val glow = TailchatShadow(6.dp, 18.dp, (-6).dp, tokens.glow)
    return if (tokens.dark) {
        val edge = Color.White.copy(alpha = 0.045f)
        val black = Color.Black
        val elev1 = TailchatElevation(
            edge,
            listOf(
                TailchatShadow(1.dp, 2.dp, 0.dp, black.copy(alpha = 0.32f)),
                TailchatShadow(4.dp, 10.dp, (-4).dp, black.copy(alpha = 0.42f)),
            ),
        )
        TailchatDepth(
            bar = TailchatElevation(
                edge,
                listOf(
                    TailchatShadow(2.dp, 4.dp, 0.dp, black.copy(alpha = 0.30f)),
                    TailchatShadow(12.dp, 28.dp, (-10).dp, black.copy(alpha = 0.60f)),
                ),
            ),
            card = elev1,
            bubble = elev1,
            floating = TailchatElevation(
                edge,
                listOf(
                    TailchatShadow(6.dp, 14.dp, 0.dp, black.copy(alpha = 0.32f)),
                    TailchatShadow(32.dp, 64.dp, (-20).dp, black.copy(alpha = 0.78f)),
                ),
            ),
            inset = listOf(
                TailchatShadow(1.dp, 3.dp, 0.dp, black.copy(alpha = 0.38f)),
                TailchatShadow(0.dp, 0.dp, 1.dp, black.copy(alpha = 0.10f)),
            ),
            sheen = Color.White.copy(alpha = 0.035f),
            sheenStop = 0.55f,
            accentGlow = glow,
            popup = 12.dp,
            enabled = true,
        )
    } else {
        val edge = Color.White.copy(alpha = 0.85f)
        val slate = Color(0xFF101828)
        val elev1 = TailchatElevation(
            edge,
            listOf(
                TailchatShadow(1.dp, 2.dp, 0.dp, slate.copy(alpha = 0.07f)),
                TailchatShadow(4.dp, 10.dp, (-4).dp, slate.copy(alpha = 0.13f)),
            ),
        )
        TailchatDepth(
            bar = TailchatElevation(
                edge,
                listOf(
                    TailchatShadow(2.dp, 4.dp, 0.dp, slate.copy(alpha = 0.06f)),
                    TailchatShadow(14.dp, 30.dp, (-12).dp, slate.copy(alpha = 0.22f)),
                ),
            ),
            card = elev1,
            bubble = elev1,
            floating = TailchatElevation(
                edge,
                listOf(
                    TailchatShadow(8.dp, 16.dp, 0.dp, slate.copy(alpha = 0.08f)),
                    TailchatShadow(32.dp, 64.dp, (-20).dp, slate.copy(alpha = 0.30f)),
                ),
            ),
            inset = listOf(
                TailchatShadow(1.dp, 2.dp, 0.dp, slate.copy(alpha = 0.08f)),
                TailchatShadow(0.dp, 0.dp, 1.dp, slate.copy(alpha = 0.02f)),
            ),
            sheen = Color.White.copy(alpha = 0.6f),
            sheenStop = 0.6f,
            accentGlow = glow,
            popup = 12.dp,
            enabled = true,
        )
    }
}

private fun TailchatDepth.flattened(): TailchatDepth {
    val flat = TailchatElevation(Color.Transparent, emptyList())
    return copy(
        enabled = false,
        bar = flat,
        card = flat,
        bubble = flat,
        inset = emptyList(),
        sheen = Color.Transparent,
        accentGlow = accentGlow.copy(color = Color.Transparent),
    )
}

private fun depthFor(tokens: Tokens, enabled: Boolean): TailchatDepth =
    fullDepthFor(tokens).let { if (enabled) it else it.flattened() }

val LocalTailchatDepth = staticCompositionLocalOf { depthFor(GreenTokens, enabled = true) }

private fun tokensFor(mode: ThemeMode, palette: AppPalette, systemDark: Boolean): Tokens {
    val dark = when (mode) {
        ThemeMode.Auto -> systemDark
        ThemeMode.Dark -> true
        ThemeMode.Light -> false
    }
    return when (palette) {
        AppPalette.Green -> if (dark) GreenTokens else LightGreenTokens
        AppPalette.Amber -> if (dark) AmberTokens else LightAmberTokens
        AppPalette.Blue -> if (dark) BlueTokens else LightBlueTokens
        AppPalette.Matrix -> if (dark) MatrixTokens else LightMatrixTokens
        AppPalette.Mono -> if (dark) MonoTokens else LightMonoTokens
        AppPalette.Paper -> if (dark) PaperDarkTokens else PaperTokens
    }
}

private object NoPressIndication : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = object : Modifier.Node() {}
    override fun equals(other: Any?): Boolean = other === this
    override fun hashCode(): Int = 0
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TailchatTheme(
    mode: ThemeMode = ThemeMode.Auto,
    palette: AppPalette = AppPalette.Green,
    font: AppFont = AppFont.Mono,
    textScale: Float = 1f,
    roundness: AppRoundness = AppRoundness.Round,
    depthDesign: Boolean = true,
    outlines: Boolean = false,
    content: @Composable () -> Unit,
) {
    val tokens = tokensFor(mode, palette, isSystemInDarkTheme())
    // Match the system bars to the palette without replacing the content tree.
    val view = LocalView.current
    val backgroundArgb = tokens.paper.toArgb()
    val dark = tokens.dark
    SideEffect {
        val window = (view.context as? Activity)?.window ?: return@SideEffect
        window.statusBarColor = backgroundArgb
        window.navigationBarColor = backgroundArgb
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
    val typography = remember(font, textScale) { typographyFor(font, textScale) }
    val shapes = remember(roundness) { shapesFor(roundness) }
    val corners = remember(roundness) { cornersFor(roundness) }
    // One composition across palette changes: replacing it with a Crossfade
    // also replaced drafts, scroll state, dialogs and media players.
    val scheme = remember(tokens, outlines) { tokens.scheme(outlines) }
    val accents = remember(tokens, depthDesign, outlines) { tokens.accents(depthDesign, outlines) }
    val depth = remember(tokens, depthDesign) { depthFor(tokens, depthDesign) }
    CompositionLocalProvider(
        LocalTailchatAccents provides accents,
        LocalTailchatCorners provides corners,
        LocalTailchatDepth provides depth,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography,
            shapes = shapes,
            content = {
                CompositionLocalProvider(
                    LocalIndication provides NoPressIndication,
                    LocalRippleConfiguration provides null,
                    content = content,
                )
            },
        )
    }
}
