//! End-to-end encryption state (spec E2EE §6, sub-stage 6c): this device's
//! Olm account and its registration on the server. The decisions are in
//! `engine/e2ee.rs`.
//!
//! Off unless the driver turns it on ([`crate::Core::set_e2ee`]): a core
//! that is off says and does exactly what it did before stage 6.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use tailchat_crypto::{
    Account, BackupKey, CrossSigning, CrossSigningPublic, DeviceKeys, InboundGroup, OlmChannel,
    OutboundGroup, SasSession, ToDevice,
};

use crate::api::{
    ApiRequest, InboundRow, OlmChannelRow, OutboundRow, PeerIdentity, PendingOutgoing,
    PendingToDevice, Seal, SealedRow,
};
use crate::frames::e2ee::{BackupAnswer, ToDeviceIn};
use crate::ids::{Seq, Ts};
use crate::login::Login;
use crate::platform::{BackupPassphraseKey, Secret};
/// One-time keys the server should hold for this device (`E2EE_OTK_LIMIT`).
pub(crate) const OTK_TARGET: usize = 50;
/// Below this many on the server, the device tops up to [`OTK_TARGET`].
pub(crate) const OTK_LOW: usize = 25;
/// First pause after a failed key request.
const RETRY_FIRST_MS: i64 = 5_000;
/// Longest pause between key requests.
const RETRY_MAX_MS: i64 = 300_000;

/// A `keys/upload` in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Upload {
    /// The request awaiting an answer.
    pub(crate) request: ApiRequest,
}

/// An [`crate::api::Action::ResetCrossSigning`] the server has not settled.
#[derive(Debug)]
pub(crate) struct PendingReset {
    /// The `keys/upload` that carries it.
    pub(crate) request: ApiRequest,
    /// The new keys, applied only once the server is known to hold them.
    pub(crate) cross: CrossSigning,
    /// The answer was lost (no HTTP answer, or the socket was replaced): the
    /// server may or may not have taken the keys. Settled by the next
    /// `keys/query` of this account — it publishes the new master key or not.
    pub(crate) in_doubt: bool,
}

/// What `keys/query` said about one account on this connection.
#[derive(Debug, Clone, Default)]
pub(crate) struct Devices {
    /// The account's cross-signing keys, when published and valid.
    pub(crate) cross: Option<CrossSigningPublic>,
    /// Devices whose self-signed keys checked out and, when `cross` is set,
    /// are signed by the account's self-signing key.
    pub(crate) keys: Vec<DeviceKeys>,
    /// Every device whose self-signed keys checked out (including unverified
    /// ones, so SAS can reach them).
    pub(crate) all_keys: Vec<DeviceKeys>,
    /// Device ids not signed by `cross`.
    pub(crate) unverified: Vec<String>,
    /// What each device calls itself ("Chrome · macOS"), by id; unnamed
    /// devices are missing. Unsigned text from the server, shown as is.
    pub(crate) names: BTreeMap<String, String>,
    /// Device ids that announced [`crate::frames::e2ee::BLOB_CAP`]: only
    /// these read an attachment as bytes inside the ciphertext.
    pub(crate) blob: BTreeSet<String>,
    /// Recently used sessions that cannot read anything encrypted.
    pub(crate) legacy: u32,
    /// Every listed device and `crossSigning` checked out.
    pub(crate) complete: bool,
}

/// A `keys/query` in flight.
#[derive(Debug, Clone)]
pub(crate) struct Query {
    /// The request awaiting an answer.
    pub(crate) request: ApiRequest,
    /// Whom it asks about.
    pub(crate) logins: BTreeSet<Login>,
}

/// A `POST /api/e2ee/trust` in flight.
#[derive(Debug, Clone)]
pub(crate) struct TrustPost {
    /// The request awaiting an answer.
    pub(crate) request: ApiRequest,
    /// The master key it vouches for, per peer.
    pub(crate) vouched: BTreeMap<Login, String>,
}

/// A `keys/claim` in flight.
#[derive(Debug, Clone)]
pub(crate) struct Claim {
    /// The request awaiting an answer.
    pub(crate) request: ApiRequest,
    /// The devices it claims a key for.
    pub(crate) devices: Vec<DeviceKeys>,
}

/// What an in-flight `POST /api/e2ee/backup` is doing.
#[derive(Debug, Clone)]
pub(crate) enum BackupPostKind {
    /// Metadata check (`Action::FetchBackup` → `Event::BackupInfo`).
    Info,
    /// Full fetch (`includeSessions: true`) to unlock and apply on this device.
    Restore,
    /// Uploading a new/rotated backup or a batch of Megolm sessions (`sid → first_known_index`).
    Upload(BTreeMap<String, u32>),
}

/// A `POST /api/e2ee/backup` in flight.
#[derive(Debug, Clone)]
pub(crate) struct BackupPost {
    /// The request awaiting an answer.
    pub(crate) request: ApiRequest,
    /// What it is doing.
    pub(crate) kind: BackupPostKind,
}

/// How a pending restore will unlock the fetched backup.
#[derive(Debug, Clone)]
pub(crate) enum PendingRestore {
    /// From a 256-bit recovery key (no KDF).
    RecoveryKey(BackupKey),
    /// From an Argon2id key derived in the driver.
    Passphrase(BackupPassphraseKey),
}

/// A key message waiting for `to-device-accepted`.
#[derive(Debug, Clone)]
pub(crate) struct KeyOut {
    /// The stored row.
    pub(crate) item: PendingToDevice,
    /// Written on the current connection.
    pub(crate) sent: bool,
}

/// `(login, device id)`.
pub(crate) type DeviceRef = (Login, String);
/// `(sender, device id, session id)`.
pub(crate) type SessionRef = (Login, String, String);

/// Encryption state, in memory.
#[derive(Debug, Default)]
pub(crate) struct E2ee {
    /// The driver turned encryption on: `e2ee-v1` goes in `auth`.
    pub(crate) enabled: bool,
    /// The server answered `ready` with `e2ee-v1` on this connection.
    pub(crate) available: bool,
    /// This device's account, once the server gave it a device id.
    pub(crate) account: Option<Account>,
    /// The `keys/upload` in flight.
    pub(crate) upload: Option<Upload>,
    /// The server holds this device's keys, checked on this connection.
    pub(crate) registered: bool,
    /// No key request before this time, after a failure.
    pub(crate) retry_at: Option<Ts>,
    /// Failures in a row, for the pause.
    failures: u32,
    /// The server refused the token: no requests until the next `ready`.
    pub(crate) refused: bool,
    /// Encryption cannot work on this device; the reason is told once.
    pub(crate) broken: Option<Broken>,
    /// The serial of the last request issued.
    serial: u64,
    /// Devices per account, as `keys/query` said on this connection.
    pub(crate) directory: BTreeMap<Login, Devices>,
    /// The `keys/query` in flight.
    pub(crate) query: Option<Query>,
    /// Accounts to ask about once the query in flight is answered.
    pub(crate) wanted: BTreeSet<Login>,
    /// The `keys/claim` in flight.
    pub(crate) claim: Option<Claim>,
    /// Devices with no key to claim on this connection.
    pub(crate) unreachable: BTreeSet<DeviceRef>,
    /// Olm channels, per peer device.
    pub(crate) channels: BTreeMap<DeviceRef, OlmChannel>,
    /// This device's sending session, per conversation.
    pub(crate) outbound: BTreeMap<Login, OutboundGroup>,
    /// Sessions to read other devices' messages with.
    pub(crate) inbound: BTreeMap<SessionRef, InboundGroup>,
    /// Key messages the server has not accepted yet, oldest first.
    pub(crate) keys_out: VecDeque<KeyOut>,
    /// The id of the last key message written, for `throttle`.
    pub(crate) last_key_write: Option<String>,
    /// Key messages received and not handled yet, in `seq` order.
    pub(crate) inbox: VecDeque<ToDeviceIn>,
    /// The last `seq` acknowledged on this connection.
    pub(crate) acked: Option<Seq>,
    /// Conversations that carried an encrypted message.
    pub(crate) encrypted: BTreeSet<Login>,
    /// Stored rows waiting for their session key.
    pub(crate) sealed: Vec<SealedRow>,
    /// The last key message id made.
    key_serial: u64,
    /// Held rows the UI was told about (`PlaintextHeld`), this run.
    pub(crate) told_held: BTreeSet<(Login, crate::ids::MessageId)>,
    /// The last `EncryptionState` told per conversation, this run.
    pub(crate) told_state: BTreeMap<Login, bool>,
    /// Conversations that became encrypted on this input by something other
    /// than a send (a sealed row opened, sessions restored from the backup):
    /// `Core::handle` tells their state once the input is done.
    pub(crate) fresh_encrypted: Vec<Login>,
    /// Known master keys of peer accounts (TOFU and verified, §4.2).
    pub(crate) peer_identities: BTreeMap<Login, PeerIdentity>,
    /// Peers whose master key changed (or disappeared) and await confirmation.
    pub(crate) key_changed: BTreeSet<Login>,
    /// Peers for whom `KeyChanged` was emitted on this connection.
    pub(crate) told_key_changed: BTreeSet<Login>,
    /// Devices for which `UnverifiedDevice` was emitted on this connection.
    pub(crate) told_unverified: BTreeSet<DeviceRef>,
    /// Active SAS verification handshakes by `transaction_id`.
    pub(crate) sas_sessions: BTreeMap<String, SasSession>,
    /// SAS handshakes waiting for `keys/query` of `(transaction_id, peer, devices)`.
    pub(crate) pending_sas: Vec<(String, Login, Vec<String>)>,
    /// Accounts whose safety code was asked for before their keys were known:
    /// answered from the next `keys/query` that names them.
    pub(crate) safety_wanted: BTreeSet<Login>,
    /// Handshakes this device started and no device has accepted yet: one
    /// initiator session per device asked, all under the same id. The first
    /// `Accept` moves its session to `sas_sessions`; the rest are cancelled.
    pub(crate) sas_offers: BTreeMap<String, Vec<SasSession>>,
    /// Olm messages waiting for a `keys/claim` session with their target device.
    pub(crate) outbox_olm: VecDeque<(DeviceKeys, ToDevice)>,
    /// Sessions `(sender, device, session_id)` already requested from our own devices.
    pub(crate) requested_keys: BTreeSet<SessionRef>,
    /// This device received the account's cross-signing secret and must re-upload `deviceKeys`.
    pub(crate) needs_reupload: bool,
    /// This account's unlocked backup key, when held on this device (spec E2EE §4.5).
    pub(crate) backup_key: Option<BackupKey>,
    /// The `POST /api/e2ee/backup` in flight.
    pub(crate) backup_post: Option<BackupPost>,
    /// Sessions `session_id → first_known_index` already uploaded to the current backup.
    pub(crate) backed_up: BTreeMap<String, u32>,
    /// Secret waiting for `POST /api/e2ee/backup` (`includeSessions: true`) to restore.
    pub(crate) pending_restore: Option<PendingRestore>,
    /// Latest backup metadata/sessions received from the server.
    pub(crate) remote_backup: Option<BackupAnswer>,
    /// A cross-signing reset not settled yet.
    pub(crate) reset: Option<PendingReset>,
    /// Whom this account vouches for on the server, and with which master
    /// key: the `peerTrust` statements of its own `keys/query` that its
    /// current self-signing key signed. A person verifies once, on any of
    /// their devices, and every device adopts it from here.
    pub(crate) attested: BTreeMap<Login, String>,
    /// The `POST /api/e2ee/trust` in flight.
    pub(crate) trust_post: Option<TrustPost>,
    /// The server refused this account's statements: not asked again on this
    /// connection.
    pub(crate) trust_refused: bool,
}

/// What the driver loaded for encryption.
pub(crate) struct Stored {
    /// The account pickle.
    pub(crate) account: Option<Secret>,
    /// Olm channels.
    pub(crate) channels: Vec<OlmChannelRow>,
    /// Sending sessions.
    pub(crate) outbound: Vec<OutboundRow>,
    /// Reading sessions.
    pub(crate) inbound: Vec<InboundRow>,
    /// Key messages not accepted yet.
    pub(crate) to_device: Vec<PendingToDevice>,
    /// Conversations that carried an encrypted message.
    pub(crate) encrypted: Vec<Login>,
    /// Rows waiting for a key.
    pub(crate) sealed: Vec<SealedRow>,
    /// Known master keys of peer accounts.
    pub(crate) peer_identities: Vec<PeerIdentity>,
    /// The account's backup key pickle, when held on this device.
    pub(crate) backup_key: Option<Secret>,
}

/// Why encryption stopped on this device, and whether the UI heard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Broken {
    /// For the log.
    pub(crate) reason: String,
    /// `EncryptionFailed` was emitted.
    pub(crate) told: bool,
}

impl E2ee {
    /// What `keys/query` last said device `id` of `login` is called, or "".
    pub(crate) fn device_name(&self, login: &Login, id: &str) -> String {
        self.directory
            .get(login)
            .and_then(|devices| devices.names.get(id))
            .cloned()
            .unwrap_or_default()
    }

    /// From what the driver loaded. An account that does not unpickle, or
    /// belongs to another login, leaves encryption broken, not the core.
    pub(crate) fn restore(me: &Login, stored: Stored) -> Self {
        let mut state = Self::default();
        if let Some(pickle) = stored.account {
            match Account::from_pickle(pickle.expose()) {
                Ok(account) if account.login() == me.as_str() => state.account = Some(account),
                Ok(_) => state.break_with("the stored keys belong to another account"),
                Err(error) => state.break_with(&format!("the stored keys are unreadable: {error}")),
            }
        }
        for row in stored.channels {
            match OlmChannel::from_pickle(row.pickle.expose()) {
                Ok(channel) => {
                    state.channels.insert((row.login, row.device), channel);
                }
                Err(error) => state.break_with(&format!("a stored channel is unreadable: {error}")),
            }
        }
        for row in stored.outbound {
            match OutboundGroup::from_pickle(row.pickle.expose()) {
                Ok(group) => {
                    state.outbound.insert(row.peer, group);
                }
                Err(error) => state.break_with(&format!("a stored session is unreadable: {error}")),
            }
        }
        for row in stored.inbound {
            match InboundGroup::from_pickle(row.pickle.expose()) {
                Ok(group) => {
                    state
                        .inbound
                        .insert((row.sender, row.device, row.session), group);
                }
                Err(error) => state.break_with(&format!("a stored session is unreadable: {error}")),
            }
        }
        state.keys_out = stored
            .to_device
            .into_iter()
            .map(|item| KeyOut { item, sent: false })
            .collect();
        state.encrypted = stored.encrypted.into_iter().collect();
        state.sealed = stored.sealed;
        state.peer_identities = stored
            .peer_identities
            .into_iter()
            .map(|p| (p.peer.clone(), p))
            .collect();
        if let Some(pickle) = stored.backup_key {
            match BackupKey::from_pickle(pickle.expose()) {
                Ok(key) if key.login() == me.as_str() => state.backup_key = Some(key),
                Ok(_) => state.break_with("the stored backup key belongs to another account"),
                Err(error) => {
                    state.break_with(&format!("the stored backup key is unreadable: {error}"));
                }
            }
        }
        state
    }

    /// Whether the queue may write this row now (see `Outbox::poll`). Off:
    /// always, as before stage 6. On but not usable on this connection:
    /// open text, except in a conversation that was encrypted before (§7).
    /// Usable: only once the row's seal is decided.
    pub(crate) fn sendable(&self, row: &PendingOutgoing) -> bool {
        if !self.enabled {
            return true;
        }
        match row.seal {
            Seal::Plain | Seal::Encrypted(_) => true,
            Seal::Undecided if self.active() => false,
            Seal::Undecided => !self.encrypted.contains(&row.message.peer),
        }
    }

    /// A new key message id: unique among those in flight.
    pub(crate) fn next_key_id(&mut self, now: Ts) -> String {
        self.key_serial = self.key_serial.wrapping_add(1);
        format!("td-{}-{}", now.0, self.key_serial)
    }

    /// Stops encryption on this device, keeping the first reason.
    pub(crate) fn break_with(&mut self, reason: &str) {
        self.upload = None;
        self.retry_at = None;
        if self.broken.is_none() {
            self.broken = Some(Broken {
                reason: reason.to_owned(),
                told: false,
            });
        }
    }

    /// Whether the core should talk to the server about keys now.
    pub(crate) fn active(&self) -> bool {
        self.enabled && self.available && self.broken.is_none() && !self.refused
    }

    /// A new authenticated socket: whatever was in flight is abandoned, and
    /// what the server said about devices is asked again.
    pub(crate) fn connected(&mut self, available: bool) {
        self.available = available;
        self.upload = None;
        self.registered = false;
        self.retry_at = None;
        self.failures = 0;
        self.refused = false;
        self.directory.clear();
        self.query = None;
        self.wanted.clear();
        self.claim = None;
        self.unreachable.clear();
        self.inbox.clear();
        self.acked = None;
        self.last_key_write = None;
        self.key_changed.clear();
        self.told_key_changed.clear();
        self.told_unverified.clear();
        self.sas_sessions.clear();
        self.pending_sas.clear();
        self.safety_wanted.clear();
        self.sas_offers.clear();
        self.outbox_olm.clear();
        self.requested_keys.clear();
        self.needs_reupload = false;
        self.backup_post = None;
        self.attested.clear();
        self.trust_post = None;
        self.trust_refused = false;
        // Its answer will never come on this socket; whether the server took
        // it is read from the account's keys instead (`settle_reset`).
        if let Some(reset) = self.reset.as_mut() {
            reset.in_doubt = true;
        }
        for key in &mut self.keys_out {
            key.sent = false;
        }
    }

    /// The next request number.
    pub(crate) fn next_serial(&mut self) -> u64 {
        self.serial = self.serial.wrapping_add(1);
        self.serial
    }

    /// A request failed: back off, doubling up to five minutes.
    pub(crate) fn failed(&mut self, now: Ts) {
        let shift = self.failures.min(6);
        let pause = (RETRY_FIRST_MS << shift).min(RETRY_MAX_MS);
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(Ts(now.0.saturating_add(pause)));
    }

    /// A request succeeded: the next failure starts the pause afresh.
    pub(crate) fn succeeded(&mut self) {
        self.failures = 0;
        self.retry_at = None;
    }

    /// When the core must look again: a paused key request, or a key
    /// message waiting for the shared pace (`gate`).
    pub(crate) fn wakeup(&self, gate: Option<Ts>) -> Option<Ts> {
        if !self.active() {
            return None;
        }
        let keys = (self.registered && self.keys_out.iter().any(|k| !k.sent))
            .then(|| gate.unwrap_or(Ts(i64::MIN)));
        let paused = (self.upload.is_none()
            && self.query.is_none()
            && self.claim.is_none()
            && self.backup_post.is_none()
            && self.trust_post.is_none())
        .then_some(self.retry_at)
        .flatten();
        [keys, paused].into_iter().flatten().min()
    }
}
