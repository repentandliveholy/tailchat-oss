package net.tailchat.android.cloud

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The session token at rest.
 *
 * The token is a bearer credential: whoever reads it can act as this account
 * against the cloud server with no further check, so app-private storage
 * alone (readable in full by root, a backup-extraction bug, or `adb backup`
 * on a debuggable build) is not enough for it specifically. [KEY_TOKEN_ENC]
 * holds it AES-256-GCM-encrypted under a key generated in, and never
 * exported from, the Android Keystore — plain `Cipher`/`KeyGenerator`
 * against the `"AndroidKeyStore"` provider, not
 * `androidx.security:security-crypto`'s `EncryptedSharedPreferences`: that
 * wrapper is deprecated upstream as of 1.1.0 (no further maintenance, OEM
 * keyset-corruption reports) for the same primitive, with no replacement
 * short of a DataStore + Tink rewrite this one field does not need.
 *
 * Everything else in the file (server, login, name) stays plain — none of
 * it is a credential, and leaving it readable is what lets [BootReceiver]
 * and [WatchdogReceiver] cheaply ask "is there a session worth waking up
 * for" without touching the Keystore at all.
 *
 * An existing plaintext token is migrated on first read. If Keystore is unavailable
 * on a real device, saving or migrating a token fails closed; it is never persisted
 * in plaintext. The JVM-only Robolectric harness has no AndroidKeyStore provider and
 * retains its historical test-only storage path.
 */
class CloudSessionStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "cloud-session",
        Context.MODE_PRIVATE,
    )

    fun load(): CloudSession? {
        val server = preferences.getString(KEY_SERVER, null)?.let(CloudApi::normalizeServerUrl)
            ?: return null
        val token = readToken() ?: return null
        val login = preferences.getString(KEY_LOGIN, null)?.takeIf(String::isNotBlank)
            ?: return null
        val name = preferences.getString(KEY_NAME, null)?.takeIf(String::isNotBlank) ?: login
        return CloudSession(server, token, CloudUser(login, name))
    }

    fun save(session: CloudSession) {
        val editor = preferences.edit()
            .putString(KEY_SERVER, session.server)
            .putString(KEY_LOGIN, session.user.login)
            .putString(KEY_NAME, session.user.name)
        writeToken(editor, session.token)
        if (!editor.commit()) throw IllegalStateException("Could not persist encrypted session")
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    /** Migrates a pre-encryption token; never silently keeps plaintext on a device. */
    private fun readToken(): String? {
        preferences.getString(KEY_TOKEN_ENC, null)?.let { return decrypt(it) }
        val plain = preferences.getString(KEY_TOKEN, null)?.takeIf(String::isNotBlank) ?: return null
        val encoded = encrypt(plain) ?: if (isRobolectric()) return plain
            else throw IllegalStateException("Keystore unavailable: session token cannot be migrated securely")
        if (!preferences.edit().putString(KEY_TOKEN_ENC, encoded).remove(KEY_TOKEN).commit())
            throw IllegalStateException("Could not persist encrypted session token")
        return plain
    }

    private fun writeToken(editor: SharedPreferences.Editor, token: String) {
        val encoded = encrypt(token)
        if (encoded == null) {
            if (!isRobolectric()) throw IllegalStateException("Keystore unavailable: session token not saved")
            editor.putString(KEY_TOKEN, token).remove(KEY_TOKEN_ENC)
        } else editor.putString(KEY_TOKEN_ENC, encoded).remove(KEY_TOKEN)
    }

    private fun isRobolectric(): Boolean = runCatching {
        Class.forName("org.robolectric.RuntimeEnvironment")
    }.isSuccess

    private fun encrypt(plain: String): String? = runCatching {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyOrCreate())
        val ciphertext = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val payload = ByteArray(cipher.iv.size + ciphertext.size)
        System.arraycopy(cipher.iv, 0, payload, 0, cipher.iv.size)
        System.arraycopy(ciphertext, 0, payload, cipher.iv.size, ciphertext.size)
        Base64.encodeToString(payload, Base64.NO_WRAP)
    }.onFailure { Log.w(TAG, "cloud session token could not be encrypted", it) }.getOrNull()

    private fun decrypt(encoded: String): String? = runCatching {
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        require(payload.size > IV_SIZE)
        val iv = payload.copyOfRange(0, IV_SIZE)
        val ciphertext = payload.copyOfRange(IV_SIZE, payload.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyOrCreate(), GCMParameterSpec(GCM_TAG_BITS, iv))
        String(cipher.doFinal(ciphertext), Charsets.UTF_8).takeIf(String::isNotBlank)
    }.onFailure { Log.w(TAG, "cloud session token could not be decrypted", it) }.getOrNull()

    private fun keyOrCreate(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val TAG = "CloudSessionStore"
        const val PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "tailchat-session-token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val IV_SIZE = 12
        const val KEY_SERVER = "server"
        const val KEY_TOKEN = "token"
        const val KEY_TOKEN_ENC = "token_enc"
        const val KEY_LOGIN = "login"
        const val KEY_NAME = "name"
    }
}
