package net.tailchat.android.cloud

/** web's `maxlength="4000"` on the image sheet's caption field. */
const val IMAGE_CAPTION_MAX_CHARS = 4000

/**
 * Every text that means "a picture, and nothing was said about it".
 *
 * The wire carries a picture's caption in the frame's `text`, and a frame
 * always has some: when the sender left the caption empty, web writes its
 * `pastedImage` string — `🖼 [Изображение]` in Russian, `🖼 [Image]` in English
 * and French — because the APK and the terminal show `text` and the wire format
 * did not change for the image sheet. Web itself tells a caption from a
 * placeholder by checking against *every* locale's string, since the sender's
 * locale is not the reader's, and this is the same set.
 */
internal val IMAGE_PLACEHOLDER_TEXTS: Set<String> = setOf(
    "🖼 [Изображение]",
    "🖼 [Image]",
)

/**
 * The `text` of an outgoing picture: the person's caption, trimmed and held to
 * web's 4000-character ceiling, or [placeholder] when there is none — so every
 * reader, whichever client, has something to show and web recognises it as
 * "no caption" and draws the picture without a bubble.
 *
 * The ceiling never cuts a surrogate pair in half: an emoji split in the
 * middle is a lone surrogate on the wire.
 */
internal fun imageMessageText(caption: String, placeholder: String): String {
    return limitImageCaption(caption.trim()).trimEnd().ifEmpty { placeholder }
}

/** Keep typed whitespace; only bound UTF-16 length without bisecting a surrogate pair. */
internal fun limitImageCaption(caption: String): String {
    if (caption.length <= IMAGE_CAPTION_MAX_CHARS) return caption
    var end = IMAGE_CAPTION_MAX_CHARS
    if (Character.isHighSurrogate(caption[end - 1])) end -= 1
    return caption.substring(0, end)
}
