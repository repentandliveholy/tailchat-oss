package net.tailchat.android.ui

import android.Manifest
import android.content.Context
import android.net.Uri
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallMissed
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.AlarmAdd
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MarkChatUnread
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Image as ImageIcon
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.compose.LifecycleEventEffect
import net.tailchat.android.AppPermissions
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.positionInWindow
import kotlinx.coroutines.flow.first
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Calendar
import java.util.Locale
import net.tailchat.android.R
import net.tailchat.android.Transfer
import net.tailchat.android.AppPreferences
import net.tailchat.android.data.CallOutcome
import net.tailchat.android.cloud.AppUpdateInfo
import net.tailchat.android.cloud.CloudBotAction
import net.tailchat.android.cloud.CloudAttachment
import net.tailchat.android.cloud.CloudCall
import net.tailchat.android.cloud.CloudCommand
import net.tailchat.android.cloud.CloudController
import net.tailchat.android.cloud.CloudDraft
import net.tailchat.android.cloud.CloudFailedOperation
import net.tailchat.android.cloud.CloudFailure
import net.tailchat.android.cloud.CloudDelivery
import net.tailchat.android.cloud.CloudLink
import net.tailchat.android.cloud.CloudMessage
import net.tailchat.android.cloud.CloudPreview
import net.tailchat.android.cloud.CloudState
import net.tailchat.android.cloud.CloudUser
import net.tailchat.android.cloud.CloudVoice
import net.tailchat.android.cloud.SERVICE_ACCOUNT_LOGIN
import net.tailchat.android.cloud.VOICE_MAX_SEC
import net.tailchat.android.cloud.displayName
import net.tailchat.android.cloud.presenceDot
import net.tailchat.android.openDownloadsFolder
import net.tailchat.android.createCameraCaptureUri
import net.tailchat.proto.formatBytes
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import net.tailchat.android.cloud.cloudCommandMatches
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MenuDefaults
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.graphics.vector.ImageVector
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import net.tailchat.android.cloud.CloudReply
import net.tailchat.android.cloud.VoiceFailureReason
import net.tailchat.android.cloud.VoicePlaybackController
import net.tailchat.android.cloud.VoicePlaybackState
import net.tailchat.android.cloud.VoiceWaveformCache
import net.tailchat.android.cloud.VoiceWaveformDecoder
import net.tailchat.android.cloud.VoiceWaveformMath
import net.tailchat.android.cloud.messageIdOrNull
import net.tailchat.android.Settings
import net.tailchat.android.VOICE_PLAYBACK_SPEEDS
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.StartOffset
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.abs
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.style.TextAlign
import net.tailchat.android.ChatWallpaper

private val cloudClock = SimpleDateFormat("HH:mm", Locale.getDefault())
private val cloudDay = SimpleDateFormat("d MMMM", Locale.getDefault())

internal enum class RosterGestureDecision { Pending, Vertical, Horizontal }

internal fun rosterGestureDecision(
    totalX: Float,
    totalY: Float,
    verticalRelease: Float,
    horizontalLock: Float,
    horizontalDominance: Float,
): RosterGestureDecision {
    if (abs(totalY) >= verticalRelease && abs(totalX) < abs(totalY) * horizontalDominance) {
        return RosterGestureDecision.Vertical
    }
    if (abs(totalX) >= horizontalLock && abs(totalX) >= abs(totalY) * horizontalDominance) {
        return RosterGestureDecision.Horizontal
    }
    return RosterGestureDecision.Pending
}

/** Carries the one [VoicePlaybackController] an open conversation owns, plus
 *  the media resolver every bubble needs (see `CloudController.resolveMedia`)
 *  and the account/peer identity `VoiceWaveformCache` keys derived peaks
 *  under — provided once by `CloudConversation`, read by every `VoicePlayer`
 *  bubble in its transcript. Absent (null) outside a conversation screen. */
private data class VoicePlaybackContext(
    val controller: VoicePlaybackController,
    val resolveMedia: (String) -> String?,
    val accountKey: String,
    val peer: String,
)

private val LocalVoicePlayback = staticCompositionLocalOf<VoicePlaybackContext?> { null }

/** The sender label the terminal transcript and the web client both use —
 *  `{name}` (src/ui.js's `whoMarkup`, web/cloud/app.js's `bracketName`). The
 *  braces are the protocol's own handwriting, so they are here too rather than
 *  a bare name that reads like every other chat app. */
private fun braced(name: String): String = "{$name}"

private fun sameDay(a: Long, b: Long): Boolean {
    val first = java.util.Calendar.getInstance().apply { timeInMillis = a }
    val second = java.util.Calendar.getInstance().apply { timeInMillis = b }
    return first.get(java.util.Calendar.YEAR) == second.get(java.util.Calendar.YEAR) &&
        first.get(java.util.Calendar.DAY_OF_YEAR) == second.get(java.util.Calendar.DAY_OF_YEAR)
}

/**
 * The four texts one roster stamp can be made of, already formatted and
 * already in the user's language — see [rosterTimeLabel], which decides which
 * of them the row gets.
 */
internal data class RosterStamp(
    val time: String,
    val weekday: String,
    val date: String,
    val yesterday: String,
)

/**
 * The roster's right-hand stamp, which is a *distance* rather than a clock: a
 * conversation last touched three weeks ago has no useful time of day to show,
 * and the row it sits on is one line beside a name. So it walks one ladder —
 * the clock today, «вчера», the weekday while that is still a day somebody
 * remembers, then a short date, with the year only once it is a different one.
 *
 * Pure on purpose: [daysAgo] and [sameYear] are the calendar facts
 * [calendarDaysBetween] and the caller's own zone measured, and the four
 * strings are already formatted. That leaves the ladder itself testable
 * without Compose, a device locale or a clock.
 */
internal fun rosterTimeLabel(daysAgo: Int, sameYear: Boolean, yearSuffix: String, stamp: RosterStamp): String = when {
    // Today, or a timestamp from a device whose clock runs ahead: a distance
    // cannot be negative, and the clock is the honest answer either way.
    daysAgo <= 0 -> stamp.time
    daysAgo == 1 -> stamp.yesterday
    daysAgo < 7 -> stamp.weekday
    sameYear -> stamp.date
    else -> "${stamp.date} '$yearSuffix"
}

/**
 * Whole calendar days between the two local dates, not elapsed hours: a message
 * from 23:50 three days ago is three days ago at 00:30, even though barely
 * sixty hours have passed. Local dates rather than a millisecond division, so a
 * DST shift inside the span cannot turn two days into one.
 */
internal fun calendarDaysBetween(older: Long, newer: Long): Int {
    val zone = java.time.ZoneId.systemDefault()
    return java.time.temporal.ChronoUnit.DAYS.between(
        java.time.Instant.ofEpochMilli(older).atZone(zone).toLocalDate(),
        java.time.Instant.ofEpochMilli(newer).atZone(zone).toLocalDate(),
    ).toInt()
}

/**
 * `d MMM` or `MMM d`, whichever the locale itself would choose.
 *
 * `SimpleDateFormat` applies one pattern in every language, so the order
 * cannot be inferred from the locale the way `Intl.DateTimeFormat` infers it
 * for the web client (`{ day: 'numeric', month: 'short' }` → `28 февр.` in
 * Russian, `Feb 28` in English, `28 févr.` in French). This names the three
 * languages the app ships rather than guessing at the others: anything else
 * gets the day-first order, which is right for most of Europe and is the form
 * the owner asked for.
 */
private fun dayMonthPattern(locale: Locale): String = if (locale.language == "en") "MMM d" else "d MMM"

/**
 * The roster's two day formats for one locale, in the order [RosterStamp]
 * wants them: a short weekday (`пт`, `Fri`) and a short date (`28 февр.`,
 * `Feb 28`). `cloudDay` spells the month out — which a day divider can afford
 * and a roster row, one line beside a name, cannot.
 *
 * Split out from the composable for two reasons. The *pattern* is worth
 * pinning by a test: the owner asked for the short weekday and a short date,
 * and `EEEE`/`MMMM` would quietly undo both. And the *locale* has to come from
 * the composition rather than from `Locale.getDefault()`, for the reason
 * `AppLocale`'s own note gives — the in-app language switch never touches the
 * process-wide default (the transcript's date formatting is shared with the
 * server, and mutating it would leak everywhere), so a formatter captured at
 * class-load would print the *device* language beside an interface in the
 * chosen one. "HH:mm" hides that; `пт` versus `Fri` does not.
 */
internal fun dayFormats(locale: Locale): Pair<SimpleDateFormat, SimpleDateFormat> =
    SimpleDateFormat("EEE", locale) to SimpleDateFormat(dayMonthPattern(locale), locale)

@Composable
private fun rememberDayFormats(): Pair<SimpleDateFormat, SimpleDateFormat> {
    val locale = LocalConfiguration.current.locales[0]
    return remember(locale) { dayFormats(locale) }
}

/** The roster stamp for one message, in whichever language this device runs. */
@Composable
private fun rosterTimeLabel(ts: Long): String {
    val zone = java.time.ZoneId.systemDefault()
    val then = java.time.Instant.ofEpochMilli(ts).atZone(zone)
    val today = java.time.Instant.ofEpochMilli(System.currentTimeMillis()).atZone(zone)
    val (weekday, dayShort) = rememberDayFormats()
    return rosterTimeLabel(
        daysAgo = calendarDaysBetween(ts, System.currentTimeMillis()),
        sameYear = then.year == today.year,
        yearSuffix = (then.year % 100).toString().padStart(2, '0'),
        stamp = RosterStamp(
            time = cloudClock.format(Date(ts)),
            weekday = weekday.format(Date(ts)),
            date = dayShort.format(Date(ts)),
            yesterday = stringResource(R.string.cloud_day_yesterday),
        ),
    )
}

/**
 * Plan §4 acceptance: «Позднее восстановление старого черновика не
 * перезаписывает уже введённый текст» — a persisted draft only applies while
 * the composer is still exactly what it was mounted with. `currentReply`/
 * `currentEditing` are included because a swipe-to-reply or a tap on
 * «Изменить» that lands before the load resolves is exactly as real a user
 * action as a keystroke, and just as wrong to discard.
 */
internal fun shouldApplyLoadedDraft(currentText: String, currentReply: CloudReply?, currentEditing: CloudMessage?): Boolean =
    currentText.isEmpty() && currentReply == null && currentEditing == null

// Fixed, not theme-tinted: a status glyph carries meaning (is the channel
// healthy right now?), not the palette's taste — the same reasoning the
// terminal client's own status colours follow. It lives in the palette as
// `--amber` so each theme can pick its own legible in-between hue.
@Composable
private fun statusWarning(): Color = LocalTailchatAccents.current.warning

/**
 * The one bar shape every cloud screen uses: 46dp tall, a hairline underneath
 * plus the [TailchatDepth.bar] step, and a two-line title block. The hairline
 * stays — it is what tells the bar from the transcript at the seam — and the
 * shadow is what tells it from the transcript in the middle of a scroll, which
 * is exactly the read the owner asked for («объёмнее, как в WhatsApp»).
 * Material's own `TopAppBar` is 64dp before its insets, which on a 6" phone is
 * a tenth of the screen spent on a name that is already in the roster row you
 * tapped.
 */
@Composable
private fun CompactBar(
    title: String,
    subtitle: String? = null,
    subtitleColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    leading: (@Composable () -> Unit)? = null,
    /** Drawn instead of [title] — the roster hands the ASCII wordmark here. */
    titleContent: (@Composable () -> Unit)? = null,
    /** «При нажатии на username»: non-null only for a real peer's own
     *  conversation — opens the user-info sheet. `null` for the roster's
     *  wordmark and Saved Messages, where there is no other person to show
     *  info about. */
    onTitleClick: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Surface(color = Color.Transparent, contentColor = MaterialTheme.colorScheme.onSurface, modifier = Modifier.glassBar()) {
        Column(Modifier.statusBarsPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                leading?.invoke()
                Column(
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp).let { base ->
                        if (onTitleClick == null) base else base.clickable(
                            onClickLabel = stringResource(R.string.cloud_user_info_open),
                            onClick = onTitleClick,
                        )
                    },
                ) {
                    if (titleContent != null) titleContent() else Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (subtitle != null) Text(
                        subtitle,
                        style = MaterialTheme.typography.labelSmall,
                        color = subtitleColor,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                actions()
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

/** A 44dp icon button in a bar. Material's 48dp default puts four of them
 *  across half a bar. [raised] makes it web 1.128's round control — the
 *  conversation header's call and menu buttons are raised discs there
 *  (`.conversation-menu-button`, `.direct-toggle`); the back arrow stays a
 *  bare glyph, as web's «← Peers» link does. */
@Composable
private fun BarAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    size: Dp = 44.dp,
    raised: Boolean = false,
    onClick: () -> Unit,
) {
    if (raised) {
        Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            RaisedDisc(onClick = onClick, modifier = Modifier.size(size - 6.dp)) {
                Icon(icon, contentDescription = description, modifier = Modifier.size(size * 0.46f))
            }
        }
        return
    }
    IconButton(onClick = onClick, modifier = Modifier.size(size)) {
        Icon(icon, contentDescription = description, modifier = Modifier.size(size * 0.52f))
    }
}

/**
 * «Стекло» (web 1.128, «студия»): chrome over the room — the conversation
 * header, the roster's bars — as a translucent sheet of `surface` at 72% with
 * the top-down sheen, lifted one `--elev-2` step so it casts its shadow onto the
 * wallpaper under it. Translucency and not a backdrop blur: blurring what is
 * behind a node needs API 31 and this app runs from 29; over the soft ambient
 * light and the faint patterns the difference is a softer edge, not legibility.
 */
@Composable
private fun Modifier.glassBar(): Modifier {
    val accents = LocalTailchatAccents.current
    val depth = LocalTailchatDepth.current
    return tailchatSurface(RectangleShape, accents.glass, depth.bar, listOf(depth.sheenBrush()))
}

/**
 * Web 1.128's round control (`.attach-button`, `.conversation-menu-button`,
 * the rail buttons): a raised disc — `--sheen` over `--raised`, a hairline and
 * `--elev-1` — that sinks while pressed or disabled, which is web's `:active`
 * / `:disabled` dropping the shadow.
 */
@Composable
private fun RaisedDisc(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val depth = LocalTailchatDepth.current
    Box(
        modifier = modifier
            .tailchatSurface(
                shape = CircleShape,
                fill = MaterialTheme.colorScheme.surfaceVariant,
                elevation = if (pressed || !enabled) null else depth.card,
                lights = listOf(depth.sheenBrush()),
            )
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
            .clip(CircleShape)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurface) { content() }
    }
}

/**
 * One of the two equally-weighted, labelled actions in the roster's bottom
 * bar (`Scaffold.bottomBar` in [CloudRoster]) — an icon plus a word, sized to
 * the accessibility minimum touch target rather than the bar's own content
 * height, so it stays reachable at the largest font scale too.
 */
@Composable
private fun RosterBarButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = modifier.heightIn(min = 48.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A full touch target; the primary action is filled, secondary actions quiet.
 *  [onLongClick] is only non-null for the mic button — see its call site for
 *  why starting a recording needs a hold rather than a tap.
 *
 *  Web 1.128's volume: the quiet ones are raised discs ([RaisedDisc]'s
 *  paint), and the filled one is the one primary action — the accent lit from
 *  above (its top 10% lighter, so the glyph keeps its contrast across the
 *  gradient) glowing onto the dock (`--accent-glow`). Both sink while pressed;
 *  the send button is pressed *in* (`inset 0 2px 4px`), as web's `:active`. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ComposerAction(
    icon: ImageVector,
    description: String,
    imageGlyph: String? = null,
    filled: Boolean = false,
    /** «Кнопку красной»: the one visible sign, on the mic button itself,
     *  that a voice note is being captured — a red fill, fixed size (no
     *  pulsing grow/shrink — the user found that distracting), rather than
     *  swapping the button (or its row) for a differently sized one, which
     *  used to change the composer's height and shift the transcript above
     *  it on every press. */
    recording: Boolean = false,
    /** Disables the button (dimmed, unclickable) — the composer's own
     *  gating for a blocked contact: history stays visible, only sending is
     *  cut off. */
    enabled: Boolean = true,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val container = when {
        recording -> MaterialTheme.colorScheme.error
        filled -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val depth = LocalTailchatDepth.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val sunk = pressed || !enabled
    val lights = if (!depth.enabled) emptyList() else if (filled && !recording) {
        listOf(Brush.verticalGradient(listOf(lerp(container, Color.White, 0.10f), container)))
    } else {
        listOf(depth.sheenBrush())
    }
    val elevation = when {
        sunk || !depth.enabled -> null
        filled && !recording -> TailchatElevation(
            depth.card.edge,
            listOf(depth.accentGlow, TailchatShadow(1.dp, 2.dp, 0.dp, Color.Black.copy(alpha = 0.25f))),
        )
        else -> depth.card
    }
    Box(
        modifier = Modifier.size(44.dp).alpha(if (enabled) 1f else 0.4f)
            .tailchatSurface(CircleShape, container, elevation, lights)
            .border(1.dp, container.takeIf { recording || filled } ?: MaterialTheme.colorScheme.outline, CircleShape)
            .clip(CircleShape)
            .combinedClickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                enabled = enabled,
                onClickLabel = description,
                onLongClickLabel = description,
                role = Role.Button,
                onClick = onClick,
                onLongClick = onLongClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (imageGlyph != null) AppleEmoji(imageGlyph, Modifier.size(19.dp).semantics { contentDescription = description }) else Icon(
            icon,
            contentDescription = description,
            modifier = Modifier.size(19.dp),
            tint = when {
                recording -> MaterialTheme.colorScheme.onError
                filled -> MaterialTheme.colorScheme.onPrimary
                else -> MaterialTheme.colorScheme.onSurface
            },
        )
    }
}

/**
 * The wordmark reveals once per app entry: a cold launch, or a genuine
 * return from being minimized — never a same-process hop between the roster
 * and a conversation, and never a second time for the same entry no matter
 * how many times that hop happens before the sweep would have finished.
 *
 * [CloudUiViewModel.appStartSignal] is what tells the two apart: it only
 * moves on `MainActivity.onStart`, so [intro] is driven from [CloudScreen] —
 * which stays composed across every roster/conversation switch — rather than
 * from [CloudRoster] itself. The previous shape drove this from a `LaunchedEffect(Unit)`
 * inside `CloudRoster`, gated by a flag persisted to disk after a fixed
 * delay: leaving the roster before that delay elapsed (routine when hopping
 * between conversations) cancelled the effect before the flag was ever
 * written, so the next roster visit saw the reveal still "due" and replayed
 * it — indefinitely, once for every conversation closed quickly enough. */
private class LogoPlayback {
    var intro by mutableStateOf(false)
    var replay by mutableStateOf(0)
}

@Composable
fun CloudScreen(controller: CloudController, onP2P: () -> Unit, uiViewModel: CloudUiViewModel) {
    val state by controller.state.collectAsState()
    val logo = remember { LogoPlayback() }
    // Both app entry and an explicit replay have a finite playback window.
    // The replay counter is an event key, never a persistent animation flag:
    // treating replay > 0 as "animate" replayed every later roster mount.
    // This owner survives roster/conversation switches, so the timer does too.
    LaunchedEffect(uiViewModel.appStartSignal, logo.replay) {
        logo.intro = true
        delay(TAILCHAT_LOGO_SWEEP_MS)
        logo.intro = false
    }
    // The invite panel is the one surface with a link that can be copied and a
    // "Copy" button; the note `/invite create` leaves behind is a plain `Text`
    // (`SystemNoteRow`) with nothing to copy or tap. That command can only be
    // typed in a conversation's own composer, and `CloudRoster` — which used to
    // own the panel — is unmounted while a conversation is open, so the panel
    // lives here instead, where it survives every switch (the same reason the
    // logo above does), and opens over whatever is on screen the moment the code
    // arrives: `openInviteDialog()` in the web client, by another shape.
    //
    // Only a code that appears while the app is running counts. A code carried
    // over from local state at launch (`ServiceCloudController` restores
    // `inviteCode`) answers nothing the person just did, and must not pop the
    // dialog open by itself.
    var showInvite by remember { mutableStateOf(false) }
    var seenInviteCode by remember { mutableStateOf(state.inviteCode) }
    LaunchedEffect(state.inviteCode) {
        if (state.inviteCode != null && state.inviteCode != seenInviteCode) showInvite = true
        seenInviteCode = state.inviteCode
    }
    // Keep only the active screen alive. Crossfading two live screens doubled
    // layout work on navigation and let the outgoing screen observe the new peer.
    when {
        !state.signedIn -> CloudAuthScreen(controller, state, onP2P)
        state.selectedPeer != null -> key(state.selectedPeer) { CloudConversation(controller, state, uiViewModel) }
        else -> CloudRoster(controller, state, logo, onP2P, onOpenInvite = { showInvite = true })
    }
    // Signed out there is nothing to invite to: the code is cleared on logout, and
    // a panel left open across that switch would offer an action with no session.
    if (showInvite && state.signedIn) {
        CloudInviteDialog(controller, state) { showInvite = false }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloudRoster(
    controller: CloudController,
    state: CloudState,
    logo: LogoPlayback,
    onP2P: () -> Unit,
    onOpenInvite: () -> Unit,
) {
    val self = state.session?.user ?: return
    var showSettings by remember { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    // The contact whose deletion is waiting on the confirmation dialog. The
    // long-press menu only raises the question; nothing is sent until the
    // person answers it, because the call cannot be undone on either side.
    var removeTarget by remember { mutableStateOf<CloudUser?>(null) }
    var openSwipeLogin by remember { mutableStateOf<String?>(null) }
    val contacts = remember(state.users, self.login, searchQuery) {
        val query = searchQuery.trim().lowercase()
        state.users.filter { user ->
            user.login != self.login && (
                query.isEmpty()
                    || user.login.lowercase().contains(query)
                    || user.name.lowercase().contains(query)
                    || user.alias?.lowercase()?.contains(query) == true
            )
        }
    }
    val byRecentMessage = remember(contacts) {
        compareByDescending<CloudUser> { it.preview?.ts ?: 0L }
            .thenBy(String.CASE_INSENSITIVE_ORDER) { it.displayName().ifBlank { it.login } }
    }
    val sortedContacts = remember(contacts) {
        contacts.sortedWith(compareBy<CloudUser> { it.blocked }.then(byRecentMessage))
    }
    val totalContacts = state.users.count { it.login != self.login }
    // «N в сети» counts people. The deployment's own two accounts are always
    // online — they *are* the server, `usersFor` says so itself — and a bot's
    // daemon is up whenever its process is, so neither answers the question
    // the line asks. Both carry a flag from the server (`official`, `bot`,
    // the latter learned from the bot's own `hello`).
    val onlineCount = state.users.count {
        it.login != self.login && it.online && !it.blocked && !it.official && !it.bot
    }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val installGate = rememberInstallPermissionGate(controller)
    var dismissedInstall by remember { mutableStateOf(settings.installPermissionPromptDismissed) }
    var dismissedNotif by remember { mutableStateOf(settings.notificationPermissionPromptDismissed) }
    val inAppNotifications by AppPreferences.cloudNotifications.collectAsState()
    var notifRefresh by remember { mutableStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        notifRefresh++
    }
    val areNotifsEnabled = remember(notifRefresh) { AppPermissions.areNotificationsEnabled(context) }
    val depth = LocalTailchatDepth.current
    val accents = LocalTailchatAccents.current
    val paper = MaterialTheme.colorScheme.background

    Scaffold(
        // The ambient light (web 1.128 «студия»): the page with three soft
        // accent glows behind everything — the glass bars are tinted by it.
        modifier = Modifier.roomBackdrop(paper, accents, wallpaper = null),
        containerColor = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            // Full-width, not the compact bar's constrained title slot: with
            // the two actions moved to the bottom bar, the roster is the one
            // screen that can give the wordmark the whole line instead of
            // sharing it with buttons — self's own login sits under it, the
            // way the terminal client's own banner names the session.
            //
            // The band itself is transparent over the ambient light, and the
            // wordmark sits on its own glass plate — web 1.128's `.logo-art`
            // (owner: «сделай подложку под него»; moving the band was looked
            // at and declined, so it stays where it is): `--glass-strong`, the
            // glass line, `radius-l` (`shapes.large`), `--elev-1` and a green
            // glow. The plate wraps the wordmark, whose size is computed from
            // the width it gets, so plate and logo always scale together.
            Column(Modifier.fillMaxWidth().statusBarsPadding()) {
                    Surface(
                        shape = MaterialTheme.shapes.large,
                        color = Color.Transparent,
                        border = BorderStroke(1.dp, accents.glassLine),
                        modifier = Modifier.fillMaxWidth()
                            .padding(start = 12.dp, top = 10.dp, end = 12.dp, bottom = 6.dp)
                            .tailchatSurface(
                                shape = MaterialTheme.shapes.large,
                                fill = accents.glassStrong,
                                elevation = depth.card,
                                lights = listOf(depth.sheenBrush()),
                                extraShadows = listOf(TailchatShadow(0.dp, 24.dp, (-8).dp, accents.glow)),
                            ),
                    ) {
                        TailchatLogo(
                            animate = logo.intro,
                            replay = logo.replay,
                            modifier = Modifier.fillMaxWidth()
                                .padding(horizontal = 10.dp, vertical = 8.dp)
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClickLabel = null,
                                ) { logo.replay++ },
                        )
                    }
                    Row(
                        // 6dp above and below the pill — the same distance
                        // twice, and less of it than the line carried before
                        // (owner: «расстояние выше и ниже @username online
                        // уменьшить»): the logo card ends 6dp above it and the
                        // header's divider sits 6dp under it, where the old
                        // arrangement gave the text itself 10dp of margin on
                        // each side and then threw in whatever the lamp's own
                        // 6dp box added.
                        modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // The line rests on an oval of the same material as the
                        // wordmark above it — the same glass plate, one
                        // `--elev-1` step off the light — so the header reads as
                        // one thing: the app, then this session (owner:
                        // «подложку … как под логотипом сделать, бабл
                        // овальный»). A capsule rather than `shapes.large`
                        // because the line is one row tall where the
                        // wordmark's plate is three.
                        Surface(
                            shape = CircleShape,
                            color = Color.Transparent,
                            border = BorderStroke(1.dp, accents.glassLine),
                            modifier = Modifier.tailchatSurface(
                                shape = CircleShape,
                                fill = accents.glassStrong,
                                elevation = depth.card,
                                lights = listOf(depth.sheenBrush()),
                            ),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                // Exactly the shape a conversation's own header uses for its
                                // peer — `CompactBar`'s subtitle, `@login ● online` — with
                                // this account's own link in the peer's place: the login, the
                                // lamp, then the word, all in the colour that word carries
                                // there (the accent while online, the quiet tone otherwise).
                                //
                                // The lamp *is* the separator. This line used to spell out the
                                // dot of that subtitle itself (`@login ·`) and hold the lamp
                                // beside it, so it read `@godsheep · ( ) online` — a 20dp touch
                                // box around an 8dp ring, 12dp of air on one side of the dot and
                                // 8dp on the other, in a line whose whole point is to read as
                                // one run of text (owner: «слишком много пробелов … пусть
                                // разделителем будет кружок онлайн\офлайн»). Nothing spells the
                                // dot now: one space, the lamp, one space — the same three parts
                                // in the same order a peer line has.
                                //
                                // The word is the binary one a conversation shows, because
                                // that header is binary too: a peer who is not online is
                                // «offline» there while their phone is still waking up. The
                                // finer state stays on the lamp's colour and pulse.
                                val online = state.link == CloudLink.Online
                                val linkColor = if (online) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant
                                Text(
                                    text = "@${self.login}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = linkColor,
                                )
                                SelfConnectionDot(state.link, onReconnect = controller::connect)
                                Text(
                                    text = stringResource(
                                        if (online) R.string.cloud_peer_online else R.string.cloud_peer_offline,
                                    ),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = linkColor,
                                )
                            }
                        }
                    }
            }
        },
        bottomBar = {
            Surface(color = Color.Transparent, contentColor = MaterialTheme.colorScheme.onSurface, modifier = Modifier.glassBar()) {
                Column(Modifier.fillMaxWidth()) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    state.updateAvailable?.let {
                        UpdateBarButton(it, state.updateDownload, installGate.requestUpdate, controller::dismissUpdate)
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth()
                            .navigationBarsPadding()
                            .height(56.dp)
                            .padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.cloud_roster_counts, totalContacts, onlineCount),
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        RaisedDisc(onClick = onOpenInvite, modifier = Modifier.size(40.dp)) {
                            Icon(Icons.Filled.PersonAdd, stringResource(R.string.cloud_add_friend_short), Modifier.size(20.dp))
                        }
                        Spacer(Modifier.width(8.dp))
                        RaisedDisc(onClick = { showSettings = true }, modifier = Modifier.size(40.dp)) {
                            Icon(Icons.Filled.Settings, stringResource(R.string.cloud_settings_short), Modifier.size(20.dp))
                        }
                    }
                }
            }
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets)) {
            AnimatedFailureStrip(state.failure, calm = true, debounceMs = 2_500L)
            state.degraded?.let { DegradedBanner(it) }
            if (state.storeFailed) StoreFailureBanner()
            state.recoveryKey?.let { RecoveryKeyCard(it, controller::clearRecoveryKey) }
            if (state.updateAvailable == null && !installGate.canInstall && !dismissedInstall) {
                PermissionNoticeCard(
                    title = stringResource(R.string.cloud_update_perm_banner_title),
                    message = stringResource(R.string.cloud_update_perm_banner_msg),
                    actionLabel = stringResource(R.string.cloud_settings_install_perm_open),
                    onAction = installGate.requestInstallPermission,
                    onDismiss = {
                        settings.installPermissionPromptDismissed = true
                        dismissedInstall = true
                    },
                )
            } else if (inAppNotifications && !areNotifsEnabled && !dismissedNotif) {
                PermissionNoticeCard(
                    title = stringResource(R.string.cloud_notif_perm_banner_title),
                    message = stringResource(R.string.cloud_notif_perm_banner_msg),
                    actionLabel = stringResource(R.string.cloud_settings_notif_system_open),
                    onAction = {
                        runCatching { context.startActivity(AppPermissions.notificationSettingsIntent(context)) }
                    },
                    onDismiss = {
                        settings.notificationPermissionPromptDismissed = true
                        dismissedNotif = true
                    },
                )
            }
            Row(
                // One bubble, and it is the search field: the magnifier used to
                // swap this row between a heading and the field, and the owner
                // wants the field itself, always — «пусть будет всегда в
                // состоянии как после нажатия на лупу». So the heading is gone
                // and there is no closed state left to come back from.
                //
                // The air above and below is the list's own rhythm: 6dp from
                // the header's divider, and 6dp down to the first card (4 here
                // plus the list's own 2dp inset) — the same gap the cards keep
                // between themselves (`spacedBy(6.dp)`), so the field reads as
                // the first of the stack it filters, which is the whole point
                // of the bubble. Until now its top edge sat flush against the
                // divider (0dp) against 4dp at the bottom, because the row
                // still kept the fixed 44dp height of the heading it no longer
                // draws.
                modifier = Modifier.fillMaxWidth()
                    .padding(start = 10.dp, end = 10.dp, top = 6.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // `OutlinedTextField` reserves vertical space for a label
                // transition even with only a placeholder given, taller than
                // this row — the field visibly overflowed it. Same fix already
                // used for the composer draft further down: hand-decorate a
                // `BasicTextField` sized to the row instead of Material's own
                // box.
                //
                // The bubble is the whole row: the field and the control that
                // clears it share one `RosterCard` spanning the width the cards
                // below use, so the search reads as the first of the stack it
                // filters instead of as a different kind of object dropped into
                // the heading. Tapping anywhere in the card focuses the field.
                BasicTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    decorationBox = { field ->
                        RosterCard {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 40.dp)
                                    // The text starts where a row's avatar
                                    // does — 14dp into the bubble — and the
                                    // × spends the last 40dp, so its glyph
                                    // lands where a row's unread badge does.
                                    .padding(start = 14.dp, end = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(Modifier.weight(1f)) {
                                    if (searchQuery.isEmpty()) Text(
                                        stringResource(R.string.cloud_roster_search),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    field()
                                }
                                // Only while there is something to clear. The ×
                                // used to be the way *out* of the search; with
                                // the field always here that way out is gone,
                                // and a control with nothing left to do is not
                                // drawn.
                                if (searchQuery.isNotEmpty()) {
                                    IconButton(
                                        onClick = { searchQuery = "" },
                                        modifier = Modifier.size(40.dp),
                                    ) {
                                        Icon(Icons.Filled.Close, stringResource(R.string.cloud_roster_search_clear))
                                    }
                                }
                            }
                        }
                    },
                )
            }
            // Cards with air between them rather than rows divided by hairlines:
            // the roster is a list of things to press, and a rounded card is what
            // says so on a phone.
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item(key = "self") {
                    CloudUserRow(
                        user = self.copy(online = state.link == CloudLink.Online),
                        selfLogin = self.login,
                        title = stringResource(R.string.cloud_saved_messages),
                        subtitle = stringResource(R.string.cloud_saved_messages_hint),
                        // Not a friend, not presence — a personal utility
                        // conversation, styled the same secondary hue as the
                        // deployment's own official accounts rather than the
                        // default (unstyled) friend row.
                        serviceStyle = true,
                        saved = true,
                        onClick = { controller.selectPeer(self.login) },
                    )
                }
                items(sortedContacts, key = CloudUser::login, contentType = { "contact" }) { user ->
                    CloudRosterContactRow(
                        user, self.login, controller, scope,
                        swipeOpen = openSwipeLogin == user.login,
                        onSwipeOpenChange = { open -> openSwipeLogin = if (open) user.login else null },
                    ) {
                        removeTarget = user
                    }
                }
                if (contacts.isEmpty()) {
                    item {
                        Text(
                            text = stringResource(R.string.cloud_no_contacts),
                            modifier = Modifier.padding(24.dp),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
    if (showSettings) CloudSettingsSheet(
        controller = controller,
        onDismiss = { showSettings = false },
        onP2P = { showSettings = false; onP2P() },
        onLogout = { showSettings = false; controller.logout() },
    )
    removeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { removeTarget = null },
            title = { Text(stringResource(R.string.cloud_roster_remove_contact)) },
            // The contract's own sentence, verbatim: it is what the CLI and the
            // web client ask, word for word, and it is the whole warning —
            // whose copy survives and whose does not.
            text = { Text(stringResource(R.string.cloud_remove_contact_confirm), color = MaterialTheme.colorScheme.onSurface) },
            confirmButton = {
                TextButton(
                    onClick = {
                        removeTarget = null
                        scope.launch {
                            if (controller.removeContact(target.login)) {
                                Toast.makeText(context, R.string.cloud_remove_contact_done, Toast.LENGTH_SHORT).show()
                            }
                        }
                    },
                ) {
                    Text(stringResource(R.string.cloud_roster_remove_contact), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { removeTarget = null }) {
                    Text(stringResource(R.string.cloud_remove_contact_cancel))
                }
            },
        )
    }
}


@Composable
private fun CloudRosterContactRow(
    user: CloudUser,
    selfLogin: String,
    controller: CloudController,
    scope: CoroutineScope,
    swipeOpen: Boolean,
    onSwipeOpenChange: (Boolean) -> Unit,
    onRemoveContact: () -> Unit,
) {
    val mutedContacts by AppPreferences.mutedContacts.collectAsState()
    val context = LocalContext.current
    val settings = remember(context) { Settings(context) }
    CloudUserRow(
        user = user,
        selfLogin = selfLogin,
        modifier = Modifier,
        onClick = { controller.selectPeer(user.login) },
        onMarkRead = { controller.markConversationRead(user.login) },
        onMarkUnread = { controller.markConversationUnread(user.login) },
        muted = user.login in mutedContacts,
        swipeOpen = swipeOpen,
        onSwipeOpenChange = onSwipeOpenChange,
        onMuteToggle = { settings.setContactMuted(user.login, user.login !in mutedContacts) },
        onBlockToggle = {
            scope.launch {
                if (user.blocked) controller.unblockContact(user.login) else controller.blockContact(user.login)
            }
        },
        onRemoveContact = onRemoveContact,
    )
}

/**
 * The self line's connection lamp — the same ●/○ glyph a conversation's own
 * subtitle draws for its peer (`presenceDot`), in the same style, so the two
 * lines are one shape.
 *
 * It used to be an 8dp ring inside a 20dp touch box, and that box was the whole
 * reason the roster header read as `@godsheep · ( ) online`: with the box and
 * the spacers around it, the line carried 12dp of air on one side of the lamp
 * and 8dp on the other, in a line whose whole point is to read as one run of
 * text (owner: «слишком много пробелов … пусть разделителем будет кружок
 * онлайн\офлайн»). A glyph costs no box; the 3dp of horizontal padding is the
 * entire gap on each side of it, and it is also what keeps the tap target wider
 * than a bare glyph. The vertical 2dp is only there so the glyph's line is not
 * the tallest thing in the pill it sits in (`CloudRoster`'s header): the
 * pill's own 3dp does the rest.
 *
 * Nothing else changes: the colour still carries the finer state, the alpha
 * still pulses while the link is being re-established, a tap still says the
 * state out loud for anyone who cannot read colour, and while offline it still
 * retries — SyncEngine already retries on its own, but a stuck link should not
 * need the tap to be hidden behind a bigger control to find.
 */
@Composable
private fun SelfConnectionDot(link: CloudLink, onReconnect: () -> Unit) {
    val label = when (link) {
        CloudLink.Online -> stringResource(R.string.cloud_status_online)
        CloudLink.Connecting -> stringResource(R.string.cloud_status_connecting)
        CloudLink.Offline -> stringResource(R.string.cloud_status_offline)
        CloudLink.SignedOut -> stringResource(R.string.cloud_status_signed_out)
    }
    // Fixed, not theme-tinted: a status dot carries meaning (is the channel
    // healthy right now?), not the palette's taste — the same reasoning the
    // terminal client's own status colors follow.
    val dotColor = when (link) {
        CloudLink.Online -> MaterialTheme.colorScheme.primary
        // Offline is what a routine Wi-Fi↔cellular handoff or a Doze window
        // looks like while the automatic reconnect is already retrying in
        // the background (SyncEngine.scheduleReconnect) — the same
        // "in-between, not broken" status the amber token already carries
        // for Connecting, not the error red a problem the user must act on
        // would get.
        CloudLink.Offline -> statusWarning()
        CloudLink.Connecting -> statusWarning()
        CloudLink.SignedOut -> LocalTailchatAccents.current.line
    }
    val animatedColor by animateColorAsState(dotColor, label = "connection-dot-color")
    val pulse = rememberInfiniteTransition(label = "connection-pulse")
    val alpha = if (link == CloudLink.Connecting) {
        pulse.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
            label = "connection-pulse-alpha",
        ).value
    } else 1f
    val context = LocalContext.current
    // The glyph, not a ring in a box: `presenceDot` is the helper a
    // conversation's own subtitle uses for its peer, so the two lines cannot
    // drift apart again.
    Text(
        text = presenceDot(link == CloudLink.Online),
        style = MaterialTheme.typography.labelSmall,
        color = animatedColor.copy(alpha = alpha),
        modifier = Modifier
            .padding(horizontal = 3.dp, vertical = 2.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = label,
            ) { if (link == CloudLink.Offline) onReconnect() else Toast.makeText(context, label, Toast.LENGTH_SHORT).show() }
            .semantics { contentDescription = label },
    )
}

/**
 * The roster's bubble — the shape a person reads as "one thing in this list",
 * whether it holds a contact, the saved-messages line, or the field the
 * magnifier opens.
 *
 * Shape, fill, depth and edge live here, once, because the search field used to
 * spell out its own: a `surfaceVariant` well with a hard-coded
 * `RoundedCornerShape(12.dp)` and its text inset to the heading row's 14dp,
 * while every row around it was a `shapes.large` card on the list's own 10dp.
 * Four separate drifts — radius, fill, elevation, inset — and the field
 * consequently read as the one element from a different design language
 * (owner: «что-то сделать с выделяющейся … строкой поиска. возможно обернуть
 * её в такой же бабл как беседы с контактами»). Naming the bubble instead of
 * repeating it is what keeps the two from drifting apart again.
 *
 * Opaque on purpose, unlike the glass bars around it: a contact card slides
 * aside over its swipe actions, and those must not show through it. It rests
 * on the page at `--elev-1` with the top-down sheen, like web's `.roster-self`.
 */
@Composable
private fun RosterCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val depth = LocalTailchatDepth.current
    Surface(
        modifier = modifier.tailchatSurface(
            shape = MaterialTheme.shapes.large,
            fill = MaterialTheme.colorScheme.surface,
            elevation = depth.card,
            lights = listOf(depth.sheenBrush()),
        ),
        shape = MaterialTheme.shapes.large,
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = if (!LocalTailchatAccents.current.outlines) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        content = content,
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CloudUserRow(
    user: CloudUser,
    selfLogin: String,
    modifier: Modifier = Modifier,
    title: String = braced(user.displayName()),
    subtitle: String? = null,
    // Saved Messages is not a friend or a real `CloudUser.official` account,
    // but it is exactly the same kind of "this is the app, not a person"
    // conversation those are — so its roster row opts into the same
    // secondary-hue treatment explicitly, rather than the code overloading
    // `official` on the self user (which other call sites read too).
    serviceStyle: Boolean = user.official,
    /** This row is Saved Messages: its avatar is web's `saved` state — the AI
     *  accent with `✎` — rather than the service accounts' cobalt initial. */
    saved: Boolean = false,
    /** Offers the row's long-press menu (open chat / block or unblock) when
     *  set. The self row and the forward picker's rows leave this `null` —
     *  neither is a friend that can be blocked, and there was no per-contact
     *  menu anywhere on Android before this, so it is opt-in per call site. */
    onBlockToggle: (() -> Unit)? = null,
    /** Deletes the contact and this account's copy of the conversation — the
     *  caller owns the confirmation, since only it can put a dialog up. Left
     *  `null` by the same call sites as [onBlockToggle], and ignored for
     *  `official` rows: the server refuses those (`official_contact`), so the
     *  action is never offered on one. */
    onMarkRead: (() -> Unit)? = null,
    onMarkUnread: (() -> Unit)? = null,
    muted: Boolean = false,
    /** Открыт ли сейчас свайп именно этой строки. Состояние живёт в списке, а
     *  не в строке: свайп по одному контакту обязан закрыть свайп другого. */
    swipeOpen: Boolean = false,
    onSwipeOpenChange: (Boolean) -> Unit = {},
    onMuteToggle: (() -> Unit)? = null,
    onRemoveContact: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val preview = previewLine(user.preview, selfLogin)
    val unreadCount = user.pending + user.reactionEvents.size
    val previewLines by AppPreferences.rosterPreviewLines.collectAsState()
    val officialLabel = stringResource(R.string.cloud_official_account)
    val blockedLabel = stringResource(R.string.cloud_contact_blocked)
    var menuOpen by remember { mutableStateOf(false) }
    var reveal by remember { mutableStateOf(0.dp) }
    LaunchedEffect(swipeOpen) { if (!swipeOpen) reveal = 0.dp }
    val menuAvailable = onBlockToggle != null || onRemoveContact != null
    // Actions stay behind a full-width card. The card moves in placement only;
    // its avatar, title and preview keep the same measurement throughout the
    // gesture instead of reflowing into `maxWidth - reveal` every frame.
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (onMarkRead != null) {
            Row(
                modifier = Modifier.align(Alignment.CenterEnd).height(68.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SwipeRosterAction(
                    if (unreadCount > 0) Icons.Filled.DoneAll else Icons.Filled.MarkChatUnread,
                    stringResource(
                        if (unreadCount > 0) R.string.cloud_swipe_mark_read
                        else R.string.cloud_swipe_mark_unread,
                    ),
                    MaterialTheme.colorScheme.primary,
                    onClick = {
                        if (unreadCount > 0) onMarkRead() else onMarkUnread?.invoke()
                        reveal = 0.dp
                        onSwipeOpenChange(false)
                    },
                )
                SwipeRosterAction(
                    Icons.Filled.NotificationsOff,
                    stringResource(if (muted) R.string.cloud_swipe_unmute else R.string.cloud_swipe_mute),
                    LocalTailchatAccents.current.warning,
                    enabled = onMuteToggle != null,
                    onClick = { onMuteToggle?.invoke(); reveal = 0.dp; onSwipeOpenChange(false) },
                )
                SwipeRosterAction(
                    Icons.Filled.MoreHoriz,
                    stringResource(R.string.cloud_swipe_more),
                    MaterialTheme.colorScheme.onSurfaceVariant,
                    onClick = { menuOpen = true; reveal = 0.dp; onSwipeOpenChange(false) },
                )
            }
        }
        RosterCard(
            modifier = modifier.width(maxWidth).offset(x = -reveal)
                .pointerInput(onMarkRead, onMarkUnread) {
                    if (onMarkRead == null || onMarkUnread == null) return@pointerInput
                    val verticalRelease = 12.dp.toPx()
                    val horizontalLock = 36.dp.toPx()
                    val horizontalDominance = 2.5f
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val startingReveal = reveal
                        var totalX = 0f
                        var totalY = 0f
                        var locked = false
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) break
                            val delta = change.positionChange()
                            totalX += delta.x
                            totalY += delta.y
                            if (!locked) {
                                when (rosterGestureDecision(
                                    totalX,
                                    totalY,
                                    verticalRelease,
                                    horizontalLock,
                                    horizontalDominance,
                                )) {
                                    RosterGestureDecision.Vertical -> return@awaitEachGesture
                                    RosterGestureDecision.Pending -> continue
                                    RosterGestureDecision.Horizontal -> locked = true
                                }
                            }
                            change.consume()
                            reveal = (startingReveal - totalX.toDp()).coerceIn(0.dp, 162.dp)
                            if (reveal > 0.dp) onSwipeOpenChange(true)
                        }
                        if (locked) {
                            reveal = if (reveal >= 108.dp) 162.dp else 0.dp
                            onSwipeOpenChange(reveal > 0.dp)
                        }
                    }
                }
                .combinedClickable(
                    role = Role.Button,
                    onClick = onClick,
                    onLongClick = if (menuAvailable) { { menuOpen = true } } else null,
                )
                .semantics {
                    // Announced in addition to the row's own name/click semantics —
                    // never replaces them, since this is metadata about the row,
                    // not the row's identity.
                    if (serviceStyle) stateDescription = officialLabel
                    else if (user.blocked) stateDescription = blockedLabel
                }
                // A blocked contact stays in the roster (blocking never
                // removes the friendship) but reads as inert at a glance,
                // the same way a muted/disabled row is dimmed elsewhere.
                .alpha(if (user.blocked) 0.55f else 1f),
        ) {
            Row(
                modifier = Modifier.heightIn(min = 68.dp).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PresenceAvatar(user, official = serviceStyle && !saved, initialFrom = user.displayName(), saved = saved)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.bodyLarge,
                        // Bold for every row, not only for one with unread
                        // messages (issue #30). The roster is a list of
                        // *people* and the name is what identifies them: web's
                        // own `.roster-name` has been `font-weight: 700` and
                        // its element a `<strong>` from the start. Weighing it
                        // by `pending` made one person's name change shape as
                        // their messages were read, which is a fact about the
                        // conversation, not about the person.
                        fontWeight = FontWeight.Bold,
                        // The server is not a person: naming it in the palette's
                        // secondary hue, the same distinction web draws on its
                        // roster dot (`.roster-dot[data-official]`), is what lets
                        // it read as "this account" rather than "this friend".
                        color = if (serviceStyle) MaterialTheme.colorScheme.secondary else Color.Unspecified,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(3.dp))
                    // The last thing said in that conversation — what the web
                    // roster shows, and what the server sends in every roster
                    // entry's `last`. Presence is the fallback for a friend
                    // nobody has said anything to yet. Only an actual message
                    // preview wraps to the setting's line count: the presence
                    // fallback and the Saved Messages hint (`subtitle`) always
                    // stay one line, so the row height never depends on whether
                    // a friend has ever said anything.
                    when {
                        subtitle != null -> Text(
                            subtitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        preview != null -> RosterPreviewText(
                            line = preview,
                            previewLines = previewLines,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        else -> Text(
                            text = if (serviceStyle) officialLabel
                            else if (user.online) stringResource(R.string.cloud_peer_online)
                            else stringResource(R.string.cloud_peer_offline),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (serviceStyle || !user.online) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                MaterialTheme.colorScheme.primary
                            },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Column(Modifier.padding(start = 8.dp).align(Alignment.Top), horizontalAlignment = Alignment.End) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        preview?.mark?.let { mark ->
                            CloudReceiptMark(mark, color = if (mark == CloudDelivery.Read) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if ((user.preview?.ts ?: 0L) > 0L) Text(
                            rosterTimeLabel(user.preview!!.ts),
                            style = MaterialTheme.typography.labelSmall.copy(fontFamily = TailchatMono),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (unreadCount > 0) {
                        val unreadDescription = stringResource(R.string.cloud_unread_count, unreadCount)
                        val badge = MaterialTheme.colorScheme.primary
                        val depth = LocalTailchatDepth.current
                        Surface(shape = CircleShape, color = Color.Transparent,
                            modifier = Modifier.padding(top = 4.dp).clearAndSetSemantics { contentDescription = unreadDescription }
                                .tailchatSurface(CircleShape, badge, null,
                                    if (depth.enabled) listOf(Brush.verticalGradient(listOf(lerp(badge, Color.White, 0.12f), badge))) else emptyList(),
                                    listOf(depth.accentGlow))) {
                            Text(if (unreadCount > 99) "99+" else unreadCount.toString(),
                                modifier = Modifier.widthIn(min = 28.dp).padding(horizontal = 6.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary,
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                        }
                    }
                }
            }
        }
        if (menuAvailable) {
            TailchatDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                MessageAction(Icons.AutoMirrored.Filled.Chat, stringResource(R.string.cloud_roster_open_chat)) {
                    menuOpen = false
                    onClick()
                }
                if (onBlockToggle != null) {
                    MessageAction(
                        Icons.Filled.Block,
                        stringResource(
                            if (user.blocked) R.string.cloud_roster_unblock_contact else R.string.cloud_roster_block_contact,
                        ),
                        tint = if (user.blocked) LocalContentColor.current else MaterialTheme.colorScheme.error,
                    ) {
                        menuOpen = false
                        onBlockToggle()
                    }
                }
                // Never on an official account: the server answers
                // `official_contact` and there is nothing to delete anyway —
                // the service account is part of the deployment, not a friend
                // this account could have added wrongly.
                if (onRemoveContact != null && !user.official) {
                    MessageAction(
                        Icons.Filled.Delete,
                        stringResource(R.string.cloud_roster_remove_contact),
                        tint = MaterialTheme.colorScheme.error,
                    ) {
                        menuOpen = false
                        onRemoveContact()
                    }
                }
            }
        }
    }
}

@Composable
private fun SwipeRosterAction(
    icon: ImageVector,
    label: String,
    tint: Color,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier.width(54.dp).height(68.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .clickable(enabled = enabled, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = tint)
        Spacer(Modifier.height(3.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
            color = tint,
            maxLines = 1,
        )
    }
}

/**
 * One roster line out of a [CloudPreview], split into the two pieces the row
 * lays out separately: [body], media named rather than shown and own messages
 * prefixed `{вы}:` the way the transcript labels them, and the read [mark]
 * (issue #25) that *closes* the line rather than opening it. Newlines are
 * flattened — a `/help` dump as the last message must not make one row four
 * rows tall. [mark] is null for a peer's own message, where this account's
 * read state says nothing about it.
 */
internal data class RosterPreviewLine(val body: String, val mark: CloudDelivery?)

/**
 * The pure split behind [RosterPreviewLine]: everything except the localised
 * words, which [caption] resolves, so the body/mark convention (issue #25) is
 * unit-testable without Compose. The mark retains its delivery rung for the
 * shared vector renderer, with read taking precedence over delivered.
 */
internal fun rosterPreviewLine(
    preview: CloudPreview?,
    selfLogin: String,
    youLabel: String,
    caption: (String) -> String,
): RosterPreviewLine? {
    if (preview == null) return null
    val body = when (preview.media) {
        "image" -> caption("image")
        "voice" -> caption("voice")
        "call" -> caption("call")
        else -> preview.text.lineSequence().joinToString(" ").trim()
    }
    if (body.isEmpty()) return null
    if (preview.from != selfLogin) return RosterPreviewLine(body, mark = null)
    // The roster's mark is the shared ladder asked with what this row knows:
    // the read watermark (`CloudPreview.read`) outranks delivery, delivery
    // (`CloudPreview.delivered`) is the ✓✓ the bubble already shows once the
    // peer's device holds the message, and neither is the plain ✓ that only
    // means the server took it.
    val mark = when {
        preview.read -> CloudDelivery.Read
        preview.delivered -> CloudDelivery.Delivered
        else -> CloudDelivery.Accepted
    }
    return RosterPreviewLine(body = "${braced(youLabel)}: $body", mark = mark)
}

@Composable
private fun previewLine(preview: CloudPreview?, selfLogin: String): RosterPreviewLine? {
    val youLabel = stringResource(R.string.cloud_author_you)
    val imageCaption = stringResource(R.string.cloud_image_caption)
    val voiceCaption = stringResource(R.string.cloud_voice_caption)
    val callCaption = stringResource(R.string.cloud_call_caption)
    return rosterPreviewLine(preview, selfLogin, youLabel) { tag ->
        when (tag) {
            "image" -> imageCaption
            "voice" -> voiceCaption
            "call" -> callCaption
            else -> tag
        }
    }
}

/** Receipt and time live in the fixed top-right column, never after preview text. */
@Composable
private fun RosterPreviewText(line: RosterPreviewLine, previewLines: Int, color: Color) {
    EmojiText(line.body, style = MaterialTheme.typography.labelSmall, color = color,
        maxLines = previewLines, overflow = TextOverflow.Ellipsis)
}

/** The roster circle's diameter. See [PresenceAvatar] for why it is this
 *  number and not the 38dp it used to be. */
private val AVATAR_SIZE = 48.dp

/** The user sheet's identity circle — web's `.info-avatar`, 76px. */
private val AVATAR_SIZE_LARGE = 76.dp

/**
 * The initial in a ring the presence colour tints. The bare `●`/`○` glyph it
 * replaces kept the roster on the text grid, but it also gave every row the
 * same silhouette — with names in `{braces}` and a monospace face there was
 * nothing to aim at.
 *
 * The states are web's `.roster-avatar` (1.128, `buildAvatar` in
 * web/cloud/app.js), which was modelled on this one: online — the accent,
 * filled with its soft twin and haloed by a 3dp ring of it; offline — the
 * quiet tone on the raised fill; the deployment's own accounts — cobalt
 * (`secondary`), whatever their always-true presence says; Saved Messages —
 * the AI accent on its soft fill, with `✎` for an initial. Web's amber
 * idle/away has no counterpart here: this client's roster carries only
 * online/offline (`CloudUser.online`). Every state gets the same light — a
 * radial highlight from the upper left — and rests at `--elev-1`.
 *
 * 48dp in the roster: this is the slot a profile photo goes in, and a face at
 * 38dp was past the point of being recognisable — the roster row's own
 * `heightIn(min = 68.dp)` already had the room (48 + the row's 10dp of
 * vertical padding is exactly 68). 76dp at the top of the user sheet.
 */
@Composable
private fun PresenceAvatar(
    user: CloudUser,
    official: Boolean = user.official,
    initialFrom: String = user.displayName(),
    saved: Boolean = false,
    size: Dp = AVATAR_SIZE,
) {
    val accents = LocalTailchatAccents.current
    val depth = LocalTailchatDepth.current
    val online = !saved && !official && user.online
    val ring = when {
        saved -> accents.ai
        official -> MaterialTheme.colorScheme.secondary
        online -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val fill = when {
        saved -> accents.aiSoft
        online -> MaterialTheme.colorScheme.primaryContainer
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    // `radial-gradient(circle at 30% 25%, ring 26%, transparent 62%)`: a
    // circle out to the farthest corner, which from (30%, 25%) is 1.026 of
    // the side.
    val highlight = remember(ring) {
        object : androidx.compose.ui.graphics.ShaderBrush() {
            override fun createShader(size: Size) = androidx.compose.ui.graphics.RadialGradientShader(
                center = Offset(0.30f * size.width, 0.25f * size.height),
                radius = 1.026f * size.width,
                colors = listOf(ring.copy(alpha = 0.26f), ring.copy(alpha = 0f)),
                colorStops = listOf(0f, 0.62f),
            )
        }
    }
    val halo = if (online && accents.outlines) listOf(TailchatShadow(0.dp, 0.dp, 3.dp, ring.copy(alpha = 0.16f))) else emptyList()
    Box(
        modifier = Modifier.size(size)
            .tailchatSurface(CircleShape, fill, depth.card, if (depth.enabled) listOf(highlight) else emptyList(), halo)
            .border(1.5.dp, accents.ring(ring), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (saved) "✎" else initialFrom.trim().take(1).uppercase().ifBlank { "?" },
            style = MaterialTheme.typography.titleMedium.copy(
                fontFamily = TailchatMono,
                fontSize = MaterialTheme.typography.titleMedium.fontSize * (size / AVATAR_SIZE) * 1.1f,
                lineHeight = MaterialTheme.typography.titleMedium.lineHeight * (size / AVATAR_SIZE) * 1.1f,
            ),
            fontWeight = FontWeight.Bold,
            color = ring,
        )
    }
}

/**
 * «При нажатии на username — данные о пользователе и также возможность
 * изменить отображаемое ЕГО имя»: opened by tapping the conversation
 * header's title. Shows the account's real name and login, then this
 * account's own private nickname for [user] — the server roster's `alias`
 * (issue #28). The nickname is saved through [CloudController.renameContact]
 * (`POST /api/alias`): it is private to this account, never disclosed to
 * [user], and [user]'s own account name (used by every other client, and by
 * this one whenever no nickname is set) never changes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UserInfoSheet(
    user: CloudUser,
    onSetAlias: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    val alias = user.alias
    var draft by remember(user.login) { mutableStateOf(alias.orEmpty()) }
    val shownName = user.displayName()
    // The sheet is glass like every dialog since 1.128, and its content is
    // web's info panel in the same order: the identity centred under a 76dp
    // avatar, then each block as a card. Web's panel also has a 2×2 tile of
    // message/image/voice/unread counts; this sheet has no such statistics to
    // show, so there is no tile here rather than a made-up one.
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = LocalTailchatAccents.current.glassSheet,
        // Explicit: a translucent container is no scheme colour, so
        // `contentColorFor` would fall back to black text on a dark sheet.
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding()) {
            Text(
                stringResource(R.string.cloud_user_info_title),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 6.dp),
            )
            Column(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                PresenceAvatar(user, initialFrom = shownName, size = AVATAR_SIZE_LARGE)
                Spacer(Modifier.height(10.dp))
                Text(
                    braced(shownName),
                    style = MaterialTheme.typography.titleLarge,
                    textAlign = TextAlign.Center,
                )
                Text(
                    // Same line as the two headers: `@login ● online`, the
                    // lamp dividing the login from the word. The service
                    // account keeps the dot, having no lamp to divide with.
                    if (user.official) {
                        "@${user.login} · " + stringResource(R.string.cloud_official_account)
                    } else {
                        "@${user.login} ${presenceDot(user.online)} " + stringResource(
                            if (user.online) R.string.cloud_peer_online else R.string.cloud_peer_offline,
                        )
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            InfoBlock {
                Text(
                    stringResource(R.string.cloud_user_info_account_name),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(user.name, style = MaterialTheme.typography.bodyLarge)
            }
            InfoBlock {
                Text(
                    stringResource(R.string.cloud_user_info_alias_label),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    singleLine = true,
                    colors = tailchatFieldColors(),
                    placeholder = { Text(user.name) },
                    // A name is prose, so the IME capitalises it the way it does
                    // anywhere else on the phone — «Words», not «Sentences»: every
                    // word in a display name starts with a capital, while a sentence
                    // rule would leave the surname lower-case. The login, password
                    // and roster-search fields keep no capitalisation at all, since
                    // those are handles this account matches exactly.
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
                Text(
                    stringResource(R.string.cloud_user_info_alias_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.End) {
                    if (draft.isNotBlank()) {
                        TextButton(onClick = { draft = ""; onSetAlias(null) }) {
                            Text(stringResource(R.string.cloud_user_info_alias_reset))
                        }
                    }
                    TextButton(onClick = { onSetAlias(draft.trim().ifBlank { null }); onDismiss() }) {
                        Text(stringResource(R.string.cloud_user_info_alias_save))
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** One block of the user sheet as a card — web's `.info-block` (1.128): the
 *  glass line, `radius-m`, the raised fill at half strength and `--elev-1`. */
@Composable
private fun InfoBlock(content: @Composable () -> Unit) {
    val accents = LocalTailchatAccents.current
    val depth = LocalTailchatDepth.current
    val shape = MaterialTheme.shapes.medium
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp)
            .tailchatSurface(shape, MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), depth.card)
            .border(1.dp, accents.glassLine, shape)
            .padding(12.dp),
    ) { content() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloudConversation(controller: CloudController, state: CloudState, uiViewModel: CloudUiViewModel) {
    // Offline the roster is empty (contacts only ever arrive over the network),
    // so the row a conversation is about may not be in it. Synthesising it from
    // the selected login is what lets a notification tap open the cached thread
    // with no network at all; when the user is genuinely known the roster copy
    // wins, because it carries the online state and the fresh name.
    val peer = state.selectedUser ?: state.session?.user?.let { self ->
        state.selectedPeer?.let { login ->
            if (login == self.login) self else CloudUser(login = login, name = login)
        }
    } ?: return
    val selfLogin = state.session?.user?.login ?: return
    val self = peer.login == selfLogin
    val showDeletedMessages by AppPreferences.showDeletedMessages.collectAsState()
    val mutedContacts by AppPreferences.mutedContacts.collectAsState()
    val wallpaper by AppPreferences.wallpaper.collectAsState()
    // Read once here rather than per bubble: the transcript backdrop and the
    // settings preview both draw from the palette in force.
    val accents = LocalTailchatAccents.current
    val depth = LocalTailchatDepth.current
    // The nickname (server `alias`, private to this account — issue #28)
    // overrides only the display, and only for a real peer — the self
    // conversation ("Saved messages") always shows its own real title.
    val displayName = if (self) peer.name else peer.displayName()
    var showUserInfo by remember(state.selectedPeer) { mutableStateOf(false) }
    var peerMenuOpen by remember(state.selectedPeer) { mutableStateOf(false) }
    val voiceContext = LocalContext.current
    val settings = remember(voiceContext) { Settings(voiceContext) }
    // One MediaPlayer for the whole conversation, not one per voice bubble:
    // this `remember` is conversation-scoped because the whole function is
    // disposed and recreated by the outer `key(state.selectedPeer) { … }`
    // wrapper at the call site — leaving this conversation (peer switch,
    // Back, process the screen away) always tears this down via `release()`.
    val voicePlaybackController = remember(Unit) { VoicePlaybackController(voiceContext, controller::resolveMedia) }
    DisposableEffect(Unit) { onDispose { voicePlaybackController.release() } }
    val voiceAccountKey = remember(state.session?.server, selfLogin) { "${state.session?.server}|$selfLogin" }
    val listState = rememberLazyListState()
    var transcriptViewport by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    val reactionEvents = state.selectedUser?.reactionEvents.orEmpty()
    val reactionsByMessage = remember(reactionEvents) { reactionEvents.groupBy { it.messageId } }
    LaunchedEffect(reactionEvents, state.messages, state.loadingHistory) {
        if (!state.loadingHistory) {
            val absent = reactionEvents.filter { event ->
                state.messages.none { it.id == event.messageId && it.reactions.containsKey(event.emoji) }
            }.map { it.id }
            if (absent.isNotEmpty()) {
                snapshotFlow { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0 }
                    .first { it }
                controller.readReactions(absent)
            }
        }
    }
    val scope = rememberCoroutineScope()
    val youLabel = stringResource(R.string.cloud_author_you)
    val names = remember(state.users, selfLogin, youLabel) {
        state.users.associate { it.login to it.displayName() } + (selfLogin to youLabel)
    }
    val nameOf: (String) -> String = remember(names) {
        { login -> names[login] ?: login }
    }
    var replyTo by remember(state.selectedPeer) { mutableStateOf<CloudReply?>(null) }
    var editing by remember(state.selectedPeer) { mutableStateOf<CloudMessage?>(null) }
    var preEditDraft by rememberSaveable(state.selectedPeer) { mutableStateOf<String?>(null) }
    // The composer's text, lifted here (rather than owned by CloudComposer)
    // so a persisted draft can be applied to it once loaded, and so it can be
    // persisted back on every change — Back, rotation, process death and a
    // theme switch must not lose what was being typed.
    var draftText by remember(state.selectedPeer) { mutableStateOf("") }
    var draftLoaded by remember(state.selectedPeer) { mutableStateOf(false) }
    // The message a restored draft says it was editing, kept separately from
    // [editing]: the transcript may not have loaded that message yet when the
    // draft itself does, and this keeps retrying as history arrives instead
    // of silently dropping the edit target.
    var pendingEditingId by remember(state.selectedPeer) { mutableStateOf<String?>(null) }

    LaunchedEffect(state.selectedPeer) {
        val loaded = controller.draft(peer.login)
        // Guards the race between this suspend load and the user typing (or
        // swiping to reply, or picking edit) before it resolves: an
        // unconditional overwrite here would let a slower-than-expected Room
        // read replace something the user already did while it was in
        // flight — see shouldApplyLoadedDraft.
        if (shouldApplyLoadedDraft(draftText, replyTo, editing)) {
            draftText = loaded?.text.orEmpty()
            replyTo = loaded?.replyTo
            pendingEditingId = loaded?.editingId
            editing = pendingEditingId?.let { id -> state.messages.firstOrNull { it.id == id } }
        }
        draftLoaded = true
    }
    LaunchedEffect(pendingEditingId, state.messages) {
        if (pendingEditingId != null && editing == null) {
            editing = state.messages.firstOrNull { it.id == pendingEditingId }
        }
    }
    // Debounced so a fast typist is one write every 300ms, not one per
    // keystroke; never runs before the initial load lands, or the empty seed
    // value would overwrite a real draft the instant the conversation opens.
    LaunchedEffect(draftText, replyTo, editing, draftLoaded) {
        if (!draftLoaded) return@LaunchedEffect
        delay(300)
        controller.saveDraft(peer.login, CloudDraft(text = draftText, replyTo = replyTo, editingId = editing?.id))
    }
    // The debounce above only fires 300ms after typing stops; switching
    // conversations (or Back) tears this whole composable down via the
    // outer `key(state.selectedPeer) { … }` at the call site immediately,
    // cancelling that `delay(300)` mid-flight before it ever calls
    // saveDraft. This flushes the latest composed value unconditionally on
    // the way out so a fast type-then-leave never loses the tail of what
    // was typed. `rememberUpdatedState` is required: a plain closure over
    // `draftText` here would freeze on the value this effect first saw, not
    // the latest one before disposal.
    val latestDraftText by rememberUpdatedState(draftText)
    val latestReplyTo by rememberUpdatedState(replyTo)
    val latestEditing by rememberUpdatedState(editing)
    val latestDraftLoaded by rememberUpdatedState(draftLoaded)
    val latestPeerLogin by rememberUpdatedState(peer.login)
    DisposableEffect(state.selectedPeer) {
        onDispose {
            if (latestDraftLoaded) {
                controller.saveDraft(
                    latestPeerLogin,
                    CloudDraft(text = latestDraftText, replyTo = latestReplyTo, editingId = latestEditing?.id),
                )
            }
        }
    }
    // The messages waiting for a recipient: set by «Переслать» — one message
    // from a bubble's menu, or the whole selection from the bar — and cleared
    // when the contact is picked or the sheet dismissed. Ids rather than
    // messages, because a bulk forward names several at once and the
    // controller reads them back in conversation order.
    var forwarding by remember(state.selectedPeer) { mutableStateOf<List<String>?>(null) }

    forwarding?.let { pending ->
        ForwardPickerDialog(
            users = state.users,
            selfLogin = selfLogin,
            onDismiss = { forwarding = null },
            onPick = { target ->
                forwarding = null
                controller.forward(pending, target)
            },
        )
    }
    if (showUserInfo && !self) {
        UserInfoSheet(
            user = peer,
            onSetAlias = { controller.renameContact(peer.login, it.orEmpty()) },
            onDismiss = { showUserInfo = false },
        )
    }
    val finishContext = {
        replyTo = null
        editing = null
        pendingEditingId = null
        preEditDraft = null
    }
    val cancelContext = {
        if (editing != null) draftText = preEditDraft.orEmpty()
        finishContext()
    }
    // Reported to the single activity-level BackHandler (CloudUiViewModel):
    // an active reply/edit closes on Back before the conversation does.
    SideEffect {
        uiViewModel.setComposerContext(replyTo != null || editing != null, cancelContext)
    }
    DisposableEffect(state.selectedPeer) { onDispose { uiViewModel.setComposerContext(false, null) } }
    // The transcript is drawn bottom-up: item 0 is the newest message and sits
    // at the bottom of the screen. That is what makes "opens at the newest"
    // structural instead of a scroll that has to be timed — a freshly composed
    // list is already at index 0, so nothing has to chase the arriving history
    // at all. Chasing it is what failed before: `scrollToItem` clamps to the
    // item count of the last completed layout pass, and a conversation's
    // history lands in one update on a list that was empty a frame earlier, so
    // every attempted jump clamped to the top of the oldest day.
    //
    // What still needs a scroll is the tail: LazyColumn re-anchors on the *key*
    // of the first visible item, so an arriving message pushes itself just off
    // the bottom edge instead of being revealed.
    var followingLatest by remember(state.selectedPeer) { mutableStateOf(true) }
    var unseenMessages by remember(state.selectedPeer) { mutableStateOf(0) }
    var previousNewest by remember(state.selectedPeer) { mutableStateOf<String?>(null) }
    LaunchedEffect(listState) {
        snapshotFlow {
            Triple(
                listState.isScrollInProgress,
                listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0,
                listState.layoutInfo.totalItemsCount,
            )
        }.collect { (scrolling, atBottom, _) ->
            if (scrolling) followingLatest = atBottom
            if (atBottom) {
                followingLatest = true
                unseenMessages = 0
            }
        }
    }
    val rows = remember(state.messages, showDeletedMessages) {
        state.messages.filter { showDeletedMessages || it.deletedAt == null }.asReversed()
    }
    val gallery = remember(state.messages) {
        state.messages.mapNotNull { message ->
            message.image?.takeIf { message.deletedAt == null }?.let { GalleryImage(message.id, it) }
        }
    }
    // The message multi-select — see [CloudSelection]. Local to this
    // conversation by construction: the `key(state.selectedPeer)` wrapper at
    // the call site disposes this whole function when the peer changes, so the
    // mode cannot outlive the bubbles it names.
    var selection by remember(state.selectedPeer) { mutableStateOf(CloudSelection()) }
    // Keep the composer's actual slot, including a multiline draft or reply,
    // when selection replaces it. Neither transition may resize the transcript.
    var composerHeightPx by remember { mutableIntStateOf(0) }
    val composerHeight = with(LocalDensity.current) { composerHeightPx.toDp() }
    // Only the rows that draw a bubble can be named by a selection: a system
    // note and a tombstone have none to ring, and a message deleted on another
    // device must fall out of the count rather than be counted off-screen.
    val selectableIds = remember(rows) {
        rows.asSequence().filter { !it.system && it.deletedAt == null }.map { it.id }.toSet()
    }
    LaunchedEffect(selectableIds) {
        val kept = selection.retain(selectableIds)
        if (kept != selection) selection = kept
    }
    // The selection in conversation order, and the two facts the delete rows
    // and the bar need — computed once for the whole transcript rather than
    // per bubble.
    val selectedMessages = remember(state.messages, selection.ids) {
        cloudSelectedInOrder(state.messages, selection.ids)
    }
    val selectionAllOwn = remember(selectedMessages) { cloudSelectionAllOwn(selectedMessages) }
    // «hold на бабл» starts the mode on that message. The composer's slot is
    // about to be taken by the selection bar, so a palette standing over it has
    // nothing left to stand on.
    val enterSelection: (String) -> Unit = { id ->
        selection = selection.enter(id)
        uiViewModel.openEmojiPalette(false)
    }
    val toggleSelection: (String) -> Unit = { id -> selection = selection.toggle(id) }
    val selectedIdsInOrder: () -> List<String> = { selectedMessages.map { it.id } }
    val deleteSelection: (Boolean) -> Unit = { forEveryone ->
        val ids = selectedIdsInOrder()
        if (ids.isNotEmpty()) controller.deleteMessages(ids, forEveryone)
        // The mode ends with the messages it named (web's `deleteMessages`
        // path exits it the same way, app.js:9897-9912).
        selection = selection.clear()
    }
    val newestRow = state.messages.lastOrNull()
    val newest = newestRow?.id
    val newestIsMine = newestRow?.mine == true
    LaunchedEffect(state.selectedPeer, newest) {
        val isNew = newest != null && previousNewest != null && newest != previousNewest
        previousNewest = newest
        if (newestIsMine) followingLatest = true
        if (newest != null && (newestIsMine || followingLatest)) {
            listState.scrollToItem(0)
            unseenMessages = 0
            controller.markVisibleMessagesRead(peer.login, rows.map { it.id })
        } else if (isNew) {
            unseenMessages += 1
        }
    }
    // Tapping the call button: a peer with no live `call-v1` connection is
    // two different situations, and calling both of them "this contact has
    // no app able to take a call" was wrong for the common one. Offline
    // simply means the phone's socket is down — the server holds the offer
    // for the caller's whole ring window and wakes the device by push
    // (`pendingCallOffers`/`kind=call` in `src/cloud/hub.js`), so the call
    // must actually be placed and the person told it may take a moment.
    // Only a peer who *is* online while still not announcing `call-v1`
    // (browser tab, old build) genuinely has nothing that can answer.
    var callNotice by remember(peer.login) { mutableStateOf<Int?>(null) }
    LaunchedEffect(callNotice) {
        if (callNotice != null) {
            delay(4_000)
            callNotice = null
        }
    }
    // A call with no RECORD_AUDIO is a call the other side hears nothing on:
    // libwebrtc's `AudioRecord` cannot even be created («getInputForAttr
    // permission denied … AudioFlinger could not create record track»), and
    // nothing in the call UI would say why. The permission was only ever asked
    // for voice notes, so a person who never recorded one has not granted it.
    val callMicPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) controller.placeCall(peer.login)
    }
    val startCall = {
        val granted = ContextCompat.checkSelfPermission(voiceContext, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) controller.placeCall(peer.login)
        else callMicPermission.launch(Manifest.permission.RECORD_AUDIO)
    }
    CompositionLocalProvider(
        LocalVoicePlayback provides VoicePlaybackContext(voicePlaybackController, controller::resolveMedia, voiceAccountKey, peer.login),
    ) {
    // The room (web 1.128 «студия»): the ambient light and the wallpaper are
    // painted on the whole conversation column, so the glass header and the
    // floating composer lie *over* the pattern instead of cutting it off at the
    // transcript's edges. It is recorded on its own layer behind the list,
    // never inside it: drawn in the LazyColumn the pattern would scroll away
    // with the messages, and it is the one thing that must stand still while
    // they move. Nothing to sit behind yet — the «Сообщений пока нет» state
    // and the history spinner — keeps the plain light, as before.
    val paper = MaterialTheme.colorScheme.background
    Scaffold(
        modifier = Modifier
            .roomBackdrop(paper, accents, wallpaper.takeIf { rows.isNotEmpty() })
            .imePadding(),
        containerColor = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            CompactBar(
                title = if (self) stringResource(R.string.cloud_saved_messages) else braced(displayName),
                subtitle = when {
                    self -> stringResource(R.string.cloud_saved_messages_hint)
                    // The lamp is the separator here too: `@login ● online`, the
                    // same three parts the roster's own self line draws. The
                    // service account has no lamp to do that job — it is not a
                    // presence — so there the dot stays.
                    peer.official -> "@${peer.login} · " + stringResource(R.string.cloud_official_account)
                    else -> "@${peer.login} ${presenceDot(peer.online)} " +
                        stringResource(if (peer.online) R.string.cloud_peer_online else R.string.cloud_peer_offline)
                },
                subtitleColor = if (peer.online && !self && !peer.official) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant,
                leading = {
                    BarAction(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        stringResource(R.string.cloud_back_to_roster),
                        onClick = controller::closeConversation,
                    )
                },
                onTitleClick = if (self) null else ({ showUserInfo = true }),
                actions = {
                    // Never for Saved Messages/AI, and never when the local
                    // engine never came up (§9.1) — there is nothing this
                    // device could do then. Otherwise the call is always
                    // placed: `callable` only says whether a socket *right
                    // now* announced `call-v1`, and a contact whose app is
                    // closed (or who is signed in from a browser tab on top
                    // of their phone) reads as online-but-not-callable while
                    // their phone is perfectly reachable — the server holds
                    // the offer for the whole ring window and wakes the
                    // device by push. Refusing that was the «приложение не
                    // может принять звонок» on a contact who could.
                    // Never for Saved Messages, and never for the deployment's
                    // own accounts ({tailchat}, {tailik}): they answer from the
                    // server and have no socket to ring — the hub says so
                    // itself (`callable: !official`, hub.js:388). A handset
                    // that can only ever fail is not an affordance.
                    if (!self && !peer.official && net.tailchat.android.call.CallEngineAvailability.available) {
                        BarAction(
                            Icons.Filled.Call,
                            stringResource(R.string.call_start),
                            raised = true,
                            onClick = {
                                if (!peer.callable) callNotice = R.string.call_peer_offline_hint
                                startCall()
                            },
                        )
                    }
                    if (!self) {
                        Box {
                            BarAction(
                                Icons.Filled.MoreVert,
                                stringResource(R.string.cloud_peer_menu),
                                onClick = { peerMenuOpen = true },
                                size = 44.dp,
                                raised = true,
                            )
                            TailchatDropdownMenu(expanded = peerMenuOpen, onDismissRequest = { peerMenuOpen = false }) {
                                MessageAction(Icons.Filled.Person, stringResource(R.string.cloud_peer_profile)) {
                                    peerMenuOpen = false
                                    showUserInfo = true
                                }
                                MessageAction(
                                    Icons.Filled.NotificationsOff,
                                    stringResource(
                                        if (peer.login in mutedContacts) R.string.cloud_swipe_unmute
                                        else R.string.cloud_swipe_mute,
                                    ),
                                ) {
                                    settings.setContactMuted(peer.login, peer.login !in mutedContacts)
                                    peerMenuOpen = false
                                }
                                MessageAction(
                                    Icons.Filled.Block,
                                    stringResource(
                                        if (peer.blocked) R.string.cloud_roster_unblock_contact
                                        else R.string.cloud_roster_block_contact,
                                    ),
                                    tint = if (peer.blocked) LocalContentColor.current else MaterialTheme.colorScheme.error,
                                ) {
                                    peerMenuOpen = false
                                    scope.launch {
                                        if (peer.blocked) controller.unblockContact(peer.login)
                                        else controller.blockContact(peer.login)
                                    }
                                }
                            }
                        }
                    }
                },
            )
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets)) {
            AnimatedFailureStrip(state.failure, calm = true, debounceMs = 2_500L)
            callNotice?.let { notice ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ) {
                    Text(
                        stringResource(notice),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            state.degraded?.let { DegradedBanner(it) }
            if (state.storeFailed) StoreFailureBanner()
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                if (state.loadingHistory) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center).size(28.dp))
                } else if (rows.isEmpty()) {
                    Text(
                        stringResource(R.string.cloud_empty_conversation),
                        modifier = Modifier.align(Alignment.Center).padding(24.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // Newest first, drawn bottom-up (see `wasAtBottom` above), so
                // the row order inside the list is the reverse of the thread.
                // `rows` is computed from the local visibility preference:
                // content-free tombstones exist in state to block stale history
                // but remain absent from the transcript by default.
                LazyColumn(
                    state = listState,
                    reverseLayout = true,
                    modifier = Modifier.fillMaxSize().onGloballyPositioned { transcriptViewport = it.boundsInWindow() },
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    itemsIndexed(
                        rows,
                        key = { _, m -> m.id },
                        contentType = { _, m ->
                            when {
                                m.system -> "system"
                                m.image != null -> "image"
                                m.voice != null -> "voice"
                                m.attachment != null -> "file"
                                else -> "text"
                            }
                        },
                    ) { index, message ->
                        Column(Modifier.animateItem()) {
                            // `── СЕГОДНЯ ──` between days, the same divider the web
                            // transcript draws (`.day-divider`, app.js:8850-8868) and
                            // the terminal client's own date rule. The chronologically
                            // previous message is one *further* down the reversed list.
                            val previous = rows.getOrNull(index + 1)
                            val startsDay = remember(previous?.ts, message.ts) {
                                previous == null || !sameDay(previous.ts, message.ts)
                            }
                            if (startsDay) {
                                DayDivider(message.ts)
                            }
                            CloudMessageBubble(
                                message = message,
                                modifier = Modifier.padding(top = 6.dp),
                                selectionCount = selection.count,
                                selected = message.id in selection.ids,
                                selectionAllOwn = selectionAllOwn,
                                onEnterSelection = { enterSelection(message.id) },
                                onToggleSelection = { toggleSelection(message.id) },
                                onForward = { forwarding = listOf(message.id) },
                                selfLogin = selfLogin,
                                peerReadAt = state.peerReadAt,
                                peerReadVia = state.peerReadVia,
                                nameOf = nameOf,
                                showAuthor = peer.official || peer.bot,
                                gallery = gallery,
                                unreadReactions = reactionsByMessage[message.id].orEmpty(),
                                reactionViewport = transcriptViewport,
                                onReactionsVisible = controller::readReactions,
                                resolveMedia = controller::resolveMedia,
                                previewLoader = controller.linkPreviews,
                                onReact = { emoji, add -> controller.react(message.id, emoji, add) },
                                onReply = {
                                    finishContext()
                                    replyTo = quoteOf(message, selfLogin, peer.login)
                                },
                                onRemind = { dueAt ->
                                    controller.scheduleReplyReminder(peer.login, message.id, dueAt)
                                },
                                reminded = message.id in state.reminderIds,
                                onEdit = {
                                    preEditDraft = draftText
                                    pendingEditingId = null
                                    replyTo = null
                                    editing = message
                                    draftText = message.text
                                },
                                // While a selection exists the menu's delete
                                // rows speak — and act — for the whole of it;
                                // otherwise this is the bubble's own message,
                                // exactly as before.
                                onDelete = { forEveryone ->
                                    if (selection.active) deleteSelection(forEveryone)
                                    else controller.deleteMessages(listOf(message.id), forEveryone)
                                },
                                onAction = { controller.sendBotValue(it.value) },
                            )
                        }
                    }
                    // The top of the thread in a reversed list is its last item.
                    // With no network this is the only way further back: the
                    // server's `/history` takes a limit and no cursor, so
                    // "earlier" can only come from this device's own cache.
                    if (state.olderAvailable) {
                        item(key = "older") {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                horizontalArrangement = Arrangement.Center,
                            ) {
                                Box(
                                    Modifier
                                        .tailchatSurface(
                                            shape = CircleShape,
                                            fill = MaterialTheme.colorScheme.surfaceVariant,
                                            elevation = depth.card,
                                            lights = listOf(depth.sheenBrush()),
                                        )
                                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
                                        .clip(CircleShape)
                                        .clickable(role = Role.Button, onClick = controller::loadOlder),
                                ) {
                                    Text(
                                        stringResource(R.string.cloud_load_older),
                                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurface,
                                    )
                                }
                            }
                        }
                    }
                }
                if (!followingLatest && state.messages.isNotEmpty()) {
                    // Separate from the arrow on purpose: a corner badge layered
                    // above it, not a label sharing its row — the arrow alone
                    // means "scroll down", the badge is the only thing that
                    // means "something is unread" (mirrors web's `.scroll-badge`
                    // in app.css).
                    Box(modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp)) {
                        // Web's `.scroll-bottom-btn`: sheen, `--elev-2` and the
                        // accent's glow under it.
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier.size(44.dp)
                                .tailchatSurface(
                                    shape = CircleShape,
                                    fill = MaterialTheme.colorScheme.surfaceVariant,
                                    elevation = depth.bar,
                                    lights = listOf(depth.sheenBrush()),
                                    extraShadows = listOf(depth.accentGlow),
                                )
                                .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
                                .clip(CircleShape)
                                .clickable(role = Role.Button) {
                                    followingLatest = true
                                    unseenMessages = 0
                                    scope.launch {
                                        listState.animateScrollToItem(0)
                                        controller.markConversationRead(peer.login)
                                    }
                                },
                        ) {
                            Icon(
                                Icons.Filled.KeyboardArrowDown,
                                contentDescription = stringResource(R.string.cloud_jump_down),
                                modifier = Modifier.size(22.dp),
                                tint = MaterialTheme.colorScheme.onSurface,
                            )
                        }
                        if (unseenMessages > 0) {
                            Surface(
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.error,
                                contentColor = MaterialTheme.colorScheme.onError,
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .offset(x = 4.dp, y = (-4).dp)
                                    .size(18.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Text(unseenMessages.toString(), style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                }
            }
            // The dashed, three-dot chip the transcript shows in place of a
            // message while the peer is composing one — matching web's own
            // `.typing-chip` (app.css:2272-2310), not a text line borrowed
            // from the header subtitle above.
            AnimatedVisibility(visible = state.peerIsTyping) {
                TypingBubble(label = "${braced(displayName)} ${stringResource(R.string.cloud_typing_indicator)}")
            }
            FailedOperationsStrip(
                failed = remember(state.failed, state.selectedPeer) {
                    state.failed.filter { it.peer == state.selectedPeer }
                },
                onRetry = controller::retryFailed,
            )
            // The service account is the one conversation that can open with
            // nothing in it — see `serviceMenuOffered` — so its menu is offered
            // through this bar rather than through a widget of its own: the
            // same rail the account's real buttons arrive on, and the same road
            // out (`performBotAction` → `sendBotValue`), so `/help` reaches the
            // server instead of the local command runner.
            val botMenuLabel = stringResource(R.string.cloud_bot_menu)
            val actions = remember(state.botActions, state.messages, state.loadingHistory, peer.login, botMenuLabel) {
                if (serviceMenuOffered(state.botActions, peer, state.messages.size, state.loadingHistory)) {
                    listOf(CloudBotAction(id = "service-menu", label = botMenuLabel, value = "/help"))
                } else {
                    state.botActions
                }
            }
            BotActionsBar(
                actions = actions,
                enabled = !peer.blocked,
                onAction = controller::performBotAction,
            )
            // The selection bar takes the composer's own slot, the one place
            // web puts its bar too (`#selection-bar`, index.html:257) — one
            // band, never two: while the mode is up nothing is being typed.
            // A live voice capture keeps the slot instead, so the recording
            // can still be stopped; web hides its bar for exactly that reason
            // (`renderSelectionState`, app.js:9832).
            if (selection.active && state.voiceRecordingElapsedSec == null) {
                CloudSelectionBar(
                    count = selection.count,
                    allOwn = selectionAllOwn,
                    modifier = Modifier.height(composerHeight),
                    onForward = {
                        // The picker is what asks «кому», and the mode has
                        // already done its job — leave it before the sheet goes
                        // up, as web does (app.js:6152-6164).
                        val ids = selectedIdsInOrder()
                        selection = selection.clear()
                        forwarding = ids
                    },
                    onDelete = deleteSelection,
                    onCancel = { selection = selection.clear() },
                )
            } else {
                CloudComposer(
                    controller = controller,
                    uiViewModel = uiViewModel,
                    modifier = Modifier.onSizeChanged { composerHeightPx = it.height },
                    // The composer is never taken away: a message typed while the
                    // socket is down is queued, not refused (see CloudOutbox).
                    online = state.link == CloudLink.Online && state.subscribedPeer == state.selectedPeer,
                    blocked = peer.blocked,
                    recordingElapsedSec = state.voiceRecordingElapsedSec,
                    draftText = draftText,
                    onDraftChange = { draftText = if (editing?.image != null) net.tailchat.android.cloud.limitImageCaption(it) else it },
                    replyTo = replyTo,
                    replyAuthor = replyTo?.from?.let(nameOf),
                    editing = editing,
                    onCancelContext = cancelContext,
                    onFinishContext = finishContext,
                    onSend = controller::send,
                    onCommitEdit = { text -> editing?.let { controller.editMessage(it.id, text) } },
                    onTyping = controller::keystroke,
                )
            }
        }
    }
    }
}

/**
 * Whether this client offers the service account's menu itself, because the
 * conversation holds nothing that could offer it instead.
 *
 * `{tailchat}` is the one thread that can open blank: the account never speaks
 * first into a conversation somebody has already used (AGENTS.md §9), and a
 * history cleared for oneself is empty again — so there is no message to carry
 * the buttons, and the menu behind `/help` is unreachable to anyone who does
 * not already know it is there. A brand-new account gets that menu as a message
 * at registration (`serviceBot.welcome`); this covers the thread that is empty
 * for any other reason.
 *
 * The *service* account only, never the assistant: `official` is true for both,
 * and `/help` is a command only the former answers. And only once the history
 * has answered — a button that appears and then vanishes under the reader is
 * worse than one that comes late.
 */
internal fun serviceMenuOffered(
    live: List<CloudBotAction>,
    peer: CloudUser,
    messageCount: Int,
    loadingHistory: Boolean,
): Boolean = live.isEmpty() &&
    peer.login == SERVICE_ACCOUNT_LOGIN &&
    messageCount == 0 &&
    !loadingHistory

/** The bot's live buttons over the composer — a card on the dock's inset
 *  (web 1.128's `.bot-actions`): the stronger glass, the glass line,
 *  `radius-l` and `--elev-1`. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BotActionsBar(
    actions: List<CloudBotAction>,
    enabled: Boolean,
    onAction: (CloudBotAction) -> Unit,
) {
    val depth = LocalTailchatDepth.current
    val accents = LocalTailchatAccents.current
    val shape = MaterialTheme.shapes.large
    AnimatedVisibility(visible = actions.isNotEmpty()) {
        FlowRow(
            modifier = Modifier.fillMaxWidth()
                .padding(start = DOCK_INSET, end = DOCK_INSET, bottom = 8.dp)
                .tailchatSurface(shape, accents.glassStrong, depth.card, listOf(depth.sheenBrush()))
                .border(1.dp, accents.glassLine, shape)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            actions.forEach { action ->
                OutlinedButton(
                    onClick = { onAction(action) },
                    enabled = enabled,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(action.label, maxLines = 1)
                }
            }
        }
    }
}
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MessageInlineButtons(
    buttons: List<CloudBotAction>,
    enabled: Boolean,
    onAction: (CloudBotAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    FlowRow(
        modifier = modifier.fillMaxWidth().padding(top = 6.dp, bottom = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        buttons.forEach { action ->
            OutlinedButton(
                onClick = { onAction(action) },
                enabled = enabled,
                shape = CircleShape,
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text(action.label, maxLines = 1, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}


/**
 * The snapshot a reply carries: the id, the author's login and up to 200
 * characters of what was said — the exact shape `normalizeReplyTo`
 * (`src/cloud/accounts.js:156`) keeps. A media row is named rather than
 * copied, so quoting a photo does not re-send the photo.
 */
private fun quoteOf(message: CloudMessage, selfLogin: String, peerLogin: String) = CloudReply(
    id = message.id,
    from = if (message.mine) selfLogin else peerLogin,
    text = message.text.take(200),
    media = when {
        message.image != null -> "image"
        message.voice != null -> "voice"
        message.attachment != null -> "file"
        else -> null
    },
)

/** Shared receipt dimensions: vector height and queued/failed text size.
 *  Bubble, roster and P2P marks all use the canonical geometry at 11dp. */
internal val RECEIPT_SIZE = 11.sp
internal val RECEIPT_HEIGHT = 11.dp

/**
 * One ladder, shared with the web (`setMark` in `web/cloud/app.js`): ⧗ until
 * the server has committed the message, ✓ once it has, ✓✓ once the peer's
 * *device* holds it (Delivered) or their read watermark has passed it (Read),
 * ⚠ when the send is not coming back and needs a decision.
 *
 * The hourglass means «this has not left this device yet», not «the other side
 * has not answered»: a message the server took is sent, and showing it as
 * pending until the peer's client happened to be open read as «оно долго
 * отправляется».
 *
 * Read and Delivered draw the same doubled mark on purpose: the two rungs are
 * ordered, and the honest difference between them is the accent colour
 * ([cloudReceiptColor]), not a third glyph no client could agree on. Only the
 * rank matters to what the user is told — "the other side has it" — and a mark
 * that never walks backwards is what keeps a delayed `Accepted` from pulling a
 * ✓✓ back down to ✓.
 */
internal fun cloudReceiptGlyph(delivery: CloudDelivery): String = when (delivery) {
    CloudDelivery.Read, CloudDelivery.Delivered -> "✓✓"
    CloudDelivery.Queued, CloudDelivery.Sending -> "⧗"
    CloudDelivery.Accepted -> "✓"
    // Not a clock any more: the queue gave up and the user has a decision to
    // make, which an hourglass would keep hiding.
    CloudDelivery.Failed -> "⚠"
}

@Composable
private fun cloudReceiptColor(message: CloudMessage): Color = when (message.delivery) {
    CloudDelivery.Read -> MaterialTheme.colorScheme.primary
    CloudDelivery.Queued, CloudDelivery.Sending -> MaterialTheme.colorScheme.onSurface
    CloudDelivery.Accepted, CloudDelivery.Delivered -> MaterialTheme.colorScheme.onSurface
    CloudDelivery.Failed -> MaterialTheme.colorScheme.error
}

/** `── СЕГОДНЯ ──`: a rule with a date in the middle, drawn on the text grid
 *  rather than as a chip — the same shape the terminal transcript uses. */
@Composable
private fun DayDivider(ts: Long) {
    val now = System.currentTimeMillis()
    val label = when {
        sameDay(ts, now) -> stringResource(R.string.cloud_day_today)
        sameDay(ts, now - 86_400_000L) -> stringResource(R.string.cloud_day_yesterday)
        else -> cloudDay.format(Date(ts))
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            text = label.uppercase(),
            modifier = Modifier.padding(horizontal = 8.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** Current web layout: compact text, bare images/jumbo and separate reactions. */
@OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun CloudMessageBubble(
    message: CloudMessage,
    selfLogin: String,
    peerReadAt: Long = 0L,
    peerReadVia: String = "",
    nameOf: (String) -> String,
    showAuthor: Boolean = false,
    gallery: List<GalleryImage> = emptyList(),
    reminded: Boolean = false,
    selectionCount: Int = 0,
    selected: Boolean = false,
    selectionAllOwn: Boolean = false,
    onEnterSelection: () -> Unit = {},
    onToggleSelection: () -> Unit = {},
    resolveMedia: (String) -> String?,
    previewLoader: net.tailchat.android.cloud.LinkPreviewLoader,
    onReact: (String, Boolean) -> Unit,
    unreadReactions: List<net.tailchat.android.cloud.CloudReactionEvent> = emptyList(),
    reactionViewport: androidx.compose.ui.geometry.Rect = androidx.compose.ui.geometry.Rect.Zero,
    onReactionsVisible: (List<String>) -> Unit,
    onReply: () -> Unit,
    onForward: () -> Unit,
    onRemind: (Long) -> Unit,
    onEdit: () -> Unit,
    onDelete: (Boolean) -> Unit,
    onAction: (CloudBotAction) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    if (message.system) { SystemNoteRow(message, modifier); return }
    if (message.deletedAt != null) { DeletedMessageMarker(message, modifier); return }
    val accents = LocalTailchatAccents.current
    val corners = LocalTailchatCorners.current
    val depth = LocalTailchatDepth.current
    val maxWidth = minOf((LocalConfiguration.current.screenWidthDp * 0.88f).dp, 560.dp)
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val table = emojiTable()
    val hasMedia = message.image != null || message.voice != null || message.attachment != null || message.call != null
    val jumbo = !hasMedia && message.replyTo == null && message.forwardedFrom == null && message.buttons.isEmpty() && isJumboEmoji(message.text, table)
    val caption = remember(message.text, message.image != null) { imageCaptionOf(message.text).orEmpty() }
    val bareImage = message.image != null && caption.isEmpty()
    val imageSize = if (bareImage) null else message.image?.let { image ->
        remember(message.id) { mutableStateOf(androidx.compose.ui.unit.IntSize(image.width, image.height)) }
    }
    val bare = bareImage || jumbo
    val previewsEnabled by AppPreferences.linkPreviews.collectAsState()
    val previewUrl = remember(message.text, hasMedia, previewsEnabled) {
        if (previewsEnabled && (message.image != null || !hasMedia)) firstLinkIn(message.text) else null
    }
    var previewShown by remember(previewUrl) { mutableStateOf(false) }
    val shape = bubbleShape(message.mine, corners)
    var menuOpen by remember(message.id) { mutableStateOf(false) }
    var quickOpen by remember(message.id) { mutableStateOf(false) }
    val hoverSource = remember(message.id) { MutableInteractionSource() }
    val hovered by hoverSource.collectIsHoveredAsState()
    var hoverSuppressed by remember(message.id) { mutableStateOf(false) }
    var quickCollapsed by remember(message.id) { mutableStateOf(false) }
    LaunchedEffect(hovered) { if (!hovered) hoverSuppressed = false }
    LaunchedEffect(hovered, hoverSuppressed, selectionCount, menuOpen) {
        if (hovered && !hoverSuppressed && selectionCount == 0 && !menuOpen) {
            kotlinx.coroutines.delay(500)
            quickCollapsed = true
            quickOpen = true
        } else if (!hovered && quickCollapsed) {
            kotlinx.coroutines.delay(200)
            if (quickCollapsed) quickOpen = false
        }
    }
    val timeLabel = remember(message.ts) { cloudClock.format(Date(message.ts)) }
    val peerLabel = if (message.mine) "" else nameOf(message.peer).takeIf { it.isNotBlank() && it != message.peer }
        ?: message.author.ifBlank { message.peer }
    val onHold = {
        quickOpen = false
        if (selectionCount > 0 && !selected) onToggleSelection() else menuOpen = true
    }
    val onTap = {
        if (selectionCount > 0) onToggleSelection()
        else { quickCollapsed = false; quickOpen = true }
    }
    val tapMessage by rememberUpdatedState(onTap)
    val holdMessage by rememberUpdatedState(onHold)
    val viewConfiguration = LocalViewConfiguration.current
    val holdConfiguration = remember(viewConfiguration) {
        object : ViewConfiguration by viewConfiguration { override val longPressTimeoutMillis = 500L }
    }
    val imageWidth = imageSize?.let { state ->
        val size = state.value
        val ratio = if (size.width > 0 && size.height > 0) size.width.toFloat() / size.height else 4f / 3f
        val capped = if (ratio >= 1f) 480.dp else 480.dp * ratio
        minOf(maxWidth, capped, if (size.width > 0) size.width.dp else capped)
    }
    val meta: @Composable (Boolean) -> Unit = { overlay ->
        MessageMeta(message, timeLabel, reminded, overlay)
    }
    CompositionLocalProvider(LocalViewConfiguration provides holdConfiguration,
        androidx.compose.material3.LocalContentColor provides MaterialTheme.colorScheme.onSurface) {
        Row(
            modifier.fillMaxWidth().pointerInput(message.id) {
                detectTapGestures(onTap = { tapMessage() }, onLongPress = { holdMessage() })
            },
            horizontalArrangement = if (message.mine) Arrangement.End else Arrangement.Start,
        ) {
            Box {
                Column(Modifier.widthIn(max = maxWidth)) {
                    Box(
                        modifier = (if (imageWidth != null) Modifier.width(maxOf(imageWidth, minOf(160.dp, maxWidth))) else Modifier)
                            .align(if (message.mine) Alignment.End else Alignment.Start)
                            .widthIn(min = if (previewShown && imageWidth == null) minOf(320.dp, maxWidth) else 0.dp)
                            .then(if (previewShown && imageWidth == null) Modifier.width(androidx.compose.foundation.layout.IntrinsicSize.Max) else Modifier)
                            .swipeToReply(enabled = selectionCount == 0, onReply = onReply)
                            .bubbleSemantics(
                                author = peerLabel, time = timeLabel,
                                body = message.call?.let { callLogLabel(it, message.mine) } ?: message.text,
                                deliveryLabel = if (message.mine) deliveryContentDescription(message.delivery) else null,
                                edited = message.editedAt != null, reminded = reminded, reactions = message.reactions,
                                onReply = onReply, onShowActions = { quickOpen = false; menuOpen = true },
                            )
                            .hoverable(hoverSource)
                            .onPreviewKeyEvent { event ->
                                if (event.type == KeyEventType.KeyDown && (event.key == Key.Menu || (event.key == Key.F10 && event.isShiftPressed))) {
                                    quickOpen = false; menuOpen = true; true
                                } else false
                            }
                            .pointerInput(message.id) {
                                awaitPointerEventScope {
                                    while (true) {
                                        val event = awaitPointerEvent(androidx.compose.ui.input.pointer.PointerEventPass.Initial)
                                        if (event.type == androidx.compose.ui.input.pointer.PointerEventType.Press && event.buttons.isSecondaryPressed) {
                                            quickOpen = false; menuOpen = true
                                            event.changes.forEach { it.consume() }
                                        }
                                    }
                                }
                            }
                            .combinedClickable(onClick = onTap, onLongClick = onHold)
                            .then(if (message.delivery == CloudDelivery.Queued || message.delivery == CloudDelivery.Sending)
                                Modifier.graphicsLayer {
                                    alpha = 0.7f
                                    clip = false
                                    compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.ModulateAlpha
                                } else Modifier)
                            .tailchatSurface(
                                if (bareImage) RectangleShape else shape,
                                when {
                                    bareImage -> Color.Transparent
                                    selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.28f)
                                        .compositeOver(if (bare) Color.Transparent else if (message.mine) accents.ownBubble else MaterialTheme.colorScheme.surfaceVariant)
                                    bare -> Color.Transparent
                                    message.mine -> accents.ownBubble
                                    else -> MaterialTheme.colorScheme.surfaceVariant
                                },
                                if (bare || selected) null else depth.bubble,
                                if (bare || selected) emptyList() else listOf(depth.sheenBrush()),
                            )
                            .then(if (bareImage) Modifier else Modifier.clip(shape))
                            .then(if (bare || !accents.outlines) Modifier else Modifier.border(1.dp,
                                if (message.mine) accents.ownBubbleBorder else accents.edgeSoft, shape)),
                        propagateMinConstraints = true,
                    ) {
                        Column(Modifier.padding(horizontal = if (message.image != null || jumbo) 0.dp else 14.dp,
                            vertical = if (message.image != null || jumbo) 0.dp else 7.dp)) {
                            if (showAuthor && !message.mine) Text(braced(peerLabel),
                                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                                color = MaterialTheme.colorScheme.secondary,
                                modifier = if (message.image != null) Modifier.padding(horizontal = 4.dp, vertical = 4.dp) else Modifier)
                            message.forwardedFrom?.let { origin ->
                                EmojiText(stringResource(R.string.cloud_msg_forwarded_from, origin.name.ifBlank { nameOf(origin.login) }),
                                    style = MaterialTheme.typography.labelSmall.copy(fontStyle = FontStyle.Italic),
                                    modifier = if (message.image != null) Modifier.padding(4.dp) else Modifier)
                            }
                            message.replyTo?.let { ReplyQuote(nameOf(it.from), it, mine = message.mine) }
                            message.image?.let { image ->
                                InlineImage(
                                    cacheKey = message.id, image = image,
                                    shape = if (bareImage) shape else RoundedCornerShape(topStart = corners.bubble, topEnd = corners.bubble),
                                    modifier = Modifier.align(Alignment.CenterHorizontally)
                                        .then(if (bareImage) Modifier.dropShadows(depth.bubble?.shadows.orEmpty(), shape) else Modifier),
                                    onNaturalSize = imageSize?.let { state -> { actual -> state.value = actual } },
                                    contentDescription = stringResource(R.string.cloud_image_caption),
                                    resolveMedia = resolveMedia, onLongClick = onHold,
                                    onClickOverride = if (selectionCount > 0) onToggleSelection else null,
                                    gallery = gallery,
                                    overlay = {
                                        if (selected) Box(Modifier.matchParentSize()
                                            .clip(if (bareImage) shape else RoundedCornerShape(topStart = corners.bubble, topEnd = corners.bubble))
                                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)))
                                        if (bareImage) Box(Modifier.align(if (message.mine) Alignment.BottomEnd else Alignment.BottomStart)
                                            .wrapContentSize(if (message.mine) Alignment.BottomEnd else Alignment.BottomStart, unbounded = true)
                                            .padding(5.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape)
                                            .combinedClickable(onClickLabel = stringResource(R.string.emoji_quick_settings), onClick = onTap, onLongClick = onHold)
                                            .padding(horizontal = 6.dp, vertical = 2.dp)) { meta(true) }
                                    },
                                )
                                if (!bareImage) Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp)) {
                                    MessageBody(caption, message.mine, style = MaterialTheme.typography.bodyMedium.copy(lineHeight = MaterialTheme.typography.bodyMedium.fontSize * 1.35f),
                                        meta = if (previewShown) null else { { meta(false) } })
                                }
                            }
                            message.voice?.let { VoicePlayer(message.id, it, mine = message.mine, onLongClick = onHold) }
                            message.attachment?.let { CloudAttachmentContent(it) }
                            message.call?.let { CallLogRow(it, message.mine) }
                            if (!hasMedia) {
                                if (jumbo) {
                                    CompactMessageText(AnnotatedString(message.text), jumbo = true, meta = { meta(false) })
                                } else MessageBody(message.text, message.mine, meta = if (previewShown) null else { { meta(false) } })
                            }
                            previewUrl?.let { url ->
                                Box(Modifier.onSizeChanged { previewShown = it.height > 0 }) {
                                    LinkPreviewCard(url, previewLoader, onLongClick = onHold,
                                        onClickOverride = if (selectionCount > 0) onToggleSelection else null)
                                }
                                if (previewShown) Box(Modifier.align(Alignment.End).padding(horizontal = if (message.image != null) 4.dp else 0.dp)) { meta(false) }
                            }
                            if (message.buttons.isNotEmpty()) MessageInlineButtons(message.buttons, enabled = true, onAction = onAction)
                            if (hasMedia && message.image == null) Box(Modifier.align(Alignment.End)) { meta(false) }
                            if (!bareImage && message.reactions.isNotEmpty()) ReactionRow(message.reactions, selfLogin, onReact,
                                Modifier.padding(top = 4.dp).widthIn(max = maxWidth),
                                unreadEvents = unreadReactions, viewport = reactionViewport, onVisible = onReactionsVisible)
                        }
                    }
                    if (bareImage && message.reactions.isNotEmpty()) ReactionRow(message.reactions, selfLogin, onReact,
                        Modifier.align(if (message.mine) Alignment.End else Alignment.Start).padding(top = 4.dp).widthIn(max = maxWidth),
                        unreadEvents = unreadReactions, viewport = reactionViewport, onVisible = onReactionsVisible)
                }
                QuickReactionPopup(quickOpen, selfLogin, message.reactions, onReact,
                    onDismiss = { quickOpen = false; hoverSuppressed = hovered }, collapsed = quickCollapsed,
                    onExpand = { quickCollapsed = false }, own = message.mine)
                MessageActions(
                    expanded = menuOpen, message = message, peerReadAt = peerReadAt, peerReadVia = peerReadVia,
                    selectionCount = selectionCount, selectionAllOwn = selectionAllOwn,
                    onDismiss = { menuOpen = false }, onSelect = onEnterSelection,
                    onReply = onReply, onRemind = onRemind, onForward = onForward, onEdit = onEdit, onDelete = onDelete,
                    onCopy = {
                        clipboard.setText(AnnotatedString(message.text))
                        Toast.makeText(context, R.string.cloud_message_copied, Toast.LENGTH_SHORT).show()
                    },
                )
            }
        }
    }
}


@Composable
private fun MessageMeta(message: CloudMessage, time: String, reminded: Boolean, overlay: Boolean) {
    val accents = LocalTailchatAccents.current
    val quiet = if (overlay) Color.White else if (message.mine) accents.ownMuted else accents.peerMuted
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(time, style = MaterialTheme.typography.labelSmall.copy(fontFamily = TailchatMono), color = quiet)
        if (message.mine) CloudReceiptMark(message.delivery,
            color = if (message.delivery == CloudDelivery.Read || message.delivery == CloudDelivery.Failed) cloudReceiptColor(message) else quiet,
            outline = if (overlay && message.delivery == CloudDelivery.Read)
                if (MaterialTheme.colorScheme.primary.luminance() > 0.4f) Color.Black else Color.White
                else null)
        if (message.editedAt != null) Text("✎", style = MaterialTheme.typography.labelSmall, color = quiet)
        if (reminded) Text("⏰", style = MaterialTheme.typography.labelSmall, color = quiet)
    }
}

/**
 * §4.5's compact call bubble: an icon naming direction/outcome plus a label,
 * reusing the same [CloudMessageBubble] scaffold (surface, `{name}`/`{you}`
 * header, clock, receipt glyph) every other kind already gets — a call is
 * just a different kind of content inside it, the same way [VoicePlayer] or
 * an image is.
 */
@Composable
private fun CallLogRow(call: CloudCall, mine: Boolean) {
    val missed = call.outcome == CallOutcome.MISSED || call.outcome == CallOutcome.DECLINED
    val icon = when {
        call.outcome == CallOutcome.MISSED -> Icons.AutoMirrored.Filled.CallMissed
        call.outcome == CallOutcome.ANSWERED_ELSEWHERE -> Icons.AutoMirrored.Filled.CallReceived
        mine -> Icons.AutoMirrored.Filled.CallMade
        else -> Icons.AutoMirrored.Filled.CallReceived
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (missed) MaterialTheme.colorScheme.error else LocalContentColor.current,
            modifier = Modifier.size(18.dp),
        )
        Text(callLogLabel(call, mine), style = MaterialTheme.typography.bodyMedium)
    }
}

/** The label [CallLogRow] shows and the one [CloudMessageBubble] falls back
 *  to for accessibility — one function so the two can never say different
 *  things about the same call. */
@Composable
private fun callLogLabel(call: CloudCall, mine: Boolean): String {
    val base = when (call.outcome) {
        CallOutcome.MISSED -> stringResource(R.string.call_log_missed)
        CallOutcome.DECLINED -> stringResource(R.string.call_ended_declined)
        CallOutcome.CANCELED -> stringResource(R.string.call_log_canceled)
        CallOutcome.BUSY -> stringResource(R.string.call_ended_busy)
        CallOutcome.TIMEOUT -> stringResource(R.string.call_ended_timeout)
        CallOutcome.FAILED -> stringResource(R.string.call_ended_failed)
        CallOutcome.UNSUPPORTED -> stringResource(R.string.call_ended_unsupported)
        CallOutcome.ANSWERED_ELSEWHERE -> stringResource(R.string.call_log_answered_elsewhere)
        else -> if (mine) stringResource(R.string.call_log_outgoing) else stringResource(R.string.call_log_incoming)
    }
    return if (call.outcome == CallOutcome.ANSWERED) "$base · ${formatVoiceClock(call.durationSec)}" else base
}

/** A tombstone never carries the original text or media. The regular bubble
 * actions are deliberately absent: this marker is information, not a message
 * users can copy, reply to or alter. */
@Composable
private fun DeletedMessageMarker(message: CloudMessage, modifier: Modifier = Modifier) {
    val corners = LocalTailchatCorners.current
    val depth = LocalTailchatDepth.current
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (message.mine) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            modifier = Modifier.tailchatSurface(
                shape = bubbleShape(message.mine, corners),
                fill = MaterialTheme.colorScheme.surfaceVariant,
                elevation = depth.bubble,
                lights = listOf(depth.sheenBrush()),
            ),
            shape = bubbleShape(message.mine, corners),
            color = Color.Transparent,
            contentColor = MaterialTheme.colorScheme.onSurface,
            border = if (!LocalTailchatAccents.current.outlines) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Text(
                stringResource(R.string.cloud_msg_deleted),
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodyMedium,
                fontStyle = FontStyle.Italic,
            )
        }
    }
}

/**
 * The bubble's corner: the chosen radius everywhere except the corner nearest
 * the speaker, which is cut back to the tail step. That notch is what still
 * tells the two columns apart once both sides are pills.
 */
private fun bubbleShape(mine: Boolean, corners: TailchatCorners) = RoundedCornerShape(
    topStart = corners.bubble,
    topEnd = corners.bubble,
    bottomStart = if (mine) corners.bubble else corners.bubbleTail,
    bottomEnd = if (mine) corners.bubbleTail else corners.bubble,
)

/**
 * The dashed, bubble-shaped chip the transcript shows in place of a message
 * while the peer is composing one — the same shape as an incoming bubble
 * (via [bubbleShape]) but dashed and unfilled, so it reads as something
 * happening on the other side rather than another line in the thread; see
 * `.typing-chip` in web/cloud/app.css:2272-2285.
 */
@Composable
private fun TypingBubble(label: String) {
    val corners = LocalTailchatCorners.current
    val shape = bubbleShape(mine = false, corners = corners)
    val outline = LocalTailchatAccents.current.line
    val depth = LocalTailchatDepth.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 2.dp)) {
        Row(
            modifier = Modifier
                // Web 1.128 lifts the typing chip to `--elev-1` too: it sits
                // on the wallpaper now, like the messages it stands in for.
                .dropShadows(depth.bubble.shadows, shape)
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), shape)
                .dashedOutline(outline, shape)
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            TypingDots(MaterialTheme.colorScheme.secondary)
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Three dots keeping time — `tcTypingDot` in web/cloud/app.css:2295-2310:
 *  each brightens and lifts 2dp thirty percent of the way into a 1.2s loop,
 *  150ms after the dot before it, then settles back to wait its turn again. */
@Composable
private fun TypingDots(color: Color) {
    val transition = rememberInfiniteTransition(label = "typing-dots")
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        repeat(3) { index ->
            val bounce by transition.animateFloat(
                initialValue = 0f,
                targetValue = 0f,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = 1200
                        0f at 0
                        1f at 360
                        0f at 720
                    },
                    initialStartOffset = StartOffset(index * 150),
                ),
                label = "typing-dot-$index",
            )
            Box(
                Modifier.offset(y = (-2).dp * bounce).size(5.dp)
                    .background(color.copy(alpha = 0.35f + 0.65f * bounce), CircleShape),
            )
        }
    }
}

/** A dashed outline traced along [shape] — Compose has no dashed `border`
 *  modifier of its own, so the typing chip's edge (the one place the app
 *  wants a border that reads as provisional rather than committed, unlike
 *  every solid bubble) is drawn by hand with a dash path effect. */
private fun Modifier.dashedOutline(color: Color, shape: Shape, width: Dp = 1.dp): Modifier = drawWithContent {
    drawContent()
    val outline = shape.createOutline(size, layoutDirection, this)
    val path = when (outline) {
        is Outline.Generic -> outline.path
        is Outline.Rounded -> Path().apply { addRoundRect(outline.roundRect) }
        is Outline.Rectangle -> Path().apply { addRect(outline.rect) }
    }
    drawPath(
        path,
        color = color,
        style = Stroke(
            width = width.toPx(),
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()), 0f),
        ),
    )
}


private fun replyReminderDue(preset: String, now: Long = System.currentTimeMillis()): Long {
    if (preset == "15m") return now + 15 * 60 * 1000L
    if (preset == "1h") return now + 60 * 60 * 1000L
    val calendar = Calendar.getInstance().apply { timeInMillis = now }
    if (preset == "evening") {
        calendar.set(Calendar.HOUR_OF_DAY, 19)
        calendar.set(Calendar.MINUTE, 0)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)
        if (calendar.timeInMillis <= now) calendar.add(Calendar.DAY_OF_YEAR, 1)
        return calendar.timeInMillis
    }
    calendar.add(Calendar.DAY_OF_YEAR, 1)
    calendar.set(Calendar.HOUR_OF_DAY, 9)
    calendar.set(Calendar.MINUTE, 0)
    calendar.set(Calendar.SECOND, 0)
    calendar.set(Calendar.MILLISECOND, 0)
    return calendar.timeInMillis
}

/**
 * Which client the peer's read watermark came from — the server's `clientKind`
 * (`web`, `cli`, `android/<build>`), reduced to the three words this menu can
 * say. [labelRes] is the word, not the wire value: a build number is a fact
 * about the sender's install, not something to put next to the time.
 */
internal enum class ReadClient(val labelRes: Int) {
    Browser(R.string.cloud_read_client_web),
    Terminal(R.string.cloud_read_client_cli),
    Phone(R.string.cloud_read_client_android),
}

/**
 * [via] as this menu understands it, or null when it names no client that can
 * be labelled — the empty string of a snapshot written before the server
 * tracked this, and anything a newer server may start sending. Null is
 * deliberately "say nothing": the detail then reads «Прочитано: 14:44», never
 * «… · web2» or any other guess. AGENTS.md §10's rule about a detail row also
 * applies to what it says: the client word is only there when it is true.
 */
internal fun readClientOf(via: String): ReadClient? = when {
    via == "web" -> ReadClient.Browser
    via == "cli" -> ReadClient.Terminal
    via.startsWith("android") -> ReadClient.Phone
    else -> null
}

/**
 * The detail's value: the time, and the client when there is one to name —
 * «14:44 · телефон». Separator and client are one optional tail, so an unknown
 * client leaves exactly the time and the caller's «Прочитано: %1$s» stands
 * unchanged — the same string a client-less snapshot produced before any of
 * this existed.
 */
internal fun readDetailValue(time: String, client: String?): String =
    if (client.isNullOrBlank()) time else "$time · $client"

/**
 * The message multi-select — this client's side of the mode web drives with
 * `selectionMode`/`selectedIds` (`web/cloud/app.js:9754-9845`), in the shape
 * the owner gave it here: «hold на бабл; и дальше другие сообщения можно
 * выделить уже обычным нажатием».
 *
 * Held as a plain value and remembered inside [CloudConversation], not on
 * [CloudState]: the mode is conversation-local, and the whole conversation is
 * disposed by the `key(state.selectedPeer)` wrapper when the open peer
 * changes — which is one of the three ways the mode ends (web's
 * `exitSelectionMode` on a conversation switch, app.js:9778).
 *
 * An empty set *is* the mode being off. Nothing but the transcript can name a
 * message, so the last one leaving — by a tap, or by a redraw that no longer
 * carries it — puts the mode back to rest exactly as web's own
 * `exitSelectionMode` does.
 */
internal data class CloudSelection(val ids: Set<String> = emptySet()) {
    val active: Boolean get() = ids.isNotEmpty()
    val count: Int get() = ids.size

    /** The selection starts with the pressed message and nothing else. */
    fun enter(id: String): CloudSelection = CloudSelection(setOf(id))

    /** A tap while the mode is on: in if it was out, out if it was in. */
    fun toggle(id: String): CloudSelection =
        if (id in ids) CloudSelection(ids - id) else CloudSelection(ids + id)

    /** Drops ids the transcript no longer draws — a message deleted on another
     *  device, or a page that no longer holds it — so the count can never name
     *  a message that is not on screen (web prunes the same way in
     *  `renderSelectionState`, app.js:9813-9821). */
    fun retain(live: Set<String>): CloudSelection =
        if (ids.isEmpty()) this else CloudSelection(ids intersect live)

    fun clear(): CloudSelection = CloudSelection()
}

/**
 * The selected messages in the order the conversation holds them — the order
 * both the forward and the delete go out in, never the order the bubbles were
 * tapped (web's `selectedIdsInOrder`, app.js:9802: «messages marked bottom-up
 * must still be forwarded and deleted in the order they were written in»).
 * [CloudState.messages] is chronological, so filtering it *is* that order.
 */
internal fun cloudSelectedInOrder(messages: List<CloudMessage>, ids: Set<String>): List<CloudMessage> =
    if (ids.isEmpty()) emptyList() else messages.filter { it.id in ids }

/**
 * Whether «Удалить у всех» may be offered for a selection: the server purges
 * the shared conversation for what *this account* wrote, so the scope is
 * offered exactly when every selected message is this account's own — web's
 * `allOwn` test in `openBulkDeleteMenu` (app.js:9891-9894). An empty
 * selection offers it to nobody.
 */
internal fun cloudSelectionAllOwn(selected: List<CloudMessage>): Boolean =
    selected.isNotEmpty() && selected.all { it.mine }

/** Actions only; reactions live in their own compact column. */
@Composable
private fun MessageActions(
    expanded: Boolean,
    message: CloudMessage,
    peerReadAt: Long,
    peerReadVia: String,
    /** How many messages the open selection holds, and whether every one of
     *  them is this account's own — the two facts the delete rows need to
     *  speak for the selection instead of for [message]. Zero means no
     *  selection, and then every row below behaves exactly as it did before
     *  this mode existed. */
    selectionCount: Int = 0,
    selectionAllOwn: Boolean = false,
    onDismiss: () -> Unit,
    onSelect: () -> Unit,
    onReply: () -> Unit,
    onRemind: (Long) -> Unit,
    onForward: () -> Unit,
    onEdit: () -> Unit,
    /** Deletes what the rows name: the bubble's own message, or the whole
     *  selection while one exists (the bubble's caller decides which). */
    onDelete: (Boolean) -> Unit,
    onCopy: () -> Unit,
) {
    val canEdit = message.mine && message.text.isNotBlank() &&
        message.voice == null && message.attachment == null
    // One line, and from it the others — same shape as web's `.msg-menu`
    // reminder picker: picking "Remind to reply" swaps this dropdown's
    // content to the four presets instead of a fifth flat row growing the
    // primary menu for every preset it ever gains.
    var showReminderPresets by remember(expanded, message.id) { mutableStateOf(false) }
    TailchatDropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        if (showReminderPresets) {
            Text(
                stringResource(R.string.cloud_msg_remind),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            )
            MessageAction(Icons.Filled.AlarmAdd, stringResource(R.string.cloud_msg_remind_15m)) {
                onDismiss(); onRemind(replyReminderDue("15m"))
            }
            MessageAction(Icons.Filled.AlarmAdd, stringResource(R.string.cloud_msg_remind_1h)) {
                onDismiss(); onRemind(replyReminderDue("1h"))
            }
            MessageAction(Icons.Filled.AlarmAdd, stringResource(R.string.cloud_msg_remind_evening)) {
                onDismiss(); onRemind(replyReminderDue("evening"))
            }
            MessageAction(Icons.Filled.AlarmAdd, stringResource(R.string.cloud_msg_remind_tomorrow)) {
                onDismiss(); onRemind(replyReminderDue("tomorrow"))
            }
            return@TailchatDropdownMenu
        }
        MessageAction(Icons.AutoMirrored.Filled.Reply, stringResource(R.string.cloud_msg_reply)) {
            onDismiss(); onReply()
        }
        MessageAction(Icons.AutoMirrored.Filled.Send, stringResource(R.string.cloud_msg_forward)) {
            onDismiss(); onForward()
        }
        MessageAction(Icons.Filled.AlarmAdd, stringResource(R.string.cloud_msg_remind)) {
            showReminderPresets = true
        }
        if (message.text.isNotBlank()) {
            MessageAction(Icons.Filled.ContentCopy, stringResource(R.string.cloud_copy)) {
                onDismiss(); onCopy()
            }
        }
        if (canEdit) {
            MessageAction(Icons.Filled.Edit, stringResource(R.string.cloud_msg_edit)) {
                onDismiss(); onEdit()
            }
        }
        MessageAction(Icons.Filled.DoneAll, stringResource(R.string.message_select)) {
            onDismiss(); onSelect()
        }
        // «и далее если вызвать меню то "удалить (кол-во)"» — while a selection
        // is up the two delete rows act on the whole of it; the count in their
        // labels is what says so. The everyone scope is offered on web's own
        // terms (`openBulkDeleteMenu`, app.js:9888-9912): only when every
        // selected message is this account's own, and never for a bubble
        // somebody else wrote, which is the same condition one message at a
        // time. With no selection these are the rows they have always been.
        if (selectionCount > 0) {
            MessageAction(
                Icons.Filled.Delete,
                stringResource(R.string.cloud_msg_delete_self_count, selectionCount),
            ) {
                onDismiss(); onDelete(false)
            }
            if (selectionAllOwn) {
                MessageAction(
                    Icons.Filled.Delete,
                    stringResource(R.string.cloud_msg_delete_all_count, selectionCount),
                    tint = MaterialTheme.colorScheme.error,
                ) {
                    onDismiss(); onDelete(true)
                }
            }
        } else {
            MessageAction(Icons.Filled.Delete, stringResource(R.string.cloud_msg_delete_self)) {
                onDismiss(); onDelete(false)
            }
            if (message.mine) {
                MessageAction(
                    Icons.Filled.Delete,
                    stringResource(R.string.cloud_msg_delete_all),
                    tint = MaterialTheme.colorScheme.error,
                ) {
                    onDismiss(); onDelete(true)
                }
            }
        }
        if ((message.mine && message.delivery == CloudDelivery.Read && peerReadAt > 0L) || message.editedAt != null) {
            HorizontalDivider(color = LocalTailchatAccents.current.lineSoft)
            if (message.mine && message.delivery == CloudDelivery.Read && peerReadAt > 0L) {
                val client = readClientOf(peerReadVia)?.let { stringResource(it.labelRes) }
                Text(
                    stringResource(R.string.cloud_msg_read_at, readDetailValue(cloudClock.format(Date(peerReadAt)), client)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
            message.editedAt?.let { edited ->
                Text(
                    stringResource(R.string.message_edited_at, cloudClock.format(Date(edited))),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/** «Переслать кому»: opens the same roster the contacts list itself uses —
 *  avatars, presence, unread badges and all — rather than a bare list of
 *  names, so picking a forward target looks and behaves like the roster it
 *  already is, not a second, thinner UI for the same list. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ForwardPickerDialog(
    users: List<CloudUser>,
    selfLogin: String,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    val savedMessagesTitle = stringResource(R.string.cloud_saved_messages)
    val savedMessagesHint = stringResource(R.string.cloud_saved_messages_hint)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = LocalTailchatAccents.current.glassSheet,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Text(
            stringResource(R.string.cloud_msg_forward_to),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
        )
        val targets = remember(users, selfLogin) { users.filter { it.login != selfLogin } }
        LazyColumn(
            modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item(key = "self") {
                CloudUserRow(
                    user = CloudUser(login = selfLogin, name = savedMessagesTitle),
                    selfLogin = selfLogin,
                    title = savedMessagesTitle,
                    subtitle = savedMessagesHint,
                    serviceStyle = true,
                    saved = true,
                    onClick = { onPick(selfLogin) },
                )
            }
            items(targets, key = CloudUser::login) { target ->
                CloudUserRow(
                    user = target,
                    selfLogin = selfLogin,
                    onClick = { onPick(target.login) },
                )
            }
        }
        Spacer(Modifier.navigationBarsPadding().height(8.dp))
    }
}

/**
 * Every menu in the app at the deepest step of the scale — web 1.128 puts
 * `.msg-menu`, the command palette and the dialogs at `--elev-3`. A menu lives
 * in its own popup window, where a hand-painted shadow would be cut off at the
 * window's edge, so it uses the platform's shadow at [TailchatDepth.popup]
 * plus the glass line, and keeps Material's own surface and shape.
 */
@Composable
internal fun TailchatDropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        shadowElevation = LocalTailchatDepth.current.popup,
        border = BorderStroke(1.dp, LocalTailchatAccents.current.glassLine),
        content = content,
    )
}

@Composable
private fun MessageAction(
    icon: ImageVector,
    label: String,
    tint: Color = LocalContentColor.current,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = { Text(label, style = MaterialTheme.typography.labelLarge, color = tint) },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = tint) },
        enabled = enabled,
        onClick = onClick,
        contentPadding = MenuDefaults.DropdownMenuItemContentPadding,
    )
}

/** A separate reaction strip; only completely visible chips acknowledge server events. */
@Composable
private fun ReactionRow(
    reactions: Map<String, List<String>>,
    selfLogin: String,
    onReact: (String, Boolean) -> Unit,
    modifier: Modifier = Modifier,
    unreadEvents: List<net.tailchat.android.cloud.CloudReactionEvent>,
    viewport: androidx.compose.ui.geometry.Rect,
    onVisible: (List<String>) -> Unit,
) {
    var strip by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Row(
        modifier = modifier.onGloballyPositioned { strip = it.boundsInWindow() }.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for ((emoji, members) in reactions) {
            val mine = selfLogin in members
            val events = remember(unreadEvents, emoji) { unreadEvents.filter { it.emoji == emoji }.map { it.id } }
            var bounds by remember(emoji) { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
            val visible = bounds.width > 0 && bounds.height > 0 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom &&
                bounds.left >= maxOf(viewport.left, strip.left) && bounds.right <= minOf(viewport.right, strip.right)
            LaunchedEffect(events, visible) { if (visible && events.isNotEmpty()) onVisible(events) }
            Surface(
                shape = CircleShape,
                color = if (events.isNotEmpty()) MaterialTheme.colorScheme.secondary.copy(alpha = 0.20f).compositeOver(MaterialTheme.colorScheme.surfaceVariant)
                    else if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                contentColor = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.widthIn(min = 30.dp).onGloballyPositioned {
                    bounds = androidx.compose.ui.geometry.Rect(it.positionInWindow(),
                        Size(it.size.width.toFloat(), it.size.height.toFloat()))
                }.clickable { onReact(emoji, !mine) },
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AppleEmoji(emoji, Modifier.size(15.dp))
                    Spacer(Modifier.width(3.dp))
                    Text(members.size.toString(), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

/** The quote a reply carries, drawn the way web's `.reply-quote` is: an accent
 *  edge, the author in braces, and one or two lines of what was said. */
@Composable
private fun ReplyQuote(author: String, quote: CloudReply, mine: Boolean) {
    val mediaLabel = when (quote.media) {
        "image" -> stringResource(R.string.cloud_image_caption)
        "voice" -> stringResource(R.string.cloud_voice_caption)
        "file" -> stringResource(R.string.cloud_attachment_caption)
        else -> ""
    }
    val authorColor = if (mine) LocalTailchatAccents.current.ownAccent else MaterialTheme.colorScheme.primary
    Row(
        modifier = Modifier.padding(bottom = 5.dp)
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
            .height(IntrinsicSize.Min),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(authorColor))
        Column(Modifier.padding(horizontal = 7.dp, vertical = 4.dp)) {
            Text(
                braced(author),
                style = MaterialTheme.typography.labelSmall,
                color = authorColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            EmojiText(
                text = quote.text.ifBlank { mediaLabel },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private val urlPattern = Regex("""https?://\S+""")

private fun linkify(text: String, linkColor: Color): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (match in urlPattern.findAll(text)) {
        append(text, last, match.range.first)
        val url = match.value
        withLink(
            LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline))),
        ) { append(url) }
        last = match.range.last + 1
    }
    append(text, last, text.length)
}

/** Mirrors web/cloud/app.js's `appendMessage()` (lines ~3808-3823) exactly: the whole
 *  message is classified once, not line by line — a fenced block only renders as code
 *  when the *entire* text starts and ends with ``` , a blockquote only when the *entire*
 *  text starts with `"> "` (the rest, including any inner newlines, is the quote body
 *  verbatim, unlinked — web's blockquote branch never calls `formatTextWithLinks`).
 *  Everything else is `formatTextWithLinks()`'s plain, link-aware text. Line-by-line
 *  segmentation was tried and dropped: it renders the same message differently here than
 *  on web/term, which is a correctness bug, not a nicer feature. */
@Composable
private fun MessageBody(text: String, mine: Boolean, style: TextStyle = MaterialTheme.typography.bodyMedium,
    meta: (@Composable () -> Unit)? = null) {
    val linkColor = MaterialTheme.colorScheme.primary
    val complex = (text.length >= 6 && text.startsWith("```") && text.endsWith("```")) || text.startsWith("> ")
    when {
        text.length >= 6 && text.startsWith("```") && text.endsWith("```") -> Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHighest,
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text.removePrefix("```").removeSuffix("```").trim(),
                modifier = Modifier.padding(8.dp),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        text.startsWith("> ") -> Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(
                Modifier.width(3.dp).fillMaxHeight()
                    .background(LocalTailchatAccents.current.line, RoundedCornerShape(2.dp)),
            )
            Spacer(Modifier.width(8.dp))
            EmojiText(
                text.removePrefix("> "),
                style = style,
                color = if (mine) MaterialTheme.colorScheme.onSurface
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        else -> {
            val annotated = remember(text, linkColor) { linkify(text, linkColor) }
            if (meta == null) EmojiText(annotated, style = style)
            else CompactMessageText(annotated, style = style, meta = meta)
        }
    }
    if (complex && meta != null) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) { meta() }
}

private fun formatVoiceClock(totalSec: Int): String = "%d:%02d".format(totalSec / 60, totalSec % 60)

/** "1×" for a whole step, "1.25×" for a fractional one — [VOICE_PLAYBACK_SPEEDS]
 *  never needs more than two decimal places, so no locale-aware formatter. */
internal fun formatVoiceSpeed(speed: Float): String {
    val trimmed = if (speed == speed.toInt().toFloat()) speed.toInt().toString() else speed.toString()
    return "${trimmed}\u00d7"
}

private const val VOICE_SEEK_STEP_MS = 10_000

/**
 * One voice bubble's contents: waveform, play/pause, current/total, inline
 * error+retry. Owns none of the actual playback — that lives in the single
 * conversation-scoped [VoicePlaybackController] reached through
 * [LocalVoicePlayback], so starting this note stops whatever the last one
 * was and neither survives only as long as this row stays composed.
 */
@Composable
private fun VoicePlayer(messageId: String, voice: CloudVoice, mine: Boolean, onLongClick: () -> Unit = {}) {
    val context = LocalContext.current
    val playback = LocalVoicePlayback.current
    val cacheKey = remember(playback?.accountKey, playback?.peer, messageId) {
        VoiceWaveformCache.key(playback?.accountKey.orEmpty(), playback?.peer.orEmpty(), messageId)
    }
    var peaks by remember(cacheKey) { mutableStateOf(VoiceWaveformCache.get(cacheKey)) }
    val placeholder = remember(messageId) { VoiceWaveformMath.placeholder(messageId) }
    val bars = peaks ?: placeholder

    LaunchedEffect(cacheKey, voice.dataUrl) {
        if (peaks != null) return@LaunchedEffect
        val decoded = withContext(Dispatchers.IO) {
            playback?.resolveMedia?.invoke(voice.dataUrl)?.let(VoiceWaveformDecoder::decodeFromDataUrl)
        }
        if (decoded != null) {
            VoiceWaveformCache.put(cacheKey, decoded)
            peaks = decoded
        }
    }

    val idleFlow = remember { MutableStateFlow<VoicePlaybackState>(VoicePlaybackState.Idle) }
    val idleSpeedFlow = remember { MutableStateFlow(1f) }
    val speed by (playback?.controller?.speed ?: idleSpeedFlow).collectAsState()
    var speedMenuOpen by remember { mutableStateOf(false) }
    val playbackState by (playback?.controller?.state ?: idleFlow).collectAsState()
    val activeState = playbackState.takeIf { it.messageIdOrNull() == messageId }
    val isPlaying = activeState is VoicePlaybackState.Playing
    val isLoading = activeState is VoicePlaybackState.Loading
    val isFailed = activeState is VoicePlaybackState.Failed
    val positionMs = when (activeState) {
        is VoicePlaybackState.Playing -> activeState.positionMs
        is VoicePlaybackState.Paused -> activeState.positionMs
        else -> 0
    }
    val durationMs = when (activeState) {
        is VoicePlaybackState.Playing -> activeState.durationMs
        is VoicePlaybackState.Paused -> activeState.durationMs
        else -> voice.durationSec * 1000
    }
    val progress = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    val playedBars = (bars.size * progress).toInt().coerceIn(0, bars.size)

    fun toggle() {
        val controller = playback?.controller ?: return
        if (isPlaying) controller.pause() else controller.play(messageId, voice.dataUrl)
    }
    fun retry() {
        playback?.controller?.retry(messageId, voice.dataUrl)
    }
    fun seekToFraction(fraction: Float) {
        val controller = playback?.controller ?: return
        if (durationMs <= 0) return
        controller.seekTo(messageId, (durationMs * fraction.coerceIn(0f, 1f)).toInt())
    }
    fun seekBy(deltaMs: Int) {
        val controller = playback?.controller ?: return
        if (durationMs <= 0) return
        controller.seekTo(messageId, (positionMs + deltaMs).coerceIn(0, durationMs))
    }

    val failedLabel = stringResource(R.string.cloud_voice_play_failed)
    val playLabel = stringResource(R.string.cloud_voice_play)
    val pauseLabel = stringResource(R.string.cloud_voice_pause)
    val playingWord = stringResource(R.string.cloud_voice_playing)
    val pausedWord = stringResource(R.string.cloud_voice_paused)
    val retryLabel = stringResource(R.string.cloud_failed_retry)
    val rewindLabel = stringResource(R.string.cloud_voice_seek_back)
    val forwardLabel = stringResource(R.string.cloud_voice_seek_forward)
    val positionLabel = formatVoiceClock(positionMs / 1000)
    val totalLabel = formatVoiceClock((durationMs / 1000).coerceAtLeast(0))
    val combinedDescription = stringResource(
        R.string.cloud_voice_player_description,
        if (isPlaying) playingWord else pausedWord,
        positionLabel,
        totalLabel,
    )

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .padding(vertical = 2.dp)
            .widthIn(min = 190.dp)
            .clearAndSetSemantics {
                if (isFailed) {
                    contentDescription = failedLabel
                    customActions = listOf(CustomAccessibilityAction(retryLabel) { retry(); true })
                    onClick(retryLabel) { retry(); true }
                } else {
                    contentDescription = combinedDescription
                    customActions = listOf(
                        CustomAccessibilityAction(rewindLabel) { seekBy(-VOICE_SEEK_STEP_MS); true },
                        CustomAccessibilityAction(forwardLabel) { seekBy(VOICE_SEEK_STEP_MS); true },
                    )
                    onClick(if (isPlaying) pauseLabel else playLabel) { toggle(); true }
                }
            },
    ) {
        IconButton(
            enabled = !isLoading,
            onClick = { if (isFailed) retry() else toggle() },
        ) {
            when {
                isLoading -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                isFailed -> Icon(Icons.Filled.Refresh, contentDescription = null)
                isPlaying -> Icon(Icons.Filled.Pause, contentDescription = null)
                else -> Icon(Icons.Filled.PlayArrow, contentDescription = null)
            }
        }
        Column(Modifier.weight(1f)) {
            VoiceWaveformBars(
                bars = bars,
                playedCount = if (isFailed) 0 else playedBars,
                enabled = !isFailed,
                onSeekFraction = ::seekToFraction,
                onLongPress = onLongClick,
            )
            Text(
                if (isFailed) failedLabel else "$positionLabel / $totalLabel",
                style = MaterialTheme.typography.labelSmall,
                color = if (isFailed) MaterialTheme.colorScheme.error
                else if (mine) MaterialTheme.colorScheme.onSurface
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (activeState != null && !isFailed) {
            Box {
                Text(
                    formatVoiceSpeed(speed),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .padding(start = 4.dp)
                        .clickable(onClickLabel = stringResource(R.string.cloud_voice_speed)) { speedMenuOpen = true },
                )
                TailchatDropdownMenu(expanded = speedMenuOpen, onDismissRequest = { speedMenuOpen = false }) {
                    VOICE_PLAYBACK_SPEEDS.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(formatVoiceSpeed(option)) },
                            onClick = {
                                playback?.controller?.setSpeed(option)
                                speedMenuOpen = false
                            },
                        )
                    }
                }
            }
        }
    }
}

/** [bars] are 0..1 heights, 36 wide (`VoiceWaveformMath.BUCKET_COUNT`); the
 *  first [playedCount] are drawn in the "already heard" colour. A tap or a
 *  drag anywhere across the strip seeks to that fraction of the track —
 *  [onSeekFraction] is responsible for turning that into an actual
 *  millisecond position and clamping it. [onLongPress] is the message
 *  bubble's own long-press menu (reply/forward/copy/delete): without it here,
 *  the tap detector below would claim every touch over the waveform first and
 *  the bubble's `combinedClickable` would never see a long press on a voice
 *  message, the same gesture conflict `InlineImage.onLongClick` exists to fix
 *  for photos. */
@Composable
private fun VoiceWaveformBars(
    bars: FloatArray,
    playedCount: Int,
    enabled: Boolean,
    onSeekFraction: (Float) -> Unit,
    onLongPress: () -> Unit = {},
) {
    val playedColor = MaterialTheme.colorScheme.primary
    val unplayedColor = Color(0xFFD5CBB8)
    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(28.dp)
            .then(
                if (!enabled) Modifier else Modifier
                    .pointerInput(bars.size) {
                        detectTapGestures(
                            onLongPress = { onLongPress() },
                            onTap = { offset -> onSeekFraction(offset.x / size.width.coerceAtLeast(1)) },
                        )
                    }
                    .pointerInput(bars.size) {
                        detectDragGestures { change, _ ->
                            change.consume()
                            onSeekFraction(change.position.x / size.width.coerceAtLeast(1))
                        }
                    },
            ),
    ) {
        val barCount = bars.size
        if (barCount == 0) return@Canvas
        val gapPx = 2.dp.toPx()
        val barWidth = ((size.width - gapPx * (barCount - 1)) / barCount).coerceAtLeast(1f)
        for (i in 0 until barCount) {
            val heightFraction = 0.15f + bars[i].coerceIn(0f, 1f) * 0.85f
            val barHeight = size.height * heightFraction
            val x = i * (barWidth + gapPx)
            drawRoundRect(
                color = if (i < playedCount) playedColor else unplayedColor,
                topLeft = Offset(x, (size.height - barHeight) / 2f),
                size = Size(barWidth, barHeight),
                cornerRadius = CornerRadius(barWidth / 2f, barWidth / 2f),
            )
        }
    }
}

@Composable
private fun CloudAttachmentContent(attachment: CloudAttachment) {
    val context = LocalContext.current
    val landed = attachment.transfer is Transfer.Complete
    Column(modifier = if (landed) Modifier.clickable { openDownloadsFolder(context) } else Modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.InsertDriveFile,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = LocalContentColor.current.copy(alpha = 0.7f),
            )
            Spacer(Modifier.width(8.dp))
            Column {
                Text(
                    attachment.name,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    formatBytes(attachment.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = LocalContentColor.current.copy(alpha = 0.55f),
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        when (val transfer = attachment.transfer) {
            is Transfer.Progress -> {
                val fraction = if (transfer.total > 0L) {
                    (transfer.done.toDouble() / transfer.total.toDouble()).toFloat().coerceIn(0f, 1f)
                } else 0f
                LinearProgressIndicator(
                    progress = { fraction },
                    modifier = Modifier.fillMaxWidth().height(3.dp),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = LocalTailchatAccents.current.line,
                )
            }
            is Transfer.Complete -> Text(
                text = transfer.location ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = LocalContentColor.current.copy(alpha = 0.7f),
            )
            is Transfer.Failed -> Text(
                text = transfer.reason,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/**
 * Command feedback and other client-local notes. `* ` in front, dim, full
 * width — `.system-note::before { content: "* " }` on web (app.css:1322-1332)
 * and `addLine` in the terminal, which prefixes the same asterisk in dim green.
 * Multi-line output (`/help`, `/status`, `/asc`) keeps its grid, so the bubble
 * that used to centre and round it is gone: an aligned table inside a rounded
 * pill reads as a mistake.
 */
@Composable
private fun SystemNoteRow(message: CloudMessage, modifier: Modifier = Modifier) {
    Text(
        text = remember(message.text) { message.text.lineSequence().joinToString("\n") { "* $it" } },
        modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 3.dp),
        style = MaterialTheme.typography.labelSmall.copy(
            fontFamily = TailchatMono,
            lineHeight = 15.sp,
        ),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}


/**
 * The command palette: `.command-palette` from web/cloud/index.html:230-236 and
 * app.css:1730-1800, anchored above the composer, filtered on every keystroke
 * of a bare `/word`, and dismissed the moment an argument is typed. A phone has
 * no ↑/↓, so selection is a tap; everything else — the header, the usage/alias/
 * help columns, the accent left edge — is the web layout.
 */
@Composable
private fun CloudCommandPalette(matches: List<CloudCommand>, onPick: (CloudCommand) -> Unit) {
    if (matches.isEmpty()) return
    val depth = LocalTailchatDepth.current
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = DOCK_INSET, vertical = 4.dp)
            .tailchatSurface(MaterialTheme.shapes.small, MaterialTheme.colorScheme.surface, depth.floating),
        shape = MaterialTheme.shapes.small,
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 10.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.cloud_palette_title),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stringResource(R.string.cloud_palette_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            LazyColumn(modifier = Modifier.heightIn(max = 210.dp)) {
                items(matches, key = CloudCommand::name) { command ->
                    Row(
                        modifier = Modifier.fillMaxWidth()
                            .clickable { onPick(command) }
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            command.usage,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        command.alias?.let {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.width(10.dp))
                        Text(
                            stringResource(command.help),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                }
            }
        }
    }
}

/**
 * The bar a selection puts in the composer's own slot — web's `#selection-bar`
 * (index.html:257-273, `.selection-bar` in app.css:3738): «Выбрано: N» on the
 * left, then Forward, Delete and the cancel, one hairline off the transcript
 * exactly like the tray it stands in for. «Удалить» opens the same two scopes
 * the message menu offers for one message, and offers the second on the same
 * condition — a selection holding a message somebody else wrote can only be
 * dropped for this account (web's `openBulkDeleteMenu`, app.js:9888).
 */
@Composable
private fun CloudSelectionBar(
    count: Int,
    allOwn: Boolean,
    modifier: Modifier = Modifier,
    onForward: () -> Unit,
    onDelete: (Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    var deleteMenuOpen by remember { mutableStateOf(false) }
    Surface(
        modifier = modifier.glassBar(),
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(Modifier.fillMaxSize()) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.cloud_selection_count, count),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SelectionBarButton(
                        icon = Icons.AutoMirrored.Filled.Send,
                        label = stringResource(R.string.cloud_msg_forward),
                        onClick = onForward,
                    )
                    Box {
                        SelectionBarButton(
                            icon = Icons.Filled.Delete,
                            label = stringResource(R.string.cloud_selection_delete),
                            danger = true,
                            onClick = { deleteMenuOpen = true },
                        )
                        TailchatDropdownMenu(expanded = deleteMenuOpen, onDismissRequest = { deleteMenuOpen = false }) {
                            MessageAction(Icons.Filled.Delete, stringResource(R.string.cloud_msg_delete_self)) {
                                deleteMenuOpen = false
                                onDelete(false)
                            }
                            if (allOwn) {
                                MessageAction(
                                    Icons.Filled.Delete,
                                    stringResource(R.string.cloud_msg_delete_all),
                                    tint = MaterialTheme.colorScheme.error,
                                ) {
                                    deleteMenuOpen = false
                                    onDelete(true)
                                }
                            }
                        }
                    }
                    SelectionBarButton(
                        icon = Icons.Filled.Close,
                        label = stringResource(R.string.cloud_selection_cancel),
                        onClick = onCancel,
                    )
                }
            }
        }
    }
}

/** One pill in [CloudSelectionBar] — web's `.selection-bar-btn`
 *  (app.css:3762): a hairline pill carrying its own icon and label, the icon
 *  every sibling in the row has (AGENTS.md §10). «Удалить» is the danger one,
 *  in the theme's own error colour, never a new red (§12). */
@Composable
private fun SelectionBarButton(
    icon: ImageVector,
    label: String,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    val content = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    val line = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outlineVariant
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(percent = 50),
        color = Color.Transparent,
        contentColor = content,
        border = BorderStroke(1.dp, line),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(14.dp), tint = content)
            Text(label, style = MaterialTheme.typography.labelMedium, color = content, maxLines = 1)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloudComposer(
    controller: CloudController,
    uiViewModel: CloudUiViewModel,
    modifier: Modifier = Modifier,
    online: Boolean,
    /** The open peer is blocked by this account — history stays on screen,
     *  but sending is server-rejected either direction, so every send/voice/
     *  attach affordance below is disabled rather than left to fail silently. */
    blocked: Boolean,
    recordingElapsedSec: Int?,
    draftText: String,
    onDraftChange: (String) -> Unit,
    replyTo: CloudReply?,
    replyAuthor: String?,
    editing: CloudMessage?,
    onCancelContext: () -> Unit,
    onFinishContext: () -> Unit,
    onSend: (String, CloudReply?, (Boolean) -> Unit) -> Unit,
    onCommitEdit: (String) -> Unit,
    onTyping: () -> Unit,
) {
    // Reported from the live state so Back cancels exactly the recording
    // actually in progress.
    if (recordingElapsedSec != null) {
        SideEffect { uiViewModel.setVoiceRecording(true) { controller.stopVoiceRecording(send = false) } }
    } else {
        SideEffect { uiViewModel.setVoiceRecording(false, null) }
    }
    val context = LocalContext.current
    var fieldValue by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(draftText, androidx.compose.ui.text.TextRange(draftText.length))) }
    val displayedField = if (fieldValue.text == draftText) fieldValue
        else androidx.compose.ui.text.input.TextFieldValue(draftText, androidx.compose.ui.text.TextRange(draftText.length))
    var pendingImages by rememberSaveable(stateSaver = remember {
        listSaver<List<Uri>, String>(save = { it.map(Uri::toString) }, restore = { it.map(Uri::parse) })
    }) { mutableStateOf(emptyList()) }
    pendingImages.firstOrNull()?.let { uri ->
        key(uri) {
            ImageEditor(uri, onDismiss = { pendingImages = pendingImages.drop(1) }, onSend = { edit, caption ->
                controller.sendImage(uri, caption, edit)
                pendingImages = pendingImages.drop(1)
            })
        }
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        for (uri in uris) {
            if (isImageUri(context, uri)) pendingImages = pendingImages + uri else controller.sendFile(uri)
        }
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingImages = pendingImages + uris
    }
    var pendingCameraUri by rememberSaveable { mutableStateOf<Uri?>(null) }
    // «Возможность фото прямо с камеры снять и отправить»: the camera app
    // writes full-resolution JPEG bytes straight to the URI this hands it —
    // no CAMERA permission needed, since the system camera app (not this
    // process) is the one that actually touches the sensor — then the same
    // `sendImage` path a gallery pick uses compresses and queues it.
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val uri = pendingCameraUri
        pendingCameraUri = null
        if (captured && uri != null) pendingImages = pendingImages + uri
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) controller.startVoiceRecording()
    }
    val matches = remember(draftText) { cloudCommandMatches(draftText) }
    // Ownership moved to CloudUiViewModel so a single Back press can close it —
    // see CloudUiViewModel.consumeBack.
    var attachmentsOpen by remember { mutableStateOf(false) }
    val corners = LocalTailchatCorners.current
    val depth = LocalTailchatDepth.current
    // `onSend`'s commit resolves asynchronously, after this composition may
    // already have moved on (more typing, a different reply/edit target) — the
    // completion callback below reads through `rememberUpdatedState` so it
    // acts on what the composer holds *now*, not what it held at the tap.
    val latestDraftText by rememberUpdatedState(draftText)
    val latestOnDraftChange by rememberUpdatedState(onDraftChange)
    val latestOnFinishContext by rememberUpdatedState(onFinishContext)
    val canSubmit = draftText.isNotBlank()
    val submit = {
        val text = draftText
        if (canSubmit) {
            if (editing != null) {
                onCommitEdit(text)
                // Synchronous today — onCommitEdit reports no failure — so this
                // only guards typing that already moved on within this event.
                if (draftText == text) onDraftChange("")
                onFinishContext()
            } else {
                onSend(text, replyTo) { sent ->
                    // Only the exact version that was sent is cleared — CloudController's
                    // own contract for `clearDraft`: a failed commit, or newer typing that
                    // landed while the send was in flight, must survive it.
                    if (sent && latestDraftText == text) latestOnDraftChange("")
                    if (sent) latestOnFinishContext()
                }
            }
        }
    }
    val recording = recordingElapsedSec != null
    var recordingDragX by remember(recording) { mutableStateOf(0f) }
    // Recording used to swap the whole row for a differently-sized one
    // (separate cancel/send icon buttons, a different padding scheme) — any
    // difference in total height there moved the transcript above it on
    // every press. Now the row itself never changes: the same attach/emoji
    // buttons stay in place, only the middle field's *content* (draft text
    // vs. the running timer, in the exact same 44dp pill) and the mic
    // button's *color* change, so the composer's height never moves.
    Column(modifier) {
        if (!recording) {
            CloudCommandPalette(matches) { command ->
                // Argument-less commands run on the tap, the way the web palette
                // auto-submits them (`applyCommandMatch`, app.js:1520-1531).
                if (command.args == null) {
                    onSend(command.name, null) {}
                    onDraftChange("")
                } else {
                    onDraftChange("${command.name} ")
                }
            }
            // Above the composer, never over the transcript: the picker is part of
            // writing, and a panel that covers what is being answered is the reason
            // web anchors its own picker to the composer too.
            if (uiViewModel.emojiPaletteOpen) {
                EmojiPickerSheet(
                    onPick = { emoji ->
                        val selection = displayedField.selection
                        val next = draftText.replaceRange(selection.min, selection.max, emoji)
                        fieldValue = androidx.compose.ui.text.input.TextFieldValue(next, androidx.compose.ui.text.TextRange(selection.min + emoji.length))
                        onDraftChange(next)
                        onTyping()
                        uiViewModel.openEmojiPalette(false)
                    },
                    onClose = { uiViewModel.openEmojiPalette(false) },
                )
            }
        }
        if (!recording) {
            if (editing != null) ComposerContext(
                icon = Icons.Filled.Edit,
                label = stringResource(R.string.cloud_edit_context),
                detail = editing.text,
                onCancel = onCancelContext,
            ) else if (replyTo != null) ComposerContext(
                icon = Icons.AutoMirrored.Filled.Reply,
                label = stringResource(R.string.cloud_reply_context, replyAuthor.orEmpty()),
                detail = replyTo.text,
                onCancel = onCancelContext,
            )
        }
        // The composer is a dock floating over the room (web 1.128, «студия»)
        // rather than a tray welded to the bottom edge: inset from the sides
        // and the bottom, a glass sheet with the glass line, lifted one
        // `--elev-2` step, its corner concentric with the round buttons inside
        // it ([TailchatCorners.dock]). What sits *above* it stays out of it:
        // the command palette, the emoji panel and the reply/edit card are
        // their own cards on the same inset, so the stack reads as one object.
        val dockShape = RoundedCornerShape(corners.dock)
        val accents = LocalTailchatAccents.current
        Surface(
            modifier = Modifier
                .padding(start = DOCK_INSET, end = DOCK_INSET, bottom = DOCK_INSET)
                .tailchatSurface(dockShape, accents.glass, depth.bar, listOf(depth.sheenBrush())),
            shape = dockShape,
            color = Color.Transparent,
            contentColor = MaterialTheme.colorScheme.onSurface,
            border = BorderStroke(1.dp, accents.glassLine),
        ) {
            Column {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(DOCK_PADDING),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    if (recording) {
                        ComposerAction(
                            icon = Icons.Filled.Close,
                            description = stringResource(R.string.cloud_voice_cancel_recording),
                            onClick = { controller.stopVoiceRecording(send = false) },
                        )
                    } else {
                        Box {
                            ComposerAction(Icons.Filled.AttachFile, stringResource(R.string.cloud_attachments), enabled = !blocked) {
                                attachmentsOpen = !attachmentsOpen
                            }
                            TailchatDropdownMenu(expanded = attachmentsOpen, onDismissRequest = { attachmentsOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.cloud_attach_camera)) },
                                    leadingIcon = { Icon(Icons.Filled.PhotoCamera, contentDescription = null) },
                                    onClick = {
                                        attachmentsOpen = false
                                        val uri = createCameraCaptureUri(context)
                                        pendingCameraUri = uri
                                        cameraLauncher.launch(uri)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.cloud_attach_image)) },
                                    leadingIcon = { Icon(Icons.Filled.ImageIcon, contentDescription = null) },
                                    onClick = { attachmentsOpen = false; imagePicker.launch("image/*") },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.cloud_attach_file)) },
                                    leadingIcon = { Icon(Icons.Filled.AttachFile, contentDescription = null) },
                                    onClick = { attachmentsOpen = false; filePicker.launch(arrayOf("*/*")) },
                                )
                            }
                        }
                    }
                    Spacer(Modifier.width(6.dp))
                    if (recording) {
                        // The exact same box the text field decorates itself into
                        // below — same `heightIn(min = 44.dp)`, background, shape and
                        // padding — so this is a swap of content, never of size.
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 44.dp)
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f), RoundedCornerShape(corners.field))
                                .insetShadows(depth.inset, RoundedCornerShape(corners.field))
                                .pointerInput(recording) {
                                    detectHorizontalDragGestures(
                                        onDragStart = { recordingDragX = 0f },
                                        onDragEnd = {
                                            if (recordingDragX <= -64.dp.toPx()) controller.stopVoiceRecording(send = false)
                                            recordingDragX = 0f
                                        },
                                        onHorizontalDrag = { change, amount ->
                                            change.consume()
                                            recordingDragX += amount
                                        },
                                    )
                                }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                formatVoiceClock(recordingElapsedSec ?: 0),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.error,
                            )
                            Spacer(Modifier.width(8.dp))
                            RecordingLevelMeter(controller.voiceRecordingAmplitude, Modifier.weight(1f))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "/ ${formatVoiceClock(VOICE_MAX_SEC)}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    } else {
                        // Material's own decorations are unusable here: `OutlinedTextField`
                        // is locked to 56dp, and `DecorationBox` keeps its own vertical
                        // padding on top of whatever is asked for, which left the text
                        // sitting high in the field. This is the decoration by hand — one
                        // centred row on a filled pill — so 44dp is exactly the height and
                        // the caret, the placeholder and the text share one baseline.
                        ImageContentReceiver(enabled = !blocked, onImage = { pendingImages = pendingImages + it }) {
                        EmojiDraftField(
                            value = displayedField,
                            onValueChange = { fieldValue = it; onDraftChange(it.text); onTyping() },
                            modifier = Modifier.weight(1f).imagePasteShortcut(!blocked) { pendingImages = pendingImages + it },
                            readOnly = blocked,
                            textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            maxLines = 5,
                            // A sentence starts with a capital and so does every
                            // one after it — the same thing every other text
                            // field on the phone does, and what the composer was
                            // the only one on this screen to be missing:
                            // `KeyboardOptions.Default` asks the IME for
                            // `TYPE_TEXT_FLAG_CAP_SENTENCES` nowhere, and Gboard
                            // renders exactly what it is asked for, so a message
                            // typed here stayed lowercase at the start of every
                            // sentence. The flag is the IME's own convention,
                            // not a transform of ours: it capitalizes the first
                            // letter after `. `, `! `, `? ` or a newline, and
                            // nothing else — mid-sentence text is untouched.
                            keyboardOptions = KeyboardOptions(
                                capitalization = KeyboardCapitalization.Sentences,
                            ),
                            decorationBox = { field ->
                                // Pressed into the dock (`--elev-inset`) over the raised
                                // fill at 78% — the same depth focused or not, because
                                // focus must not add a ring (web: «фокус не добавляет
                                // рамку»). A blocked contact's read-only field is flat,
                                // as web's disabled field is.
                                Row(
                                    modifier = Modifier
                                        .heightIn(min = 44.dp)
                                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f), RoundedCornerShape(corners.field))
                                        .then(
                                            if (blocked) Modifier
                                            else Modifier.insetShadows(depth.inset, RoundedCornerShape(corners.field)),
                                        )
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    // The terminal client's prompt is a themed `❯ ` caret
                                    // (ui.js:1407-1415); this is that caret, as the field's own.
                                    Text(
                                        "❯",
                                        fontFamily = TailchatMono,
                                        fontWeight = FontWeight.Bold,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (blocked) MaterialTheme.colorScheme.error
                                        else if (online) MaterialTheme.colorScheme.primary
                                        else MaterialTheme.colorScheme.onSurface,
                                    )
                                    Spacer(Modifier.width(6.dp))
                                    Box(Modifier.weight(1f)) {
                                        if (draftText.isEmpty()) Text(
                                            if (blocked) stringResource(R.string.cloud_composer_blocked_hint)
                                            else if (online) stringResource(R.string.cloud_message)
                                            else stringResource(R.string.cloud_composer_offline),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurface,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        field()
                                    }
                                }
                            },
                        )
                        }
                    }
                    if (!recording) {
                        Spacer(Modifier.width(4.dp))
                        ComposerAction(
                            icon = Icons.Filled.EmojiEmotions,
                            imageGlyph = "😊",
                            description = stringResource(R.string.cloud_emoji_open),
                            enabled = !blocked,
                            onClick = { uiViewModel.openEmojiPalette(!uiViewModel.emojiPaletteOpen) },
                        )
                    }
                    Spacer(Modifier.width(4.dp))
                    when {
                        recording -> {
                            // «Кнопку красной + анимация»: the same mic button, not a
                            // different one — a pulsing red fill is the one visible
                            // sign a capture is live. Tapping it stops and sends, the
                            // same action the send button in this slot already means.
                            ComposerAction(
                                icon = Icons.Filled.Mic,
                                description = stringResource(R.string.cloud_voice_stop),
                                recording = true,
                                onClick = { controller.stopVoiceRecording(send = true) },
                            )
                        }
                        draftText.isBlank() && editing == null -> {
                            // A tap used to start a recording outright — one stray touch
                            // reaching for send/emoji next to it, and a note was already
                            // being captured before anyone meant to. A hold is the same
                            // gesture every reference chat app binds to this icon; the
                            // tap now only names it, via the hint toast below.
                            val holdHint = stringResource(R.string.cloud_voice_record_hint)
                            ComposerAction(
                                icon = Icons.Filled.Mic,
                                description = stringResource(R.string.cloud_voice_record),
                                enabled = !blocked,
                                onLongClick = {
                                    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                                        PackageManager.PERMISSION_GRANTED
                                    if (granted) controller.startVoiceRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                                },
                                onClick = { Toast.makeText(context, holdHint, Toast.LENGTH_SHORT).show() },
                            )
                        }
                        else -> {
                            // The one filled button on the screen: sending is the action
                            // everything else on this row is in service of.
                            ComposerAction(
                                Icons.AutoMirrored.Filled.Send,
                                stringResource(R.string.cloud_send),
                                filled = true,
                                enabled = !blocked && canSubmit,
                                onClick = submit,
                            )
                        }
                    }
                }
            }
        }

    }
}


/** The strip above the composer that says what the next send will do — a reply
 *  to somebody, or a rewrite of one's own message — with the one control that
 *  calls it off. A card on the dock's own inset (web 1.128's
 *  `.composer-context`): the stronger glass, the glass line, `radius-l` and
 *  `--elev-1`, so it and the dock read as one stack. */
@Composable
private fun ComposerContext(
    icon: ImageVector,
    label: String,
    detail: String,
    onCancel: () -> Unit,
) {
    val depth = LocalTailchatDepth.current
    val accents = LocalTailchatAccents.current
    Surface(
        modifier = Modifier.fillMaxWidth().padding(start = DOCK_INSET, end = DOCK_INSET, bottom = 8.dp)
            .tailchatSurface(MaterialTheme.shapes.large, accents.glassStrong, depth.card, listOf(depth.sheenBrush())),
        shape = MaterialTheme.shapes.large,
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.dp, accents.glassLine),
    ) {
        Row(
            modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                icon,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.secondary,
            )
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (detail.isNotBlank()) EmojiText(
                    detail,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onCancel, modifier = Modifier.size(30.dp)) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = stringResource(R.string.cloud_context_cancel),
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/** The floating composer's distance from the screen's sides and bottom, shared
 *  by every card stacked over it — web's `--dock-inset` on a phone (12px). */
private val DOCK_INSET = 12.dp

/** The dock's own padding around its 44dp controls; with half the field it
 *  makes [TailchatCorners.dock]'s concentric corner. */
private val DOCK_PADDING = 6.dp


@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloudAuthScreen(controller: CloudController, state: CloudState, onP2P: () -> Unit) {
    var registering by rememberSaveable { mutableStateOf(false) }
    var login by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    // Revealed only when the server has said the account needs it
    // (`extra_password_required`), which it says only after the primary
    // password was proven correct. Kept as a plain second field rather than a
    // separate step: the primary credentials still go with it, and the user
    // ends up back on the same form with one more thing filled in.
    var extraPassword by rememberSaveable { mutableStateOf("") }
    val busy = state.link == CloudLink.Connecting
    Scaffold(
        // Ambient light behind the sign-in too, as web's `.auth` since 1.128.
        modifier = Modifier.roomBackdrop(MaterialTheme.colorScheme.background, LocalTailchatAccents.current, wallpaper = null),
        containerColor = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            CompactBar(
                title = stringResource(R.string.cloud_title),
                subtitle = stringResource(R.string.cloud_logo_tagline),
                actions = {
                    BarAction(Icons.Filled.Devices, stringResource(R.string.p2p_open), onClick = onP2P)
                },
            )
        },
    ) { insets ->
        Column(
            Modifier.fillMaxSize().padding(insets).verticalScroll(rememberScrollState()).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // The wordmark, drawn the way both reference clients draw it — a
            // typewriter sweep behind a `▌` cursor, then the cat blinks once.
            TailchatLogo(Modifier.padding(bottom = 2.dp))
            CloudStatusCard(state.link)
            AnimatedFailureStrip(state.failure)
            // `[ login ] [ register ]` — the same tab strip the terminal's cloud
            // sign-in dialog draws (src/cloud/prompt.js:236-262). Material's own
            // Button shape is a pill regardless of the theme's Shapes, so every
            // filled button here is squared off by hand to match the fields.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!registering) Button(onClick = { registering = false }, shape = MaterialTheme.shapes.small) { Text(stringResource(R.string.cloud_login_tab)) }
                else TextButton(onClick = { registering = false }) { Text(stringResource(R.string.cloud_login_tab)) }
                if (registering) Button(onClick = { registering = true }, shape = MaterialTheme.shapes.small) { Text(stringResource(R.string.cloud_register_tab)) }
                else TextButton(onClick = { registering = true }) { Text(stringResource(R.string.cloud_register_tab)) }
            }
            // No server field and no server address: this build signs in to the
            // deployment it ships with (`net.tailchat.android.cloud.
            // DEFAULT_CLOUD_SERVER`), and every other client is the same — the web
            // signs in to its own origin and the terminal takes
            // `~/.tailchat/config.json`. `state.server` still carries whichever
            // address the session was loaded with, so a self-hosted build keeps
            // working; the address is simply not put in front of the person on the
            // way in (owner: «убери при регистрации … показ сервера»).
            OutlinedTextField(login, { login = it }, label = { Text(stringResource(R.string.cloud_login)) }, colors = tailchatFieldColors(), singleLine = true, enabled = !busy, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth())
            if (registering) OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.cloud_display_name)) }, colors = tailchatFieldColors(), singleLine = true, enabled = !busy, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                password, { password = it }, label = { Text(stringResource(R.string.cloud_password)) },
                singleLine = true, enabled = !busy, visualTransformation = PasswordVisualTransformation(),
                shape = MaterialTheme.shapes.small,
                colors = tailchatFieldColors(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
            )
            if (state.extraPasswordRequired && !registering) {
                OutlinedTextField(
                    extraPassword, { extraPassword = it },
                    label = { Text(stringResource(R.string.cloud_extra_password)) },
                    singleLine = true, enabled = !busy, visualTransformation = PasswordVisualTransformation(),
                    shape = MaterialTheme.shapes.small,
                    colors = tailchatFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Button(
                onClick = {
                    if (registering) controller.register(state.server, login, name, password)
                    else controller.login(state.server, login, password, extraPassword)
                },
                enabled = !busy && login.isNotBlank() && password.isNotEmpty(),
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (busy) stringResource(R.string.cloud_connecting) else if (registering) stringResource(R.string.cloud_register_action) else stringResource(R.string.cloud_login_action))
            }
        }
    }
}

@Composable
private fun CloudStatusCard(link: CloudLink) {
    val status = when (link) {
        CloudLink.SignedOut -> stringResource(R.string.cloud_status_signed_out)
        CloudLink.Connecting -> stringResource(R.string.cloud_status_connecting)
        CloudLink.Online -> stringResource(R.string.cloud_status_online)
        CloudLink.Offline -> stringResource(R.string.cloud_status_offline)
    }
    Card(
        Modifier.fillMaxWidth().restingCard(),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Box(Modifier.padding(16.dp)) {
            Text(status, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        }
    }
}

/**
 * [calm]/[debounceMs] exist for the two post-login call sites (roster,
 * conversation): every code that reaches [CloudState.failure] there came
 * through [SyncEngine]'s `onFailure`, which always schedules its own
 * reconnect — nothing the user could do would resolve it faster, unlike a
 * login-screen error (wrong password, taken login) which stays the default
 * loud/immediate style because the user genuinely has to act on it. Calm
 * styling is the amber "in-between, not broken" token the status pill
 * already uses for Connecting/Offline, not the error-red a problem the user
 * must fix would get; the debounce keeps a routine Wi-Fi↔cellular handoff
 * that self-heals in a second or two from ever flashing the strip at all.
 */
@Composable
private fun AnimatedFailureStrip(failure: CloudFailure?, calm: Boolean = false, debounceMs: Long = 0L) {
    var shown by remember { mutableStateOf<CloudFailure?>(null) }
    LaunchedEffect(failure) {
        if (failure == null) {
            shown = null
        } else {
            if (debounceMs > 0) delay(debounceMs)
            shown = failure
        }
    }
    AnimatedVisibility(visible = shown != null, enter = fadeIn(tween(180)), exit = fadeOut(tween(120))) {
        shown?.let { FailureStrip(it, calm) }
    }
}

@Composable
private fun FailureStrip(failure: CloudFailure, calm: Boolean = false) {
    val container = if (calm) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.errorContainer
    val content = if (calm) statusWarning() else MaterialTheme.colorScheme.onErrorContainer
    Card(
        modifier = Modifier.restingCard(),
        colors = CardDefaults.cardColors(containerColor = container),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Text(cloudFailureText(failure), Modifier.fillMaxWidth().padding(12.dp), color = content)
    }
}

/**
 * The queue is kept, and this says so: an old server that never announces
 * `caps` gets a durable-acceptance client indefinitely optimistic otherwise,
 * which is the "eternal clock" §3.2/§3.3 both call out as a defect.
 */
@Composable
private fun DegradedBanner(reason: String) {
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Text(
            stringResource(R.string.cloud_degraded_banner, reason),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

/**
 * The durable store refused a write. Deliberately not [DegradedBanner]: that one
 * tells the person their *server* needs updating, and saying that when the
 * device is out of space sends them to fix the wrong thing. Nothing here is
 * automatically recoverable, so it does not come and go with a reconnect.
 */
@Composable
private fun StoreFailureBanner() {
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Text(
            stringResource(R.string.cloud_error_local_store),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

/**
 * "New version available" — a filled, primary-coloured (`signal` token —
 * green in the default palette, the same accent [ComposerAction]'s send
 * button uses) row in the roster's bottom bar, above the Add friend/Settings
 * row rather than mixed into the scrolling content above the conversation
 * list, so it reads as a persistent piece of chrome instead of one more
 * banner to scroll past. [CloudSettingsSheet] carries the same status and
 * action for anyone who dismissed this one.
 */
@Composable
private fun UpdateBarButton(
    update: AppUpdateInfo,
    download: Transfer?,
    onUpdate: () -> Unit,
    onDismiss: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.SystemUpdate, contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.cloud_update_available, update.versionName),
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                when (download) {
                    is Transfer.Progress -> {
                        Spacer(Modifier.height(4.dp))
                        val fraction = if (download.total > 0L) {
                            (download.done.toDouble() / download.total.toDouble())
                                .toFloat().coerceIn(0f, 1f)
                        } else 0f
                        LinearProgressIndicator(
                            progress = { fraction },
                            modifier = Modifier.fillMaxWidth().height(3.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                            trackColor = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.35f),
                        )
                    }
                    is Transfer.Failed -> Text(
                        stringResource(R.string.cloud_update_failed),
                        style = MaterialTheme.typography.labelSmall,
                    )
                    else -> {}
                }
            }
            if (download !is Transfer.Progress) {
                Spacer(Modifier.width(8.dp))
                TextButton(
                    onClick = onUpdate,
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onPrimary),
                ) { Text(stringResource(R.string.cloud_update_action)) }
                IconButton(onClick = onDismiss, modifier = Modifier.size(36.dp)) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.cloud_update_dismiss),
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

/**
 * One row per operation the queue gave up on, with the one action that makes
 * sense: retry it under its original id. Nothing here is deleted — a failed
 * send is still the only copy of what the user wrote (ChatRepository never
 * drops the row), so dismissing this strip without retrying just means the
 * message sits in [CloudState.failed] until the next successful attempt.
 */
@Composable
private fun FailedOperationsStrip(failed: List<CloudFailedOperation>, onRetry: (String) -> Unit) {
    if (failed.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        for (op in failed) {
            Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp).restingCard(MaterialTheme.shapes.small),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.cloud_failed_reason, op.reason),
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                    TextButton(onClick = { onRetry(op.opId) }) {
                        Text(stringResource(R.string.cloud_failed_retry))
                    }
                }
            }
        }
    }
}

@Composable
private fun RecoveryKeyCard(key: String, onDone: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    Card(
        modifier = Modifier.restingCard(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(R.string.cloud_recovery_title), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(6.dp))
            Text(stringResource(R.string.cloud_recovery_warning), style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(12.dp))
            Text(key, style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { clipboard.setText(AnnotatedString(key)) }) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = null)
                    Text(stringResource(R.string.cloud_copy))
                }
                TextButton(onClick = onDone) { Text(stringResource(R.string.cloud_recovery_saved)) }
            }
        }
    }
}

@Composable
private fun PermissionNoticeCard(
    title: String,
    message: String,
    actionLabel: String,
    onAction: () -> Unit,
    onDismiss: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp).restingCard(),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.cloud_update_dismiss))
                }
                Spacer(Modifier.width(8.dp))
                Button(
                    onClick = onAction,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(actionLabel)
                }
            }
        }
    }
}

/** A Material card or surface that keeps its own fill, resting on the page at
 *  `--elev-1`: the shadow outside [shape] and the rim on its top edge. */
@Composable
private fun Modifier.restingCard(shape: Shape = MaterialTheme.shapes.medium): Modifier {
    val depth = LocalTailchatDepth.current
    return dropShadows(depth.card.shadows, shape).rim(depth.card.edge, shape)
}

@Composable
internal fun cloudFailureText(failure: CloudFailure): String = when (failure.code) {
    "invalid_server" -> stringResource(R.string.cloud_error_invalid_server)
    "invalid_login" -> stringResource(R.string.cloud_error_invalid_login)
    "invalid_password" -> stringResource(R.string.cloud_error_invalid_password)
    "invalid_name" -> stringResource(R.string.cloud_error_invalid_name)
    "login_taken" -> stringResource(R.string.cloud_error_login_taken)
    "bad_credentials" -> stringResource(R.string.cloud_error_bad_credentials)
    // Not a refusal: the primary password was right and the account simply has
    // a second one to offer, which is why the screen also reveals that field.
    "extra_password_required" -> stringResource(R.string.cloud_error_extra_password_required)
    "too_many_attempts", "rate_limited" -> stringResource(R.string.cloud_error_rate_limited)
    "auth_failed", "auth_required", "unknown_token" -> stringResource(R.string.cloud_error_session_expired)
    "peer_not_found" -> stringResource(R.string.cloud_error_peer_not_found)
    "not_subscribed" -> stringResource(R.string.cloud_error_not_subscribed)
    // The roster never offers the action on an official account, so this is
    // the answer to a race or an older client — never to a menu the person
    // could actually have chosen.
    "official_contact" -> stringResource(R.string.cloud_error_official_contact)
    "unreachable" -> stringResource(R.string.cloud_error_unreachable)
    "invalid_invite" -> stringResource(R.string.cloud_error_invalid_invite)
    "self_invite" -> stringResource(R.string.cloud_error_self_invite)
    "invite_not_found" -> stringResource(R.string.cloud_error_invite_not_found)
    "forbidden" -> stringResource(R.string.cloud_error_forbidden)
    "official_invite" -> stringResource(R.string.cloud_error_official_invite)
    "unknown_user" -> stringResource(R.string.cloud_error_unknown_user)
    "self_request" -> stringResource(R.string.cloud_error_self_request)
    "official_request" -> stringResource(R.string.cloud_error_official_request)
    // This side did the blocking: the request cannot go out until it is lifted.
    // A block the *other* side put up is never reported — that request is
    // answered exactly like one that went through.
    "blocked" -> stringResource(R.string.cloud_error_blocked)
    "request_limit" -> stringResource(R.string.cloud_error_request_limit)
    // A history walk gave up on the open conversation even at one message per page
    // (`SyncEngine.loadHistory`); named, because the strip also shows over the roster.
    "history_failed" -> stringResource(R.string.cloud_error_history_failed, failure.peer.orEmpty())
    else -> failure.detail ?: stringResource(R.string.cloud_error_server)
}
