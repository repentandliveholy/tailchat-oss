package net.tailchat.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp
import net.tailchat.android.ChatWallpaper

/**
 * The decorative patterns behind a conversation (docs/archive/HANDOFF_WALLPAPERS.md, web
 * 1.128's «объёмные обои»), drawn from primitives on the canvas. There is no
 * image file anywhere in this feature: the dot grid, the rules and the diamond
 * are a handful of [DrawScope] calls, `aurora` is three gradients, and the
 * three line tiles are the web client's own SVG paths parsed once — which is
 * what keeps the APK from carrying textures and the shapes correct at any
 * density.
 *
 * The first three steps are not free numbers. 22/28/34 line up with the
 * transcript's own rhythm — 23px bubbles with 5px gaps between them — so
 * `Ruled` lands under the text instead of cutting through it, and the other two
 * read as paper texture rather than as a grid. Changing one shifts every line
 * in the thread.
 */
private val DOTS_STEP = 22.dp
private val DOTS_RADIUS = 0.5.dp
private val RULED_STEP = 28.dp
private val DIAMOND_STEP = 34.dp

/** A step and a half, which is what makes two dot grids a diamond lattice. */
private val DIAMOND_SHIFT = 17.dp
private val DIAMOND_RADIUS = 0.75.dp

/**
 * A light hairline on black reads much louder than a dark one on white, so in a
 * dark scheme the same pattern is drawn fainter — the *step* is untouched, or
 * switching light↔dark would move the whole backdrop. `Ruled` gets the gentler
 * of the two reductions because it is already the quietest token (`lineSoft`)
 * and there are many more of its lines on screen.
 */
private const val DARK_ALPHA = 0.55f
private const val DARK_ALPHA_SOFT = 0.7f

/**
 * Paints one pattern over the whole draw area, tiled by hand: Compose has no
 * repeating-gradient equivalent of the web client's `background-size`, and
 * measuring the area in [DrawScope] is cheaper than asking for one.
 *
 * [ChatWallpaper.None] draws nothing at all, and must cost nothing.
 */
fun DrawScope.drawChatWallpaper(wallpaper: ChatWallpaper, accents: TailchatAccents) {
    when (wallpaper) {
        ChatWallpaper.None -> Unit
        ChatWallpaper.Dots -> drawDotGrid(
            step = DOTS_STEP.toPx(),
            radius = DOTS_RADIUS.toPx(),
            color = accents.line.forWallpaper(accents.dark),
        )
        // `lineSoft`, not `line`: horizontals are the pattern with the most
        // ink on screen, and the stronger token turns into ruled paper.
        ChatWallpaper.Ruled -> drawRules(
            step = RULED_STEP.toPx(),
            stroke = 1.dp.toPx(),
            color = accents.lineSoft.forWallpaper(accents.dark, DARK_ALPHA_SOFT),
        )
        ChatWallpaper.Diamond -> {
            val ink = accents.line.forWallpaper(accents.dark)
            val step = DIAMOND_STEP.toPx()
            val radius = DIAMOND_RADIUS.toPx()
            val shift = DIAMOND_SHIFT.toPx()
            // Two passes of the one dot grid, the second offset by half a step
            // on both axes: a set-type ornament, not a drawn trellis.
            drawDotGrid(step = step, radius = radius, color = ink)
            drawDotGrid(step = step, radius = radius, color = ink, startX = shift, startY = shift)
        }
        ChatWallpaper.Aurora -> drawAurora(accents)
        ChatWallpaper.Waves -> drawLineTile(WavesTile, accents)
        ChatWallpaper.Topo -> drawLineTile(TopoTile, accents)
        ChatWallpaper.Doodle -> drawLineTile(DoodleTile, accents)
    }
}

/** `aurora`'s quiet grid on top of the light: 24dp, the quieter line token. */
private val AURORA_GRID_STEP = 24.dp

/**
 * `aurora` (web/cloud/app.css, «1.128: объёмные обои»): the palette's three
 * accents glowing through the page — signal at the top left, cobalt at the top
 * right, the AI accent rising from below the bottom edge — each an ellipse
 * fading out by 72% of its radius, at [TailchatAccents.auroraStrength]. A
 * 24dp grid of `lineSoft` dots sits over them so the light reads as a space
 * behind a surface rather than as a stain on it. Layers are painted bottom
 * first, the reverse of the CSS `background-image` list.
 */
private fun DrawScope.drawAurora(accents: TailchatAccents) {
    val w = size.width
    val h = size.height
    val strength = accents.auroraStrength
    drawGlow(Offset(0.50f * w, 1.08f * h), 0.75f * w, 0.55f * h, accents.ai.copy(alpha = strength), 0.72f)
    drawGlow(Offset(0.94f * w, 0.26f * h), 0.55f * w, 0.48f * h, accents.cobalt.copy(alpha = strength), 0.72f)
    drawGlow(Offset(0.08f * w, 0.10f * h), 0.60f * w, 0.50f * h, accents.signal.copy(alpha = strength), 0.72f)
    drawDotGrid(
        step = AURORA_GRID_STEP.toPx(),
        radius = DOTS_RADIUS.toPx(),
        color = accents.lineSoft.forWallpaper(accents.dark, DARK_ALPHA_SOFT),
    )
}

/**
 * One of the web client's SVG line tiles (`--wp-waves`, `--wp-topo`,
 * `--wp-doodle`), path for path: [width]×[height] user units, one unit = 1dp,
 * stroked [stroke] wide with round caps and joins. The ink is white on a dark
 * page and black on a light one, at the tile's own alpha — an SVG in a CSS
 * `url()` cannot read a variable, so web ships both inks and so does this.
 */
private class LineTile(
    val width: Float,
    val height: Float,
    val stroke: Float,
    val darkAlpha: Float,
    val lightAlpha: Float,
    val paths: List<Path>,
)

private fun svgPath(d: String, dx: Float = 0f, dy: Float = 0f): Path =
    PathParser().parsePathString(d).toPath().apply { if (dx != 0f || dy != 0f) translate(Offset(dx, dy)) }

private fun circle(cx: Float, cy: Float, r: Float): Path =
    Path().apply { addOval(Rect(cx - r, cy - r, cx + r, cy + r)) }

/** `--wp-waves`, 140×28: one wave that leaves the tile on the tangent it
 *  entered with, so the rows run on without a seam. */
private val WavesTile by lazy {
    LineTile(
        width = 140f, height = 28f, stroke = 1.3f, darkAlpha = 0.07f, lightAlpha = 0.075f,
        paths = listOf(svgPath("M0 14C35 4 35 4 70 14S105 24 140 14")),
    )
}

/** `--wp-topo`, 240×240: five contour rings around the centre, and one set of
 *  three corner rings (the SVG's `<use href="#c">`) drawn at all four corners,
 *  so four neighbouring tiles complete each corner set between them. */
private val TopoTile by lazy {
    val centre = listOf(
        "M134 120C134 123 133 127 131 129C129 132 126 135 123 136C120 136 116 134 113 132C110 130 108 128 107 125C106 122 105 118 106 115C108 112 111 111 114 109C116 108 120 106 122 106C125 106 129 108 131 111C133 113 134 117 134 120Z",
        "M144 120C145 126 146 134 143 139C140 144 132 147 125 149C119 150 109 151 104 148C99 144 97 135 96 129C94 123 94 117 96 111C97 105 100 97 105 94C110 91 119 89 125 91C131 93 137 98 140 103C143 108 144 114 144 120Z",
        "M162 120C164 129 161 142 155 150C150 158 138 167 128 167C119 168 109 159 100 154C92 149 81 144 77 136C73 127 74 114 78 105C81 96 90 85 98 82C106 78 118 81 126 84C135 86 141 91 147 97C153 103 161 111 162 120Z",
        "M183 120C184 132 174 148 165 158C157 168 143 177 131 180C118 183 98 182 88 175C79 168 75 150 71 138C68 125 62 112 65 100C68 88 77 72 88 65C99 58 118 55 131 58C143 61 155 73 164 83C173 93 183 108 183 120Z",
        "M200 120C202 135 192 159 181 171C170 184 149 197 134 198C118 198 103 181 90 173C76 164 58 157 52 145C47 132 50 111 56 97C61 82 72 65 85 59C97 53 117 56 131 59C145 63 157 69 168 79C180 90 197 105 200 120Z",
    )
    val corner = listOf(
        "M12 0C12 3 12 7 11 9C9 10 4 10 2 10C-1 10 -3 10 -5 9C-8 9 -12 7 -13 5C-14 3 -13 -2 -12 -4C-11 -7 -7 -8 -5 -9C-3 -10 -1 -11 2 -11C5 -11 9 -11 11 -9C12 -7 12 -3 12 0Z",
        "M24 0C24 5 23 13 20 17C17 20 9 21 4 21C-2 22 -8 23 -12 21C-16 19 -19 12 -20 7C-22 3 -21 -2 -20 -7C-18 -12 -16 -18 -12 -21C-8 -23 -1 -23 4 -22C9 -21 15 -19 18 -15C22 -12 23 -5 24 0Z",
        "M40 0C39 8 33 16 28 23C22 30 15 40 7 42C-0 43 -11 36 -18 31C-25 26 -33 21 -37 14C-42 6 -48 -9 -45 -16C-41 -23 -25 -26 -17 -29C-8 -32 -2 -37 6 -37C15 -36 27 -34 33 -28C38 -21 41 -8 40 0Z",
    )
    val corners = listOf(0f to 0f, 240f to 0f, 0f to 240f, 240f to 240f)
    LineTile(
        width = 240f, height = 240f, stroke = 1.1f, darkAlpha = 0.065f, lightAlpha = 0.07f,
        paths = centre.map { svgPath(it) } + corners.flatMap { (x, y) -> corner.map { svgPath(it, x, y) } },
    )
}

/** `--wp-doodle`, 168×168: a chat bubble, ticks, a star, a heart, a paper
 *  clip, a target, two pluses, a microphone, a squiggle and three dots — all
 *  inside the tile, so nothing crosses a seam. */
private val DoodleTile by lazy {
    LineTile(
        width = 168f, height = 168f, stroke = 1.4f, darkAlpha = 0.085f, lightAlpha = 0.09f,
        paths = listOf(
            svgPath("M4 0h18a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H11l-6 5v-5H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z", 14f, 14f),
            svgPath("M0 6l4 4 8-9M7 8l2 2 8-9", 92f, 22f),
            svgPath("M9 0l2.6 5.6 6.1.7-4.5 4.2 1.2 6L9 13.6 3.6 16.5l1.2-6L.3 6.3l6.1-.7z", 130f, 56f),
            svgPath("M9 16S0 10.5 0 5a4.5 4.5 0 0 1 9-1 4.5 4.5 0 0 1 9 1c0 5.5-9 11-9 11z", 52f, 70f),
            svgPath("M14 6l-8 8a3 3 0 0 0 4 4l9-9a5 5 0 0 0-7-7l-9 9a7 7 0 0 0 10 10l7-7", 20f, 104f),
            circle(112f, 118f, 7f),
            circle(112f, 118f, 1.5f),
            svgPath("M6 0v12M0 6h12", 66f, 16f),
            svgPath("M5 0v10M0 5h10", 140f, 132f),
            svgPath("M5 0a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V3a3 3 0 0 1 3-3zM0 9a5 5 0 0 0 10 0M5 14v3", 84f, 128f),
            svgPath("M0 4c3-4 6-4 9 0s6 4 9 0", 98f, 74f),
            circle(40f, 60f, 1.6f),
            circle(148f, 20f, 1.6f),
            circle(62f, 146f, 1.6f),
        ),
    )
}

/**
 * A line tile over its accent tint: cobalt from the top right and signal from
 * the bottom left, each an 80%×60% ellipse fading by 70%, at
 * [TailchatAccents.wallpaperTint] — the part of the pattern that *is* made of
 * the palette. The tile is then repeated from the top-left corner, each copy
 * clipped to its own cell exactly as `background-repeat` clips the SVG, so a
 * stroke that crosses the edge (the wave's round caps, the topographic corner
 * rings) is finished by the neighbour instead of being drawn twice.
 */
private fun DrawScope.drawLineTile(tile: LineTile, accents: TailchatAccents) {
    val w = size.width
    val h = size.height
    drawGlow(Offset(0f, h), 0.80f * w, 0.60f * h, accents.signal.copy(alpha = accents.wallpaperTint), 0.70f)
    drawGlow(Offset(w, 0f), 0.80f * w, 0.60f * h, accents.cobalt.copy(alpha = accents.wallpaperTint), 0.70f)

    val ink = if (accents.dark) Color.White.copy(alpha = tile.darkAlpha) else Color.Black.copy(alpha = tile.lightAlpha)
    val unit = density
    val cellW = tile.width * unit
    val cellH = tile.height * unit
    // In tile units: the canvas is scaled by the density inside each cell, so
    // the stroke width scales with it and stays 1.3/1.1/1.4dp.
    val stroke = Stroke(width = tile.stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
    var top = 0f
    while (top < h) {
        var left = 0f
        while (left < w) {
            clipRect(left, top, left + cellW, top + cellH) {
                withTransform({
                    translate(left, top)
                    scale(unit, unit, pivot = Offset.Zero)
                }) {
                    for (path in tile.paths) drawPath(path, ink, style = stroke)
                }
            }
            left += cellW
        }
        top += cellH
    }
}

/** Every palette token is opaque, so a fixed alpha is the whole rule. */
private fun Color.forWallpaper(dark: Boolean, alpha: Float = DARK_ALPHA): Color =
    if (dark) copy(alpha = alpha) else this

/**
 * The dot lattice. The first dot sits half a step in rather than in the corner,
 * matching the web client's `radial-gradient` (whose default centre is the tile's
 * middle) — the two clients are meant to tile identically.
 */
private fun DrawScope.drawDotGrid(
    step: Float,
    radius: Float,
    color: Color,
    startX: Float = 0f,
    startY: Float = 0f,
) {
    var y = startY + step / 2f
    while (y < size.height + radius) {
        var x = startX + step / 2f
        while (x < size.width + radius) {
            drawCircle(color = color, radius = radius, center = Offset(x, y))
            x += step
        }
        y += step
    }
}

/**
 * Horizontal rules. The web client tiles a 1px band at 27–28px of every 28px
 * tile; a stroke is centred on its `y`, so the centre line sits half a stroke
 * above the tile's end and the first rule is not clipped by the top edge.
 */
private fun DrawScope.drawRules(step: Float, stroke: Float, color: Color) {
    var y = step - stroke / 2f
    while (y - stroke / 2f < size.height) {
        drawLine(color = color, start = Offset(0f, y), end = Offset(size.width, y), strokeWidth = stroke)
        y += step
    }
}

/** The settings preview card: 120dp tall, and 186dp wide unless the caller
 *  hands it a cell to fill (the settings grid does — `size` gives way to an
 *  exact incoming width). */
private val PREVIEW_WIDTH = 186.dp
private val PREVIEW_HEIGHT = 120.dp
private val PREVIEW_RADIUS = 14.dp

/** The card's own outline, shared with the selection ring the settings sheet
 *  draws around it so the two can never disagree about the corner. */
val WallpaperPreviewShape: Shape = RoundedCornerShape(PREVIEW_RADIUS)

/**
 * One pattern as a settings card: the transcript's own paper, the pattern drawn
 * by [drawChatWallpaper] (so the preview cannot drift from what the transcript
 * does), and two bubbles over it. The bubbles are the point — every pattern is
 * decorative by construction, and seeing the message contrast survive it is the
 * only way to choose between «точки» and «ромб», which are indistinguishable in
 * a caption.
 */
@Composable
fun WallpaperPreview(wallpaper: ChatWallpaper, modifier: Modifier = Modifier) {
    val accents = LocalTailchatAccents.current
    val paper = MaterialTheme.colorScheme.background
    val peerBubble = MaterialTheme.colorScheme.surfaceVariant
    val ownBubble = accents.ownBubble
    val bubbleInk = MaterialTheme.colorScheme.onSurfaceVariant

    Canvas(modifier.size(PREVIEW_WIDTH, PREVIEW_HEIGHT)) {
        val card = Path().apply {
            addRoundRect(RoundRect(Rect(Offset.Zero, size), CornerRadius(PREVIEW_RADIUS.toPx())))
        }
        // Clipped to the card's own corner, so a pattern cannot leak out of the
        // rounded rectangle the way it would out of a plain rectangular fill.
        clipPath(card) {
            drawRect(paper)
            drawChatWallpaper(wallpaper, accents)

            // Two bubbles, a peer's over an own one, drawn as the transcript
            // draws them: solid fills, so whatever the pattern does underneath
            // is hidden exactly where text would be.
            val bubbleWidth = 92.dp.toPx()
            val bubbleHeight = 30.dp.toPx()
            val inset = 12.dp.toPx()
            val radius = CornerRadius(10.dp.toPx())
            val peerTop = Offset(inset, 22.dp.toPx())
            val ownTop = Offset(size.width - inset - bubbleWidth, 64.dp.toPx())

            for ((top, fill) in listOf(peerTop to peerBubble, ownTop to ownBubble)) {
                drawRoundRect(color = fill, topLeft = top, size = Size(bubbleWidth, bubbleHeight), cornerRadius = radius)
                // Two stands-in for lines of text: the shorter one under the
                // longer, the way a paragraph looks at this size.
                val bar = Offset(top.x + 10.dp.toPx(), top.y + 9.dp.toPx())
                drawRoundRect(
                    color = bubbleInk.copy(alpha = 0.45f),
                    topLeft = bar,
                    size = Size(bubbleWidth - 30.dp.toPx(), 3.dp.toPx()),
                    cornerRadius = CornerRadius(1.5.dp.toPx()),
                )
                drawRoundRect(
                    color = bubbleInk.copy(alpha = 0.3f),
                    topLeft = Offset(bar.x, bar.y + 8.dp.toPx()),
                    size = Size(bubbleWidth - 52.dp.toPx(), 3.dp.toPx()),
                    cornerRadius = CornerRadius(1.5.dp.toPx()),
                )
            }
        }
    }
}
