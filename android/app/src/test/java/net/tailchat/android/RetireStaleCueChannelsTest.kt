package net.tailchat.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [retireStaleCueChannels] is what repairs a phone that already has the bug: a
 * `messages_soft` channel created before the cue was addressed by name holds a
 * resource id that has since moved, and cannot be corrected in place — so it has
 * to go the moment the build that knows better posts its first notification.
 *
 * The scoping is the part worth a test: sweeping by prefix alone would delete
 * the silent twin (`messages_quiet_*`) and every other pack's channel along
 * with it, resetting settings the user made in the system's notification
 * screen for rows that were never broken.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RetireStaleCueChannelsTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    private val manager get() = context.getSystemService(NotificationManager::class.java)

    private fun channel(id: String) = NotificationChannel(
        id,
        id,
        NotificationManager.IMPORTANCE_HIGH,
    )

    @Test
    fun `the pre-name channel of the same pack is retired, the new one stays`() {
        // `messages_soft` is what an earlier build created: frozen onto a
        // resource id, with nothing in it to say which file that id is now.
        manager.createNotificationChannel(channel("messages_soft"))
        manager.createNotificationChannel(channel("messages_soft-received"))
        manager.createNotificationChannel(channel("messages_classic-received"))
        manager.createNotificationChannel(channel("messages_quiet_soft"))
        manager.createNotificationChannel(channel("wake_soft-received"))

        retireStaleCueChannels(manager, "messages_soft-received", "messages_soft")

        assertNull(
            "a channel frozen onto a resource id that has since moved cannot be repaired " +
                "in place, and it is what the user hears as a strange notification",
            manager.getNotificationChannel("messages_soft"),
        )
        assertNotNull(
            "the channel just created is the one this build posts to",
            manager.getNotificationChannel("messages_soft-received"),
        )
        assertNotNull(
            "another pack's channel is not this sweep's business",
            manager.getNotificationChannel("messages_classic-received"),
        )
        assertNotNull(
            "the silent twin is a separate channel with its own user settings",
            manager.getNotificationChannel("messages_quiet_soft"),
        )
        assertNotNull(
            "a wake cue is a different prefix, not a revision of a message cue",
            manager.getNotificationChannel("wake_soft-received"),
        )
    }
}
