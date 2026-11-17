package net.tailchat.android.data

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The migration harness `TailchatDatabase`'s own doc comment promises: opens
 * the exported v1 schema (`app/schemas/net.tailchat.android.data.TailchatDatabase/1.json`)
 * through `MigrationTestHelper` instead of a fresh in-memory database, so a
 * future version bump is checked against what version 1 actually was on
 * disk, not against what the entities happen to say today.
 *
 * There is no migration to test yet — version 1 is still the only version.
 * When version 2 exists:
 *   1. export its schema too (`./gradlew :app:kspDebugKotlin`, commit the
 *      new `app/schemas/.../2.json`);
 *   2. write a `Migration(1, 2)` object and add it to
 *      `Room.databaseBuilder(...).addMigrations(...)` in `TailchatDatabase.get`;
 *   3. add a test here that calls `helper.createDatabase(TEST_DB, 1)`, seeds
 *      rows with raw SQL, then `helper.runMigrationsAndValidate(TEST_DB, 2,
 *      true, MIGRATION_1_2)` and asserts the seeded rows survived.
 *      `fallbackToDestructiveMigration()` must never be the answer to a
 *      failing assertion here — that is exactly the unsent-queue loss this
 *      whole rearchitecture exists to remove; see `TailchatDatabase`'s own
 *      doc comment.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TailchatDatabaseMigrationTest {

    @get:Rule
    val helper: MigrationTestHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        TailchatDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    /**
     * Seeds every table version 1 shipped with — a conversation, a message,
     * a pending (unsent) operation and a draft, matching the real APK-upgrade
     * scenario in `HANDOFF.md` (existing user data must survive the 0.61.0 →
     * next-release upgrade) — then runs the real [TailchatDatabase.MIGRATION_1_2]
     * and asserts every row is still there afterwards, plus that the new
     * `official` column defaults to `0` for a peer nobody ever marked as the
     * service account.
     */
    @Test
    fun `migration 1 to 2 preserves every existing row and defaults official to false`() {
        val v1 = helper.createDatabase(TEST_DB, 1)
        v1.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 1000, 2, 0, 0, 1, NULL, 1, 1000)",
        )
        v1.execSQL(
            "INSERT INTO messages (accountKey, peer, id, text, ts, author, mine, delivery, system, kind, " +
                "imageDataUrl, imageWidth, imageHeight, voiceDataUrl, voiceDurationSec, reactionsJson, replyJson, " +
                "forwardJson, editedAt, deletedAt, serverSeq) " +
                "VALUES ('srv|alice', 'bob', 'm1', 'hi', 1000, 'bob', 0, 2, 0, 'msg', " +
                "NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
        )
        v1.execSQL(
            "INSERT INTO pending_ops (opId, accountKey, peer, kind, messageId, payloadJson, attempts, " +
                "nextAttemptAt, lastError, errorKind, leaseOwner, leaseUntil, createdAt) " +
                "VALUES ('op1', 'srv|alice', 'bob', 'send', 'm2', '{}', 0, 0, NULL, 0, NULL, 0, 1000)",
        )
        v1.execSQL(
            "INSERT INTO drafts (accountKey, peer, text, replyJson, editingId, updatedAt) " +
                "VALUES ('srv|alice', 'bob', 'unsent draft', NULL, NULL, 1000)",
        )
        v1.close()

        val v2 = helper.runMigrationsAndValidate(TEST_DB, 2, true, TailchatDatabase.MIGRATION_1_2)

        v2.query("SELECT peer, name, unread, official FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("bob", cursor.getString(0))
            assertEquals("Bob", cursor.getString(1))
            assertEquals(2, cursor.getInt(2))
            assertEquals("official must default to false for pre-existing rows", 0, cursor.getInt(3))
        }
        v2.query("SELECT text FROM messages WHERE accountKey = 'srv|alice' AND id = 'm1'").use { cursor ->
            assertTrue("message row lost in migration", cursor.moveToFirst())
            assertEquals("hi", cursor.getString(0))
        }
        v2.query("SELECT messageId FROM pending_ops WHERE opId = 'op1'").use { cursor ->
            assertTrue("pending op lost in migration", cursor.moveToFirst())
            assertEquals("m2", cursor.getString(0))
        }
        v2.query("SELECT text FROM drafts WHERE accountKey = 'srv|alice' AND peer = 'bob'").use { cursor ->
            assertTrue("draft lost in migration", cursor.moveToFirst())
            assertEquals("unsent draft", cursor.getString(0))
        }
        v2.close()
    }

    /**
     * Opens the *exported* version 1 schema — not `Room.databaseBuilder`,
     * which would happily build from today's entity definitions even if they
     * had drifted from what version 1 actually shipped — and checks every
     * table this cutover introduced is there. This is what proves the harness
     * itself (schema export, `MigrationTestHelper` wiring) works, independent
     * of any one migration.
     */
    @Test
    fun `version 1 opens from its exported schema with every table present`() {
        val db = helper.createDatabase(TEST_DB, 1)
        val tables = mutableSetOf<String>()
        db.query("SELECT name FROM sqlite_master WHERE type = 'table'").use { cursor ->
            while (cursor.moveToNext()) tables += cursor.getString(0)
        }
        db.close()

        for (table in listOf("accounts", "conversations", "messages", "pending_ops", "drafts", "sync_state")) {
            assertTrue("missing table $table", tables.contains(table))
        }
    }

    /**
     * The `2 -> 3` migration settles the read-receipt backlog a device already
     * has.
     *
     * Rows written by every previous release left incoming messages at
     * `Accepted`, so `unreadIncoming` matched the whole conversation and
     * `flushReads` replayed it as read receipts on every connect — the burst
     * that ends in a `rate_limited` close. The code fix only covers receipts
     * sent from now on, so without this the first reconnect after the update
     * repeats the old storm once, in full, from a database that still holds
     * every unread row ever written. What it advances is exactly what the device
     * already knows it read: incoming, non-system rows at or before the
     * conversation's own watermark.
     */
    @Test
    fun `migration 2 to 3 settles the incoming backlog against the read watermark`() {
        val v2 = helper.createDatabase(TEST_DB, 2)
        v2.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, official) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 2000, 2, 1500, 0, 1, NULL, 1, 2000, 0)",
        )
        // Ids and the five states that matter: before the watermark, exactly at
        // it, after it, already read, our own, and a system note.
        insertMessage(v2, id = "before", ts = 1000, mine = 0, system = 0, delivery = 2)
        insertMessage(v2, id = "at", ts = 1500, mine = 0, system = 0, delivery = 2)
        insertMessage(v2, id = "after", ts = 2000, mine = 0, system = 0, delivery = 2)
        insertMessage(v2, id = "already-read", ts = 1000, mine = 0, system = 0, delivery = 4)
        insertMessage(v2, id = "ours", ts = 1000, mine = 1, system = 0, delivery = 2)
        insertMessage(v2, id = "system", ts = 1000, mine = 0, system = 1, delivery = 2)
        v2.close()

        val v3 = helper.runMigrationsAndValidate(TEST_DB, 3, true, TailchatDatabase.MIGRATION_2_3)

        assertEquals("an incoming row the device has read is settled", 4, deliveryOf(v3, "before"))
        assertEquals("the watermark itself is inclusive", 4, deliveryOf(v3, "at"))
        assertEquals("a row past the watermark is still owed a receipt", 2, deliveryOf(v3, "after"))
        assertEquals(4, deliveryOf(v3, "already-read"))
        assertEquals("our own messages are not receipts", 2, deliveryOf(v3, "ours"))
        assertEquals("a system note is not a receipt either", 2, deliveryOf(v3, "system"))
        v3.close()
    }

    @Test
    fun `migration 3 to 4 preserves messages and adds durable notification delivery`() {
        val v3 = helper.createDatabase(TEST_DB, 3)
        insertMessage(v3, id = "m1", ts = 2_000, mine = 0, system = 0, delivery = 2)
        v3.close()

        val v4 = helper.runMigrationsAndValidate(TEST_DB, 4, true, TailchatDatabase.MIGRATION_3_4)
        assertEquals(2, deliveryOf(v4, "m1"))
        v4.execSQL(
            """INSERT INTO notification_deliveries
               (accountKey, peer, messageId, status, claimedAt, updatedAt)
               VALUES ('srv|alice', 'bob', 'm1', 0, 0, 1000)""",
        )
        v4.query(
            """SELECT status FROM notification_deliveries
               WHERE accountKey = 'srv|alice' AND peer = 'bob' AND messageId = 'm1'""",
        ).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(0, cursor.getInt(0))
        }
        v4.close()
    }

    @Test
    fun `migration 4 to 5 preserves conversations and defaults blocked to false`() {
        val v4 = helper.createDatabase(TEST_DB, 4)
        v4.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, official) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 3000, 1, 0, 0, 1, NULL, 1, 3000, 0)",
        )
        v4.close()

        val v5 = helper.runMigrationsAndValidate(TEST_DB, 5, true, TailchatDatabase.MIGRATION_4_5)

        v5.query("SELECT peer, name, unread, blocked FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("bob", cursor.getString(0))
            assertEquals("Bob", cursor.getString(1))
            assertEquals(1, cursor.getInt(2))
            assertEquals("blocked must default to false for pre-existing rows", 0, cursor.getInt(3))
        }
        v5.close()
    }

    /**
     * §4.5: existing rows must survive with both new columns `NULL`
     * (nothing before this version ever logged a call), and a freshly
     * inserted call row must round-trip both.
     */
    @Test
    fun `migration 5 to 6 preserves messages and adds nullable call columns`() {
        val v5 = helper.createDatabase(TEST_DB, 5)
        insertMessage(v5, id = "m1", ts = 5_000, mine = 0, system = 0, delivery = 2)
        v5.close()

        val v6 = helper.runMigrationsAndValidate(TEST_DB, 6, true, TailchatDatabase.MIGRATION_5_6)

        v6.query("SELECT text, callOutcome, callDurationSec FROM messages WHERE accountKey = 'srv|alice' AND id = 'm1'")
            .use { cursor ->
                assertTrue("message row lost in migration", cursor.moveToFirst())
                assertEquals("m1", cursor.getString(0))
                assertTrue("callOutcome must default to NULL for a pre-existing row", cursor.isNull(1))
                assertTrue("callDurationSec must default to NULL for a pre-existing row", cursor.isNull(2))
            }

        v6.execSQL(
            "INSERT INTO messages (accountKey, peer, id, text, ts, author, mine, delivery, system, kind, " +
                "imageDataUrl, imageWidth, imageHeight, voiceDataUrl, voiceDurationSec, reactionsJson, replyJson, " +
                "forwardJson, editedAt, deletedAt, serverSeq, callOutcome, callDurationSec) " +
                "VALUES ('srv|alice', 'bob', 'call-c1', '', 6000, 'bob', 0, 2, 0, 'call', " +
                "NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'missed', 0)",
        )
        v6.query("SELECT callOutcome, callDurationSec FROM messages WHERE accountKey = 'srv|alice' AND id = 'call-c1'")
            .use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("missed", cursor.getString(0))
                assertEquals(0, cursor.getInt(1))
            }
        v6.close()
    }

    /**
     * The account feed names messages by id and never carries their content, so
     * a device that hears about a message it does not hold owes a fetch —
     * `backfillJson` is the durable record of that debt (`MIGRATION_7_8`).
     *
     * Two things have to be true of the upgrade. `NULL` is the correct starting
     * state for every existing row: a device that has never run the feed owes
     * nothing it did not record, and the feed itself re-names anything genuinely
     * missing on the next sync from its cursor. And the rows that must never be
     * touched — the unsent queue, the transcripts, both read watermarks — come
     * through untouched, because dropping the queue on an upgrade is the one
     * failure this whole schema exists to prevent.
     */
    @Test
    fun `migration 7 to 8 preserves the queue and watermarks and starts with no backfill`() {
        val v7 = helper.createDatabase(TEST_DB, 7)
        v7.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, " +
                "official, blocked) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 4000, 1, 700, 900, 1, NULL, 1, 4000, 0, 0)",
        )
        insertMessage(v7, id = "m1", ts = 4_000, mine = 1, system = 0, delivery = 2)
        v7.execSQL(
            """INSERT INTO pending_ops (opId, accountKey, peer, kind, messageId, payloadJson, attempts,
               nextAttemptAt, lastError, errorKind, leaseOwner, leaseUntil, createdAt)
               VALUES ('op-1', 'srv|alice', 'bob', 'message', 'm1', '{}', 0, 0, NULL, 0, NULL, 0, 1000)""",
        )
        v7.close()

        val v8 = helper.runMigrationsAndValidate(TEST_DB, 8, true, TailchatDatabase.MIGRATION_7_8)

        v8.query(
            "SELECT peer, unread, readWatermarkTs, peerReadTs, historySeeded, backfillJson FROM conversations " +
                "WHERE accountKey = 'srv|alice'",
        ).use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("bob", cursor.getString(0))
            assertEquals(1, cursor.getInt(1))
            assertEquals("this account's read watermark has to survive", 700L, cursor.getLong(2))
            assertEquals("the peer's read watermark has to survive", 900L, cursor.getLong(3))
            assertEquals(1, cursor.getInt(4))
            assertTrue("a conversation must not start owing a fetch nobody recorded", cursor.isNull(5))
        }
        v8.query("SELECT opId, messageId FROM pending_ops WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue("the unsent queue must survive the upgrade", cursor.moveToFirst())
            assertEquals("op-1", cursor.getString(0))
            assertEquals("m1", cursor.getString(1))
        }
        assertEquals(2, deliveryOf(v8, "m1"))
        // The column is writable, and reads back what was written: the pump's
        // whole contract depends on the debt round-tripping through SQLite.
        v8.execSQL("UPDATE conversations SET backfillJson = '[\"m-gap\"]' WHERE accountKey = 'srv|alice'")
        v8.query("SELECT backfillJson FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("[\"m-gap\"]", cursor.getString(0))
        }
        v8.close()
    }

    /**
     * The contact nickname (`alias`, the server roster's own field) gets a local
     * home on the conversation row so the roster shows it before the next
     * envelope arrives (issue #28).
     *
     * `NULL` is every existing row's correct starting state: a device that has
     * never set a nickname has none, and the server re-sends the authoritative
     * value on the next roster — so nothing already stored is rewritten and the
     * rows that must never be touched (the queue, both read watermarks, the
     * backfill debt) come through untouched.
     */
    @Test
    fun `migration 8 to 9 preserves the queue and watermarks and starts with no nickname`() {
        val v8 = helper.createDatabase(TEST_DB, 8)
        v8.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, " +
                "official, blocked, backfillJson) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 4000, 1, 700, 900, 1, NULL, 1, 4000, 0, 0, '[\"m-gap\"]')",
        )
        insertMessage(v8, id = "m1", ts = 4_000, mine = 1, system = 0, delivery = 2)
        v8.execSQL(
            """INSERT INTO pending_ops (opId, accountKey, peer, kind, messageId, payloadJson, attempts,
               nextAttemptAt, lastError, errorKind, leaseOwner, leaseUntil, createdAt)
               VALUES ('op-1', 'srv|alice', 'bob', 'message', 'm1', '{}', 0, 0, NULL, 0, NULL, 0, 1000)""",
        )
        v8.close()

        val v9 = helper.runMigrationsAndValidate(TEST_DB, 9, true, TailchatDatabase.MIGRATION_8_9)

        v9.query(
            "SELECT peer, alias, unread, readWatermarkTs, peerReadTs, backfillJson FROM conversations " +
                "WHERE accountKey = 'srv|alice'",
        ).use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("bob", cursor.getString(0))
            assertTrue("a conversation must start with no nickname", cursor.isNull(1))
            assertEquals(1, cursor.getInt(2))
            assertEquals("this account's read watermark has to survive", 700L, cursor.getLong(3))
            assertEquals("the peer's read watermark has to survive", 900L, cursor.getLong(4))
            assertEquals("the backfill debt has to survive", "[\"m-gap\"]", cursor.getString(5))
        }
        v9.query("SELECT opId FROM pending_ops WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue("the unsent queue must survive the upgrade", cursor.moveToFirst())
            assertEquals("op-1", cursor.getString(0))
        }
        assertEquals(2, deliveryOf(v9, "m1"))
        // The column is writable and reads back what was written.
        v9.execSQL("UPDATE conversations SET alias = 'Аня с работы' WHERE accountKey = 'srv|alice'")
        v9.query("SELECT alias FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("Аня с работы", cursor.getString(0))
        }
        v9.close()
    }

    @Test
    fun `migration 9 to 10 keeps the roster and starts with nobody a bot`() {
        val v9 = helper.createDatabase(TEST_DB, 9)
        v9.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, " +
                "official, blocked, alias, backfillJson) " +
                "VALUES ('srv|alice', 'reminder', 'reminder', 0, 'reminder', 'ping', NULL, 4000, 1, 700, 0, 1, " +
                "NULL, 1, 4000, 0, 0, NULL, NULL)",
        )
        insertMessage(v9, id = "m1", ts = 4_000, mine = 1, system = 0, delivery = 2)
        v9.close()

        val v10 = helper.runMigrationsAndValidate(TEST_DB, 10, true, TailchatDatabase.MIGRATION_9_10)

        v10.query("SELECT peer, bot, online, unread FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("reminder", cursor.getString(0))
            assertEquals("a device that never heard the flag must not call anybody a bot", 0, cursor.getInt(1))
            assertEquals("presence is the envelope's business, not the migration's", 1, cursor.getInt(2))
            assertEquals(1, cursor.getInt(3))
        }
        assertEquals(2, deliveryOf(v10, "m1"))
        // The column is writable and reads back what was written.
        v10.execSQL("UPDATE conversations SET bot = 1 WHERE accountKey = 'srv|alice'")
        v10.query("SELECT bot FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(1, cursor.getInt(0))
        }
        v10.close()
    }

    /**
     * The message menu's «Прочитано: 14:44 · телефон» line needs *when* the peer
     * read a conversation and *which client* did it, neither of which
     * `peerReadTs` alone holds. Both columns start empty, which is the truth
     * for every row a device already has — a snapshot written before the server
     * tracked read times knows the watermark but neither the moment nor the
     * client — and the menu renders that as the time alone, never a guess. The
     * rows that must never be touched (the queue, both watermarks) come through
     * untouched, as always.
     */
    @Test
    fun `migration 10 to 11 keeps the watermarks and starts with an unknown read time and client`() {
        val v10 = helper.createDatabase(TEST_DB, 10)
        v10.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, " +
                "official, blocked, alias, backfillJson, bot) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 4000, 1, 700, 900, 1, NULL, 1, 4000, " +
                "0, 0, NULL, NULL, 0)",
        )
        insertMessage(v10, id = "m1", ts = 4_000, mine = 1, system = 0, delivery = 2)
        v10.close()

        val v11 = helper.runMigrationsAndValidate(TEST_DB, 11, true, TailchatDatabase.MIGRATION_10_11)

        v11.query(
            "SELECT peer, readWatermarkTs, peerReadTs, peerReadAt, peerReadVia FROM conversations " +
                "WHERE accountKey = 'srv|alice'",
        ).use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("bob", cursor.getString(0))
            assertEquals("this account's read watermark has to survive", 700L, cursor.getLong(1))
            assertEquals("the peer's read watermark has to survive", 900L, cursor.getLong(2))
            assertEquals("a device that never heard when cannot invent a moment", 0L, cursor.getLong(3))
            assertEquals("nor a client", "", cursor.getString(4))
        }
        assertEquals(2, deliveryOf(v11, "m1"))
        // Both columns are writable and read back what was written.
        v11.execSQL("UPDATE conversations SET peerReadAt = 9000, peerReadVia = 'android/450' WHERE accountKey = 'srv|alice'")
        v11.query("SELECT peerReadAt, peerReadVia FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(9000L, cursor.getLong(0))
            assertEquals("android/450", cursor.getString(1))
        }
        v11.close()
    }

    /**
     * The ladder gained its missing rung: between "the server took it" and "the
     * peer read it" there was nothing, so a message the peer's phone plainly had
     * still drew as one ✓. `peerDeliveredTs` is that rung, and it starts at `0`
     * for every row a device already has — the truth, since a snapshot written
     * before the server tracked delivery knows nothing about it. The rows that
     * must never be touched (the queue, the read watermark, the read time and
     * client) come through untouched, as always, and the read watermark still
     * outranks the delivered one wherever the two are compared.
     */
    @Test
    fun `migration 11 to 12 keeps the read facts and starts with nothing known delivered`() {
        val v11 = helper.createDatabase(TEST_DB, 11)
        v11.execSQL(
            "INSERT INTO conversations (accountKey, peer, name, self, previewFrom, previewText, previewMedia, " +
                "previewTs, unread, readWatermarkTs, peerReadTs, online, lastSeen, historySeeded, updatedAt, " +
                "official, blocked, alias, backfillJson, bot, peerReadAt, peerReadVia) " +
                "VALUES ('srv|alice', 'bob', 'Bob', 0, 'bob', 'hi', NULL, 4000, 1, 700, 900, 1, NULL, 1, 4000, " +
                "0, 0, NULL, NULL, 0, 9000, 'android/450')",
        )
        insertMessage(v11, id = "m1", ts = 4_000, mine = 1, system = 0, delivery = 2)
        v11.close()

        val v12 = helper.runMigrationsAndValidate(TEST_DB, 12, true, TailchatDatabase.MIGRATION_11_12)

        v12.query(
            "SELECT peer, readWatermarkTs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs FROM conversations " +
                "WHERE accountKey = 'srv|alice'",
        ).use { cursor ->
            assertTrue("conversation row lost in migration", cursor.moveToFirst())
            assertEquals("bob", cursor.getString(0))
            assertEquals("this account's read watermark has to survive", 700L, cursor.getLong(1))
            assertEquals("the peer's read watermark has to survive", 900L, cursor.getLong(2))
            assertEquals("so does when it was reached", 9000L, cursor.getLong(3))
            assertEquals("and by which client", "android/450", cursor.getString(4))
            assertEquals(
                "a device that never heard a delivery cannot invent one",
                0L,
                cursor.getLong(5),
            )
        }
        assertEquals("the queue's acceptance is not touched", 2, deliveryOf(v12, "m1"))
        // The new column is writable and reads back what was written.
        v12.execSQL("UPDATE conversations SET peerDeliveredTs = 8000 WHERE accountKey = 'srv|alice'")
        v12.query("SELECT peerDeliveredTs FROM conversations WHERE accountKey = 'srv|alice'").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(8000L, cursor.getLong(0))
        }
        v12.close()
    }

    private fun insertMessage(
        db: androidx.sqlite.db.SupportSQLiteDatabase,
        id: String,
        ts: Long,
        mine: Int,
        system: Int,
        delivery: Int,
    ) {
        db.execSQL(
            "INSERT INTO messages (accountKey, peer, id, text, ts, author, mine, delivery, system, kind, " +
                "imageDataUrl, imageWidth, imageHeight, voiceDataUrl, voiceDurationSec, reactionsJson, replyJson, " +
                "forwardJson, editedAt, deletedAt, serverSeq) " +
                "VALUES ('srv|alice', 'bob', '$id', '$id', $ts, 'bob', $mine, $delivery, $system, 'msg', " +
                "NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
        )
    }

    private fun deliveryOf(db: androidx.sqlite.db.SupportSQLiteDatabase, id: String): Int =
        db.query("SELECT delivery FROM messages WHERE accountKey = 'srv|alice' AND id = ?", arrayOf(id)).use { cursor ->
            assertTrue("row $id lost in migration", cursor.moveToFirst())
            cursor.getInt(0)
        }

    private companion object {
        const val TEST_DB = "migration-test"
    }
}
