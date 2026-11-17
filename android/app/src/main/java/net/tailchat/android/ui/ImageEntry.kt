package net.tailchat.android.ui

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.MimeTypeMap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.PlatformTextInputSession
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * The ways a picture reaches the editor that are not the attach menu: a keyboard's own
 * sticker / image button, and Ctrl+V.
 *
 * Compose Foundation 1.7's `Modifier.contentReceiver` is wired only into the state-based
 * `BasicTextField(state = …)`; the composer's field is the `value`/`onValueChange` one, which
 * never looks at it, so a keyboard that offers an image would find a field that does not take
 * one. The same effect is had at the layer below: the keyboard asks the field's input
 * connection for the content types it accepts, and a legacy field's connection can be wrapped
 * on its way out (`InterceptPlatformTextInput`).
 *
 * Both entries copy what they are given into the app's cache before handing a `Uri` on: a
 * keyboard's grant lasts only until the commit returns, and the clipboard's only as long as
 * that clip is the primary one, while the editor may sit open for minutes.
 */

/** What the composer's field tells a keyboard it will take. Not GIF: every picture is sent as one
 *  still frame (web does the same), and a button that sends an animation as a photograph is a lie. */
private val IME_IMAGE_TYPES = arrayOf(
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/bmp",
)

private const val ENTRY_DIR = "image-entry"

/** Past this a "picture" is not one: the same 48 MB ceiling as a picked file
 *  ([net.tailchat.android.cloud.IMAGE_SOURCE_MAX_BYTES]), which this copy is about to become. */
private const val ENTRY_MAX_BYTES = 48L * 1024 * 1024

/** The copies are scratch: anything older than this is swept the next time one is made. */
private const val ENTRY_KEEP_MS = 60L * 60 * 1000

/**
 * Whether [uri] is a picture — what the file picker uses to route a chosen document: a picture goes
 * to the editor like any other, everything else is sent as a file. The provider's own answer
 * first; for one that gives none (a plain `file:` path), the file name's extension.
 */
fun isImageUri(context: Context, uri: Uri): Boolean {
    val reported = runCatching { context.contentResolver.getType(uri) }.getOrNull()
    if (!reported.isNullOrEmpty()) return reported.startsWith("image/")
    val extension = uri.lastPathSegment?.substringAfterLast('.', "").orEmpty().lowercase()
    if (extension.isEmpty()) return false
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)?.startsWith("image/") == true
}

/**
 * Copies the picture behind [source] into the app's cache and returns the copy's `Uri`, or `null`
 * when it cannot be read or is larger than the ceiling. Blocking: call it on `Dispatchers.IO`.
 */
internal fun copyImageToCache(context: Context, source: Uri): Uri? = runCatching {
    val dir = File(context.cacheDir, ENTRY_DIR).apply { mkdirs() }
    val stale = System.currentTimeMillis() - ENTRY_KEEP_MS
    dir.listFiles()?.forEach { if (it.lastModified() < stale) it.delete() }
    val target = File.createTempFile("entry-", ".img", dir)
    val copied = try {
        context.contentResolver.openInputStream(source)?.use { input ->
            target.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > ENTRY_MAX_BYTES) return@use false
                    output.write(buffer, 0, read)
                }
                total > 0L
            }
        } == true
    } catch (error: Exception) {
        target.delete()
        throw error
    }
    if (!copied) {
        target.delete()
        null
    } else {
        Uri.fromFile(target)
    }
}.getOrNull()

/** The picture on the clipboard, if the primary clip holds one — web prefers it over text too. */
private fun clipboardImageUri(context: Context): Uri? {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    if (manager.primaryClipDescription?.hasMimeType("image/*") != true) return null
    val clip = manager.primaryClip ?: return null
    for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let { return it }
    return null
}

/**
 * Wrap the composer's text field in this and a keyboard's sticker / image / clipboard-suggestion button
 * can hand a picture to [onImage] — which opens the editor. A wrapper that adds no layout node of its
 * own, so `Modifier.weight(1f)` on the field inside still works.
 *
 * While [enabled] is `false` (a blocked contact, a recording) the field advertises nothing and takes
 * nothing, exactly as if this were not here.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ImageContentReceiver(
    enabled: Boolean = true,
    onImage: (Uri) -> Unit,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val latestOnImage by rememberUpdatedState(onImage)
    val interceptor = remember(enabled) {
        object : PlatformTextInputInterceptor {
            override suspend fun interceptStartInputMethod(
                request: PlatformTextInputMethodRequest,
                nextHandler: PlatformTextInputSession,
            ): Nothing = nextHandler.startInputMethod(
                if (!enabled) {
                    request
                } else {
                    object : PlatformTextInputMethodRequest {
                        override fun createInputConnection(outAttributes: EditorInfo): InputConnection {
                            val inner = request.createInputConnection(outAttributes)
                            EditorInfoCompat.setContentMimeTypes(outAttributes, IME_IMAGE_TYPES)
                            return InputConnectionCompat.createWrapper(inner, outAttributes) { info, flags, _ ->
                                acceptKeyboardImage(context, scope, info, flags) { latestOnImage(it) }
                            }
                        }
                    }
                },
            )
        }
    }
    InterceptPlatformTextInput(interceptor, content)
}

/** The keyboard's commit: take a read grant if it offers one, copy the picture out, hand the copy on. */
private fun acceptKeyboardImage(
    context: Context,
    scope: CoroutineScope,
    info: InputContentInfoCompat,
    flags: Int,
    onImage: (Uri) -> Unit,
): Boolean {
    if (!info.description.hasMimeType("image/*")) return false
    if ((flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
        try {
            info.requestPermission()
        } catch (_: Exception) {
            return false
        }
    }
    scope.launch {
        val copy = withContext(Dispatchers.IO) { copyImageToCache(context.applicationContext, info.contentUri) }
        runCatching { info.releasePermission() }
        if (copy != null) onImage(copy)
    }
    return true
}

/**
 * Ctrl/Cmd+V and Shift+Insert on a hardware keyboard, with a picture on the clipboard, send it to
 * [onImage] instead of letting the field ignore it — a text field only ever pastes text. A clipboard
 * with no picture is left to the field, which pastes as usual. Put it on the composer's field
 * itself (`BasicTextField(modifier = Modifier.weight(1f).imagePasteShortcut { … })`).
 */
@Composable
fun Modifier.imagePasteShortcut(enabled: Boolean = true, onImage: (Uri) -> Unit): Modifier {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val latestOnImage by rememberUpdatedState(onImage)
    if (!enabled) return this
    return onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val paste = ((event.isCtrlPressed || event.isMetaPressed) && event.key == Key.V) ||
            (event.isShiftPressed && event.key == Key.Insert)
        if (!paste) return@onPreviewKeyEvent false
        val picture = clipboardImageUri(context) ?: return@onPreviewKeyEvent false
        scope.launch {
            val copy = withContext(Dispatchers.IO) { copyImageToCache(context.applicationContext, picture) }
            if (copy != null) latestOnImage(copy)
        }
        true
    }
}
