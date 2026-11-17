package net.tailchat.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** One random data key for Room, media and the P2P transcript. The wrapping key never leaves Keystore.
 * The wrapped key is deliberately not backed up: restoring ciphertext without the device key cannot work. */
object DeviceDataKey {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "tailchat-data-v1"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val FILE = "data-key-v1.bin"
    private const val IV_BYTES = 12

    private fun isRobolectric(): Boolean = runCatching {
        Class.forName("org.robolectric.RuntimeEnvironment")
    }.isSuccess

    @Synchronized fun get(context: Context): SecretKey {
        if (isRobolectric()) return SecretKeySpec(ByteArray(32) { 0x42 }, "AES")
        val app = context.applicationContext
        val wrapped = File(app.noBackupFilesDir, FILE)
        if (wrapped.exists()) {
            val blob = wrapped.readBytes()
            if (blob.size != 1 + IV_BYTES + 32 + 16 || blob[0] != 1.toByte())
                throw IOException("Device data key is damaged; unsent messages and P2P history cannot be restored without it")
            val cipher = Cipher.getInstance(TRANSFORM)
            try {
                cipher.init(Cipher.DECRYPT_MODE, wrappingKey(false), GCMParameterSpec(128, blob, 1, IV_BYTES))
                val raw = cipher.doFinal(blob, 1 + IV_BYTES, blob.size - 1 - IV_BYTES)
                if (raw.size != 32) throw IOException("Invalid device data key length")
                return SecretKeySpec(raw, "AES").also { raw.fill(0) }
            } catch (e: Exception) {
                throw IOException("Device key unavailable: unsent messages and P2P history cannot be restored without it", e)
            }
        }
        // Never replace a missing wrapping file while any encrypted or legacy data could exist.
        if (TailchatDatabase.hasExistingData(app) || File(app.filesDir, "transcript.ndjson.enc").exists() ||
            File(app.filesDir, "transcript.ndjson").exists() ||
            MediaCache.rootDir(app.filesDir).walkTopDown().any { it.isFile } ||
            File(app.filesDir, "camera-encrypted").walkTopDown().any { it.isFile } ||
            File(app.cacheDir, "camera").walkTopDown().any { it.isFile } ||
            File(app.cacheDir, "camera-encrypted").walkTopDown().any { it.isFile } ||
            File(app.filesDir, LegacyImporter.OUTBOX_FILE).exists() ||
            File(app.filesDir, LegacyImporter.HISTORY_DIR).walkTopDown().any { it.isFile })
            throw IOException("Existing data requires explicit migration or the original device key; unsent messages and P2P history cannot be restored by resetting it")
        return create(app)
    }

    /** Called only by explicit foreground migration. Never overwrites an existing key. */
    @Synchronized fun forMigration(context: Context): SecretKey {
        if (isRobolectric()) return SecretKeySpec(ByteArray(32) { 0x42 }, "AES")
        val app = context.applicationContext
        val file = File(app.noBackupFilesDir, FILE)
        if (file.exists()) return get(app)
        if (app.getDatabasePath(TailchatDatabase.ENCRYPTED_NAME).exists() ||
            app.getDatabasePath("${TailchatDatabase.ENCRYPTED_NAME}.migrating").exists() ||
            File(app.filesDir, "transcript.ndjson.enc").exists() ||
            MediaCache.rootDir(app.filesDir).walkTopDown().any { it.isFile } ||
            File(app.filesDir, "camera-encrypted").walkTopDown().any { it.isFile } ||
            File(app.cacheDir, "camera-encrypted").walkTopDown().any { it.isFile } ||
            File(app.filesDir, "legacy-encrypted").walkTopDown().any { it.isFile })
            throw IOException("Device key was lost: unsent messages and P2P history cannot be restored")
        return create(app)
    }

    fun hasWrappedKey(context: Context): Boolean = File(context.noBackupFilesDir, FILE).isFile

    /**
     * Drops the wrapped key and the Keystore entry that wraps it. Both halves go: a
     * key the Keystore has invalidated (a lock-screen change, an OEM keystore that
     * lost its blob) keeps failing under the same alias, so leaving the alias behind
     * would leave the device exactly as stuck as it was.
     */
    @Synchronized fun reset(context: Context) {
        val app = context.applicationContext
        runCatching { File(app.noBackupFilesDir, FILE).delete() }
        runCatching {
            KeyStore.getInstance(PROVIDER).apply { load(null) }.deleteEntry(ALIAS)
        }
    }

    private fun create(context: Context): SecretKey {
        val file = File(context.noBackupFilesDir, FILE)
        val raw = ByteArray(32).also(SecureRandom()::nextBytes)
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(true))
            val blob = byteArrayOf(1) + cipher.iv + cipher.doFinal(raw)
            val tmp = File(file.parentFile, "$FILE.tmp")
            try {
                java.io.FileOutputStream(tmp).use { stream -> stream.write(blob); stream.fd.sync() }
                if (!tmp.renameTo(file)) throw IOException("Cannot publish wrapped device key")
            } finally { tmp.delete() }
            return SecretKeySpec(raw, "AES")
        } finally { raw.fill(0) }
    }

    private fun wrappingKey(create: Boolean): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) throw IOException("Android Keystore wrapping key is missing")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

}
