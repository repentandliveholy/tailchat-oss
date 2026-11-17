//! Inner frames: the `d` of a `frame` or `message-event` envelope.
//!
//! The server relays these from the other side, so every field a client
//! writes is untrusted here. The envelope around them (`from`, `self`) is the
//! server's own and is typed strictly; the body is typed as strictly as the
//! server's own store is (`accounts.js` `normalizeMessage`), so a relayed
//! frame and the same message read back from `sync-page` mean the same thing.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ids::{MessageId, Ts};
use crate::login::Login;

use super::lossy::{self, Lossy};
use super::num;

/// Most buttons one message may carry (`normalizeButtons`, `hub.js`).
pub const BUTTONS_MAX: usize = 8;

/// The picture types an open frame may carry (`normalizeMedia`,
/// `src/cloud/accounts.js`): exactly the server's rule.
pub const IMAGE_MIMES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/// The `mime` and standard-base64 payload of an inline picture's `dataUrl`.
fn split_image(data_url: &str) -> Option<(&'static str, &str)> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    let mime = IMAGE_MIMES
        .iter()
        .copied()
        .find(|allowed| *allowed == mime)?;
    Some((mime, payload))
}

/// The MIME type of an inline picture's `dataUrl`, when it is one the server
/// takes from an open frame.
pub(crate) fn image_mime(data_url: &str) -> Option<&'static str> {
    split_image(data_url).map(|(mime, _)| mime)
}

/// The bytes an inline picture's `dataUrl` carries: standard padded base64,
/// decoded. `None` when the URL is not one of [`IMAGE_MIMES`] or does not
/// decode.
pub(crate) fn image_bytes(data_url: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let (_, payload) = split_image(data_url)?;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()
}

/// Puts an encrypted header's picture back into the `dataUrl` form every
/// client draws: the bytes travelled as the ciphertext's blob (spec E2EE
/// §4.3). A header that does not describe a complete picture is dropped —
/// the message itself is still the message.
pub(crate) fn attach_image(content: &mut Map<String, Value>, blob: Option<&[u8]>) {
    use base64::Engine as _;
    let Some(image) = content.remove("image") else {
        return;
    };
    let Value::Object(image) = image else {
        return;
    };
    if image.contains_key("dataUrl") {
        content.insert("image".into(), Value::Object(image));
        return;
    }
    let mime = image
        .get("mime")
        .and_then(Value::as_str)
        .and_then(|mime| IMAGE_MIMES.iter().copied().find(|allowed| *allowed == mime));
    let Some((mime, blob)) = mime.zip(blob.filter(|bytes| !bytes.is_empty())) else {
        return;
    };
    let mut rebuilt = Map::new();
    rebuilt.insert(
        "dataUrl".into(),
        Value::String(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(blob)
        )),
    );
    for field in ["width", "height"] {
        if let Some(value) = image.get(field) {
            rebuilt.insert(field.into(), value.clone());
        }
    }
    content.insert("image".into(), Value::Object(rebuilt));
}

/// The `mime` and standard-base64 payload of a voice note's `dataUrl`, by the
/// server's own rule (`normalizeMedia`: `audio/<subtype>`, optional
/// `;codecs=…`).
fn split_voice(data_url: &str) -> Option<(&str, &str)> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    voice_mime_ok(mime).then_some((mime, payload))
}

/// Whether `mime` is a voice note type the server keeps.
pub fn voice_mime_ok(mime: &str) -> bool {
    let (base, codecs) = match mime.split_once(';') {
        Some((base, params)) => (base, Some(params)),
        None => (mime, None),
    };
    let Some(subtype) = base.strip_prefix("audio/") else {
        return false;
    };
    let token = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
    };
    let codecs_ok = codecs.is_none_or(|params| {
        params
            .strip_prefix("codecs=")
            .is_some_and(|c| !c.is_empty() && !c.contains([';', ',']))
    });
    token(subtype) && codecs_ok && mime.len() <= 64
}

/// The bytes a voice note's `dataUrl` carries, with its media type.
pub(crate) fn voice_bytes(data_url: &str) -> Option<(&str, Vec<u8>)> {
    use base64::Engine as _;
    let (mime, payload) = split_voice(data_url)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    Some((mime, bytes))
}

/// Puts the attachment of an encrypted header back into the `dataUrl` form:
/// a picture when the header describes one, otherwise a voice note. One
/// ciphertext carries at most one blob.
///
/// `true` when the sender sealed an attachment this core cannot put back:
/// a picture or voice note the header names but that does not rebuild, or
/// bytes after the header that nothing here describes — a newer sender's
/// form. Such a message is kept without its attachment and is not
/// acknowledged, so the sender is not told it arrived whole.
pub(crate) fn attach_media(content: &mut Map<String, Value>, blob: Option<&[u8]>) -> bool {
    let named = ["image", "voice"]
        .into_iter()
        .find(|field| content.get(*field).is_some_and(|value| !value.is_null()));
    match named {
        Some("image") => attach_image(content, blob),
        Some(_) => attach_voice(content, blob),
        None => return blob.is_some_and(|bytes| !bytes.is_empty()),
    }
    named.is_some_and(|field| !content.contains_key(field))
}

/// [`attach_image`] for a voice note: `{mime, duration, waveform}` and the
/// blob become `{dataUrl, duration, waveform}`; anything incomplete is dropped.
fn attach_voice(content: &mut Map<String, Value>, blob: Option<&[u8]>) {
    use base64::Engine as _;
    let Some(Value::Object(voice)) = content.remove("voice") else {
        return;
    };
    if voice.contains_key("dataUrl") {
        content.insert("voice".into(), Value::Object(voice));
        return;
    }
    let mime = voice
        .get("mime")
        .and_then(Value::as_str)
        .filter(|mime| voice_mime_ok(mime));
    let Some((mime, blob)) = mime.zip(blob.filter(|bytes| !bytes.is_empty())) else {
        return;
    };
    let mut rebuilt = Map::new();
    rebuilt.insert(
        "dataUrl".into(),
        Value::String(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(blob)
        )),
    );
    for field in ["duration", "waveform"] {
        if let Some(value) = voice.get(field) {
            rebuilt.insert(field.into(), value.clone());
        }
    }
    content.insert("voice".into(), Value::Object(rebuilt));
}

/// One inner frame, discriminated by `t`.
#[derive(Debug, Clone, PartialEq)]
pub enum Inner {
    /// A message from a person (`t: "msg"`).
    Message(MessageBody),
    /// A message from the assistant (`t: "ai"`).
    Ai(MessageBody),
    /// The reader's device has the message (`t: "ack"`).
    Ack(Ack),
    /// The reader has read the message (`t: "read"`).
    Read(Read),
    /// The author changed the text (`t: "edit"`).
    Edit(Edit),
    /// Messages were deleted or hidden (`t: "del"`).
    Delete(Delete),
    /// One emoji was toggled on one message (`t: "react"`).
    React(React),
    /// The peer is or is not typing (`t: "typing"`).
    Typing(Typing),
    /// A frame this core has no type for: calls, pings, file transfer, a
    /// newer client's invention. Dropped by the core, never an error.
    Unknown,
}

/// The body of a `msg` or `ai` frame, with everything a message may carry.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MessageBody {
    /// The sender's id for it; absent only from a broken client.
    #[serde(default, deserialize_with = "de_opt_message_id")]
    pub id: Option<MessageId>,
    /// The sender's time, floored to milliseconds; absent means "no time".
    #[serde(default, deserialize_with = "num::de_opt_ts")]
    pub ts: Option<Ts>,
    /// The text; anything that is not a string reads as empty.
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    /// The display name the sender claims (`author` in the store).
    #[serde(default, deserialize_with = "de_optional_string")]
    pub name: Option<String>,
    /// An inline picture.
    #[serde(default, deserialize_with = "de_media")]
    pub image: Option<Image>,
    /// An inline voice note.
    #[serde(default, deserialize_with = "de_media")]
    pub voice: Option<Voice>,
    /// The message this one quotes.
    #[serde(default, rename = "replyTo", deserialize_with = "de_media")]
    pub reply_to: Option<Reply>,
    /// Who said it before it was forwarded.
    #[serde(default, rename = "forwardedFrom", deserialize_with = "de_media")]
    pub forwarded_from: Option<Forwarded>,
    /// Inline buttons a bot offers.
    #[serde(default, rename = "buttons", deserialize_with = "de_buttons")]
    pub buttons: Lossy<Button>,
    /// The message whose text this one replaces. Read only from inside an
    /// encrypted envelope: the server refuses an open `edit` of an encrypted
    /// record, so an encrypted edit travels as a message of its own.
    #[serde(default, rename = "editOf", deserialize_with = "de_opt_message_id")]
    pub edit_of: Option<MessageId>,
    /// The `e2ee` envelope of an encrypted message, in place of the content.
    #[serde(default)]
    pub e2ee: Option<serde_json::Value>,
}

impl MessageBody {
    /// A body with nothing in it: the content of a row that could not be read.
    pub(crate) fn empty() -> Self {
        Self {
            id: None,
            ts: None,
            text: String::new(),
            name: None,
            image: None,
            voice: None,
            reply_to: None,
            forwarded_from: None,
            buttons: Lossy {
                items: Vec::new(),
                skipped: 0,
            },
            edit_of: None,
            e2ee: None,
        }
    }

    /// The conversation row this body becomes.
    pub(crate) fn into_message(
        self,
        peer: Login,
        id: MessageId,
        from: Login,
        ts: Ts,
        kind: crate::api::MessageKind,
        protection: crate::api::Protection,
    ) -> crate::api::Message {
        crate::api::Message {
            peer,
            id,
            from,
            ts,
            kind,
            text: self.text,
            author: self.name,
            image: self.image,
            voice: self.voice,
            reply_to: self.reply_to,
            forwarded_from: self.forwarded_from,
            buttons: self.buttons.items,
            edit_of: self.edit_of,
            media_dropped: false,
            edited_at: None,
            reactions: Vec::new(),
            protection,
        }
    }
}

/// An inline picture, as the sender embedded it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Image {
    /// The `data:` URL itself.
    #[serde(rename = "dataUrl")]
    pub data_url: String,
    /// Width the sender claims, in pixels.
    #[serde(default, deserialize_with = "num::de_opt_i64")]
    pub width: Option<i64>,
    /// Height the sender claims, in pixels.
    #[serde(default, deserialize_with = "num::de_opt_i64")]
    pub height: Option<i64>,
}

/// An inline voice note.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Voice {
    /// The `data:` URL itself.
    #[serde(rename = "dataUrl")]
    pub data_url: String,
    /// Length in seconds, as the sender measured it.
    #[serde(default, deserialize_with = "de_optional_f64")]
    pub duration: Option<f64>,
    /// Loudness bars, 0–255 each, as the sender drew them; only an encrypted
    /// header carries them.
    #[serde(default, deserialize_with = "de_waveform")]
    pub waveform: Option<Vec<u8>>,
}

/// Bars a waveform keeps at most.
pub const WAVEFORM_MAX: usize = 128;

/// Reads a waveform: a list of 0–255 integers, cut to [`WAVEFORM_MAX`];
/// anything else reads as absent.
fn de_waveform<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<u8>>, D::Error> {
    let raw: Option<Vec<Value>> = lossy::lenient(deserializer)?;
    Ok(raw.and_then(|values| {
        values
            .iter()
            .take(WAVEFORM_MAX)
            .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect()
    }))
}

/// A quoted message: a snapshot, not a live reference (`normalizeReplyTo`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Reply {
    /// The quoted message's id.
    pub id: MessageId,
    /// Who wrote it.
    pub from: Login,
    /// Its text, as the sender quoted it (the server keeps 200 characters).
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    /// What kind of attachment it had, if any.
    #[serde(default, deserialize_with = "de_media")]
    pub media: Option<MediaKind>,
}

/// Who a forwarded message came from before.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Forwarded {
    /// Their login, when the forwarder knows it.
    #[serde(default, deserialize_with = "de_optional_login")]
    pub login: Option<Login>,
    /// The name they were shown under, when the forwarder knows it.
    #[serde(default, deserialize_with = "de_optional_string")]
    pub name: Option<String>,
}

/// One inline button of a bot message.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Button {
    /// What the button is called back by.
    pub id: String,
    /// What it says.
    pub label: String,
    /// What pressing it sends.
    pub value: String,
}

/// What kind of attachment a reply snapshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    /// A picture.
    Image,
    /// A voice note.
    Voice,
    /// A file.
    File,
}

/// `t: "ack"`: the reader's device holds the message.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Ack {
    /// Which message.
    pub id: MessageId,
    /// How far the reader's device has the conversation; the server attaches
    /// it, so a receipt for an older message still moves the watermark.
    #[serde(default, rename = "deliveredTs", deserialize_with = "num::de_opt_ts")]
    pub delivered_ts: Option<Ts>,
}

/// `t: "read"`: the reader has seen the message.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Read {
    /// Which message.
    pub id: MessageId,
    /// How far the reader has read the conversation.
    #[serde(default, rename = "readTs", deserialize_with = "num::de_opt_ts")]
    pub read_ts: Option<Ts>,
    /// When the reader got there, in the reader's wall clock.
    #[serde(default, rename = "readAt", deserialize_with = "num::de_opt_ts")]
    pub read_at: Option<Ts>,
    /// The kind of client that read it: `web`, `cli`, `android/<build>`.
    #[serde(default, deserialize_with = "de_optional_string")]
    pub via: Option<String>,
}

/// `t: "edit"`: the author changed the text.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Edit {
    /// Which message.
    pub id: MessageId,
    /// The new text.
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    /// When it was edited. The server builds this frame from a record that
    /// does not carry the field (`commitEdit`), so it is usually absent.
    #[serde(default, rename = "editedAt", deserialize_with = "num::de_opt_ts")]
    pub edited_at: Option<Ts>,
}

/// `t: "del"`: messages were deleted for both sides or hidden for one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Delete {
    /// Which messages. The server has already cut the list to
    /// [`super::DELETE_IDS_MAX`]; ids that are not usable are dropped.
    #[serde(default, deserialize_with = "de_message_ids")]
    pub ids: Lossy<MessageId>,
    /// Whose copy goes.
    #[serde(default)]
    pub scope: Option<Scope>,
    /// Whether the message is gone from the server for both sides
    /// (`tombstone`, `commitDelete`).
    #[serde(default)]
    pub tombstone: bool,
}

/// Whose copy of a deleted message goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scope {
    /// Both sides: the record is gone from the server.
    #[serde(rename = "all")]
    All,
    /// Only this account's copy is hidden; the peer keeps theirs.
    #[serde(rename = "self")]
    SelfOnly,
}

impl Delete {
    /// The scope, with the server's own default: a frame that names none is
    /// "for everybody" (`d.scope === 'self' ? 'self' : 'all'`).
    pub fn scope(&self) -> Scope {
        self.scope.unwrap_or(Scope::All)
    }
}

/// `t: "react"`: one emoji was toggled on one message.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct React {
    /// Which message.
    pub id: MessageId,
    /// The emoji itself.
    #[serde(default, deserialize_with = "de_text")]
    pub emoji: String,
    /// Who reacted.
    pub by: Login,
    /// `true` adds, `false` removes; absent means add (`d.add !== false`).
    #[serde(default = "default_true")]
    pub add: bool,
}

/// `t: "typing"`: the peer is or is not composing.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Typing {
    /// Started or stopped.
    #[serde(default, deserialize_with = "de_typing_state")]
    pub state: TypingState,
    /// What to sign the indicator with.
    #[serde(default, deserialize_with = "de_optional_string")]
    pub name: Option<String>,
}

/// Whether a `typing` frame started or stopped the indicator.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TypingState {
    /// Started composing.
    Start,
    /// Stopped composing.
    #[default]
    Stop,
}

impl<'de> Deserialize<'de> for Inner {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        /// The same wire shape, with a unit fallback for unknown `t`, because
        /// serde cannot carry the tag into `#[serde(other)]`.
        #[derive(Deserialize)]
        #[serde(tag = "t")]
        enum Repr {
            #[serde(rename = "msg")]
            Message(MessageBody),
            #[serde(rename = "ai")]
            Ai(MessageBody),
            #[serde(rename = "ack")]
            Ack(Ack),
            #[serde(rename = "read")]
            Read(Read),
            #[serde(rename = "edit")]
            Edit(Edit),
            #[serde(rename = "del")]
            Delete(Delete),
            #[serde(rename = "react")]
            React(React),
            #[serde(rename = "typing")]
            Typing(Typing),
            #[serde(other)]
            Unknown,
        }

        Ok(match Repr::deserialize(deserializer)? {
            Repr::Message(body) => Self::Message(body),
            Repr::Ai(body) => Self::Ai(body),
            Repr::Ack(ack) => Self::Ack(ack),
            Repr::Read(read) => Self::Read(read),
            Repr::Edit(edit) => Self::Edit(edit),
            Repr::Delete(delete) => Self::Delete(delete),
            Repr::React(react) => Self::React(react),
            Repr::Typing(typing) => Self::Typing(typing),
            Repr::Unknown => Self::Unknown,
        })
    }
}

/// Whether `value` is `true`; the default of a `react`'s `add`.
fn default_true() -> bool {
    true
}

/// Reads a string, or empty when it is anything else.
pub(crate) fn de_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(de_optional_string(deserializer)?.unwrap_or_default())
}

/// Reads a string, or `None` when it is missing or anything else.
pub(crate) fn de_optional_string<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    lossy::lenient(deserializer)
}

/// Reads a name and a login only when both are usable.
pub(crate) fn de_optional_login<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Login>, D::Error> {
    let Some(raw) = de_optional_string(deserializer)? else {
        return Ok(None);
    };
    Ok(Login::parse(&raw).ok())
}

/// Reads a message id only when it is one.
pub(crate) fn de_opt_message_id<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MessageId>, D::Error> {
    let Some(raw) = de_optional_string(deserializer)? else {
        return Ok(None);
    };
    Ok(MessageId::parse(&raw).ok())
}

/// Reads a list of message ids, dropping the ones that are not ids.
pub(crate) fn de_message_ids<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Lossy<MessageId>, D::Error> {
    let raw = Lossy::<String>::deserialize(deserializer)?;
    let mut ids = Lossy::<MessageId>::new();
    ids.skipped = raw.skipped;
    for id in raw.items {
        match MessageId::parse(&id) {
            Ok(id) => ids.items.push(id),
            Err(_) => ids.skipped = ids.skipped.saturating_add(1),
        }
    }
    Ok(ids)
}

/// Reads `width`, `height`, `duration`, `replyTo`, `forwardedFrom` or `media`
/// from one field: a value of the wrong shape reads as absent, because a
/// picture the sender described badly must not cost the message.
pub(crate) fn de_media<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct MaybeVisitor<T>(std::marker::PhantomData<T>);

    impl<'de, T: Deserialize<'de>> de::Visitor<'de> for MaybeVisitor<T> {
        type Value = Option<T>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an optional object")
        }

        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D2: Deserializer<'de>>(
            self,
            deserializer: D2,
        ) -> Result<Self::Value, D2::Error> {
            Ok(T::deserialize(deserializer).ok())
        }
    }

    deserializer.deserialize_option(MaybeVisitor(std::marker::PhantomData))
}

/// Reads a fractional number, or `None`.
fn de_optional_f64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    lossy::lenient(deserializer)
}

/// Reads the `buttons` list, cutting it to [`BUTTONS_MAX`] entries.
pub(crate) fn de_buttons<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Lossy<Button>, D::Error> {
    let mut buttons = Lossy::<Button>::deserialize(deserializer)?;
    buttons.items.truncate(BUTTONS_MAX);
    Ok(buttons)
}

/// Reads `start` and `stop`; anything else, and nothing at all, is `stop`
/// (the web client's own reading of the frame).
fn de_typing_state<'de, D: Deserializer<'de>>(deserializer: D) -> Result<TypingState, D::Error> {
    let Some(raw) = de_optional_string(deserializer)? else {
        return Ok(TypingState::Stop);
    };
    Ok(if raw == "start" {
        TypingState::Start
    } else {
        TypingState::Stop
    })
}

impl<'de> Deserialize<'de> for MediaKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match de_optional_string(deserializer)?.as_deref() {
            Some("image") => Ok(Self::Image),
            Some("voice") => Ok(Self::Voice),
            Some("file") => Ok(Self::File),
            // The store only ever writes those three; anything else is a
            // reply whose attachment kind we cannot draw. `file` is the one
            // that shows nothing but a name, which is the safe reading.
            _ => Ok(Self::File),
        }
    }
}
