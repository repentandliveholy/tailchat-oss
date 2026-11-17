package net.tailchat.android.call

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Both call notifications are `CallStyle`, and API 34 refuses to post a
 * `CallStyle` notification that is neither a foreground service's own
 * notification nor carries a full-screen intent — it throws
 * `IllegalArgumentException` («CallStyle notifications must be for a
 * foreground service or user initated job or use a fullScreenIntent»), which
 * is a process crash at the exact moment the person pressed Call. This app
 * posts both from `CallController`, never from `startForeground`, so the
 * full-screen intent is the only thing making them postable at all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallNotificationsTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    private fun posted(): Notification {
        val manager = context.getSystemService(NotificationManager::class.java)
        val all = shadowOf(manager).allNotifications
        assertEquals("exactly one call notification is expected", 1, all.size)
        return all.first()
    }

    @Test
    fun `the ongoing call notification is owned by the microphone service`() {
        CallNotifications(context).showOngoing("call-1", "beta", "Beta")

        // Not a plain post: Android silences the microphone of a process that
        // is neither visible nor holding a `microphone` foreground service, so
        // the service is what keeps a call audible once its screen goes dark.
        val started = shadowOf(context).nextStartedService
        assertNotNull("no foreground call service was started", started)
        assertEquals(CallService::class.java.name, started.component?.className)
    }

    @Test
    fun `the ongoing notification carries a full-screen intent`() {
        val notification = CallNotifications(context).ongoingNotification("call-1", "beta", "Beta")

        assertEquals(
            "Notification\$CallStyle",
            notification.extras.getString(Notification.EXTRA_TEMPLATE)?.substringAfterLast('.'),
        )
        assertNotNull(
            "a CallStyle notification with no full-screen intent is refused by the platform",
            notification.fullScreenIntent,
        )
    }

    @Test
    fun `an incoming call notification carries a full-screen intent`() {
        CallNotifications(context).showIncoming("call-1", "beta", "Beta")

        val notification = posted()
        assertEquals(
            "Notification\$CallStyle",
            notification.extras.getString(Notification.EXTRA_TEMPLATE)?.substringAfterLast('.'),
        )
        assertNotNull(
            "a CallStyle notification with no full-screen intent is refused by the platform",
            notification.fullScreenIntent,
        )
    }
}
