//! Conversation messages: Megolm (`docs/specs/2026-11-04-e2ee.md` §4.3).
//!
//! Each sending device has one outbound session per conversation; its key
//! travels over Olm to every recipient device, which records who sent it and
//! for which conversation. The plaintext repeats `from`, `to`, `id` and
//! `kind` of the frame around it, so the server can neither move a
//! ciphertext to another conversation or id nor pass an edit off as a
//! message; the receiver remembers which id each message index carried, so
//! it cannot replay one either.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use vodozemac::megolm::{
    ExportedSessionKey, GroupSession, GroupSessionPickle, InboundGroupSession,
    InboundGroupSessionPickle, MegolmMessage, SessionConfig, SessionKey,
};
use zeroize::Zeroizing;

use crate::pickle::{from_pickle, to_pickle};
use crate::{Account, CrossSigningPublic, CryptoError, DeviceKeys, DeviceKind, Undecryptable};

/// Messages one outbound session encrypts before it is replaced.
pub const ROTATE_AFTER_MESSAGES: u32 = 100;
/// Age at which an outbound session is replaced, in milliseconds (7 days).
pub const ROTATE_AFTER_MS: u64 = 7 * 24 * 60 * 60 * 1000;

const ENVELOPE_VERSION: u64 = 1;
const PLAINTEXT_VERSION: u8 = 1;
const RESERVED: [&str; 4] = ["from", "to", "id", "kind"];

/// The Megolm version Matrix runs (see `olm::config`).
fn config() -> SessionConfig {
    SessionConfig::version_1()
}

/// The two logins of a one-to-one conversation, in order. Both may be the
/// same login: a conversation with oneself exists (`addressed-send`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "[String; 2]", into = "[String; 2]")]
pub struct Conversation {
    low: String,
    high: String,
}

impl Conversation {
    /// The conversation between `a` and `b`, either order.
    pub fn new(a: &str, b: &str) -> Self {
        let (low, high) = if a <= b { (a, b) } else { (b, a) };
        Self {
            low: low.to_owned(),
            high: high.to_owned(),
        }
    }

    /// Whether `login` is one of the two.
    pub fn contains(&self, login: &str) -> bool {
        self.low == login || self.high == login
    }
}

impl From<[String; 2]> for Conversation {
    fn from([a, b]: [String; 2]) -> Self {
        Self::new(&a, &b)
    }
}

impl From<Conversation> for [String; 2] {
    fn from(c: Conversation) -> Self {
        [c.low, c.high]
    }
}

/// The frame kind a ciphertext was written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    /// A new message.
    Msg,
    /// A new text for an earlier message of the same account.
    Edit,
    /// A message forwarded from another conversation.
    Forward,
}

impl MessageKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Msg => "msg",
            Self::Edit => "edit",
            Self::Forward => "forward",
        }
    }
}

/// The frame around a ciphertext: what the server routes by.
#[derive(Debug, Clone, Copy)]
pub struct Frame<'a> {
    /// Author login.
    pub from: &'a str,
    /// Recipient login.
    pub to: &'a str,
    /// Message id (an edit carries the id of the message it edits).
    pub id: &'a str,
    /// Frame kind.
    pub kind: MessageKind,
}

/// `e2ee` of a `msg` frame: `{v: 1, dev, sid, ct}` (§4.3, §8.1).
///
/// `dev` and `sid` are lookup hints the server could change; the session
/// found with them is checked against both, and against the frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// The sending device.
    pub dev: String,
    /// The Megolm session id.
    pub sid: String,
    /// The Megolm message, unpadded base64.
    pub ct: String,
}

impl Envelope {
    /// The wire form.
    pub fn to_json(&self) -> Value {
        json!({"v": ENVELOPE_VERSION, "dev": self.dev, "sid": self.sid, "ct": self.ct})
    }

    /// Parse the wire form.
    ///
    /// # Errors
    /// [`Undecryptable::Malformed`] for another version or shape.
    pub fn from_json(value: &Value) -> Result<Self, Undecryptable> {
        if value.get("v").and_then(Value::as_u64) != Some(ENVELOPE_VERSION) {
            return Err(Undecryptable::Malformed);
        }
        let text = |field| {
            value
                .get(field)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(Undecryptable::Malformed)
        };
        Ok(Self {
            dev: text("dev")?,
            sid: text("sid")?,
            ct: text("ct")?,
        })
    }
}

/// A decrypted message.
#[derive(Debug, Clone, PartialEq)]
pub struct Decrypted {
    /// The former `d` of the frame without `t` (`text`, `replyTo`, …).
    pub content: Map<String, Value>,
    /// Attachment bytes, when the message carried any.
    pub blob: Option<Vec<u8>>,
    /// The Megolm message index: later edits of one message have higher ones.
    pub index: u32,
}

/// A conversation's session key, as one device sends it to another.
pub struct RoomKey {
    conversation: Conversation,
    session_id: String,
    session_key: Zeroizing<String>,
}

impl std::fmt::Debug for RoomKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomKey")
            .field("conversation", &self.conversation)
            .field("session_id", &self.session_id)
            .field("session_key", &"[redacted]")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoomKeyWire {
    conversation: Conversation,
    session_id: String,
    session_key: Zeroizing<String>,
}

impl RoomKey {
    pub(crate) fn wire(&self) -> RoomKeyWire {
        RoomKeyWire {
            conversation: self.conversation.clone(),
            session_id: self.session_id.clone(),
            session_key: self.session_key.clone(),
        }
    }

    pub(crate) fn from_wire(wire: RoomKeyWire) -> Self {
        Self {
            conversation: wire.conversation,
            session_id: wire.session_id,
            session_key: wire.session_key,
        }
    }

    /// The conversation it is for.
    pub fn conversation(&self) -> &Conversation {
        &self.conversation
    }

    /// The Megolm session id.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

/// A session key as it came out of Olm: bound to the device that sent it.
/// Only [`crate::OlmChannel::decrypt`] makes one.
#[derive(Debug)]
pub struct ReceivedRoomKey {
    sender: DeviceKeys,
    key: RoomKey,
}

impl ReceivedRoomKey {
    pub(crate) fn new(sender: DeviceKeys, key: RoomKey) -> Self {
        Self { sender, key }
    }

    /// The device it verifiably came from.
    pub fn sender(&self) -> &DeviceKeys {
        &self.sender
    }

    /// The key.
    pub fn key(&self) -> &RoomKey {
        &self.key
    }
}

/// A request to another cross-signed device of the same account to forward a
/// Megolm session key (§4.2, §4.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomKeyRequest {
    /// The conversation the session belongs to.
    pub conversation: Conversation,
    /// The account that created the session.
    pub sender: String,
    /// The device that created the session.
    pub sender_device: String,
    /// The Megolm session id.
    pub session_id: String,
}

/// A conversation's session key exported from an [`InboundGroup`] to be
/// forwarded to another cross-signed device of the same account (§4.2).
pub struct ForwardedRoomKey {
    conversation: Conversation,
    sender: DeviceKeys,
    session_id: String,
    session_key: Zeroizing<String>,
}

impl std::fmt::Debug for ForwardedRoomKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForwardedRoomKey")
            .field("conversation", &self.conversation)
            .field("sender", &self.sender)
            .field("session_id", &self.session_id)
            .field("session_key", &"[redacted]")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForwardedRoomKeyWire {
    conversation: Conversation,
    sender: DeviceKeys,
    session_id: String,
    session_key: Zeroizing<String>,
}

impl ForwardedRoomKey {
    pub(crate) fn wire(&self) -> ForwardedRoomKeyWire {
        ForwardedRoomKeyWire {
            conversation: self.conversation.clone(),
            sender: self.sender.clone(),
            session_id: self.session_id.clone(),
            session_key: self.session_key.clone(),
        }
    }

    pub(crate) fn from_wire(wire: ForwardedRoomKeyWire) -> Self {
        Self {
            conversation: wire.conversation,
            sender: wire.sender,
            session_id: wire.session_id,
            session_key: wire.session_key,
        }
    }

    /// The conversation it is for.
    pub fn conversation(&self) -> &Conversation {
        &self.conversation
    }

    /// The original sending device of the session.
    pub fn sender(&self) -> &DeviceKeys {
        &self.sender
    }

    /// The Megolm session id.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

/// A [`ForwardedRoomKey`] as it came out of Olm, bound to the device that
/// forwarded it. Only [`crate::OlmChannel::decrypt`] makes one.
#[derive(Debug)]
pub struct ReceivedForwardedKey {
    forwarder: DeviceKeys,
    key: ForwardedRoomKey,
}

impl ReceivedForwardedKey {
    pub(crate) fn new(forwarder: DeviceKeys, key: ForwardedRoomKey) -> Self {
        Self { forwarder, key }
    }

    /// The device that forwarded the key.
    pub fn forwarder(&self) -> &DeviceKeys {
        &self.forwarder
    }

    /// The forwarded key.
    pub fn key(&self) -> &ForwardedRoomKey {
        &self.key
    }
}

/// Why an outbound session should be replaced (§4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    /// It encrypted [`ROTATE_AFTER_MESSAGES`] messages.
    Messages,
    /// It is [`ROTATE_AFTER_MS`] old.
    Age,
    /// A device it was shared with is no longer a recipient.
    DeviceRemoved,
}

/// This device's sending session for one conversation.
pub struct OutboundGroup {
    session: GroupSession,
    owner: DeviceKeys,
    conversation: Conversation,
    created_at: u64,
    shared_with: BTreeMap<(String, String), DeviceKeys>,
}

impl std::fmt::Debug for OutboundGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundGroup")
            .field("session_id", &self.session.session_id())
            .field("index", &self.session.message_index())
            .field("conversation", &self.conversation)
            .field("created_at", &self.created_at)
            .field("shared_with", &self.shared_with.len())
            .finish_non_exhaustive()
    }
}

impl OutboundGroup {
    /// A new session for `own`'s conversation with `peer`, created at
    /// `now_ms`, and the inbound half this device reads its own messages
    /// with (its history and its other devices' copies come back encrypted).
    pub fn create(own: &Account, peer: &str, now_ms: u64) -> (Self, InboundGroup) {
        let session = GroupSession::new(config());
        let conversation = Conversation::new(own.login(), peer);
        let inbound = InboundGroup {
            session: InboundGroupSession::new(&session.session_key(), config()),
            sender: own.identity(),
            conversation: conversation.clone(),
            seen: BTreeMap::new(),
            sender_verified: true,
        };
        let outbound = Self {
            session,
            owner: own.identity(),
            conversation,
            created_at: now_ms,
            shared_with: BTreeMap::new(),
        };
        (outbound, inbound)
    }

    /// The session id (`sid` of its envelopes).
    pub fn session_id(&self) -> String {
        self.session.session_id()
    }

    /// The index the next message gets.
    pub fn message_index(&self) -> u32 {
        self.session.message_index()
    }

    /// The conversation.
    pub fn conversation(&self) -> &Conversation {
        &self.conversation
    }

    /// Whether the session must be replaced before the next message, given
    /// the devices that should be able to read it now. A change of trust is
    /// the caller's to act on (§4.3): it replaces the session itself.
    pub fn rotation_due(&self, now_ms: u64, recipients: &[DeviceKeys]) -> Option<Rotation> {
        if self.session.message_index() >= ROTATE_AFTER_MESSAGES {
            return Some(Rotation::Messages);
        }
        if now_ms.saturating_sub(self.created_at) >= ROTATE_AFTER_MS {
            return Some(Rotation::Age);
        }
        let removed = self
            .shared_with
            .values()
            .any(|shared| !recipients.contains(shared));
        removed.then_some(Rotation::DeviceRemoved)
    }

    /// The recipients that have not been sent the key yet — including a
    /// device whose keys changed under a known id, which is another device.
    pub fn unshared<'a>(&self, recipients: &'a [DeviceKeys]) -> Vec<&'a DeviceKeys> {
        recipients
            .iter()
            .filter(|d| {
                self.shared_with
                    .get(&(d.login().to_owned(), d.device_id().to_owned()))
                    != Some(*d)
            })
            .collect()
    }

    /// The key to send over Olm, from the current index: a device that gets
    /// it reads this message and later ones, not earlier ones (§4.3).
    pub fn room_key(&self) -> RoomKey {
        RoomKey {
            conversation: self.conversation.clone(),
            session_id: self.session.session_id(),
            session_key: Zeroizing::new(self.session.session_key().to_base64()),
        }
    }

    /// `device` was sent [`OutboundGroup::room_key`].
    pub fn mark_shared(&mut self, device: &DeviceKeys) {
        self.shared_with.insert(
            (device.login().to_owned(), device.device_id().to_owned()),
            device.clone(),
        );
    }

    /// Encrypt one message. Advances the ratchet: persist the session in the
    /// same `Persist` as the message row, before it is sent, and send this
    /// envelope on every retry (§4.3, §6).
    ///
    /// # Errors
    /// [`CryptoError::WrongSession`] when `frame` is not `own`'s in this
    /// conversation, [`CryptoError::ReservedField`] when `content` carries a
    /// field the plaintext binds, [`CryptoError::TooLarge`].
    pub fn encrypt(
        &mut self,
        own: &Account,
        frame: &Frame<'_>,
        content: &Map<String, Value>,
        blob: Option<&[u8]>,
    ) -> Result<Envelope, CryptoError> {
        if own.identity() != self.owner
            || frame.from != own.login()
            || Conversation::new(frame.from, frame.to) != self.conversation
        {
            return Err(CryptoError::WrongSession);
        }
        if let Some(field) = RESERVED.iter().find(|f| content.contains_key(**f)) {
            return Err(CryptoError::ReservedField { field });
        }
        let mut header = content.clone();
        header.insert("from".into(), Value::String(frame.from.to_owned()));
        header.insert("to".into(), Value::String(frame.to.to_owned()));
        header.insert("id".into(), Value::String(frame.id.to_owned()));
        header.insert("kind".into(), Value::String(frame.kind.as_str().to_owned()));
        let plaintext = frame_plaintext(&header, blob.unwrap_or_default())?;
        let message = self.session.encrypt(plaintext.as_slice());
        Ok(Envelope {
            dev: own.device_id().to_owned(),
            sid: self.session.session_id(),
            ct: message.to_base64(),
        })
    }

    /// The session with its ratchet, for storage.
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn pickle(&self) -> Result<Zeroizing<String>, CryptoError> {
        to_pickle(&OutboundPickle {
            session: self.session.pickle(),
            owner: self.owner.clone(),
            conversation: self.conversation.clone(),
            created_at: self.created_at,
            shared_with: self.shared_with.values().cloned().collect(),
        })
    }

    /// Restore from [`OutboundGroup::pickle`].
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn from_pickle(pickle: &str) -> Result<Self, CryptoError> {
        let p: OutboundPickle = from_pickle(pickle)?;
        Ok(Self {
            session: GroupSession::from_pickle(p.session),
            owner: p.owner,
            conversation: p.conversation,
            created_at: p.created_at,
            shared_with: p
                .shared_with
                .into_iter()
                .map(|d| ((d.login().to_owned(), d.device_id().to_owned()), d))
                .collect(),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct OutboundPickle {
    session: GroupSessionPickle,
    owner: DeviceKeys,
    conversation: Conversation,
    created_at: u64,
    shared_with: Vec<DeviceKeys>,
}

/// A session this device reads one sender device's messages with, bound to
/// that device and conversation (§4.3 «Привязка входящей сессии»).
pub struct InboundGroup {
    session: InboundGroupSession,
    sender: DeviceKeys,
    conversation: Conversation,
    /// Message index → the message id it carried.
    seen: BTreeMap<u32, String>,
    /// `true` when the session came from a direct `SessionKey`, `false` when
    /// imported from a forwarded/backup `ExportedSessionKey` (§4.2).
    sender_verified: bool,
}

impl std::fmt::Debug for InboundGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboundGroup")
            .field("session_id", &self.session.session_id())
            .field("sender", &self.sender)
            .field("conversation", &self.conversation)
            .field("seen", &self.seen.len())
            .field("sender_verified", &self.sender_verified)
            .finish_non_exhaustive()
    }
}

impl InboundGroup {
    /// Accept a session key from Olm for `own`'s use.
    ///
    /// # Errors
    /// [`Undecryptable::WrongConversation`] unless both `own` and the sending
    /// account are in the key's conversation; [`Undecryptable::BadPlaintext`]
    /// for a key that does not parse or names another session id.
    pub fn from_room_key(own: &Account, received: ReceivedRoomKey) -> Result<Self, Undecryptable> {
        let ReceivedRoomKey { sender, key } = received;
        if !key.conversation.contains(own.login()) || !key.conversation.contains(sender.login()) {
            return Err(Undecryptable::WrongConversation);
        }
        let session_key =
            SessionKey::from_base64(&key.session_key).map_err(|_| Undecryptable::BadPlaintext)?;
        let session = InboundGroupSession::new(&session_key, config());
        if session.session_id() != key.session_id {
            return Err(Undecryptable::BadPlaintext);
        }
        Ok(Self {
            session,
            sender,
            conversation: key.conversation,
            seen: BTreeMap::new(),
            sender_verified: true,
        })
    }

    /// Export this session at its first known index to forward over Olm to
    /// another client device `requester` of `own`'s account that is signed by
    /// `own_cross` (§4.2).
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] unless `own_cross` belongs to `own`,
    /// `requester` is a client device of `own`'s account signed by `own_cross`,
    /// and [`CryptoError::WrongSession`] if this session is not for a
    /// conversation of `own`.
    pub fn export_forwarded(
        &self,
        own: &Account,
        own_cross: &CrossSigningPublic,
        requester: &DeviceKeys,
    ) -> Result<ForwardedRoomKey, CryptoError> {
        if own_cross.login() != own.login()
            || requester.login() != own.login()
            || requester.device_id() == own.device_id()
            || requester.kind() != DeviceKind::Client
            || !own_cross.verifies(requester)
        {
            return Err(CryptoError::UntrustedDevice);
        }
        if !self.conversation.contains(own.login()) {
            return Err(CryptoError::WrongSession);
        }
        let exported = self.session.export_at_first_known_index();
        Ok(ForwardedRoomKey {
            conversation: self.conversation.clone(),
            sender: self.sender.clone(),
            session_id: self.session.session_id(),
            session_key: Zeroizing::new(exported.to_base64()),
        })
    }

    /// Import a forwarded session key from another device of `own`'s account
    /// that is signed by `own_cross`. Marks the session as `sender_verified =
    /// false` until the original `SessionKey` arrives (§4.2).
    ///
    /// # Errors
    /// [`Undecryptable::WrongSender`] if the forwarder is not a cross-signed
    /// client device of `own`, [`Undecryptable::WrongConversation`] if the key
    /// is not for a conversation between `own` and the original sender.
    pub fn from_forwarded_key(
        own: &Account,
        own_cross: &CrossSigningPublic,
        received: ReceivedForwardedKey,
    ) -> Result<Self, Undecryptable> {
        let ReceivedForwardedKey { forwarder, key } = received;
        if own_cross.login() != own.login()
            || forwarder.login() != own.login()
            || forwarder.kind() != DeviceKind::Client
            || !own_cross.verifies(&forwarder)
        {
            return Err(Undecryptable::WrongSender);
        }
        Self::from_exported(
            own.login(),
            key.conversation,
            key.sender,
            &key.session_id,
            &key.session_key,
        )
    }

    /// Export the session key at its first known index as unpadded base64, for
    /// encrypted key backup (§4.5).
    pub(crate) fn export_at_first_known_index_base64(&self) -> Zeroizing<String> {
        Zeroizing::new(self.session.export_at_first_known_index().to_base64())
    }

    /// Import an exported session key (forwarded or restored from backup) for
    /// `own_login`, marking `sender_verified = false` until the original
    /// `SessionKey` arrives (§4.2, §4.5).
    pub(crate) fn from_exported(
        own_login: &str,
        conversation: Conversation,
        sender: DeviceKeys,
        session_id: &str,
        session_key_b64: &str,
    ) -> Result<Self, Undecryptable> {
        if !conversation.contains(own_login) || !conversation.contains(sender.login()) {
            return Err(Undecryptable::WrongConversation);
        }
        let exported = ExportedSessionKey::from_base64(session_key_b64)
            .map_err(|_| Undecryptable::BadPlaintext)?;
        let session = InboundGroupSession::import(&exported, config());
        if session.session_id() != session_id {
            return Err(Undecryptable::BadPlaintext);
        }
        Ok(Self {
            session,
            sender,
            conversation,
            seen: BTreeMap::new(),
            sender_verified: false,
        })
    }

    /// Merge another instance of the same session (for example, an original
    /// `SessionKey` upgrading a forwarded session's `sender_verified`, or a
    /// forwarded session providing an earlier `first_known_index`), keeping
    /// all seen message indexes. Returns `true` if `self` changed.
    pub fn merge(&mut self, mut other: Self) -> bool {
        if self.sender != other.sender || self.conversation != other.conversation {
            return false;
        }
        let before_index = self.session.first_known_index();
        let before_verified = self.sender_verified;
        let Some(merged) = self.session.merge(&mut other.session) else {
            return false;
        };
        self.session = merged;
        self.sender_verified |= other.sender_verified;
        for (idx, id) in other.seen {
            self.seen.entry(idx).or_insert(id);
        }
        self.session.first_known_index() < before_index || self.sender_verified != before_verified
    }

    /// Whether the session's sender was verified directly (`SessionKey` rather
    /// than an imported `ExportedSessionKey`, §4.2).
    pub fn is_sender_verified(&self) -> bool {
        self.sender_verified
    }

    /// The session id.
    pub fn session_id(&self) -> String {
        self.session.session_id()
    }

    /// The device whose messages this session reads.
    pub fn sender(&self) -> &DeviceKeys {
        &self.sender
    }

    /// The conversation.
    pub fn conversation(&self) -> &Conversation {
        &self.conversation
    }

    /// The first message index it can read.
    pub fn first_known_index(&self) -> u32 {
        self.session.first_known_index()
    }

    /// Decrypt `envelope` of `frame`. `edit_of` is the author of the message
    /// an edit names, from this device's own copy of it.
    ///
    /// Records which id the message index carried: persist the session with
    /// the decrypted row, before the `ack` (§6). The same envelope again
    /// (history, a reconnect) decrypts again.
    ///
    /// # Errors
    /// Never a caller error; every refusal is an [`Undecryptable`].
    pub fn decrypt(
        &mut self,
        frame: &Frame<'_>,
        envelope: &Envelope,
        edit_of: Option<&str>,
    ) -> Result<Decrypted, Undecryptable> {
        if envelope.sid != self.session.session_id() || envelope.dev != self.sender.device_id() {
            return Err(Undecryptable::SessionMismatch);
        }
        if frame.from != self.sender.login() {
            return Err(Undecryptable::WrongSender);
        }
        if Conversation::new(frame.from, frame.to) != self.conversation {
            return Err(Undecryptable::WrongConversation);
        }
        let message =
            MegolmMessage::from_base64(&envelope.ct).map_err(|_| Undecryptable::Malformed)?;
        let decrypted = self
            .session
            .decrypt(&message)
            .map_err(|_| Undecryptable::BadCiphertext)?;
        let plaintext = Zeroizing::new(decrypted.plaintext);
        let (mut content, blob) = parse_plaintext(&plaintext)?;

        let expected = [
            ("from", frame.from),
            ("to", frame.to),
            ("id", frame.id),
            ("kind", frame.kind.as_str()),
        ];
        for (field, value) in expected {
            if content.remove(field).as_ref().and_then(Value::as_str) != Some(value) {
                return Err(Undecryptable::FieldMismatch { field });
            }
        }
        if frame.kind == MessageKind::Edit && edit_of != Some(self.sender.login()) {
            return Err(Undecryptable::EditByOtherAccount);
        }
        let index = decrypted.message_index;
        match self.seen.get(&index) {
            Some(id) if id != frame.id => return Err(Undecryptable::Replay { index }),
            Some(_) => {}
            None => {
                self.seen.insert(index, frame.id.to_owned());
            }
        }
        Ok(Decrypted {
            content,
            blob: (!blob.is_empty()).then(|| blob.to_vec()),
            index,
        })
    }

    /// The session, its binding and the indexes seen, for storage.
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn pickle(&self) -> Result<Zeroizing<String>, CryptoError> {
        to_pickle(&InboundPickle {
            session: self.session.pickle(),
            sender: self.sender.clone(),
            conversation: self.conversation.clone(),
            seen: self.seen.clone(),
            sender_verified: self.sender_verified,
        })
    }

    /// Restore from [`InboundGroup::pickle`].
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn from_pickle(pickle: &str) -> Result<Self, CryptoError> {
        let p: InboundPickle = from_pickle(pickle)?;
        Ok(Self {
            session: InboundGroupSession::from_pickle(p.session),
            sender: p.sender,
            conversation: p.conversation,
            seen: p.seen,
            sender_verified: p.sender_verified,
        })
    }
}

const fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
struct InboundPickle {
    session: InboundGroupSessionPickle,
    sender: DeviceKeys,
    conversation: Conversation,
    seen: BTreeMap<u32, String>,
    #[serde(default = "default_true")]
    sender_verified: bool,
}

/// `[version][header length, u32 big-endian][header JSON][attachment bytes]`:
/// an attachment travels as raw bytes, so the ciphertext's base64 is about
/// the size the attachment's `dataUrl` was (§4.3).
fn frame_plaintext(
    header: &Map<String, Value>,
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let header = Zeroizing::new(serde_json::to_vec(header).map_err(|_| CryptoError::TooLarge)?);
    let length = u32::try_from(header.len()).map_err(|_| CryptoError::TooLarge)?;
    let total = header
        .len()
        .checked_add(blob.len())
        .and_then(|n| n.checked_add(5))
        .ok_or(CryptoError::TooLarge)?;
    let mut out = Zeroizing::new(Vec::with_capacity(total));
    out.push(PLAINTEXT_VERSION);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(blob);
    Ok(out)
}

fn parse_plaintext(plaintext: &[u8]) -> Result<(Map<String, Value>, &[u8]), Undecryptable> {
    let (&version, rest) = plaintext.split_first().ok_or(Undecryptable::BadPlaintext)?;
    if version != PLAINTEXT_VERSION {
        return Err(Undecryptable::BadPlaintext);
    }
    let (length, rest) = rest
        .split_at_checked(4)
        .ok_or(Undecryptable::BadPlaintext)?;
    let length = <[u8; 4]>::try_from(length).map_err(|_| Undecryptable::BadPlaintext)?;
    let length =
        usize::try_from(u32::from_be_bytes(length)).map_err(|_| Undecryptable::BadPlaintext)?;
    let (header, blob) = rest
        .split_at_checked(length)
        .ok_or(Undecryptable::BadPlaintext)?;
    let header: Map<String, Value> =
        serde_json::from_slice(header).map_err(|_| Undecryptable::BadPlaintext)?;
    Ok((header, blob))
}
