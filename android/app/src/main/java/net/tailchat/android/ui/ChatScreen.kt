package net.tailchat.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import net.tailchat.android.R
import net.tailchat.android.ChatController
import net.tailchat.android.ChatState
import net.tailchat.android.Entry
import net.tailchat.android.Link
import net.tailchat.android.Receipt
import net.tailchat.android.cloud.CloudController
import net.tailchat.android.cloud.CloudDelivery
// Aliased: `Icons.Filled.Settings` is imported above under the bare name.
import net.tailchat.android.Settings as StoredSettings
import net.tailchat.android.Transfer
import net.tailchat.android.openDownloadsFolder

private val clock = SimpleDateFormat("HH:mm", Locale.getDefault())

private fun stamp(ts: Long): String = clock.format(Date(ts))

private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
    else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
}

/** Preserve the P2P ladder: Sent and Acked both remain a single mark. */
private fun receiptDelivery(receipt: Receipt): CloudDelivery = when (receipt) {
    Receipt.Queued -> CloudDelivery.Queued
    Receipt.Sent, Receipt.Acked -> CloudDelivery.Accepted
    Receipt.Read -> CloudDelivery.Read
    Receipt.Failed -> CloudDelivery.Failed
}

private fun peerLabel(state: ChatState): String =
    state.peerName ?: state.peerHost.ifBlank { "no peer set" }

private fun statusLine(state: ChatState): String {
    val base = when (state.link) {
        Link.Online -> {
            val where = state.remoteAddress ?: "connected"
            val presence = state.peerPresence?.trim()?.lowercase(Locale.US)?.takeIf { it.isNotEmpty() }
            if (presence != null) "$where · $presence" else where
        }
        Link.Reaching -> "connecting…"
        Link.Offline -> when {
            !state.tailscaleUp -> "tailscale is down"
            state.peerHost.isNotBlank() -> "waiting for ${state.peerHost}"
            else -> "no peer yet"
        }
    }
    return if (state.queued > 0) "$base · queued ${state.queued}" else base
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    controller: ChatController,
    cloudController: CloudController,
    onPickFile: () -> Unit,
    onCloud: () -> Unit,
) {
    val state by controller.state.collectAsState()
    val context = LocalContext.current
    val settings = remember { StoredSettings(context) }
    var showSettings by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val listState = rememberLazyListState()

    LaunchedEffect(state.entries.size) {
        if (state.entries.isNotEmpty()) listState.animateScrollToItem(state.entries.lastIndex)
    }

    Scaffold(
        modifier = Modifier.imePadding(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            ChatHeader(
                state = state,
                onAttach = onPickFile,
                onCloud = onCloud,
                onWake = { controller.wake() },
                onSettings = { showSettings = true },
            )
        },
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets),
        ) {
            LazyColumn(
                state = listState,
                reverseLayout = false,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(state.entries, key = { it.key }) { entry ->
                    when (entry) {
                        is Entry.Msg -> MessageBubble(entry)
                        is Entry.Note -> NoteLine(entry)
                        is Entry.FileEntry -> FileBubble(entry)
                    }
                }
            }
            TypingLine(state)
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (state.configured) {
                Composer(controller)
            } else {
                NoPeerCard(onSettings = { showSettings = true })
            }
        }
    }

    if (showSettings) {
        // Read the stored values once per opening: the fields below own their text
        // from then on, and `save` writes the whole set back through the service.
        val initialName = remember { settings.displayName }
        val initialPeer = remember { settings.peerHost }
        val initialPeerPort = remember { settings.peerPort }
        val initialListenPort = remember { settings.listenPort }
        val initialKeep = remember { settings.keepTranscript }
        ModalBottomSheet(
            onDismissRequest = { showSettings = false },
            sheetState = sheetState,
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            SettingsSheet(
                controller = controller,
                cloudController = cloudController,
                state = state,
                initialName = initialName,
                initialPeer = initialPeer,
                initialPeerPort = initialPeerPort,
                initialListenPort = initialListenPort,
                initialKeepTranscript = initialKeep,
                onDismiss = { showSettings = false },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatHeader(
    state: ChatState,
    onAttach: () -> Unit,
    onWake: () -> Unit,
    onCloud: () -> Unit,
    onSettings: () -> Unit,
) {
    Column {
        TopAppBar(
            title = {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .background(
                                    color = when (state.link) {
                                        Link.Online -> MaterialTheme.colorScheme.primary
                                        Link.Reaching -> MaterialTheme.colorScheme.secondary
                                        Link.Offline -> LocalTailchatAccents.current.line
                                    },
                                    shape = CircleShape,
                                ),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = peerLabel(state),
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        text = statusLine(state),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            },
            actions = {
                IconButton(onClick = onCloud) {
                    Icon(Icons.Filled.Cloud, contentDescription = stringResource(R.string.cloud_open))
                }
                IconButton(onClick = onAttach) {
                    Icon(Icons.Filled.AttachFile, contentDescription = "send a file")
                }
                IconButton(onClick = onWake) {
                    Icon(Icons.Filled.NotificationsActive, contentDescription = "wake the peer")
                }
                IconButton(onClick = onSettings) {
                    Icon(Icons.Filled.Settings, contentDescription = "settings")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
                titleContentColor = MaterialTheme.colorScheme.onSurface,
                actionIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            ),
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

@Composable
private fun MessageBubble(msg: Entry.Msg) {
    val accents = LocalTailchatAccents.current
    val depth = LocalTailchatDepth.current
    val shape = if (msg.mine) {
        RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp)
    } else {
        RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp)
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (msg.mine) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .tailchatSurface(
                    shape = shape,
                    fill = if (msg.mine) accents.ownBubble else MaterialTheme.colorScheme.surfaceVariant,
                    elevation = depth.bubble,
                    lights = listOf(depth.sheenBrush()),
                ),
            shape = shape,
            color = Color.Transparent,
            contentColor = MaterialTheme.colorScheme.onSurface,
            border = if (accents.outlines) {
                BorderStroke(1.dp, if (msg.mine) accents.ownBubbleBorder else MaterialTheme.colorScheme.outline)
            } else {
                null
            },
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                if (!msg.mine && msg.author.isNotBlank()) {
                    Text(
                        text = msg.author,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    Spacer(Modifier.height(2.dp))
                }
                EmojiText(text = msg.text, style = MaterialTheme.typography.bodyMedium, jumbo = isJumboEmoji(msg.text, emojiTable()))
                Spacer(Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stamp(msg.ts),
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalContentColor.current.copy(alpha = 0.55f),
                    )
                    if (msg.mine) {
                        Spacer(Modifier.width(6.dp))
                        CloudReceiptMark(
                            delivery = receiptDelivery(msg.receipt),
                            color = when (msg.receipt) {
                                Receipt.Read -> MaterialTheme.colorScheme.primary
                                Receipt.Failed -> MaterialTheme.colorScheme.error
                                else -> LocalContentColor.current.copy(alpha = 0.55f)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NoteLine(note: Entry.Note) {
    if (note.monospace) {
        // Logos and other ASCII art: never reflow, let the row scroll sideways.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
        ) {
            Text(
                text = note.text,
                softWrap = false,
                style = MaterialTheme.typography.bodySmall,
                fontSize = 9.sp,
                lineHeight = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    } else {
        Text(
            text = note.text,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 2.dp),
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun FileBubble(file: Entry.FileEntry) {
    val context = LocalContext.current
    // A received file that landed is the one thing here with somewhere to go:
    // tapping it opens the Downloads view where it actually is.
    val landed = !file.mine && file.transfer is Transfer.Complete
    val accents = LocalTailchatAccents.current
    val depth = LocalTailchatDepth.current
    val shape = RoundedCornerShape(18.dp)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (file.mine) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .tailchatSurface(
                    shape = shape,
                    fill = if (file.mine) accents.ownBubble else MaterialTheme.colorScheme.surfaceVariant,
                    elevation = depth.bubble,
                    lights = listOf(depth.sheenBrush()),
                )
                .then(
                    if (landed) Modifier.clickable { openDownloadsFolder(context) } else Modifier,
                ),
            shape = shape,
            color = Color.Transparent,
            contentColor = MaterialTheme.colorScheme.onSurface,
            border = if (accents.outlines) {
                BorderStroke(1.dp, if (file.mine) accents.ownBubbleBorder else MaterialTheme.colorScheme.outline)
            } else {
                null
            },
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.InsertDriveFile,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = LocalContentColor.current.copy(alpha = 0.7f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = file.name,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = formatBytes(file.size),
                            style = MaterialTheme.typography.labelSmall,
                            color = LocalContentColor.current.copy(alpha = 0.55f),
                        )
                    }
                }
                Spacer(Modifier.height(6.dp))
                when (val transfer = file.transfer) {
                    is Transfer.Progress -> {
                        val fraction = if (transfer.total > 0L) {
                            (transfer.done.toDouble() / transfer.total.toDouble())
                                .toFloat()
                                .coerceIn(0f, 1f)
                        } else {
                            0f
                        }
                        LinearProgressIndicator(
                            progress = { fraction },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(3.dp),
                            color = MaterialTheme.colorScheme.primary,
                            trackColor = LocalTailchatAccents.current.line,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "${formatBytes(transfer.done)} / ${formatBytes(transfer.total)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = LocalContentColor.current.copy(alpha = 0.7f),
                        )
                    }
                    is Transfer.Complete -> Text(
                        text = transfer.location ?: "saved",
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalContentColor.current.copy(alpha = 0.7f),
                    )
                    is Transfer.Failed -> Text(
                        text = transfer.reason,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    text = stamp(file.ts),
                    style = MaterialTheme.typography.labelSmall,
                    color = LocalContentColor.current.copy(alpha = 0.55f),
                )
            }
        }
    }
}

/** Reserves its height whether or not the peer is typing, so nothing jumps. */
@Composable
private fun TypingLine(state: ChatState) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(16.dp)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (state.peerTyping) {
            Text(
                text = "${state.peerName ?: state.peerHost.ifBlank { "peer" }} is typing…",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun Composer(controller: ChatController) {
    var draft by remember { mutableStateOf("") }
    var focused by remember { mutableStateOf(false) }
    val ready = draft.isNotBlank()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        EmojiDraftField(
            value = draft,
            onValueChange = {
                draft = it
                controller.keystroke()
            },
            modifier = Modifier.weight(1f).onFocusChanged { focused = it.isFocused },
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
            maxLines = 6,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            decorationBox = { field ->
                val shape = RoundedCornerShape(22.dp)
                Box(Modifier.fillMaxWidth().heightIn(min = 56.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, shape)
                    .border(if (focused) 2.dp else 1.dp,
                        if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, shape)
                    .padding(horizontal = 16.dp, vertical = 16.dp)) {
                    if (draft.isEmpty()) Text("message", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    field()
                }
            },
        )
        Spacer(Modifier.width(6.dp))
        IconButton(
            onClick = {
                controller.send(draft.trim())
                draft = ""
                controller.stopTyping()
            },
            enabled = ready,
            modifier = Modifier.padding(bottom = 4.dp),
            colors = IconButtonDefaults.iconButtonColors(
                contentColor = MaterialTheme.colorScheme.primary,
            ),
        ) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "send")
        }
    }
}

@Composable
private fun NoPeerCard(onSettings: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = "no peer yet", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(6.dp))
            Text(
                text = "Point tailchat at a machine on your tailnet — a MagicDNS name or a 100.x address — and messages start flowing.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(12.dp))
            Button(onClick = onSettings) { Text("set a peer") }
        }
    }
}
