package net.tailchat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.HoverInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringArrayResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import net.tailchat.android.R
import java.util.Locale

private val categoryGlyphs = listOf("🕘", "😀", "👋", "🐻", "🍔", "⚽", "🚗", "💡", "🔣", "🏁")
private data class PickerCell(val category: Int, val glyph: String? = null)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun EmojiPickerSheet(onPick: (String) -> Unit, onClose: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onClose, containerColor = LocalTailchatAccents.current.glassSheet,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        EmojiPickerPanel(onPick, onClose)
        Spacer(Modifier.navigationBarsPadding())
    }
}

@Composable
internal fun EmojiPickerPanel(onPick: (String) -> Unit, onClose: () -> Unit) {
    val table = emojiTable()
    val prefs = EmojiPreferences.get(LocalContext.current)
    val revision by prefs.revision.collectAsState()
    val labels = stringArrayResource(R.array.emoji_categories)
    var query by remember { mutableStateOf("") }
    val categories = remember(table) {
        table?.categories?.map { group -> group.entries.filter { EmojiChoices.allowed(it.glyph) } }.orEmpty()
    }
    val groups = remember(table, revision, categories) {
        if (table == null) emptyList() else listOf(prefs.recent(table).mapNotNull { table.entry(it) }) + categories
    }
    val cells = remember(groups, query) {
        val terms = query.lowercase(Locale.ROOT).replace('ё', 'е').split(Regex("\\s+")).filter { it.isNotBlank() }.map { " $it" }
        buildList {
            groups.forEachIndexed { category, entries ->
                if (terms.isNotEmpty() && category == 0) return@forEachIndexed
                val visible = entries.filter { item -> item.glyph == query.trim() || terms.all { term -> item.terms.contains(term) } }
                if (visible.isNotEmpty()) {
                    if (terms.isEmpty()) add(PickerCell(category))
                    visible.forEach { add(PickerCell(category, it.glyph)) }
                }
            }
        }
    }
    val state = rememberLazyGridState()
    var requestedCategory by remember { mutableStateOf<Int?>(null) }
    var previousQuery by remember { mutableStateOf(query) }
    LaunchedEffect(cells, requestedCategory, query) {
        val category = requestedCategory
        when {
            category != null -> {
                state.scrollToItem(cells.indexOfFirst { it.category == category }.coerceAtLeast(0))
                requestedCategory = null
            }
            previousQuery != query -> state.scrollToItem(0)
        }
        previousQuery = query
    }
    val active by remember(cells, state) { derivedStateOf { cells.getOrNull(state.firstVisibleItemIndex)?.category ?: 0 } }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp).onPreviewKeyEvent {
        if (it.type == KeyEventType.KeyDown && it.key == Key.Escape) { onClose(); true } else false
    }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
                placeholder = { Text(stringResource(R.string.emoji_search)) },
                colors = tailchatFieldColors(),
                modifier = Modifier.weight(1f), textStyle = MaterialTheme.typography.bodyMedium)
            IconButton(onClick = onClose) { Icon(Icons.Filled.Close, stringResource(R.string.cloud_emoji_close)) }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 4.dp)) {
            categoryGlyphs.forEachIndexed { index, glyph ->
                if (groups.getOrNull(index).isNullOrEmpty()) return@forEachIndexed
                Box(Modifier.size(36.dp).background(if (active == index) MaterialTheme.colorScheme.primaryContainer else Color.Transparent, CircleShape)
                    .semantics { contentDescription = labels[index] }
                    .clickable {
                        query = ""
                        requestedCategory = index
                    }, contentAlignment = Alignment.Center) { AppleEmoji(glyph, Modifier.size(18.dp)) }
            }
        }
        when {
            table == null -> Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            cells.isEmpty() -> Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { Text(stringResource(R.string.emoji_nothing)) }
            else -> LazyVerticalGrid(columns = GridCells.Adaptive(32.dp), state = state,
                modifier = Modifier.fillMaxWidth().height(240.dp), contentPadding = PaddingValues(bottom = 8.dp)) {
                items(cells.size, key = { index -> "${cells[index].category}:${cells[index].glyph ?: "header"}" },
                    span = { index -> GridItemSpan(if (cells[index].glyph == null) maxLineSpan else 1) }) { index ->
                    val cell = cells[index]
                    val glyph = cell.glyph
                    if (glyph == null) Text(labels[cell.category], style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(vertical = 6.dp, horizontal = 4.dp))
                    else Box(Modifier.size(32.dp).clickable {
                        prefs.remember(glyph, table)
                        onPick(glyph)
                    }, contentAlignment = Alignment.Center) { AppleEmoji(glyph, Modifier.size(18.dp)) }
                }
            }
        }
    }
}

/** The same 32 slots as quick reactions; choosing an occupied glyph swaps slots. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun QuickReactionSettings() {
    val table = emojiTable() ?: return
    val prefs = EmojiPreferences.get(LocalContext.current)
    val revision by prefs.revision.collectAsState()
    var slot by remember { mutableStateOf<Int?>(null) }
    val quick = remember(table, revision) { prefs.quick(table) }
    Text(stringResource(R.string.emoji_quick_settings), style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
    FlowRow(Modifier.widthIn(max = 320.dp).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        quick.forEachIndexed { index, glyph ->
            val description = stringResource(R.string.emoji_quick_slot, index + 1, glyph)
            Box(Modifier.size(28.dp).background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.small)
                .semantics { contentDescription = description; role = Role.Button }.clickable { slot = index },
                contentAlignment = Alignment.Center) { AppleEmoji(glyph, Modifier.size(17.dp)) }
        }
    }
    slot?.let { selected -> EmojiPickerSheet(onPick = { prefs.setQuick(selected, it, table); slot = null }, onClose = { slot = null }) }
}

/** Separate from the action menu: a single compact column, never two rows. */
@Composable
internal fun QuickReactionPopup(
    expanded: Boolean,
    selfLogin: String,
    reactions: Map<String, List<String>>,
    onReact: (String, Boolean) -> Unit,
    onDismiss: () -> Unit,
    collapsed: Boolean = false,
    onExpand: () -> Unit = {},
    own: Boolean = false,
) {
    if (!expanded) return
    val table = emojiTable() ?: return
    val prefs = EmojiPreferences.get(LocalContext.current)
    val revision by prefs.revision.collectAsState()
    val quick = remember(table, revision) { prefs.quick(table) }
    var fullPicker by remember { mutableStateOf(false) }
    val hoverSource = remember { MutableInteractionSource() }
    val expand by rememberUpdatedState(onExpand)
    val dismiss by rememberUpdatedState(onDismiss)
    LaunchedEffect(hoverSource) {
        hoverSource.interactions.collect {
            when (it) {
                is HoverInteraction.Enter -> expand()
                is HoverInteraction.Exit -> if (!fullPicker) dismiss()
            }
        }
    }
    val moreLabel = stringResource(R.string.emoji_more)
    val gap = with(LocalDensity.current) { 4.dp.roundToPx() }
    val placement = remember(own, gap) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: androidx.compose.ui.unit.IntRect,
                windowSize: androidx.compose.ui.unit.IntSize, layoutDirection: androidx.compose.ui.unit.LayoutDirection,
                popupContentSize: androidx.compose.ui.unit.IntSize): IntOffset {
                val beside = if (own) anchorBounds.left - popupContentSize.width - gap else anchorBounds.right + gap
                return IntOffset(beside.coerceIn(gap, (windowSize.width - popupContentSize.width - gap).coerceAtLeast(gap)),
                    anchorBounds.top.coerceIn(gap, (windowSize.height - popupContentSize.height - gap).coerceAtLeast(gap)))
            }
        }
    }
    if (fullPicker) {
        EmojiPickerSheet(onPick = { glyph -> onReact(glyph, selfLogin !in reactions[glyph].orEmpty()); onDismiss() }, onClose = onDismiss)
    } else Popup(popupPositionProvider = placement, onDismissRequest = onDismiss, properties = PopupProperties(focusable = !collapsed)) {
        Surface(shape = MaterialTheme.shapes.small, shadowElevation = if (collapsed) 0.dp else LocalTailchatDepth.current.popup,
            color = MaterialTheme.colorScheme.surfaceVariant, border = androidx.compose.foundation.BorderStroke(1.dp, LocalTailchatAccents.current.glassLine)) {
            LazyColumn(Modifier.width(if (collapsed) 17.dp else 34.dp).heightIn(max = if (collapsed) 17.dp else 132.dp)
                .hoverable(hoverSource),
                contentPadding = PaddingValues(if (collapsed) 1.dp else 2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                items(if (collapsed) quick.take(1) else quick, key = { it }) { glyph ->
                    val description = stringResource(R.string.cloud_a11y_reaction, glyph, reactions[glyph].orEmpty().size)
                    Box(Modifier.size(if (collapsed) 14.dp else 28.dp).background(if (selfLogin in reactions[glyph].orEmpty()) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.small)
                        .semantics { contentDescription = description; role = Role.Button }
                        .clickable { prefs.remember(glyph, table); onReact(glyph, selfLogin !in reactions[glyph].orEmpty()); onDismiss() },
                        contentAlignment = Alignment.Center) { AppleEmoji(glyph, Modifier.size(if (collapsed) 8.dp else 17.dp)) }
                }
                if (!collapsed) item { Box(Modifier.size(28.dp).semantics { contentDescription = moreLabel; role = Role.Button }.clickable { fullPicker = true },
                    contentAlignment = Alignment.Center) { Text("+") } }
            }
        }
    }
}

