package net.tailchat.android.ui

import android.icu.text.BreakIterator
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.roundToInt

internal data class DraftEmojiSpan(val start: Int, val end: Int, val image: String)

internal fun draftEmojiSpans(text: String, table: EmojiTable?): List<DraftEmojiSpan> {
    if (table == null) return emptyList()
    var cursor = text.indexOfFirst { table.canStartEmoji(it) }
    if (cursor < 0) return emptyList()
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }
    val spans = ArrayList<DraftEmojiSpan>()
    while (cursor < text.length) {
        if (!table.canStartEmoji(text[cursor])) { cursor++; continue }
        if (!iterator.isBoundary(cursor)) { cursor = iterator.following(cursor); continue }
        val end = iterator.following(cursor)
        table.entry(text.substring(cursor, end))?.let { spans.add(DraftEmojiSpan(cursor, end, it.image)) }
        cursor = end
    }
    return spans
}

/** Keep the actual Unicode, offsets, IME composition and accessibility text unchanged. */
internal class DraftEmojiTransformation(
    private val source: String,
    private val spans: List<DraftEmojiSpan>,
    private val size: TextUnit,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        if (spans.isEmpty() || text.text != source) return TransformedText(text, OffsetMapping.Identity)
        val styled = AnnotatedString.Builder(text)
        val hidden = SpanStyle(color = Color.Transparent, fontSize = size)
        for (span in spans) styled.addStyle(hidden, span.start, span.end)
        return TransformedText(styled.toAnnotatedString(), OffsetMapping.Identity)
    }
}

private data class DraftEmojiPaint(val bitmap: ImageBitmap, val offset: IntOffset, val size: IntSize)
private data class DraftPaint(val text: String, val items: List<DraftEmojiPaint>)
private val EmptyDraftPaint = DraftPaint("", emptyList())

private fun draftPaint(
    layout: TextLayoutResult,
    spans: List<DraftEmojiSpan>,
    images: Map<String, ImageBitmap>,
    side: Int,
): DraftPaint {
    val items = ArrayList<DraftEmojiPaint>(spans.size)
    for (span in spans) {
        val bitmap = images[span.image] ?: continue
        var left = Float.POSITIVE_INFINITY
        var top = Float.POSITIVE_INFINITY
        var right = Float.NEGATIVE_INFINITY
        var bottom = Float.NEGATIVE_INFINITY
        for (index in span.start until span.end) {
            val bounds = layout.getBoundingBox(index)
            left = minOf(left, bounds.left); top = minOf(top, bounds.top)
            right = maxOf(right, bounds.right); bottom = maxOf(bottom, bounds.bottom)
        }
        items.add(DraftEmojiPaint(bitmap,
            IntOffset((left + (right - left - side) / 2).roundToInt(), (top + (bottom - top - side) / 2).roundToInt()),
            IntSize(side, side)))
    }
    return DraftPaint(layout.layoutInput.text.text, items)
}

/**
 * The existing editable field, with only known emoji painted from the message assets.
 * The inner field is unbounded vertically; the surrounding scroll viewport owns scrolling,
 * so the PNG layer and text share an origin even in a long draft and during selection.
 */
@Composable
internal fun EmojiDraftField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
    textStyle: TextStyle = MaterialTheme.typography.bodyMedium,
    cursorBrush: Brush = SolidColor(MaterialTheme.colorScheme.primary),
    readOnly: Boolean = false,
    maxLines: Int = 5,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    decorationBox: @Composable (@Composable () -> Unit) -> Unit = { it() },
) {
    val table = emojiTable()
    val context = LocalContext.current.applicationContext
    val density = LocalDensity.current
    val candidates = remember(value.text, table) { draftEmojiSpans(value.text, table) }
    val files = remember(candidates) { candidates.map { it.image }.toSet() }
    var images by remember(files) {
        mutableStateOf(files.mapNotNull { file -> EmojiCatalog.cached(file)?.let { file to it } }.toMap())
    }
    LaunchedEffect(files) {
        if (images.size != files.size) images = withContext(Dispatchers.IO) {
            files.associateWith { EmojiCatalog.image(context, it) }
        }
    }
    val spans = remember(candidates, images) { candidates.filter { it.image in images } }
    val fontSize = textStyle.fontSize.takeUnless { it == TextUnit.Unspecified } ?: 16.sp
    val emojiSize = fontSize * 1.05f
    val side = with(density) { emojiSize.toPx().roundToInt().coerceAtLeast(1) }
    val lineHeight = textStyle.lineHeight.takeUnless { it == TextUnit.Unspecified } ?: (fontSize * 1.5f)
    val viewport = with(density) { lineHeight.toDp() } * maxLines
    val transformation = remember(value.text, spans, emojiSize) { DraftEmojiTransformation(value.text, spans, emojiSize) }
    var paint by remember { mutableStateOf(EmptyDraftPaint) }
    val scroll = rememberScrollState()
    var lastLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val viewportPixels = with(density) { viewport.roundToPx() }
    LaunchedEffect(lastLayout, value.text, value.selection, viewportPixels) {
        val layout = lastLayout?.takeIf { it.layoutInput.text.text == value.text } ?: return@LaunchedEffect
        val cursor = layout.getCursorRect(value.selection.end.coerceIn(0, value.text.length))
        val target = when {
            cursor.top < scroll.value -> cursor.top.roundToInt()
            cursor.bottom > scroll.value + viewportPixels -> cursor.bottom.roundToInt() - viewportPixels
            else -> return@LaunchedEffect
        }
        scroll.scrollTo(target)
    }
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        textStyle = textStyle,
        cursorBrush = cursorBrush,
        readOnly = readOnly,
        maxLines = Int.MAX_VALUE,
        keyboardOptions = keyboardOptions,
        visualTransformation = transformation,
        onTextLayout = { layout ->
            lastLayout = layout
            paint = if (spans.isNotEmpty() && layout.layoutInput.text.text == value.text) draftPaint(layout, spans, images, side)
                else EmptyDraftPaint
        },
        decorationBox = { inner ->
            decorationBox {
                Box(Modifier.heightIn(max = viewport).verticalScroll(scroll)) {
                    Box(Modifier.drawWithContent {
                        drawContent()
                        if (paint.text == value.text) for (item in paint.items)
                            drawImage(item.bitmap, dstOffset = item.offset, dstSize = item.size)
                    }) { inner() }
                }
            }
        },
    )
}

@Composable
internal fun EmojiDraftField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    textStyle: TextStyle = MaterialTheme.typography.bodyMedium,
    cursorBrush: Brush = SolidColor(MaterialTheme.colorScheme.primary),
    readOnly: Boolean = false,
    maxLines: Int = 5,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    decorationBox: @Composable (@Composable () -> Unit) -> Unit = { it() },
) {
    var editing by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    val displayed = if (editing.text == value) editing else TextFieldValue(value, TextRange(value.length))
    EmojiDraftField(displayed, { next ->
        editing = next
        if (next.text != value) onValueChange(next.text)
    }, modifier, textStyle, cursorBrush, readOnly, maxLines, keyboardOptions, decorationBox)
}
