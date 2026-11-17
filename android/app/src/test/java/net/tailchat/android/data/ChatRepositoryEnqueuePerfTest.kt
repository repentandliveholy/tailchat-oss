package net.tailchat.android.data

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import kotlin.math.roundToInt
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Measures what `ServiceCloudController.enqueue`'s `runBlocking { repository
 * .enqueueMessage(...) }` actually costs (LOCAL_FIRST_HANDOFF.md §3.3: "он
 * не измерен... если он выходит за 100 мс, переносить... не молча делать
 * отправку асинхронной").
 *
 * This is a JVM/Robolectric proxy, not the on-device number the plan's own
 * §10 asks for (p95 ≤ 100ms on a fixed reference device with a 1,000-message
 * conversation): this environment has no attached physical device and no
 * `androidTest` source set to run an instrumented benchmark on the one
 * running emulator. What this test *can* say honestly: the Room transaction
 * itself — insert message row + insert pending-op row + upsert conversation
 * preview, one `db.withTransaction` — against a real file-backed SQLite
 * database (not `inMemoryDatabaseBuilder`, which skips the disk entirely) on
 * ordinary developer-machine storage. A host SSD is faster than most phones'
 * storage, so this result is a floor, not the on-device figure; treat it as
 * a regression guard against something making the transaction itself heavier
 * (an added query, a missing index), not as proof the 100ms UI budget holds
 * on a device.
 *
 * Seeded with 1,000 prior messages per the plan's fixed conversation size,
 * since `enqueueMessage`'s cost is dominated by the two inserts and the
 * indexed preview upsert, not by table size — but an unindexed regression
 * would only show up with real rows present.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatRepositoryEnqueuePerfTest {
    private lateinit var dbFile: File
    private lateinit var mediaDir: File
    private lateinit var db: TailchatDatabase
    private lateinit var repo: ChatRepository
    private val accountKey = "https://repentandliveholy.org|perf"
    private val peer = "peer"

    @Before
    fun setUp() {
        dbFile = File.createTempFile("tailchat-perf", ".db")
        mediaDir = File.createTempFile("tailchat-perf-media", "").apply { delete(); mkdirs() }
        db = Room.databaseBuilder(ApplicationProvider.getApplicationContext(), TailchatDatabase::class.java, dbFile.absolutePath)
            .allowMainThreadQueries()
            .build()
        repo = ChatRepository(db, MediaCache(mediaDir))
    }

    @After
    fun tearDown() {
        db.close()
        dbFile.delete()
    }

    @Test
    fun `enqueueMessage commit latency against a 1000-message conversation`() = runTest {
        repeat(1_000) { i ->
            val id = "m-$i-${UUID.randomUUID()}"
            repo.enqueueMessage(seedMessage(i, id), seedOp(i, id))
        }

        val samples = LongArray(SAMPLES)
        for (i in 0 until SAMPLES) {
            val n = 1_000 + i
            val id = "m-$n-${UUID.randomUUID()}"
            val message = seedMessage(n, id)
            val op = seedOp(n, id)
            val start = System.nanoTime()
            repo.enqueueMessage(message, op)
            samples[i] = (System.nanoTime() - start) / 1_000_000
        }
        samples.sort()

        val p50 = samples[(SAMPLES * 0.50).roundToInt().coerceAtMost(SAMPLES - 1)]
        val p95 = samples[(SAMPLES * 0.95).roundToInt().coerceAtMost(SAMPLES - 1)]
        val p99 = samples[(SAMPLES * 0.99).roundToInt().coerceAtMost(SAMPLES - 1)]
        val max = samples.last()
        println(
            "ChatRepository.enqueueMessage commit latency (ms), file-backed SQLite, " +
                "host JVM, ${SAMPLES} samples after 1000 seeded messages: " +
                "p50=$p50 p95=$p95 p99=$p99 max=$max",
        )

        // A generous sanity bound, not the plan's 100ms UI target: this guards
        // against the transaction itself regressing by an order of magnitude
        // (a missing index, an accidental full-table scan), not against the
        // on-device budget, which this host cannot measure.
        assertTrue("p95 commit time regressed badly: ${p95}ms", p95 < 500)
    }

    private fun seedMessage(i: Int, id: String) = MessageEntity(
        accountKey = accountKey,
        peer = peer,
        id = id,
        text = "message number $i",
        ts = 1_700_000_000_000L + i,
        author = "perf",
        mine = true,
        delivery = DeliveryState.Queued.ordinal,
        system = false,
        kind = MessageKind.TEXT,
        imageDataUrl = null,
        imageWidth = null,
        imageHeight = null,
        voiceDataUrl = null,
        voiceDurationSec = null,
        reactionsJson = null,
        replyJson = null,
        forwardJson = null,
        editedAt = null,
        deletedAt = null,
        serverSeq = null,
    )

    private fun seedOp(i: Int, id: String) = PendingOperationEntity(
        opId = "msg:$id",
        accountKey = accountKey,
        peer = peer,
        kind = "message",
        messageId = id,
        payloadJson = "{}",
        attempts = 0,
        nextAttemptAt = 1_700_000_000_000L + i,
        lastError = null,
        errorKind = ErrorKind.None.ordinal,
        leaseOwner = null,
        leaseUntil = 0,
        createdAt = 1_700_000_000_000L + i,
    )

    private companion object {
        const val SAMPLES = 200
    }
}
