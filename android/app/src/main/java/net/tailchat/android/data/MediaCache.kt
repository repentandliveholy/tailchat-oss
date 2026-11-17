package net.tailchat.android.data

import java.io.File
import java.security.MessageDigest
import javax.crypto.SecretKey

/**
 * Where an inline `data:` URL actually lives once [ChatRepository] gets hold
 * of it: a file under [root], never a SQLite column.
 *
 * Android's `CursorWindow` caps what any single queried row can return at
 * roughly 2 MB — native behaviour, not a Room quirk (`SQLiteBlobTooBigException:
 * Row too big to fit into CursorWindow`), and it applies even to a `SELECT`
 * of that one oversized column alone. A compressed photo's base64 form
 * (`CLOUD_MEDIA_MAX_CHARS` allows up to 10 MiB of it) routinely exceeds that
 * on its own, which used to mean: `SyncEngine.pump()`'s outbox claim threw
 * before the photo — or anything queued behind it — ever reached `write()`,
 * every time, forever, because the row that broke the read was never removed
 * by the read that never completed. Opening the conversation that owned it
 * threw the same way.
 *
 * The fix is to never let a large value be a queried column's content in the
 * first place: [store] takes the literal `data:` URL off [ChatRepository]'s
 * hands and returns a short `media://` reference instead, small enough that
 * no ordinary row could ever be too big again. [load] resolves that
 * reference back to the real `data:` URL for the two places that need the
 * actual bytes — the wire frame [SyncEngine] sends and the model the UI
 * renders — both single-row, bounded operations, unlike the list/claim
 * queries this exists to protect.
 *
 * A value that is not a `media://` reference is passed through unchanged by
 * [load]: a small legacy row written before this cache existed still holds
 * its literal `data:` URL, and skipping it here is what keeps reading it as
 * cheap as it always was.
 */
class MediaCache(private val root: File, key: SecretKey) {
    private val encrypted = EncryptedFile(key)
    /** JVM-only test convenience. Release APKs have no Robolectric class and cannot use it. */
    constructor(root: File) : this(root, testKey())
    /** Stores only encrypted bytes and keeps the same deterministic `media://`
     * reference for a message and its paired pending operation. [EncryptedFile]
     * publishes via encrypted temporary file and atomic rename; failures
     * prevent the caller from committing a dangling queue entry. */
    fun store(accountKey: String, id: String, slot: String, dataUrl: String): String {
        val file = fileFor(accountKey, id, slot)
        encrypted.write(file, dataUrl.toByteArray(Charsets.UTF_8))
        return SCHEME + relativeKey(accountKey, id, slot)
    }

    /** `null` only when [ref] names a file this cache no longer has — the
     *  disk was cleared out from under a row that still points at it. A value
     *  that was never a reference (legacy inline data, or plain `null`) comes
     *  back exactly as given. */
    fun load(ref: String?): String? {
        if (ref == null) return null
        if (!ref.startsWith(SCHEME)) return ref
        val file = File(root, ref.removePrefix(SCHEME))
        return if (file.isFile) String(encrypted.read(file), Charsets.UTF_8) else null
    }

    /** No-op for anything that is not a reference — deleting a row that was
     *  never file-backed must not need a second code path. */
    fun delete(ref: String?) {
        if (ref == null || !ref.startsWith(SCHEME)) return
        File(root, ref.removePrefix(SCHEME)).delete()
    }

    /** Frees whatever media a message owned, by (accountKey, id) alone — no
     *  need to have read the row's old reference first, since [store] names
     *  every slot deterministically. A slot this message never used is a
     *  harmless no-op, the same as [delete] on a reference that never
     *  existed. This is what a tombstone ([Daos.applyDelete]) or a bulk
     *  history clear ([ChatRepository.clearTranscripts]/[ChatRepository.
     *  clearTranscript]/[ChatRepository.forgetAccount]) calls once the Room
     *  row that used to reference the file is gone, so "clear cache"
     *  actually frees the bytes its own size figure counts. */
    fun deleteFor(accountKey: String, id: String) {
        SLOTS.forEach { slot -> fileFor(accountKey, id, slot).delete() }
    }

    /** The whole account's media in one call — logout/account-switch does not
     *  enumerate rows to find what to free, it just owns nothing anymore. */
    fun deleteAccount(accountKey: String) {
        File(root, hash(accountKey)).deleteRecursively()
    }

    /** What the settings sheet's storage figure has to include now that a
     *  photo's bytes live here instead of in the database file. */
    fun sizeBytes(): Long =
        if (root.isDirectory) root.walkTopDown().filter { it.isFile }.sumOf { it.length() } else 0L

    private fun relativeKey(accountKey: String, id: String, slot: String) = "${hash(accountKey)}/${hash(id)}-$slot.dat"

    private fun fileFor(accountKey: String, id: String, slot: String) = File(root, relativeKey(accountKey, id, slot))

    companion object {
        private const val SCHEME = "media://"

        /** The two slots [ChatRepository.withCachedMedia] ever writes for a
         *  message — kept in sync with those call sites' literal "img"/
         *  "voice" by [deleteFor], the only place that has to name both at
         *  once without an existing row to read them from. */
        private val SLOTS = listOf("img", "voice")

        /** Where every [MediaCache] instance in the app has to agree to look —
         *  shared so `TailchatDatabase.storedBytes` can report the same bytes
         *  `ChatRepository`'s cache actually wrote. */
        private fun testKey(): SecretKey {
            check(runCatching { Class.forName("org.robolectric.RuntimeEnvironment") }.isSuccess) {
                "MediaCache requires the wrapped device key"
            }
            return javax.crypto.spec.SecretKeySpec(ByteArray(32) { 0x42 }, "AES")
        }

        fun rootDir(filesDir: File): File = File(filesDir, "media-cache-encrypted")

        private fun hash(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
                .joinToString("") { "%02x".format(it) }
    }
}
