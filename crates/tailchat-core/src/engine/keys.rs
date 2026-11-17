//! End-to-end encryption, the conversation half (spec E2EE §4.3–4.4, §6,
//! design in §8.3): devices from `keys/query`, Olm sessions from
//! `keys/claim`, key messages in and out, the seal of each queued message,
//! and opening envelopes received.
//!
//! Persist before the wire: a message's envelope, the ratchet that made it,
//! the Olm channels that carried its key and the key messages themselves land
//! in one `Persist` before any of them is written, so a crash can neither
//! reuse a Megolm index nor send a key the device forgot it shared.

use serde_json::{Map, Value};
use tailchat_crypto::{
    BackupKey, Conversation, CrossSigning, CrossSigningPublic, DeviceKeys, DeviceKind,
    EncryptedBackupEntry, Envelope as Sealed, Frame, InboundGroup, MessageKind as Kind, OlmChannel,
    OutboundGroup, PassphraseSlot, QrVerification, Received, RoomKeyRequest, SasMessage,
    SasSession, SasVerified, ToDevice, Undecryptable,
};
use zeroize::Zeroizing;

use crate::api::{
    ApiCall, ApiRequest, Envelope, Event, FetchError, InboundRow, OlmChannelRow, OutboundRow,
    Output, PeerIdentity, PendingToDevice, Protection, SafetyHalf, Seal, SealedRow, StoreOp,
};
use crate::e2ee::{
    BackupPost, BackupPostKind, Claim, DeviceRef, Devices, KeyOut, PendingRestore, Query,
    SessionRef, TrustPost,
};
use crate::frames::e2ee::{
    self as wire, BackupEntryWire, BackupSessionWire, PassphraseSlotWire, ToDeviceIn,
};
use crate::frames::{MessageBody, ServerError};
use crate::ids::{MessageId, Ts};
use crate::login::Login;
use crate::platform::{BackupPassphraseKey, Secret};

use super::Core;

/// Most accounts one `keys/query` names (`E2EE_QUERY_BATCH_MAX`).
const QUERY_MAX: usize = 50;
/// Most devices one `keys/claim` names (`E2EE_CLAIM_BATCH_MAX`).
const CLAIM_MAX: usize = 50;
/// Statements per `POST /api/e2ee/trust`; the rest go in the next one.
const TRUST_MAX: usize = 50;
/// Most Megolm sessions uploaded in one `/api/e2ee/backup` POST (`E2EE_BACKUP_BATCH_MAX`).
const BACKUP_BATCH_MAX: usize = 100;
/// What a conversation's next message goes as.
enum Decision {
    /// Not known yet: a key request is out.
    Wait,
    /// Open text.
    Plain,
    /// Encrypted to these devices.
    Encrypt(Vec<DeviceKeys>),
}

/// An envelope opened, or why not.
pub(super) struct Opened {
    /// How the row is stored.
    pub(super) protection: Protection,
    /// The decrypted content, when there is one.
    pub(super) body: Option<MessageBody>,
    /// What opening it changed (the session's seen indexes, the flag).
    pub(super) ops: Vec<StoreOp>,
    /// The sender sealed an attachment this core could not put back
    /// (`frames::inner::attach_media`): the row keeps the rest, says
    /// `media_dropped`, and is not acknowledged.
    pub(super) media_lost: bool,
}

/// `(login, device)` of a device, when its login is one.
fn device_ref(device: &DeviceKeys) -> Option<DeviceRef> {
    Login::parse(device.login())
        .ok()
        .map(|login| (login, device.device_id().to_owned()))
}

/// How an attachment travels inside the ciphertext.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MediaForm {
    /// The header describes it (`mime`) and its raw bytes follow the header
    /// (spec E2EE §4.3): what every device announcing
    /// [`crate::frames::e2ee::BLOB_CAP`] reads.
    Blob,
    /// The `dataUrl` itself inside the header, the form a core before 1.148
    /// reads (it ignores the bytes after the header and would keep only the
    /// caption, while acknowledging the message). A third larger, so only
    /// for a conversation where some device has not announced the blob.
    Inline,
}

/// The header an encrypted message carries inside its ciphertext: the caption
/// and, for a picture or a voice note, its description — the bytes follow the
/// header ([`MediaForm::Blob`]) or sit in it as the `dataUrl`
/// ([`MediaForm::Inline`]). Never anything outside the ciphertext.
fn sealed_header(message: &crate::api::Outgoing, form: MediaForm) -> Map<String, Value> {
    let mut content = Map::new();
    content.insert("text".into(), Value::String(message.text.clone()));
    if let Some(image) = &message.image
        && let Some(mime) = crate::frames::inner::image_mime(&image.data_url)
    {
        let mut picture = Map::new();
        match form {
            MediaForm::Blob => picture.insert("mime".into(), Value::String(mime.to_owned())),
            MediaForm::Inline => {
                picture.insert("dataUrl".into(), Value::String(image.data_url.clone()))
            }
        };
        for (field, value) in [("width", image.width), ("height", image.height)] {
            if let Some(value) = value {
                picture.insert(field.into(), Value::from(value));
            }
        }
        content.insert("image".into(), Value::Object(picture));
    } else if let Some(voice) = &message.extra.voice
        && let Some((mime, _)) = crate::frames::inner::voice_bytes(&voice.data_url)
    {
        let mut note = Map::new();
        match form {
            MediaForm::Blob => note.insert("mime".into(), Value::String(mime.to_owned())),
            MediaForm::Inline => {
                note.insert("dataUrl".into(), Value::String(voice.data_url.clone()))
            }
        };
        note.insert(
            "duration".into(),
            Value::from(f64::from(voice.duration_ms) / 1000.0),
        );
        if !voice.waveform.is_empty() {
            note.insert("waveform".into(), Value::from(voice.waveform.clone()));
        }
        content.insert("voice".into(), Value::Object(note));
    }
    let extra = &message.extra;
    if let Some(reply) = &extra.reply_to
        && let Ok(value) = serde_json::to_value(crate::frames::en::ReplyWire::of(reply))
    {
        content.insert("replyTo".into(), value);
    }
    if let Some(forwarded) = &extra.forwarded_from
        && let Ok(value) = serde_json::to_value(crate::frames::en::ForwardWire::of(forwarded))
    {
        content.insert("forwardedFrom".into(), value);
    }
    if let Some(target) = &extra.edit_of {
        content.insert("editOf".into(), Value::String(target.as_str().to_owned()));
    }
    content
}

/// The attachment bytes an encrypted message carries in its ciphertext:
/// the picture's, else the voice note's — whichever the header describes.
pub(super) fn sealed_blob(
    message: &crate::api::Outgoing,
    content: &Map<String, Value>,
) -> Option<Vec<u8>> {
    if content.contains_key("image") {
        message
            .image
            .as_ref()
            .and_then(|image| crate::frames::inner::image_bytes(&image.data_url))
    } else if content.contains_key("voice") {
        message
            .extra
            .voice
            .as_ref()
            .and_then(|voice| crate::frames::inner::voice_bytes(&voice.data_url))
            .map(|(_, bytes)| bytes)
    } else {
        None
    }
}

/// The characters a `msg` frame takes when `message` goes encrypted, with
/// `blob_len` attachment bytes inside the ciphertext: one rule with
/// [`crate::frames::MAX_SEALED`], decided before anything is queued.
pub(super) fn sealed_frame_chars(
    me: &Login,
    message: &crate::api::Outgoing,
    blob_len: usize,
    form: MediaForm,
) -> usize {
    // OutboundGroup::encrypt adds these authenticated routing fields inside
    // the ciphertext. In particular a valid id may need JSON escaping and
    // cannot be covered by a constant intended for short random ids.
    let mut content = sealed_header(message, form);
    content.insert("from".into(), Value::String(me.as_str().into()));
    content.insert("to".into(), Value::String(message.peer.as_str().into()));
    content.insert("id".into(), Value::String(message.id.as_str().into()));
    content.insert("kind".into(), Value::String("msg".into()));
    let header = serde_json::to_vec(&content).map_or(usize::MAX, |v| v.len());
    let id = serde_json::to_vec(message.id.as_str()).map_or(usize::MAX, |v| v.len());
    // Version byte, the header's length, the header, the attachment bytes.
    let plaintext = header.saturating_add(blob_len).saturating_add(5);
    crate::frames::en::sealed_frame_chars(crate::frames::en::sealed_chars(plaintext))
        .saturating_add(id)
}

/// A pickle as a store value.
fn secret(
    pickle: Result<zeroize::Zeroizing<String>, tailchat_crypto::CryptoError>,
) -> Result<Secret, String> {
    pickle.map(Secret::new).map_err(|error| error.to_string())
}

impl Core {
    /// One key message per pass, sharing the queue's pace, before messages.
    pub(super) fn e2ee_send_keys(&mut self, now: Ts) -> Vec<Output> {
        if !self.e2ee.active() || !self.e2ee.registered || !self.outbox.gate_open(now) {
            return Vec::new();
        }
        let Some(key) = self.e2ee.keys_out.iter_mut().find(|k| !k.sent) else {
            return Vec::new();
        };
        match wire::to_device(&key.item) {
            Ok(frame) => {
                key.sent = true;
                self.e2ee.last_key_write = Some(key.item.id.clone());
                self.outbox.foreign_write(now);
                vec![Output::Send(frame)]
            }
            Err(error) => {
                let id = key.item.id.clone();
                self.e2ee.keys_out.retain(|k| k.item.id != id);
                vec![
                    Output::Persist(vec![StoreOp::DropToDevice(id)]),
                    Output::Event(Event::BadFrame {
                        reason: format!("key message: {error}"),
                    }),
                ]
            }
        }
    }

    /// The server dropped the last frame: if it was a key message, it goes again.
    pub(super) fn e2ee_throttled(&mut self) {
        if let Some(id) = self.e2ee.last_key_write.take()
            && let Some(key) = self.e2ee.keys_out.iter_mut().find(|k| k.item.id == id)
        {
            key.sent = false;
        }
    }

    /// `to-device-accepted`: the key message is on the server's disk.
    pub(super) fn on_to_device_accepted(&mut self, id: &str) -> Vec<Output> {
        let before = self.e2ee.keys_out.len();
        self.e2ee.keys_out.retain(|k| k.item.id != id);
        if self.e2ee.keys_out.len() == before {
            return Vec::new();
        }
        vec![Output::Persist(vec![StoreOp::DropToDevice(id.to_owned())])]
    }

    /// An `error` naming one of our key messages. `None` when it names none.
    pub(super) fn key_refused(&mut self, error: &ServerError) -> Option<Vec<Output>> {
        let id = error.id.as_ref()?.as_str();
        let index = self.e2ee.keys_out.iter().position(|k| k.item.id == id)?;
        if matches!(
            error.code.as_str(),
            "store_failed" | "to_device_full" | "rate_limited"
        ) {
            // Stays marked as written: it goes again on the next connection.
            return Some(Vec::new());
        }
        self.e2ee.keys_out.remove(index);
        Some(vec![Output::Persist(vec![StoreOp::DropToDevice(
            id.to_owned(),
        )])])
    }

    /// `device-list-changed`: forget what we knew and, for an account we
    /// hold keys for or have pinned a master key of, ask again right away
    /// rather than at the next send — a replaced master key is then reported
    /// (`Event::KeyChanged`) when it happens, not when this side next writes,
    /// which for someone who only reads was never. The pin matters on its own:
    /// the directory lives in memory and is empty after a restart until
    /// something is sent, while `peer_identities` comes back from the store.
    /// An account we never dealt with stays unasked: a notice is not a reason
    /// to fetch a stranger's keys. This account's own always is: it carries
    /// whom the account vouches for, which another of its devices just changed.
    pub(super) fn devices_changed(&mut self, login: &Login) {
        let held = self.e2ee.directory.remove(login).is_some();
        if held || *login == self.me || self.e2ee.peer_identities.contains_key(login) {
            self.e2ee.wanted.insert(login.clone());
        }
    }

    /// Decides the seal of every due queued row, conversation by
    /// conversation, and asks for what a decision still needs.
    pub(super) fn seal_due(&mut self, now: Ts) -> Vec<Output> {
        if !self.e2ee.active() {
            if !self.e2ee.enabled {
                return Vec::new();
            }
            // A legacy connection can send open rows, but their first-write
            // decision must survive a lost acceptance and a later encrypted
            // connection. Otherwise the same id changes wire representation.
            return self
                .outbox
                .undecided_due(now)
                .into_iter()
                .flat_map(|(peer, ids)| self.seal_plain(&peer, &ids))
                .collect();
        }
        if !self.e2ee.registered || self.e2ee.account.is_none() {
            return Vec::new();
        }
        let mut out = Vec::new();
        if self.e2ee.needs_reupload && self.e2ee.upload.is_none() {
            self.e2ee.needs_reupload = false;
            out.extend(self.post_upload());
        }
        out.extend(self.request_missing_keys(now));
        for (peer, ids) in self.outbox.undecided_due(now) {
            match self.decide(&peer) {
                Decision::Wait => {}
                Decision::Plain => out.extend(self.seal_plain(&peer, &ids)),
                Decision::Encrypt(recipients) => {
                    out.extend(self.seal_encrypted(now, &peer, &ids, &recipients));
                }
            }
        }
        out.extend(self.flush_outbox_olm(now));
        out.extend(self.post_backup_sessions(now));
        out.extend(self.post_query(now));
        out.extend(self.post_trust());
        out
    }

    /// Open or encrypted, by spec E2EE §4.2, §7: encrypted only when every
    /// verified device of both sides can read it; held (`Wait`) if the peer's
    /// master key changed or if a peer with a master key has only unverified
    /// devices.
    fn decide(&mut self, peer: &Login) -> Decision {
        let me = self.me.clone();
        let mut missing = false;
        for login in [peer, &me] {
            if !self.e2ee.directory.contains_key(login) {
                self.e2ee.wanted.insert(login.clone());
                missing = true;
            }
        }
        if missing {
            return Decision::Wait;
        }
        if self.e2ee.key_changed.contains(peer) {
            return Decision::Wait;
        }
        let (Some(theirs), Some(mine), Some(account)) = (
            self.e2ee.directory.get(peer),
            self.e2ee.directory.get(&me),
            self.e2ee.account.as_ref(),
        ) else {
            return Decision::Wait;
        };
        if theirs.legacy > 0 || mine.legacy > 0 || theirs.all_keys.is_empty() {
            return Decision::Plain;
        }
        if !theirs.complete || !mine.complete || theirs.keys.is_empty() {
            return if theirs.cross.is_some() || self.e2ee.peer_identities.contains_key(peer) {
                Decision::Wait
            } else {
                Decision::Plain
            };
        }
        let own = account.device_id();
        let mut recipients: Vec<DeviceKeys> = Vec::new();
        for device in theirs.keys.iter().chain(&mine.keys) {
            let this_device = device.login() == me.as_str() && device.device_id() == own;
            // Tailik reads only where it was let in (§6); not in 6c/6d.
            if this_device || device.kind() != DeviceKind::Client || recipients.contains(device) {
                continue;
            }
            recipients.push(device.clone());
        }
        let unreachable = recipients
            .iter()
            .filter_map(device_ref)
            .any(|r| self.e2ee.unreachable.contains(&r));
        if unreachable {
            Decision::Plain
        } else {
            Decision::Encrypt(recipients)
        }
    }

    /// Open text, unless the conversation was encrypted before: then the
    /// rows wait (spec E2EE §7).
    fn seal_plain(&mut self, peer: &Login, ids: &[MessageId]) -> Vec<Output> {
        let mut out = self.tell_state(peer, false);
        if self.e2ee.encrypted.contains(peer) {
            for id in ids {
                if self.e2ee.told_held.insert((peer.clone(), id.clone())) {
                    out.push(Output::Event(Event::PlaintextHeld {
                        peer: peer.clone(),
                        id: id.clone(),
                    }));
                }
            }
            return out;
        }
        let ops: Vec<StoreOp> = ids
            .iter()
            .filter_map(|id| self.outbox.set_seal(peer, id, Seal::Plain))
            .map(StoreOp::PutPending)
            .collect();
        if !ops.is_empty() {
            out.insert(0, Output::Persist(ops));
        }
        out
    }

    /// `EncryptionState{encrypted: true}` for the conversations that became
    /// encrypted during this input without a send (`E2ee::fresh_encrypted`).
    pub(super) fn tell_fresh_encrypted(&mut self) -> Vec<Output> {
        let fresh = std::mem::take(&mut self.e2ee.fresh_encrypted);
        let mut out = Vec::new();
        for peer in fresh {
            out.extend(self.tell_state(&peer, true));
        }
        out
    }

    /// `EncryptionState`, when it changed for this conversation.
    pub(super) fn tell_state(&mut self, peer: &Login, encrypted: bool) -> Vec<Output> {
        if self.e2ee.told_state.insert(peer.clone(), encrypted) == Some(encrypted) {
            return Vec::new();
        }
        vec![Output::Event(Event::EncryptionState {
            peer: peer.clone(),
            encrypted,
        })]
    }

    /// `Action::SendUnencrypted`: the person lets a held row go open.
    pub(super) fn send_unencrypted(
        &mut self,
        now: Ts,
        peer: &Login,
        id: &MessageId,
    ) -> Result<Vec<Output>, crate::error::CoreError> {
        if !self.outbox.is_pending(peer, id) {
            return Err(crate::error::CoreError::NotRetryable);
        }
        let Some(row) = self.outbox.set_seal(peer, id, Seal::Plain) else {
            return Err(crate::error::CoreError::NotRetryable);
        };
        self.e2ee.told_held.remove(&(peer.clone(), id.clone()));
        let mut out = vec![Output::Persist(vec![StoreOp::PutPending(row)])];
        out.extend(self.on_tick(now));
        Ok(out)
    }

    /// `Action::CancelHeld`: the person withdraws a held row. Only a row the
    /// core told about (`PlaintextHeld`) and that is still queued may go:
    /// anything else could already be on the wire.
    pub(super) fn cancel_held(
        &mut self,
        peer: &Login,
        id: &MessageId,
    ) -> Result<Vec<Output>, crate::error::CoreError> {
        let key = (peer.clone(), id.clone());
        if !self.e2ee.told_held.contains(&key) || !self.outbox.is_pending(peer, id) {
            return Err(crate::error::CoreError::NotRetryable);
        }
        if self.outbox.discard(peer, id).is_none() {
            return Err(crate::error::CoreError::NotRetryable);
        }
        self.e2ee.told_held.remove(&key);
        Ok(vec![
            Output::Persist(vec![StoreOp::DropPending {
                peer: peer.clone(),
                id: id.clone(),
            }]),
            Output::Event(Event::MessagesRemoved {
                peer: peer.clone(),
                ids: vec![id.clone()],
            }),
        ])
    }

    /// Shares the conversation's key where it is missing and encrypts the
    /// rows, all in one `Persist`; or asks for the Olm sessions first.
    fn seal_encrypted(
        &mut self,
        now: Ts,
        peer: &Login,
        ids: &[MessageId],
        recipients: &[DeviceKeys],
    ) -> Vec<Output> {
        let now_ms = u64::try_from(now.0).unwrap_or(0);
        let state = &self.e2ee;
        let fresh = state
            .outbound
            .get(peer)
            .is_none_or(|group| group.rotation_due(now_ms, recipients).is_some());
        let unshared: Vec<DeviceKeys> = match state.outbound.get(peer) {
            Some(group) if !fresh => group.unshared(recipients).into_iter().cloned().collect(),
            _ => recipients.to_vec(),
        };
        let need_session: Vec<DeviceKeys> = unshared
            .iter()
            .filter(|device| {
                device_ref(device).is_none_or(|r| {
                    state
                        .channels
                        .get(&r)
                        .is_none_or(|c| !c.has_session() || c.peer() != *device)
                })
            })
            .cloned()
            .collect();
        if !need_session.is_empty() {
            return self.post_claim(now, need_session);
        }
        let key_ids: Vec<String> = unshared
            .iter()
            .map(|_| self.e2ee.next_key_id(now))
            .collect();
        let form = self.media_form(recipients);
        match self.encrypt_rows(now_ms, peer, fresh, &unshared, key_ids, ids, form) {
            Ok((mut ops, seals, outdated)) => {
                for (id, seal) in seals {
                    if let Some(row) = self.outbox.set_seal(peer, &id, seal) {
                        ops.push(StoreOp::PutPending(row));
                    }
                }
                if self.e2ee.encrypted.insert(peer.clone()) {
                    ops.push(StoreOp::MarkEncrypted(peer.clone()));
                }
                let mut out = vec![Output::Persist(ops)];
                out.extend(self.tell_state(peer, true));
                for id in outdated {
                    out.extend(self.outbox.fail_unsealed(
                        peer,
                        &id,
                        crate::frames::e2ee::PEER_OUTDATED,
                    ));
                }
                out
            }
            Err(reason) => self.e2ee_broken(&format!("cannot encrypt: {reason}")),
        }
    }

    /// The crypto of [`Core::seal_encrypted`]: new session if `fresh`, the key
    /// to each unshared device, each row sealed. Errors are this device's
    /// state, not the server's.
    #[allow(clippy::type_complexity, clippy::too_many_arguments)]
    fn encrypt_rows(
        &mut self,
        now_ms: u64,
        peer: &Login,
        fresh: bool,
        unshared: &[DeviceKeys],
        key_ids: Vec<String>,
        ids: &[MessageId],
        form: MediaForm,
    ) -> Result<(Vec<StoreOp>, Vec<(MessageId, Seal)>, Vec<MessageId>), String> {
        let me = self.me.clone();
        let state = &mut self.e2ee;
        let account = state.account.as_ref().ok_or("no account")?;
        let mut ops = Vec::new();
        if fresh {
            let (group, inbound) = OutboundGroup::create(account, peer.as_str(), now_ms);
            let session = inbound.session_id();
            let device = account.device_id().to_owned();
            ops.push(StoreOp::PutInboundGroup(InboundRow {
                sender: me.clone(),
                device: device.clone(),
                session: session.clone(),
                pickle: secret(inbound.pickle())?,
            }));
            state.inbound.insert((me.clone(), device, session), inbound);
            state.outbound.insert(peer.clone(), group);
        }
        let group = state.outbound.get_mut(peer).ok_or("no session")?;
        let key = ToDevice::RoomKey(group.room_key());
        for (device, id) in unshared.iter().zip(key_ids) {
            let reference = device_ref(device).ok_or("bad login")?;
            let channel = state.channels.get_mut(&reference).ok_or("no channel")?;
            let body = channel
                .encrypt(account, &key)
                .map_err(|error| error.to_string())?;
            ops.push(StoreOp::PutOlmChannel(OlmChannelRow {
                login: reference.0.clone(),
                device: reference.1.clone(),
                pickle: secret(channel.pickle())?,
            }));
            let item = PendingToDevice {
                id,
                to: reference.0,
                device: reference.1,
                body: body.to_string(),
            };
            ops.push(StoreOp::PutToDevice(item.clone()));
            state.keys_out.push_back(KeyOut { item, sent: false });
            group.mark_shared(device);
        }
        let mut seals = Vec::new();
        let mut outdated = Vec::new();
        // The outbox and crypto state are disjoint fields. Borrow each image
        // in place instead of cloning the whole due album into memory before
        // any picture can be encrypted.
        for id in ids {
            let Some(row) = self.outbox.pending_row(peer, id) else {
                continue;
            };
            let message = &row.message;
            let has_media = message.image.is_some() || message.extra.voice.is_some();
            if form == MediaForm::Inline
                && has_media
                && sealed_frame_chars(&me, message, 0, MediaForm::Inline)
                    > crate::frames::MAX_SEALED
            {
                // The only form an old device reads does not fit one frame:
                // sealing the bytes it would drop is not delivering them.
                outdated.push(message.id.clone());
                continue;
            }
            let content = sealed_header(message, form);
            let blob = match form {
                MediaForm::Blob => sealed_blob(message, &content),
                MediaForm::Inline => None,
            };
            let frame = Frame {
                from: me.as_str(),
                to: peer.as_str(),
                id: message.id.as_str(),
                kind: Kind::Msg,
            };
            let sealed = group
                .encrypt(account, &frame, &content, blob.as_deref())
                .map_err(|error| error.to_string())?;
            seals.push((
                message.id.clone(),
                Seal::Encrypted(Envelope {
                    dev: sealed.dev,
                    sid: sealed.sid,
                    ct: sealed.ct,
                }),
            ));
        }
        // The ratchet after the last envelope, in the same Persist as the rows.
        ops.push(StoreOp::PutOutboundGroup(OutboundRow {
            peer: peer.clone(),
            pickle: secret(group.pickle())?,
        }));
        Ok((ops, seals, outdated))
    }

    /// [`MediaForm::Blob`] when every device the conversation's key goes to
    /// announced [`crate::frames::e2ee::BLOB_CAP`]; otherwise the form an
    /// older core reads. The author's other devices count: each of them
    /// keeps its own copy of what was sent.
    fn media_form(&self, recipients: &[DeviceKeys]) -> MediaForm {
        let all_read_blob = recipients.iter().all(|device| {
            device_ref(device).is_some_and(|(login, id)| {
                self.e2ee
                    .directory
                    .get(&login)
                    .is_some_and(|devices| devices.blob.contains(&id))
            })
        });
        if all_read_blob {
            MediaForm::Blob
        } else {
            MediaForm::Inline
        }
    }

    /// Stops encryption on this device and says why.
    fn e2ee_broken(&mut self, reason: &str) -> Vec<Output> {
        self.e2ee.break_with(reason);
        match &mut self.e2ee.broken {
            Some(broken) if !broken.told => {
                broken.told = true;
                vec![Output::Event(Event::EncryptionFailed {
                    reason: broken.reason.clone(),
                })]
            }
            _ => Vec::new(),
        }
    }

    /// One `keys/query` for the accounts wanted, unless one is out or paused.
    pub(super) fn post_query(&mut self, now: Ts) -> Vec<Output> {
        let state = &mut self.e2ee;
        if state.query.is_some()
            || state.wanted.is_empty()
            || state.retry_at.is_some_and(|at| now < at)
        {
            return Vec::new();
        }
        state.retry_at = None;
        let mut logins = std::collections::BTreeSet::new();
        while logins.len() < QUERY_MAX {
            let Some(login) = state.wanted.pop_first() else {
                break;
            };
            logins.insert(login);
        }
        let request = ApiRequest {
            serial: state.next_serial(),
            call: ApiCall::KeysQuery,
            body: wire::query_body(&logins),
        };
        state.query = Some(Query {
            request: request.clone(),
            logins,
        });
        vec![Output::Post(request)]
    }

    /// One `keys/claim` for these devices, unless one is out or paused.
    fn post_claim(&mut self, now: Ts, mut devices: Vec<DeviceKeys>) -> Vec<Output> {
        let state = &mut self.e2ee;
        if state.claim.is_some() || state.retry_at.is_some_and(|at| now < at) {
            return Vec::new();
        }
        state.retry_at = None;
        devices.truncate(CLAIM_MAX);
        let mut claims: std::collections::BTreeMap<Login, Vec<String>> =
            std::collections::BTreeMap::new();
        for (login, device) in devices.iter().filter_map(device_ref) {
            claims.entry(login).or_default().push(device);
        }
        let request = ApiRequest {
            serial: state.next_serial(),
            call: ApiCall::KeysClaim,
            body: wire::claim_body(&claims),
        };
        state.claim = Some(Claim {
            request: request.clone(),
            devices,
        });
        vec![Output::Post(request)]
    }

    /// `attested` from this account's own `keys/query` answer: the statements
    /// its current self-signing key signed. Anything else — a forgery, a
    /// statement from before a key reset — vouches for nobody.
    fn refresh_attested(&mut self, own: Option<&wire::QueryUser>) {
        self.e2ee.attested.clear();
        let Some(own) = own else {
            return;
        };
        let Ok(Some(cross)) = CrossSigningPublic::from_json(self.me.as_str(), &own.cross_signing)
        else {
            return;
        };
        for (key, statement) in &own.peer_trust {
            let Some(attested) = cross.attested_peer(statement) else {
                continue;
            };
            if attested.peer != *key {
                continue;
            }
            if let Ok(peer) = Login::parse(&attested.peer) {
                self.e2ee.attested.insert(peer, attested.master_key);
            }
        }
    }

    /// `peer`'s `master_key` is verified here because this account vouched
    /// for it on another device: pinned as a local verification would pin
    /// it, and a key change it answers is settled the same way.
    fn adopt_attested(&mut self, peer: &Login, master_key: String) -> StoreOp {
        let identity = PeerIdentity {
            peer: peer.clone(),
            master_key,
            verified: true,
        };
        self.e2ee
            .peer_identities
            .insert(peer.clone(), identity.clone());
        if self.e2ee.key_changed.remove(peer) {
            self.e2ee.told_key_changed.remove(peer);
            self.e2ee.outbound.remove(peer);
        }
        StoreOp::PutPeerIdentity(identity)
    }

    /// Publishes what this device verified and the account does not vouch
    /// for yet — a verification made here, one made before statements
    /// existed, or every one after this account reset its keys. Only a device
    /// holding the account's current self-signing key can sign, and only a
    /// key still published by the peer is worth vouching for: a stale pin
    /// must never overwrite what another device verified since.
    pub(super) fn post_trust(&mut self) -> Vec<Output> {
        let state = &mut self.e2ee;
        if !state.active()
            || !state.registered
            || state.trust_post.is_some()
            || state.trust_refused
            || state.retry_at.is_some()
        {
            return Vec::new();
        }
        let Some(account) = state.account.as_ref() else {
            return Vec::new();
        };
        let signer = account.cross_signing();
        let own = state.directory.get(&self.me).and_then(|d| d.cross.as_ref());
        if own != Some(signer.public()) {
            return Vec::new();
        }
        let mut statements = std::collections::BTreeMap::new();
        let mut vouched = std::collections::BTreeMap::new();
        for (peer, identity) in &state.peer_identities {
            if statements.len() >= TRUST_MAX {
                break;
            }
            if !identity.verified || state.attested.get(peer) == Some(&identity.master_key) {
                continue;
            }
            let published = state
                .directory
                .get(peer)
                .and_then(|d| d.cross.as_ref())
                .map(CrossSigningPublic::master_key);
            if published.as_ref() != Some(&identity.master_key) {
                continue;
            }
            if let Ok(statement) = signer.attest_peer(peer.as_str(), &identity.master_key) {
                statements.insert(peer.clone(), statement);
                vouched.insert(peer.clone(), identity.master_key.clone());
            }
        }
        if statements.is_empty() {
            return Vec::new();
        }
        let request = ApiRequest {
            serial: state.next_serial(),
            call: ApiCall::Trust,
            body: wire::trust_body(&statements),
        };
        state.trust_post = Some(TrustPost {
            request: request.clone(),
            vouched,
        });
        vec![Output::Post(request)]
    }

    /// A `200` to `POST /api/e2ee/trust`: the server holds the statements.
    pub(super) fn trust_posted(&mut self, request: &ApiRequest) -> Vec<Output> {
        let Some(post) = self.e2ee.trust_post.take_if(|p| &p.request == request) else {
            return Vec::new();
        };
        self.e2ee.succeeded();
        self.e2ee.attested.extend(post.vouched);
        self.post_trust()
    }

    /// A `keys/query` answer: the directory for the accounts it asked about.
    pub(super) fn queried(&mut self, now: Ts, request: &ApiRequest, body: &str) -> Vec<Output> {
        let Some(query) = self.e2ee.query.take_if(|q| &q.request == request) else {
            return Vec::new();
        };
        let answer = match wire::decode_query(body) {
            Ok(answer) => answer,
            Err(error) => {
                self.e2ee.wanted.extend(query.logins);
                self.e2ee.failed(now);
                return vec![Output::Event(Event::BadFrame {
                    reason: format!("keys/query: {error}"),
                })];
            }
        };
        self.e2ee.succeeded();
        let mut ops = Vec::new();
        let mut events = Vec::new();
        // This account's own answer first: what it vouches for decides how a
        // peer's key in the same answer is taken.
        let own_answered = query.logins.contains(&self.me);
        if own_answered {
            self.refresh_attested(answer.users.get(self.me.as_str()));
        }
        let mut upgraded: Vec<Login> = Vec::new();
        for login in query.logins {
            let mut devices = Devices {
                complete: true,
                ..Devices::default()
            };
            if let Some(user) = answer.users.get(login.as_str()) {
                devices.legacy = user.legacy_sessions;
                match CrossSigningPublic::from_json(login.as_str(), &user.cross_signing) {
                    Ok(cross) => devices.cross = cross,
                    Err(_) => devices.complete = false,
                }
                for (id, device) in &user.devices {
                    match DeviceKeys::from_json(&device.device_keys) {
                        Ok(keys) if keys.login() == login.as_str() && keys.device_id() == id => {
                            let name = crate::frames::e2ee::clean_device_name(&device.name);
                            if !name.is_empty() {
                                devices.names.insert(id.clone(), name);
                            }
                            if device
                                .caps
                                .iter()
                                .any(|cap| cap == crate::frames::e2ee::BLOB_CAP)
                            {
                                devices.blob.insert(id.clone());
                            }
                            devices.all_keys.push(keys.clone());
                            if devices.cross.as_ref().is_none_or(|c| c.verifies(&keys)) {
                                devices.keys.push(keys);
                            } else {
                                devices.unverified.push(id.clone());
                            }
                        }
                        _ => devices.complete = false,
                    }
                }
            }
            if login != self.me {
                match &devices.cross {
                    // Verified on another device of this account: the key
                    // the person checked is the key published now.
                    Some(cross)
                        if self.e2ee.attested.get(&login) == Some(&cross.master_key())
                            && !self.e2ee.peer_identities.get(&login).is_some_and(|p| {
                                p.verified && p.master_key == cross.master_key()
                            }) =>
                    {
                        ops.push(self.adopt_attested(&login, cross.master_key()));
                        upgraded.push(login.clone());
                    }
                    Some(cross) => match self.e2ee.peer_identities.get(&login) {
                        None => {
                            let identity = PeerIdentity {
                                peer: login.clone(),
                                master_key: cross.master_key(),
                                verified: false,
                            };
                            self.e2ee
                                .peer_identities
                                .insert(login.clone(), identity.clone());
                            ops.push(StoreOp::PutPeerIdentity(identity));
                        }
                        Some(known) if known.master_key == cross.master_key() => {
                            self.e2ee.key_changed.remove(&login);
                        }
                        Some(_) => {
                            self.e2ee.key_changed.insert(login.clone());
                            if self.e2ee.told_key_changed.insert(login.clone()) {
                                events.push(Output::Event(Event::KeyChanged {
                                    peer: login.clone(),
                                }));
                            }
                        }
                    },
                    None if self.e2ee.peer_identities.contains_key(&login) || !devices.complete => {
                        self.e2ee.key_changed.insert(login.clone());
                        if self.e2ee.told_key_changed.insert(login.clone()) {
                            events.push(Output::Event(Event::KeyChanged {
                                peer: login.clone(),
                            }));
                        }
                    }
                    None => {}
                }
            }
            for id in &devices.unverified {
                if self
                    .e2ee
                    .told_unverified
                    .insert((login.clone(), id.clone()))
                {
                    events.push(Output::Event(Event::UnverifiedDevice {
                        peer: login.clone(),
                        device: id.clone(),
                        name: devices.names.get(id).cloned().unwrap_or_default(),
                    }));
                }
            }
            self.e2ee.directory.insert(login, devices);
        }
        if own_answered {
            // Peers not in this answer: adopted when the key they publish —
            // or, not asked about on this connection, the key pinned here —
            // is the one vouched for; any other waits for their own answer.
            let state = &self.e2ee;
            let pinned: Vec<(Login, String)> = state
                .attested
                .iter()
                .filter(|(peer, master)| {
                    let pin = state.peer_identities.get(*peer);
                    let current = match state.directory.get(*peer) {
                        Some(devices) => devices.cross.as_ref().map(CrossSigningPublic::master_key),
                        None => pin.map(|p| p.master_key.clone()),
                    };
                    !upgraded.contains(peer)
                        && current.as_ref() == Some(*master)
                        && !pin.is_some_and(|p| p.verified && &p.master_key == *master)
                })
                .map(|(peer, master)| (peer.clone(), master.clone()))
                .collect();
            for (peer, master) in pinned {
                ops.push(self.adopt_attested(&peer, master));
                upgraded.push(peer);
            }
        }
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        out.extend(events);
        // What Details shows changes with it; a code not computable yet is
        // answered once the peer's keys are known.
        for peer in upgraded {
            if self.e2ee.directory.contains_key(&peer) {
                out.push(self.safety_now(peer));
            } else {
                self.e2ee.safety_wanted.insert(peer);
            }
        }
        out.extend(self.post_trust());
        out.extend(self.settle_reset());
        out.extend(self.start_pending_sas(now));
        out.extend(self.answer_safety_wanted());
        out.extend(self.process_inbox());
        out.extend(self.try_complete_restore(now));
        out
    }

    /// A `keys/claim` answer: Olm sessions for the devices that had a key.
    pub(super) fn claimed(&mut self, now: Ts, request: &ApiRequest, body: &str) -> Vec<Output> {
        let Some(claim) = self.e2ee.claim.take_if(|c| &c.request == request) else {
            return Vec::new();
        };
        let answer = match wire::decode_claim(body) {
            Ok(answer) => answer,
            Err(error) => {
                self.e2ee.failed(now);
                return vec![Output::Event(Event::BadFrame {
                    reason: format!("keys/claim: {error}"),
                })];
            }
        };
        self.e2ee.succeeded();
        let state = &mut self.e2ee;
        let Some(account) = state.account.as_ref() else {
            return Vec::new();
        };
        let mut ops = Vec::new();
        let mut held_back = false;
        for device in claim.devices {
            let Some(reference) = device_ref(&device) else {
                continue;
            };
            let key = answer
                .keys
                .get(reference.0.as_str())
                .and_then(|keys| keys.get(&reference.1));
            let Some(key) = key else {
                if answer.rate_limited {
                    held_back = true;
                } else {
                    state.unreachable.insert(reference);
                }
                continue;
            };
            let channel = state
                .channels
                .entry(reference.clone())
                .or_insert_with(|| OlmChannel::new(device.clone()));
            if channel.peer() != &device {
                // Other keys under a known id: another device.
                *channel = OlmChannel::new(device.clone());
            }
            match channel.start_session(account, &key.key) {
                Ok(()) => match secret(channel.pickle()) {
                    Ok(pickle) => ops.push(StoreOp::PutOlmChannel(OlmChannelRow {
                        login: reference.0,
                        device: reference.1,
                        pickle,
                    })),
                    Err(_) => {
                        state.unreachable.insert(reference);
                    }
                },
                Err(_) => {
                    state.unreachable.insert(reference);
                }
            }
        }
        if held_back {
            state.failed(now);
        }
        let mut out = if ops.is_empty() {
            Vec::new()
        } else {
            vec![Output::Persist(ops)]
        };
        out.extend(self.flush_outbox_olm(now));
        out
    }

    /// A key request that produced no answer.
    pub(super) fn key_request_failed(&mut self, now: Ts, request: &ApiRequest, error: FetchError) {
        match request.call {
            ApiCall::KeysQuery => {
                if let Some(query) = self.e2ee.query.take_if(|q| &q.request == request) {
                    self.e2ee.wanted.extend(query.logins);
                } else {
                    return;
                }
            }
            ApiCall::KeysClaim => {
                if self.e2ee.claim.take_if(|c| &c.request == request).is_none() {
                    return;
                }
            }
            ApiCall::Backup => {
                if self
                    .e2ee
                    .backup_post
                    .take_if(|b| &b.request == request)
                    .is_none()
                {
                    return;
                }
            }
            ApiCall::Trust => {
                if self
                    .e2ee
                    .trust_post
                    .take_if(|t| &t.request == request)
                    .is_none()
                {
                    return;
                }
                // The shape was refused: the same statements would be again.
                if matches!(error, FetchError::Status(400 | 409 | 413, _)) {
                    self.e2ee.trust_refused = true;
                    return;
                }
            }
            ApiCall::KeysUpload => return,
        }
        if matches!(error, FetchError::Status(401, _)) {
            self.e2ee.refused = true;
        } else {
            self.e2ee.failed(now);
        }
    }

    /// A key message for this device: handled in `seq` order, acknowledged
    /// only once what it changed is on disk.
    pub(super) fn on_to_device(&mut self, item: ToDeviceIn) -> Vec<Output> {
        if !self.e2ee.active() {
            // Not acknowledged: the server holds it for a later connection.
            return Vec::new();
        }
        let seen = self.e2ee.acked.is_some_and(|acked| item.seq <= acked)
            || self.e2ee.inbox.iter().any(|queued| queued.seq == item.seq);
        if !seen {
            self.e2ee.inbox.push_back(item);
        }
        self.process_inbox()
    }

    /// Handles queued key messages until one needs a device not known yet.
    pub(super) fn process_inbox(&mut self) -> Vec<Output> {
        let me = self.me.clone();
        let state = &mut self.e2ee;
        if !state.registered || state.account.is_none() {
            return Vec::new();
        }
        for queued in &state.inbox {
            if !state.directory.contains_key(&queued.from) {
                state.wanted.insert(queued.from.clone());
            }
        }
        let mut ops = Vec::new();
        let mut events = Vec::new();
        let mut last = None;
        let mut opened: Vec<SessionRef> = Vec::new();
        let mut account_changed = false;
        while let Some(item) = state.inbox.front() {
            let reference = (item.from.clone(), item.from_device.clone());
            let Some(devices) = state.directory.get(&item.from) else {
                state.wanted.insert(item.from.clone());
                break;
            };
            let Some(device) = devices
                .all_keys
                .iter()
                .find(|d| d.device_id() == item.from_device)
                .cloned()
            else {
                // Not a device of the sender's: nothing to open it with.
                last = Some(item.seq);
                state.inbox.pop_front();
                continue;
            };
            state
                .channels
                .entry(reference.clone())
                .and_modify(|c| c.update_peer(device.clone()))
                .or_insert_with(|| OlmChannel::new(device));
            let Some(item) = state.inbox.pop_front() else {
                break;
            };
            last = Some(item.seq);
            let (Some(account), Some(channel)) =
                (state.account.as_mut(), state.channels.get_mut(&reference))
            else {
                continue;
            };
            let peer_device = channel.peer().clone();
            let received = channel.decrypt(account, &item.body);
            account_changed = true;
            if !channel.has_session() {
                state.channels.remove(&reference);
                continue;
            }
            let Ok(received) = received else {
                continue;
            };
            if let Ok(pickle) = secret(channel.pickle()) {
                ops.push(StoreOp::PutOlmChannel(OlmChannelRow {
                    login: reference.0.clone(),
                    device: reference.1.clone(),
                    pickle,
                }));
            }
            match received {
                Received::RoomKey(key) => {
                    let sender_verified = state
                        .directory
                        .get(&reference.0)
                        .and_then(|d| d.cross.as_ref())
                        .is_none_or(|c| c.verifies(key.sender()));
                    if !sender_verified {
                        continue;
                    }
                    let Some(account) = state.account.as_ref() else {
                        continue;
                    };
                    let Ok(group) = InboundGroup::from_room_key(account, *key) else {
                        continue;
                    };
                    let Ok(sender) = Login::parse(group.sender().login()) else {
                        continue;
                    };
                    if sender != me && state.encrypted.insert(sender.clone()) {
                        ops.push(StoreOp::MarkEncrypted(sender.clone()));
                        // A room key is how the receiving side learns first.
                        state.fresh_encrypted.push(sender.clone());
                    }
                    let session: SessionRef = (
                        sender,
                        group.sender().device_id().to_owned(),
                        group.session_id(),
                    );
                    if let Some(existing) = state.inbound.get_mut(&session) {
                        if existing.merge(group)
                            && let Ok(pickle) = secret(existing.pickle())
                        {
                            ops.push(StoreOp::PutInboundGroup(InboundRow {
                                sender: session.0.clone(),
                                device: session.1.clone(),
                                session: session.2.clone(),
                                pickle,
                            }));
                            opened.push(session);
                        }
                        continue;
                    }
                    if let Ok(pickle) = secret(group.pickle()) {
                        ops.push(StoreOp::PutInboundGroup(InboundRow {
                            sender: session.0.clone(),
                            device: session.1.clone(),
                            session: session.2.clone(),
                            pickle,
                        }));
                        state.inbound.insert(session.clone(), group);
                        opened.push(session);
                    }
                }
                Received::RoomKeyRequest(req) => {
                    let Some(account) = state.account.as_ref() else {
                        continue;
                    };
                    let own_cross = state
                        .directory
                        .get(&me)
                        .and_then(|d| d.cross.clone())
                        .unwrap_or_else(|| account.cross_signing().public().clone());
                    let Ok(sender) = Login::parse(&req.sender) else {
                        continue;
                    };
                    let session: SessionRef = (sender, req.sender_device, req.session_id);
                    let Some(group) = state.inbound.get(&session) else {
                        continue;
                    };
                    if let Ok(forwarded) = group.export_forwarded(account, &own_cross, &peer_device)
                    {
                        state
                            .outbox_olm
                            .push_back((peer_device, ToDevice::ForwardedRoomKey(forwarded)));
                    }
                }
                Received::ForwardedRoomKey(received_key) => {
                    let Some(account) = state.account.as_ref() else {
                        continue;
                    };
                    let own_cross = state
                        .directory
                        .get(&me)
                        .and_then(|d| d.cross.clone())
                        .unwrap_or_else(|| account.cross_signing().public().clone());
                    let Ok(group) =
                        InboundGroup::from_forwarded_key(account, &own_cross, *received_key)
                    else {
                        continue;
                    };
                    let Ok(sender) = Login::parse(group.sender().login()) else {
                        continue;
                    };
                    let session: SessionRef = (
                        sender,
                        group.sender().device_id().to_owned(),
                        group.session_id(),
                    );
                    if let Some(existing) = state.inbound.get_mut(&session) {
                        if existing.merge(group)
                            && let Ok(pickle) = secret(existing.pickle())
                        {
                            ops.push(StoreOp::PutInboundGroup(InboundRow {
                                sender: session.0.clone(),
                                device: session.1.clone(),
                                session: session.2.clone(),
                                pickle,
                            }));
                            opened.push(session);
                        }
                        continue;
                    }
                    if let Ok(pickle) = secret(group.pickle()) {
                        ops.push(StoreOp::PutInboundGroup(InboundRow {
                            sender: session.0.clone(),
                            device: session.1.clone(),
                            session: session.2.clone(),
                            pickle,
                        }));
                        state.inbound.insert(session.clone(), group);
                        opened.push(session);
                    }
                }
                Received::CrossSigningKey(received_cross) => {
                    let matches_directory = state
                        .directory
                        .get(&me)
                        .and_then(|d| d.cross.as_ref())
                        .is_none_or(|c| c == received_cross.key().public());
                    if matches_directory
                        && let Some(account) = state.account.as_mut()
                        && let Ok(cross) = CrossSigning::from_shared(account, *received_cross)
                        && account.set_cross_signing(cross).is_ok()
                    {
                        state.needs_reupload = true;
                        state.directory.remove(&me);
                    }
                }
                Received::Sas(sas_msg) => {
                    on_sas_message(&me, state, peer_device, sas_msg, &mut ops, &mut events);
                }
                Received::BackupKey(received_bk) => {
                    let Some(account) = state.account.as_ref() else {
                        continue;
                    };
                    let own_cross = state
                        .directory
                        .get(&me)
                        .and_then(|d| d.cross.clone())
                        .unwrap_or_else(|| account.cross_signing().public().clone());
                    let Ok(bk) = BackupKey::from_shared(account, &own_cross, *received_bk) else {
                        continue;
                    };
                    let newer = state
                        .backup_key
                        .as_ref()
                        .is_none_or(|cur| bk.version() > cur.version());
                    if newer && let Ok(pickle) = secret(bk.pickle()) {
                        ops.push(StoreOp::PutBackupKey(pickle));
                        state.backed_up.clear();
                        state.backup_key = Some(bk.clone());
                        if !state.sealed.is_empty() && state.pending_restore.is_none() {
                            state.pending_restore = Some(PendingRestore::RecoveryKey(bk));
                        }
                    }
                }
                Received::Other { .. } => {}
            }
        }
        if account_changed
            && let Some(account) = state.account.as_ref()
            && let Ok(pickle) = secret(account.pickle())
        {
            ops.push(StoreOp::PutCryptoAccount(pickle));
        }
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        out.extend(events);
        if let Some(seq) = last {
            self.e2ee.acked = Some(seq);
            out.push(Output::Send(wire::to_device_ack(seq)));
        }
        for session in opened {
            out.extend(self.unseal_session(&session));
        }
        if self.e2ee.pending_restore.is_some() && self.e2ee.backup_post.is_none() {
            out.extend(self.post_backup_restore(Ts(0)));
        }
        // A verification just finished here: the account vouches for it.
        out.extend(self.post_trust());
        out
    }

    /// Opens an envelope of conversation `peer` written by `from`.
    pub(super) fn open_envelope(
        &mut self,
        peer: &Login,
        from: &Login,
        id: &MessageId,
        ts: Ts,
        kind: crate::api::MessageKind,
        raw: &Value,
    ) -> Opened {
        let mut ops = Vec::new();
        let Some(envelope) = wire::envelope(raw) else {
            return Opened {
                protection: Protection::Sealed {
                    envelope: Envelope {
                        dev: String::new(),
                        sid: String::new(),
                        ct: String::new(),
                    },
                    waiting: false,
                },
                body: None,
                ops,
                media_lost: false,
            };
        };
        let (protection, body, media_lost) = self.decrypt(peer, from, id, &envelope, &mut ops);
        if let Protection::Sealed { waiting: true, .. } = protection {
            self.e2ee
                .sealed
                .retain(|row| !(row.peer == *peer && row.id == *id));
            self.e2ee.sealed.push(SealedRow {
                peer: peer.clone(),
                id: id.clone(),
                from: from.clone(),
                ts,
                kind,
                envelope,
            });
        }
        Opened {
            protection,
            body,
            ops,
            media_lost,
        }
    }

    /// Decrypts with the session the envelope names, if this device has it.
    fn decrypt(
        &mut self,
        peer: &Login,
        from: &Login,
        id: &MessageId,
        envelope: &Envelope,
        ops: &mut Vec<StoreOp>,
    ) -> (Protection, Option<MessageBody>, bool) {
        let sealed = |waiting| Protection::Sealed {
            envelope: envelope.clone(),
            waiting,
        };
        if *from != self.me && *from != *peer {
            return (sealed(false), None, false);
        }
        let to = if *from == self.me { peer } else { &self.me };
        let session: SessionRef = (from.clone(), envelope.dev.clone(), envelope.sid.clone());
        let Some(group) = self.e2ee.inbound.get_mut(&session) else {
            return (sealed(true), None, false);
        };
        let frame = Frame {
            from: from.as_str(),
            to: to.as_str(),
            id: id.as_str(),
            kind: Kind::Msg,
        };
        let wire_envelope = Sealed {
            dev: envelope.dev.clone(),
            sid: envelope.sid.clone(),
            ct: envelope.ct.clone(),
        };
        match group.decrypt(&frame, &wire_envelope, None) {
            Ok(decrypted) => {
                if let Ok(pickle) = secret(group.pickle()) {
                    ops.push(StoreOp::PutInboundGroup(InboundRow {
                        sender: session.0,
                        device: session.1,
                        session: session.2,
                        pickle,
                    }));
                }
                let mut content = decrypted.content;
                // The picture's bytes came inside the ciphertext: put the
                // `dataUrl` form back before the body is read.
                let mut lost =
                    crate::frames::inner::attach_media(&mut content, decrypted.blob.as_deref());
                let named = content.contains_key("image") || content.contains_key("voice");
                match serde_json::from_value::<MessageBody>(Value::Object(content)) {
                    Ok(body) => {
                        if self.e2ee.encrypted.insert(peer.clone()) {
                            ops.push(StoreOp::MarkEncrypted(peer.clone()));
                            // The receiving side's lock: no send of its own
                            // has told it yet.
                            self.e2ee.fresh_encrypted.push(peer.clone());
                        }
                        // Rebuilt, yet not a picture or voice note the body
                        // reads: lost the same way.
                        lost |= named && body.image.is_none() && body.voice.is_none();
                        (Protection::Encrypted, Some(body), lost)
                    }
                    Err(_) => (sealed(false), None, false),
                }
            }
            Err(Undecryptable::UnknownSession) => (sealed(true), None, false),
            Err(_) => (sealed(false), None, false),
        }
    }

    /// A session key arrived: open every stored row that waited for it.
    fn unseal_session(&mut self, session: &SessionRef) -> Vec<Output> {
        let waiting: Vec<SealedRow> = self
            .e2ee
            .sealed
            .iter()
            .filter(|row| {
                row.from == session.0
                    && row.envelope.dev == session.1
                    && row.envelope.sid == session.2
            })
            .cloned()
            .collect();
        if waiting.is_empty() {
            return Vec::new();
        }
        let mut ops = Vec::new();
        let mut events = Vec::new();
        for row in waiting {
            let (protection, body, media_lost) =
                self.decrypt(&row.peer, &row.from, &row.id, &row.envelope, &mut ops);
            if let Protection::Sealed { waiting: true, .. } = protection {
                continue;
            }
            self.e2ee
                .sealed
                .retain(|kept| !(kept.peer == row.peer && kept.id == row.id));
            let body = body.unwrap_or_else(MessageBody::empty);
            let mut message = body.into_message(
                row.peer.clone(),
                row.id.clone(),
                row.from,
                row.ts,
                row.kind,
                protection,
            );
            // Its receipt went out when it arrived sealed; the row can still
            // say the attachment did not survive.
            message.media_dropped = media_lost;
            for output in self.receive_carrier(&mut message) {
                match output {
                    Output::Persist(more) => ops.extend(more),
                    other => events.push(other),
                }
            }
            ops.push(StoreOp::Unseal(Box::new(message)));
            events.push(Output::Event(Event::MessageStored {
                peer: row.peer,
                id: row.id,
            }));
        }
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        out.extend(events);
        out
    }

    /// `Action::AcceptPeerKey`: accept `peer`'s current master key after
    /// `Event::KeyChanged`, rotate the outbound session and resume sending.
    pub(super) fn accept_peer_key(&mut self, now: Ts, peer: &Login) -> Vec<Output> {
        self.e2ee.key_changed.remove(peer);
        self.e2ee.told_key_changed.remove(peer);
        self.e2ee.outbound.remove(peer);
        let mut out = Vec::new();
        if let Some(cross) = self.e2ee.directory.get(peer).and_then(|d| d.cross.as_ref()) {
            let identity = PeerIdentity {
                peer: peer.clone(),
                master_key: cross.master_key(),
                verified: false,
            };
            self.e2ee
                .peer_identities
                .insert(peer.clone(), identity.clone());
            out.push(Output::Persist(vec![StoreOp::PutPeerIdentity(identity)]));
        }
        out.extend(self.on_tick(now));
        out
    }

    /// `Action::StartSas` / `Action::StartSasAny`: begin one SAS verification
    /// with whichever of `devices` (all `peer`'s) accepts first.
    pub(super) fn start_sas(&mut self, now: Ts, peer: Login, devices: Vec<String>) -> Vec<Output> {
        if !self.e2ee.active() || !self.e2ee.registered || self.e2ee.account.is_none() {
            return Vec::new();
        }
        let mut wanted: Vec<String> = Vec::new();
        for device in devices {
            if !device.is_empty() && !wanted.contains(&device) {
                wanted.push(device);
            }
        }
        if wanted.is_empty() {
            return Vec::new();
        }
        let tx_id = self.e2ee.next_key_id(now);
        self.e2ee.pending_sas.push((tx_id, peer.clone(), wanted));
        if !self.e2ee.directory.contains_key(&peer) {
            self.e2ee.wanted.insert(peer);
        }
        if !self.e2ee.directory.contains_key(&self.me) {
            self.e2ee.wanted.insert(self.me.clone());
        }
        let mut out = self.start_pending_sas(now);
        out.extend(self.on_tick(now));
        out
    }

    fn start_pending_sas(&mut self, now: Ts) -> Vec<Output> {
        let Some(account) = self.e2ee.account.as_ref() else {
            return Vec::new();
        };
        let own_device = account.identity();
        let mut remaining = Vec::new();
        let mut events = Vec::new();
        let pending = std::mem::take(&mut self.e2ee.pending_sas);
        for (tx_id, peer, device_ids) in pending {
            let Some(devices) = self.e2ee.directory.get(&peer) else {
                remaining.push((tx_id, peer, device_ids));
                continue;
            };
            // In the order asked; a device the directory does not know (gone
            // since the client looked) is skipped, as a single one always was.
            let targets: Vec<DeviceKeys> = device_ids
                .iter()
                .filter_map(|id| devices.all_keys.iter().find(|d| d.device_id() == id))
                .cloned()
                .collect();
            let Some(first) = targets.first().map(|d| d.device_id().to_owned()) else {
                continue;
            };
            let mut offers = Vec::with_capacity(targets.len());
            for target in targets {
                let (session, start_msg) =
                    SasSession::start(tx_id.clone(), own_device.clone(), target.clone());
                offers.push(session);
                self.e2ee
                    .outbox_olm
                    .push_back((target, ToDevice::Sas(start_msg)));
            }
            self.e2ee.sas_offers.insert(tx_id.clone(), offers);
            events.push(Output::Event(Event::SasStarted {
                transaction_id: tx_id,
                peer,
                device: first,
            }));
        }
        self.e2ee.pending_sas = remaining;
        events.extend(self.flush_outbox_olm(now));
        events
    }

    /// `Action::ConfirmSas`: the person confirmed the SAS emojis/decimals.
    pub(super) fn confirm_sas(&mut self, now: Ts, transaction_id: &str) -> Vec<Output> {
        let (Some(account), Some(session)) = (
            self.e2ee.account.as_ref(),
            self.e2ee.sas_sessions.get_mut(transaction_id),
        ) else {
            return Vec::new();
        };
        let peer_device = session.peer_device().clone();
        let Ok(peer_login) = Login::parse(peer_device.login()) else {
            return Vec::new();
        };
        let own_master = self
            .e2ee
            .directory
            .get(&self.me)
            .and_then(|d| d.cross.as_ref())
            .map_or_else(
                || account.cross_signing().master_key(),
                CrossSigningPublic::master_key,
            );
        let Some(peer_master) = (if peer_login == self.me {
            Some(own_master.clone())
        } else {
            self.e2ee
                .directory
                .get(&peer_login)
                .and_then(|d| d.cross.as_ref())
                .map(CrossSigningPublic::master_key)
        }) else {
            let mut events = Vec::new();
            abort_sas(
                &mut self.e2ee,
                transaction_id,
                SAS_UNKNOWN_IDENTITY,
                &mut events,
            );
            events.extend(self.on_tick(now));
            return events;
        };
        let Ok((mac_msg, verified)) = session.confirm(&own_master, &peer_master) else {
            let mut events = Vec::new();
            abort_sas(
                &mut self.e2ee,
                transaction_id,
                SAS_MAC_MISMATCH,
                &mut events,
            );
            events.extend(self.on_tick(now));
            return events;
        };
        self.e2ee
            .outbox_olm
            .push_back((peer_device, ToDevice::Sas(mac_msg)));
        let mut ops = Vec::new();
        let mut events = Vec::new();
        if let Some(verified) = verified {
            self.e2ee.sas_sessions.remove(transaction_id);
            complete_verification(&self.me, &mut self.e2ee, verified, &mut ops, &mut events);
        }
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        out.extend(events);
        out.extend(self.on_tick(now));
        out
    }

    /// `Action::CancelSas`: abort an in-flight SAS verification.
    pub(super) fn cancel_sas(&mut self, now: Ts, transaction_id: &str) -> Vec<Output> {
        // Nobody has answered yet: every device asked is told, or the one
        // switched off pops the request up when it comes back.
        if let Some(offers) = self.e2ee.sas_offers.remove(transaction_id) {
            for session in offers {
                self.e2ee.outbox_olm.push_back((
                    session.peer_device().clone(),
                    ToDevice::Sas(SasMessage::Cancel {
                        transaction_id: transaction_id.to_owned(),
                        reason: "user_cancelled".to_owned(),
                    }),
                ));
            }
            return self.on_tick(now);
        }
        let Some(session) = self.e2ee.sas_sessions.remove(transaction_id) else {
            return Vec::new();
        };
        let peer_device = session.peer_device().clone();
        let cancel = SasMessage::Cancel {
            transaction_id: transaction_id.to_owned(),
            reason: "user_cancelled".to_owned(),
        };
        self.e2ee
            .outbox_olm
            .push_back((peer_device, ToDevice::Sas(cancel)));
        self.on_tick(now)
    }

    /// `Action::VerifyWithQr`: verify a peer or another own device from a QR string.
    pub(super) fn verify_with_qr(&mut self, now: Ts, qr: &str) -> Vec<Output> {
        let Ok(parsed) = QrVerification::decode(qr) else {
            return vec![Output::Event(Event::BadFrame {
                reason: "invalid QR verification code".into(),
            })];
        };
        let Ok(peer_login) = Login::parse(&parsed.login) else {
            return Vec::new();
        };
        let (Some(account), Some(devices)) = (
            self.e2ee.account.as_ref(),
            self.e2ee.directory.get(&peer_login),
        ) else {
            return Vec::new();
        };
        let Some(device) = devices
            .all_keys
            .iter()
            .find(|d| d.device_id() == parsed.device_id && d.ed25519() == parsed.device_ed25519)
            .cloned()
        else {
            return Vec::new();
        };
        let expected_master = devices
            .cross
            .as_ref()
            .map(CrossSigningPublic::master_key)
            .or_else(|| (peer_login == self.me).then(|| account.cross_signing().master_key()));
        if expected_master.as_deref() != Some(parsed.master_key.as_str()) && peer_login != self.me {
            return Vec::new();
        }
        let mut ops = Vec::new();
        let mut events = Vec::new();
        complete_verification(
            &self.me,
            &mut self.e2ee,
            SasVerified {
                transaction_id: String::new(),
                peer_device: device,
                peer_master_key: parsed.master_key,
            },
            &mut ops,
            &mut events,
        );
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        out.extend(events);
        out.extend(self.on_tick(now));
        out
    }

    /// `Action::SafetyCode`: the safety code with `peer`, now when both
    /// accounts' keys are in the directory, otherwise after the `keys/query`
    /// this asks for.
    pub(super) fn safety_code(&mut self, now: Ts, peer: Login) -> Vec<Output> {
        if !self.e2ee.active() || self.e2ee.account.is_none() || peer == self.me {
            return vec![safety_event(
                peer,
                "unavailable",
                Vec::new(),
                String::new(),
                String::new(),
                false,
            )];
        }
        let mut missing = false;
        for login in [peer.clone(), self.me.clone()] {
            if !self.e2ee.directory.contains_key(&login) {
                self.e2ee.wanted.insert(login);
                missing = true;
            }
        }
        if !missing {
            return vec![self.safety_now(peer)];
        }
        self.e2ee.safety_wanted.insert(peer);
        self.on_tick(now)
    }

    /// The codes asked for whose accounts the directory now knows.
    fn answer_safety_wanted(&mut self) -> Vec<Output> {
        if !self.e2ee.directory.contains_key(&self.me) {
            return Vec::new();
        }
        let ready: Vec<Login> = self
            .e2ee
            .safety_wanted
            .iter()
            .filter(|p| self.e2ee.directory.contains_key(*p))
            .cloned()
            .collect();
        ready
            .into_iter()
            .map(|peer| {
                self.e2ee.safety_wanted.remove(&peer);
                self.safety_now(peer)
            })
            .collect()
    }

    /// The safety code with `peer` from the directory as it stands: `peer`'s
    /// key as published now — the one messages would be encrypted to — and
    /// this account's as SAS uses it (`confirm_sas`).
    fn safety_now(&self, peer: Login) -> Output {
        let Some(account) = self.e2ee.account.as_ref() else {
            return safety_event(
                peer,
                "unavailable",
                Vec::new(),
                String::new(),
                String::new(),
                false,
            );
        };
        let Some(peer_master) = self
            .e2ee
            .directory
            .get(&peer)
            .and_then(|d| d.cross.as_ref())
            .map(CrossSigningPublic::master_key)
        else {
            return safety_event(
                peer,
                "no_keys",
                Vec::new(),
                String::new(),
                String::new(),
                false,
            );
        };
        let own_master = self
            .e2ee
            .directory
            .get(&self.me)
            .and_then(|d| d.cross.as_ref())
            .map_or_else(
                || account.cross_signing().master_key(),
                CrossSigningPublic::master_key,
            );
        let Ok(halves) = tailchat_crypto::safety_code(
            self.me.as_str(),
            &own_master,
            peer.as_str(),
            &peer_master,
        ) else {
            return safety_event(
                peer,
                "no_keys",
                Vec::new(),
                String::new(),
                String::new(),
                false,
            );
        };
        let halves = halves
            .into_iter()
            .filter_map(|h| {
                Some(SafetyHalf {
                    login: Login::parse(&h.login).ok()?,
                    emoji_indices: h.emoji_indices.to_vec(),
                })
            })
            .collect();
        let number = tailchat_crypto::safety_number(
            self.me.as_str(),
            &own_master,
            peer.as_str(),
            &peer_master,
        )
        .unwrap_or_default();
        let verified = self
            .e2ee
            .peer_identities
            .get(&peer)
            .is_some_and(|i| i.verified && i.master_key == peer_master);
        safety_event(peer, "ready", halves, peer_master, number, verified)
    }

    /// `Action::ConfirmSafetyCode`: the code matched — trust `master_key` as
    /// a SAS or QR verification would, but only while it is still `peer`'s
    /// published key.
    pub(super) fn confirm_safety_code(
        &mut self,
        now: Ts,
        peer: &Login,
        master_key: &str,
    ) -> Vec<Output> {
        let current = self
            .e2ee
            .directory
            .get(peer)
            .and_then(|d| d.cross.as_ref())
            .map(CrossSigningPublic::master_key);
        if *peer == self.me || current.as_deref() != Some(master_key) {
            return vec![self.safety_now(peer.clone())];
        }
        let identity = PeerIdentity {
            peer: peer.clone(),
            master_key: master_key.to_owned(),
            verified: true,
        };
        self.e2ee
            .peer_identities
            .insert(peer.clone(), identity.clone());
        if self.e2ee.key_changed.remove(peer) {
            self.e2ee.told_key_changed.remove(peer);
            self.e2ee.outbound.remove(peer);
        }
        let mut out = vec![
            Output::Persist(vec![StoreOp::PutPeerIdentity(identity)]),
            self.safety_now(peer.clone()),
        ];
        // What a key change held goes now, as after `AcceptPeerKey`.
        out.extend(self.on_tick(now));
        out
    }

    /// `Action::CreateBackup`: generate a new 256-bit backup key, encrypt the
    /// self-signing secret and inbound sessions, persist the backup key before
    /// uploading, emit `Event::BackupCreated` once and share over Olm with our
    /// other cross-signed client devices (spec E2EE §4.5).
    pub(super) fn create_backup(
        &mut self,
        now: Ts,
        passphrase_key: Option<BackupPassphraseKey>,
    ) -> Vec<Output> {
        if !self.e2ee.active() || !self.e2ee.registered {
            return Vec::new();
        }
        let Some(account) = self.e2ee.account.as_ref() else {
            return Vec::new();
        };
        let prev_version = self
            .e2ee
            .backup_key
            .as_ref()
            .map_or(0, BackupKey::version)
            .max(self.e2ee.remote_backup.as_ref().map_or(0, |b| b.version));
        let version = prev_version.saturating_add(1);
        let replace = prev_version > 0;
        let Ok((backup_key, recovery_key)) = BackupKey::new(self.me.as_str(), version) else {
            return Vec::new();
        };
        let Ok(enc_cross) = backup_key.encrypt_cross_signing(account.cross_signing()) else {
            return Vec::new();
        };
        let cross_wire = BackupEntryWire {
            nonce: enc_cross.nonce,
            ct: enc_cross.ct,
        };
        let passphrase_wire = match passphrase_key {
            Some(pk) => match backup_key.wrap_with_passphrase(&pk.inner) {
                Ok(slot) => Some(PassphraseSlotWire {
                    salt: slot.salt,
                    nonce: slot.nonce,
                    ct: slot.ct,
                }),
                Err(_) => return Vec::new(),
            },
            None => None,
        };
        let Ok(pickle) = secret(backup_key.pickle()) else {
            return Vec::new();
        };
        let mut sessions = std::collections::BTreeMap::new();
        let mut uploaded_sids = std::collections::BTreeMap::new();
        for group in self.e2ee.inbound.values() {
            if sessions.len() >= BACKUP_BATCH_MAX {
                break;
            }
            if let Ok(enc) = backup_key.encrypt_session(group) {
                uploaded_sids.insert(enc.session_id.clone(), enc.first_known_index);
                sessions.insert(
                    enc.session_id,
                    BackupSessionWire {
                        first_known_index: enc.first_known_index,
                        nonce: enc.nonce,
                        ct: enc.ct,
                    },
                );
            }
        }
        let own_cross = self
            .e2ee
            .directory
            .get(&self.me)
            .and_then(|d| d.cross.clone())
            .unwrap_or_else(|| account.cross_signing().public().clone());
        if let Some(mine) = self.e2ee.directory.get(&self.me) {
            for target in &mine.keys {
                if target.device_id() != account.device_id()
                    && target.kind() == DeviceKind::Client
                    && let Ok(shared) = backup_key.share(account, &own_cross, target)
                {
                    self.e2ee
                        .outbox_olm
                        .push_back((target.clone(), ToDevice::BackupKey(shared)));
                }
            }
        }
        self.e2ee.backed_up.clear();
        self.e2ee.backup_key = Some(backup_key);
        let body = wire::backup_create_body(
            version,
            replace,
            &cross_wire,
            passphrase_wire.as_ref(),
            &sessions,
        );
        let request = ApiRequest {
            serial: self.e2ee.next_serial(),
            call: ApiCall::Backup,
            body,
        };
        self.e2ee.backup_post = Some(BackupPost {
            request: request.clone(),
            kind: BackupPostKind::Upload(uploaded_sids),
        });
        let mut out = vec![
            Output::Persist(vec![StoreOp::PutBackupKey(pickle)]),
            Output::Event(Event::BackupCreated {
                version,
                recovery_key: Secret::new(Zeroizing::new(recovery_key.expose().to_owned())),
            }),
            Output::Post(request),
        ];
        out.extend(self.flush_outbox_olm(now));
        out.extend(self.on_tick(now));
        out
    }

    /// `Action::FetchBackup`: query the server's current backup metadata.
    pub(super) fn fetch_backup(&mut self) -> Vec<Output> {
        if !self.e2ee.active() || !self.e2ee.registered || self.e2ee.backup_post.is_some() {
            return Vec::new();
        }
        let request = ApiRequest {
            serial: self.e2ee.next_serial(),
            call: ApiCall::Backup,
            body: wire::backup_read_body(false),
        };
        self.e2ee.backup_post = Some(BackupPost {
            request: request.clone(),
            kind: BackupPostKind::Info,
        });
        vec![Output::Post(request)]
    }

    /// `Action::RestoreBackupWithRecoveryKey`: unlock the backup with the
    /// 256-bit recovery key (no KDF).
    pub(super) fn restore_backup_with_recovery_key(
        &mut self,
        now: Ts,
        recovery_key: &Secret,
    ) -> Vec<Output> {
        let Ok(bk) = BackupKey::from_recovery_key(self.me.as_str(), recovery_key.expose()) else {
            return vec![Output::Event(Event::BadFrame {
                reason: "invalid backup recovery key".into(),
            })];
        };
        self.e2ee.pending_restore = Some(PendingRestore::RecoveryKey(bk));
        self.post_backup_restore(now)
    }

    /// `Action::RestoreBackupWithPassphrase`: unlock the backup with the
    /// Argon2id key derived in the driver.
    pub(super) fn restore_backup_with_passphrase(
        &mut self,
        now: Ts,
        passphrase_key: BackupPassphraseKey,
    ) -> Vec<Output> {
        self.e2ee.pending_restore = Some(PendingRestore::Passphrase(passphrase_key));
        self.post_backup_restore(now)
    }

    fn post_backup_restore(&mut self, now: Ts) -> Vec<Output> {
        if !self.e2ee.active() || !self.e2ee.registered {
            return Vec::new();
        }
        if !self.e2ee.directory.contains_key(&self.me) {
            self.e2ee.wanted.insert(self.me.clone());
        }
        let mut out = Vec::new();
        if self.e2ee.backup_post.is_none() {
            let request = ApiRequest {
                serial: self.e2ee.next_serial(),
                call: ApiCall::Backup,
                body: wire::backup_read_body(true),
            };
            self.e2ee.backup_post = Some(BackupPost {
                request: request.clone(),
                kind: BackupPostKind::Restore,
            });
            out.push(Output::Post(request));
        }
        out.extend(self.post_query(now));
        out
    }

    /// Uploads any inbound Megolm sessions that are not yet backed up (or have
    /// an earlier `first_known_index` than what was uploaded).
    fn post_backup_sessions(&mut self, now: Ts) -> Vec<Output> {
        let state = &mut self.e2ee;
        if state.backup_post.is_some() || state.retry_at.is_some_and(|at| now < at) {
            return Vec::new();
        }
        let Some(backup_key) = state.backup_key.as_ref() else {
            return Vec::new();
        };
        let mut sessions = std::collections::BTreeMap::new();
        let mut uploaded_sids = std::collections::BTreeMap::new();
        for group in state.inbound.values() {
            if sessions.len() >= BACKUP_BATCH_MAX {
                break;
            }
            let sid = group.session_id();
            let idx = group.first_known_index();
            if state
                .backed_up
                .get(&sid)
                .is_some_and(|&prev_idx| idx >= prev_idx)
            {
                continue;
            }
            if let Ok(enc) = backup_key.encrypt_session(group) {
                uploaded_sids.insert(enc.session_id.clone(), enc.first_known_index);
                sessions.insert(
                    enc.session_id,
                    BackupSessionWire {
                        first_known_index: enc.first_known_index,
                        nonce: enc.nonce,
                        ct: enc.ct,
                    },
                );
            }
        }
        if sessions.is_empty() {
            return Vec::new();
        }
        let version = backup_key.version();
        state.retry_at = None;
        let request = ApiRequest {
            serial: state.next_serial(),
            call: ApiCall::Backup,
            body: wire::backup_sessions_body(version, &sessions),
        };
        state.backup_post = Some(BackupPost {
            request: request.clone(),
            kind: BackupPostKind::Upload(uploaded_sids),
        });
        vec![Output::Post(request)]
    }

    /// A `200` answer to `POST /api/e2ee/backup`.
    pub(super) fn backup_posted(
        &mut self,
        now: Ts,
        request: &ApiRequest,
        body: &str,
    ) -> Vec<Output> {
        let Some(post) = self.e2ee.backup_post.take_if(|b| &b.request == request) else {
            return Vec::new();
        };
        let answer = match wire::decode_backup(body) {
            Ok(answer) => answer,
            Err(error) => {
                self.e2ee.failed(now);
                return vec![Output::Event(Event::BadFrame {
                    reason: format!("backup: {error}"),
                })];
            }
        };
        self.e2ee.succeeded();
        let is_restore = matches!(post.kind, BackupPostKind::Restore);
        if !is_restore || !answer.sessions.is_empty() || answer.version == 0 {
            self.e2ee.remote_backup = Some(answer.clone());
        }
        match post.kind {
            BackupPostKind::Upload(sids) => {
                for (sid, idx) in sids {
                    self.e2ee.backed_up.insert(sid, idx);
                }
                let mut out = Vec::new();
                if self.e2ee.pending_restore.is_some() {
                    out.extend(self.post_backup_restore(now));
                } else {
                    out.extend(self.post_backup_sessions(now));
                }
                out
            }
            BackupPostKind::Info => {
                let mut out = vec![Output::Event(Event::BackupInfo {
                    version: answer.version,
                    passphrase_salt: answer.passphrase.map(|p| p.salt),
                    session_count: answer.session_count,
                })];
                if self.e2ee.pending_restore.is_some() {
                    out.extend(self.post_backup_restore(now));
                }
                out
            }
            BackupPostKind::Restore => {
                self.e2ee.remote_backup = Some(answer);
                self.try_complete_restore(now)
            }
        }
    }

    /// Unlocks `remote_backup` once both the backup payload and `self.me`'s
    /// directory entry have arrived.
    fn try_complete_restore(&mut self, now: Ts) -> Vec<Output> {
        if self.e2ee.pending_restore.is_none()
            || self.e2ee.backup_post.is_some()
            || !self.e2ee.directory.contains_key(&self.me)
        {
            return Vec::new();
        }
        let Some(remote) = self.e2ee.remote_backup.clone() else {
            return Vec::new();
        };
        let Some(pending) = self.e2ee.pending_restore.take() else {
            return Vec::new();
        };
        if remote.version == 0 {
            return vec![Output::Event(Event::BadFrame {
                reason: "backup: no backup on server".into(),
            })];
        }
        let Some(cross_wire) = remote.cross_signing else {
            return vec![Output::Event(Event::BadFrame {
                reason: "backup: missing crossSigning".into(),
            })];
        };
        let backup_key = match pending {
            PendingRestore::RecoveryKey(bk) => {
                if bk.version() != remote.version {
                    return vec![Output::Event(Event::BadFrame {
                        reason: "backup: version mismatch".into(),
                    })];
                }
                bk
            }
            PendingRestore::Passphrase(derived) => {
                let Some(slot_wire) = remote.passphrase else {
                    return vec![Output::Event(Event::BadFrame {
                        reason: "backup: no passphrase slot".into(),
                    })];
                };
                let slot = PassphraseSlot {
                    salt: slot_wire.salt,
                    nonce: slot_wire.nonce,
                    ct: slot_wire.ct,
                };
                match BackupKey::from_passphrase_slot(
                    self.me.as_str(),
                    remote.version,
                    &slot,
                    &derived.inner,
                ) {
                    Ok(bk) => bk,
                    Err(error) => {
                        return vec![Output::Event(Event::BadFrame {
                            reason: format!("backup passphrase: {error}"),
                        })];
                    }
                }
            }
        };
        let expected_cross = self
            .e2ee
            .directory
            .get(&self.me)
            .and_then(|d| d.cross.as_ref());
        let cross_entry = EncryptedBackupEntry {
            nonce: cross_wire.nonce,
            ct: cross_wire.ct,
        };
        let Ok(restored_cross) = backup_key.decrypt_cross_signing(&cross_entry, expected_cross)
        else {
            return vec![Output::Event(Event::BadFrame {
                reason: "backup: cannot decrypt crossSigning".into(),
            })];
        };
        let mut ops = Vec::new();
        if let Some(account) = self.e2ee.account.as_mut()
            && account.set_cross_signing(restored_cross).is_ok()
            && let Ok(pickle) = secret(account.pickle())
        {
            ops.push(StoreOp::PutCryptoAccount(pickle));
            self.e2ee.needs_reupload = true;
            self.e2ee.directory.remove(&self.me);
        }
        if let Ok(pickle) = secret(backup_key.pickle()) {
            ops.push(StoreOp::PutBackupKey(pickle));
        }
        let mut opened: Vec<SessionRef> = Vec::new();
        let mut restored_sessions = 0usize;
        self.e2ee.backed_up.clear();
        for (sid, wire_sess) in &remote.sessions {
            let Ok(group) = backup_key.decrypt_session(sid, &wire_sess.nonce, &wire_sess.ct) else {
                continue;
            };
            let Ok(sender) = Login::parse(group.sender().login()) else {
                continue;
            };
            self.e2ee
                .backed_up
                .insert(sid.clone(), group.first_known_index());
            if sender != self.me && self.e2ee.encrypted.insert(sender.clone()) {
                ops.push(StoreOp::MarkEncrypted(sender.clone()));
                self.e2ee.fresh_encrypted.push(sender.clone());
            }
            let session: SessionRef = (
                sender,
                group.sender().device_id().to_owned(),
                group.session_id(),
            );
            if let Some(existing) = self.e2ee.inbound.get_mut(&session) {
                if existing.merge(group)
                    && let Ok(pickle) = secret(existing.pickle())
                {
                    ops.push(StoreOp::PutInboundGroup(InboundRow {
                        sender: session.0.clone(),
                        device: session.1.clone(),
                        session: session.2.clone(),
                        pickle,
                    }));
                    opened.push(session);
                    restored_sessions = restored_sessions.saturating_add(1);
                }
                continue;
            }
            if let Ok(pickle) = secret(group.pickle()) {
                ops.push(StoreOp::PutInboundGroup(InboundRow {
                    sender: session.0.clone(),
                    device: session.1.clone(),
                    session: session.2.clone(),
                    pickle,
                }));
                self.e2ee.inbound.insert(session.clone(), group);
                opened.push(session);
                restored_sessions = restored_sessions.saturating_add(1);
            }
        }
        let version = backup_key.version();
        self.e2ee.backup_key = Some(backup_key);
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        out.push(Output::Event(Event::BackupRestored {
            version,
            sessions: restored_sessions,
        }));
        for session in opened {
            out.extend(self.unseal_session(&session));
        }
        out.extend(self.seal_due(now));
        out
    }
    /// Asks our other cross-signed devices for any session keys `sealed` rows
    /// are still waiting for (spec E2EE §4.2, §4.3).
    fn request_missing_keys(&mut self, _now: Ts) -> Vec<Output> {
        let state = &mut self.e2ee;
        if state.sealed.is_empty() {
            return Vec::new();
        }
        if !state.directory.contains_key(&self.me) {
            state.wanted.insert(self.me.clone());
            return Vec::new();
        }
        let (Some(account), Some(mine)) = (state.account.as_ref(), state.directory.get(&self.me))
        else {
            return Vec::new();
        };
        if mine
            .cross
            .as_ref()
            .is_some_and(|c| !c.verifies(&account.identity()))
        {
            return Vec::new();
        }
        let others: Vec<DeviceKeys> = mine
            .keys
            .iter()
            .filter(|d| d.device_id() != account.device_id() && d.kind() == DeviceKind::Client)
            .cloned()
            .collect();
        if others.is_empty() {
            return Vec::new();
        }
        for row in &state.sealed {
            let session: SessionRef = (
                row.from.clone(),
                row.envelope.dev.clone(),
                row.envelope.sid.clone(),
            );
            if state.inbound.contains_key(&session) || !state.requested_keys.insert(session) {
                continue;
            }
            let req = RoomKeyRequest {
                conversation: Conversation::new(self.me.as_str(), row.peer.as_str()),
                sender: row.from.as_str().to_owned(),
                sender_device: row.envelope.dev.clone(),
                session_id: row.envelope.sid.clone(),
            };
            for target in &others {
                state
                    .outbox_olm
                    .push_back((target.clone(), ToDevice::RoomKeyRequest(req.clone())));
            }
        }
        Vec::new()
    }

    /// Encrypts queued `outbox_olm` messages whose Olm channel is ready, or
    /// claims one-time keys for the rest.
    fn flush_outbox_olm(&mut self, now: Ts) -> Vec<Output> {
        if self.e2ee.outbox_olm.is_empty() || self.e2ee.account.is_none() {
            return Vec::new();
        }
        let mut ops = Vec::new();
        let mut need_session: Vec<DeviceKeys> = Vec::new();
        let mut deferred = std::collections::VecDeque::new();
        let queued = std::mem::take(&mut self.e2ee.outbox_olm);
        for (device, message) in queued {
            let Some(reference) = device_ref(&device) else {
                continue;
            };
            let ready = self
                .e2ee
                .channels
                .get(&reference)
                .is_some_and(|c| c.has_session() && c.peer() == &device);
            if !ready {
                if !self.e2ee.unreachable.contains(&reference) {
                    if !need_session.contains(&device) {
                        need_session.push(device.clone());
                    }
                    deferred.push_back((device, message));
                }
                continue;
            }
            let id = self.e2ee.next_key_id(now);
            let (Some(account), Some(channel)) = (
                self.e2ee.account.as_ref(),
                self.e2ee.channels.get_mut(&reference),
            ) else {
                continue;
            };
            if let Ok(body) = channel.encrypt(account, &message)
                && let Ok(pickle) = secret(channel.pickle())
            {
                ops.push(StoreOp::PutOlmChannel(OlmChannelRow {
                    login: reference.0.clone(),
                    device: reference.1.clone(),
                    pickle,
                }));
                let item = PendingToDevice {
                    id,
                    to: reference.0,
                    device: reference.1,
                    body: body.to_string(),
                };
                ops.push(StoreOp::PutToDevice(item.clone()));
                self.e2ee.keys_out.push_back(KeyOut { item, sent: false });
            }
        }
        self.e2ee.outbox_olm = deferred;
        let mut out = Vec::new();
        if !ops.is_empty() {
            out.push(Output::Persist(ops));
        }
        if !need_session.is_empty() {
            out.extend(self.post_claim(now, need_session));
        }
        out
    }
}

/// Why this side gave up on a SAS handshake (`Event::SasCancelled::reason`,
/// and the `reason` of the `Cancel` the other device is sent).
const SAS_COMMITMENT_MISMATCH: &str = "commitment_mismatch";
const SAS_KEY_MISMATCH: &str = "key_mismatch";
const SAS_MAC_MISMATCH: &str = "mac_mismatch";
const SAS_UNKNOWN_IDENTITY: &str = "unknown_identity";
/// Told to the devices a fanned-out `Start` reached but another device of the
/// same account answered first: not a refusal, and nothing to show anyone.
pub(crate) const SAS_ACCEPTED_ELSEWHERE: &str = "accepted_elsewhere";

/// The first `Accept` for a handshake offered to several devices: that
/// device's session becomes the handshake, every other device asked is told
/// `accepted_elsewhere`. Returns false when `peer_device` was not asked.
fn take_offer(
    state: &mut crate::e2ee::E2ee,
    transaction_id: &str,
    peer_device: &DeviceKeys,
) -> bool {
    let Some(offers) = state.sas_offers.get(transaction_id) else {
        return false;
    };
    if !offers.iter().any(|s| s.peer_device() == peer_device) {
        return false;
    }
    let offers = state.sas_offers.remove(transaction_id).unwrap_or_default();
    for session in offers {
        if session.peer_device() == peer_device {
            state
                .sas_sessions
                .insert(transaction_id.to_owned(), session);
        } else {
            state.outbox_olm.push_back((
                session.peer_device().clone(),
                ToDevice::Sas(SasMessage::Cancel {
                    transaction_id: transaction_id.to_owned(),
                    reason: SAS_ACCEPTED_ELSEWHERE.to_owned(),
                }),
            ));
        }
    }
    true
}

/// Ends a handshake that can no longer succeed: forgets it, tells the other
/// device so it stops waiting for an answer that will never come, and tells
/// the person why.
fn abort_sas(
    state: &mut crate::e2ee::E2ee,
    transaction_id: &str,
    reason: &str,
    events: &mut Vec<Output>,
) {
    let Some(session) = state.sas_sessions.remove(transaction_id) else {
        return;
    };
    let peer_device = session.peer_device().clone();
    let Ok(peer) = Login::parse(peer_device.login()) else {
        return;
    };
    let device = peer_device.device_id().to_owned();
    state.outbox_olm.push_back((
        peer_device,
        ToDevice::Sas(SasMessage::Cancel {
            transaction_id: transaction_id.to_owned(),
            reason: reason.to_owned(),
        }),
    ));
    let name = state.device_name(&peer, &device);
    events.push(Output::Event(Event::SasCancelled {
        transaction_id: transaction_id.to_owned(),
        peer,
        device,
        name,
        reason: reason.to_owned(),
    }));
}

/// The other device's reason code, as far as it is one: a short machine word,
/// never free text from the wire put in front of the person.
fn sas_reason_code(reason: &str) -> String {
    let clean = reason.len() <= 64
        && !reason.is_empty()
        && reason
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.');
    if clean {
        reason.to_owned()
    } else {
        "unknown".to_owned()
    }
}

/// Handles one incoming `SasMessage` inside `process_inbox`.
fn on_sas_message(
    me: &Login,
    state: &mut crate::e2ee::E2ee,
    peer_device: DeviceKeys,
    sas_msg: SasMessage,
    ops: &mut Vec<StoreOp>,
    events: &mut Vec<Output>,
) {
    let Some(own_identity) = state
        .account
        .as_ref()
        .map(tailchat_crypto::Account::identity)
    else {
        return;
    };
    let Some(own_cross_master) = state
        .account
        .as_ref()
        .map(|a| a.cross_signing().master_key())
    else {
        return;
    };
    let Ok(peer_login) = Login::parse(peer_device.login()) else {
        return;
    };
    match sas_msg {
        SasMessage::Start { transaction_id } => {
            let (session, accept) =
                SasSession::accept(transaction_id.clone(), own_identity, peer_device.clone());
            state.sas_sessions.insert(transaction_id.clone(), session);
            state
                .outbox_olm
                .push_back((peer_device.clone(), ToDevice::Sas(accept)));
            events.push(Output::Event(Event::SasStarted {
                transaction_id,
                peer: peer_login,
                device: peer_device.device_id().to_owned(),
            }));
        }
        SasMessage::Accept {
            transaction_id,
            commitment,
        } => {
            if !state.sas_sessions.contains_key(&transaction_id) {
                take_offer(state, &transaction_id, &peer_device);
            }
            let Some(session) = state.sas_sessions.get_mut(&transaction_id) else {
                return;
            };
            if session.peer_device() != &peer_device {
                return;
            }
            match session.on_accept(&commitment) {
                Ok(key_msg) => {
                    state
                        .outbox_olm
                        .push_back((peer_device, ToDevice::Sas(key_msg)));
                }
                Err(_) => abort_sas(state, &transaction_id, SAS_COMMITMENT_MISMATCH, events),
            }
        }
        SasMessage::Key {
            transaction_id,
            key,
        } => {
            let Some(session) = state.sas_sessions.get_mut(&transaction_id) else {
                return;
            };
            if session.peer_device() != &peer_device {
                return;
            }
            match session.on_key(&key) {
                Ok((code, maybe_reply)) => {
                    if let Some(reply) = maybe_reply {
                        state
                            .outbox_olm
                            .push_back((peer_device.clone(), ToDevice::Sas(reply)));
                    }
                    events.push(Output::Event(Event::SasCodeReady {
                        transaction_id,
                        peer: peer_login,
                        device: peer_device.device_id().to_owned(),
                        emoji_indices: code.emoji_indices,
                        decimals: code.decimals,
                    }));
                }
                Err(_) => abort_sas(state, &transaction_id, SAS_KEY_MISMATCH, events),
            }
        }
        SasMessage::Mac {
            transaction_id,
            master_key,
            mac,
        } => {
            // Only the device this handshake is with may move it, or end it.
            if state
                .sas_sessions
                .get(&transaction_id)
                .is_none_or(|session| session.peer_device() != &peer_device)
            {
                return;
            }
            let expected_master = if peer_login == *me {
                state
                    .directory
                    .get(me)
                    .and_then(|d| d.cross.as_ref())
                    .map_or(own_cross_master, CrossSigningPublic::master_key)
            } else {
                let Some(m) = state
                    .directory
                    .get(&peer_login)
                    .and_then(|d| d.cross.as_ref())
                    .map(CrossSigningPublic::master_key)
                else {
                    abort_sas(state, &transaction_id, SAS_UNKNOWN_IDENTITY, events);
                    return;
                };
                m
            };
            let Some(session) = state.sas_sessions.get_mut(&transaction_id) else {
                return;
            };
            match session.on_mac(&master_key, &mac, &expected_master) {
                Ok(Some(verified)) => {
                    state.sas_sessions.remove(&transaction_id);
                    complete_verification(me, state, verified, ops, events);
                }
                Ok(None) => {}
                Err(_) => abort_sas(state, &transaction_id, SAS_MAC_MISMATCH, events),
            }
        }
        SasMessage::Cancel {
            transaction_id,
            reason,
        } => {
            // Still an offer: that one device is out. The handshake ends only
            // when no device asked is left to answer it.
            if let Some(offers) = state.sas_offers.get_mut(&transaction_id) {
                let before = offers.len();
                offers.retain(|s| s.peer_device() != &peer_device);
                if offers.len() == before || !offers.is_empty() {
                    return;
                }
                state.sas_offers.remove(&transaction_id);
                events.push(Output::Event(Event::SasCancelled {
                    transaction_id,
                    name: state.device_name(&peer_login, peer_device.device_id()),
                    peer: peer_login,
                    device: peer_device.device_id().to_owned(),
                    reason: sas_reason_code(&reason),
                }));
                return;
            }
            // A cancel from any other device must not end somebody else's
            // handshake: a transaction id is not a secret.
            if state
                .sas_sessions
                .get(&transaction_id)
                .is_none_or(|session| session.peer_device() != &peer_device)
            {
                return;
            }
            state.sas_sessions.remove(&transaction_id);
            events.push(Output::Event(Event::SasCancelled {
                transaction_id,
                name: state.device_name(&peer_login, peer_device.device_id()),
                peer: peer_login,
                device: peer_device.device_id().to_owned(),
                reason: sas_reason_code(&reason),
            }));
        }
    }
}

/// Records a completed SAS or QR verification: shares `CrossSigning` with a
/// verified own device, or stores `PeerIdentity { verified: true }` for a peer.
fn complete_verification(
    me: &Login,
    state: &mut crate::e2ee::E2ee,
    verified: SasVerified,
    ops: &mut Vec<StoreOp>,
    events: &mut Vec<Output>,
) {
    let Ok(peer_login) = Login::parse(verified.peer_device.login()) else {
        return;
    };
    let device_id = verified.peer_device.device_id().to_owned();
    if peer_login == *me {
        let is_authority = state
            .directory
            .get(me)
            .and_then(|d| d.cross.as_ref())
            .is_none_or(|c| Some(c) == state.account.as_ref().map(|a| a.cross_signing().public()));
        if is_authority && let Some(account) = state.account.as_ref() {
            if let Ok(shared) = account
                .cross_signing()
                .share(account, &verified.peer_device)
            {
                state.outbox_olm.push_back((
                    verified.peer_device.clone(),
                    ToDevice::CrossSigningKey(shared),
                ));
            }
            if let Some(bk) = state.backup_key.as_ref()
                && let Ok(shared_bk) = bk.share(
                    account,
                    account.cross_signing().public(),
                    &verified.peer_device,
                )
            {
                state
                    .outbox_olm
                    .push_back((verified.peer_device, ToDevice::BackupKey(shared_bk)));
            }
        }
    } else {
        let identity = PeerIdentity {
            peer: peer_login.clone(),
            master_key: verified.peer_master_key,
            verified: true,
        };
        state
            .peer_identities
            .insert(peer_login.clone(), identity.clone());
        ops.push(StoreOp::PutPeerIdentity(identity));
        if state.key_changed.remove(&peer_login) {
            state.told_key_changed.remove(&peer_login);
            state.outbound.remove(&peer_login);
        }
    }
    events.push(Output::Event(Event::DeviceVerified {
        name: state.device_name(&peer_login, &device_id),
        peer: peer_login,
        device: device_id,
    }));
}

/// `Event::SafetyCode`.
fn safety_event(
    peer: Login,
    status: &str,
    halves: Vec<SafetyHalf>,
    master_key: String,
    number: String,
    verified: bool,
) -> Output {
    Output::Event(Event::SafetyCode {
        peer,
        status: status.to_owned(),
        halves,
        master_key,
        number,
        verified,
    })
}
