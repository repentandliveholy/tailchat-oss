package net.tailchat.android

import net.tailchat.android.cloud.AppUpdateInfo
import net.tailchat.android.cloud.updateToPublish
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.provider.Settings as AndroidSettings
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class AppPermissionsTest {

    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test
    @Config(sdk = [34])
    fun `canInstallUpdates agrees with canInstallPackages`() {
        assertEquals(canInstallPackages(context), AppPermissions.canInstallUpdates(context))
    }

    @Test
    @Config(sdk = [34])
    fun `requestInstallPermissionIntent targets this app package`() {
        val intent = AppPermissions.requestInstallPermissionIntent(context)
        assertEquals(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, intent.action)
        assertEquals("package:${context.packageName}", intent.dataString)
        assertTrue((intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK) != 0)
    }

    @Test
    @Config(sdk = [34])
    fun `areNotificationsEnabled returns a boolean without throwing`() {
        val enabled = AppPermissions.areNotificationsEnabled(context)
        // Robolectric environment defaults to notifications allowed or disallowable
        assertTrue(enabled == true || enabled == false)
    }

    @Test
    @Config(sdk = [34])
    fun `areNotificationsEnabled reports false when message channel is blocked`() {
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel("messages_test", "Messages", NotificationManager.IMPORTANCE_NONE)
        nm.createNotificationChannel(channel)
        try {
            assertFalse(AppPermissions.areNotificationsEnabled(context))
        } finally {
            nm.deleteNotificationChannel("messages_test")
        }
    }

    @Test
    @Config(sdk = [34])
    fun `areNotificationsEnabled reports false when incoming call channel is blocked`() {
        val nm = context.getSystemService(NotificationManager::class.java)
        val incoming = NotificationChannel("calls_v3", "Incoming Calls", NotificationManager.IMPORTANCE_NONE)
        val ongoing = NotificationChannel("calls_ongoing_v1", "Ongoing Call", NotificationManager.IMPORTANCE_LOW)
        nm.createNotificationChannel(incoming)
        nm.createNotificationChannel(ongoing)
        try {
            assertFalse(AppPermissions.areNotificationsEnabled(context))
        } finally {
            nm.deleteNotificationChannel("calls_v3")
            nm.deleteNotificationChannel("calls_ongoing_v1")
        }
    }

    @Test
    @Config(sdk = [34])
    fun `notificationSettingsIntent targets this package on modern Android`() {
        val intent = AppPermissions.notificationSettingsIntent(context)
        assertEquals(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS, intent.action)
        assertEquals(context.packageName, intent.getStringExtra(AndroidSettings.EXTRA_APP_PACKAGE))
        assertTrue((intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK) != 0)
    }

    @Test
    @Config(sdk = [34])
    fun `isBatteryOptimizationIgnored returns a boolean without throwing`() {
        val ignored = AppPermissions.isBatteryOptimizationIgnored(context)
        assertTrue(ignored == true || ignored == false)
    }

    @Test
    @Config(sdk = [34])
    fun `batteryOptimizationSettingsIntent targets this package`() {
        val intent = AppPermissions.batteryOptimizationSettingsIntent(context)
        assertEquals(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, intent.action)
        assertEquals("package:${context.packageName}", intent.dataString)
        assertTrue((intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK) != 0)
    }

    @Test
    @Config(sdk = [34])
    fun `installPermissionPromptDismissed defaults to false and persists`() {
        val settings = Settings(context)
        assertFalse(settings.installPermissionPromptDismissed)

        settings.installPermissionPromptDismissed = true
        assertTrue(settings.installPermissionPromptDismissed)

        val reloaded = Settings(context)
        assertTrue(reloaded.installPermissionPromptDismissed)

        settings.installPermissionPromptDismissed = false
        assertFalse(Settings(context).installPermissionPromptDismissed)
    }

    @Test
    @Config(sdk = [34])
    fun `notificationPermissionPromptDismissed defaults to false and persists`() {
        val settings = Settings(context)
        assertFalse(settings.notificationPermissionPromptDismissed)

        settings.notificationPermissionPromptDismissed = true
        assertTrue(settings.notificationPermissionPromptDismissed)

        val reloaded = Settings(context)
        assertTrue(reloaded.notificationPermissionPromptDismissed)

        settings.notificationPermissionPromptDismissed = false
        assertFalse(Settings(context).notificationPermissionPromptDismissed)
    }

    @Test
    @Config(sdk = [34])
    fun `dismissedUpdateVersionCode defaults to 0 and persists`() {
        val settings = Settings(context)
        assertEquals(0L, settings.dismissedUpdateVersionCode)

        settings.dismissedUpdateVersionCode = 165L
        assertEquals(165L, settings.dismissedUpdateVersionCode)

        val reloaded = Settings(context)
        assertEquals(165L, reloaded.dismissedUpdateVersionCode)

        settings.dismissedUpdateVersionCode = 0L
        assertEquals(0L, Settings(context).dismissedUpdateVersionCode)
    }

    @Test
    fun `updateToPublish publishes fresh newer build on auto check`() {
        val info = AppUpdateInfo(166L, "0.76.61", "https://example.test/app.apk")
        val result = updateToPublish(info, currentCode = 165L, dismissedCode = 0L, manual = false)
        assertEquals(info, result)
    }

    @Test
    fun `updateToPublish skips dismissed build on auto check`() {
        val info = AppUpdateInfo(165L, "0.76.60", "https://example.test/app.apk")
        val result = updateToPublish(info, currentCode = 164L, dismissedCode = 165L, manual = false)
        assertEquals(null, result)
    }

    @Test
    fun `updateToPublish allows dismissed build on manual check`() {
        val info = AppUpdateInfo(165L, "0.76.60", "https://example.test/app.apk")
        val result = updateToPublish(info, currentCode = 164L, dismissedCode = 165L, manual = true)
        assertEquals(info, result)
    }

    @Test
    fun `updateToPublish publishes when newer build exceeds dismissed code`() {
        val info = AppUpdateInfo(166L, "0.76.61", "https://example.test/app.apk")
        val result = updateToPublish(info, currentCode = 164L, dismissedCode = 165L, manual = false)
        assertEquals(info, result)
    }

    @Test
    fun `updateToPublish returns null when build is already current or older`() {
        val current = AppUpdateInfo(165L, "0.76.60", "https://example.test/app.apk")
        val older = AppUpdateInfo(164L, "0.76.59", "https://example.test/app.apk")
        assertEquals(null, updateToPublish(current, currentCode = 165L, dismissedCode = 0L, manual = false))
        assertEquals(null, updateToPublish(older, currentCode = 165L, dismissedCode = 0L, manual = true))
    }
}
