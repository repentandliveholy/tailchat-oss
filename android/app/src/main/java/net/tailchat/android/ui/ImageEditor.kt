package net.tailchat.android.ui

import android.content.ContentResolver
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.view.KeyCharacterMap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Crop
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.RotateRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.tailchat.android.R
import net.tailchat.android.cloud.limitImageCaption
import net.tailchat.android.cloud.ImageEdit
import net.tailchat.android.cloud.ImageEncoder
import net.tailchat.android.cloud.orientationFromExif

/*
 * The image editor — web/cloud/app.js's image sheet. Every picture, however it arrives (gallery,
 * camera, a file, paste, a keyboard's sticker button), stops here first: a screenshot usually
 * holds more than the person meant to send, and a picture that has left cannot be cropped.
 *
 * It edits a *description* (turns and a crop frame) over a screen-sized copy of the picture and
 * hands that description back; the picture that is sent is cut from the original bytes
 * (ImageEncoder), so the preview's resolution never limits the result.
 */

/** Below this the eight handles of the frame start sitting on top of each other. web's `IMAGE_CROP_MIN_PX`. */
private val CropMinSide = 40.dp
/** How far from a corner or an edge a finger still grabs it — a thumb is not a pixel. */
private val CropGrabSlop = 28.dp
/** A handle's white square, and how far inside the frame its centre sits (web: 10px, inset 6 of 22). */
private val CropHandleSide = 10.dp
private val CropHandleInset = 11.dp

/** Everything the editor changes, in one place: the picture's rotation, the frame on it, and its shape. */
@Stable
private class EditorState {
    var quarterTurns by mutableIntStateOf(0)
    var crop by mutableStateOf(CropRect.Whole)
    var ratio by mutableStateOf(CropRatio.Free)

    /** Width / height the frame keeps while resized; `0` is a free frame. */
    var aspect by mutableFloatStateOf(0f)
    var cropping by mutableStateOf(false)

    val isEdited: Boolean get() = quarterTurns % 4 != 0 || !crop.isWhole

    fun rotate() {
        crop = rotateCrop(crop)
        quarterTurns = (quarterTurns + 1) % 4
        if (aspect != 0f) aspect = 1f / aspect
    }

    /** Back to the original picture; crop mode itself is left as it is. */
    fun reset() {
        quarterTurns = 0
        crop = CropRect.Whole
        ratio = CropRatio.Free
        aspect = 0f
    }

    fun pick(ratio: CropRatio, rotatedWidth: Int, rotatedHeight: Int) {
        this.ratio = ratio
        aspect = cropAspectFor(ratio, rotatedWidth, rotatedHeight)
        if (aspect > 0f) crop = cropFrameForAspect(aspect, rotatedWidth, rotatedHeight)
    }
}

/**
 * The state across a recreation of the activity (a rotation while cropping is the likeliest one): turns,
 * the frame, the ratio and whether crop mode was open. Only useful if the caller keeps the picture's
 * `Uri` across it too — then the editor comes back exactly as it was left.
 */
private val EditorStateSaver = listSaver<EditorState, Any>(
    save = { listOf(it.quarterTurns, it.crop.x, it.crop.y, it.crop.w, it.crop.h, it.ratio.ordinal, it.aspect, it.cropping) },
    restore = { saved ->
        EditorState().apply {
            quarterTurns = saved[0] as Int
            crop = CropRect(saved[1] as Float, saved[2] as Float, saved[3] as Float, saved[4] as Float)
            ratio = CropRatio.entries[saved[5] as Int]
            aspect = saved[6] as Float
            cropping = saved[7] as Boolean
        }
    },
)

/**
 * The editor over the picture at [uri]: preview, crop (free / 1:1 / 4:3 / 16:9 with draggable
 * handles), a 90° turn, a reset to the original, and a caption.
 *
 * [onDismiss] is cancel — the button, Back, Esc: nothing is sent and the caller's draft is
 * untouched. [onSend] is "send": the edit to apply (`ImageEdit.None` for an untouched picture) and the
 * caption as typed, trimmed. The editor calls exactly one of them, once, and does not close itself:
 * the caller drops its [uri] state in both and passes the pair on to `CloudController.sendImage`.
 *
 * A picture that cannot be opened shows why and leaves only cancel.
 */
@OptIn(ExperimentalComposeUiApi::class, ExperimentalLayoutApi::class)
@Composable
fun ImageEditor(
    uri: Uri,
    onDismiss: () -> Unit,
    onSend: (edit: ImageEdit, caption: String) -> Unit,
) {
    // A different picture is a different editor: no crop, turn or caption carries over.
    key(uri) { EditorSheet(uri, onDismiss, onSend) }
}

@OptIn(ExperimentalComposeUiApi::class, ExperimentalLayoutApi::class)
@Composable
private fun EditorSheet(uri: Uri, onDismiss: () -> Unit, onSend: (ImageEdit, String) -> Unit) {
    val context = LocalContext.current
    val latestOnDismiss by rememberUpdatedState(onDismiss)
    val latestOnSend by rememberUpdatedState(onSend)
    val state = rememberSaveable(saver = EditorStateSaver) { EditorState() }
    var source by remember { mutableStateOf<Bitmap?>(null) }
    var failed by remember { mutableStateOf(false) }
    var caption by rememberSaveable { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }

    // The copy the editor shows is as sharp as the screen can use, no sharper: off the main
    // thread, sampled, EXIF-upright, and bounded in pixels whatever the file is.
    val maxSide = remember { context.resources.displayMetrics.let { max(it.widthPixels, it.heightPixels) } }
    LaunchedEffect(uri) {
        val bitmap = withContext(Dispatchers.IO) { decodeForEditor(context.contentResolver, uri, maxSide) }
        if (bitmap != null) source = bitmap else failed = true
    }

    val ready = source != null
    val send = {
        if (source != null && !sent) {
            sent = true
            latestOnSend(imageEditOf(state.quarterTurns, state.crop), caption.trim())
        }
    }

    val title = stringResource(R.string.image_editor_title)

    FullscreenDialog(onDismissRequest = { latestOnDismiss() }, resizeForKeyboard = true) {
        // Everything that touches focus is made *inside* the dialog's content: a dialog is a window of
        // its own, composed on its own, with a focus owner of its own — the activity's `LocalFocusManager`
        // read out here would clear the wrong one.
        val focusManager = LocalFocusManager.current
        val rootFocus = remember { FocusRequester() }
        val captionFocus = remember { FocusRequester() }
        // A hardware keyboard means typing is cheap and an on-screen one will not cover the picture:
        // the caption takes the focus at once (web: only for a fine pointer). On a phone it waits to be tapped.
        val hardwareKeyboard = LocalConfiguration.current.keyboard != Configuration.KEYBOARD_NOKEYS
        LaunchedEffect(ready) {
            runCatching { if (hardwareKeyboard && ready) captionFocus.requestFocus() else rootFocus.requestFocus() }
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.92f))
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .semantics {
                    testTagsAsResourceId = true
                    paneTitle = title
                }
                .testTag("image_editor")
                .focusRequester(rootFocus)
                .focusable()
                .onPreviewKeyEvent { event ->
                    if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
                        latestOnDismiss()
                        true
                    } else {
                        false
                    }
                },
        ) {
            // ---- the picture, over all the free area ----
            BoxWithConstraints(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(12.dp)
                    .testTag("image_editor_stage")
                    // A tap on the picture's surround is how a keyboard is put away.
                    .pointerInput(Unit) { detectTapGestures { focusManager.clearFocus() } },
                contentAlignment = Alignment.Center,
            ) {
                val bitmap = source
                when {
                    bitmap != null -> {
                        val odd = state.quarterTurns % 2 == 1
                        val rotatedWidth = if (odd) bitmap.height else bitmap.width
                        val rotatedHeight = if (odd) bitmap.width else bitmap.height
                        // The picture fills the area as far as its shape allows; unlike the viewer, a
                        // small picture is enlarged to be worth cropping.
                        val fitScale = min(
                            constraints.maxWidth / rotatedWidth.toFloat(),
                            constraints.maxHeight / rotatedHeight.toFloat(),
                        )
                        EditorFrame(
                            bitmap = bitmap,
                            state = state,
                            frameWidthPx = max(1, floor(rotatedWidth * fitScale).toInt()),
                            frameHeightPx = max(1, floor(rotatedHeight * fitScale).toInt()),
                            description = stringResource(R.string.image_editor_preview),
                        )
                    }
                    failed -> Text(
                        stringResource(R.string.image_editor_failed),
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    else -> {
                        val loading = stringResource(R.string.image_editor_loading)
                        CircularProgressIndicator(
                            modifier = Modifier.size(32.dp).semantics { contentDescription = loading },
                            color = Color.White.copy(alpha = 0.8f),
                            strokeWidth = 2.dp,
                        )
                    }
                }
            }

            // ---- the panel under it ----
            Surface(
                color = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.onSurface,
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (state.cropping && source != null) {
                        // The group's name, so a screen reader says what the four chips choose between.
                        val ratioGroup = stringResource(R.string.image_editor_ratio_group)
                        FlowRow(
                            modifier = Modifier.semantics { contentDescription = ratioGroup },
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val odd = state.quarterTurns % 2 == 1
                            val rotatedWidth = source?.let { if (odd) it.height else it.width } ?: 1
                            val rotatedHeight = source?.let { if (odd) it.width else it.height } ?: 1
                            for ((ratio, label, tag) in ratioChips()) {
                                EditorChip(
                                    label = label,
                                    selected = state.ratio == ratio,
                                    onClick = { state.pick(ratio, rotatedWidth, rotatedHeight) },
                                    modifier = Modifier.testTag(tag),
                                )
                            }
                        }
                    }
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        EditorChip(
                            label = stringResource(R.string.image_editor_cancel),
                            onClick = { latestOnDismiss() },
                            modifier = Modifier.testTag("image_editor_cancel"),
                        )
                        if (ready) {
                            EditorChip(
                                label = stringResource(R.string.image_editor_crop),
                                icon = Icons.Filled.Crop,
                                selected = state.cropping,
                                onClick = { state.cropping = !state.cropping },
                                modifier = Modifier.testTag("image_editor_crop"),
                            )
                            EditorChip(
                                label = stringResource(R.string.image_editor_rotate),
                                icon = Icons.Filled.RotateRight,
                                onClick = { state.rotate() },
                                modifier = Modifier.testTag("image_editor_rotate"),
                            )
                            if (state.isEdited) {
                                EditorChip(
                                    label = stringResource(R.string.image_editor_reset),
                                    icon = Icons.Filled.RestartAlt,
                                    onClick = { state.reset() },
                                    modifier = Modifier.testTag("image_editor_reset"),
                                )
                            }
                        }
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        CaptionField(
                            value = caption,
                            onValueChange = { caption = limitImageCaption(it) },
                            onSend = send,
                            focus = captionFocus,
                            modifier = Modifier.weight(1f),
                        )
                        val sendLabel = stringResource(R.string.image_editor_send)
                        Box(
                            modifier = Modifier
                                .size(48.dp)
                                .clip(CircleShape)
                                .background(
                                    MaterialTheme.colorScheme.primary.copy(alpha = if (ready) 1f else 0.38f),
                                )
                                .clickable(enabled = ready, role = Role.Button) { send() }
                                .semantics { contentDescription = sendLabel }
                                .testTag("image_editor_send"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onPrimary,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The ratio chips, in web's order, with the label each shows and the tag an instrumented test finds it by. */
@Composable
private fun ratioChips(): List<Triple<CropRatio, String, String>> = listOf(
    Triple(CropRatio.Free, stringResource(R.string.image_editor_ratio_free), "image_editor_ratio_free"),
    Triple(CropRatio.Square, "1:1", "image_editor_ratio_1_1"),
    Triple(CropRatio.FourThree, "4:3", "image_editor_ratio_4_3"),
    Triple(CropRatio.SixteenNine, "16:9", "image_editor_ratio_16_9"),
)

/**
 * The picture at its on-screen size with the crop frame over it. Two canvases, deliberately: the
 * picture's reads only the rotation, so dragging a handle redraws the frame and never the bitmap.
 */
@Composable
private fun EditorFrame(
    bitmap: Bitmap,
    state: EditorState,
    frameWidthPx: Int,
    frameHeightPx: Int,
    description: String,
) {
    val density = LocalDensity.current
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    val frame = Modifier.size(
        with(density) { frameWidthPx.toDp() },
        with(density) { frameHeightPx.toDp() },
    )
    Box(
        modifier = frame
            .semantics { contentDescription = description }
            .then(if (state.cropping) Modifier.cropGestures(state) else Modifier),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val turns = state.quarterTurns % 4
            // The frame is the *rotated* picture's size; the bitmap is drawn at its own, centred, and
            // the canvas turned about the centre — so a quarter turn costs nothing but this transform.
            val unrotatedWidth = if (turns % 2 == 1) size.height else size.width
            val unrotatedHeight = if (turns % 2 == 1) size.width else size.height
            withTransform({ rotate(degrees = turns * 90f, pivot = center) }) {
                drawImage(
                    image,
                    dstOffset = IntOffset(
                        (size.width / 2f - unrotatedWidth / 2f).roundToInt(),
                        (size.height / 2f - unrotatedHeight / 2f).roundToInt(),
                    ),
                    dstSize = IntSize(unrotatedWidth.roundToInt(), unrotatedHeight.roundToInt()),
                    filterQuality = FilterQuality.Medium,
                )
            }
        }
        Canvas(Modifier.fillMaxSize()) {
            // Outside crop mode a frame that was set stays drawn — dimmed outside — so what is about
            // to be sent is never a surprise; a picture that is still whole shows no frame at all.
            val crop = state.crop
            if (!state.cropping && crop.isWhole) return@Canvas
            val rect = crop.scaledBy(size.width, size.height)
            clipRect(rect.x, rect.y, rect.right, rect.bottom, ClipOp.Difference) {
                drawRect(Color.Black.copy(alpha = 0.55f))
            }
            drawRect(
                color = Color.White.copy(alpha = 0.9f),
                topLeft = Offset(rect.x, rect.y),
                size = Size(rect.w, rect.h),
                style = Stroke(width = 1.dp.toPx()),
            )
            if (state.cropping) {
                val side = CropHandleSide.toPx()
                val inset = CropHandleInset.toPx()
                for (handle in CropHandle.entries) {
                    val centre = handleCentre(handle, rect, inset)
                    val topLeft = Offset(centre.x - side / 2f, centre.y - side / 2f)
                    drawRect(Color.White, topLeft, Size(side, side))
                    drawRect(Color.Black.copy(alpha = 0.4f), topLeft, Size(side, side), style = Stroke(width = 1.dp.toPx()))
                }
            }
        }
    }
}

/** Where a handle's square is drawn: just inside the frame, so all eight stay visible when the frame fills the picture. */
private fun handleCentre(handle: CropHandle, rect: CropRect, inset: Float): Offset {
    val x = when {
        handle.west -> rect.x + inset
        handle.east -> rect.right - inset
        else -> rect.x + rect.w / 2f
    }
    val y = when {
        handle.north -> rect.y + inset
        handle.south -> rect.bottom - inset
        else -> rect.y + rect.h / 2f
    }
    return Offset(x, y)
}

/**
 * Dragging the frame: a corner or an edge resizes it (the opposite side stays put), the inside
 * moves it, a touch anywhere else is left alone. The grab zones are generous ([CropGrabSlop]) and
 * the drag follows the finger from the very first pixel — there is no touch slop to wait out,
 * because there is nothing else here a drag could mean.
 */
private fun Modifier.cropGestures(state: EditorState): Modifier = pointerInput(Unit) {
    val slop = CropGrabSlop.toPx()
    val minSide = CropMinSide.toPx()
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val width = size.width.toFloat()
        val height = size.height.toFloat()
        val start = state.crop.scaledBy(width, height)
        val touch = cropHitTest(start, down.position.x, down.position.y, slop)
        if (touch is CropTouch.None) return@awaitEachGesture
        down.consume()
        val aspect = state.aspect
        drag(down.id) { change ->
            val dx = change.position.x - down.position.x
            val dy = change.position.y - down.position.y
            val moved = when (touch) {
                is CropTouch.Resize -> resizeCropRect(start, touch.handle, dx, dy, aspect, width, height, minSide)
                else -> moveCropRect(start, dx, dy, width, height)
            }
            state.crop = moved.dividedBy(width, height)
            change.consume()
        }
    }
}

/** A pill the editor's actions and ratios are made of: 44 dp tall, filled with the accent while [selected]. */
@Composable
private fun EditorChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    selected: Boolean = false,
) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier = modifier
            .heightIn(min = 44.dp)
            .clip(CircleShape)
            .background(if (selected) scheme.primary.copy(alpha = 0.18f) else scheme.surfaceVariant)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        Text(label, style = MaterialTheme.typography.labelLarge, color = scheme.onSurface)
    }
}

/**
 * The caption: several lines, 4000 characters at most. Enter on a hardware keyboard sends and
 * Shift+Enter breaks the line, as on web; on an on-screen keyboard Enter stays a line break, as it is
 * in every other multi-line field on the phone, and the send button is the way out.
 */
@Composable
private fun CaptionField(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    focus: FocusRequester,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val corners = LocalTailchatCorners.current
    val hint = stringResource(R.string.image_editor_caption)
    EmojiDraftField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .focusRequester(focus)
            .onPreviewKeyEvent { event ->
                val enter = event.key == Key.Enter || event.key == Key.NumPadEnter
                // An on-screen keyboard's Enter arrives as a virtual-device key; only a real keyboard sends.
                val typed = event.nativeKeyEvent.deviceId != KeyCharacterMap.VIRTUAL_KEYBOARD
                if (event.type == KeyEventType.KeyDown && enter && typed && !event.isShiftPressed) {
                    onSend()
                    true
                } else {
                    false
                }
            }
            .testTag("image_editor_caption"),
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = scheme.onSurface),
        cursorBrush = SolidColor(scheme.primary),
        maxLines = 5,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        decorationBox = { field ->
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .background(scheme.surfaceVariant, RoundedCornerShape(corners.media))
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) {
                    Text(hint, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant.copy(alpha = 0.7f))
                }
                field()
            }
        },
    )
}

/**
 * The picture at [uri], upright and screen-sized. Blocking: call it on `Dispatchers.IO`.
 * `null` when it cannot be read or is not a picture.
 */
private fun decodeForEditor(resolver: ContentResolver, uri: Uri, maxSide: Int): Bitmap? = runCatching {
    val bytes = ImageEncoder.readBytes(resolver, uri) ?: return@runCatching null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
    val orientation = orientationFromExif(ImageEncoder.exifOrientation(bytes))
    val decoded = BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply { inSampleSize = editorSampleSize(bounds.outWidth, bounds.outHeight, maxSide) },
    ) ?: return@runCatching null
    val matrix = Matrix()
    if (orientation.flipped) matrix.postScale(-1f, 1f)
    if (orientation.turns != 0) matrix.postRotate(orientation.turns * 90f)
    if (matrix.isIdentity) {
        decoded
    } else {
        Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also { decoded.recycle() }
    }
}.getOrNull()
