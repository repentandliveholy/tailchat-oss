package net.tailchat.android.cloud

import android.content.Intent
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import net.tailchat.android.ChatService
import net.tailchat.android.Settings

/**
 * Receives data-only FCM routing identity and hands it to durable WorkManager
 * work. It never receives or renders conversation content; ChatService's sole
 * account-scoped SyncEngine fetches the named message and uses the normal
 * notification builder.
 *
 * Android does not deliver callbacks after the user explicitly force-stops the
 * package. Background, Doze, swipe-away and ordinary process death are the
 * supported cases.
 */
class TailchatFirebaseMessagingService : FirebaseMessagingService() {

    /** A rotated/reissued token can arrive at any time, including before the
     *  first login (fresh install) — [Settings.fcmToken] is what lets a later
     *  `connect()`/login pick it up if there is no session to register it
     *  against yet. */
    override fun onNewToken(token: String) {
        Settings(this).fcmToken = token
        FcmTokenRegistrationWorker.enqueue(this)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val peer = message.data["peer"]?.takeIf(::validIdentity) ?: return
        val login = message.data["login"]?.takeIf(::validIdentity) ?: return
        val accountScope = message.data["scope"]?.takeIf { SCOPE.matches(it) } ?: return
        val session = CloudSessionStore(this).load() ?: return
        if (session.user.login != login || accountScopeOf(session) != accountScope) return

        // A call push carries no `messageId` — there is no message to fetch,
        // the point is to get this process' socket back up before the caller's
        // 45-second ring runs out. It used to be dropped by the `messageId`
        // check below, which is why a phone whose socket had gone (Doze, the
        // app not in the foreground, the process already reclaimed) never rang
        // at all: the offer was never delivered and the one wake-up signal for
        // it was discarded on arrival.
        if (message.data["kind"] == "call") {
            val callId = message.data["callId"]?.takeIf(::validIdentity).orEmpty()
            runCatching {
                ContextCompat.startForegroundService(
                    this,
                    Intent(this, ChatService::class.java)
                        .setAction(ChatService.ACTION_CALL_WAKE)
                        .putExtra(ChatService.EXTRA_PEER, peer)
                        .putExtra(ChatService.EXTRA_CALL_ID, callId)
                        .putExtra(ChatService.EXTRA_ACCOUNT_SCOPE, accountScope),
                )
            }
            return
        }

        // Reply reminders are replayed by the authenticated socket and retired
        // only after the controller has rendered them. Do not fetch the old
        // message through the ordinary push path: that would present a read
        // message as new and alter its unread state.
        if (message.data["kind"] == "reply-reminder") {
            runCatching {
                ContextCompat.startForegroundService(
                    this,
                    Intent(this, ChatService::class.java).setAction(ChatService.ACTION_WAKE),
                )
            }
            return
        }

        val messageId = message.data["messageId"]?.takeIf(::validIdentity) ?: return

        // WorkManager owns retry and survives process death. The direct start
        // consumes FCM's short high-priority execution allowance; failure is
        // not success because the same unique work remains queued.
        runCatching { PushNotificationWorker.enqueue(this, peer, messageId, accountScope) }
        runCatching {
            ContextCompat.startForegroundService(
                this,
                Intent(this, ChatService::class.java)
                    .setAction(ChatService.ACTION_WAKE)
                    .putExtra(ChatService.EXTRA_PEER, peer)
                    .putExtra(ChatService.EXTRA_MESSAGE_ID, messageId)
                    .putExtra(ChatService.EXTRA_ACCOUNT_SCOPE, accountScope),
            )
        }
    }

    private fun validIdentity(value: String): Boolean =
        value.isNotBlank() && value.length <= MAX_IDENTITY_LENGTH && value.none(Char::isISOControl)

    private companion object {
        const val MAX_IDENTITY_LENGTH = 160
        val SCOPE = Regex("^[a-f0-9]{64}$")
    }
}
