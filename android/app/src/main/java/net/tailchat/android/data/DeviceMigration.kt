package net.tailchat.android.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase as PlatformDatabase
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import javax.crypto.SecretKey
import net.zetetic.database.sqlcipher.SQLiteDatabase as CipherDatabase
import net.zetetic.database.sqlcipher.SQLiteConnection
import net.zetetic.database.sqlcipher.SQLiteDatabaseHook

class MigrationRequiredException : IOException("Local data must be encrypted before chat can start")

/** The original DB/WAL/SHM, media and legacy importer JSON are never removed by migration.
 * Only the encrypted staging DB is replaceable; a failed run can be repeated. Call only from
 * the foreground user's explicit migration action, with all chat services stopped. */
object DeviceMigration {
    val fastHook: SQLiteDatabaseHook = object : SQLiteDatabaseHook {
        override fun preKey(connection: SQLiteConnection) {
            connection.execute("PRAGMA cipher_default_kdf_iter = 1", null, null)
        }
        override fun postKey(connection: SQLiteConnection) = Unit
    }

    val legacyHook: SQLiteDatabaseHook = object : SQLiteDatabaseHook {
        override fun preKey(connection: SQLiteConnection) {
            connection.execute("PRAGMA cipher_default_kdf_iter = 256000", null, null)
        }
        override fun postKey(connection: SQLiteConnection) = Unit
    }

    fun needed(context: Context): Boolean {
        val app = context.applicationContext
        val source = app.getDatabasePath(TailchatDatabase.NAME)
        val target = app.getDatabasePath(TailchatDatabase.ENCRYPTED_NAME)
        if ((source.exists() || File(source.path + "-wal").exists() ||
            File(source.path + "-shm").exists()) && !target.exists()) return true
        val oldMedia = File(app.filesDir, "media-cache")
        val secureMedia = MediaCache.rootDir(app.filesDir)
        if (oldMedia.isDirectory && oldMedia.walkTopDown().any {
                it.isFile && !File(secureMedia, it.relativeTo(oldMedia).path).isFile
            }) return true
        if (File(app.filesDir, "transcript.ndjson").isFile &&
            !File(app.filesDir, "transcript.ndjson.enc").isFile) return true
        val oldCamera = File(app.cacheDir, "camera")
        if (oldCamera.isDirectory && oldCamera.walkTopDown().any {
                it.isFile && !File(app.filesDir, "camera-encrypted/old/${it.name}.enc").isFile
            }) return true
        val legacy = File(app.filesDir, "legacy-encrypted")
        val outbox = File(app.filesDir, LegacyImporter.OUTBOX_FILE)
        if (outbox.isFile && !File(legacy, "${LegacyImporter.OUTBOX_FILE}.enc").isFile) return true
        val history = File(app.filesDir, LegacyImporter.HISTORY_DIR)
        return history.isDirectory && history.walkTopDown().any {
            it.isFile && !File(legacy, "${LegacyImporter.HISTORY_DIR}/${it.name}.enc").isFile
        }
    }

    @Synchronized fun migrate(context: Context) {
        val app = context.applicationContext
        val key = DeviceDataKey.forMigration(app)
        val source = app.getDatabasePath(TailchatDatabase.NAME)
        val target = app.getDatabasePath(TailchatDatabase.ENCRYPTED_NAME)
        val stage = app.getDatabasePath("${TailchatDatabase.ENCRYPTED_NAME}.migrating")
        migrateDatabase(source, stage, target, key)
        migrateMedia(app, key)
        migrateTranscript(app, key)
        migrateLegacy(app, key)
        migrateCamera(app, key)
        cleanupPlaintext(app)
    }

    /**
     * The database half, split out so `DeviceMigrationOnDeviceTest` can drive exactly
     * this code against scratch files on a real phone. Robolectric cannot run it: the
     * SQLCipher native library is what does the work, and the JVM harness never loads
     * it — which is how an `ATTACH` that cannot create its file reached a release
     * build with the whole unit suite green.
     */
    internal fun migrateDatabase(source: File, stage: File, target: File, key: SecretKey) {
        if (!source.exists() && (File(source.path + "-wal").exists() || File(source.path + "-shm").exists()))
            throw IOException("Original database is missing; cannot recover its WAL without the main database")
        if (source.isFile && !target.isFile) {
            System.loadLibrary("sqlcipher")
            // Never copy just the main DB file: the original WAL can hold the unsent queue.
            // SQLite's read-only connection sees a single consistent main+WAL snapshot.
            val old = PlatformDatabase.openDatabase(source.path, null, PlatformDatabase.OPEN_READONLY)
            try {
                old.rawQuery("PRAGMA integrity_check", null).use {
                    if (!it.moveToFirst() || it.getString(0) != "ok") throw IOException("Original database failed integrity check")
                }
                if (stage.exists()) {
                    // Only migration-owned encrypted staging files are disposable.
                    listOf(stage, File(stage.path + "-wal"), File(stage.path + "-shm")).forEach {
                        if (it.exists() && !it.delete()) throw IOException("Cannot reset encrypted staging database")
                    }
                }
                val passphrase = passphrase(key)
                // SQLCipher's `ATTACH` cannot create its target file on a real device:
                // `ATTACH DATABASE '<new path>' AS encrypted KEY '<pass>'` fails with
                // SQLITE_CANTOPEN / errno ENOENT (code 14) even though the directory is
                // writable and `openOrCreateDatabase` creates files there happily — and
                // it fails the same way with the path as a bound parameter, with the
                // passphrase as a literal, and with no `KEY` clause at all (measured on
                // 0.76.44 against a real RMX3624; see
                // androidTest/DeviceMigrationOnDeviceTest). So the destination is created
                // first by the API that does work, and the ATTACH that follows only ever
                // opens a file that already exists.
                CipherDatabase.openOrCreateDatabase(stage.path, passphrase, null, null, fastHook).close()
                val cipher = CipherDatabase.openDatabase(source.path, null, CipherDatabase.OPEN_READWRITE)
                try {
                    // Literal, escaped values rather than bound parameters: the working
                    // recipe is the one SQLCipher's own documentation shows.
                    val stageSql = stage.path.replace("'", "''")
                    val passphraseSql = passphrase.replace("'", "''")
                    cipher.execSQL("PRAGMA cipher_default_kdf_iter = 1")
                    cipher.execSQL("ATTACH DATABASE '$stageSql' AS encrypted KEY '$passphraseSql'")
                    try {
                        cipher.rawQuery("SELECT sqlcipher_export('encrypted')", null).use { it.moveToFirst() }
                        cipher.rawQuery("PRAGMA user_version", null).use {
                            if (!it.moveToFirst()) throw IOException("Cannot read original schema version")
                            cipher.execSQL("PRAGMA encrypted.user_version = ${it.getInt(0)}")
                        }
                        cipher.rawQuery("PRAGMA encrypted.integrity_check", null).use {
                            if (!it.moveToFirst() || it.getString(0) != "ok")
                                throw IOException("Encrypted database failed integrity check")
                        }
                        // Validate every table, including pending_operations and Room's own metadata.
                        cipher.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", null).use { tables ->
                            while (tables.moveToNext()) {
                                val table = tables.getString(0).replace("\"", "\"\"")
                                val original = cipher.rawQuery("SELECT count(*) FROM \"$table\"", null).use { it.moveToFirst(); it.getLong(0) }
                                val copied = cipher.rawQuery("SELECT count(*) FROM encrypted.\"$table\"", null).use { it.moveToFirst(); it.getLong(0) }
                                if (original != copied) throw IOException("Database migration changed row count in $table")
                            }
                        }
                    } finally { cipher.execSQL("DETACH DATABASE encrypted") }
                } finally { cipher.close() }
            } finally { old.close() }
            Files.move(stage.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
        }
    }

    private fun migrateCamera(context: Context, key: SecretKey) {
        val old = File(context.cacheDir, "camera")
        if (!old.isDirectory) return
        val encrypted = EncryptedFile(key)
        old.walkTopDown().filter(File::isFile).forEach { source ->
            val target = File(context.filesDir, "camera-encrypted/old/${source.name}.enc")
            if (target.isFile) encrypted.read(target) else encrypted.write(target, source.readBytes())
        }
    }

    private fun migrateLegacy(context: Context, key: SecretKey) {
        val root = File(context.filesDir, "legacy-encrypted")
        val encrypted = EncryptedFile(key)
        val sources = sequenceOf(File(context.filesDir, LegacyImporter.OUTBOX_FILE)) +
            File(context.filesDir, LegacyImporter.HISTORY_DIR).listFiles().orEmpty().asSequence()
        sources.filter(File::isFile).forEach { source ->
            val relative = if (source.name == LegacyImporter.OUTBOX_FILE) source.name
                else "${LegacyImporter.HISTORY_DIR}/${source.name}"
            val target = File(root, "$relative.enc")
            if (target.isFile) encrypted.read(target) else encrypted.write(target, source.readBytes())
        }
    }

    private fun migrateMedia(context: Context, key: SecretKey) {
        val old = File(context.filesDir, "media-cache")
        val target = MediaCache.rootDir(context.filesDir)
        if (!old.isDirectory) return
        val encrypted = EncryptedFile(key)
        old.walkTopDown().filter { it.isFile }.forEach { file ->
            val output = File(target, file.relativeTo(old).path)
            if (output.isFile) {
                encrypted.read(output) // Refuse to treat corrupt staged data as successfully migrated.
            } else encrypted.write(output, file.readBytes())
        }
    }

    private fun migrateTranscript(context: Context, key: SecretKey) {
        val old = File(context.filesDir, "transcript.ndjson")
        if (!old.isFile) return
        val target = File(context.filesDir, "transcript.ndjson.enc")
        val encrypted = EncryptedFile(key)
        if (target.isFile) encrypted.read(target) else encrypted.write(target, old.readBytes())
    }

    internal fun passphrase(key: SecretKey): String = key.encoded.joinToString("") { "%02x".format(it) }

    /**
     * Checks if the encrypted Room database is using fast key derivation (kdf_iter = 1).
     * If still using the legacy 256,000-iteration key, exports it to a fast-key copy via
     * `sqlcipher_export`, verifies integrity and table row counts, and atomically swaps
     * the file while cleanly purging old WAL/SHM siblings to prevent corruption.
     * Returns true if fast key is active (or became active), or false if fallback to
     * legacy 256k key should be used.
     */
    @Synchronized fun ensureFastKey(
        context: Context,
        key: SecretKey,
        dbName: String = TailchatDatabase.ENCRYPTED_NAME,
    ): Boolean {
        val app = context.applicationContext
        val target = app.getDatabasePath(dbName)
        if (!target.isFile) return true

        System.loadLibrary("sqlcipher")
        val passBytes = passphrase(key).toByteArray(Charsets.UTF_8)

        // 1. Probe if already opening with fastHook
        val alreadyFast = runCatching {
            CipherDatabase.openDatabase(target.path, passBytes, null, CipherDatabase.OPEN_READONLY, fastHook).use { db ->
                db.rawQuery("SELECT count(*) FROM sqlite_schema", null).use { it.moveToFirst() }
            }
        }.isSuccess
        if (alreadyFast) {
            val stage = app.getDatabasePath("$dbName.fastkey-migrating")
            deleteWithSiblings(stage)
            return true
        }

        // 2. Perform safe export from legacy 256k to fast (kdf_iter = 1)
        val stage = app.getDatabasePath("$dbName.fastkey-migrating")
        deleteWithSiblings(stage)

        return try {
            CipherDatabase.openOrCreateDatabase(stage.path, passBytes, null, null, fastHook).close()
            val oldDb = CipherDatabase.openDatabase(target.path, passBytes, null, CipherDatabase.OPEN_READWRITE, legacyHook)
            try {
                oldDb.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null).use { it.moveToFirst() }
                oldDb.rawQuery("PRAGMA cipher_default_kdf_iter = 1", null).use { it.moveToFirst() }
                val stageSql = stage.path.replace("'", "''")
                val passphraseSql = passphrase(key).replace("'", "''")
                oldDb.execSQL("ATTACH DATABASE '$stageSql' AS faststage KEY '$passphraseSql'")
                try {
                    oldDb.rawQuery("SELECT sqlcipher_export('faststage')", null).use { it.moveToFirst() }
                    oldDb.rawQuery("PRAGMA user_version", null).use {
                        if (it.moveToFirst()) oldDb.execSQL("PRAGMA faststage.user_version = ${it.getInt(0)}")
                    }
                    oldDb.rawQuery("PRAGMA faststage.integrity_check", null).use {
                        if (!it.moveToFirst() || it.getString(0) != "ok")
                            throw IOException("Fast-key database failed integrity check")
                    }
                    // Validate every table row count
                    oldDb.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", null).use { tables ->
                        while (tables.moveToNext()) {
                            val table = tables.getString(0).replace("\"", "\"\"")
                            val original = oldDb.rawQuery("SELECT count(*) FROM \"$table\"", null).use { it.moveToFirst(); it.getLong(0) }
                            val exported = oldDb.rawQuery("SELECT count(*) FROM faststage.\"$table\"", null).use { it.moveToFirst(); it.getLong(0) }
                            if (original != exported) throw IOException("Fast-key migration changed row count in $table: $original vs $exported")
                        }
                    }
                } finally {
                    oldDb.execSQL("DETACH DATABASE faststage")
                }
            } finally {
                oldDb.close()
            }

            // 3. Purge old WAL/SHM before swap so no orphaned files remain under the old key!
            val targetWal = File(target.path + "-wal")
            val targetShm = File(target.path + "-shm")
            if (targetWal.exists()) targetWal.delete()
            if (targetShm.exists()) targetShm.delete()

            Files.move(stage.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)

            // 4. Verify target opens with fastHook
            CipherDatabase.openDatabase(target.path, passBytes, null, CipherDatabase.OPEN_READONLY, fastHook).use { db ->
                db.rawQuery("SELECT count(*) FROM sqlite_schema", null).use {
                    if (!it.moveToFirst()) throw IOException("Fast-key database cannot query schema after move")
                }
            }
            true
        } catch (e: Exception) {
            deleteWithSiblings(stage)
            false
        }
    }

    /**
     * Removes plaintext originals (Room db/wal/shm, media-cache, camera, transcript, legacy history)
     * once an encrypted database exists, closing cleartext residue and eliminating directory
     * traversal during cold-start `needed()` checks.
     */
    fun cleanupPlaintext(context: Context) {
        val app = context.applicationContext
        val target = app.getDatabasePath(TailchatDatabase.ENCRYPTED_NAME)
        if (!target.isFile) return

        // 1. Plaintext Room DB originals
        val source = app.getDatabasePath(TailchatDatabase.NAME)
        removeTree(source)

        // 2. Plaintext media
        val oldMedia = File(app.filesDir, "media-cache")
        val secureMedia = MediaCache.rootDir(app.filesDir)
        if (oldMedia.isDirectory && secureMedia.isDirectory) {
            oldMedia.walkTopDown().filter { it.isFile }.forEach { file ->
                val encrypted = File(secureMedia, file.relativeTo(oldMedia).path)
                if (encrypted.isFile) file.delete()
            }
            if (oldMedia.walkTopDown().none { it.isFile }) {
                oldMedia.deleteRecursively()
            }
        }

        // 3. Plaintext camera
        val oldCamera = File(app.cacheDir, "camera")
        val secureCamera = File(app.filesDir, "camera-encrypted/old")
        if (oldCamera.isDirectory && secureCamera.isDirectory) {
            oldCamera.walkTopDown().filter { it.isFile }.forEach { file ->
                val encrypted = File(secureCamera, "${file.name}.enc")
                if (encrypted.isFile) file.delete()
            }
            if (oldCamera.walkTopDown().none { it.isFile }) {
                oldCamera.deleteRecursively()
            }
        }

        // 4. Plaintext transcript
        val oldTranscript = File(app.filesDir, "transcript.ndjson")
        val secureTranscript = File(app.filesDir, "transcript.ndjson.enc")
        if (oldTranscript.isFile && secureTranscript.isFile) {
            oldTranscript.delete()
        }

        // 5. Legacy importer JSON files
        val legacy = File(app.filesDir, "legacy-encrypted")
        if (legacy.isDirectory) {
            val outbox = File(app.filesDir, LegacyImporter.OUTBOX_FILE)
            if (outbox.isFile && File(legacy, "${LegacyImporter.OUTBOX_FILE}.enc").isFile) {
                outbox.delete()
            }
            val history = File(app.filesDir, LegacyImporter.HISTORY_DIR)
            if (history.isDirectory) {
                history.walkTopDown().filter { it.isFile }.forEach { file ->
                    if (File(legacy, "${LegacyImporter.HISTORY_DIR}/${file.name}.enc").isFile) {
                        file.delete()
                    }
                }
                if (history.walkTopDown().none { it.isFile }) {
                    history.deleteRecursively()
                }
            }
        }
    }

    internal fun deleteWithSiblings(base: File) {
        runCatching { base.delete() }
        runCatching { File(base.path + "-wal").delete() }
        runCatching { File(base.path + "-shm").delete() }
    }

    /**
     * The way out of the dead end: every local artifact, plaintext and encrypted,
     * plus the unusable key, so the app can start over with a new one.
     *
     * The screen that offers this exists because the alternative is a device that can
     * never open chat again: with the Keystore key invalidated there is nothing to
     * decrypt with, and reinstalling the app is the same deletion done without a
     * warning. Cloud-synced history is re-downloaded after the next sign-in; the
     * unsent queue and the local P2P transcripts are gone for good, which is why the
     * caller has to say so and ask before calling this.
     */
    @Synchronized fun discard(context: Context) {
        val app = context.applicationContext
        val databases = app.getDatabasePath(TailchatDatabase.NAME).parentFile
        val encryptedDb = app.getDatabasePath(TailchatDatabase.ENCRYPTED_NAME)
        listOf(
            // The encrypted side first: it is the copy that is unreadable anyway.
            encryptedDb, File("${encryptedDb.path}.migrating"),
            // Then the plaintext originals, so `needed()` stops asking to migrate them.
            app.getDatabasePath(TailchatDatabase.NAME),
            File(app.filesDir, "media-cache"),
            File(app.filesDir, "transcript.ndjson"),
            File(app.cacheDir, "camera"),
            File(app.filesDir, LegacyImporter.OUTBOX_FILE),
            File(app.filesDir, LegacyImporter.HISTORY_DIR),
        ).forEach { removeTree(it) }
        removeTree(MediaCache.rootDir(app.filesDir))
        listOf("transcript.ndjson.enc").forEach { removeTree(File(app.filesDir, it)) }
        removeTree(File(app.cacheDir, "camera-encrypted"))
        removeTree(File(app.filesDir, "camera-encrypted"))
        removeTree(File(app.filesDir, "legacy-encrypted"))
        databases?.listFiles()?.filter { it.name.startsWith("probe-") }?.forEach { removeTree(it) }
        DeviceDataKey.reset(app)
    }

    private fun removeTree(file: File) {
        runCatching { if (file.isDirectory) file.deleteRecursively() else file.delete() }
        runCatching { File(file.path + "-wal").delete() }
        runCatching { File(file.path + "-shm").delete() }
    }
}
