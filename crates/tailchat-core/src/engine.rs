use std::collections::HashSet;

use crate::api::{Action, Input, Output};
use crate::e2ee::{E2ee, Stored};
use crate::error::CoreError;
use crate::frames;
use crate::ids::{Seq, Ts};
use crate::login::Login;
use crate::outbox::Outbox;
use crate::platform::{Snapshot, Token};
use crate::sync::SyncState;

/// End-to-end encryption: device registration and keys.
mod e2ee;
/// The work behind `handle`: one function per kind of input.
mod handlers;
/// End-to-end encryption: devices, Olm, key messages, seals, envelopes.
mod keys;
/// The account feed, history walks and messages received live.
mod sync;

/// The engine: one per signed-in account. Feed it inputs with [`Core::handle`]
/// and carry out the outputs it returns, in order.
pub struct Core {
    /// The account this core works for.
    me: Login,
    /// Sent in `auth` on every new connection.
    token: Token,
    /// Extra capabilities advertised on each connection.
    extra_caps: Vec<String>,
    /// `auth` says `webFeatures: true`: this core runs in the browser.
    web_features: bool,
    /// What `keys/upload` calls this device ("Chrome · macOS"), so the other
    /// side's verification lines name it instead of its random id.
    device_name: String,
    /// The server answered `ready`; until then messages only wait in `outbox`.
    ready: bool,
    /// How far the sync-v1 feed has been read.
    cursor: Seq,
    /// Messages of ours the server has not committed yet, with their retry
    /// timers, and the delivery receipts this device owes.
    outbox: Outbox,
    /// Who we may write to (from `ready` and `users`); anyone else fails at once.
    roster: HashSet<Login>,
    /// What this device holds, and what the feed says it still owes.
    sync: SyncState,
    /// End-to-end encryption: this device's account and keys.
    e2ee: E2ee,
}

impl Core {
    /// Starts a core for `me` from what the driver loaded from disk.
    pub fn new(me: Login, token: Token, snapshot: Snapshot) -> Self {
        let outbox = Outbox::restore(
            snapshot.pending,
            snapshot.sent,
            snapshot.receipts,
            snapshot.acks,
        );
        let mut sync = SyncState::restore(snapshot.held, snapshot.backfill, snapshot.own_reads);
        // Committed rows are held whether or not the storage listed them.
        for (peer, id) in outbox.sent_keys() {
            if !sync.holds(peer, id) {
                sync.hold(peer.clone(), id.clone(), None);
            }
        }
        let e2ee = E2ee::restore(
            &me,
            Stored {
                account: snapshot.crypto_account,
                channels: snapshot.olm_channels,
                outbound: snapshot.outbound_groups,
                inbound: snapshot.inbound_groups,
                to_device: snapshot.to_device,
                encrypted: snapshot.encrypted,
                sealed: snapshot.sealed,
                peer_identities: snapshot.peer_identities,
                backup_key: snapshot.backup_key,
            },
        );
        Self {
            me,
            token,
            extra_caps: Vec::new(),
            web_features: false,
            device_name: String::new(),
            ready: false,
            cursor: snapshot.cursor,
            outbox,
            roster: HashSet::new(),
            sync,
            e2ee,
        }
    }

    /// Replaces the extra capabilities advertised on later connections.
    ///
    /// Invalid or duplicate capabilities are omitted from the auth frame.
    pub fn set_extra_caps(&mut self, caps: Vec<String>) {
        self.extra_caps = caps;
    }

    /// Marks this core as the browser's: later `auth` frames carry
    /// `webFeatures: true`, which is how the server knows a web session.
    pub fn set_web_features(&mut self, on: bool) {
        self.web_features = on;
    }

    /// Names this device in later `keys/upload` bodies. The server keeps at
    /// most 64 characters and drops control characters; empty sends no name.
    pub fn set_device_name(&mut self, name: String) {
        self.device_name = name;
    }

    /// Takes one input and returns what the driver must do, in order.
    ///
    /// `now` is the driver's clock: the core has none of its own.
    /// `Err` means an invalid action (blank text, full queue, duplicate id or
    /// retry of a non-failed message). No existing row is removed on `Err`;
    /// bad data from the server never is an `Err`, it becomes
    /// [`crate::Event::BadFrame`].
    pub fn handle(&mut self, now: Ts, input: Input) -> Result<Vec<Output>, CoreError> {
        let mut out = self.dispatch(now, input)?;
        // Whatever path opened the first sealed row of a conversation, its
        // lock is told here, after the row itself.
        out.extend(self.tell_fresh_encrypted());
        Ok(out)
    }

    fn dispatch(&mut self, now: Ts, input: Input) -> Result<Vec<Output>, CoreError> {
        match input {
            Input::Connected => {
                self.ready = false;
                Ok(vec![Output::Send(frames::auth_for(
                    &self.token,
                    &self.auth_caps(),
                    self.web_features,
                )?)])
            }
            Input::Disconnected => {
                self.ready = false;
                Ok(Vec::new())
            }
            Input::Tick => Ok(self.on_tick(now)),
            Input::Frame(raw) => Ok(self.on_frame(now, &raw)),

            Input::Action(Action::SendText { id, peer, text }) => {
                self.send_text(now, id, peer, text)
            }
            Input::Action(Action::SendImage {
                id,
                peer,
                text,
                image,
            }) => self.send_image(now, id, peer, text, image),
            Input::Action(Action::SendWith {
                id,
                peer,
                text,
                image,
                extra,
            }) => self.send_with(now, id, peer, text, image, extra),
            Input::Action(Action::EditText {
                id,
                peer,
                target,
                text,
            }) => self.edit_text(now, id, peer, target, text),
            Input::Action(Action::SendUnencrypted { peer, id }) => {
                self.send_unencrypted(now, &peer, &id)
            }
            Input::Action(Action::CancelHeld { peer, id }) => self.cancel_held(&peer, &id),
            Input::Action(Action::AcceptPeerKey { peer }) => Ok(self.accept_peer_key(now, &peer)),
            Input::Action(Action::LoadOlder { peer, below }) => Ok(self.load_older(now, peer, below)),
            Input::Action(Action::StartSas { peer, device }) => {
                Ok(self.start_sas(now, peer, vec![device]))
            }
            Input::Action(Action::StartSasAny { peer, devices }) => {
                Ok(self.start_sas(now, peer, devices))
            }
            Input::Action(Action::ConfirmSas { transaction_id }) => {
                Ok(self.confirm_sas(now, &transaction_id))
            }
            Input::Action(Action::CancelSas { transaction_id }) => {
                Ok(self.cancel_sas(now, &transaction_id))
            }
            Input::Action(Action::VerifyWithQr { qr }) => Ok(self.verify_with_qr(now, &qr)),
            Input::Action(Action::SafetyCode { peer }) => Ok(self.safety_code(now, peer)),
            Input::Action(Action::ConfirmSafetyCode { peer, master_key }) => {
                Ok(self.confirm_safety_code(now, &peer, &master_key))
            }
            Input::Action(Action::CreateBackup { passphrase_key }) => {
                Ok(self.create_backup(now, passphrase_key))
            }
            Input::Action(Action::FetchBackup) => Ok(self.fetch_backup()),
            Input::Action(Action::RestoreBackupWithRecoveryKey { recovery_key }) => {
                Ok(self.restore_backup_with_recovery_key(now, &recovery_key))
            }
            Input::Action(Action::RestoreBackupWithPassphrase { passphrase_key }) => {
                Ok(self.restore_backup_with_passphrase(now, passphrase_key))
            }
            Input::Action(Action::ResetCrossSigning { password }) => {
                Ok(self.reset_cross_signing(&password))
            }
            Input::Action(Action::Retry { peer, id }) => self.retry(now, peer, id),
            Input::PeerReceipts(receipts) => Ok(self.outbox.watermarks(receipts)),
            Input::SendFailed { peer, id } => Ok(self.write_failed(&peer, &id)),
            Input::History { request, body } => Ok(self.on_history(now, &request, &body)),
            Input::HistoryFailed { request, error } => {
                Ok(self.on_history_failed(now, &request, error))
            }
            Input::Posted { request, body } => {
                let mut out = self.on_posted(now, &request, &body);
                out.extend(self.on_tick(now));
                Ok(out)
            }
            Input::PostFailed { request, error } => Ok(self.on_post_failed(now, &request, error)),
        }
    }
}
