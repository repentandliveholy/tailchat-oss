package net.tailchat.android.call

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat

/**
 * Holds the `microphone` foreground service a live call needs — the plan's
 * §4.2 component, restored after the deviation it flagged for exactly this
 * check turned out to matter.
 *
 * Android silences the microphone of a process that is neither visible nor
 * holding a foreground service of type `microphone`. `ChatService` is a
 * foreground service, but its single `startForeground` is typed `specialUse`
 * (the chat channel), so the moment a call's screen went dark — a phone
 * against an ear does that by itself, through the proximity lock — the
 * capture kept running and delivered zeroes. Nothing anywhere said so: ICE
 * stayed connected, the notification stayed up, and both sides simply heard
 * nothing.
 *
 * This service exists only for the duration of one call. It owns the ongoing
 * `CallStyle` notification too, which is what makes that notification legal
 * on API 34 (see [CallNotifications.showOngoing]); the hangup action still
 * goes to `ChatService`, which owns the one [CallController].
 */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(EXTRA_CALL_ID).orEmpty()
        val peer = intent?.getStringExtra(EXTRA_CALL_PEER).orEmpty()
        val peerName = intent?.getStringExtra(EXTRA_PEER_NAME).orEmpty().ifEmpty { peer }
        val stopping = intent?.action == ACTION_STOP
        // A `CallStyle` notification describes a call; the teardown start has
        // no call to describe (and its extras are empty), so it promotes with
        // the plain placeholder instead — visible for the milliseconds until
        // `stopForeground` removes it again.
        val notification = if (stopping) {
            CallNotifications(this).teardownNotification()
        } else {
            CallNotifications(this).ongoingNotification(callId, peer, peerName)
        }
        // Promote first, always — even when this very intent is the one asking
        // the service to go away. A `startForegroundService` that is never
        // answered by a `startForeground` kills the process outright
        // (`ForegroundServiceDidNotStartInTimeException`), and the call that
        // ends milliseconds after it was answered — a failed SDP, the caller
        // hanging up first — is exactly that: the pending start had not been
        // delivered yet when `stopService` brought the record down, and the
        // platform took the process with it.
        try {
            ServiceCompat.startForeground(
                this,
                CALL_NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                } else {
                    0
                },
            )
        } catch (error: Exception) {
            // Refused: a background start on API 31+, or a `microphone` type
            // without RECORD_AUDIO on API 34+. Both are survivable — post the
            // same notification by hand and stop, which is precisely the
            // behaviour before this service existed, rather than taking the
            // process down mid-call.
            Log.w(TAG, "foreground call service refused; falling back to a plain notification", error)
            if (!stopping) {
                // The ongoing notification is a `CallStyle`, and API 34 only
                // accepts one from a foreground service or with a
                // full-screen intent — this path has neither, by definition.
                // Losing the shade row is survivable; throwing here would
                // take the process down mid-call.
                runCatching { NotificationManagerCompat.from(this).notify(CALL_NOTIFICATION_ID, notification) }
                    .onFailure { Log.w(TAG, "plain call notification refused too", it) }
            }
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (stopping) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val TAG = "CallService"
        private const val EXTRA_PEER_NAME = "peerName"
        private const val ACTION_STOP = "net.tailchat.android.call.CALL_SERVICE_STOP"

        fun start(context: Context, callId: String, peer: String, peerName: String) {
            val intent = Intent(context, CallService::class.java).apply {
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_CALL_PEER, peer)
                putExtra(EXTRA_PEER_NAME, peerName)
            }
            // Guarded for the same reason the start itself is: a call answered
            // while nothing of this app is on screen may not be allowed to
            // start a foreground service at all.
            runCatching { context.startForegroundService(intent) }
                .onFailure { error ->
                    Log.w(TAG, "call service could not be started", error)
                    runCatching {
                        val notification = CallNotifications(context).ongoingNotification(callId, peer, peerName)
                        NotificationManagerCompat.from(context).notify(CALL_NOTIFICATION_ID, notification)
                    }.onFailure { Log.w(TAG, "plain call notification refused too", it) }
                }
        }

        /**
         * Ends the call's foreground service. Delivered *through* the service
         * rather than as `stopService`, so a start that has not reached
         * [onStartCommand] yet is answered by a `startForeground` before the
         * service goes down. `stopService` is the fallback for the one case
         * that cannot create a new obligation: a start the platform refuses.
         */
        fun stop(context: Context) {
            val intent = Intent(context, CallService::class.java).setAction(ACTION_STOP)
            runCatching { context.startForegroundService(intent) }
                .onFailure {
                    runCatching { context.stopService(Intent(context, CallService::class.java)) }
                }
        }
    }
}
