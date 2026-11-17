package net.tailchat.android.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import net.tailchat.android.R

/** Actions [CallActivity]/a future `CallService` broadcast receiver reads off
 *  the intent that fired a notification action button. */
const val ACTION_CALL_ANSWER = "net.tailchat.android.call.ACTION_ANSWER"
const val ACTION_CALL_DECLINE = "net.tailchat.android.call.ACTION_DECLINE"
const val ACTION_CALL_HANGUP = "net.tailchat.android.call.ACTION_HANGUP"
const val EXTRA_CALL_ID = "callId"
const val EXTRA_CALL_PEER = "peer"

// Bumped from `calls_v1` when the ringtone moved into the app: a channel's
// sound cannot be changed after creation, and `calls_v1` was created with
// the system default. `calls_v2` gave one short blip of vibration and then
// cancelled it; see `ensureChannel`. The older channels are deleted there.
private const val CALL_CHANNEL_ID = "calls_v3"
private val LEGACY_CALL_CHANNEL_IDS = listOf("calls_v2", "calls_v1")
/** A call in progress: a shade row, never a banner — see `ensureChannel`. */
private const val ONGOING_CHANNEL_ID = "calls_ongoing_v1"
internal const val CALL_NOTIFICATION_ID = 9100

/** What [CallController] needs to post — extracted for the same reason as
 *  [net.tailchat.android.call.CallAudioController]. */
interface CallNotifier {
    fun showIncoming(callId: String, peer: String, peerName: String)
    fun showOngoing(callId: String, peer: String, peerName: String)
    fun clear()
}

/**
 * `CallStyle` notifications (§4.3) — the only UI an incoming call has before
 * the user acts on it, since [CallActivity]'s full-screen intent is not
 * guaranteed to actually take over the screen (`canUseFullScreenIntent()`
 * can be `false` on API 34+, §4.2).
 */
class CallNotifications(private val context: Context) : CallNotifier {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        for (legacy in LEGACY_CALL_CHANNEL_IDS) runCatching { nm.deleteNotificationChannel(legacy) }
        if (nm.getNotificationChannel(CALL_CHANNEL_ID) == null) {
            // Deliberately silent *and* vibration-free: the whole ring — the
            // looping melody and the repeating waveform — is [CallRinger]'s,
            // and a channel contributes a one-shot that does not merely
            // overlap it. On the vibrator it *supersedes* the app's waveform:
            // measured on the RMX3624 (Android 13) while an incoming call rang
            // in the background, the platform's own InputReader started the
            // app's `[0,1000,1100]` repeat at t=0 and cancelled the device
            // 192ms later when this channel's default `[0,350,250,350]`
            // arrived, then stopped the motor when *that* finished — the
            // remaining forty-odd seconds silent, the owner's «одна вибрация и
            // все». Hence `calls_v3`: vibration is not a field an app can
            // change on a channel that already exists.
            val channel = NotificationChannel(CALL_CHANNEL_ID, context.getString(R.string.call_notification_channel), NotificationManager.IMPORTANCE_HIGH).apply {
                enableVibration(false)
                setSound(null, null)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            nm.createNotificationChannel(channel)
        }
        if (nm.getNotificationChannel(ONGOING_CHANNEL_ID) == null) {
            // A call *in progress* needs a row in the shade (the foreground
            // service demands one) and nothing else. On the high-importance
            // channel it also arrived as a heads-up banner — which, with the
            // call screen already up, is the banner the owner saw pasted over
            // his own call. IMPORTANCE_LOW is a row, never a banner.
            val ongoing = NotificationChannel(
                ONGOING_CHANNEL_ID,
                context.getString(R.string.call_ongoing_channel),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                enableVibration(false)
                setSound(null, null)
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            nm.createNotificationChannel(ongoing)
        }
    }

    override fun showIncoming(callId: String, peer: String, peerName: String) {
        ensureChannel()
        val person = Person.Builder().setName(peerName).build()
        val fullScreenIntent = PendingIntent.getActivity(
            context, 0, CallActivity.incomingIntent(context, callId, peer),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val answer = actionIntent(ACTION_CALL_ANSWER, callId, peer, requestCode = 1)
        val decline = actionIntent(ACTION_CALL_DECLINE, callId, peer, requestCode = 2)
        val notification = NotificationCompat.Builder(context, CALL_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tailchat)
            .setContentIntent(fullScreenIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
            .addPerson(person)
            .build()
        manager.notify(CALL_NOTIFICATION_ID, notification)
    }

    /**
     * The ongoing-call notification is posted by [CallService], not from here.
     *
     * Two platform rules make that the only correct owner. Android silences
     * the microphone of a process that is neither visible nor holding a
     * `microphone` foreground service — a call whose screen went dark against
     * an ear is exactly that process, and the silencing is invisible from
     * inside: `AudioRecord` keeps reading, the frames are just zeroes. And a
     * `CallStyle` notification is refused outright by API 34 unless it is a
     * foreground service's own notification (or carries a full-screen intent).
     * One service satisfies both.
     */
    override fun showOngoing(callId: String, peer: String, peerName: String) {
        ensureChannel()
        CallService.start(context, callId, peer, peerName)
    }

    /** The notification [CallService] posts with `startForeground`, and the
     *  fallback it posts by hand when the platform refuses that start. */
    fun ongoingNotification(callId: String, peer: String, peerName: String): Notification {
        ensureChannel()
        val person = Person.Builder().setName(peerName).build()
        val openCall = PendingIntent.getActivity(
            context, 0, CallActivity.activeIntent(context, callId, peer),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hangup = actionIntent(ACTION_CALL_HANGUP, callId, peer, requestCode = 3)
        return NotificationCompat.Builder(context, ONGOING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tailchat)
            .setContentIntent(openCall)
            // Kept: API 34 refuses a CallStyle notification that is neither a
            // foreground service's own nor carries one, and the fallback path
            // in `CallService` posts this by hand. On the low-importance
            // channel it no longer produces a heads-up banner over the call
            // screen — that combination is what the owner saw.
            .setFullScreenIntent(openCall, true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setSilent(true)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangup))
            .build()
    }

    /**
     * What [CallService] promotes with when the start it is answering is the
     * one asking it to stop. It exists purely to discharge a pending
     * `startForegroundService` obligation — an unanswered one kills the
     * process — and is removed in the same call, so it says nothing about a
     * call and carries no actions.
     */
    fun teardownNotification(): Notification {
        ensureChannel()
        return NotificationCompat.Builder(context, ONGOING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tailchat)
            .setContentTitle(context.getString(R.string.call_ended_hangup))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
    }

    override fun clear() {
        CallService.stop(context)
        manager.cancel(CALL_NOTIFICATION_ID)
    }

    // Routed straight to ChatService (already handles ACTION_REPLY/ACTION_WAKE
    // the same way) rather than through a separate BroadcastReceiver: the
    // service already owns the one CallController instance, so this avoids a
    // second component that would have to rediscover it via bindService.
    private fun actionIntent(action: String, callId: String, peer: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, net.tailchat.android.ChatService::class.java).apply {
            this.action = action
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(EXTRA_CALL_PEER, peer)
        }
        return PendingIntent.getForegroundService(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
