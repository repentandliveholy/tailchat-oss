//! To-device messages: Olm between two devices (`docs/specs/2026-11-04-e2ee.md`
//! §4.4).
//!
//! The plaintext names both ends — login, device id and Ed25519 key of the
//! sender and of the recipient — so that the server cannot hand one device's
//! message to another, or present it as somebody else's.

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vodozemac::olm::{OlmMessage, Session, SessionConfig, SessionPickle};
use vodozemac::{base64_decode, base64_encode};
use zeroize::Zeroizing;

use crate::backup::{ReceivedBackupKey, SharedBackupKey, SharedBackupKeyWire};
use crate::cross_signing::{
    ReceivedCrossSigningKey, SharedCrossSigningKey, SharedCrossSigningWire,
};
use crate::megolm::{
    ForwardedRoomKey, ForwardedRoomKeyWire, ReceivedForwardedKey, ReceivedRoomKey, RoomKey,
    RoomKeyRequest, RoomKeyWire,
};
use crate::pickle::{from_pickle, to_pickle};
use crate::sas::SasMessage;
use crate::{Account, CryptoError, DeviceKeys, Undecryptable};

/// Sessions kept per peer device, newest first. A peer that keeps starting
/// new sessions pushes out the oldest; one that still uses it ends in
/// [`Undecryptable`] and starts another (§4.4).
const MAX_SESSIONS: usize = 8;
const BODY_VERSION: u64 = 1;
const ROOM_KEY: &str = "room_key";
const ROOM_KEY_REQUEST: &str = "room_key_request";
const FORWARDED_ROOM_KEY: &str = "forwarded_room_key";
const CROSS_SIGNING_KEY: &str = "cross_signing_key";
const BACKUP_KEY: &str = "backup_key";
const SAS_VERIFICATION: &str = "sas";
/// The Olm version Matrix runs. `version_2` (full-length MAC) exists only
/// behind vodozemac's `experimental-session-config`.
fn config() -> SessionConfig {
    SessionConfig::version_1()
}

/// What one device sends another over Olm.
#[derive(Debug)]
pub enum ToDevice {
    /// A conversation's Megolm session key (§4.3).
    RoomKey(RoomKey),
    /// Ask another cross-signed device of the same account for a session key (§4.2, §4.3).
    RoomKeyRequest(RoomKeyRequest),
    /// Forward an exported Megolm session key to another cross-signed device of the same account (§4.2).
    ForwardedRoomKey(ForwardedRoomKey),
    /// Share the account's cross-signing secret with a newly verified own device (§4.2).
    CrossSigningKey(SharedCrossSigningKey),
    /// Share the account's backup key with a verified own client device (§4.5).
    BackupKey(SharedBackupKey),
    /// One step of a SAS verification handshake (§4.2).
    Sas(SasMessage),
    /// Anything later sub-stages add (backup key).
    Other {
        /// The `type` tag.
        kind: String,
        /// Its content.
        content: Value,
    },
}

/// What arrived over Olm, bound to the device it verifiably came from.
#[derive(Debug)]
pub enum Received {
    /// A session key: open it with [`crate::InboundGroup::from_room_key`].
    RoomKey(Box<ReceivedRoomKey>),
    /// A request from another device for a session key.
    RoomKeyRequest(RoomKeyRequest),
    /// A forwarded session key: open it with [`crate::InboundGroup::from_forwarded_key`].
    ForwardedRoomKey(Box<ReceivedForwardedKey>),
    /// The account's cross-signing secret: open it with [`crate::CrossSigning::from_shared`].
    CrossSigningKey(Box<ReceivedCrossSigningKey>),
    /// The account's backup key: open it with [`crate::BackupKey::from_shared`].
    BackupKey(Box<ReceivedBackupKey>),
    /// One step of a SAS verification handshake.
    Sas(SasMessage),
    /// Any other `type`.
    Other {
        /// The `type` tag.
        kind: String,
        /// Its content.
        content: Value,
    },
}

enum PendingSession {
    Created(Box<Session>),
    Existing(usize),
}

/// The Olm sessions with one peer device.
pub struct OlmChannel {
    peer: DeviceKeys,
    sessions: Vec<Session>,
}

impl std::fmt::Debug for OlmChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OlmChannel")
            .field("peer", &self.peer)
            .field("sessions", &self.sessions.len())
            .finish()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainOut<'a, C> {
    #[serde(rename = "type")]
    kind: &'a str,
    content: C,
    sender: &'a str,
    sender_device: &'a str,
    sender_key: String,
    recipient: &'a str,
    recipient_device: &'a str,
    recipient_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlainIn<C> {
    #[serde(rename = "type")]
    kind: String,
    content: C,
    sender: String,
    sender_device: String,
    sender_key: String,
    recipient: String,
    recipient_device: String,
    recipient_key: String,
}

impl OlmChannel {
    /// A channel with `peer`, a device from `keys/query` whose
    /// self-signature [`DeviceKeys::from_json`] checked.
    pub fn new(peer: DeviceKeys) -> Self {
        Self {
            peer,
            sessions: Vec::new(),
        }
    }

    /// The device at the other end.
    pub fn peer(&self) -> &DeviceKeys {
        &self.peer
    }

    /// Refresh the peer's [`DeviceKeys`] (for example, when cross-signing
    /// signatures were added) while keeping existing Olm sessions if the
    /// identity keys did not change.
    pub fn update_peer(&mut self, peer: DeviceKeys) {
        if self.peer == peer {
            self.peer = peer;
        } else {
            self.peer = peer;
            self.sessions.clear();
        }
    }
    /// Whether [`OlmChannel::encrypt`] can send without a claimed key.
    pub fn has_session(&self) -> bool {
        !self.sessions.is_empty()
    }

    /// Start a new outbound session from a key `keys/claim` returned for
    /// this device (`{key, fallback?, signatures}`); it becomes the one
    /// [`OlmChannel::encrypt`] uses.
    ///
    /// # Errors
    /// [`CryptoError::BadSignature`] unless the peer signed the key,
    /// [`CryptoError::InvalidKey`], [`CryptoError::WeakKey`].
    pub fn start_session(&mut self, own: &Account, claimed_key: &Value) -> Result<(), CryptoError> {
        let one_time_key = self.peer.verify_signed_key(claimed_key)?;
        let session = own
            .olm()
            .create_outbound_session(config(), self.peer.curve25519_key(), one_time_key)
            .map_err(|_| CryptoError::WeakKey)?;
        self.push_front(session);
        Ok(())
    }

    /// The `body` of a `to-device` frame carrying `message` to the peer.
    /// Advances the session: persist the channel before the frame is sent.
    ///
    /// # Errors
    /// [`CryptoError::NoSession`] before [`OlmChannel::start_session`].
    pub fn encrypt(&mut self, own: &Account, message: &ToDevice) -> Result<Value, CryptoError> {
        let plaintext = match message {
            ToDevice::RoomKey(key) => self.plaintext(own, ROOM_KEY, key.wire())?,
            ToDevice::RoomKeyRequest(req) => self.plaintext(own, ROOM_KEY_REQUEST, req)?,
            ToDevice::ForwardedRoomKey(key) => {
                self.plaintext(own, FORWARDED_ROOM_KEY, key.wire())?
            }
            ToDevice::CrossSigningKey(key) => self.plaintext(own, CROSS_SIGNING_KEY, key.wire())?,
            ToDevice::BackupKey(key) => self.plaintext(own, BACKUP_KEY, key.wire())?,
            ToDevice::Sas(msg) => self.plaintext(own, SAS_VERIFICATION, msg)?,
            ToDevice::Other { kind, content } => self.plaintext(own, kind, content)?,
        };
        let session = self.sessions.first_mut().ok_or(CryptoError::NoSession)?;
        let message = session
            .encrypt(plaintext.as_slice())
            .map_err(|_| CryptoError::WeakKey)?;
        let (message_type, ciphertext) = message.to_parts();
        Ok(json!({"v": BODY_VERSION, "type": message_type, "ct": base64_encode(ciphertext)}))
    }

    fn plaintext<C: Serialize>(
        &self,
        own: &Account,
        kind: &str,
        content: C,
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let plain = PlainOut {
            kind,
            content,
            sender: own.login(),
            sender_device: own.device_id(),
            sender_key: own.identity().ed25519(),
            recipient: self.peer.login(),
            recipient_device: self.peer.device_id(),
            recipient_key: self.peer.ed25519(),
        };
        serde_json::to_vec(&plain)
            .map(Zeroizing::new)
            .map_err(|_| CryptoError::TooLarge)
    }

    /// Open the `body` of a `to-device` frame the server says came from this
    /// channel's peer. A pre-key message uses up one of `own`'s one-time
    /// keys: persist the account and the channel together, before the
    /// `to-device-ack` (§4.4).
    ///
    /// # Errors
    /// Never a caller error: anything unreadable, or not from the peer to
    /// this device, is [`Undecryptable`].
    pub fn decrypt(&mut self, own: &mut Account, body: &Value) -> Result<Received, Undecryptable> {
        let message = parse_body(body)?;
        let (pending, plaintext) = self.open(own, &message)?;
        let plaintext = Zeroizing::new(plaintext);

        let head: PlainIn<IgnoredAny> =
            serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
        if head.sender != self.peer.login()
            || head.sender_device != self.peer.device_id()
            || head.sender_key != self.peer.ed25519()
        {
            return Err(Undecryptable::WrongSender);
        }
        if head.recipient != own.login()
            || head.recipient_device != own.device_id()
            || head.recipient_key != own.identity().ed25519()
        {
            return Err(Undecryptable::WrongRecipient);
        }

        let received = match head.kind.as_str() {
            ROOM_KEY => {
                let full: PlainIn<RoomKeyWire> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                let key = RoomKey::from_wire(full.content);
                Received::RoomKey(Box::new(ReceivedRoomKey::new(self.peer.clone(), key)))
            }
            ROOM_KEY_REQUEST => {
                let full: PlainIn<RoomKeyRequest> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                Received::RoomKeyRequest(full.content)
            }
            FORWARDED_ROOM_KEY => {
                let full: PlainIn<ForwardedRoomKeyWire> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                let key = ForwardedRoomKey::from_wire(full.content);
                Received::ForwardedRoomKey(Box::new(ReceivedForwardedKey::new(
                    self.peer.clone(),
                    key,
                )))
            }
            CROSS_SIGNING_KEY => {
                let full: PlainIn<SharedCrossSigningWire> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                let key = SharedCrossSigningKey::from_wire(full.content);
                Received::CrossSigningKey(Box::new(ReceivedCrossSigningKey::new(
                    self.peer.clone(),
                    key,
                )))
            }
            BACKUP_KEY => {
                let full: PlainIn<SharedBackupKeyWire> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                let key = SharedBackupKey::from_wire(full.content);
                Received::BackupKey(Box::new(ReceivedBackupKey::new(self.peer.clone(), key)))
            }
            SAS_VERIFICATION => {
                let full: PlainIn<SasMessage> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                Received::Sas(full.content)
            }
            _ => {
                let full: PlainIn<Value> =
                    serde_json::from_slice(&plaintext).map_err(|_| Undecryptable::BadPlaintext)?;
                Received::Other {
                    kind: full.kind,
                    content: full.content,
                }
            }
        };
        match pending {
            PendingSession::Created(session) => self.push_front(*session),
            PendingSession::Existing(i) => self.move_to_front(i),
        }
        Ok(received)
    }

    fn open(
        &mut self,
        own: &mut Account,
        message: &OlmMessage,
    ) -> Result<(PendingSession, Vec<u8>), Undecryptable> {
        if let OlmMessage::PreKey(pre_key) = message {
            // The pre-key message names the sender's identity key; one that
            // is not this peer's was never this peer's message.
            if pre_key.identity_key() != self.peer.curve25519_key() {
                return Err(Undecryptable::WrongSender);
            }
            let id = pre_key.session_id();
            if let Some(i) = self.sessions.iter().position(|s| s.session_id() == id) {
                return self.decrypt_with(i, message);
            }
            let created = own
                .olm_mut()
                .create_inbound_session(config(), self.peer.curve25519_key(), pre_key)
                .map_err(|_| Undecryptable::BadCiphertext)?;
            return Ok((
                PendingSession::Created(Box::new(created.session)),
                created.plaintext,
            ));
        }
        let opened = self
            .sessions
            .iter_mut()
            .enumerate()
            .find_map(|(i, s)| s.decrypt(message).ok().map(|p| (i, p)));
        let (i, plaintext) = opened.ok_or(Undecryptable::BadCiphertext)?;
        Ok((PendingSession::Existing(i), plaintext))
    }

    fn decrypt_with(
        &mut self,
        i: usize,
        message: &OlmMessage,
    ) -> Result<(PendingSession, Vec<u8>), Undecryptable> {
        let session = self
            .sessions
            .get_mut(i)
            .ok_or(Undecryptable::UnknownSession)?;
        let plaintext = session
            .decrypt(message)
            .map_err(|_| Undecryptable::BadCiphertext)?;
        Ok((PendingSession::Existing(i), plaintext))
    }

    fn push_front(&mut self, session: Session) {
        self.sessions.insert(0, session);
        self.sessions.truncate(MAX_SESSIONS);
    }

    fn move_to_front(&mut self, i: usize) {
        if i > 0 && i < self.sessions.len() {
            let session = self.sessions.remove(i);
            self.sessions.insert(0, session);
        }
    }

    /// The channel with its session secrets, for storage.
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn pickle(&self) -> Result<Zeroizing<String>, CryptoError> {
        to_pickle(&ChannelPickle {
            peer: self.peer.clone(),
            sessions: self.sessions.iter().map(Session::pickle).collect(),
        })
    }

    /// Restore from [`OlmChannel::pickle`].
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn from_pickle(pickle: &str) -> Result<Self, CryptoError> {
        let p: ChannelPickle = from_pickle(pickle)?;
        Ok(Self {
            peer: p.peer,
            sessions: p.sessions.into_iter().map(Session::from_pickle).collect(),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct ChannelPickle {
    peer: DeviceKeys,
    sessions: Vec<SessionPickle>,
}

fn parse_body(body: &Value) -> Result<OlmMessage, Undecryptable> {
    if body.get("v").and_then(Value::as_u64) != Some(BODY_VERSION) {
        return Err(Undecryptable::Malformed);
    }
    let message_type = body
        .get("type")
        .and_then(Value::as_u64)
        .and_then(|t| usize::try_from(t).ok())
        .ok_or(Undecryptable::Malformed)?;
    let ciphertext = body
        .get("ct")
        .and_then(Value::as_str)
        .and_then(|ct| base64_decode(ct).ok())
        .ok_or(Undecryptable::Malformed)?;
    OlmMessage::from_parts(message_type, &ciphertext).map_err(|_| Undecryptable::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DeviceKind;

    /// Bob's real keys under another name: what a channel to Bob would look
    /// like if the server had re-addressed it.
    fn relabelled(real: &DeviceKeys, login: &str, ed25519: Option<String>) -> DeviceKeys {
        serde_json::from_value(json!({
            "login": login,
            "device_id": real.device_id(),
            "kind": "client",
            "curve25519": real.curve25519(),
            "ed25519": ed25519.unwrap_or_else(|| real.ed25519()),
        }))
        .unwrap()
    }

    #[test]
    fn a_message_addressed_to_someone_else_is_refused() {
        let alice = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let other = Account::new("carol", "CCCCCCCCCCCCCCC1", DeviceKind::Client).unwrap();
        let mut bob = Account::new("bob", "BBBBBBBBBBBBBBB1", DeviceKind::Client).unwrap();
        bob.generate_one_time_keys(2);
        let upload = bob.upload_body().unwrap();
        let mut claims = upload["oneTimeKeys"].as_object().unwrap().values();
        let ping = ToDevice::Other {
            kind: "ping".into(),
            content: json!({}),
        };

        for (peer, claim) in [
            (
                relabelled(&bob.identity(), "carol", None),
                claims.next().unwrap(),
            ),
            (
                relabelled(&bob.identity(), "bob", Some(other.identity().ed25519())),
                claims.next().unwrap(),
            ),
        ] {
            let mut channel = OlmChannel::new(bob.identity());
            channel.start_session(&alice, claim).unwrap();
            channel.peer = peer;
            let body = channel.encrypt(&alice, &ping).unwrap();
            let mut bob_channel = OlmChannel::new(alice.identity());
            assert_eq!(
                bob_channel.decrypt(&mut bob, &body).unwrap_err(),
                Undecryptable::WrongRecipient
            );
            assert!(
                !bob_channel.has_session(),
                "a refused pre-key message must not install an active session"
            );
        }
    }

    #[test]
    fn pickle_keeps_sessions() {
        let alice = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let mut bob = Account::new("bob", "BBBBBBBBBBBBBBB1", DeviceKind::Client).unwrap();
        bob.generate_one_time_keys(1);
        let upload = bob.upload_body().unwrap();
        let claim = upload["oneTimeKeys"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap();
        let mut channel = OlmChannel::new(bob.identity());
        channel.start_session(&alice, claim).unwrap();
        let mut channel = OlmChannel::from_pickle(&channel.pickle().unwrap()).unwrap();
        assert!(channel.has_session());
        let body = channel
            .encrypt(
                &alice,
                &ToDevice::Other {
                    kind: "ping".into(),
                    content: json!({}),
                },
            )
            .unwrap();
        assert!(
            OlmChannel::new(alice.identity())
                .decrypt(&mut bob, &body)
                .is_ok()
        );
        assert!(!format!("{channel:?}").contains("ratchet"));
    }
}
