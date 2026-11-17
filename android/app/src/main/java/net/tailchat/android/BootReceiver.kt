package net.tailchat.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import net.tailchat.android.cloud.CloudSessionStore
import net.tailchat.android.data.DeviceDataKey
import net.tailchat.android.data.DeviceMigration

/**
 * Without this, a reboot leaves the chat channel dead — no socket, no
 * notifications — until the user remembers to reopen the app by hand. That
 * silently defeats "notifications always work" for the single most common
 * reason a phone's process state resets, one a live-app reconnect fix can
 * never reach since there is no process to reconnect from yet.
 *
 * Starting a foreground service from a `BOOT_COMPLETED`/
 * `MY_PACKAGE_REPLACED` receiver is one of Android's documented background
 * start exemptions, so this is allowed even on API 31+ as long as
 * [ChatService] promotes itself to the foreground promptly — which it
 * already does in `onCreate`.
 *
 * Only starts the service when there is actually something to reconnect: a
 * saved cloud session or a configured P2P peer. A fresh install that was
 * never signed into anything has nothing worth waking up for.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        val settings = Settings(context)
        // Background mode off: nothing is supposed to run — or sit in the
        // shade — until the person opens the app themselves.
        if (!settings.backgroundService) return
        if (DeviceMigration.needed(context) || runCatching { DeviceDataKey.get(context) }.isFailure) return
        val hasCloudSession = runCatching { CloudSessionStore(context).load() }.getOrNull() != null
        val hasP2PPeer = settings.configured
        if (!hasCloudSession && !hasP2PPeer) return
        ContextCompat.startForegroundService(context, Intent(context, ChatService::class.java))
    }
}
