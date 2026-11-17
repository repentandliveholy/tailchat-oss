package net.tailchat.android.cloud

import android.content.Context
import android.content.Intent
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import net.tailchat.android.ChatService
import net.tailchat.android.Settings
import net.tailchat.android.data.TailchatDatabase

/**
 * Resumes the pending-operation queue when nothing else would.
 *
 * `ChatService` is the sole owner of [SyncEngine] and therefore of the socket
 * (LOCAL_FIRST_HANDOFF.md §4: "один владелец сокета... второй отправитель
 * запрещён, включая worker"), so this worker never constructs an engine or a
 * connection of its own. Its entire job is to make sure `ChatService` is
 * running: starting it re-enters the same path `ChatService.onStartCommand`
 * already takes on a foreground return — `cloud.connect()` when not already
 * online — which is what actually reconnects and pumps the queue. A worker
 * that opened a second socket here would be exactly the second sender the
 * architecture forbids.
 *
 * Scheduled as unique work with a network constraint: a device coming back
 * online after Doze, a force-stop that killed the process, or a reboot all
 * end here instead of leaving a queued message stuck until the user happens
 * to reopen the app. [schedule] is safe to call on every enqueue — a run
 * already waiting for the constraint is left alone ([ExistingWorkPolicy.KEEP]),
 * and one that already finished is replaced by a fresh wait.
 *
 * `startForegroundService`/`startService` succeeding only means the intent
 * was accepted, not that anything was actually sent — a background-start
 * restriction on some OEM build, a service that starts and then fails to
 * reach `connect()`, or a promotion Android silently refused all look
 * identical from here unless something is actually watched. When this
 * worker has an account to watch, it waits, bounded, for the queue depth to
 * actually drop before declaring success; otherwise WorkManager's own
 * backoff never gets a reason to try again.
 */
class CloudOutboxWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (net.tailchat.android.data.DeviceMigration.needed(applicationContext) ||
            runCatching { net.tailchat.android.data.DeviceDataKey.get(applicationContext) }.isFailure)
            return Result.retry()
        val accountKey = CloudSessionStore(applicationContext).load()?.let(::accountKeyOf)
        val pendingOps = accountKey?.let { TailchatDatabase.get(applicationContext).pendingOps() }
        val before = if (accountKey != null && pendingOps != null) pendingOps.countAll(accountKey).first() else 0

        val intent = Intent(applicationContext, ChatService::class.java)
        try {
            if (Settings(applicationContext).backgroundService) {
                applicationContext.startForegroundService(intent)
            } else {
                applicationContext.startService(intent)
            }
        } catch (_: Exception) {
            // A transient failure to start — a background-start restriction on
            // some OEM build, for instance — is WorkManager's own backoff to
            // retry, not a reason to give up on the queue.
            return Result.retry()
        }

        // No session, or nothing was queued for it by the time this ran (the
        // live service's own pump already won the race): starting the
        // service is everything this worker exists to guarantee, and there
        // is no queue depth left to watch.
        if (accountKey == null || pendingOps == null || before == 0) return Result.success()

        repeat(RESULT_POLLS) {
            delay(RESULT_POLL_MS)
            if (pendingOps.countAll(accountKey).first() < before) return Result.success()
        }
        // The service started but the queue never moved. WorkManager's own
        // backoff retries this from scratch rather than this worker looping
        // forever on its own clock.
        return Result.retry()
    }

    companion object {
        private const val UNIQUE_WORK_NAME = "tailchat-outbox"
        private const val RESULT_POLL_MS = 1_000L
        private const val RESULT_POLLS = 30

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = OneTimeWorkRequestBuilder<CloudOutboxWorker>()
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}
