package net.tailchat.android.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import net.tailchat.android.AppPermissions
import net.tailchat.android.R
import net.tailchat.android.cloud.CloudController

class InstallPermissionGate(
    val canInstall: Boolean,
    val requestInstallPermission: () -> Unit,
    val requestUpdate: () -> Unit,
)

/**
 * Hosts the single install-permission lifecycle gate and explain-dialog for both
 * the roster's [UpdateBarButton] and [UpdateCheckSection].
 *
 * Android provides no useful resultCode from `ACTION_MANAGE_UNKNOWN_APP_SOURCES`,
 * so detecting a newly-granted permission must re-check on lifecycle ON_RESUME.
 * When the user tapped "Update" while permission was missing, the dialog sends
 * them to Settings; when they return with the permission granted, the download
 * starts automatically.
 */
@Composable
fun rememberInstallPermissionGate(controller: CloudController): InstallPermissionGate {
    val context = LocalContext.current
    var permRefresh by remember { mutableStateOf(0) }
    var pendingUpdateDownload by remember { mutableStateOf(false) }
    var showDialog by remember { mutableStateOf(false) }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        permRefresh++
        if (pendingUpdateDownload) {
            pendingUpdateDownload = false
            if (AppPermissions.canInstallUpdates(context)) {
                controller.downloadUpdate()
            }
        }
    }

    val canInstall = remember(permRefresh) { AppPermissions.canInstallUpdates(context) }

    if (showDialog) {
        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(stringResource(R.string.cloud_update_perm_dialog_title)) },
            text = { Text(stringResource(R.string.cloud_update_perm_dialog_msg)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDialog = false
                        pendingUpdateDownload = true
                        runCatching { context.startActivity(AppPermissions.requestInstallPermissionIntent(context)) }
                    },
                ) {
                    Text(stringResource(R.string.cloud_update_perm_dialog_settings))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDialog = false }) {
                    Text(stringResource(R.string.cloud_invite_close))
                }
            },
        )
    }

    return remember(canInstall) {
        InstallPermissionGate(
            canInstall = canInstall,
            requestInstallPermission = {
                runCatching { context.startActivity(AppPermissions.requestInstallPermissionIntent(context)) }
                permRefresh++
            },
            requestUpdate = {
                if (canInstall) {
                    controller.downloadUpdate()
                } else {
                    showDialog = true
                }
            },
        )
    }
}
