package net.tailchat.android

import android.net.Uri

/** URI granted to the external camera, backed by an in-memory seekable FD.
 * [SecureCameraProvider] publishes only authenticated ciphertext after close. */
fun createCameraCaptureUri(context: android.content.Context): Uri = SecureCameraProvider.uri(context)
