package net.tailchat.android.cloud

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import net.tailchat.android.ChatService
import net.tailchat.android.data.ErrorKind
import net.tailchat.android.data.OperationKind
import net.tailchat.android.data.PendingOperationEntity
import net.tailchat.android.data.Payloads
import net.tailchat.android.data.TailchatDatabase
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/**
 * `doWork` never touches a socket or `SyncEngine` — see the class doc for why
 * — but it does have to watch the pending-op queue it exists to resume: a
 * successful `startForegroundService`/`startService` call proves nothing by
 * itself, since a background-start restriction or a service that starts and
 * then fails to connect look identical from here unless the queue is
 * actually watched.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CloudOutboxWorkerTest {

    private val session = CloudSession("https://example.com", "token", CloudUser("alice", "Alice"))
    private val account = accountKeyOf(session)

    @Before
    fun setUp() {
        TailchatDatabase.resetForTest()
    }

    @After
    fun tearDown() {
        TailchatDatabase.resetForTest()
    }

    @Test
    fun `doWork starts ChatService and reports success when there is no account to watch`() = runTest {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val worker = TestListenableWorkerBuilder<CloudOutboxWorker>(context).build()

        val result = worker.doWork()

        assertEquals(ListenableWorker.Result.success(), result)
        val started = Shadows.shadowOf(context).nextStartedService
        assertEquals(ChatService::class.java.name, started?.component?.className)
    }

    @Test
    fun `doWork reports success immediately when the account has nothing queued`() = runTest {
        val context = ApplicationProvider.getApplicationContext<Application>()
        CloudSessionStore(context).save(session)
        val worker = TestListenableWorkerBuilder<CloudOutboxWorker>(context).build()

        val result = worker.doWork()

        assertEquals(ListenableWorker.Result.success(), result)
        val started = Shadows.shadowOf(context).nextStartedService
        assertEquals(ChatService::class.java.name, started?.component?.className)
    }

    @Test
    fun `doWork retries when the service starts but the queue never moves`() = runTest {
        val context = ApplicationProvider.getApplicationContext<Application>()
        CloudSessionStore(context).save(session)
        TailchatDatabase.get(context).pendingOps().insert(operation("msg-stuck"))
        val worker = TestListenableWorkerBuilder<CloudOutboxWorker>(context).build()

        val result = worker.doWork()

        assertEquals(
            "a started service that never actually sends anything must not be reported as done",
            ListenableWorker.Result.retry(),
            result,
        )
    }

    @Test
    fun `doWork succeeds once the queue actually moves`() = runTest {
        val context = ApplicationProvider.getApplicationContext<Application>()
        CloudSessionStore(context).save(session)
        val db = TailchatDatabase.get(context)
        db.pendingOps().insert(operation("msg-1"))
        // Simulates ChatService's own live pump sending and removing the row
        // partway through this worker's bounded wait.
        backgroundScope.launch {
            delay(2_500)
            db.pendingOps().delete("send:msg-1")
        }
        val worker = TestListenableWorkerBuilder<CloudOutboxWorker>(context).build()

        val result = worker.doWork()

        assertEquals(ListenableWorker.Result.success(), result)
    }

    private fun operation(messageId: String) = PendingOperationEntity(
        opId = "send:$messageId",
        accountKey = account,
        peer = "bob",
        kind = OperationKind.MESSAGE,
        messageId = messageId,
        payloadJson = Payloads.messagePayload(
            text = "hi",
            ts = 100L,
            author = "alice",
            imageDataUrl = null,
            imageWidth = null,
            imageHeight = null,
            voiceDataUrl = null,
            voiceDurationSec = null,
            replyId = null,
            replyFrom = null,
            replyText = null,
            replyMedia = null,
            forwardLogin = null,
            forwardName = null,
        ),
        attempts = 0,
        nextAttemptAt = 0L,
        lastError = null,
        errorKind = ErrorKind.None.ordinal,
        leaseOwner = null,
        leaseUntil = 0L,
        createdAt = 0L,
    )
}
