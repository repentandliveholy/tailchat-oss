package net.tailchat.android.data

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Versioned AES-GCM payload; associated path prevents swapping two media or transcript files. */
internal class EncryptedFile(private val key: SecretKey) {
    private val header = byteArrayOf(0x54, 0x43, 0x45, 0x01)

    fun write(file: File, plain: ByteArray) {
        if (file.parentFile?.isDirectory != true && file.parentFile?.mkdirs() != true)
            throw IOException("Cannot create encrypted storage directory")
        val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD(file.absolutePath.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(plain)
        val temp = File(file.parentFile, "${file.name}.tmp-${java.util.UUID.randomUUID()}")
        try {
            java.io.FileOutputStream(temp).use { stream ->
                stream.write(header)
                stream.write(nonce)
                stream.write(encrypted)
                stream.fd.sync()
            }
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temp.delete() }
    }

    fun read(file: File): ByteArray {
        val bytes = file.readBytes()
        if (bytes.size < header.size + 12 + 16 || !bytes.copyOfRange(0, 4).contentEquals(header))
            throw IOException("Encrypted file is damaged: ${file.name}")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes, 4, 12))
        cipher.updateAAD(file.absolutePath.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(bytes, 16, bytes.size - 16)
    }
}
