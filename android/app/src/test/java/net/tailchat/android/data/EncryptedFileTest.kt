package net.tailchat.android.data

import java.io.File
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedFileTest {
    private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")

    @Test fun mediaReferenceSurvivesEncryptedPublicationAndTamperingFails() {
        val root = java.nio.file.Files.createTempDirectory("tailchat-encrypted-media").toFile()
        try {
            val media = MediaCache(root, key)
            val source = "data:image/png;base64,VERY_PRIVATE_IMAGE"
            val ref = media.store("account", "message-1", "img", source)
            assertTrue(ref.startsWith("media://"))
            val file = File(root, ref.removePrefix("media://"))
            assertFalse(file.readBytes().toString(Charsets.UTF_8).contains("VERY_PRIVATE_IMAGE"))
            assertTrue(file.parentFile!!.listFiles()!!.none { it.name.contains(".tmp-") })
            assertTrue(media.load(ref) == source)
            val damaged = file.readBytes()
            damaged[damaged.lastIndex] = (damaged.last().toInt() xor 1).toByte()
            file.writeBytes(damaged)
            assertThrows(Exception::class.java) { media.load(ref) }
        } finally { root.deleteRecursively() }
    }

    @Test fun swappingEncryptedMediaPathsDoesNotDecrypt() {
        val root = java.nio.file.Files.createTempDirectory("tailchat-encrypted-swap").toFile()
        try {
            val media = MediaCache(root, key)
            val first = media.store("account", "one", "img", "data:image/png;base64,FIRST")
            val second = media.store("account", "two", "img", "data:image/png;base64,SECOND")
            val firstFile = File(root, first.removePrefix("media://"))
            val secondFile = File(root, second.removePrefix("media://"))
            secondFile.writeBytes(firstFile.readBytes())
            assertThrows(Exception::class.java) { media.load(second) }
        } finally { root.deleteRecursively() }
    }
}
