package net.tailchat.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import net.tailchat.android.data.DeviceDataKey
import net.tailchat.android.data.DeviceMigration
import net.tailchat.android.cloud.CloudSessionStore

/**
 * The periodic "is the socket still there" wake-up.
 *
 * It used to be an alarm that started the service directly
 * (`PendingIntent.getForegroundService`), which was wrong twice over. On API
 * 31+ an *inexact* `setAndAllowWhileIdle` alarm is not on the foreground-service
 * start exemption list, so when the process had been killed — the one case the
 * watchdog exists for — the start was either rejected outright or the following
 * `startForeground()` threw `ForegroundServiceStartNotAllowedException` out of
 * `onCreate`, crashing the process. `START_STICKY` and the next alarm then did
 * it again: a repeating crash with no user action, which is what raises
 * Android's "keeps stopping" dialog. And because the alarm was re-armed only
 * from inside the service, a single rejection killed the watchdog for good.
 *
 * A broadcast is always allowed to arrive. This receiver re-arms the next alarm
 * *first*, so the chain cannot break, and only then tries to start the service —
 * and only when starting it is actually legal (the app is battery-exempt, which
 * is the exemption Android does honour) and there is something to reconnect.
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_WATCHDOG) return
        schedule(context)
        val power = context.getSystemService(PowerManager::class.java)
        val exempt = power?.isIgnoringBatteryOptimizations(context.packageName) ?: false
        if (!exempt) return
        val settings = Settings(context)
        // Background mode off means the app promised to stay out of the way
        // while it is not on screen; waking it up on a timer would break that
        // promise (and put the shade row back).
        if (!settings.backgroundService) {
            cancel(context)
            return
        }
        if (DeviceMigration.needed(context) || runCatching { DeviceDataKey.get(context) }.isFailure) return
        val worth = runCatching { CloudSessionStore(context).load() }.getOrNull() != null || settings.configured
        if (!worth) return
        // Still guarded: the exemption can be revoked between the check and the
        // start, and an OEM build may refuse anyway. A failed wake-up is a
        // missed notification; a crash is a dialog telling the user the app is
        // broken.
        runCatching {
            ContextCompat.startForegroundService(
                context,
                Intent(context, ChatService::class.java).setAction(ChatService.ACTION_WATCHDOG),
            )
        }
    }

    companion object {
        const val ACTION_WATCHDOG = "net.tailchat.android.action.WATCHDOG_ALARM"

        /**
         * 20 minutes, and deliberately not a `*_WAKEUP` alarm: pulling the SoC
         * out of suspend 72 times a day to find the socket already online is
         * exactly the standby drain the OS blames the app for. Without WAKEUP
         * the check happens at the next time the device is awake anyway, which
         * for a phone that is picked up is soon enough.
         */
        private const val INTERVAL_MS = 20 * 60 * 1000L
        private const val REQUEST = 900

        fun cancel(context: Context) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            val pending = PendingIntent.getBroadcast(
                context,
                REQUEST,
                Intent(context, WatchdogReceiver::class.java).setAction(ACTION_WATCHDOG),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            runCatching { alarms.cancel(pending) }
        }

        fun schedule(context: Context) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            val pending = PendingIntent.getBroadcast(
                context,
                REQUEST,
                Intent(context, WatchdogReceiver::class.java).setAction(ACTION_WATCHDOG),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            runCatching {
                alarms.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME,
                    SystemClock.elapsedRealtime() + INTERVAL_MS,
                    pending,
                )
            }
        }
    }
}
