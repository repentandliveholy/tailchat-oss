package net.tailchat.android.cloud

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.delay
import net.tailchat.android.ChatService
import net.tailchat.android.Settings
import net.tailchat.android.data.NotificationDeliveryStatus
import net.tailchat.android.data.TailchatDatabase
import okhttp3.OkHttpClient
/** Durable owner of an FCM wake intention. ChatService remains the sole owner
 * of SyncEngine and all message network work. */
class PushNotificationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val peer = inputData.getString(KEY_PEER) ?: return Result.failure()
        val messageId = inputData.getString(KEY_MESSAGE_ID) ?: return Result.failure()
        val scope = inputData.getString(KEY_SCOPE) ?: return Result.failure()
        if (net.tailchat.android.data.DeviceMigration.needed(applicationContext) ||
            runCatching { net.tailchat.android.data.DeviceDataKey.get(applicationContext) }.isFailure)
            return Result.retry()
        val session = CloudSessionStore(applicationContext).load() ?: return Result.success()
        if (accountScopeOf(session) != scope) return Result.success()

        val intent = Intent(applicationContext, ChatService::class.java)
            .setAction(ChatService.ACTION_WAKE)
            .putExtra(ChatService.EXTRA_PEER, peer)
            .putExtra(ChatService.EXTRA_MESSAGE_ID, messageId)
            .putExtra(ChatService.EXTRA_ACCOUNT_SCOPE, scope)
        try {
            ContextCompat.startForegroundService(applicationContext, intent)
        } catch (_: Exception) {
            return Result.retry()
        }

        val accountKey = accountKeyOf(session)
        val dao = TailchatDatabase.get(applicationContext).notificationDeliveries()
        repeat(RESULT_POLLS) {
            when (dao.status(accountKey, peer, messageId)) {
                NotificationDeliveryStatus.POSTED,
                NotificationDeliveryStatus.SUPPRESSED,
                -> return Result.success()
            }
            delay(RESULT_POLL_MS)
        }
        return Result.retry()
    }

    companion object {
        private const val KEY_PEER = "peer"
        private const val KEY_MESSAGE_ID = "messageId"
        private const val KEY_SCOPE = "scope"
        private const val RESULT_POLL_MS = 1_000L
        private const val RESULT_POLLS = 30

        fun enqueue(context: Context, peer: String, messageId: String, scope: String) {
            val request = OneTimeWorkRequestBuilder<PushNotificationWorker>()
                .setInputData(workDataOf(KEY_PEER to peer, KEY_MESSAGE_ID to messageId, KEY_SCOPE to scope))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                "tailchat-push-$scope-$peer-$messageId",
                ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}

/** Retries token rotation registration when FCM's callback-time POST fails. */
class FcmTokenRegistrationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val session = CloudSessionStore(applicationContext).load() ?: return Result.success()
        val token = Settings(applicationContext).fcmToken ?: return Result.success()
        return try {
            CloudApi(OkHttpClient()).registerFcmToken(session, token)
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }
    companion object {
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<FcmTokenRegistrationWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                "tailchat-fcm-token-registration",
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }
    }
}
