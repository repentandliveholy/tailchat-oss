package net.tailchat.android.data

import android.database.sqlite.SQLiteDatabase as PlatformDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import net.zetetic.database.sqlcipher.SQLiteDatabaseHook
import net.zetetic.database.sqlcipher.SQLiteConnection
import net.zetetic.database.sqlcipher.SQLiteDatabase as CipherDatabase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * The database half of the storage migration, run where it actually runs: a phone,
 * against the real SQLCipher native library.
 *
 * Robolectric cannot cover this. It builds Room with `FrameworkSQLiteOpenHelperFactory`
 * and never loads `libsqlcipher.so`, so the entire unit suite exercised a different
 * implementation than the one shipped — which is how a migration whose `ATTACH` cannot
 * create its target file reached a release build with 339 green tests. Inserting a row
 * and leaving it in the write-ahead log is the point of the first case: the unsent
 * queue lives there, and a migration that only copies the main file silently drops it.
 *
 * Run it on an emulator. `connectedReleaseAndroidTest` installs over and then removes
 * the package under test, which takes the app's data directory with it — on a real
 * phone that is somebody's chat history, not a fixture. Pin the target when more than
 * one device is attached: `ANDROID_SERIAL=emulator-5554 ./gradlew …`.
 */
@RunWith(AndroidJUnit4::class)
class DeviceMigrationOnDeviceTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    // A key of the test's own rather than `DeviceDataKey.forMigration`: this case is
    // about the SQLCipher hand-off, and it must not touch the real app's key or data.
    private val key: SecretKey = SecretKeySpec(ByteArray(32) { (it * 7 + 3).toByte() }, "AES")
    private val passphrase = DeviceMigration.passphrase(key)

    private fun scratch(name: String): File =
        File(context.getDatabasePath("probe-$name").parentFile, "probe-$name")

    private fun deleteWithSiblings(base: File) {
        base.delete()
        File(base.path + "-wal").delete()
        File(base.path + "-shm").delete()
    }

    /**
     * Opens the way production does: the bytes of the hex passphrase handed to
     * `SupportOpenHelperFactory`, which is exactly what `TailchatDatabase.get` gives
     * Room. A migration that writes the database under a different key derivation
     * would pass a string-keyed read-back and still fail here — that is the mismatch
     * this assertion exists to catch.
     */
    private fun <T> withProductionConnection(path: String, body: (SupportSQLiteDatabase) -> T): T {
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(path)
            .callback(object : SupportSQLiteOpenHelper.Callback(1) {
                override fun onCreate(db: SupportSQLiteDatabase) = Unit
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val helper = SupportOpenHelperFactory(passphrase.toByteArray(StandardCharsets.UTF_8)).create(configuration)
        return try {
            body(helper.writableDatabase)
        } finally {
            helper.close()
        }
    }

    private fun countRows(db: SupportSQLiteDatabase, table: String): Long =
        db.query("SELECT count(*) FROM \"$table\"").use { cursor ->
            cursor.moveToFirst()
            cursor.getLong(0)
        }

    @Test
    fun migrationCarriesTheUnsentQueueOutOfTheWriteAheadLog() {
        System.loadLibrary("sqlcipher")
        val source = scratch("mig-src.db")
        val stage = scratch("mig-enc.db.migrating")
        val target = scratch("mig-enc.db")
        listOf(source, stage, target).forEach(::deleteWithSiblings)

        // Held open on purpose: closing would checkpoint the WAL away, and a row that
        // only ever reached the -wal is exactly what "unsent queue survives" means.
        val origin = PlatformDatabase.openOrCreateDatabase(source, null)
        try {
            // `execSQL` refuses a statement that returns rows, and this PRAGMA answers
            // with the mode it settled on.
            origin.rawQuery("PRAGMA journal_mode=WAL", null).use { it.moveToFirst() }
            origin.execSQL("CREATE TABLE pending_operations(opId TEXT PRIMARY KEY, payloadJson TEXT)")
            origin.execSQL("CREATE TABLE messages(id TEXT PRIMARY KEY, text TEXT)")
            origin.execSQL("INSERT INTO pending_operations VALUES ('send:queued-1', '{\"text\":\"not sent yet\"}')")
            origin.execSQL("INSERT INTO messages VALUES ('m1', 'older message')")
            val wal = File(source.path + "-wal")
            assertTrue("the fixture must leave rows in the WAL", wal.isFile && wal.length() > 0)
            assertFalse("no encrypted copy exists before the migration", target.exists())

            DeviceMigration.migrateDatabase(source, stage, target, key)

            assertTrue("the encrypted database was published", target.isFile)
            assertFalse("the staging file is consumed by the rename", stage.exists())
        } finally {
            origin.close()
        }

        withProductionConnection(target.path) { db ->
            assertEquals("the queued operation survived", 1L, countRows(db, "pending_operations"))
            assertEquals("the message survived", 1L, countRows(db, "messages"))
            db.query("SELECT payloadJson FROM pending_operations").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("{\"text\":\"not sent yet\"}", cursor.getString(0))
            }
        }

        // The published file must not be readable as a plaintext SQLite database.
        val header = target.inputStream().use { it.readNBytes(16) }
        assertFalse(
            "the published database still has a plaintext SQLite header",
            String(header, StandardCharsets.ISO_8859_1).startsWith("SQLite format 3"),
        )
    }

    @Test
    fun aSecondRunLeavesThePublishedDatabaseAlone() {
        System.loadLibrary("sqlcipher")
        val source = scratch("mig2-src.db")
        val stage = scratch("mig2-enc.db.migrating")
        val target = scratch("mig2-enc.db")
        listOf(source, stage, target).forEach(::deleteWithSiblings)

        val origin = PlatformDatabase.openOrCreateDatabase(source, null)
        try {
            origin.execSQL("CREATE TABLE messages(id TEXT PRIMARY KEY, text TEXT)")
            origin.execSQL("INSERT INTO messages VALUES ('m1', 'first')")
            origin.close()
            DeviceMigration.migrateDatabase(source, stage, target, key)
        } finally {
            runCatching { origin.close() }
        }

        val published = target.readBytes()
        // A re-run — the retry an operator presses after a partial failure — must not
        // rewrite what already landed, and must not need the source any more.
        DeviceMigration.migrateDatabase(source, stage, target, key)
        assertTrue("a second run left the published database untouched", published.contentEquals(target.readBytes()))
        assertEquals(1L, withProductionConnection(target.path) { countRows(it, "messages") })
    }

    @Test
    fun roomOpensTheMigratedCopyWithItsSchemaAndRows() {
        System.loadLibrary("sqlcipher")
        val legacyName = "probe-room-legacy.db"
        val targetName = "probe-room-enc.db"
        val legacy = context.getDatabasePath(legacyName)
        val stage = context.getDatabasePath("$targetName.migrating")
        val target = context.getDatabasePath(targetName)
        listOf(legacy, stage, target).forEach(::deleteWithSiblings)

        // A genuine Room v8 database at the legacy path: Room itself writes the schema
        // and its identity hash, which is what the copy has to reproduce for the
        // encrypted database to be accepted later.
        val plain = Room.databaseBuilder(context, TailchatDatabase::class.java, legacyName).build()
        try {
            runBlocking {
                plain.conversations().upsert(conversation())
                plain.messages().upsert(message())
                plain.pendingOps().insert(pendingOperation())
            }
        } finally {
            plain.close()
        }

        DeviceMigration.migrateDatabase(legacy, stage, target, key)

        // Opened exactly as `TailchatDatabase.get` opens it: Room's own integrity check
        // on the schema hash runs here, so a copy that dropped `room_master_table`
        // fails at this line instead of on a user's phone.
        val migrated = Room.databaseBuilder(context, TailchatDatabase::class.java, targetName)
            .openHelperFactory(SupportOpenHelperFactory(passphrase.toByteArray(StandardCharsets.UTF_8)))
            .build()
        try {
            runBlocking {
                assertEquals("conversation survived", 1, migrated.conversations().all(ACCOUNT).size)
                assertEquals(
                    "unsent operation survived into Room's view",
                    "{\"text\":\"queued before encryption\"}",
                    migrated.pendingOps().find("seed-op-1")?.payloadJson,
                )
                assertEquals(
                    "message survived",
                    1,
                    migrated.messages().count(ACCOUNT, PEER, "seed-message-1"),
                )
            }
        } finally {
            migrated.close()
        }
    }

    private fun conversation() = ConversationEntity(
        accountKey = ACCOUNT, peer = PEER, name = "Roman", self = false,
        previewFrom = PEER, previewText = "seed preview", previewMedia = null,
        previewTs = 1_700_000_000_000, unread = 1, readWatermarkTs = 0, peerReadTs = 0,
        online = false, lastSeen = 1_700_000_000_000, historySeeded = true,
        updatedAt = 1_700_000_000_000,
    )

    private fun message() = MessageEntity(
        accountKey = ACCOUNT, peer = PEER, id = "seed-message-1", text = "seeded history row",
        ts = 1_700_000_000_000, author = PEER, mine = false, delivery = 2,
        system = false, kind = "msg", imageDataUrl = null, imageWidth = null,
        imageHeight = null, voiceDataUrl = null, voiceDurationSec = null,
        reactionsJson = null, replyJson = null, forwardJson = null,
        editedAt = null, deletedAt = null, serverSeq = null,
    )

    private fun pendingOperation() = PendingOperationEntity(
        opId = "seed-op-1", accountKey = ACCOUNT, peer = PEER, kind = "send",
        messageId = "seed-unsent-1", payloadJson = "{\"text\":\"queued before encryption\"}",
        attempts = 0, nextAttemptAt = 0, lastError = null, errorKind = 0,
        leaseOwner = null, leaseUntil = 0, createdAt = 1_700_000_000_000,
    )

    /**
     * The "start fresh" escape has to actually clear the state, or it is a button that
     * returns the person to the same dead-end screen. `needed()` is the exact predicate
     * the gate is built on, so it is what this asserts — plus that the unusable key is
     * gone, since a Keystore alias that keeps failing would otherwise keep failing.
     */
    @Test
    fun discardClearsEveryLocalArtifactSoTheAppCanStartOver() {
        System.loadLibrary("sqlcipher")
        val legacyName = "probe-discard.db"
        val legacy = context.getDatabasePath(legacyName)
        val encrypted = context.getDatabasePath("${TailchatDatabase.ENCRYPTED_NAME}")
        deleteWithSiblings(legacy)
        deleteWithSiblings(encrypted)
        val mediaDir = File(context.filesDir, "media-cache").apply { mkdirs() }
        File(mediaDir, "old-photo.jpg").writeBytes(byteArrayOf(1, 2, 3))
        File(context.filesDir, "transcript.ndjson").writeText("[00:00] a: legacy\n")
        assertTrue("the fixture must look like an install that needs migration", DeviceMigration.needed(context))

        DeviceMigration.discard(context)

        val encryptedExists = encrypted.exists() || File(encrypted.path + "-wal").exists()
        assertFalse("the encrypted database is gone", encryptedExists)
        assertFalse("the plaintext database is gone", legacy.exists())
        assertFalse("the plaintext media is gone", File(mediaDir, "old-photo.jpg").exists())
        assertFalse("the plaintext transcript is gone", File(context.filesDir, "transcript.ndjson").exists())
        assertFalse("the wrapped key is gone", DeviceDataKey.hasWrappedKey(context))
        assertFalse(
            "nothing is left that asks for a migration",
            DeviceMigration.needed(context),
        )
    }

    @Test
    fun fastKeyRekeyAllowsRoomToOpenWithFastHook() {
        System.loadLibrary("sqlcipher")
        val targetName = "probe-fastkey.db"
        val target = context.getDatabasePath(targetName)
        deleteWithSiblings(target)

        // 1. Create a genuine 256k-iteration encrypted DB
        val plain = Room.databaseBuilder(context, TailchatDatabase::class.java, "probe-fastkey-plain.db").build()
        try {
            runBlocking {
                plain.conversations().upsert(conversation())
                plain.messages().upsert(message())
            }
        } finally {
            plain.close()
        }
        val plainFile = context.getDatabasePath("probe-fastkey-plain.db")
        val stage = context.getDatabasePath("$targetName.migrating")
        deleteWithSiblings(stage)

        // Explicitly create target under legacy 256k iterations
        val passBytes = passphrase.toByteArray(StandardCharsets.UTF_8)
        CipherDatabase.openOrCreateDatabase(stage.path, passBytes, null, null, DeviceMigration.legacyHook).close()
        val cipher = CipherDatabase.openDatabase(plainFile.path, null, CipherDatabase.OPEN_READWRITE)
        try {
            cipher.rawQuery("PRAGMA cipher_default_kdf_iter = 256000", null).use { it.moveToFirst() }
            val stageSql = stage.path.replace("'", "''")
            val passphraseSql = passphrase.replace("'", "''")
            cipher.execSQL("ATTACH DATABASE '$stageSql' AS encrypted KEY '$passphraseSql'")
            try {
                cipher.rawQuery("SELECT sqlcipher_export('encrypted')", null).use { it.moveToFirst() }
                cipher.rawQuery("PRAGMA user_version", null).use {
                    if (it.moveToFirst()) cipher.execSQL("PRAGMA encrypted.user_version = ${it.getInt(0)}")
                }
            } finally {
                cipher.execSQL("DETACH DATABASE encrypted")
            }
        } finally {
            cipher.close()
        }
        Files.move(stage.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        deleteWithSiblings(plainFile)

        // 2. PROVE it is genuinely a 256k database:
        // (a) Fast hook (kdf_iter = 1) MUST FAIL to open it
        val failedFast = runCatching {
            CipherDatabase.openDatabase(target.path, passBytes, null, CipherDatabase.OPEN_READONLY, DeviceMigration.fastHook).use {
                it.rawQuery("SELECT count(*) FROM sqlite_schema", null).use { c -> c.moveToFirst() }
            }
        }.isFailure
        assertTrue("target MUST fail to open with fastHook before ensureFastKey", failedFast)

        // (b) Legacy hook (256k) MUST SUCCEED to open it
        val openedLegacy = runCatching {
            CipherDatabase.openDatabase(target.path, passBytes, null, CipherDatabase.OPEN_READONLY, DeviceMigration.legacyHook).use {
                it.rawQuery("SELECT count(*) FROM sqlite_schema", null).use { c -> c.moveToFirst() }
            }
        }.isSuccess
        assertTrue("target MUST open with legacyHook before ensureFastKey", openedLegacy)

        // 3. NOW run ensureFastKey: this forces it down the export/swap migration branch!
        assertTrue("ensureFastKey must succeed migrating 256k DB", DeviceMigration.ensureFastKey(context, key, targetName))

        // 4. PROVE it is now a 1-iteration fast database:
        val openedFast = runCatching {
            CipherDatabase.openDatabase(target.path, passBytes, null, CipherDatabase.OPEN_READONLY, DeviceMigration.fastHook).use {
                it.rawQuery("SELECT count(*) FROM sqlite_schema", null).use { c -> c.moveToFirst() }
            }
        }.isSuccess
        assertTrue("target MUST open with fastHook after ensureFastKey", openedFast)

        // 5. Open target in Room using SupportOpenHelperFactory with fastHook
        val roomFast = Room.databaseBuilder(context, TailchatDatabase::class.java, targetName)
            .openHelperFactory(SupportOpenHelperFactory(passBytes, DeviceMigration.fastHook, false))
            .build()
        try {
            runBlocking {
                assertEquals("conversation survived rekey", 1, roomFast.conversations().all(ACCOUNT).size)
                assertEquals("message survived rekey", 1, roomFast.messages().count(ACCOUNT, PEER, "seed-message-1"))
            }
        } finally {
            roomFast.close()
        }

        // 6. Verify second ensureFastKey call is fast and returns true (idempotent path)
        assertTrue("second ensureFastKey call is idempotent", DeviceMigration.ensureFastKey(context, key, targetName))
        deleteWithSiblings(target)
    }

    @Test
    fun cleanupPlaintextRemovesVerifiedPlaintextFiles() {
        System.loadLibrary("sqlcipher")
        val encrypted = context.getDatabasePath(TailchatDatabase.ENCRYPTED_NAME)
        encrypted.parentFile?.mkdirs()
        encrypted.writeBytes(byteArrayOf(1, 2, 3))

        val source = context.getDatabasePath(TailchatDatabase.NAME)
        source.writeBytes(byteArrayOf(4, 5, 6))

        val oldMedia = File(context.filesDir, "media-cache").apply { mkdirs() }
        val secureMedia = MediaCache.rootDir(context.filesDir).apply { mkdirs() }
        val oldFile = File(oldMedia, "photo.jpg").apply { writeBytes(byteArrayOf(7, 8, 9)) }
        val encFile = File(secureMedia, "photo.jpg").apply { writeBytes(byteArrayOf(7, 8, 9)) }

        val oldTranscript = File(context.filesDir, "transcript.ndjson").apply { writeText("plaintext\n") }
        val encTranscript = File(context.filesDir, "transcript.ndjson.enc").apply { writeBytes(byteArrayOf(10, 11)) }

        DeviceMigration.cleanupPlaintext(context)

        assertFalse("source db must be removed", source.exists())
        assertFalse("old media file must be removed", oldFile.exists())
        assertFalse("old media dir must be removed", oldMedia.exists())
        assertFalse("old transcript must be removed", oldTranscript.exists())
        assertTrue("encrypted transcript must remain", encTranscript.exists())
        assertTrue("secure media must remain", encFile.exists())

        deleteWithSiblings(encrypted)
        encFile.delete()
        secureMedia.delete()
        encTranscript.delete()
    }

    private companion object {
        const val TAG = "TCMIGRATE"
        const val ACCOUNT = "https://repentandliveholy.org|seedowner"
        const val PEER = "seedpeer"
    }
}
