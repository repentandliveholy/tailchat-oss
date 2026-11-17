package net.tailchat.android.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import java.io.File
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

/**
 * Everything this device knows, so that a conversation is a local fact and the
 * network is only how it gets updated.
 *
 * `exportSchema = true`: schema JSON lands under `app/schemas/<version>.json`
 * via the `room.schemaLocation` KSP argument in `app/build.gradle.kts`. A
 * version bump MUST add a hand-written [androidx.room.migration.Migration]
 * object plus a `MigrationTestHelper` test that opens the exported v(n-1)
 * schema and asserts `migrate()` reads its rows back — see
 * `TailchatDatabaseMigrationTest` for the harness.
 *
 * There is deliberately no `fallbackToDestructiveMigration()`. Dropping the
 * tables on an unhandled upgrade would throw away the unsent queue, which is
 * the single failure this whole rearchitecture exists to remove; a crash on a
 * missing migration is a bug the developer sees, silent data loss is a bug the
 * user discovers.
 */
@Database(
    entities = [
        AccountEntity::class,
        ConversationEntity::class,
        MessageEntity::class,
        PendingOperationEntity::class,
        DraftEntity::class,
        SyncCheckpointEntity::class,
        NotificationDeliveryEntity::class,
    ],
    version = 12,
    exportSchema = true,
)
abstract class TailchatDatabase : RoomDatabase() {
    abstract fun accounts(): AccountDao

    abstract fun conversations(): ConversationDao

    abstract fun messages(): MessageDao

    abstract fun pendingOps(): PendingOperationDao

    abstract fun drafts(): DraftDao

    abstract fun syncState(): SyncStateDao

    abstract fun notificationDeliveries(): NotificationDeliveryDao

    companion object {
        const val NAME = "tailchat.db"
        const val ENCRYPTED_NAME = "tailchat-encrypted.db"

        @Volatile
        private var instance: TailchatDatabase? = null

        private fun isRobolectric(): Boolean = runCatching {
            Class.forName("org.robolectric.RuntimeEnvironment")
        }.isSuccess

        fun get(context: Context): TailchatDatabase =
            instance ?: synchronized(this) {
                instance ?: run {
                    val app = context.applicationContext
                    if (!isRobolectric()) {
                        if (DeviceMigration.needed(app)) throw MigrationRequiredException()
                        System.loadLibrary("sqlcipher")
                        val key = DeviceDataKey.get(app)
                        Thread({ DeviceMigration.cleanupPlaintext(app) }, "TailchatPlaintextCleanup").start()
                        val hook = if (DeviceMigration.ensureFastKey(app, key)) DeviceMigration.fastHook else DeviceMigration.legacyHook
                        Room.databaseBuilder(app, TailchatDatabase::class.java, ENCRYPTED_NAME)
                            .openHelperFactory(SupportOpenHelperFactory(DeviceMigration.passphrase(key).toByteArray(Charsets.UTF_8), hook, false))
                            .addMigrations(
                                MIGRATION_1_2,
                                MIGRATION_2_3,
                                MIGRATION_3_4,
                                MIGRATION_4_5,
                                MIGRATION_5_6,
                                MIGRATION_6_7,
                                MIGRATION_7_8,
                                MIGRATION_8_9,
                                MIGRATION_9_10,
                                MIGRATION_10_11,
                                MIGRATION_11_12,
                            )
                            .build().also { instance = it }
                    } else {
                        Room.databaseBuilder(app, TailchatDatabase::class.java, ENCRYPTED_NAME)
                            .addMigrations(
                                MIGRATION_1_2,
                                MIGRATION_2_3,
                                MIGRATION_3_4,
                                MIGRATION_4_5,
                                MIGRATION_5_6,
                                MIGRATION_6_7,
                                MIGRATION_7_8,
                                MIGRATION_8_9,
                                MIGRATION_9_10,
                                MIGRATION_10_11,
                                MIGRATION_11_12,
                            )
                            .build().also { instance = it }
                    }
                }
            }

        fun hasExistingData(context: Context): Boolean =
            listOf(NAME, ENCRYPTED_NAME, "$ENCRYPTED_NAME.migrating").any { name ->
                val base = context.getDatabasePath(name)
                listOf(base, File(base.path + "-wal"), File(base.path + "-shm")).any(File::exists)
            }

        /** Test-only: `get()` caches one instance for the process, which
         *  would otherwise leak a closed/stale database across Robolectric
         *  test methods that each get a fresh sandboxed context. Never
         *  called from production code. */
        internal fun resetForTest() {
            synchronized(this) {
                instance?.close()
                instance = null
            }
        }

        /**
         * Official accounts (`official` in the server's roster entry, see
         * [net.tailchat.android.cloud.CloudUser.official]) need a place to
         * live locally so the roster row can style them without asking the
         * network again on every launch. `DEFAULT 0` matches every row this
         * device already has: nothing already stored can retroactively know
         * it was the deployment's own account.
         */
        val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN official INTEGER NOT NULL DEFAULT 0")
            }
        }

        /**
         * Incoming rows never left `Accepted`, so `MessageDao.unreadIncoming`
         * returned every message a conversation had ever received and
         * `flushReads` replayed all of them as read receipts on *every*
         * connect — a two-thousand message thread was a two-thousand frame
         * burst against a 60-frames/second 4429 close, on each reconnect.
         *
         * The code fix (`markIncomingRead`, called once a receipt has left the
         * socket) only applies to receipts sent from now on. Without this, the
         * first reconnect after the update repeats the old storm in full, once,
         * from a database that still holds every unread row ever written — so
         * the migration settles that backlog against what the device already
         * knows it read: every incoming row at or before its conversation's own
         * read watermark is marked read here.
         *
         * `mine = 0 AND system = 0` mirrors the query exactly, `delivery < 4`
         * keeps it monotonic (a row already at Read or beyond is left alone),
         * and `COALESCE(..., -1)` means a conversation with no row at all —
         * which cannot have a watermark — advances nothing rather than
         * everything.
         */
        val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """UPDATE messages SET delivery = 4
                       WHERE mine = 0 AND system = 0 AND delivery < 4
                         AND ts <= COALESCE((
                               SELECT c.readWatermarkTs FROM conversations c
                               WHERE c.accountKey = messages.accountKey AND c.peer = messages.peer
                             ), -1)""",
                )
            }
        }

        val MIGRATION_3_4 = object : androidx.room.migration.Migration(3, 4) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS notification_deliveries (
                       accountKey TEXT NOT NULL,
                       peer TEXT NOT NULL,
                       messageId TEXT NOT NULL,
                       status INTEGER NOT NULL,
                       claimedAt INTEGER NOT NULL,
                       updatedAt INTEGER NOT NULL,
                       PRIMARY KEY(accountKey, peer, messageId))""",
                )
                db.execSQL(
                    """CREATE INDEX IF NOT EXISTS index_notification_deliveries_accountKey_status
                       ON notification_deliveries(accountKey, status)""",
                )
            }
        }

        /**
         * Contact blocking (`blocked` in the server's roster entry, see
         * [net.tailchat.android.cloud.CloudUser.blocked]) needs the same local
         * home `official` already has, for the same reason: the roster row
         * has to show the blocked state on a cold start, before the next
         * roster envelope arrives. `DEFAULT 0` matches every row this device
         * already has: nothing already stored was ever blocked.
         */
        val MIGRATION_4_5 = object : androidx.room.migration.Migration(4, 5) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0")
            }
        }

        /**
         * A finished call becomes its own row in `messages`
         * (`kind = MessageKind.CALL`, see `ChatRepository.recordCall`) instead
         * of vanishing the moment `CallController` tears the call down.
         * Both columns are nullable and `NULL` by default: every row from
         * before this version, and every non-call row from now on, has
         * neither. Direction needs no column of its own — `mine` (already on
         * every row) already says whether this device placed the call.
         */
        val MIGRATION_5_6 = object : androidx.room.migration.Migration(5, 6) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN callOutcome TEXT")
                db.execSQL("ALTER TABLE messages ADD COLUMN callDurationSec INTEGER")
            }
        }
        val MIGRATION_6_7 = object : androidx.room.migration.Migration(6, 7) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN buttonsJson TEXT DEFAULT NULL")
            }
        }

        /**
         * The account feed names messages by id and never carries their
         * content, so a device that sees a `message` event for an id it does
         * not hold owes a backfill that survives a crash, a killed process or
         * a lost connection. `NULL` is every existing row's correct state: a
         * device that has never run the feed has no recorded debt, and the
         * feed itself re-names anything genuinely missing on the next sync from
         * its own cursor.
         *
         * Nothing is dropped or rewritten — the column is added empty, so the
         * unsent queue, the transcripts and both read watermarks come through
         * the upgrade untouched.
         */
        val MIGRATION_7_8 = object : androidx.room.migration.Migration(7, 8) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN backfillJson TEXT DEFAULT NULL")
            }
        }

        /**
         * This account's own nickname for a contact (issue #28) moves from a
         * `Settings` map to the server, and the conversation row keeps a local
         * copy so the roster shows it before the next envelope. `NULL` is every
         * existing row's correct starting state: a device that has never set a
         * nickname has none, and the server re-sends the authoritative value on
         * the next roster.
         */
        val MIGRATION_8_9 = object : androidx.room.migration.Migration(8, 9) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN alias TEXT DEFAULT NULL")
            }
        }

        /**
         * Bot accounts (`bot` in the server's roster entry): a program, not a
         * person. Same shape and same reasoning as `MIGRATION_4_5`'s `blocked` —
         * a column that starts `false`, which is the truth for every row a
         * device already has, and which the next roster envelope corrects for
         * the ones the server marks.
         */
        val MIGRATION_9_10 = object : androidx.room.migration.Migration(9, 10) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN bot INTEGER NOT NULL DEFAULT 0")
            }
        }

        /**
         * When the peer read this conversation, and from which client: the
         * message menu's «Прочитано: 14:44 · телефон» line needs both, and
         * neither can be recovered from `peerReadTs` alone — the receipt's
         * timestamp is the *message's*, and `MAX(peerReadTs)` cannot say who
         * moved it.
         *
         * Both start at their "unknown" values, which is the truth for every
         * row a device already has: a snapshot written before the server
         * tracked read times knows the watermark but not when it was reached
         * or by what. The menu renders that as the time alone (or no line at
         * all when even the time is absent), never as a guessed client, and
         * the next advance — or the next `/api/history` answer, which now
         * carries both — fills them in.
         */
        val MIGRATION_10_11 = object : androidx.room.migration.Migration(10, 11) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN peerReadAt INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE conversations ADD COLUMN peerReadVia TEXT NOT NULL DEFAULT ''")
            }
        }

        /**
         * How far the peer's *device* holds this conversation — the delivered
         * watermark the read watermark was always standing in for.
         *
         * `peerReadTs` said only that the peer had read up to a moment, and the
         * single ✓/✓✓ ladder had no rung between "the server took it" and "the
         * peer read it": a receipt that showed the peer's phone had the message
         * drew exactly like one that only showed the server did. This column is
         * that missing rung, advanced only forwards, and every row a device
         * already has starts at `0` — which is the truth for them, since a
         * snapshot written before the server tracked delivery knows nothing
         * about it. The read watermark still wins wherever the two are
         * compared: everything at or below `peerReadTs` is delivered by
         * definition, so a `0` here means "not known", never "not delivered".
         */
        val MIGRATION_11_12 = object : androidx.room.migration.Migration(11, 12) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE conversations ADD COLUMN peerDeliveredTs INTEGER NOT NULL DEFAULT 0")
            }
        }


        /**
         * Total bytes the local database occupies — what the settings sheet
         * offers to free. Room defaults to WAL, so the write-ahead log and
         * shared-memory siblings are real disk usage too, not just the main
         * file. [MediaCache] moved a message's image/voice out of this
         * database into its own files (see `MediaCache`, `ChatRepository`),
         * so a large conversation's real footprint is there now, not here —
         * this has to add it back in or the figure quietly stops meaning
         * "everything this screen's button clears".
         */
        fun storedBytes(context: Context): Long {
            val base = context.getDatabasePath(ENCRYPTED_NAME)
            val dbBytes = listOf(base, File(base.path + "-wal"), File(base.path + "-shm"))
                .sumOf { if (it.isFile) it.length() else 0L }
            return dbBytes + MediaCache.rootDir(context.filesDir).walkTopDown()
                .filter { it.isFile }.sumOf { it.length() }
        }
    }
}
