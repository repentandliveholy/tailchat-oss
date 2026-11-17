package net.tailchat.android.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.tailchat.android.R
import net.tailchat.android.Transfer
import net.tailchat.android.cloud.CloudController
import net.tailchat.android.cloud.UpdateCheckResult

/**
 * The self-update control: installed version, current status, and a
 * check/download button. Shared between [CloudSettingsSheet] and the
 * direct-tailnet [SettingsSheet] so the update button is always present, in
 * every settings screen, for every user — not only signed-in cloud accounts.
 * [CloudController] stays alive and reachable for the whole app process
 * regardless of which screen is on top (see `ChatService`), and the fetch
 * itself is an unauthenticated same-origin static file, so it works before
 * sign-in too, against the configured or default server.
 *
 * A manual tap on "check for updates" always resolves to a popup — a new
 * build (with a way to update now or skip it with the close icon, same as
 * the roster's persistent update banner), "you're already current", or "the
 * check failed" — unlike [CloudController.checkForUpdate]'s silent
 * background checks on connect/reconnect, which never interrupt with a
 * dialog.
 */
@Composable
fun UpdateCheckSection(controller: CloudController) {
    val cloudState by controller.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var checking by remember { mutableStateOf(false) }
    var checkResult by remember { mutableStateOf<UpdateCheckResult?>(null) }
    val installGate = rememberInstallPermissionGate(controller)

    val update = cloudState.updateAvailable
    val download = cloudState.updateDownload

    SettingHeading(stringResource(R.string.cloud_update_check))
    Text(
        text = stringResource(R.string.cloud_settings_version, appVersion(context)),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 4.dp),
    )
    if (installGate.canInstall) {
        Text(
            text = stringResource(R.string.cloud_settings_install_perm_on),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 6.dp),
        )
    } else {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.cloud_settings_install_perm_off),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            OutlinedButton(
                onClick = installGate.requestInstallPermission,
                shape = MaterialTheme.shapes.small,
            ) {
                Text(stringResource(R.string.cloud_settings_install_perm_open))
            }
        }
    }
    if (download is Transfer.Progress) {
        val fraction = if (download.total > 0L) {
            (download.done.toDouble() / download.total.toDouble()).toFloat().coerceIn(0f, 1f)
        } else 0f
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        )
    } else {
        Text(
            text = update?.let { stringResource(R.string.cloud_update_available, it.versionName) }
                ?: stringResource(R.string.cloud_update_current),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        OutlinedButton(
            onClick = {
                if (update != null) {
                    installGate.requestUpdate()
                } else if (!checking) {
                    checking = true
                    scope.launch {
                        checkResult = controller.checkForUpdateNow()
                        checking = false
                    }
                }
            },
            enabled = !checking,
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(if (update != null) R.string.cloud_update_action else R.string.cloud_update_check))
        }
    }

    checkResult?.let { result ->
        AlertDialog(
            onDismissRequest = { checkResult = null },
            title = {
                Text(
                    when (result) {
                        is UpdateCheckResult.Available ->
                            stringResource(R.string.cloud_update_available, result.info.versionName)
                        UpdateCheckResult.UpToDate -> stringResource(R.string.cloud_update_current)
                        UpdateCheckResult.Failed -> stringResource(R.string.cloud_update_check_failed)
                    },
                )
            },
            confirmButton = {
                if (result is UpdateCheckResult.Available) {
                    TextButton(onClick = { checkResult = null; installGate.requestUpdate() }) {
                        Text(stringResource(R.string.cloud_update_action))
                    }
                } else {
                    TextButton(onClick = { checkResult = null }) {
                        Text(stringResource(R.string.cloud_invite_close))
                    }
                }
            },
            dismissButton = if (result is UpdateCheckResult.Available) {
                {
                    IconButton(onClick = { checkResult = null; controller.dismissUpdate() }) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.cloud_update_dismiss))
                    }
                }
            } else null,
        )
    }
}
