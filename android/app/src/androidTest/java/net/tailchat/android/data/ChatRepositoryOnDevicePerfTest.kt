package net.tailchat.android.data

import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real on-device number LOCAL_FIRST_EXECUTION_PLAN.md §10 asks for —
 * [ChatRepositoryEnqueuePerfTest] already measures the same Room transaction
 * on a file-backed JVM/Robolectric database, and says plainly in its own KDoc
 * that a host SSD is faster than phone storage and is a floor, not the
 * on-device figure. This runs the identical two operations against the real
 * `net.tailchat.android` app database, on the emulator's own storage, through
 * `am instrument` — the thing three prior HANDOFF entries listed as "not
 * measured" for lack of an `androidTest` source set.
 *
 * Targets (§10): local warm-open p95 ≤200ms, local text-send commit p95
 * ≤100ms, against a conversation holding at least 1,000 messages. The
 * assertions here are a generous regression net (a real hang or an
 * accidentally-quadratic query), not a strict gate on the target itself —
 * emulator storage and host load are not the "fixed reference device" the
 * plan asks the actual target be judged against. The measured p50/p95/p99
 * are logged (`Log.i("PerfTest", …)`) and belong in the HANDOFF entry that
 * cites this run, not silently discarded.
 */
@RunWith(AndroidJUnit4::class)
class ChatRepositoryOnDevicePerfTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val accountKey = "https://on-device-perf.invalid|perf"
    private val peer = "perf-peer"
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository

    @Before
    fun setUp() {
        // A fresh file each run: reusing net.tailchat.android's own live
        // database file would race whatever session/process is already using
        // it on a device this test happens to share.
        context.deleteDatabase(DB_NAME)
        db = androidx.room.Room.databaseBuilder(context, TailchatDatabase::class.java, DB_NAME).build()
        repo = ChatRepository(db, MediaCache(MediaCache.rootDir(context.cacheDir), DeviceDataKey.get(context)))
        runBlocking {
            repo.upsertAccount(AccountEntity(accountKey, "https://on-device-perf.invalid", "perf", "Perf"))
            repeat(SEED_MESSAGES) { i ->
                val id = "seed-$i"
                repo.enqueueMessage(
                    seedMessage(i, id),
                    seedOp(i, id),
                )
            }
        }
    }

    @After
    fun tearDown() {
        db.close()
        context.deleteDatabase(DB_NAME)
    }

    @Test
    fun warmOpenAndLocalSendLatencyAgainstA1000MessageConversation() = runBlocking {
        // Warm open: the exact query CloudController.selectPeer's transcript
        // Flow runs, HISTORY_WINDOW-sized, against a conversation the DB
        // already holds — nothing here waits on network by design.
        val openSamples = LongArray(SAMPLES) {
            val start = System.nanoTime()
            val page = repo.messages(accountKey, peer, HISTORY_WINDOW).first()
            val elapsed = (System.nanoTime() - start) / 1_000_000
            assertTrue("expected a full page back", page.size == HISTORY_WINDOW)
            elapsed
        }
        openSamples.sort()
        Log.i(
            TAG,
            "warm-open ms: p50=${percentile(openSamples, 50)} p95=${percentile(openSamples, 95)} " +
                "p99=${percentile(openSamples, 99)} max=${openSamples.last()}",
        )
        assertTrue(
            "warm-open p95 was ${percentile(openSamples, 95)}ms — investigate before trusting this device's number",
            percentile(openSamples, 95) < 2_000,
        )

        // Local send commit: message row + pending-op row + conversation
        // preview upsert, one `db.withTransaction`, on the same seeded
        // conversation so the table is not empty when measured.
        val sendSamples = LongArray(SAMPLES) { i ->
            val id = "send-$i-${UUID.randomUUID()}"
            val start = System.nanoTime()
            repo.enqueueMessage(seedMessage(SEED_MESSAGES + i, id), seedOp(SEED_MESSAGES + i, id))
            (System.nanoTime() - start) / 1_000_000
        }
        sendSamples.sort()
        Log.i(
            TAG,
            "local-send ms: p50=${percentile(sendSamples, 50)} p95=${percentile(sendSamples, 95)} " +
                "p99=${percentile(sendSamples, 99)} max=${sendSamples.last()}",
        )
        assertTrue(
            "local-send p95 was ${percentile(sendSamples, 95)}ms — investigate before trusting this device's number",
            percentile(sendSamples, 95) < 2_000,
        )
    }

    private fun percentile(sorted: LongArray, p: Int): Long {
        val index = ((sorted.size - 1) * (p / 100.0)).toInt().coerceIn(0, sorted.size - 1)
        return sorted[index]
    }

    private fun seedMessage(i: Int, id: String) = MessageEntity(
        accountKey = accountKey, peer = peer, id = id, text = "seed message $i", ts = i.toLong(),
        author = "perf", mine = i % 2 == 0, delivery = DeliveryState.Delivered.ordinal, system = false,
        kind = MessageKind.TEXT, imageDataUrl = null, imageWidth = null, imageHeight = null,
        voiceDataUrl = null, voiceDurationSec = null, reactionsJson = null, replyJson = null,
        forwardJson = null, editedAt = null, deletedAt = null, serverSeq = null,
    )

    private fun seedOp(i: Int, id: String) = PendingOperationEntity(
        opId = "send:$id", accountKey = accountKey, peer = peer, kind = OperationKind.MESSAGE,
        messageId = id,
        payloadJson = Payloads.messagePayload(
            text = "seed message $i", ts = i.toLong(), author = "perf", imageDataUrl = null, imageWidth = null,
            imageHeight = null, voiceDataUrl = null, voiceDurationSec = null, replyId = null, replyFrom = null,
            replyText = null, replyMedia = null, forwardLogin = null, forwardName = null,
        ),
        attempts = 0, nextAttemptAt = i.toLong(), lastError = null, errorKind = ErrorKind.None.ordinal,
        leaseOwner = null, leaseUntil = 0, createdAt = i.toLong(),
    )

    private companion object {
        const val TAG = "PerfTest"
        const val DB_NAME = "tailchat-perf-test.db"
        const val SEED_MESSAGES = 1_000
        const val HISTORY_WINDOW = 120
        const val SAMPLES = 50
    }
}
