package net.tailchat.android

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import androidx.core.app.NotificationManagerCompat

/**
 * Android system permissions and capabilities that directly gate this client's
 * core runtime contracts:
 *
 * 1. [canInstallUpdates] — [REQUEST_INSTALL_PACKAGES]: sideloaded APK updates
 *    (AppUpdateApi / installApk) cannot proceed without it.
 * 2. [areNotificationsEnabled] — [POST_NOTIFICATIONS] and system notification
 *    channels: without it, incoming messages and calls make no sound and show
 *    no notification in the system shade. Checks both app-level toggle and
 *    per-channel blocking on message and call channels.
 * 3. [isBatteryOptimizationIgnored] — [REQUEST_IGNORE_BATTERY_OPTIMIZATIONS]:
 *    Doze and OEM battery managers kill the background socket hours after the
 *    screen turns off unless exempt.
 */
object AppPermissions {

    fun canInstallUpdates(context: Context): Boolean = canInstallPackages(context)

    fun requestInstallPermissionIntent(context: Context): Intent =
        net.tailchat.android.requestInstallPermissionIntent(context)

    fun areNotificationsEnabled(context: Context): Boolean {
        val compat = NotificationManagerCompat.from(context)
        if (!compat.areNotificationsEnabled()) return false
        val channels = compat.notificationChannels
        if (channels.isEmpty()) return true
        val messageChannels = channels.filter { it.id.startsWith("messages") }
        if (messageChannels.isNotEmpty() && messageChannels.all { it.importance == NotificationManager.IMPORTANCE_NONE }) {
            return false
        }
        val callChannels = channels.filter { it.id.startsWith("calls_v") }
        if (callChannels.isNotEmpty() && callChannels.all { it.importance == NotificationManager.IMPORTANCE_NONE }) {
            return false
        }
        return true
    }

    fun notificationSettingsIntent(context: Context): Intent =
        Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    fun isBatteryOptimizationIgnored(context: Context): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return power?.isIgnoringBatteryOptimizations(context.packageName) ?: true
    }

    fun batteryOptimizationSettingsIntent(context: Context): Intent =
        Intent(
            AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
