package net.tailchat.android.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.icu.text.BreakIterator
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

internal data class EmojiEntry(val glyph: String, val terms: String, val image: String)
internal data class EmojiCategory(val id: String, val entries: List<EmojiEntry>)
internal class EmojiTable(val categories: List<EmojiCategory>) {
    val entries = categories.flatMap { it.entries }
    val byGlyph = entries.associateBy { it.glyph }
    private val unqualified = entries.filter { '\u200d' in it.glyph }.associateBy { it.glyph.replace("\uFE0F", "") }
    private val starts = java.util.BitSet(65536).apply {
        for (glyph in byGlyph.keys) set(glyph[0].code)
    }
    fun canStartEmoji(character: Char): Boolean = starts[character.code]
    fun entry(glyph: String): EmojiEntry? = byGlyph[glyph]
        ?: if ('\u200d' in glyph) unqualified[glyph.replace("\uFE0F", "")] else null
}

internal object EmojiCatalog {
    val table = MutableStateFlow<EmojiTable?>(null)
    private val loading = AtomicBoolean(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val images = object : LruCache<String, ImageBitmap>(2 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    fun load(context: Context) {
        if (!loading.compareAndSet(false, true)) return
        val app = context.applicationContext
        scope.launch {
            try {
                val json = app.assets.open("emoji/catalog.json").bufferedReader().use { JSONObject(it.readText()) }
                val groups = json.getJSONArray("categories")
                table.value = EmojiTable(List(groups.length()) { index ->
                    val group = groups.getJSONArray(index)
                    val rows = group.getJSONArray(1)
                    EmojiCategory(group.getString(0), List(rows.length()) { row ->
                        val item = rows.getJSONArray(row)
                        EmojiEntry(item.getString(0), " " + item.getString(1).lowercase(Locale.ROOT).replace('ё', 'е'), item.getString(2))
                    })
                })
            } catch (error: Exception) {
                loading.set(false)
                android.util.Log.e("TailchatEmoji", "Cannot load bundled emoji catalog", error)
            }
        }
    }
    fun cached(file: String): ImageBitmap? = images.get(file)
    fun image(context: Context, file: String): ImageBitmap = images.get(file) ?: context.assets.open("apple/64/$file").use {
        requireNotNull(BitmapFactory.decodeStream(it)).asImageBitmap().also { bitmap -> images.put(file, bitmap) }
    }
}

@Composable
internal fun emojiTable(): EmojiTable? {
    val context = LocalContext.current
    LaunchedEffect(context.applicationContext) { EmojiCatalog.load(context) }
    return EmojiCatalog.table.collectAsState().value
}

internal object EmojiChoices {
    val defaults = listOf("👍", "👎", "👌", "❤️", "🙏", "🔥", "🤝", "👋", "🆗", "✅", "👏", "💪", "😂", "😍", "😢", "🤔", "😊", "😇", "🥰", "😘", "😎", "🎉", "💯", "🙌", "🤗", "🤷", "👀", "☕", "✌️", "🤞", "🫡", "🙋")
    private val excluded = "🎃🖕🤬💩😈👿👹👺💀☠👻🧙🧛🧟🧞🧚🧝🧜🧌🔮🪄🧿🪬🧹🥠🔯⚰⚱🪦⚧⛎♈♉♊♋♌♍♎♏♐♑♒♓".codePoints().toArray().toSet()
    fun allowed(glyph: String): Boolean {
        val bare = glyph.replace("\uFE0F", "")
        return bare != "🏳‍🌈" && bare.codePoints().noneMatch { it in excluded || it in 0x1F3FB..0x1F3FF }
    }
    fun normalize(stored: List<String>, table: EmojiTable): List<String> {
        if (stored.size !in 1..defaults.size) return defaults
        val used = HashSet<String>()
        val result = stored.map { it.takeIf { glyph -> table.entry(glyph) != null && allowed(glyph) && used.add(glyph) } }.toMutableList()
        while (result.size < defaults.size) result.add(null)
        for (index in result.indices) if (result[index] == null) result[index] = defaults.first { it !in result }
        return result.filterNotNull()
    }
}

internal fun emojiSegments(text: String): List<IntRange> {
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT)
    iterator.setText(text)
    val ranges = ArrayList<IntRange>()
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
        ranges.add(start until end)
        start = end
        end = iterator.next()
    }
    return ranges
}

internal fun isJumboEmoji(text: String, table: EmojiTable?): Boolean {
    val trimmed = text.trim()
    if (table == null || trimmed.length !in 1..64 || !table.canStartEmoji(trimmed[0])) return false
    var count = 0
    for (range in emojiSegments(trimmed)) {
        val glyph = trimmed.substring(range)
        if (glyph.isBlank()) continue
        if (++count > 3 || table.entry(glyph) == null) return false
    }
    return count > 0
}

@Composable
internal fun AppleEmoji(glyph: String, modifier: Modifier = Modifier, size: TextUnit = 18.sp) {
    val table = emojiTable()
    val entry = table?.entry(glyph)
    val context = LocalContext.current
    var bitmap by remember(entry?.image) { mutableStateOf(entry?.let { EmojiCatalog.cached(it.image) }) }
    LaunchedEffect(entry?.image) {
        if (entry != null && bitmap == null) bitmap = withContext(Dispatchers.IO) { EmojiCatalog.image(context, entry.image) }
    }
    val image = bitmap
    if (image != null) Image(image, contentDescription = glyph, modifier = modifier)
    else Text(glyph, modifier = modifier, fontSize = size)
}

internal fun emojiVisuals(text: AnnotatedString, table: EmojiTable?): Pair<AnnotatedString, Map<String, String>> {
    if (table == null) return text to emptyMap()
    val value = text.text
    var cursor = value.indexOfFirst { table.canStartEmoji(it) }
    if (cursor < 0) return text to emptyMap()
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(value) }
    var body: AnnotatedString.Builder? = null
    var replacements: LinkedHashMap<String, String>? = null
    var copiedUntil = 0
    while (cursor < value.length) {
        if (!table.canStartEmoji(value[cursor])) { cursor++; continue }
        if (!iterator.isBoundary(cursor)) { cursor = iterator.following(cursor); continue }
        val end = iterator.following(cursor)
        val glyph = value.substring(cursor, end)
        if (table.entry(glyph) != null) {
            val output = body ?: AnnotatedString.Builder(value.length).also {
                body = it
                replacements = LinkedHashMap()
            }
            output.append(value, copiedUntil, cursor)
            val id = "emoji:$cursor"
            output.appendInlineContent(id, glyph)
            replacements!![id] = glyph
            copiedUntil = end
        }
        cursor = end
    }
    val output = body ?: return text to emptyMap()
    output.append(value, copiedUntil, value.length)
    // Alternate text is unchanged, so all original annotation offsets stay valid.
    for (span in text.spanStyles) output.addStyle(span.item, span.start, span.end)
    for (paragraph in text.paragraphStyles) output.addStyle(paragraph.item, paragraph.start, paragraph.end)
    for (annotation in text.getStringAnnotations(0, text.length))
        output.addStringAnnotation(annotation.tag, annotation.item, annotation.start, annotation.end)
    for (link in text.getLinkAnnotations(0, text.length)) when (val annotation = link.item) {
        is LinkAnnotation.Url -> output.addLink(annotation, link.start, link.end)
        is LinkAnnotation.Clickable -> output.addLink(annotation, link.start, link.end)
    }
    return output.toAnnotatedString() to replacements!!
}

/** Keeps original Unicode and link annotations; only the visual glyph is replaced. */
@Composable
internal fun EmojiText(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
    jumbo: Boolean = false,
    extraInline: Map<String, InlineTextContent> = emptyMap(),
) {
    val table = emojiTable()
    val rendered = remember(text, table) { emojiVisuals(text, table) }
    val inline = remember(rendered.second, jumbo, extraInline) {
        if (rendered.second.isEmpty()) extraInline else buildMap {
            putAll(extraInline)
            for ((id, glyph) in rendered.second) put(id, InlineTextContent(
                Placeholder(if (jumbo) 1.75.em else 1.05.em, if (jumbo) 1.75.em else 1.05.em, PlaceholderVerticalAlign.TextCenter),
            ) { AppleEmoji(glyph, Modifier.fillMaxSize()) })
        }
    }
    Text(rendered.first, modifier, color = color, style = style, maxLines = maxLines, overflow = overflow,
        inlineContent = inline)
}

@Composable
internal fun EmojiText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
    jumbo: Boolean = false,
) = EmojiText(remember(text) { AnnotatedString(text) }, modifier, style, color, maxLines, overflow, jumbo)
