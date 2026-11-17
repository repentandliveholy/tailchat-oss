package net.tailchat.android.ui

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import net.tailchat.android.ChatWallpaper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/**
 * What the patterns actually paint (docs/archive/HANDOFF_WALLPAPERS.md §2, §3): the steps,
 * the off-phase of the diamond lattice, and the reduced density a dark scheme
 * asks for. Drawn through a real [CanvasDrawScope] into a bitmap and read back,
 * because those three numbers are the whole feature — a dot grid at 22dp, a
 * rule every 28dp and a 34dp lattice are what keep the pattern from fighting
 * the transcript's own line rhythm, and a "small" edit to any of them is
 * invisible in the source and obvious on a phone.
 *
 * Density is 2 throughout, which is what a phone runs: the steps are asserted
 * there, where 22dp is 44px.
 *
 * Dots are narrower than a pixel at this density — a 0.5dp radius is a 1px
 * disc, and a disc centred on a pixel *corner* covers a quarter of each of four
 * neighbours, so the ink is measured as coverage rather than compared against
 * the token's own colour. The rules and the diamond's larger dots do cover
 * whole pixels, and are asserted exactly.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatWallpaperDrawingTest {
    // Paper (light), the pair `Theme.kt` gives the book theme.
    private val paper = Color(0xFFF7F2E9)
    private val line = Color(0xFFE1D7C6)
    private val lineSoft = Color(0xFFEBE3D5)

    // Green (dark), `:root` in web/cloud/app.css — for the patterns whose
    // dark ink differs from their light one.
    private val darkPaper = Color(0xFF090C10)
    private val signal = Color(0xFF3FB950)
    private val cobalt = Color(0xFF58A6FF)
    private val ai = Color(0xFFBC8CFF)

    private fun accents(dark: Boolean = false, auroraStrength: Float = 0.16f, wallpaperTint: Float = 0f) = TailchatAccents(
        ownBubble = Color(0xFFE9EFE6),
        ownBubbleBorder = Color(0xFFC4D5C0),
        ownAccent = Color(0xFF4A6B4E),
        ownMuted = Color(0xFF766C5E),
        outlines = true,
        edge = line,
        edgeSoft = lineSoft,
        ai = ai,
        aiSoft = Color(0xFFEDE7F2),
        warning = Color(0xFF8A6A2F),
        glow = Color(0x38FFFFFF),
        line = line,
        lineSoft = lineSoft,
        dark = dark,
        signal = signal,
        cobalt = cobalt,
        auroraStrength = auroraStrength,
        wallpaperTint = wallpaperTint,
        glass = paper.copy(alpha = 0.72f),
        glassStrong = paper.copy(alpha = 0.84f),
        glassLine = line.copy(alpha = 0.7f),
        glassSheet = paper.copy(alpha = 0.95f),
    )

    /** The transcript's own two layers: the palette's paper, then the pattern. */
    private fun render(
        wallpaper: ChatWallpaper,
        accents: TailchatAccents = accents(),
        width: Int = 160,
        height: Int = 160,
        background: Color = paper,
    ): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        CanvasDrawScope().draw(
            Density(2f),
            LayoutDirection.Ltr,
            androidx.compose.ui.graphics.Canvas(bitmap.asImageBitmap()),
            Size(width.toFloat(), height.toFloat()),
        ) {
            drawRect(background)
            drawChatWallpaper(wallpaper, accents)
        }
        return bitmap
    }

    /**
     * How much of a full-strength [token] this pixel carries: 0 on bare paper,
     * 1 where the pattern is painted at the token's own alpha. Averaged over
     * the channels, whose deltas differ (22/27/35 for this paper/line pair).
     */
    private fun Bitmap.coverage(x: Int, y: Int, token: Color = line, background: Color = paper): Double {
        val actual = Color(getPixel(x, y))
        fun channel(back: Float, full: Float, got: Float): Double =
            if (abs(full - back) < 1e-4) 0.0 else ((back - got) / (back - full)).toDouble()
        return listOf(
            channel(background.red, token.red, actual.red),
            channel(background.green, token.green, actual.green),
            channel(background.blue, token.blue, actual.blue),
        ).average()
    }

    private fun Bitmap.isPaper(x: Int, y: Int) = coverage(x, y) < 0.02

    @Test
    fun `none leaves the paper untouched`() {
        val bitmap = render(ChatWallpaper.None)

        for (x in 0 until bitmap.width step 7) {
            for (y in 0 until bitmap.height step 7) {
                assertTrue("paper expected at $x,$y", bitmap.isPaper(x, y))
            }
        }
    }

    @Test
    fun `dots tile a 22dp grid, half a tile in`() {
        val bitmap = render(ChatWallpaper.Dots)
        val step = 44

        // 22dp at density 2 = 44px, and `radial-gradient`'s default centre puts
        // the first dot half a tile in rather than in the corner.
        assertTrue("dot at 22,22", bitmap.coverage(22, 22) > 0.5)
        assertTrue("dot one column on", bitmap.coverage(22 + step, 22) > 0.5)
        assertTrue("dot one row down", bitmap.coverage(22, 22 + step) > 0.5)
        assertTrue("two tiles on", bitmap.coverage(22 + 2 * step, 22 + 2 * step) > 0.5)
        // The gaps are what make it a pattern rather than a wash: a dot that
        // "grew" into its neighbour would fill these in.
        assertTrue("paper between the dots", bitmap.isPaper(22 + step / 2, 22))
        assertTrue("paper below the dots", bitmap.isPaper(22, 22 + step / 2))
        assertTrue("paper on the far side", bitmap.isPaper(22, 22 - step / 2))

        // One tile carries one dot's worth of ink: π of a 1px-radius disc. A
        // step or radius that drifted would move this number.
        val tileInk = (2 until 2 + step).sumOf { y -> (2 until 2 + step).sumOf { x -> bitmap.coverage(x, y) } }
        assertEquals(Math.PI, tileInk, 0.35)
    }

    @Test
    fun `ruled draws one hairline every 28dp`() {
        val bitmap = render(ChatWallpaper.Ruled)
        // 27.5dp at density 2 = a 2px stroke centred on 55, covering 54–55.
        val firstRuleTop = 54
        val step = 56

        assertTrue("rule row 1", bitmap.coverage(8, firstRuleTop, lineSoft) > 0.95)
        assertTrue("rule row 2", bitmap.coverage(8, firstRuleTop + 1, lineSoft) > 0.95)
        assertTrue("paper above", bitmap.isPaper(8, firstRuleTop - 2))
        assertTrue("paper below", bitmap.isPaper(8, firstRuleTop + 2))
        assertTrue("next rule", bitmap.coverage(8, firstRuleTop + step, lineSoft) > 0.95)
        assertTrue("the rule spans the width", bitmap.coverage(bitmap.width - 1, firstRuleTop, lineSoft) > 0.95)
        // `lineSoft`, not `line`: the handoff asks for the quieter token on the
        // pattern with the most ink on screen.
        assertTrue("the quieter token", bitmap.coverage(8, firstRuleTop, line) < 0.95)
    }

    @Test
    fun `diamond is two dot grids a half step apart`() {
        val bitmap = render(ChatWallpaper.Diamond)
        // 34dp at density 2 = 68px, the second pass shifted by 17dp = 34px, and
        // a 0.75dp radius covers its pixel whole.
        val cell = 34
        val step = 68

        assertTrue("first pass point", bitmap.coverage(cell, cell) > 0.95)
        assertTrue("second pass point", bitmap.coverage(step, step) > 0.95)
        assertTrue("same parity cell", bitmap.coverage(cell + step, cell) > 0.95)
        // Only the same-parity cells carry a dot — that is what makes the
        // lattice read as a diamond rather than as a square grid.
        assertTrue("off-lattice cell is paper", bitmap.isPaper(cell, step))
        assertTrue("and the mirrored one too", bitmap.isPaper(step, cell))
    }

    @Test
    fun `a dark scheme draws the same grid at reduced density`() {
        val light = render(ChatWallpaper.Dots)
        val dark = render(ChatWallpaper.Dots, accents(dark = true))
        val step = 44

        // Same grid, same phase: only the density is allowed to change.
        assertTrue("dark dot in place", dark.coverage(22, 22) > 0.25)
        assertTrue("dark dot one tile on", dark.coverage(22 + step, 22) > 0.25)
        assertTrue("dark gap stays empty", dark.isPaper(22 + step / 2, 22))

        // 55% of `line`: the whole tile's ink against the same tile in the light
        // render. One pixel is not enough — its 8-bit alpha and the rasteriser's
        // antialiasing differ between hosts (CI on Linux missed 0.02 on a single
        // pixel that macOS hit), while a tile's sum averages them out.
        fun tileInk(bitmap: Bitmap) =
            (2 until 2 + step).sumOf { y -> (2 until 2 + step).sumOf { x -> bitmap.coverage(x, y) } }
        val ratio = tileInk(dark) / tileInk(light)
        assertEquals("dark/light ink", 0.55, ratio, 0.03)
    }

    @Test
    fun `ruled keeps its step but drops to 70 percent in the dark`() {
        val dark = render(ChatWallpaper.Ruled, accents(dark = true))
        val firstRuleTop = 54

        assertTrue("rule still at 27dp", dark.coverage(8, firstRuleTop, lineSoft) > 0.6)
        assertTrue("next rule still 28dp on", dark.coverage(8, firstRuleTop + 56, lineSoft) > 0.6)
        // A 2px stroke covers its pixels whole, so here the composited colour
        // is checkable against the arithmetic: 70% of lineSoft over the paper.
        val composited = Color(dark.getPixel(8, firstRuleTop))
        assertEquals((0.7 * lineSoft.red + 0.3 * paper.red).toDouble(), composited.red.toDouble(), 0.012)
        assertEquals((0.7 * lineSoft.blue + 0.3 * paper.blue).toDouble(), composited.blue.toDouble(), 0.012)
    }

    // --- 1.128: aurora and the three line tiles ------------------------------

    /** [ink] at [alpha] over [over], composited the way a canvas does it. */
    private fun over(over: Color, ink: Color, alpha: Float) = Color(
        red = over.red * (1 - alpha) + ink.red * alpha,
        green = over.green * (1 - alpha) + ink.green * alpha,
        blue = over.blue * (1 - alpha) + ink.blue * alpha,
    )

    private fun assertColor(message: String, expected: Color, actual: Color, tolerance: Double = 0.012) {
        assertEquals("$message (red)", expected.red.toDouble(), actual.red.toDouble(), tolerance)
        assertEquals("$message (green)", expected.green.toDouble(), actual.green.toDouble(), tolerance)
        assertEquals("$message (blue)", expected.blue.toDouble(), actual.blue.toDouble(), tolerance)
    }

    private fun Bitmap.color(x: Int, y: Int) = Color(getPixel(x, y))

    /** The pattern repeats on its tile: every sampled pixel equals the one a
     *  tile to the right and a tile below, to within one 8-bit step. */
    private fun Bitmap.assertRepeats(tileW: Int, tileH: Int, stepX: Int, stepY: Int, rows: Int = tileH) {
        for (y in 0 until rows step stepY) {
            for (x in 0 until tileW step stepX) {
                val here = getPixel(x, y)
                for ((ox, oy) in listOf(tileW to 0, 0 to tileH)) {
                    val there = getPixel(x + ox, y + oy)
                    for (shift in listOf(16, 8, 0)) {
                        val a = (here shr shift) and 0xFF
                        val b = (there shr shift) and 0xFF
                        assertTrue("($x,$y) vs (${x + ox},${y + oy})", abs(a - b) <= 1)
                    }
                }
            }
        }
    }

    /** How far the most-inked pixel of one tile moved from the background, in
     *  the red channel — one stroke at the tile's own alpha, never two. */
    private fun Bitmap.strongestInk(tileW: Int, tileH: Int, background: Color): Double =
        (0 until tileH).maxOf { y -> (0 until tileW).maxOf { x -> abs(color(x, y).red - background.red).toDouble() } }

    @Test
    fun `waves repeat every 140 by 28dp and run on across the seam`() {
        val bitmap = render(ChatWallpaper.Waves, width = 600, height = 120)
        // Density 2: a 280×56px tile.
        bitmap.assertRepeats(tileW = 280, tileH = 56, stepX = 3, stepY = 1)

        // The crest of `M0 14C35 4 35 4 70 14` is (35, 6.5)dp = (70, 13)px,
        // where the curve runs flat: the 2.6px stroke covers rows 12 and 13
        // whole, in black at 7.5% on a light page.
        assertColor("crest", over(paper, Color.Black, 0.075f), bitmap.color(70, 12))
        assertColor("crest", over(paper, Color.Black, 0.075f), bitmap.color(70, 13))

        // At the seam (x = 140dp ≡ 0) the wave crosses y = 14 with the slope
        // it has, mirrored, in the middle of the tile (x = 70dp). A gap there
        // would carry less ink, a cap drawn twice by both tiles more.
        fun column(x: Int) = (0 until 56).sumOf { y -> (paper.red - bitmap.color(x, y).red).toDouble() }
        val seam = column(279) + column(280)
        val middle = column(139) + column(140)
        assertTrue("ink at the seam", seam > 0.0)
        assertEquals(middle, seam, middle * 0.08)
    }

    @Test
    fun `waves ink is white at 7 percent on a dark page`() {
        val bitmap = render(ChatWallpaper.Waves, accents(dark = true), width = 300, height = 60, background = darkPaper)
        assertColor("dark crest", over(darkPaper, Color.White, 0.07f), bitmap.color(70, 12))
        assertColor("dark crest", over(darkPaper, Color.White, 0.07f), bitmap.color(70, 13))
    }

    @Test
    fun `topo repeats every 240dp, one ring at its own alpha in both inks`() {
        val light = render(ChatWallpaper.Topo, width = 1000, height = 600)
        // A 480px tile; the corner rings are finished by the four tiles that
        // meet there, so the repeat holds across every edge.
        light.assertRepeats(tileW = 480, tileH = 480, stepX = 7, stepY = 7, rows = 100)
        // The innermost ring starts at (134, 120)dp heading straight down: at
        // (268, 240)px the 2.2px stroke covers columns 267 and 268 whole.
        // (Two of the outer contours do cross near (116, 56)dp and ink twice
        // there — they do in web's own tile too — so a single-ring pixel is
        // what carries the alpha.)
        assertColor("ring", over(paper, Color.Black, 0.07f), light.color(268, 240))
        assertColor("ring", over(paper, Color.Black, 0.07f), light.color(267, 240))

        val dark = render(ChatWallpaper.Topo, accents(dark = true), width = 480, height = 480, background = darkPaper)
        assertColor("dark ring", over(darkPaper, Color.White, 0.065f), dark.color(268, 240))
    }

    @Test
    fun `doodle repeats every 168dp, one stroke at its own alpha in both inks`() {
        val light = render(ChatWallpaper.Doodle, width = 700, height = 400)
        light.assertRepeats(tileW = 336, tileH = 336, stepX = 5, stepY = 5, rows = 60)
        assertEquals(paper.red * 0.09, light.strongestInk(336, 336, paper), paper.red * 0.09 * 0.15)

        val dark = render(ChatWallpaper.Doodle, accents(dark = true), width = 336, height = 336, background = darkPaper)
        assertEquals((1 - darkPaper.red) * 0.085, dark.strongestInk(336, 336, darkPaper), (1 - darkPaper.red) * 0.085 * 0.15)
    }

    @Test
    fun `the line tiles sit on a cobalt and signal tint from opposite corners`() {
        val bitmap = render(
            ChatWallpaper.Waves,
            accents(dark = true, wallpaperTint = 0.09f),
            width = 300,
            height = 600,
            background = darkPaper,
        )
        // Both corners are clear of the wave (it never leaves 6.5–21.5dp of
        // its 28dp row), so these are the tint alone: each glow at full
        // strength in its own corner and nothing of the other one.
        assertColor("cobalt, top right", over(darkPaper, cobalt, 0.09f), bitmap.color(299, 1), 0.01)
        assertColor("signal, bottom left", over(darkPaper, signal, 0.09f), bitmap.color(0, 599), 0.01)
    }

    @Test
    fun `aurora glows with the palette's three accents`() {
        val bitmap = render(
            ChatWallpaper.Aurora,
            accents(dark = true, auroraStrength = 0.30f),
            width = 400,
            height = 800,
            background = darkPaper,
        )
        // Each glow at the centre web puts it: signal at (8%, 10%), cobalt at
        // (94%, 26%), at the full strength; neither reaches the other.
        assertColor("signal, top left", over(darkPaper, signal, 0.30f), bitmap.color(32, 80), 0.02)
        assertColor("cobalt, top right", over(darkPaper, cobalt, 0.30f), bitmap.color(376, 208), 0.02)
        // The AI glow is centred below the bottom edge, at (50%, 108%), and
        // reaches the bottom row 65px into a 440px radius that fades out by
        // 72% of it: 0.30 × (1 − 0.148 / 0.72) of the accent.
        assertColor("ai, bottom", over(darkPaper, ai, 0.30f * (1f - (65f / 440f) / 0.72f)), bitmap.color(200, 799), 0.02)
    }
}
