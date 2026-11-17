package net.tailchat.android.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import androidx.compose.ui.graphics.layer.drawLayer
import net.tailchat.android.ChatWallpaper
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/*
 * The painting half of [TailchatDepth]: CSS `box-shadow` (outer and inset),
 * the `--elev-edge` rim and the `--sheen` light, drawn by hand rather than with
 * Compose's `shadowElevation`. The platform shadow is one fixed light source
 * whose strength the theme cannot set — on these near-black palettes it simply
 * disappears — while web 1.128 is three exact layers per step. Painting them
 * here is what lets both clients cast the same shadow.
 */

/**
 * `box-shadow` outside [shape], and only outside it: with [outsideOnly] the
 * shadow is clipped away under the surface, exactly as CSS clips an outer
 * shadow to the border box. That is what lets a translucent «glass» surface
 * stay clean instead of showing its own shadow through itself. An opaque
 * surface covers its own shadow anyway and passes `false`: a path clip is the
 * one expensive step here, and a transcript of bubbles would pay it per row.
 */
fun Modifier.dropShadows(shadows: List<TailchatShadow>, shape: Shape, outsideOnly: Boolean = true): Modifier =
    if (shadows.isEmpty()) this else drawWithCache {
        val visible = shadows.filter { it.color.alpha > 0f }
        if (visible.isEmpty()) return@drawWithCache onDrawBehind { }
        val body = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
        val casts = visible.map { shadow ->
            val spread = shadow.spread.toPx()
            val grown = Size((size.width + 2 * spread).coerceAtLeast(0f), (size.height + 2 * spread).coerceAtLeast(0f))
            val silhouette = Path().apply {
                addOutline(shape.createOutline(grown, layoutDirection, this@drawWithCache))
                translate(Offset(-spread, -spread))
            }
            silhouette to shadowPaint(shadow.color, shadow.blur.toPx(), shadow.y.toPx())
        }
        onDrawBehind {
            val cast = {
                drawIntoCanvas { canvas ->
                    for ((path, paint) in casts) canvas.nativeCanvas.drawPath(path.asAndroidPath(), paint)
                }
            }
            if (outsideOnly) clipPath(body, ClipOp.Difference) { cast() } else cast()
        }
    }

/**
 * `box-shadow: inset …` inside [shape], over whatever was drawn before this
 * modifier (the field's own fill) and under the content after it. Each layer
 * is the shadow of everything *outside* the shape — shifted by its offset and
 * pulled in by its spread — falling onto the inside, which is the CSS
 * definition, not an approximation of it.
 */
fun Modifier.insetShadows(shadows: List<TailchatShadow>, shape: Shape): Modifier =
    if (shadows.isEmpty()) this else drawWithCache {
        val body = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
        val margin = shadows.maxOf { it.blur.toPx() + abs(it.y.toPx()) + abs(it.spread.toPx()) } + 4f
        val frames = shadows.map { shadow ->
            val spread = shadow.spread.toPx()
            val shrunk = Size((size.width - 2 * spread).coerceAtLeast(0f), (size.height - 2 * spread).coerceAtLeast(0f))
            val hole = Path().apply {
                addOutline(shape.createOutline(shrunk, layoutDirection, this@drawWithCache))
                translate(Offset(spread, spread + shadow.y.toPx()))
            }
            val outside = Path().apply { addRect(Rect(-margin, -margin, size.width + margin, size.height + margin)) }
            val frame = Path().apply { op(outside, hole, PathOperation.Difference) }
            frame to shadowPaint(shadow.color, shadow.blur.toPx(), 0f)
        }
        onDrawBehind {
            clipPath(body) {
                drawIntoCanvas { canvas ->
                    for ((path, paint) in frames) canvas.nativeCanvas.drawPath(path.asAndroidPath(), paint)
                }
            }
        }
    }

/**
 * A paint whose only visible output is a CSS-style shadow of whatever path it
 * draws. With [blurPx] at zero there is nothing to blur, so the path itself is
 * filled in the shadow colour (`inset 0 0 0 1px` is a solid ring); otherwise
 * the paint is transparent and carries a shadow layer — CSS blur is twice the
 * Gaussian sigma, and Skia turns a shadow radius `r` into `0.57735·r + 0.5`.
 */
private fun shadowPaint(color: Color, blurPx: Float, dyPx: Float): android.graphics.Paint =
    android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        if (blurPx <= 0f && dyPx == 0f) {
            this.color = color.toArgb()
        } else {
            this.color = android.graphics.Color.TRANSPARENT
            val radius = max(0.01f, (blurPx / 2f - 0.5f) / 0.57735f)
            setShadowLayer(radius, 0f, dyPx, color.toArgb())
        }
    }

/**
 * One surface of the depth scale, painted in CSS order: [elevation]'s shadows
 * outside the shape (and [extraShadows], e.g. an accent glow), then [fill],
 * then each of [lights] over the fill (`--sheen`, the own bubble's accent
 * wash), then the content, then the 1dp rim on top. A `null` elevation is a
 * flat surface: fill and lights only.
 *
 * Meant for a `Surface(color = Color.Transparent, shape = …)`: the Surface
 * keeps clipping the content and setting its colour, this paints everything a
 * `background` would — which a Surface cannot do itself, because its fill
 * would otherwise be the last thing under the content and the light has to sit
 * between the two.
 */
fun Modifier.tailchatSurface(
    shape: Shape,
    fill: Color,
    elevation: TailchatElevation?,
    lights: List<Brush> = emptyList(),
    extraShadows: List<TailchatShadow> = emptyList(),
): Modifier = dropShadows(elevation?.shadows.orEmpty() + extraShadows, shape, outsideOnly = fill.alpha < 1f).drawWithCache {
    val outline = shape.createOutline(size, layoutDirection, this)
    val edge = elevation?.edge?.takeIf { it.alpha > 0f }
    val rim = edge?.let { rimPath(outline, 1.dp.toPx()) }
    onDrawWithContent {
        drawOutline(outline, fill)
        for (light in lights) if (light !== NoLight) drawOutline(outline, light)
        drawContent()
        if (rim != null && edge != null) drawPath(rim, edge)
    }
}

/** The `inset 0 1px 0` rim on its own, over the content — for a surface whose
 *  fill something else already paints (a Material `Surface` with `onClick`). */
fun Modifier.rim(edge: Color, shape: Shape): Modifier = if (edge.alpha <= 0f) this else drawWithCache {
    val rim = rimPath(shape.createOutline(size, layoutDirection, this), 1.dp.toPx())
    onDrawWithContent {
        drawContent()
        drawPath(rim, edge)
    }
}

/** The part of the shape that the same shape, moved down by [thickness],
 *  does not cover: the top edge's highlight following the corners. */
private fun rimPath(outline: Outline, thickness: Float): Path {
    val body = Path().apply { addOutline(outline) }
    val shifted = Path().apply { addOutline(outline); translate(Offset(0f, thickness)) }
    return Path().apply { op(body, shifted, PathOperation.Difference) }
}

/** `--sheen`: a top-down light on a fill, gone by [TailchatDepth.sheenStop];
 *  [NoLight] when «Объёмный дизайн» is off. */
fun TailchatDepth.sheenBrush(): Brush =
    if (enabled) Brush.verticalGradient(0f to sheen, sheenStop to sheen.copy(alpha = 0f)) else NoLight

/** A light that paints nothing: [tailchatSurface] skips it by identity, so a
 *  flat surface pays no draw call for the light it would have had. */
val NoLight: Brush = SolidColor(Color.Transparent)

/**
 * `linear-gradient(<angle>deg, color, transparent <stop>)` with CSS's own
 * geometry: the angle runs clockwise from "to top", and the gradient line is
 * exactly long enough for both corners it points between to sit on its ends.
 * The own bubble's accent wash is `150deg`, 16% → 0 by 70%.
 */
fun cssLinearGradient(angleDegrees: Float, color: Color, stop: Float): Brush = object : ShaderBrush() {
    override fun createShader(size: Size): Shader {
        val radians = Math.toRadians(angleDegrees.toDouble())
        val dx = sin(radians).toFloat()
        val dy = -cos(radians).toFloat()
        val half = (abs(size.width * dx) + abs(size.height * dy)) / 2f
        val center = Offset(size.width / 2f, size.height / 2f)
        return LinearGradientShader(
            from = center - Offset(dx * half, dy * half),
            to = center + Offset(dx * half, dy * half),
            colors = listOf(color, color.copy(alpha = 0f)),
            colorStops = listOf(0f, stop),
        )
    }
}

/**
 * CSS `radial-gradient(<rx> <ry> at <cx> <cy>, color, transparent <stop>)`:
 * an elliptical glow with explicit radii, drawn as a circular gradient on a
 * canvas stretched sideways by `rx / ry`. Compose's radial gradient is a circle
 * only, and the web glows are ellipses sized off the box's width *and* height.
 * The fade runs to the same colour at zero alpha, never to transparent black,
 * so no interpolation mode can darken its edge.
 */
internal fun DrawScope.drawGlow(center: Offset, rx: Float, ry: Float, color: Color, stop: Float) {
    if (rx <= 0f || ry <= 0f || color.alpha <= 0f) return
    val stretch = rx / ry
    withTransform({ scale(stretch, 1f, pivot = center) }) {
        drawRect(
            brush = Brush.radialGradient(
                0f to color,
                stop to color.copy(alpha = 0f),
                center = center,
                radius = ry,
            ),
            topLeft = Offset(center.x - center.x / stretch, 0f),
            size = Size(size.width / stretch, size.height),
        )
    }
}

/**
 * Ambient light — the app's own background since web 1.128 («1.128: студия»):
 * the page with three soft accent glows, signal at the top left, cobalt at the
 * top right, the AI accent at the bottom right. It is what the translucent bars
 * and the floating composer are tinted by.
 */
fun DrawScope.drawAmbientLight(paper: Color, accents: TailchatAccents) {
    drawRect(paper)
    val w = size.width
    val h = size.height
    drawGlow(Offset(0f, 0f), 0.70f * w, 0.60f * h, accents.signal.copy(alpha = 0.11f), 0.70f)
    drawGlow(Offset(w, 0f), 0.55f * w, 0.55f * h, accents.cobalt.copy(alpha = 0.09f), 0.70f)
    drawGlow(Offset(w, h), 0.65f * w, 0.60f * h, accents.ai.copy(alpha = 0.10f), 0.70f)
}

/**
 * The room behind a screen: [drawAmbientLight], then [wallpaper] over it when
 * there is one. Recorded once into its own graphics layer and only replayed
 * afterwards — the pattern is the one thing that must stand still while a
 * conversation scrolls over it, and re-painting a few hundred tile strokes on
 * every frame of that scroll would be work for an unchanged picture. A new
 * size, palette or pattern records it again.
 */
fun Modifier.roomBackdrop(paper: Color, accents: TailchatAccents, wallpaper: ChatWallpaper?): Modifier =
    drawWithCache {
        val layer = obtainGraphicsLayer()
        layer.record {
            drawAmbientLight(paper, accents)
            if (wallpaper != null) drawChatWallpaper(wallpaper, accents)
        }
        onDrawBehind { drawLayer(layer) }
    }
