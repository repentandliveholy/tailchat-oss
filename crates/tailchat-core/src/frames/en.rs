//! Our frames: every envelope the core writes, in the server's own JSON.
//!
//! Each encoder returns the finished JSON text, checked against
//! [`MAX_OUTBOUND`] before the driver sees it: the server refuses a bigger
//! frame (`CLOUD_FRAME_MAX_CHARS`) and the core should not spend a socket
//! write to find that out. Nothing here allocates more than the text it
//! returns; the structs borrow from their arguments.

use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};

use crate::api::Outgoing;
use crate::error::CoreError;
use crate::ids::{MessageId, Seq};
use crate::login::Login;
use crate::platform::Token;

use super::DELETE_IDS_MAX;
use super::inner::Scope;
use super::server::PresenceState;
use super::sync::SYNC_PAGE_MAX;
use super::{MAX_OUTBOUND, MAX_SEALED};

/// What this client supports; the server answers accordingly
/// (`addressed-send` lets us send without a `subscribe`, `sync-nudge-v1`
/// gets a `sync-nudge` whenever this account's feed moves).
pub const CAPS: &[&str] = &["durable-ack", "addressed-send", "sync-nudge-v1"];

/// `{"k":"auth"}`: the first frame on every connection.
#[derive(Serialize)]
struct Auth<'a> {
    /// The envelope name.
    k: &'static str,
    /// The bearer token, as the server issued it.
    token: &'a str,
    /// Built-in capabilities followed by valid, unique extras.
    caps: Capabilities<'a>,
    /// The browser's flag: the server tells web sessions apart by it (client
    /// kind, reaction events, multi-session sync). Absent for every other
    /// client, exactly as before.
    #[serde(rename = "webFeatures", skip_serializing_if = "std::ops::Not::not")]
    web_features: bool,
}

struct Capabilities<'a>(&'a [String]);

impl Serialize for Capabilities<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        for cap in CAPS {
            seq.serialize_element(cap)?;
        }
        for (index, cap) in self.0.iter().enumerate() {
            if !cap.is_empty()
                && cap.len() <= 64
                && cap
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !CAPS.contains(&cap.as_str())
                && !self.0.iter().take(index).any(|previous| previous == cap)
            {
                seq.serialize_element(cap)?;
            }
        }
        seq.end()
    }
}

/// `{"k":"subscribe","peer":…}`: the conversation this socket shows.
///
/// An empty peer unsubscribes (`receive`, `hub.js`).
#[derive(Serialize)]
struct Subscribe<'a> {
    /// The envelope name.
    k: &'static str,
    /// Who, or `""` for nobody.
    peer: &'a str,
}

/// `{"k":"frame","to":…,"d":…}`: wraps one inner frame for one peer.
#[derive(Serialize)]
struct Envelope<'a, T> {
    /// The envelope name.
    k: &'static str,
    /// The peer whose conversation it belongs to.
    to: &'a str,
    /// The inner frame.
    d: T,
}

impl<'a, T> Envelope<'a, T> {
    /// The envelope for `to`.
    fn new(to: &'a str, d: T) -> Self {
        Self { k: "frame", to, d }
    }
}

/// `{"t":"msg"}`: a text message, with a picture when there is one.
#[derive(Serialize)]
struct Msg<'a> {
    /// The inner frame type.
    t: &'static str,
    /// The message id the driver made.
    id: &'a str,
    /// When it was written.
    ts: i64,
    /// The text; empty for a picture without a caption.
    text: &'a str,
    /// The picture inline, as the server's store takes it (`normalizeMedia`).
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<ImageWire<'a>>,
    /// A voice note inline, as `normalizeMedia` takes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<VoiceWire<'a>>,
    /// The quote (`normalizeReplyTo`).
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none")]
    reply_to: Option<ReplyWire<'a>>,
    /// The forward label (`normalizeForwardedFrom`).
    #[serde(rename = "forwardedFrom", skip_serializing_if = "Option::is_none")]
    forwarded_from: Option<ForwardWire<'a>>,
}

/// `{"dataUrl":…,"duration":…}`: a voice note of an open frame, duration in
/// seconds as every client writes it.
#[derive(Serialize)]
struct VoiceWire<'a> {
    /// The `data:` URL itself.
    #[serde(rename = "dataUrl")]
    data_url: &'a str,
    /// Seconds.
    duration: f64,
}

/// `{"id","from","text","media"}`: a quote, as `normalizeReplyTo` keeps it.
#[derive(Serialize)]
pub(crate) struct ReplyWire<'a> {
    /// The quoted message.
    id: &'a str,
    /// Its author.
    from: &'a str,
    /// Its text.
    text: &'a str,
    /// Its attachment kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    media: Option<&'static str>,
}

/// `{"login","name"}`: who said a forwarded message first.
#[derive(Serialize)]
pub(crate) struct ForwardWire<'a> {
    /// Their login.
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<&'a str>,
    /// Their name.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
}

/// Characters of a quote's text the server keeps (`normalizeReplyTo`).
pub const REPLY_TEXT_MAX: usize = 200;

impl<'a> ReplyWire<'a> {
    /// The wire form of `reply`, its text cut where the server cuts it.
    pub(crate) fn of(reply: &'a crate::frames::inner::Reply) -> Self {
        let end = reply
            .text
            .char_indices()
            .nth(REPLY_TEXT_MAX)
            .map_or(reply.text.len(), |(at, _)| at);
        Self {
            id: reply.id.as_str(),
            from: reply.from.as_str(),
            text: &reply.text[..end],
            media: reply.media.map(|kind| match kind {
                crate::frames::inner::MediaKind::Image => "image",
                crate::frames::inner::MediaKind::Voice => "voice",
                crate::frames::inner::MediaKind::File => "file",
            }),
        }
    }
}

impl<'a> ForwardWire<'a> {
    /// The wire form of `forwarded`.
    pub(crate) fn of(forwarded: &'a crate::frames::inner::Forwarded) -> Self {
        Self {
            login: forwarded.login.as_ref().map(Login::as_str),
            name: forwarded.name.as_deref(),
        }
    }
}

/// `{"dataUrl":…,"width":…,"height":…}`: one inline picture of an open frame.
#[derive(Serialize)]
struct ImageWire<'a> {
    /// The `data:` URL itself.
    #[serde(rename = "dataUrl")]
    data_url: &'a str,
    /// Width the sender claims, in pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    /// Height the sender claims, in pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
}

impl<'a> ImageWire<'a> {
    /// The wire form of `image`.
    fn of(image: &'a crate::frames::inner::Image) -> Self {
        Self {
            data_url: &image.data_url,
            width: image.width,
            height: image.height,
        }
    }
}

/// `{"t":"ack"}` or `{"t":"read"}`: a receipt for one message.
#[derive(Serialize)]
struct Receipt<'a> {
    /// The inner frame type.
    t: &'static str,
    /// The message.
    id: &'a str,
}

/// `{"t":"edit"}`: a new text for a message we wrote.
#[derive(Serialize)]
struct Edit<'a> {
    /// The inner frame type.
    t: &'static str,
    /// The message.
    id: &'a str,
    /// The new text.
    text: &'a str,
    /// The client's id for this operation, when the caller has one.
    #[serde(rename = "opId", skip_serializing_if = "Option::is_none")]
    op_id: Option<&'a str>,
}

/// `{"t":"del"}`: delete for both sides, or hide for ours.
#[derive(Serialize)]
struct Delete<'a> {
    /// The inner frame type.
    t: &'static str,
    /// The messages, at most [`DELETE_IDS_MAX`].
    #[serde(serialize_with = "serialize_ids")]
    ids: &'a [MessageId],
    /// Whose copy goes.
    scope: Scope,
    /// The client's id for this operation, when the caller has one.
    #[serde(rename = "opId", skip_serializing_if = "Option::is_none")]
    op_id: Option<&'a str>,
}

/// `{"t":"react"}`: toggle one emoji on one message.
#[derive(Serialize)]
struct React<'a> {
    /// The inner frame type.
    t: &'static str,
    /// The message.
    id: &'a str,
    /// The emoji.
    emoji: &'a str,
    /// Whether to add or remove it.
    add: bool,
    /// The client's id for this operation, when the caller has one.
    #[serde(rename = "opId", skip_serializing_if = "Option::is_none")]
    op_id: Option<&'a str>,
}

/// `{"t":"typing"}`: the two halves of the composer indicator.
#[derive(Serialize)]
struct Typing<'a> {
    /// The inner frame type.
    t: &'static str,
    /// `start` or `stop`.
    state: &'static str,
    /// What the peer signs the indicator with.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
}

/// `{"k":"sync"}`: ask for the account feed from a cursor.
#[derive(Serialize)]
struct Sync {
    /// The envelope name.
    k: &'static str,
    /// The last event already applied.
    since: i64,
    /// How many events to ask for, at most [`SYNC_PAGE_MAX`].
    limit: usize,
}

/// `{"k":"mark-read","peer":…}`: mark a whole conversation read.
#[derive(Serialize)]
struct MarkRead<'a> {
    /// The envelope name.
    k: &'static str,
    /// The conversation.
    peer: &'a str,
}

/// `{"k":"state","state":…}`: how present this client is.
#[derive(Serialize)]
struct State {
    /// The envelope name.
    k: &'static str,
    /// `active`, `idle` or `away`.
    state: &'static str,
}

/// The `auth` frame for this token and our capabilities.
pub fn auth(token: &Token) -> Result<String, CoreError> {
    auth_with(token, &[])
}

/// The `auth` frame with valid, unique extra capabilities appended.
pub fn auth_with(token: &Token, extra: &[String]) -> Result<String, CoreError> {
    auth_for(token, extra, false)
}

/// The `auth` frame, also saying `webFeatures: true` when the client is the
/// browser.
pub fn auth_for(token: &Token, extra: &[String], web_features: bool) -> Result<String, CoreError> {
    encode(&Auth {
        k: "auth",
        token: token.expose(),
        caps: Capabilities(extra),
        web_features,
    })
}

/// `subscribe` to `peer`: the conversation this socket is showing.
pub fn subscribe(peer: &Login) -> Result<String, CoreError> {
    encode(&Subscribe {
        k: "subscribe",
        peer: peer.as_str(),
    })
}

/// `subscribe` to nobody: this socket is back on the roster.
pub fn unsubscribe() -> Result<String, CoreError> {
    encode(&Subscribe {
        k: "subscribe",
        peer: "",
    })
}

/// The frame that sends `message`, refused if it would break the server's limit.
pub fn msg(message: &Outgoing) -> Result<String, CoreError> {
    encode(&Envelope::new(
        message.peer.as_str(),
        Msg {
            t: "msg",
            id: message.id.as_str(),
            ts: message.ts.0,
            text: &message.text,
            image: message.image.as_ref().map(ImageWire::of),
            voice: message.extra.voice.as_ref().map(|voice| VoiceWire {
                data_url: &voice.data_url,
                duration: f64::from(voice.duration_ms) / 1000.0,
            }),
            reply_to: message.extra.reply_to.as_ref().map(ReplyWire::of),
            forwarded_from: message.extra.forwarded_from.as_ref().map(ForwardWire::of),
        },
    ))
}

/// `{"t":"msg"}` of an encrypted message: the envelope instead of the text.
#[derive(Serialize)]
struct SealedMsg<'a> {
    /// The inner frame type.
    t: &'static str,
    /// The message id the driver made.
    id: &'a str,
    /// When it was written.
    ts: i64,
    /// `{v, dev, sid, ct}`.
    e2ee: serde_json::Value,
    /// `true` on an encrypted edit: the one bit the server needs so that an
    /// edit is neither an unread message nor a push (`isSealedEdit`,
    /// `src/cloud/e2ee.js`). The target and the words stay inside `e2ee`;
    /// a reader trusts only the `editOf` it decrypts, never this flag.
    #[serde(rename = "sealedEdit", skip_serializing_if = "std::ops::Not::not")]
    sealed_edit: bool,
}

/// The frame that sends `message` encrypted as `envelope`: no `text` beside
/// it, the server refuses one that carries both (`bad_envelope`).
pub fn msg_sealed(
    message: &Outgoing,
    envelope: &crate::api::Envelope,
) -> Result<String, CoreError> {
    encode_at(
        &Envelope::new(
            message.peer.as_str(),
            SealedMsg {
                t: "msg",
                id: message.id.as_str(),
                ts: message.ts.0,
                e2ee: super::e2ee::envelope_json(envelope),
                sealed_edit: message.extra.edit_of.is_some(),
            },
        ),
        MAX_SEALED,
    )
}

/// Room the cipher's MAC and signature take in a ciphertext, and the frame
/// keys around `ct`: a bound, not a measurement.
const SEAL_TAIL: usize = 256;
/// Room a `msg` frame takes around its ciphertext: `k`, `to`, `d.t`, `id`,
/// `ts`, and the envelope's `v`, `dev` and `sid`.
pub const SEALED_FRAME_TAIL: usize = 512;

/// How many characters an encrypted message's `ct` takes when the plaintext
/// inside it (header JSON plus attachment bytes) is `plaintext_len` bytes:
/// unpadded base64 of the plaintext plus the MAC and signature. Refusing what
/// [`sealed_frame_chars`] says will not fit [`MAX_SEALED`] is the one size
/// rule an encrypted frame has.
pub fn sealed_chars(plaintext_len: usize) -> usize {
    base64::encoded_len(plaintext_len.saturating_add(SEAL_TAIL), false).unwrap_or(usize::MAX)
}

/// The characters a `msg` frame takes on the wire around `ct_chars` of
/// ciphertext.
pub fn sealed_frame_chars(ct_chars: usize) -> usize {
    ct_chars.saturating_add(SEALED_FRAME_TAIL)
}

/// `ack`: the peer's device holds `id`.
pub fn ack(to: &Login, id: &MessageId) -> Result<String, CoreError> {
    encode(&Envelope::new(
        to.as_str(),
        Receipt {
            t: "ack",
            id: id.as_str(),
        },
    ))
}

/// `read`: the peer has read `id`.
pub fn read(to: &Login, id: &MessageId) -> Result<String, CoreError> {
    encode(&Envelope::new(
        to.as_str(),
        Receipt {
            t: "read",
            id: id.as_str(),
        },
    ))
}

/// `edit`: a new text for a message of ours.
pub fn edit(
    to: &Login,
    id: &MessageId,
    text: &str,
    op_id: Option<&str>,
) -> Result<String, CoreError> {
    encode(&Envelope::new(
        to.as_str(),
        Edit {
            t: "edit",
            id: id.as_str(),
            text,
            op_id,
        },
    ))
}

/// `del`: delete `ids` for both sides (`scope: all`) or mute them for ours
/// (`scope: self`).
///
/// A `del` must name at least one message and at most [`DELETE_IDS_MAX`]: the
/// server silently drops an empty list and silently cuts a longer one, so a
/// caller that got either wrong would be told it worked when it did not.
pub fn del(
    to: &Login,
    ids: &[MessageId],
    scope: Scope,
    op_id: Option<&str>,
) -> Result<String, CoreError> {
    if ids.is_empty() || ids.len() > DELETE_IDS_MAX {
        return Err(CoreError::InvalidIdCount {
            count: ids.len(),
            max: DELETE_IDS_MAX,
        });
    }
    encode(&Envelope::new(
        to.as_str(),
        Delete {
            t: "del",
            ids,
            scope,
            op_id,
        },
    ))
}

/// `react`: toggle `emoji` on a message.
pub fn react(
    to: &Login,
    id: &MessageId,
    emoji: &str,
    add: bool,
    op_id: Option<&str>,
) -> Result<String, CoreError> {
    encode(&Envelope::new(
        to.as_str(),
        React {
            t: "react",
            id: id.as_str(),
            emoji,
            add,
            op_id,
        },
    ))
}

/// `typing`: `state` is whether the composer is being used right now.
pub fn typing(to: &Login, start: bool, name: Option<&str>) -> Result<String, CoreError> {
    encode(&Envelope::new(
        to.as_str(),
        Typing {
            t: "typing",
            state: if start { "start" } else { "stop" },
            name,
        },
    ))
}

/// `sync`: the account feed from `since`, at most [`SYNC_PAGE_MAX`] events.
///
/// The server clamps both (`eventsSince`), so this clamps them the same way
/// instead of sending a request whose answer the caller did not ask for.
pub fn sync(since: Seq, limit: usize) -> Result<String, CoreError> {
    let limit = limit.clamp(1, SYNC_PAGE_MAX);
    encode(&Sync {
        k: "sync",
        since: since.0.max(0),
        limit,
    })
}

/// `mark-read`: the whole conversation with `peer` is read.
pub fn mark_read(peer: &Login) -> Result<String, CoreError> {
    encode(&MarkRead {
        k: "mark-read",
        peer: peer.as_str(),
    })
}

/// `state`: how present this client is.
pub fn state(state: PresenceState) -> Result<String, CoreError> {
    encode(&State {
        k: "state",
        state: state.as_str(),
    })
}

/// Serializes one frame and refuses it if the server would.
fn encode<T: Serialize>(frame: &T) -> Result<String, CoreError> {
    encode_at(frame, MAX_OUTBOUND)
}

/// Serializes one frame and refuses it if it is over `max` characters.
fn encode_at<T: Serialize>(frame: &T, max: usize) -> Result<String, CoreError> {
    let json =
        serde_json::to_string(frame).map_err(|error| CoreError::BadFrame(error.to_string()))?;
    if json.len() > max {
        return Err(CoreError::FrameTooLarge {
            len: json.len(),
            max,
        });
    }
    Ok(json)
}

/// Writes a list of message ids as plain strings.
fn serialize_ids<S: Serializer>(ids: &[MessageId], serializer: S) -> Result<S::Ok, S::Error> {
    let mut seq = serializer.serialize_seq(Some(ids.len()))?;
    for id in ids {
        seq.serialize_element(id.as_str())?;
    }
    seq.end()
}
