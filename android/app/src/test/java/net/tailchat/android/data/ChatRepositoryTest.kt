package net.tailchat.android.data

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatRepositoryTest {
    private lateinit var db: TailchatDatabase
    private lateinit var media: MediaCache
    private lateinit var repo: ChatRepository
    private var now = 1_000L

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            TailchatDatabase::class.java,
        ).allowMainThreadQueries().build()
        media = MediaCache(File.createTempFile("tailchat-test-media", "").apply { delete(); mkdirs() })
        repo = ChatRepository(db, media) { now }
    }

    @After
    fun tearDown() {
        db.close()
    }

    /** The ordinals are written into every row on every user's phone; the
     *  contract freezes them and this is what notices a reorder. */
    @Test
    fun deliveryOrdinalsAreFrozen() {
        assertEquals(
            listOf("Queued", "Sending", "Accepted", "Delivered", "Read", "Failed"),
            DeliveryState.entries.map(DeliveryState::name),
        )
        assertEquals(
            listOf("None", "Retryable", "Permanent", "Unsupported"),
            ErrorKind.entries.map(ErrorKind::name),
        )
        assertEquals(DeliveryState.Failed.ordinal, DELIVERY_FAILED)
        assertEquals(DeliveryState.Accepted.ordinal, DELIVERY_ACCEPTED)
        assertEquals(DeliveryState.Delivered.ordinal, DELIVERY_DELIVERED)
        assertEquals(DeliveryState.Read.ordinal, DELIVERY_READ)
        assertEquals(DeliveryState.Queued, DeliveryState.of(99))
    }

    @Test
    fun enqueueWritesMessageOperationAndPreviewTogether() = runTest {
        assertTrue(repo.enqueueMessage(message("bob", "m1", ts = 500L, text = "hello"), operation("m1", "bob")))

        assertEquals("hello", repo.message(ACCOUNT, "bob", "m1")?.text)
        assertNotNull(repo.operation("send:m1"))
        val conversation = repo.conversation(ACCOUNT, "bob")
        assertEquals("hello", conversation?.previewText)
        assertEquals(500L, conversation?.previewTs)
        assertEquals(1, repo.pendingCount(ACCOUNT).first())
    }

    @Test
    fun oldestPendingCreatedAtTracksTheEarliestQueuedOperationForDiagnostics() = runTest {
        assertNull(repo.oldestPendingCreatedAt(ACCOUNT).first())

        repo.enqueueMessage(message("bob", "m1", ts = 1_000L), operation("m1", "bob", createdAt = 1_000L))
        assertEquals(1_000L, repo.oldestPendingCreatedAt(ACCOUNT).first())

        repo.enqueueMessage(message("bob", "m2", ts = 2_000L), operation("m2", "bob", createdAt = 2_000L))
        assertEquals(1_000L, repo.oldestPendingCreatedAt(ACCOUNT).first())

        repo.completeOperation("send:m1", "m1", DeliveryState.Accepted, null)
        assertEquals(2_000L, repo.oldestPendingCreatedAt(ACCOUNT).first())

        repo.completeOperation("send:m2", "m2", DeliveryState.Accepted, null)
        assertNull(repo.oldestPendingCreatedAt(ACCOUNT).first())
    }

    @Test
    fun failedEnqueueLeavesNoPartialRow() = runTest {
        repo.enqueueMessage(message("bob", "m1", ts = 500L, text = "hello"), operation("m1", "bob"))

        // Same opId: the operation insert aborts after the message insert has
        // already run, which is exactly the partial state that must not survive.
        val clash = repo.enqueueMessage(
            message("bob", "m2", ts = 900L, text = "lost?"),
            operation("m1", "bob").copy(messageId = "m2"),
        )

        assertFalse(clash)
        assertNull(repo.message(ACCOUNT, "bob", "m2"))
        assertEquals(1, repo.pendingCount(ACCOUNT).first())
        assertEquals(500L, repo.conversation(ACCOUNT, "bob")?.previewTs)
    }

    @Test
    fun deliveryNeverRegresses() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))

        repo.markDelivery(ACCOUNT, "bob", "m1", DeliveryState.Read)
        repo.markDelivery(ACCOUNT, "bob", "m1", DeliveryState.Accepted)

        assertEquals(DeliveryState.Read, repo.message(ACCOUNT, "bob", "m1")?.deliveryState)
    }

    @Test
    fun failedMessageCanStillClimbOutOfFailure() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))
        repo.failOperation("send:m1", "no route", ErrorKind.Retryable.ordinal)
        assertEquals(DeliveryState.Failed, repo.message(ACCOUNT, "bob", "m1")?.deliveryState)

        repo.markDelivery(ACCOUNT, "bob", "m1", DeliveryState.Accepted)

        assertEquals(DeliveryState.Accepted, repo.message(ACCOUNT, "bob", "m1")?.deliveryState)
    }

    @Test
    fun concurrentClaimersNeverShareAnOperation() = runTest {
        repeat(24) { index ->
            repo.enqueueMessage(
                message("bob", "m$index", ts = index.toLong()),
                operation("m$index", "bob", createdAt = index.toLong()),
            )
        }

        val (first, second) = withContext(Dispatchers.IO) {
            listOf(
                async { repo.claimDue(ACCOUNT, "sender-a", now, 24) },
                async { repo.claimDue(ACCOUNT, "sender-b", now, 24) },
            ).awaitAll()
        }

        val a = first.map(PendingOperationEntity::opId).toSet()
        val b = second.map(PendingOperationEntity::opId).toSet()
        assertTrue("overlap: ${a intersect b}", (a intersect b).isEmpty())
        assertEquals(24, a.size + b.size)
        assertTrue(first.all { it.leaseOwner == "sender-a" })
        assertTrue(second.all { it.leaseOwner == "sender-b" })
    }

    @Test
    fun claimedOperationIsNotHandedOutAgainWhileLeased() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))

        assertEquals(1, repo.claimDue(ACCOUNT, "sender-a", now, 10).size)
        assertTrue(repo.claimDue(ACCOUNT, "sender-b", now, 10).isEmpty())
    }

    @Test
    fun releaseLeaseReschedulesBeyondTheNextClaim() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))
        repo.claimDue(ACCOUNT, "sender-a", now, 10)

        repo.releaseLease("send:m1", now + 5_000, "timeout", ErrorKind.Retryable.ordinal)

        assertTrue(repo.claimDue(ACCOUNT, "sender-a", now + 4_999, 10).isEmpty())
        val again = repo.claimDue(ACCOUNT, "sender-a", now + 5_000, 10)
        assertEquals(listOf("send:m1"), again.map(PendingOperationEntity::opId))
        assertEquals(1, again.single().attempts)
        assertEquals("timeout", again.single().lastError)
    }

    @Test
    fun completeOperationDropsOpAndAdvancesDeliveryWithoutRewritingTs() = runTest {
        repo.enqueueMessage(message("bob", "m1", ts = 100L), operation("m1", "bob"))

        repo.completeOperation("send:m1", "m1", DeliveryState.Accepted, serverSeq = 42L)

        assertNull(repo.operation("send:m1"))
        assertEquals(0, repo.pendingCount(ACCOUNT).first())
        val row = repo.message(ACCOUNT, "bob", "m1")
        assertEquals(DeliveryState.Accepted, row?.deliveryState)
        // A slow/queued acceptance must never let the server's later ts jump
        // this row past a peer message that already rendered above it while
        // this one was still pending — the "my message reordered below a
        // newer one" bug. `ts` stays exactly what the composer assigned.
        assertEquals(100L, row?.ts)
        assertEquals(42L, row?.serverSeq)
    }

    @Test
    fun failedOperationIsParkedButRetryable() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))
        repo.claimDue(ACCOUNT, "sender-a", now, 10)

        repo.failOperation("send:m1", "server said no", ErrorKind.Permanent.ordinal)

        assertTrue(repo.claimDue(ACCOUNT, "sender-a", now + 10_000_000, 10).isEmpty())
        val parked = repo.failedOperations(ACCOUNT).first().single()
        assertEquals("server said no", parked.lastError)
        assertEquals(ErrorKind.Permanent.ordinal, parked.errorKind)

        repo.releaseLease("send:m1", now, null, ErrorKind.None.ordinal)

        val retried = repo.claimDue(ACCOUNT, "sender-a", now, 10).single()
        assertEquals("send:m1", retried.opId)
        assertEquals("m1", retried.messageId)
        assertTrue(repo.failedOperations(ACCOUNT).first().isEmpty())
    }

    @Test
    fun clearDraftKeepsNewerTextAndClearsMatchingText() = runTest {
        repo.saveDraft(DraftEntity(ACCOUNT, "bob", "hello", null, null, now))

        repo.clearDraft(ACCOUNT, "bob", "hello")
        assertNull(repo.draft(ACCOUNT, "bob"))

        repo.saveDraft(DraftEntity(ACCOUNT, "bob", "hello there", null, null, now))
        repo.clearDraft(ACCOUNT, "bob", "hello")
        assertEquals("hello there", repo.draft(ACCOUNT, "bob")?.text)

        repo.clearDraft(ACCOUNT, "bob", null)
        assertNull(repo.draft(ACCOUNT, "bob"))
    }

    @Test
    fun cursorStaysPutWhenTheBodyThrows() = runTest {
        repo.advanceCursorWith(ACCOUNT, 7L) {}
        assertEquals(7L, repo.cursor(ACCOUNT))

        val failed = runCatching {
            repo.advanceCursorWith(ACCOUNT, 9L) {
                repo.upsertAccount(AccountEntity(ACCOUNT, SERVER, "me", "Me"))
                error("sync page rejected")
            }
        }

        assertTrue(failed.isFailure)
        assertEquals(7L, repo.cursor(ACCOUNT))
        assertNull(repo.account(ACCOUNT))
    }

    @Test
    fun forgetAccountKeepsTheUnsentQueueWhenAsked() = runTest {
        repo.upsertAccount(AccountEntity(ACCOUNT, SERVER, "me", "Me"))
        repo.enqueueMessage(message("bob", "queued"), operation("queued", "bob"))
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(message("bob", "old", ts = 5L, mine = false, delivery = DeliveryState.Delivered)),
            peerReadTs = 0L,
        )
        repo.saveDraft(DraftEntity(ACCOUNT, "bob", "typing", null, null, now))

        repo.forgetAccount(ACCOUNT, keepPending = true)

        assertNotNull(repo.operation("send:queued"))
        assertNotNull(repo.message(ACCOUNT, "bob", "queued"))
        assertNull(repo.message(ACCOUNT, "bob", "old"))
        assertNull(repo.conversation(ACCOUNT, "bob"))
        assertNull(repo.draft(ACCOUNT, "bob"))
        assertNull(repo.account(ACCOUNT))

        repo.forgetAccount(ACCOUNT, keepPending = false)

        assertNull(repo.operation("send:queued"))
        assertNull(repo.message(ACCOUNT, "bob", "queued"))
        assertEquals(0, repo.pendingCount(ACCOUNT).first())
    }

    @Test
    fun accountsWithTheSamePeerNeverSeeEachOther() = runTest {
        val other = "https://other.example|me"
        repo.enqueueMessage(message("bob", "m1", text = "mine"), operation("m1", "bob"))
        repo.enqueueMessage(
            message("bob", "m1", text = "theirs", account = other),
            operation("m1", "bob", account = other, opId = "send:other:m1"),
        )

        assertEquals("mine", repo.message(ACCOUNT, "bob", "m1")?.text)
        assertEquals("theirs", repo.message(other, "bob", "m1")?.text)
        assertEquals(1, repo.messages(ACCOUNT, "bob", 50).first().size)
        assertEquals(1, repo.conversations(other).first().size)
        assertEquals(listOf("send:m1"), repo.claimDue(ACCOUNT, "sender", now, 10).map(PendingOperationEntity::opId))

        repo.forgetAccount(ACCOUNT, keepPending = false)

        assertNotNull(repo.message(other, "bob", "m1"))
        assertEquals(1, repo.pendingCount(other).first())
    }

    @Test
    fun rosterDoesNotClobberANewerLocalPreview() = runTest {
        repo.applyIncoming(
            ACCOUNT,
            "bob",
            message("bob", "m9", ts = 9_000L, text = "just arrived", mine = false),
            countUnread = true,
        )
        repo.applyHistoryPage(ACCOUNT, "bob", emptyList(), peerReadTs = 0L)

        repo.applyRoster(
            ACCOUNT,
            listOf(
                ChatRepository.RosterRow(
                    accountKey = ACCOUNT,
                    peer = "bob",
                    name = "Bob",
                    online = true,
                    lastSeen = 8_000L,
                    unread = 1,
                    previewFrom = "bob",
                    previewText = "stale server preview",
                    previewMedia = null,
                    previewTs = 3_000L,
                ),
            ),
        )

        val conversation = repo.conversation(ACCOUNT, "bob")
        assertEquals("just arrived", conversation?.previewText)
        assertEquals(9_000L, conversation?.previewTs)
        assertEquals("Bob", conversation?.name)
        assertTrue(conversation?.online == true)
        assertTrue("roster must not un-seed local history", conversation?.historySeeded == true)
    }

    @Test
    fun applyIncomingOnlyRaisesUnreadOnTheMessagesFirstInsert() = runTest {
        repo.applyIncoming(ACCOUNT, "bob", message("bob", "m1", ts = 1_000L, mine = false), countUnread = true)
        assertEquals(1, repo.conversation(ACCOUNT, "bob")?.unread)

        // The same id again — a retry, a self-sync echo, a redelivered frame —
        // updates the row but must not count a second unread item.
        repo.applyIncoming(ACCOUNT, "bob", message("bob", "m1", ts = 1_000L, mine = false), countUnread = true)
        assertEquals(1, repo.conversation(ACCOUNT, "bob")?.unread)

        // A genuinely new id does raise it.
        repo.applyIncoming(ACCOUNT, "bob", message("bob", "m2", ts = 2_000L, mine = false), countUnread = true)
        assertEquals(2, repo.conversation(ACCOUNT, "bob")?.unread)
    }

    /** §4.5: a finished call becomes a `messages` row like any other kind —
     *  merged, previewed, and (only when missed) counted as unread — via the
     *  same `recordCall` path `CloudController.onCallEnded` calls. */
    @Test
    fun recordCallInsertsARowAndTouchesThePreview() = runTest {
        val call = message(
            "bob",
            "call-c1",
            ts = 1_000L,
            text = "",
            mine = false,
            kind = MessageKind.CALL,
            callOutcome = CallOutcome.MISSED,
            callDurationSec = 0,
        )
        assertTrue(repo.recordCall(ACCOUNT, "bob", call, countUnread = true))

        assertEquals(CallOutcome.MISSED, repo.message(ACCOUNT, "bob", "call-c1")?.callOutcome)
        val conversation = repo.conversation(ACCOUNT, "bob")
        assertEquals("call", conversation?.previewMedia)
        assertEquals(1_000L, conversation?.previewTs)
        assertEquals(1, conversation?.unread)
    }

    @Test
    fun recordCallOnlyCountsUnreadWhenTheCallerSaysTo() = runTest {
        val answered = message(
            "bob",
            "call-c2",
            ts = 1_000L,
            text = "",
            mine = true,
            kind = MessageKind.CALL,
            callOutcome = CallOutcome.ANSWERED,
            callDurationSec = 42,
        )
        repo.recordCall(ACCOUNT, "bob", answered, countUnread = false)
        assertEquals(0, repo.conversation(ACCOUNT, "bob")?.unread ?: 0)
    }

    @Test
    fun setUnreadSnapshotIsAbsoluteNotAdditive() = runTest {
        repo.setUnreadSnapshot(ACCOUNT, "bob", previewText = "привет", previewTs = 1_000L, count = 3)
        assertEquals(3, repo.conversation(ACCOUNT, "bob")?.unread)

        // A second snapshot for the same absolute total does not pile on top
        // of the first — it replaces it, matching the server's own count.
        repo.setUnreadSnapshot(ACCOUNT, "bob", previewText = "привет", previewTs = 1_000L, count = 3)
        assertEquals(3, repo.conversation(ACCOUNT, "bob")?.unread)

        repo.setUnreadSnapshot(ACCOUNT, "bob", previewText = "ещё", previewTs = 2_000L, count = 1)
        assertEquals(1, repo.conversation(ACCOUNT, "bob")?.unread)
    }

    /** The historical Android "unread 500" bug: a client that had accumulated
     *  an inflated local count from the old increment-based path must be
     *  corrected by the next absolute roster snapshot (`applyRoster`, sent on
     *  `ready`/`users` and after reconnect), not left to keep climbing. */
    @Test
    fun applyRosterCorrectsAStaleInflatedUnreadCount() = runTest {
        repo.setUnreadSnapshot(ACCOUNT, "bob", previewText = null, previewTs = 500L, count = 500)
        assertEquals(500, repo.conversation(ACCOUNT, "bob")?.unread)

        repo.applyRoster(
            ACCOUNT,
            listOf(
                ChatRepository.RosterRow(
                    accountKey = ACCOUNT,
                    peer = "bob",
                    name = "Bob",
                    online = true,
                    lastSeen = 8_000L,
                    unread = 1,
                    previewFrom = "bob",
                    previewText = "server truth",
                    previewMedia = null,
                    previewTs = 3_000L,
                ),
            ),
        )

        assertEquals(1, repo.conversation(ACCOUNT, "bob")?.unread)
    }


    @Test
    fun serverProofClearsTheQueueAndRaisesDelivery() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))
        repo.enqueueMessage(message("bob", "m2"), operation("m2", "bob"))
        repo.markDelivery(ACCOUNT, "bob", "m2", DeliveryState.Read)

        repo.acceptByServerProof(ACCOUNT, "bob", listOf("m1", "m2"))

        assertEquals(0, repo.pendingCount(ACCOUNT).first())
        assertEquals(DeliveryState.Accepted, repo.message(ACCOUNT, "bob", "m1")?.deliveryState)
        assertEquals(DeliveryState.Read, repo.message(ACCOUNT, "bob", "m2")?.deliveryState)
    }

    @Test
    fun unreadIncomingSkipsOwnAndAlreadyReadMessages() = runTest {
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(
                message("bob", "in1", ts = 1L, mine = false, delivery = DeliveryState.Delivered),
                message("bob", "in2", ts = 2L, mine = false, delivery = DeliveryState.Read),
                message("bob", "out1", ts = 3L, mine = true, delivery = DeliveryState.Accepted),
            ),
            peerReadTs = 0L,
        )

        // The bound on how many one flush may collect is the engine's business
        // (SyncEngineReadReceiptTest); what this pins is which rows qualify.
        assertEquals(listOf("in1"), repo.unreadIncoming(ACCOUNT, "bob", limit = 200))
    }

    @Test
    fun historyPageNeverPullsBackDeliveryOrResurrectsADeletedRow() = runTest {
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(
                message("bob", "m1", ts = 1L, text = "one", delivery = DeliveryState.Accepted),
                message("bob", "m2", ts = 2L, text = "two", delivery = DeliveryState.Accepted),
            ),
            peerReadTs = 0L,
        )
        repo.markDelivery(ACCOUNT, "bob", "m1", DeliveryState.Read)
        repo.applyDelete(ACCOUNT, "bob", listOf("m2"))

        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(
                message("bob", "m1", ts = 1L, text = "one", delivery = DeliveryState.Accepted),
                message("bob", "m2", ts = 2L, text = "two", delivery = DeliveryState.Accepted),
            ),
            peerReadTs = 4L,
        )

        assertEquals(DeliveryState.Read, repo.message(ACCOUNT, "bob", "m1")?.deliveryState)
        assertEquals("", repo.message(ACCOUNT, "bob", "m2")?.text)
        assertNotNull(repo.message(ACCOUNT, "bob", "m2")?.deletedAt)
        assertEquals(4L, repo.conversation(ACCOUNT, "bob")?.peerReadTs)
    }

    /**
     * The message menu's «Прочитано: 14:44 · телефон» line is only as good as
     * what the conversation row kept: the *when* (`readAt`) and the *which
     * client* (`via`) arrive on the same receipt as the watermark, and a
     * `MAX(peerReadTs)` alone cannot recover either. An older watermark
     * arriving late — a duplicate frame, or a queued one drained out of order —
     * says nothing new about who read what, so it must not relabel a read that
     * already happened elsewhere.
     */
    @Test
    fun peerReadWatermarkKeepsTheReadTimeAndClientAndAStaleFrameCannotRelabelThem() = runTest {
        repo.applyHistoryPage(ACCOUNT, "bob", emptyList(), peerReadTs = 0L)

        repo.peerReadWatermark(ACCOUNT, "bob", ts = 3_000L, readAt = 9_000L, via = "android/450")
        assertEquals(3_000L, repo.conversation(ACCOUNT, "bob")?.peerReadTs)
        assertEquals(9_000L, repo.conversation(ACCOUNT, "bob")?.peerReadAt)
        assertEquals("android/450", repo.conversation(ACCOUNT, "bob")?.peerReadVia)

        repo.peerReadWatermark(ACCOUNT, "bob", ts = 2_000L, readAt = 1_000L, via = "web")
        assertEquals("an older watermark never moves the mark", 3_000L, repo.conversation(ACCOUNT, "bob")?.peerReadTs)
        assertEquals("nor does it rewrite when the mark was reached", 9_000L, repo.conversation(ACCOUNT, "bob")?.peerReadAt)
        assertEquals("nor the client that reached it", "android/450", repo.conversation(ACCOUNT, "bob")?.peerReadVia)
    }

    /**
     * `/api/history` carries the same pair next to `peerReadTs`, so a device
     * that was closed while the peer read still learns both on the next open —
     * this is the path that backfills a row written before the columns existed.
     */
    @Test
    fun historyPageRecordsThePeersReadTimeAndClient() = runTest {
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(message("bob", "m1", ts = 1L)),
            peerReadTs = 4L,
            peerReadAt = 9_000L,
            peerReadVia = "cli",
        )

        assertEquals(4L, repo.conversation(ACCOUNT, "bob")?.peerReadTs)
        assertEquals(9_000L, repo.conversation(ACCOUNT, "bob")?.peerReadAt)
        assertEquals("cli", repo.conversation(ACCOUNT, "bob")?.peerReadVia)
    }

    /**
     * The delivered rung is a watermark exactly like the read one above it:
     * everything of this account's own at or before `ts` is on the peer's
     * device, the later one is not, an incoming row is not this device's to
     * state anything about, and neither read watermark nor the queue is
     * touched — holding a message is not reading it, and it is not permission
     * to drop an unsent copy of it.
     */
    @Test
    fun peerDeliveredWatermarkLiftsEveryOwnRowBelowItAndLeavesTheReadFactsAlone() = runTest {
        repo.enqueueMessage(message("bob", "m-queued", ts = 500L), operation("m-queued", "bob"))
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(
                message("bob", "m-early", ts = 1_000L, delivery = DeliveryState.Accepted),
                message("bob", "m-mid", ts = 2_000L, delivery = DeliveryState.Accepted),
                message("bob", "m-late", ts = 3_000L, delivery = DeliveryState.Accepted),
                message("bob", "in-1", ts = 1_500L, mine = false, delivery = DeliveryState.Accepted),
            ),
            peerReadTs = 0L,
        )

        repo.peerDeliveredWatermark(ACCOUNT, "bob", ts = 2_000L)

        assertEquals(2_000L, repo.conversation(ACCOUNT, "bob")?.peerDeliveredTs)
        assertEquals(
            "the watermark settles every own row at or below it, not just the newest",
            DeliveryState.Delivered,
            repo.message(ACCOUNT, "bob", "m-early")?.deliveryState,
        )
        assertEquals(DeliveryState.Delivered, repo.message(ACCOUNT, "bob", "m-mid")?.deliveryState)
        assertEquals(
            "a row past the watermark is not delivered",
            DeliveryState.Accepted,
            repo.message(ACCOUNT, "bob", "m-late")?.deliveryState,
        )
        assertEquals(
            "the peer's device holding a message says nothing about our own incoming one",
            DeliveryState.Accepted,
            repo.message(ACCOUNT, "bob", "in-1")?.deliveryState,
        )
        assertEquals(
            "a message the server never took cannot be on the peer's device, however old it is",
            DeliveryState.Queued,
            repo.message(ACCOUNT, "bob", "m-queued")?.deliveryState,
        )
        assertEquals(
            "delivery is not read: the read watermark must not move",
            0L,
            repo.conversation(ACCOUNT, "bob")?.peerReadTs,
        )
        assertEquals(
            "nor may it write the queue off — an unsent copy is still ours to send",
            1,
            repo.pendingCount(ACCOUNT).first(),
        )
    }

    /**
     * The FAILME case from the 2026-10-26 report: a later message was
     * delivered and read while an earlier one never left the queue. Neither
     * watermark may raise the unsent one or the one the queue gave up on; the
     * unsent one takes them the moment the server accepts it.
     */
    @Test
    fun watermarksSkipUncommittedRowsUntilTheirAcceptanceLands() = runTest {
        repo.enqueueMessage(message("bob", "m-stuck", ts = 1_000L), operation("m-stuck", "bob"))
        repo.enqueueMessage(message("bob", "m-dead", ts = 1_100L), operation("m-dead", "bob"))
        repo.failOperation("send:m-dead", "no_acceptance", ErrorKind.Retryable.ordinal)
        repo.enqueueMessage(message("bob", "m-later", ts = 2_000L), operation("m-later", "bob"))
        repo.completeOperation("send:m-later", "m-later", DeliveryState.Accepted, null)

        repo.peerDeliveredWatermark(ACCOUNT, "bob", ts = 2_000L)
        repo.peerReadWatermark(ACCOUNT, "bob", ts = 2_000L)

        assertEquals(DeliveryState.Read, repo.message(ACCOUNT, "bob", "m-later")?.deliveryState)
        assertEquals(
            "an unsent message stays ⧗ under both watermarks",
            DeliveryState.Queued,
            repo.message(ACCOUNT, "bob", "m-stuck")?.deliveryState,
        )
        assertEquals(
            "and a failed one stays ⚠",
            DeliveryState.Failed,
            repo.message(ACCOUNT, "bob", "m-dead")?.deliveryState,
        )

        repo.completeOperation("send:m-stuck", "m-stuck", DeliveryState.Accepted, null, serverTs = 1_000L)
        assertEquals(
            "accepted below a read watermark it was too early for, it is read",
            DeliveryState.Read,
            repo.message(ACCOUNT, "bob", "m-stuck")?.deliveryState,
        )

        repo.enqueueMessage(message("bob", "m-new", ts = 3_000L), operation("m-new", "bob"))
        repo.completeOperation("send:m-new", "m-new", DeliveryState.Accepted, null, serverTs = 3_000L)
        assertEquals(
            "a row accepted past both watermarks is only sent",
            DeliveryState.Accepted,
            repo.message(ACCOUNT, "bob", "m-new")?.deliveryState,
        )
    }

    /** A stale `ack` drained out of order, or replayed on a reconnect, is not
     *  news that the mark moved backwards. */
    @Test
    fun aStaleDeliveredWatermarkNeverPullsTheMarkBackOrDowngradesARow() = runTest {
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(message("bob", "m-mid", ts = 2_000L, delivery = DeliveryState.Accepted)),
            peerReadTs = 0L,
            peerDeliveredTs = 3_000L,
        )

        repo.peerDeliveredWatermark(ACCOUNT, "bob", ts = 1_000L)

        assertEquals("the watermark only ever climbs", 3_000L, repo.conversation(ACCOUNT, "bob")?.peerDeliveredTs)
        assertEquals(
            "and a row already delivered is not downgraded",
            DeliveryState.Delivered,
            repo.message(ACCOUNT, "bob", "m-mid")?.deliveryState,
        )
    }

    /**
     * The same answer carries both rungs, and applying them the other way round
     * must reach the same place: the DAO only ever climbs, so a read page that
     * finds the delivered watermark stale (or absent) still leaves every row it
     * covers Read — the stronger rung — and the conversation keeps the delivered
     * watermark it was told, never a `0` that would claim "not delivered" about
     * messages the peer has plainly read.
     */
    @Test
    fun historyPageAppliesDeliveredAndReadWithoutLettingReadWalkBackwards() = runTest {
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(
                message("bob", "m1", ts = 1_000L, delivery = DeliveryState.Accepted),
                message("bob", "m2", ts = 2_000L, delivery = DeliveryState.Accepted),
            ),
            peerReadTs = 2_000L,
            peerDeliveredTs = 1_000L,
        )

        assertEquals(2_000L, repo.conversation(ACCOUNT, "bob")?.peerReadTs)
        assertEquals(1_000L, repo.conversation(ACCOUNT, "bob")?.peerDeliveredTs)
        assertEquals(
            "read outranks delivered for a row both cover",
            DeliveryState.Read,
            repo.message(ACCOUNT, "bob", "m1")?.deliveryState,
        )
        assertEquals(DeliveryState.Read, repo.message(ACCOUNT, "bob", "m2")?.deliveryState)
    }

    @Test
    fun messagesAreOldestFirstInsideTheNewestWindow() = runTest {
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            (1..5).map { message("bob", "m$it", ts = it.toLong(), text = "t$it") },
            peerReadTs = 0L,
        )

        assertEquals(listOf("m3", "m4", "m5"), repo.messages(ACCOUNT, "bob", 3).first().map(MessageEntity::id))
        assertEquals(listOf("m1", "m2"), repo.messagePage(ACCOUNT, "bob", beforeTs = 3L, limit = 10).map(MessageEntity::id))
    }

    @Test
    fun reactionsAccumulateAndDisappearWithTheirLastAuthor() = runTest {
        repo.enqueueMessage(message("bob", "m1"), operation("m1", "bob"))

        repo.applyReaction(ACCOUNT, "bob", "m1", "🔥", "bob", add = true)
        repo.applyReaction(ACCOUNT, "bob", "m1", "🔥", "me", add = true)
        assertEquals(
            mapOf("🔥" to listOf("bob", "me")),
            Payloads.decodeReactions(repo.message(ACCOUNT, "bob", "m1")?.reactionsJson),
        )

        repo.applyReaction(ACCOUNT, "bob", "m1", "🔥", "bob", add = false)
        repo.applyReaction(ACCOUNT, "bob", "m1", "🔥", "me", add = false)
        assertNull(repo.message(ACCOUNT, "bob", "m1")?.reactionsJson)
    }

    // --- MediaCache / CursorWindow --------------------------------------
    //
    // Android's CursorWindow caps what any `SELECT` can return per row at
    // roughly 2 MB, native, and it applies even to a `SELECT` of one big
    // column alone (`SQLiteBlobTooBigException: Row too big to fit into
    // CursorWindow`). A compressed photo's base64 form (`CLOUD_MEDIA_MAX_CHARS`
    // allows up to 10 MiB of it) routinely exceeds that. Before `MediaCache`,
    // this meant: send a photo offline, and every future `claimDue()` —
    // hence every reconnect, forever — threw before it, or anything queued
    // behind it, ever reached the socket; opening the conversation threw the
    // same way.

    private val hugeDataUrl = "data:image/webp;base64," + "A".repeat(9_800_000)

    @Test
    fun enqueueMessageNeverLeavesTheRawImageInAQueriedRow() = runTest {
        val op = operation("m1", "bob").copy(
            payloadJson = Payloads.messagePayload(
                text = "photo", ts = 100L, author = "me",
                imageDataUrl = hugeDataUrl, imageWidth = 100, imageHeight = 100,
                voiceDataUrl = null, voiceDurationSec = null,
                replyId = null, replyFrom = null, replyText = null, replyMedia = null,
                forwardLogin = null, forwardName = null,
            ),
        )
        val message = message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = hugeDataUrl)
        assertTrue(repo.enqueueMessage(message, op))

        // What actually landed in the row Room queries — never the huge value.
        val storedOp = db.pendingOps().find("send:m1")!!
        assertTrue(storedOp.payloadJson.length < 1_000)
        val storedMessage = db.messages().find(ACCOUNT, "bob", "m1")!!
        assertTrue((storedMessage.imageDataUrl?.length ?: 0) < 1_000)

        // What every caller of the repository still sees, once it asks for it —
        // `claimDue` (SyncEngine sending) still resolves eagerly, since the
        // wire frame needs the real bytes; `message` (display) does not, since
        // fixing this test's regression (`messagesReturnsTheMediaReferenceUnresolvedAndResolveMediaRecoversIt`
        // below) is what stops `CloudState` holding one of these per photo.
        val claimed = repo.claimDue(ACCOUNT, "owner-1", now, 10)
        assertEquals(hugeDataUrl, Payloads.parseMessagePayload(claimed.single().payloadJson)?.imageDataUrl)
        val stored = repo.message(ACCOUNT, "bob", "m1")
        assertNotEquals(hugeDataUrl, stored?.imageDataUrl)
        assertEquals(hugeDataUrl, repo.resolveMedia(stored?.imageDataUrl))
    }

    @Test
    fun messagesReturnsTheMediaReferenceUnresolvedAndResolveMediaRecoversIt() = runTest {
        // Regression for the fix that stopped `ChatRepository.messages()` /
        // `messagePage()` / `message()` from resolving every row's media to
        // its full `data:` URL before handing it to the UI: doing that meant
        // `CloudState.messages` held one full-size string per photo in the
        // whole scroll window, on screen or not, for as long as the
        // conversation stayed open. On the old code this test's first two
        // assertions fail — `imageDataUrl` comes back as `hugeDataUrl` itself.
        val dataUrl = "data:image/webp;base64," + "B".repeat(500)
        repo.enqueueMessage(
            message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = dataUrl),
            operation("m1", "bob"),
        )

        val fromFlow = repo.messages(ACCOUNT, "bob", 10).first().single()
        val fromPage = repo.messagePage(ACCOUNT, "bob", beforeTs = now + 1, limit = 10).single()
        val fromFind = repo.message(ACCOUNT, "bob", "m1")

        for (row in listOf(fromFlow, fromPage, fromFind)) {
            assertNotEquals(dataUrl, row?.imageDataUrl)
            assertEquals(dataUrl, repo.resolveMedia(row?.imageDataUrl))
        }
    }

    @Test
    fun applyDeleteFreesTheDeletedMessagesMediaFile() = runTest {
        val dataUrl = "data:image/webp;base64," + "C".repeat(500)
        repo.enqueueMessage(
            message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = dataUrl),
            operation("m1", "bob"),
        )
        val ref = repo.message(ACCOUNT, "bob", "m1")?.imageDataUrl
        assertEquals(dataUrl, repo.resolveMedia(ref))

        // Mirrors CloudController.deleteMessages: the queue entry goes first,
        // then the tombstone.
        repo.cancelOperationsFor(ACCOUNT, "m1")
        repo.applyDelete(ACCOUNT, "bob", listOf("m1"))

        assertNull("a tombstoned row's file must not survive it", repo.resolveMedia(ref))
    }

    @Test
    fun clearTranscriptsFreesAcceptedMediaButNeverAPendingVoiceNote() = runTest {
        val photoUrl = "data:image/webp;base64," + "D".repeat(500)
        val voiceUrl = "data:audio/mp4;base64," + "E".repeat(500)
        repo.enqueueMessage(
            message("bob", "sent", kind = MessageKind.IMAGE).copy(imageDataUrl = photoUrl),
            operation("sent", "bob"),
        )
        // Accepted: the outbox has already cleared its queue entry, same as a
        // real delivered photo — nothing still owes it.
        repo.acceptByServerProof(ACCOUNT, "bob", listOf("sent"))
        repo.enqueueMessage(
            message("bob", "pending", kind = MessageKind.VOICE).copy(voiceDataUrl = voiceUrl),
            operation("pending", "bob"),
        )
        val sentRef = repo.message(ACCOUNT, "bob", "sent")?.imageDataUrl
        val pendingRef = repo.message(ACCOUNT, "bob", "pending")?.voiceDataUrl

        repo.clearTranscripts(ACCOUNT)

        assertNull("cleared row", repo.message(ACCOUNT, "bob", "sent"))
        assertNull("cache clear must free an accepted message's file", repo.resolveMedia(sentRef))
        assertNotNull("still queued to send, so kept", repo.message(ACCOUNT, "bob", "pending"))
        assertEquals(
            "cache clear must never take the only copy of a pending voice note",
            voiceUrl,
            repo.resolveMedia(pendingRef),
        )
    }

    @Test
    fun clearTranscriptFreesOnlyThatConversationsMedia() = runTest {
        val bobUrl = "data:image/webp;base64," + "F".repeat(500)
        val carolUrl = "data:image/webp;base64," + "G".repeat(500)
        repo.enqueueMessage(message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = bobUrl), operation("m1", "bob"))
        repo.acceptByServerProof(ACCOUNT, "bob", listOf("m1"))
        repo.enqueueMessage(message("carol", "m2", kind = MessageKind.IMAGE).copy(imageDataUrl = carolUrl), operation("m2", "carol"))
        repo.acceptByServerProof(ACCOUNT, "carol", listOf("m2"))
        val bobRef = repo.message(ACCOUNT, "bob", "m1")?.imageDataUrl
        val carolRef = repo.message(ACCOUNT, "carol", "m2")?.imageDataUrl

        repo.clearTranscript(ACCOUNT, "bob")

        assertNull(repo.resolveMedia(bobRef))
        assertEquals("a different conversation's media must survive", carolUrl, repo.resolveMedia(carolRef))
    }

    @Test
    fun forgetAccountKeepPendingFreesTheNonPendingMessagesMedia() = runTest {
        val oldUrl = "data:image/webp;base64," + "H".repeat(500)
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(message("bob", "old", ts = 5L, mine = false, delivery = DeliveryState.Delivered, kind = MessageKind.IMAGE).copy(imageDataUrl = oldUrl)),
            peerReadTs = 0L,
        )
        repo.enqueueMessage(message("bob", "queued"), operation("queued", "bob"))
        val oldRef = repo.message(ACCOUNT, "bob", "old")?.imageDataUrl

        repo.forgetAccount(ACCOUNT, keepPending = true)

        assertNull("logout/account-switch must free a non-pending message's file", repo.resolveMedia(oldRef))
    }

    /**
     * Deleting a contact takes that conversation's whole local copy — and only
     * that one. The still-queued message goes with the rest, which is where
     * this parts company with [ChatRepository.clearTranscript] and
     * `forgetAccount(keepPending = true)`: the server refuses frames between
     * this pair (`peer_not_found`) from now on and answers an empty history
     * page for it forever, so a message still owed to that contact is a send
     * that can never land. Carol's identical row is the control: nothing here
     * may be a wider net than one peer.
     */
    @Test
    fun purgeContactTakesItsWholeLocalCopyAndLeavesOtherPeersAlone() = runTest {
        val bobUrl = "data:image/webp;base64," + "I".repeat(500)
        val carolUrl = "data:image/webp;base64," + "J".repeat(500)
        repo.enqueueMessage(message("bob", "b-queued", kind = MessageKind.IMAGE).copy(imageDataUrl = bobUrl), operation("b-queued", "bob"))
        repo.applyHistoryPage(
            ACCOUNT,
            "bob",
            listOf(message("bob", "b-kept", ts = 5L, mine = false, delivery = DeliveryState.Delivered)),
            peerReadTs = 0L,
        )
        repo.enqueueMessage(message("carol", "c-queued", kind = MessageKind.IMAGE).copy(imageDataUrl = carolUrl), operation("c-queued", "carol"))
        repo.applyHistoryPage(
            ACCOUNT,
            "carol",
            listOf(message("carol", "c-kept", ts = 5L, mine = false, delivery = DeliveryState.Delivered)),
            peerReadTs = 0L,
        )
        repo.saveDraft(draft("bob"))
        repo.saveDraft(draft("carol"))
        assertNotNull(repo.claimNotification(ACCOUNT, "bob", "b-kept", visible = false))
        assertNotNull(repo.claimNotification(ACCOUNT, "carol", "c-kept", visible = false))
        val bobRef = repo.message(ACCOUNT, "bob", "b-queued")?.imageDataUrl

        repo.purgeContact(ACCOUNT, "bob")

        assertNull("the transcript goes, stored rows and queued ones alike", repo.message(ACCOUNT, "bob", "b-kept"))
        assertNull(repo.message(ACCOUNT, "bob", "b-queued"))
        assertNull("the roster row is what removes the contact", repo.conversation(ACCOUNT, "bob"))
        assertNull("an unsent draft for a deleted contact is not kept", repo.draft(ACCOUNT, "bob"))
        assertNull("nothing is still owed to a contact that is gone", repo.operation("send:b-queued"))
        assertNull("nor is there anything left to alert about", repo.notificationStatus(ACCOUNT, "bob", "b-kept"))
        assertNull("the deleted rows' media is freed", repo.resolveMedia(bobRef))

        assertNotNull(repo.message(ACCOUNT, "carol", "c-kept"))
        assertNotNull(repo.message(ACCOUNT, "carol", "c-queued"))
        assertNotNull(repo.conversation(ACCOUNT, "carol"))
        assertNotNull(repo.draft(ACCOUNT, "carol"))
        assertNotNull(repo.operation("send:c-queued"))
        assertNotNull(repo.notificationStatus(ACCOUNT, "carol", "c-kept"))
        assertEquals("a different conversation's media must survive", carolUrl, repo.resolveMedia(repo.message(ACCOUNT, "carol", "c-queued")?.imageDataUrl))
    }

    @Test
    fun claimDueSelfHealsARowFromBeforeMediaCacheExisted() = runTest {
        // Simulates a row written by the pre-fix code path: the literal
        // `data:` URL inline in `payloadJson`, inserted below Room level so
        // `ChatRepository` never gets a chance to cache it first.
        db.messages().insert(message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = hugeDataUrl))
        db.pendingOps().insert(
            operation("m1", "bob").copy(
                payloadJson = Payloads.messagePayload(
                    text = "photo", ts = 100L, author = "me",
                    imageDataUrl = hugeDataUrl, imageWidth = 100, imageHeight = 100,
                    voiceDataUrl = null, voiceDurationSec = null,
                    replyId = null, replyFrom = null, replyText = null, replyMedia = null,
                    forwardLogin = null, forwardName = null,
                ),
            ),
        )

        // Pre-fix, this line threw `SQLiteBlobTooBigException` every time —
        // the crash the offline photo never recovered from.
        val claimed = repo.claimDue(ACCOUNT, "owner-1", now, 10)

        assertTrue("unrecoverable row must not be handed out to send", claimed.isEmpty())
        val healed = repo.message(ACCOUNT, "bob", "m1")
        assertNull("the photo could not be recovered, so it must not still claim to be there", healed?.imageDataUrl)
        assertEquals(DELIVERY_FAILED, healed?.delivery)
        assertNull("a queue entry with no recoverable content must not offer a retry", repo.operationForMessage(ACCOUNT, "m1"))
    }

    @Test
    fun storeWritesAtomicallyAndLeavesNoTempFileBehind() {
        val root = File.createTempFile("tailchat-test-media-atomic", "").apply { delete(); mkdirs() }
        val cache = MediaCache(root)
        val dataUrl = "data:image/webp;base64," + "X".repeat(500)

        val ref = cache.store(ACCOUNT, "m1", "img", dataUrl)

        assertEquals("a successful store must round-trip the exact bytes it was given", dataUrl, cache.load(ref))
        val leftovers = root.walkTopDown().filter { it.isFile && it.name.contains(".tmp-") }.toList()
        assertTrue("a successful store must not leave its staging temp file behind", leftovers.isEmpty())
    }

    /** [MediaCache.store] writes to a temp file and only then publishes it
     *  with an atomic rename — this is what a write failure exercises: the
     *  final path must never end up with a half-written file, which is why
     *  [enqueueMessage]/[applyIncoming]/[applyHistoryPage] must see this as
     *  a plain `false`, the same as any other write this class refuses,
     *  rather than an exception past their documented contract. */
    @Test
    fun enqueueMessageReturnsFalseAndWritesNothingWhenTheMediaCacheCannotWrite() = runTest {
        val unwritableRoot = File.createTempFile("tailchat-test-media-ro1", "").apply { delete(); mkdirs() }
        val brokenRepo = ChatRepository(db, MediaCache(unwritableRoot)) { now }
        unwritableRoot.setWritable(false)
        try {
            val dataUrl = "data:image/webp;base64," + "Z".repeat(500)
            val committed = brokenRepo.enqueueMessage(
                message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = dataUrl),
                operation("m1", "bob"),
            )

            assertFalse("a media write failure must not be reported as sent", committed)
            assertNull("nothing must be written when the media write failed", brokenRepo.message(ACCOUNT, "bob", "m1"))
            assertNull(brokenRepo.operation("send:m1"))
        } finally {
            unwritableRoot.setWritable(true)
        }
    }

    @Test
    fun applyIncomingReturnsFalseAndWritesNothingWhenTheMediaCacheCannotWrite() = runTest {
        val unwritableRoot = File.createTempFile("tailchat-test-media-ro2", "").apply { delete(); mkdirs() }
        val brokenRepo = ChatRepository(db, MediaCache(unwritableRoot)) { now }
        unwritableRoot.setWritable(false)
        try {
            val dataUrl = "data:image/webp;base64," + "Y".repeat(500)
            val accepted = brokenRepo.applyIncoming(
                ACCOUNT,
                "bob",
                message("bob", "in1", mine = false, kind = MessageKind.IMAGE).copy(imageDataUrl = dataUrl),
                countUnread = true,
            )

            assertFalse("an incoming message whose media could not be cached must not be accepted", accepted)
            assertNull(brokenRepo.message(ACCOUNT, "bob", "in1"))
        } finally {
            unwritableRoot.setWritable(true)
        }
    }

    @Test
    fun applyHistoryPageReturnsFalseAndWritesNothingWhenTheMediaCacheCannotWrite() = runTest {
        val unwritableRoot = File.createTempFile("tailchat-test-media-ro3", "").apply { delete(); mkdirs() }
        val brokenRepo = ChatRepository(db, MediaCache(unwritableRoot)) { now }
        unwritableRoot.setWritable(false)
        try {
            val dataUrl = "data:image/webp;base64," + "W".repeat(500)
            val stored = brokenRepo.applyHistoryPage(
                ACCOUNT,
                "bob",
                listOf(message("bob", "h1", mine = false, kind = MessageKind.IMAGE).copy(imageDataUrl = dataUrl)),
                peerReadTs = 0L,
            )

            assertFalse("a history page whose media could not be cached must not be reported as applied", stored)
            assertNull(brokenRepo.message(ACCOUNT, "bob", "h1"))
        } finally {
            unwritableRoot.setWritable(true)
        }
    }

    @Test
    fun messagesFlowSelfHealsARowFromBeforeMediaCacheExisted() = runTest {
        db.messages().insert(message("bob", "m1", kind = MessageKind.IMAGE).copy(imageDataUrl = hugeDataUrl))

        // Pre-fix, collecting this flow threw the same way `claimDue` did.
        val loaded = repo.messages(ACCOUNT, "bob", 10).first()

        assertEquals(listOf("m1"), loaded.map(MessageEntity::id))
        assertNull(loaded.single().imageDataUrl)
    }

    @Test
    fun notificationClaimIsSingleAcrossLivePushAndRepeatDelivery() = runTest {
        assertTrue(
            repo.applyHistoryPage(
                ACCOUNT,
                "bob",
                listOf(message("bob", "m1", ts = 2_000L, text = "hello", mine = false, delivery = DeliveryState.Accepted)),
                peerReadTs = 0L,
            ),
        )

        val first = repo.claimNotification(ACCOUNT, "bob", "m1", visible = false)
        val racingPush = repo.claimNotification(ACCOUNT, "bob", "m1", visible = false)
        assertEquals("m1", first?.messageId)
        assertNull("a second path must not alert while the first owns the claim", racingPush)

        repo.completeNotification(ACCOUNT, "bob", "m1", posted = true)
        assertNull("a repeated FCM delivery must stay terminal", repo.claimNotification(ACCOUNT, "bob", "m1", visible = false))
        assertEquals(NotificationDeliveryStatus.POSTED, repo.notificationStatus(ACCOUNT, "bob", "m1"))
    }

    @Test
    fun notificationEligibilitySuppressesVisibleOwnReadAndDeletedMessages() = runTest {
        val rows = listOf(
            message("bob", "visible", ts = 2_000L, mine = false, delivery = DeliveryState.Accepted),
            message("bob", "own", ts = 2_001L, mine = true, delivery = DeliveryState.Accepted),
            message("bob", "read", ts = 2_002L, mine = false, delivery = DeliveryState.Read),
            message("bob", "deleted", ts = 2_003L, mine = false, delivery = DeliveryState.Accepted)
                .copy(deletedAt = 2_004L),
        )
        assertTrue(repo.applyHistoryPage(ACCOUNT, "bob", rows, peerReadTs = 0L))

        assertNull(repo.claimNotification(ACCOUNT, "bob", "visible", visible = true))
        assertNull(repo.claimNotification(ACCOUNT, "bob", "own", visible = false))
        assertNull(repo.claimNotification(ACCOUNT, "bob", "read", visible = false))
        assertNull(repo.claimNotification(ACCOUNT, "bob", "deleted", visible = false))
        for (id in listOf("visible", "own", "read", "deleted")) {
            assertEquals(NotificationDeliveryStatus.SUPPRESSED, repo.notificationStatus(ACCOUNT, "bob", id))
        }
    }

    @Test
    fun remoteReadSuppressesAnInFlightNotificationWithoutMarkingForDedupe() = runTest {
        assertTrue(
            repo.applyHistoryPage(
                ACCOUNT,
                "bob",
                listOf(message("bob", "m1", ts = 2_000L, mine = false, delivery = DeliveryState.Accepted)),
                peerReadTs = 0L,
            ),
        )
        assertNotNull(repo.claimNotification(ACCOUNT, "bob", "m1", visible = false))

        repo.suppressReadNotifications(ACCOUNT, "bob", readTs = 2_000L)

        assertEquals(NotificationDeliveryStatus.SUPPRESSED, repo.notificationStatus(ACCOUNT, "bob", "m1"))
        assertEquals(
            "notification dedupe must not mutate message read state",
            DeliveryState.Accepted,
            repo.message(ACCOUNT, "bob", "m1")?.deliveryState,
        )
    }

    @Test
    fun abandonedNotificationClaimCanBeRecoveredAfterItsLease() = runTest {
        assertTrue(
            repo.applyHistoryPage(
                ACCOUNT,
                "bob",
                listOf(message("bob", "m1", ts = 2_000L, mine = false, delivery = DeliveryState.Accepted)),
                peerReadTs = 0L,
            ),
        )
        assertNotNull(repo.claimNotification(ACCOUNT, "bob", "m1", visible = false))
        now += 60_001L

        assertEquals("m1", repo.claimNotification(ACCOUNT, "bob", "m1", visible = false)?.messageId)
    }

    @Test
    fun newestIncomingIgnoresOwnAndDeletedRows() = runTest {
        assertTrue(
            repo.applyHistoryPage(
                ACCOUNT,
                "bob",
                listOf(
                    message("bob", "in-1", ts = 1_000L, mine = false, delivery = DeliveryState.Accepted),
                    message("bob", "own-1", ts = 2_000L, mine = true, delivery = DeliveryState.Accepted),
                ),
                peerReadTs = 0L,
            ),
        )
        assertEquals("our own newer message is not what an unread envelope means", "in-1", repo.newestIncoming(ACCOUNT, "bob")?.id)

        assertTrue(
            repo.applyHistoryPage(
                ACCOUNT,
                "bob",
                listOf(message("bob", "in-2", ts = 3_000L, mine = false, delivery = DeliveryState.Accepted)),
                peerReadTs = 0L,
            ),
        )
        assertEquals("in-2", repo.newestIncoming(ACCOUNT, "bob")?.id)
        assertEquals(3_000L, repo.newestIncoming(ACCOUNT, "bob")?.ts)

        repo.applyDelete(ACCOUNT, "bob", listOf("in-2"))
        assertEquals("a tombstone is not alertable content", "in-1", repo.newestIncoming(ACCOUNT, "bob")?.id)
    }

    private fun message(
        peer: String,
        id: String,
        ts: Long = 100L,
        text: String = "hi",
        mine: Boolean = true,
        delivery: DeliveryState = DeliveryState.Queued,
        account: String = ACCOUNT,
        kind: String = MessageKind.TEXT,
        callOutcome: String? = null,
        callDurationSec: Int? = null,
    ) = MessageEntity(
        accountKey = account,
        peer = peer,
        id = id,
        text = text,
        ts = ts,
        author = if (mine) "me" else peer,
        mine = mine,
        delivery = delivery.ordinal,
        system = false,
        kind = kind,
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
        callOutcome = callOutcome,
        callDurationSec = callDurationSec,
    )

    private fun operation(
        messageId: String,
        peer: String,
        account: String = ACCOUNT,
        opId: String = "send:$messageId",
        createdAt: Long = 0L,
    ) = PendingOperationEntity(
        opId = opId,
        accountKey = account,
        peer = peer,
        kind = OperationKind.MESSAGE,
        messageId = messageId,
        payloadJson = Payloads.messagePayload(
            text = "hi",
            ts = 100L,
            author = "me",
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
        createdAt = createdAt,
    )

    private fun draft(peer: String, text: String = "unsent") = DraftEntity(
        accountKey = ACCOUNT,
        peer = peer,
        text = text,
        replyJson = null,
        editingId = null,
        updatedAt = 0L,
    )

    private companion object {
        const val SERVER = "https://chat.example"
        const val ACCOUNT = "https://chat.example|me"
    }
}
