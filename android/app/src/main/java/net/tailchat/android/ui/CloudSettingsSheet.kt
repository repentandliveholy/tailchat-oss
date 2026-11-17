package net.tailchat.android.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import net.tailchat.android.AppPermissions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.tailchat.android.AppFont
import net.tailchat.android.AppLang
import net.tailchat.android.AppLocale
import net.tailchat.android.AppPalette
import net.tailchat.android.AppPreferences
import net.tailchat.android.AppRoundness
import net.tailchat.android.CallRingtone
import net.tailchat.android.ChatWallpaper
import net.tailchat.android.R
import net.tailchat.android.Settings
import net.tailchat.android.SoundEffects
import net.tailchat.android.SoundPack
import net.tailchat.android.TEXT_SCALES
import net.tailchat.android.ThemeMode
import net.tailchat.android.call.CallRingPreview
import net.tailchat.android.call.CallRinger
import net.tailchat.android.cloud.CloudApi
import net.tailchat.android.cloud.CloudController
import net.tailchat.android.cloud.CloudFailure
import net.tailchat.android.data.TailchatDatabase
import net.tailchat.android.cloud.CloudState
import net.tailchat.proto.formatBytes

/**
 * Everything the web client's settings dialog asks (`web/cloud/index.html:349`)
 * and the three questions only a phone has: what the on-device cache is allowed
 * to keep, whether the link is kept hot at the battery's expense, and how big
 * the text should be independently of the OS font scale.
 *
 * Every control writes straight through [Settings] and is picked up immediately
 * by [AppPreferences] — there is no separate "apply" step, and nothing here can
 * be half-saved.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CloudSettingsSheet(
    controller: CloudController,
    onDismiss: () -> Unit,
    /** Opens the direct tailnet screen; used to be an unlabelled bar icon. */
    onP2P: (() -> Unit)? = null,
    /** Signs the account out; moved off the bar so it cannot be hit by accident. */
    onLogout: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val sheetState = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    val cloudState by controller.state.collectAsState()

    val mode by AppPreferences.themeMode.collectAsState()
    val palette by AppPreferences.palette.collectAsState()
    val font by AppPreferences.font.collectAsState()
    val roundness by AppPreferences.roundness.collectAsState()
    val wallpaper by AppPreferences.wallpaper.collectAsState()
    val outlines by AppPreferences.outlines.collectAsState()
    val depthDesign by AppPreferences.depthDesign.collectAsState()
    val linkPreviews by AppPreferences.linkPreviews.collectAsState()
    val textScale by AppPreferences.textScale.collectAsState()
    val sounds by AppPreferences.cloudSounds.collectAsState()
    val sendSound by AppPreferences.sendSound.collectAsState()
    val soundPack by AppPreferences.soundPack.collectAsState()
    val soundVolume by AppPreferences.soundVolume.collectAsState()
    val customSound by AppPreferences.customSoundPath.collectAsState()
    val notifications by AppPreferences.cloudNotifications.collectAsState()
    val vibration by AppPreferences.cloudVibration.collectAsState()
    val typingIndicator by AppPreferences.cloudTypingIndicator.collectAsState()
    val showDeletedMessages by AppPreferences.showDeletedMessages.collectAsState()
    val offlineCache by AppPreferences.offlineCache.collectAsState()
    val keepLinkHot by AppPreferences.keepLinkHot.collectAsState()
    val backgroundService by AppPreferences.backgroundService.collectAsState()
    val rosterPreviewLines by AppPreferences.rosterPreviewLines.collectAsState()
    val callRingtone by AppPreferences.callRingtone.collectAsState()

    // Measured, not estimated: the number is the reason somebody opens this row,
    // and it has to move the moment the cache is cleared.
    var cacheBytes by remember { mutableStateOf(-1L) }
    var cacheRefresh by remember { mutableStateOf(0) }
    LaunchedEffect(cacheRefresh) {
        cacheBytes = withContext(Dispatchers.IO) { TailchatDatabase.storedBytes(context) }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        cacheRefresh++
    }
    DisposableEffect(Unit) {
        onDispose {
            CallRingPreview.stop()
            SoundEffects.stopPreview()
        }
    }


    // The copy is deliberate: a `content://` grant does not survive a reboot,
    // and a notification channel has to be able to read this sound years later.
    val soundPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val stored = withContext(Dispatchers.IO) { copyCustomCue(context, uri) }
            if (stored == null) return@launch
            settings.customSoundPath = stored
            settings.soundPack = SoundPack.Custom
            SoundEffects.preview(context)
        }
    }

    // Glass, like web's dialogs since 1.128 (`.modal-card`): the room tints
    // the sheet, at the sheet's own near-opaque strength (see `glassSheet`).
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = LocalTailchatAccents.current.glassSheet,
        // Explicit: a translucent container is no scheme colour, so
        // `contentColorFor` would fall back to black text on a dark sheet.
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 4.dp),
        ) {
            Text(stringResource(R.string.cloud_settings_title), style = MaterialTheme.typography.titleMedium)

            SettingHeading(stringResource(R.string.cloud_settings_appearance))
            ChoiceRow(stringResource(R.string.cloud_settings_mode)) {
                for ((value, label) in modeOptions()) {
                    SettingChip(
                        stringResource(label),
                        mode == value,
                    ) { settings.themeMode = value }
                }
            }
            ChoiceRow(stringResource(R.string.cloud_settings_scheme)) {
                for ((value, label) in paletteOptions()) {
                    SettingChip(stringResource(label), palette == value) { settings.palette = value }
                }
            }
            ChoiceRow(stringResource(R.string.cloud_settings_font)) {
                for ((value, label) in fontOptions()) {
                    SettingChip(stringResource(label), font == value) { settings.appFont = value }
                }
            }
            // Ahead of «Скругление», per docs/archive/HANDOFF_WALLPAPERS.md §4: the four
            // questions in this block run from the whole look down to one
            // detail, and the wallpaper belongs to the first half of that.
            // Eight cards no longer read as one sideways strip — two thirds of
            // them would sit off screen — so they wrap two to a row, as web's
            // `.wallpaper-grid` does since 1.128.
            ChoiceLabel(stringResource(R.string.cloud_settings_wallpaper))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (pair in wallpaperOptions().chunked(2)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        for ((value, label) in pair) {
                            WallpaperCard(value, label, selected = wallpaper == value, modifier = Modifier.weight(1f)) {
                                settings.wallpaper = value
                            }
                        }
                    }
                }
            }
            ChoiceRow(stringResource(R.string.cloud_settings_round)) {
                for ((value, label) in roundOptions()) {
                    SettingChip(stringResource(label), roundness == value) { settings.roundness = value }
                }
            }
            ChoiceRow(stringResource(R.string.cloud_settings_text_scale)) {
                for (scale in TEXT_SCALES) {
                    SettingChip("${(scale * 100).toInt()}%", textScale == scale) { settings.textScale = scale }
                }
            }
            SettingToggleRow(
                title = stringResource(R.string.settings_outlines),
                hint = stringResource(R.string.settings_outlines_hint),
                checked = outlines,
                onCheckedChange = { settings.outlines = it },
            )
            SettingToggleRow(
                title = stringResource(R.string.settings_depth),
                hint = stringResource(R.string.settings_depth_hint),
                checked = depthDesign,
                onCheckedChange = { settings.depthDesign = it },
            )
            ChoiceRow(stringResource(R.string.cloud_settings_roster_preview)) {
                for (lines in 1..3) {
                    SettingChip(lines.toString(), rosterPreviewLines == lines) { settings.rosterPreviewLines = lines }
                }
            }

            SettingHeading(stringResource(R.string.settings_behavior))
            SettingToggleRow(
                title = stringResource(R.string.settings_link_previews),
                hint = stringResource(R.string.settings_link_previews_hint),
                checked = linkPreviews,
                onCheckedChange = { settings.linkPreviews = it },
            )
            QuickReactionSettings()

            SettingHeading(stringResource(R.string.cloud_settings_sound_section))
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_sounds),
                hint = stringResource(R.string.cloud_settings_sounds_hint),
                checked = sounds,
                onCheckedChange = { settings.cloudSounds = it },
            )
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_send_sound),
                hint = stringResource(R.string.cloud_settings_send_sound_hint),
                checked = sendSound,
                onCheckedChange = { settings.sendSound = it },
            )
            ChoiceRow(stringResource(R.string.cloud_settings_sound_pack)) {
                for ((value, label) in packOptions()) {
                    SettingChip(stringResource(label), soundPack == value) {
                        // Picking a pack plays it: choosing a notification sound
                        // you cannot hear until the next message arrives is a
                        // guess, not a choice.
                        if (value == SoundPack.Custom && customSound == null) soundPicker.launch(arrayOf("audio/*"))
                        else {
                            settings.soundPack = value
                            SoundEffects.preview(context)
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = customSound?.let { File(it).name } ?: stringResource(R.string.cloud_settings_sound_builtin),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(
                    onClick = { soundPicker.launch(arrayOf("audio/*")) },
                    shape = MaterialTheme.shapes.small,
                ) { Text(stringResource(R.string.cloud_settings_sound_pick)) }
            }
            Text(
                stringResource(R.string.cloud_settings_sound_volume, soundVolume),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 10.dp),
            )
            Slider(
                value = soundVolume.toFloat(),
                onValueChange = { settings.soundVolume = it.toInt() },
                // Audible on release, not on every pixel of the drag: 20 steps
                // of the same cue while a finger moves is a stutter, not feedback.
                onValueChangeFinished = { SoundEffects.preview(context) },
                valueRange = 0f..100f,
                steps = 19,
            )
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_notifications),
                hint = stringResource(R.string.cloud_settings_notifications_hint),
                checked = notifications,
                onCheckedChange = { settings.cloudNotifications = it },
            )
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_vibration),
                hint = stringResource(R.string.cloud_settings_vibration_hint),
                checked = vibration,
                onCheckedChange = { settings.cloudVibration = it },
            )
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_typing),
                hint = stringResource(R.string.cloud_settings_typing_hint),
                checked = typingIndicator,
                onCheckedChange = { settings.cloudTypingIndicator = it },
            )
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_show_deleted),
                hint = stringResource(R.string.cloud_settings_show_deleted_hint),
                checked = showDeletedMessages,
                onCheckedChange = { settings.showDeletedMessages = it },
            )
            val sysNotificationsEnabled = remember(cacheRefresh) { AppPermissions.areNotificationsEnabled(context) }
            if (notifications && !sysNotificationsEnabled) {
                Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.cloud_settings_notif_system_off),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    OutlinedButton(
                        onClick = {
                            runCatching { context.startActivity(AppPermissions.notificationSettingsIntent(context)) }
                        },
                        shape = MaterialTheme.shapes.small,
                    ) { Text(stringResource(R.string.cloud_settings_notif_system_open)) }
                }
            }

            SettingHeading(stringResource(R.string.cloud_settings_calls))
            ChoiceRow(stringResource(R.string.cloud_settings_ringtone)) {
                for ((value, label) in ringtoneOptions()) {
                    SettingChip(stringResource(label), callRingtone == value) {
                        settings.callRingtone = value
                        // Heard on tap, like the sound packs: a ringtone you
                        // first hear when somebody actually calls is a guess.
                        CallRingPreview.play(context, value)
                    }
                }
            }
            // API 34 stopped granting USE_FULL_SCREEN_INTENT at install time
            // to anything that is not a dialer, and without it an incoming
            // call cannot raise its own screen over the keyguard — it
            // degrades to a heads-up a locked, dark phone never shows. The
            // one-time prompt at first launch is easy to dismiss and never
            // came back; this row is the way in afterwards, and it says which
            // of the two states this install is actually in.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val fullScreenAllowed = remember(cacheRefresh) { CallRinger.canUseFullScreenIntent(context) }
                Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(
                            if (fullScreenAllowed) R.string.cloud_settings_fullscreen_on
                            else R.string.cloud_settings_fullscreen_off,
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(
                        onClick = {
                            val intent = Intent(
                                AndroidSettings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                                Uri.parse("package:${context.packageName}"),
                            )
                            // Re-checked when the sheet is next recomposed by
                            // the same counter the cache row uses.
                            runCatching { context.startActivity(intent) }
                            cacheRefresh++
                        },
                        shape = MaterialTheme.shapes.small,
                    ) { Text(stringResource(R.string.cloud_settings_fullscreen_open)) }
                }
            }

            SettingHeading(stringResource(R.string.cloud_settings_storage))
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_cache),
                hint = stringResource(R.string.cloud_settings_cache_hint),
                checked = offlineCache,
                onCheckedChange = {
                    settings.offlineCache = it
                    if (!it) {
                        controller.clearHistoryCache()
                        cacheRefresh++
                    }
                },
            )
            Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(
                        R.string.cloud_settings_cache_size,
                        if (cacheBytes < 0) "…" else formatBytes(cacheBytes),
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(
                    onClick = {
                        controller.clearHistoryCache()
                        cacheRefresh++
                    },
                    shape = MaterialTheme.shapes.small,
                ) { Text(stringResource(R.string.cloud_settings_cache_clear)) }
            }

            SettingHeading(stringResource(R.string.cloud_settings_connection))
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_background),
                hint = stringResource(R.string.cloud_settings_background_hint),
                checked = backgroundService,
                onCheckedChange = { settings.backgroundService = it },
            )
            SettingToggleRow(
                title = stringResource(R.string.cloud_settings_keep_hot),
                hint = stringResource(R.string.cloud_settings_keep_hot_hint),
                checked = keepLinkHot,
                onCheckedChange = { settings.keepLinkHot = it },
            )
            val batteryOptIgnored = remember(cacheRefresh) { AppPermissions.isBatteryOptimizationIgnored(context) }
            if (backgroundService && !batteryOptIgnored) {
                Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.cloud_settings_battery_opt_off),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    OutlinedButton(
                        onClick = {
                            runCatching { context.startActivity(AppPermissions.batteryOptimizationSettingsIntent(context)) }
                        },
                        shape = MaterialTheme.shapes.small,
                    ) { Text(stringResource(R.string.cloud_settings_battery_opt_open)) }
                }
            }

            SettingHeading(stringResource(R.string.cloud_settings_language))
            val language = remember(cacheRefresh) { AppLocale.current(context) }
            ChoiceRow(null) {
                for ((value, label) in langOptions()) {
                    SettingChip(stringResource(label), language == value) {
                        // A language change re-reads every string in the tree, so
                        // the activity is rebuilt rather than recomposed — and on
                        // API 33+ the platform does that itself (see AppLocale).
                        if (AppLocale.apply(context, value)) (context as? Activity)?.recreate()
                    }
                }
            }

            if (onP2P != null || onLogout != null) {
                SettingHeading(stringResource(R.string.cloud_settings_account))
                if (onP2P != null) {
                    OutlinedButton(
                        onClick = onP2P,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.p2p_open)) }
                    Spacer(Modifier.height(8.dp))
                }
                if (onLogout != null) {
                    OutlinedButton(
                        onClick = onLogout,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.cloud_logout)) }
                }
            }

            UpdateCheckSection(controller)

            SettingHeading(stringResource(R.string.cloud_settings_diagnostics))
            Text(
                text = stringResource(R.string.cloud_diag_build, appVersion(context), appVersionCode(context)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = stringResource(R.string.cloud_diag_status, cloudStatusText(cloudState.link)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = stringResource(
                    R.string.cloud_diag_server_caps,
                    cloudState.serverCaps.takeIf(Set<String>::isNotEmpty)?.sorted()?.joinToString(", ")
                        ?: stringResource(R.string.cloud_diag_server_caps_none),
                ),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = cloudState.oldestPendingCreatedAt?.let {
                    stringResource(R.string.cloud_diag_pending_age, formatAge(System.currentTimeMillis() - it))
                } ?: stringResource(R.string.cloud_diag_pending_empty),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = cloudState.failed.lastOrNull()?.let {
                    stringResource(R.string.cloud_diag_last_error, it.reason, it.kind)
                } ?: stringResource(R.string.cloud_diag_last_error_none),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            var showDiagnostics by remember { mutableStateOf(false) }
            OutlinedButton(
                onClick = { showDiagnostics = true },
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            ) { Text(stringResource(R.string.cloud_diag_export)) }
            if (showDiagnostics) {
                DiagnosticsExportDialog(
                    report = buildDiagnosticsReport(context, cloudState),
                    onDismiss = { showDiagnostics = false },
                )
            }

            Text(
                text = stringResource(R.string.cloud_settings_version, appVersion(context)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 16.dp),
            )
            // No confirmation button at the foot of the sheet: a bottom sheet
            // already has its own way out — the drag down, the scrim, the Back
            // gesture — and everything on it applies the moment it is touched,
            // so «Готово» confirmed nothing (owner: «в настройках done
            // избыточно»). The same reason there is no Done on the other
            // sheets in this screen.
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** The picked file, copied into this app's own storage. Returns null when the
 *  document cannot be read at all, which is the only failure worth reporting —
 *  the caller simply keeps the previous cue. */
private fun copyCustomCue(context: android.content.Context, uri: Uri): String? = runCatching {
    val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "cue"
    val safe = name.filter { it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' }.takeLast(48)
        .ifBlank { "cue.mp3" }
    val target = File(context.filesDir, "cue-$safe")
    context.contentResolver.openInputStream(uri)?.use { input ->
        target.outputStream().use { output -> input.copyTo(output) }
    } ?: return@runCatching null
    // A notification channel reads this file as a Uri from outside this app's
    // process, which world-unreadable app storage would refuse.
    target.setReadable(true, false)
    target.absolutePath
}.getOrNull()

internal fun appVersion(context: android.content.Context): String = runCatching {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
}.getOrDefault("")

private fun appVersionCode(context: android.content.Context): Long = runCatching {
    androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(
        context.packageManager.getPackageInfo(context.packageName, 0),
    )
}.getOrDefault(0L)

@Composable
private fun cloudStatusText(link: net.tailchat.android.cloud.CloudLink): String = stringResource(
    when (link) {
        net.tailchat.android.cloud.CloudLink.SignedOut -> R.string.cloud_status_signed_out
        net.tailchat.android.cloud.CloudLink.Connecting -> R.string.cloud_status_connecting
        net.tailchat.android.cloud.CloudLink.Online -> R.string.cloud_status_online
        net.tailchat.android.cloud.CloudLink.Offline -> R.string.cloud_status_offline
    },
)

/** A duration in plain, unlocalized units — the same choice [formatBytes]
 *  already makes for a technical number nobody needs translated. */
private fun formatAge(ms: Long): String {
    val totalSec = (ms / 1000).coerceAtLeast(0)
    return when {
        totalSec < 60 -> "${totalSec}s"
        totalSec < 3600 -> "${totalSec / 60}m"
        totalSec < 86400 -> "${totalSec / 3600}h"
        else -> "${totalSec / 86400}d"
    }
}

/**
 * Exactly the numbers the settings screen already shows, joined into one
 * copy/share-able block. Deliberately excludes anything [CloudSettingsSheet]'s
 * own KDoc promises never leaves the device except through this explicit,
 * previewed action: no session token, no recovery key, no message text, no
 * peer logins, no media.
 */
private fun buildDiagnosticsReport(context: android.content.Context, state: CloudState): String {
    val caps = state.serverCaps.takeIf(Set<String>::isNotEmpty)?.sorted()?.joinToString(", ") ?: "none"
    val pendingAge = state.oldestPendingCreatedAt?.let { formatAge(System.currentTimeMillis() - it) } ?: "empty"
    val lastError = state.failed.lastOrNull()?.let { "${it.kind}: ${it.reason}" } ?: "none"
    return buildString {
        appendLine("Tailchat Android diagnostics")
        appendLine("version: ${appVersion(context)} (${appVersionCode(context)})")
        appendLine("link: ${state.link}")
        appendLine("server capabilities: $caps")
        appendLine("queued (open conversation / total): ${state.queuedHere} / ${state.queuedTotal}")
        appendLine("oldest pending operation: $pendingAge")
        appendLine("last error: $lastError")
        appendLine("degraded: ${state.degraded ?: "no"}")
        appendLine("local store failed: ${state.storeFailed}")
    }
}

/** The explicit action + preview the diagnostics export requires: nothing
 *  leaves the process until the person reads this and taps Share. */
@Composable
private fun DiagnosticsExportDialog(report: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.cloud_diag_export_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    stringResource(R.string.cloud_diag_export_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(12.dp))
                Text(report, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
            }
        },
        confirmButton = {
            Button(shape = MaterialTheme.shapes.small, onClick = {
                val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(android.content.Intent.EXTRA_TEXT, report)
                }
                context.startActivity(android.content.Intent.createChooser(intent, null))
                onDismiss()
            }) { Text(stringResource(R.string.cloud_diag_share)) }
        },
        dismissButton = {
            Row {
                OutlinedButton(
                    shape = MaterialTheme.shapes.small,
                    onClick = { clipboard.setText(AnnotatedString(report)) },
                ) { Text(stringResource(R.string.cloud_copy)) }
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cloud_invite_close)) }
            }
        },
    )
}

private fun modeOptions() = listOf(
    ThemeMode.Auto to R.string.cloud_theme_system,
    ThemeMode.Light to R.string.cloud_theme_light,
    ThemeMode.Dark to R.string.cloud_theme_dark,
)

private fun paletteOptions() = listOf(
    AppPalette.Paper to R.string.cloud_theme_paper,
    AppPalette.Green to R.string.cloud_theme_green,
    AppPalette.Amber to R.string.cloud_theme_amber,
    AppPalette.Blue to R.string.cloud_theme_blue,
    AppPalette.Matrix to R.string.cloud_theme_matrix,
    AppPalette.Mono to R.string.cloud_theme_mono,
)

private fun fontOptions() = listOf(
    AppFont.Serif to R.string.cloud_font_serif,
    AppFont.Mono to R.string.cloud_font_mono,
    AppFont.Sans to R.string.cloud_font_sans,
)

private fun roundOptions() = listOf(
    AppRoundness.Sharp to R.string.cloud_round_sharp,
    AppRoundness.Soft to R.string.cloud_round_soft,
    AppRoundness.Round to R.string.cloud_round_round,
)

/** `aurora` first — the default, and web's order since 1.128 — then the other
 *  drawn patterns, then the plain page and the three hairline ones. */
private fun wallpaperOptions() = listOf(
    ChatWallpaper.Aurora to R.string.cloud_wallpaper_aurora,
    ChatWallpaper.Waves to R.string.cloud_wallpaper_waves,
    ChatWallpaper.Topo to R.string.cloud_wallpaper_topo,
    ChatWallpaper.Doodle to R.string.cloud_wallpaper_doodle,
    ChatWallpaper.None to R.string.cloud_wallpaper_none,
    ChatWallpaper.Dots to R.string.cloud_wallpaper_dots,
    ChatWallpaper.Ruled to R.string.cloud_wallpaper_ruled,
    ChatWallpaper.Diamond to R.string.cloud_wallpaper_diamond,
)

private fun packOptions() = listOf(
    SoundPack.Classic to R.string.cloud_pack_classic,
    SoundPack.Soft to R.string.cloud_pack_soft,
    SoundPack.Terminal to R.string.cloud_pack_terminal,
    SoundPack.Custom to R.string.cloud_pack_custom,
)

private fun ringtoneOptions() = listOf(
    CallRingtone.Phone to R.string.cloud_ringtone_phone,
    CallRingtone.Chime to R.string.cloud_ringtone_chime,
    CallRingtone.Classic to R.string.cloud_ringtone_classic,
    CallRingtone.Pulse to R.string.cloud_ringtone_pulse,
)

private fun langOptions() = listOf(
    AppLang.System to R.string.cloud_lang_system,
    AppLang.Ru to R.string.cloud_lang_ru,
    AppLang.En to R.string.cloud_lang_en,
)

@Composable
internal fun SettingHeading(text: String) {
    Spacer(Modifier.height(18.dp))
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
    )
    Spacer(Modifier.height(4.dp))
}

/** A labelled row of chips that scrolls sideways: five schemes and four scales
 *  do not fit a phone's width, and wrapping them turns one question into two
 *  ragged lines. */
@Composable
private fun ChoiceRow(label: String?, content: @Composable () -> Unit) {
    if (label != null) ChoiceLabel(label)
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

/** The caption over one appearance question, shared by the chip rows and the
 *  wallpaper grid so the two cannot drift apart. */
@Composable
private fun ChoiceLabel(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 8.dp),
    )
    Spacer(Modifier.height(4.dp))
}

@Composable
private fun SettingChip(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    // With «Обводки» off an unselected chip has no edge to be seen by, so it
    // takes the raised tone and the selected one the accent's soft fill.
    val outlines = LocalTailchatAccents.current.outlines
    val scheme = MaterialTheme.colorScheme
    FilterChip(
        selected = selected,
        enabled = enabled,
        onClick = onClick,
        label = { Text(label) },
        colors = FilterChipDefaults.filterChipColors(
            containerColor = if (outlines) Color.Transparent else scheme.surfaceVariant,
            selectedContainerColor = if (outlines) scheme.secondaryContainer else scheme.primaryContainer,
        ),
    )
}

/**
 * One wallpaper in the settings grid: [WallpaperPreview] filling its cell with
 * its name under it, the whole card the control — a chip reading «Ромб» next to
 * one reading «Точки» answers nothing, since the difference between the two
 * patterns is exactly what a word cannot carry. [Modifier.selectable] rather
 * than a plain click so a screen reader announces the choice the same way it
 * does the palette and font rows above it. The card rests on the page at
 * `--elev-1`, as web's `.wallpaper-preview` does.
 */
@Composable
private fun WallpaperCard(
    value: ChatWallpaper,
    label: Int,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onPick: () -> Unit,
) {
    val depth = LocalTailchatDepth.current
    Column(
        modifier = modifier
            .selectable(selected = selected, role = Role.RadioButton, onClick = onPick)
            .padding(2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WallpaperPreview(
            value,
            Modifier.fillMaxWidth()
                .dropShadows(depth.card.shadows, WallpaperPreviewShape, outsideOnly = false)
                .border(
                    width = if (selected) 2.dp else 1.dp,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                    shape = WallpaperPreviewShape,
                ),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            stringResource(label),
            style = MaterialTheme.typography.labelSmall,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SettingToggleRow(title: String, hint: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                checkedTrackColor = MaterialTheme.colorScheme.primary,
                uncheckedTrackColor = MaterialTheme.colorScheme.surfaceVariant,
                uncheckedThumbColor = LocalTailchatAccents.current.line,
                uncheckedBorderColor = MaterialTheme.colorScheme.outline,
            ),
        )
    }
}

/**
 * Adding a friend: by their `@username`, which is the way it is normally done
 * and so comes first, or with a one-time code — created here to hand out, or
 * redeemed after someone handed one over. Every action and its result flow
 * through [CloudController]/[CloudState] like everything else in the cloud
 * client.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CloudInviteDialog(controller: CloudController, state: CloudState, onDismiss: () -> Unit) {
    val depth = LocalTailchatDepth.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    // The request is a round trip, and a second press while it is in flight
    // would send the same one twice.
    var requesting by remember { mutableStateOf(false) }

    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.cloud_invite_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                state.lastAcceptedFriend?.let { friend ->
                    Surface(
                        shape = MaterialTheme.shapes.small,
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        modifier = Modifier.fillMaxWidth()
                            .dropShadows(depth.card.shadows, MaterialTheme.shapes.small)
                            .rim(depth.card.edge, MaterialTheme.shapes.small),
                    ) {
                        Text(
                            stringResource(R.string.cloud_invite_accepted_toast, friend.name),
                            Modifier.padding(12.dp),
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                }
                state.friendRequestSent?.let { login ->
                    Surface(
                        shape = MaterialTheme.shapes.small,
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        modifier = Modifier.fillMaxWidth()
                            .dropShadows(depth.card.shadows, MaterialTheme.shapes.small)
                            .rim(depth.card.edge, MaterialTheme.shapes.small),
                    ) {
                        Text(
                            stringResource(R.string.cloud_friend_request_sent, login),
                            Modifier.padding(12.dp),
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                }
                state.failure?.let { failure ->
                    Text(
                        cloudFailureText(failure),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(12.dp))
                }

                Text(stringResource(R.string.cloud_friend_request), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                Text(
                    stringResource(R.string.cloud_friend_request_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it.trim() },
                    label = { Text(stringResource(R.string.cloud_friend_request_label)) },
                    singleLine = true,
                    shape = MaterialTheme.shapes.small,
                    colors = tailchatFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        val login = username
                        username = ""
                        scope.launch {
                            requesting = true
                            try {
                                controller.requestFriend(login)
                            } finally {
                                requesting = false
                            }
                        }
                    },
                    enabled = !requesting && username.removePrefix("@").isNotBlank(),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.cloud_friend_request_action))
                }

                Spacer(Modifier.height(20.dp))
                Text(stringResource(R.string.cloud_invite_create), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                Text(
                    stringResource(R.string.cloud_invite_create_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(8.dp))
                val invite = state.inviteCode
                if (invite != null) {
                    // What is shown is what gets shared: the same link the command's
                    // note prints and that every client redeems, built here so the
                    // state keeps holding only the bare code the server answered with.
                    val link = CloudApi.inviteUrl(state.server, invite) ?: invite
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            link,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedButton(onClick = { clipboard.setText(AnnotatedString(link)) }, shape = MaterialTheme.shapes.small) {
                            Text(stringResource(R.string.cloud_copy))
                        }
                    }
                } else {
                    OutlinedButton(onClick = controller::createInvite, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.cloud_invite_create_action))
                    }
                }

                Spacer(Modifier.height(20.dp))
                Text(stringResource(R.string.cloud_invite_accept), style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.trim() },
                    label = { Text(stringResource(R.string.cloud_invite_code_label)) },
                    singleLine = true,
                    shape = MaterialTheme.shapes.small,
                    colors = tailchatFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = { controller.acceptInvite(code); code = "" },
                    enabled = code.isNotBlank(),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.cloud_invite_accept_action))
                }
            }
        },
        confirmButton = {
            Button(shape = MaterialTheme.shapes.small, onClick = {
                controller.clearInviteCode()
                controller.clearLastAcceptedFriend()
                controller.clearFriendRequestSent()
                onDismiss()
            }) { Text(stringResource(R.string.cloud_invite_close)) }
        },
    )
}
