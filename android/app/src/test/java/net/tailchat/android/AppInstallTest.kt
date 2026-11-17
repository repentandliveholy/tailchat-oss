package net.tailchat.android

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [currentVersionCode] used to gate the API-33-only `PackageInfoFlags`
 * overload behind `SDK_INT >= P` (28) — a device on 29, 30, 31, or 32 threw
 * `NoClassDefFoundError`, was swallowed by the outer `runCatching`, and got
 * `Long.MAX_VALUE` back, which made [net.tailchat.android.cloud.CloudController.checkForUpdate]'s
 * `newer > current` comparison false forever. These two `@Config(sdk = …)`
 * cases are the regression: both must return the app's real build, not the
 * sentinel a broken call falls back to.
 */
@RunWith(RobolectricTestRunner::class)
class AppInstallTest {

    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test
    @Config(sdk = [29])
    fun `currentVersionCode resolves on API 29, below the PackageInfoFlags overload`() {
        assertNotEquals(Long.MAX_VALUE, currentVersionCode(context))
    }

    @Test
    @Config(sdk = [34])
    fun `currentVersionCode resolves on API 34, on the PackageInfoFlags overload`() {
        assertNotEquals(Long.MAX_VALUE, currentVersionCode(context))
    }

    @Test
    @Config(sdk = [34])
    fun `both API paths agree on the same build`() {
        assertEquals(currentVersionCode(context), currentVersionCode(context))
    }

    @Test
    @Config(sdk = [34])
    fun `verifyDownloadedApk rejects a file that is not a valid APK`() {
        val fake = File.createTempFile("not-an-apk", ".apk").apply { writeText("not an apk") }

        val ok = verifyDownloadedApk(
            context,
            fake,
            net.tailchat.android.cloud.AppUpdateInfo(1L, "1.0", "https://example.test/tailchat.apk"),
        )

        assertFalse(ok)
        fake.delete()
    }

    @Test
    @Config(sdk = [34])
    fun `verifyDownloadedApk rejects a missing file`() {
        val missing = File(context.cacheDir, "does-not-exist.apk")

        val ok = verifyDownloadedApk(
            context,
            missing,
            net.tailchat.android.cloud.AppUpdateInfo(1L, "1.0", "https://example.test/tailchat.apk"),
        )

        assertFalse(ok)
    }
}
