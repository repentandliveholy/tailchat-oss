package net.tailchat.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.LayoutModifier
import androidx.compose.ui.layout.IntrinsicMeasureScope
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import net.tailchat.android.AppPreferences
import net.tailchat.android.R
import net.tailchat.android.cloud.LINK_PREVIEW_HERO_MAX_HEIGHT_DP
import net.tailchat.android.cloud.LINK_PREVIEW_THUMB_DP
import net.tailchat.android.cloud.LinkPreview
import net.tailchat.android.cloud.LinkPreviewLayout
import net.tailchat.android.cloud.LinkPreviewLoader

/*
 * The link-preview card — web's `.link-preview`, in the three shapes `buildLinkPreviewCard` picks
 * from the picture's own size: a picture across the top (hero), a 56 dp square beside the text
 * (thumb), or the text alone.
 *
 * The card is a pure function of a settled [LinkPreview]: nothing here waits for a picture, so
 * nothing jumps. What waits is the loader (CloudController.linkPreviews), which resolves only when
 * the title is known and the picture has been fetched, decoded and measured — and until then this
 * emits nothing at all, not a skeleton. A bubble scrolled back into view draws its card in the first
 * frame, from the loader's cache.
 */

private val LINK_URL = Regex("https?://[^\\p{Z}\\t\\n\\u000B\\f\\r\\uFEFF]+")
private val LINK_TRAILING_PUNCTUATION = Regex("[.,!?;:]+$")
private val LINK_TRAILING_CLOSERS = Regex("[)\\]}]+$")

private fun openerOf(closer: Char): Char = when (closer) {
    ')' -> '('
    ']' -> '['
    else -> '{'
}

/**
 * The first link in a message, the way web finds it (`firstUrlIn`): the first `http(s)://…`, minus
 * the sentence punctuation that trails it, and minus any closing bracket the link itself never
 * opened — `(see https://a.b/c)` previews `https://a.b/c`, `https://a.b/c_(x)` keeps its own `)`.
 */
fun firstLinkIn(text: String): String? {
    val found = LINK_URL.find(text)?.value ?: return null
    return found
        .replace(LINK_TRAILING_PUNCTUATION, "")
        .replace(LINK_TRAILING_CLOSERS) { ending -> ending.value.filter { closer -> found.contains(openerOf(closer)) } }
}

/**
 * The hero picture's box in the card, in pixels: [cardWidth] wide when that crops at most 15% of
 * the picture against the [maxHeight] ceiling (`object-fit: cover`), and past that the picture's own
 * proportions at [maxHeight] tall, centred on the card's tone — web's `--hero-fit` step, decided here
 * on every width instead of once. The height is the same on both sides of the step, so crossing it
 * never moves the text below.
 */
internal fun linkHeroSize(cardWidth: Float, ratio: Float, maxHeight: Float): Pair<Float, Float> {
    if (cardWidth <= 0f || ratio <= 0f || maxHeight <= 0f) return 0f to 0f
    val coversWithinLimit = cardWidth <= maxHeight * ratio / 0.85f
    val width = if (coversWithinLimit) cardWidth else min(cardWidth, maxHeight * ratio)
    val height = min(maxHeight, cardWidth / ratio)
    return width to height
}

/**
 * The card for [url] under a message, or nothing: no title, an unreachable page, previews switched
 * off in settings (`AppPreferences.linkPreviews`, read here, so the switch takes effect on every
 * bubble at once).
 *
 * [url] is `firstLinkIn(message text)`; [loader] is `controller.linkPreviews` — one per controller, so
 * nothing is built per bubble. The card fills the width it is given, like web's, and opens the link
 * on a tap; [onLongClick] and [onClickOverride] do for it what they do for `InlineImage` — the
 * bubble's long-press menu stays reachable, and a tap during a selection toggles the message instead
 * of opening the page.
 */
@Composable
fun LinkPreviewCard(
    url: String,
    loader: LinkPreviewLoader,
    modifier: Modifier = Modifier,
    onLongClick: () -> Unit = {},
    onClickOverride: (() -> Unit)? = null,
) {
    val enabled by AppPreferences.linkPreviews.collectAsState()
    if (enabled) {
        // `remember` keyed on the URL: a card never inherits the previous message's preview.
        var preview by remember(url, loader) { mutableStateOf(loader.cached(url)) }
        LaunchedEffect(url, loader) {
            if (preview != null) return@LaunchedEffect
            preview = try {
                loader.load(url)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
        }
        preview?.let { LinkCard(it, modifier, onLongClick, onClickOverride) }
    }
}

/** A percentage-width child must not make its auto-sized message wider. */
private object PreviewPercentWidth : LayoutModifier {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val child = measurable.measure(constraints)
        return layout(child.width, child.height) { child.placeRelative(0, 0) }
    }
    override fun IntrinsicMeasureScope.minIntrinsicWidth(measurable: IntrinsicMeasurable, height: Int) = 0
    override fun IntrinsicMeasureScope.maxIntrinsicWidth(measurable: IntrinsicMeasurable, height: Int) = 0
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LinkCard(
    preview: LinkPreview,
    modifier: Modifier,
    onLongClick: () -> Unit,
    onClickOverride: (() -> Unit)?,
) {
    val corners = LocalTailchatCorners.current
    val edge = LocalTailchatAccents.current.edge
    val scheme = MaterialTheme.colorScheme
    val uriHandler = LocalUriHandler.current
    val shape = RoundedCornerShape(corners.media)
    // One step of ink over whatever the bubble is — darker on a light theme, lighter on a dark one,
    // for own and peer bubbles alike (web's `--bubble-step`). The edge is `--edge`: transparent unless
    // «Обводки» is on, the same width either way.
    val tone = scheme.onSurface.copy(alpha = 0.07f)
    val open: () -> Unit = onClickOverride ?: { runCatching { uriHandler.openUri(preview.url) } }
    val bitmap = remember(preview) { preview.image?.asImageBitmap() }

    Column(
        modifier = modifier
            .then(PreviewPercentWidth)
            .fillMaxWidth()
            .padding(top = 4.dp)
            .clip(shape)
            .background(tone)
            .border(1.dp, edge, shape)
            .combinedClickable(
                onClickLabel = if (onClickOverride == null) stringResource(R.string.link_card_open) else null,
                onClick = open,
                onLongClick = onLongClick,
            ),
    ) {
        when {
            preview.layout == LinkPreviewLayout.Hero && bitmap != null -> {
                val ratio = preview.imageWidth.toFloat() / preview.imageHeight.coerceAtLeast(1)
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                    Image(
                        bitmap = bitmap,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.heroBox(ratio),
                    )
                    if (preview.video) {
                        Text(
                            stringResource(R.string.link_card_youtube),
                            color = Color.White,
                            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                            modifier = Modifier
                                .align(Alignment.TopStart)
                                .padding(8.dp)
                                .background(Color(0xDC121212), CircleShape)
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
                LinkBody(preview, showDescription = true, Modifier.padding(8.dp))
            }
            preview.layout == LinkPreviewLayout.Thumb && bitmap != null -> {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // A picture smaller than the square stays at its own size on the tone rather than
                    // being blown up into a blur (web's `--icon`, `object-fit: scale-down`).
                    val icon = minOf(preview.imageWidth, preview.imageHeight) < LINK_PREVIEW_THUMB_DP
                    Box(
                        modifier = Modifier
                            .size(LINK_PREVIEW_THUMB_DP.dp)
                            .clip(RoundedCornerShape(corners.media * 0.4f))
                            .background(tone),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            bitmap = bitmap,
                            contentDescription = null,
                            contentScale = if (icon) ContentScale.Inside else ContentScale.Crop,
                            modifier = Modifier.size(LINK_PREVIEW_THUMB_DP.dp),
                        )
                    }
                    // The description is for hero and text only: a thumbnail is a line or two of title.
                    LinkBody(preview, showDescription = false, Modifier.weight(1f))
                }
            }
            else -> LinkBody(preview, showDescription = true, Modifier.padding(8.dp))
        }
    }
}

/** Site (one line, muted), title (two lines), description (two lines): an empty field makes no row. */
@Composable
private fun LinkBody(preview: LinkPreview, showDescription: Boolean, modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        preview.siteName?.let { site ->
            Text(
                site.uppercase(),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp),
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            preview.title,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
            color = scheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (showDescription) {
            preview.description?.let { description ->
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The hero's box, sized from the card's own width on every layout pass ([linkHeroSize]). */
private fun Modifier.heroBox(ratio: Float): Modifier = layout { measurable, constraints ->
    val maxWidth = if (constraints.maxWidth == Constraints.Infinity) 0f else constraints.maxWidth.toFloat()
    val (width, height) = linkHeroSize(maxWidth, ratio, LINK_PREVIEW_HERO_MAX_HEIGHT_DP.dp.toPx())
    val placeable = measurable.measure(
        Constraints.fixed(width.roundToInt().coerceAtLeast(0), height.roundToInt().coerceAtLeast(0)),
    )
    layout(placeable.width, placeable.height) { placeable.place(0, 0) }
}
