package net.tailchat.android

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.core.content.FileProvider
import java.io.File

/**
 * Self-update install plumbing. There is no programmatic install for a
 * sideloaded APK — Android reserves the "do you want to install this
 * update?" confirmation for the user on every non-Play-Store package, the
 * same way [RequestBatteryExemptionOnce][net.tailchat.android.MainActivity]'s
 * battery dialog cannot be silently granted. What this file does own is
 * everything around that one unavoidable tap: checking whether the
 * permission that gates it is held, sending the user to grant it when it is
 * not, and handing the downloaded APK to the installer through the
 * `FileProvider` declared in the manifest rather than a raw `file://` URI,
 * which Android has refused with `FileUriExposedException` since N.
 */

/** Whether this app currently holds the "install unknown apps" grant a
 *  non-Play-Store package-installer intent needs to actually install rather
 *  than silently bounce to Settings. */
fun canInstallPackages(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

/** The one settings screen Android defines for granting [canInstallPackages]
 *  to this app specifically — scoped by `package:`, the same targeting
 *  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`'s intent uses. */
fun requestInstallPermissionIntent(context: Context): Intent =
    Intent(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

/**
 * The last check before [installApk] gets the file: the expected package
 * name and `versionCode` from the same `android-version.json` [apk] was
 * downloaded against, read out of the downloaded file itself rather than
 * trusted from the HTTP response. This catches a truncated download, an
 * error page saved with a `.apk` name, or a stale/wrong server response —
 * none of which the platform's own install-time signature check has any
 * opinion on, since all three are either not a valid APK at all or a
 * validly-signed one for the wrong build.
 */
fun verifyDownloadedApk(context: Context, apk: File, expected: net.tailchat.android.cloud.AppUpdateInfo): Boolean {
    val info = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
        runCatching {
            context.packageManager.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(0))
        }.getOrNull()
    } else {
        @Suppress("DEPRECATION")
        runCatching { context.packageManager.getPackageArchiveInfo(apk.path, 0) }.getOrNull()
    } ?: return false
    return info.packageName == context.packageName && info.longVersionCode == expected.versionCode
}

/**
 * Hands [apk] to the system package installer. Accepting its confirmation
 * kills this process and installs over the running APK. The system's own
 * post-install "App installed" screen then offers "Open" — that, not a
 * self-launched Activity, is what completes "close, update, reopen": a
 * `MY_PACKAGE_REPLACED` broadcast receiver has no background-activity-start
 * exemption on modern Android (verified: a direct `startActivity` from
 * `BootReceiver` was silently dropped by BAL on API 34/35), so nothing here
 * or in `BootReceiver` attempts it. `BootReceiver` still restarts the
 * background socket/service on `MY_PACKAGE_REPLACED`, which *is* an allowed
 * foreground-service-start exemption — a materially different permission
 * class from starting a visible Activity.
 */
fun installApk(context: Context, apk: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
}

/**
 * This install's `versionCode` (`longVersionCode` on API 28+, where a plain
 * `versionCode` int can no longer express it), the same runtime source
 * `CloudSettingsSheet`'s `appVersion()` reads `versionName` from — nothing
 * here depends on `BuildConfig`, which this module does not generate.
 *
 * The `PackageInfoFlags` overload only exists from API 33 (Tiramisu) —
 * calling it on API 29–32 (within this app's `minSdk`) throws
 * `NoSuchMethodError`, which the outer `runCatching` swallowed into
 * `Long.MAX_VALUE`: on every device below 33 this silently reported the
 * current build as newer than anything the server could ever offer, so
 * self-update never fired at all. The gate below gets the API level right;
 * `longVersionCode` itself has existed on the returned `PackageInfo` since
 * 28 regardless of which overload produced it.
 */
fun currentVersionCode(context: Context): Long = runCatching {
    val info = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(context.packageName, 0)
    }
    info.longVersionCode
}.getOrDefault(Long.MAX_VALUE) // unknown current version must never look "outdated"
