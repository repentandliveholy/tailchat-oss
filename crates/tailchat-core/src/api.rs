//! The core's contract: everything that goes in (`Input`) and comes out
//! (`Output`). The core itself never touches the network, the disk or a clock.

use crate::frames::inner::{Button, Forwarded, Image, Reply, Voice};
use crate::ids::{MessageId, Seq, Ts};
use crate::login::Login;
use crate::platform::{BackupPassphraseKey, Secret};
use crate::receipt::Receipt;

/// A message we wrote, as the core, the disk and the UI see it.
///
/// `Debug` prints the text and the picture: never log it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    /// Unique within the conversation with `peer`.
    pub id: MessageId,
    /// Who it is for.
    pub peer: Login,
    /// When it was written; replaced by the server's time once accepted.
    pub ts: Ts,
    /// The message text; the caption, for a picture.
    pub text: String,
    /// An inline picture, sent with the text (spec E2EE §4.3).
    pub image: Option<Image>,
    /// The quote, the forward label, the voice note and the edit target;
    /// boxed, because most messages carry none of them.
    pub extra: Box<Extra>,
    /// Where it stands on the receipt ladder.
    pub receipt: Receipt,
}

/// What an outgoing message may carry besides its text and picture. In an
/// encrypted conversation all of it travels inside the ciphertext.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Extra {
    /// The quoted message: a snapshot, not a live reference.
    pub reply_to: Option<Reply>,
    /// Who said it before it was forwarded.
    pub forwarded_from: Option<Forwarded>,
    /// A voice note.
    pub voice: Option<OutVoice>,
    /// The message of ours whose text this one replaces. Only ever sent
    /// encrypted: an old client shows it as an ordinary message with the new
    /// text, a new one applies it to the target and hides it.
    pub edit_of: Option<MessageId>,
}

impl Extra {
    /// Nothing besides the text.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// A voice note of ours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutVoice {
    /// `data:audio/…;base64,…`.
    pub data_url: String,
    /// Its length in milliseconds.
    pub duration_ms: u32,
    /// Loudness bars, 0–255 each, at most [`crate::frames::inner::WAVEFORM_MAX`].
    pub waveform: Vec<u8>,
}

/// Everything that can happen to the core. The driver hands these in one at
/// a time through [`crate::Core::handle`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// The driver opened a socket; nothing is authenticated yet.
    Connected,
    /// The socket is gone.
    Disconnected,
    /// The driver's timer reached [`crate::Core::next_wakeup`].
    Tick,
    /// One text frame from the server, exactly as received.
    Frame(String),
    /// The user did something.
    Action(Action),
    /// Delivery/read positions loaded by the driver from conversation history.
    PeerReceipts(PeerReceipts),
    /// The socket refused this message or receipt write. Stop processing that
    /// output batch, report this input and reconnect; the write is refunded.
    SendFailed {
        /// The conversation.
        peer: Login,
        /// The write the socket did not accept.
        id: MessageId,
    },
    /// The body of a `200` answer to an [`Output::Fetch`], exactly as received.
    History {
        /// The request it answers, as the core issued it.
        request: HistoryRequest,
        /// The response body (JSON text).
        body: String,
    },
    /// An [`Output::Fetch`] that produced no usable body.
    HistoryFailed {
        /// The request it answers, as the core issued it.
        request: HistoryRequest,
        /// What went wrong.
        error: FetchError,
    },
    /// The body of a `200` answer to an [`Output::Post`], exactly as received.
    Posted {
        /// The request it answers, as the core issued it.
        request: ApiRequest,
        /// The response body (JSON text).
        body: String,
    },
    /// An [`Output::Post`] that produced no usable body.
    PostFailed {
        /// The request it answers, as the core issued it.
        request: ApiRequest,
        /// What went wrong.
        error: FetchError,
    },
}

/// A refusal the server named in the body of a non-200 answer (`{"error":
/// "<code>"}`) that the core acts on differently from the bare status. Only
/// the codes the core needs are here; any other body is `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// `device_keys_changed` (409 on `keys/upload`): other keys are already
    /// published under this session's device id, so this store is not the one
    /// that registered it — lost, wiped or copied. Asking again cannot help;
    /// only a new sign-in gives a new device id.
    DeviceKeysChanged,
}

impl Refusal {
    /// The refusal a server error code names, if the core acts on it.
    #[must_use]
    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "device_keys_changed" => Some(Self::DeviceKeysChanged),
            _ => None,
        }
    }
}

/// Why a history request produced no page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// No HTTP answer at all: DNS, TCP, TLS, timeout.
    Network,
    /// The server answered with this non-200 status, and maybe named why.
    Status(u16, Option<Refusal>),
    /// The body was longer than [`crate::MAX_INBOUND`]; the driver stopped
    /// reading it. The core asks again for a smaller page.
    TooLarge,
}

/// One `GET /api/history` the driver must make with the account's bearer
/// token, answering with [`Input::History`] or [`Input::HistoryFailed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRequest {
    /// Which request this is. An answer to any other request is ignored.
    pub serial: u64,
    /// The conversation.
    pub peer: Login,
    /// Only messages strictly older than this one; `None` is the newest page.
    pub below: Option<Below>,
    /// How many messages to ask for.
    pub limit: u16,
    /// Ask for the envelopes of encrypted messages (`e2ee=1`) rather than
    /// the server's stub text: this device decrypts.
    pub sealed: bool,
}

/// A position in a conversation's history: the server pages by time and id
/// together, so equal timestamps cannot stall a walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Below {
    /// The oldest message already read.
    pub id: MessageId,
    /// Its time.
    pub ts: Ts,
}

/// Which end-to-end encryption endpoint a [`ApiRequest`] calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiCall {
    /// `POST /api/e2ee/keys/upload`: this device's keys.
    KeysUpload,
    /// `POST /api/e2ee/keys/query`: the devices of some accounts.
    KeysQuery,
    /// `POST /api/e2ee/keys/claim`: one-time keys to start Olm sessions.
    KeysClaim,
    /// `POST /api/e2ee/backup`: encrypted session key backup and self-signing secret.
    Backup,
    /// `POST /api/e2ee/trust`: this account's signed word on whom its people
    /// verified, so every device of the account knows it.
    Trust,
}

impl ApiCall {
    /// Path relative to the cloud's base URL.
    pub fn path(self) -> &'static str {
        match self {
            Self::KeysUpload => "/api/e2ee/keys/upload",
            Self::KeysQuery => "/api/e2ee/keys/query",
            Self::KeysClaim => "/api/e2ee/keys/claim",
            Self::Backup => "/api/e2ee/backup",
            Self::Trust => "/api/e2ee/trust",
        }
    }
}

/// One JSON `POST` the driver must make with the account's bearer token,
/// answering with [`Input::Posted`] or [`Input::PostFailed`]. The body holds
/// public keys and encrypted blobs — and, for [`Action::ResetCrossSigning`]
/// only, the account password the server asks for. So `Debug` never prints
/// the body, only its length.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiRequest {
    /// Which request this is. An answer to any other request is ignored.
    pub serial: u64,
    /// The endpoint.
    pub call: ApiCall,
    /// The JSON body.
    pub body: String,
}

impl std::fmt::Debug for ApiRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiRequest")
            .field("serial", &self.serial)
            .field("call", &self.call)
            .field("body", &format_args!("[{} bytes]", self.body.len()))
            .finish()
    }
}

/// What the user can ask the core to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Send a text message.
    SendText {
        /// Made by the driver with `MessageId::from_random`, so the UI knows
        /// the id before the core answers.
        id: MessageId,
        /// Who it is for.
        peer: Login,
        /// The text; must not be blank.
        text: String,
    },
    /// Send a picture, with an optional caption. The same queue, seal and
    /// receipt ladder as [`Action::SendText`]: in an encrypted conversation
    /// the bytes travel inside the Megolm ciphertext (spec E2EE §4.3).
    SendImage {
        /// Made by the driver with `MessageId::from_random`, so the UI knows
        /// the id before the core answers.
        id: MessageId,
        /// Who it is for.
        peer: Login,
        /// The caption; may be blank.
        text: String,
        /// The picture: a `data:image/{jpeg,png,gif,webp};base64,` URL.
        image: Image,
    },
    /// Send a message with any of: a picture, a quote, a forward label, a
    /// voice note. Same queue, seal and ladder as [`Action::SendText`]; in an
    /// encrypted conversation the quote, the label and the voice bytes travel
    /// inside the ciphertext, never beside it. `extra.edit_of` is refused
    /// here: an edit is [`Action::EditText`].
    SendWith {
        /// Made by the driver with `MessageId::from_random`.
        id: MessageId,
        /// Who it is for.
        peer: Login,
        /// The text; may be blank only when a picture or voice note goes too.
        text: String,
        /// A picture, as for [`Action::SendImage`].
        image: Option<Image>,
        /// Everything else.
        extra: Box<Extra>,
    },
    /// New text for a message of ours. In a conversation that is encrypted
    /// the edit goes as an encrypted message of its own under `id`, naming
    /// `target`, and the target's text changes here at once; otherwise it is
    /// the server's open `edit` frame and `id` is not used.
    EditText {
        /// A fresh id for the encrypted carrier.
        id: MessageId,
        /// The conversation.
        peer: Login,
        /// The message whose text changes.
        target: MessageId,
        /// The new text; must not be blank.
        text: String,
    },
    /// The user pressed "retry" on a message marked ⚠.
    Retry {
        /// The conversation.
        peer: Login,
        /// The failed message; it goes again under the same id.
        id: MessageId,
    },
    /// The person confirmed that a message held back (`Event::PlaintextHeld`)
    /// may go as open text in a conversation that was encrypted before.
    SendUnencrypted {
        /// The conversation.
        peer: Login,
        /// The held message.
        id: MessageId,
    },
    /// The person withdrew a message held back (`Event::PlaintextHeld`): it
    /// leaves the queue and is never sent, open or encrypted. Refused with
    /// `CoreError::NotRetryable` for a row that is not held, because a row
    /// already on its way may have reached the server.
    CancelHeld {
        /// The conversation.
        peer: Login,
        /// The held message.
        id: MessageId,
    },
    /// One page of `peer`'s conversation from the server, older than `below`
    /// (`None`: the newest page). The feed only carries what happened since
    /// the server's log began, so a new device holds the last events of the
    /// account and reads the rest on demand, as a person scrolls back.
    /// Answered by [`Event::OlderPage`].
    LoadOlder {
        /// The conversation.
        peer: Login,
        /// The oldest message the reader has; the page ends just above it.
        below: Option<Below>,
    },
    /// Accept a peer's new master key after `Event::KeyChanged`, rotating the
    /// outbound session and resuming sending to `peer` (spec E2EE §4.2).
    AcceptPeerKey {
        /// The peer account.
        peer: Login,
    },
    /// Start a SAS verification handshake with `(peer, device)` (spec E2EE §4.2).
    StartSas {
        /// The account (a friend, or this account for another own device).
        peer: Login,
        /// The target device id.
        device: String,
    },
    /// Start one SAS verification with whichever of `devices` (all `peer`'s)
    /// answers first. Every device gets the same `Start`; the first `Accept`
    /// takes the handshake and the others are told `accepted_elsewhere`, so a
    /// person is reached on the device they have open instead of the newest
    /// one by age (the first live test, 2026-11-11, asked a switched-off one).
    /// One `Event::SasStarted` is emitted, naming the first device.
    StartSasAny {
        /// The account (a friend, or this account for its other devices).
        peer: Login,
        /// The candidate device ids, most preferred first.
        devices: Vec<String>,
    },
    /// Confirm that the SAS emojis/decimals match on screen.
    ConfirmSas {
        /// The SAS handshake id.
        transaction_id: String,
    },
    /// Cancel an in-flight SAS verification handshake.
    CancelSas {
        /// The SAS handshake id.
        transaction_id: String,
    },
    /// Verify a peer or another own device from a scanned QR code string.
    VerifyWithQr {
        /// Compact QR verification string (`tailchat-verify:v1:...`).
        qr: String,
    },
    /// Ask for the safety code with `peer` — both accounts' master keys as
    /// emojis that stay the same until either resets its keys, to compare
    /// whenever the two people talk. Answered by `Event::SafetyCode`, once
    /// `peer`'s keys are known (they are fetched first when they are not).
    SafetyCode {
        /// The other account (not this one).
        peer: Login,
    },
    /// The person compared the safety code with `peer` and it matched: trust
    /// `master_key`, the key that code was made from. Nothing happens when it
    /// is no longer `peer`'s published key — a code shown before a key change
    /// says nothing about the new key. Answered by `Event::SafetyCode`.
    ConfirmSafetyCode {
        /// The other account.
        peer: Login,
        /// `master_key` of the `Event::SafetyCode` the person compared.
        master_key: String,
    },
    /// Create or rotate the account's encrypted key backup, generating a fresh
    /// 256-bit recovery key (emitted once in [`Event::BackupCreated`]) and
    /// optionally wrapping it with a passphrase key derived in the driver (spec E2EE §4.5).
    CreateBackup {
        /// Optional Argon2id wrapping key derived in the driver.
        passphrase_key: Option<BackupPassphraseKey>,
    },
    /// Fetch the account's backup metadata from the server (`Event::BackupInfo`).
    FetchBackup,
    /// Unlock the account's key backup from its 256-bit recovery key (no KDF),
    /// sign this device with the recovered self-signing key and decrypt stored
    /// history (spec E2EE §4.2, §4.5).
    RestoreBackupWithRecoveryKey {
        /// Compact recovery key (`tailchat-backup:v1:...`).
        recovery_key: Secret,
    },
    /// Unlock the account's key backup using an Argon2id key derived in the
    /// driver from the user's passphrase and the server's backup salt (spec E2EE §4.5).
    RestoreBackupWithPassphrase {
        /// The Argon2id wrapping key derived in the driver.
        passphrase_key: BackupPassphraseKey,
    },
    /// Replace the account's cross-signing keys with new ones made here, and
    /// sign this device with them (spec E2EE §8.7, "сброс ключей"): the way out
    /// for a person who lost every device and has no backup. The server takes
    /// it only with the account password. Answered by
    /// [`Event::CrossSigningReset`] or [`Event::CrossSigningResetFailed`].
    /// Every contact then sees the account's keys change, and the account's
    /// other devices and its key backup stop matching until verified / made
    /// again.
    ResetCrossSigning {
        /// The account's password; sent once, never stored.
        password: Secret,
    },
}

/// What the driver must do, strictly in the order the core returned them.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// Write this JSON text to the socket.
    Send(String),
    /// Apply with `Storage::apply` before carrying out any later output, so a
    /// message is on disk before it is on the wire. If it fails: drop the rest
    /// of this batch and rebuild the core from `Storage::load`.
    Persist(Vec<StoreOp>),
    /// Tell the UI.
    Event(Event),
    /// Make this HTTP request; it does not need the socket. Every fetch must be
    /// answered exactly once, even after a disconnect.
    Fetch(HistoryRequest),
    /// Make this HTTP request, under the same rule as [`Output::Fetch`].
    Post(ApiRequest),
}

/// News for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A message we just wrote; show it with its receipt (⧗).
    MessageAdded(Outgoing),
    /// The answer to [`Action::LoadOlder`]: its rows are stored (each with
    /// its own `MessageStored`) before this.
    OlderPage {
        /// The conversation.
        peer: Login,
        /// The oldest row of the page, deleted ones included: where the next
        /// page starts even when this one left nothing to show.
        oldest: Option<Below>,
        /// The page reached the conversation's first message, or the server
        /// will not show this conversation at all.
        complete: bool,
    },
    /// A message of ours moved on the receipt ladder.
    ReceiptChanged {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
        /// The server's time for it; the row moves to this time.
        ts: Ts,
        /// The new rung.
        receipt: Receipt,
    },
    /// The server refused something (`{"k":"error"}`).
    ServerError {
        /// The server's code, e.g. `store_failed`, `not_subscribed`.
        code: String,
        /// The conversation, when the server names it.
        peer: Option<Login>,
        /// The message, when the server names it.
        id: Option<MessageId>,
    },
    /// A frame the core could not read. It is dropped; the connection goes on.
    BadFrame {
        /// What was wrong with it, for the log.
        reason: String,
    },
    /// A conversation row was written or changed (new message, edit,
    /// reaction). Read it back from storage: events never copy message bodies.
    MessageStored {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
    },
    /// These messages are gone from this device: deleted for everyone, or
    /// hidden by this account on another device.
    MessagesRemoved {
        /// The conversation.
        peer: Login,
        /// The messages that were held here.
        ids: Vec<MessageId>,
    },
    /// This account read the conversation up to `read_ts` (on any device).
    OwnReadMoved {
        /// The conversation.
        peer: Login,
        /// The new position.
        read_ts: Ts,
    },
    /// This device's encryption keys are on the server under `device_id`.
    DeviceRegistered {
        /// The id the server gave this device.
        device_id: String,
    },
    /// End-to-end encryption cannot work on this device until the client is
    /// set up again (the server refused its keys, or its stored keys are
    /// unreadable). Messages keep going as before.
    EncryptionFailed {
        /// What went wrong, for the log.
        reason: String,
    },
    /// A message waits (⧗): it can only go as open text, in a conversation
    /// that was encrypted before (spec E2EE §7). It goes after
    /// `Action::SendUnencrypted`, or encrypted once every device can read it;
    /// `Action::CancelHeld` withdraws it.
    PlaintextHeld {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
    },
    /// Whether this device's messages to `peer` now go encrypted.
    EncryptionState {
        /// The conversation.
        peer: Login,
        /// Encrypted, or open with the "not encrypted" mark.
        encrypted: bool,
    },
    /// The peer account's master key changed (or disappeared after being
    /// known); outgoing messages to `peer` wait until `Action::AcceptPeerKey`
    /// or verification (spec E2EE §4.2).
    KeyChanged {
        /// The conversation.
        peer: Login,
    },
    /// A device of `peer` (or of this account) is not signed by that
    /// account's master key: it receives no conversation keys (spec E2EE §4.2).
    UnverifiedDevice {
        /// The account that owns the device.
        peer: Login,
        /// The unsigned device id.
        device: String,
        /// What it calls itself ("" when unnamed).
        name: String,
    },
    /// A SAS verification handshake started with `(peer, device)`.
    SasStarted {
        /// The handshake id.
        transaction_id: String,
        /// The account.
        peer: Login,
        /// The device id.
        device: String,
    },
    /// The SAS short authentication string is ready for the person to compare.
    SasCodeReady {
        /// The handshake id.
        transaction_id: String,
        /// The account.
        peer: Login,
        /// The device id.
        device: String,
        /// Seven 6-bit emoji indices (0..64).
        emoji_indices: [u8; 7],
        /// Three 13-bit decimal numbers (1000..=9191).
        decimals: [u16; 3],
    },
    /// The server already holds other keys under this session's device id
    /// (`device_keys_changed`): this local store is not the one that
    /// registered it — lost, wiped or copied from elsewhere. Encryption stays
    /// off on this device; only signing out and in again gives it a new
    /// device id. Said instead of `EncryptionFailed`, never with it.
    DeviceKeysConflict,
    /// A SAS handshake with `(peer, device)` ended without verifying anything:
    /// the other device cancelled it, or a step did not check out here and this
    /// side gave up (and told the other device so). A cancel this device asked
    /// for itself (`Action::CancelSas`) is not reported back.
    SasCancelled {
        /// The handshake id.
        transaction_id: String,
        /// The account.
        peer: Login,
        /// The device id.
        device: String,
        /// What that device calls itself ("" when unnamed).
        name: String,
        /// `user_cancelled` (or another code) from the other device, or why
        /// this side gave up: `commitment_mismatch`, `key_mismatch`,
        /// `mac_mismatch`, `unknown_identity`.
        reason: String,
    },
    /// SAS or QR verification of `(peer, device)` succeeded.
    DeviceVerified {
        /// The account.
        peer: Login,
        /// The device id.
        device: String,
        /// What that device calls itself ("" when unnamed).
        name: String,
    },
    /// A new encrypted key backup was created; display `recovery_key` once to
    /// the user (spec E2EE §1.2, §4.5).
    BackupCreated {
        /// Backup version number (`>= 1`).
        version: u64,
        /// The 256-bit recovery key (`tailchat-backup:v1:...`), wiped on drop.
        recovery_key: Secret,
    },
    /// Backup metadata reported by the server (`Action::FetchBackup`).
    BackupInfo {
        /// Backup version (`0` when no backup exists yet).
        version: u64,
        /// Argon2id salt when the backup also has a passphrase slot.
        passphrase_salt: Option<String>,
        /// Number of Megolm sessions stored in the backup.
        session_count: usize,
    },
    /// The account's key backup was unlocked and applied on this device.
    BackupRestored {
        /// Backup version number.
        version: u64,
        /// Number of Megolm inbound sessions imported or merged from the backup.
        sessions: usize,
    },
    /// The server published this device's new cross-signing keys
    /// ([`Action::ResetCrossSigning`]); this device is signed by them.
    CrossSigningReset,
    /// A reset did not happen. `reason`: `bad_password`, `too_many_attempts`,
    /// `not_ready` (no registered device on this connection), `busy` (another
    /// key upload in flight), `refused` (the server would not take the keys),
    /// `signed_out`, or `connection_lost` (no answer, and the server does not
    /// publish the new keys). The old keys stay in force.
    CrossSigningResetFailed {
        /// Why, as above.
        reason: String,
    },
    /// The safety code with `peer` (`Action::SafetyCode`,
    /// `Action::ConfirmSafetyCode`). `status`: `ready` (`halves` and
    /// `master_key` are set), `no_keys` (`peer` has published no encryption
    /// keys, so there is nothing to compare), `unavailable` (encryption is not
    /// running on this device yet).
    SafetyCode {
        /// The other account.
        peer: Login,
        /// As above.
        status: String,
        /// Both accounts' emojis, the alphabetically first login first — the
        /// order the other person sees too. Empty unless `ready`.
        halves: Vec<SafetyHalf>,
        /// `peer`'s master key the code was made from ("" unless `ready`).
        master_key: String,
        /// The same two keys as 30 digits in six groups of five
        /// (`tailchat_crypto::safety_number`); "" unless `ready`.
        number: String,
        /// `true` once this exact key was verified (safety code, SAS or QR).
        verified: bool,
    },
}

/// One account's part of a safety code (`Event::SafetyCode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyHalf {
    /// The account.
    pub login: Login,
    /// Ten indices into the SAS emoji table (0..64).
    pub emoji_indices: Vec<u8>,
}

/// Whether a message came from a person or the assistant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MessageKind {
    /// A person (or a bot speaking for itself).
    #[default]
    Human,
    /// The assistant (`t: "ai"`).
    Ai,
}

/// One emoji and everybody who put it on a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaction {
    /// The emoji.
    pub emoji: String,
    /// Who reacted with it.
    pub by: Vec<Login>,
}

/// One message of a conversation as this device holds it, whoever wrote it:
/// read from history, filled in for a feed event, or received live. Messages
/// this device wrote stay [`Outgoing`] rows.
///
/// `Debug` prints the text and media: never log it.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    /// The conversation.
    pub peer: Login,
    /// Unique within the conversation.
    pub id: MessageId,
    /// Who wrote it: `peer`, or this account on another device.
    pub from: Login,
    /// The server's time for it.
    pub ts: Ts,
    /// Person or assistant.
    pub kind: MessageKind,
    /// The text; empty for a pure attachment.
    pub text: String,
    /// The display name the author claimed.
    pub author: Option<String>,
    /// An inline picture.
    pub image: Option<Image>,
    /// An inline voice note.
    pub voice: Option<Voice>,
    /// The quoted message.
    pub reply_to: Option<Reply>,
    /// Who said it before it was forwarded.
    pub forwarded_from: Option<Forwarded>,
    /// Buttons a bot offers.
    pub buttons: Vec<Button>,
    /// The message whose text this encrypted one replaced (see
    /// [`Extra::edit_of`]); a client shows the target, not this row.
    pub edit_of: Option<MessageId>,
    /// The server evicted this message's attachment for good.
    pub media_dropped: bool,
    /// When the text was last edited.
    pub edited_at: Option<Ts>,
    /// The reactions on it.
    pub reactions: Vec<Reaction>,
    /// How it travelled: open, decrypted here, or still sealed.
    pub protection: Protection,
}

/// How a conversation row travelled (spec E2EE §4.3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Protection {
    /// Open text, as every message was before end-to-end encryption.
    #[default]
    Plain,
    /// Encrypted on the wire and decrypted on this device.
    Encrypted,
    /// Encrypted and not readable here. The envelope is kept: never shown
    /// empty, never dropped, opened again when its key arrives.
    Sealed {
        /// The envelope as it came.
        envelope: Envelope,
        /// A key may still arrive; `false` once the envelope was refused for
        /// good (forged, replayed, not from its sender).
        waiting: bool,
    },
}

/// The `e2ee` of a message frame, `{v: 1, dev, sid, ct}`, as sent or stored.
/// Nothing in it is secret: it is what the server sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// The sending device.
    pub dev: String,
    /// The Megolm session id.
    pub sid: String,
    /// The ciphertext, unpadded base64.
    pub ct: String,
}

/// What the queue decided about one outgoing message. Decided once, at its
/// first write, and kept: every retry sends the same bytes (spec E2EE §4.3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Seal {
    /// Not written yet.
    #[default]
    Undecided,
    /// Goes as open text.
    Plain,
    /// Goes as this envelope.
    Encrypted(Envelope),
}

/// One Olm channel with one device of `login`, pickled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OlmChannelRow {
    /// The account of the device.
    pub login: Login,
    /// The device id.
    pub device: String,
    /// The channel with its session secrets.
    pub pickle: Secret,
}

/// This device's sending session for the conversation with `peer`, pickled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundRow {
    /// The conversation.
    pub peer: Login,
    /// The session with its ratchet.
    pub pickle: Secret,
}

/// A session to read one device's messages with, pickled. Keyed by
/// `(sender, device, session)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundRow {
    /// The account that sends with it.
    pub sender: Login,
    /// The sending device.
    pub device: String,
    /// The Megolm session id.
    pub session: String,
    /// The session, its binding and the indexes seen.
    pub pickle: Secret,
}

/// A key message the server has not accepted yet. Its Olm ratchet already
/// moved: it is sent as is until `to-device-accepted`, never encrypted again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingToDevice {
    /// Our id for it, answered in `to-device-accepted`.
    pub id: String,
    /// The account of the receiving device.
    pub to: Login,
    /// The receiving device.
    pub device: String,
    /// The `body`: an Olm message, not secret.
    pub body: String,
}

/// A stored row whose envelope waits for its key: what the core needs to open
/// it when the key comes, without reading the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedRow {
    /// The conversation.
    pub peer: Login,
    /// The message.
    pub id: MessageId,
    /// Its author.
    pub from: Login,
    /// The server's time for it.
    pub ts: Ts,
    /// Person or assistant.
    pub kind: MessageKind,
    /// The envelope.
    pub envelope: Envelope,
}

/// What this device knows about a peer account's master key (spec E2EE §4.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerIdentity {
    /// The peer account.
    pub peer: Login,
    /// The peer's master Ed25519 public key (unpadded base64).
    pub master_key: String,
    /// `true` once verified by QR or SAS; `false` when trusted on first contact (TOFU).
    pub verified: bool,
}

/// What this device holds, as the core needs it after a restart: the key and
/// the edit time that decides whether a later edit is newer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// The conversation.
    pub peer: Login,
    /// The message.
    pub id: MessageId,
    /// When its text was last edited.
    pub edited_at: Option<Ts>,
}

/// Where a history walk resumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalkFrom {
    /// From the newest message.
    Newest,
    /// Below a message already read.
    Below(Below),
}

/// What one conversation still owes this device from `/api/history`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backfill {
    /// The conversation.
    pub peer: Login,
    /// Messages the feed named whose content this device does not hold yet.
    pub owed: Vec<MessageId>,
    /// A whole-conversation re-read after the feed said `reset`, and where it
    /// has got to.
    pub reseed: Option<WalkFrom>,
}

/// How far this account has read one conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnRead {
    /// The conversation.
    pub peer: Login,
    /// The newest timestamp read.
    pub read_ts: Ts,
}

/// A delivery receipt this device owes: the newest stored message from `peer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwedAck {
    /// The conversation.
    pub peer: Login,
    /// The message.
    pub id: MessageId,
    /// Its time; only a newer message replaces it.
    pub ts: Ts,
}

/// A durable queue row. Attempts count socket writes, never time spent offline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingOutgoing {
    /// The original id, text and timestamp are kept for idempotent retries.
    pub message: Outgoing,
    /// Writes made without server acceptance since the last manual retry.
    pub attempts: u8,
    /// Earliest time to retry, or to mark the eighth unanswered write failed.
    pub next_attempt_at: Ts,
    /// Open or encrypted, decided at the first write.
    pub seal: Seal,
}

/// Durable, monotonic receipt positions for one conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReceipts {
    /// The conversation.
    pub peer: Login,
    /// The newest timestamp stored on the peer's device.
    pub delivered_ts: Option<Ts>,
    /// The newest timestamp read by the peer; reading also implies delivery.
    pub read_ts: Option<Ts>,
}

/// One durable change. `Storage::apply` gets a batch and applies all of it or
/// none of it.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreOp {
    /// Insert or update by `(peer, id)`, and remove the same key from the
    /// pending queue atomically. Committed messages must remain available for
    /// later receipt upgrades. Never clears an edit time or reactions.
    PutOutgoing(Outgoing),
    /// Upsert a queue row by `(peer, id)`, including attempts and its deadline.
    PutPending(PendingOutgoing),
    /// Remove a queue row by `(peer, id)` without committing it anywhere: a
    /// withdrawn message. A missing row is not an error.
    DropPending {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
    },
    /// Update only retry metadata on an existing queue row, without rewriting
    /// its text. Missing rows are storage errors, never implicit inserts.
    SetAttempt {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
        /// Number of socket writes so far.
        attempts: u8,
        /// Next retry or final acceptance deadline.
        next_attempt_at: Ts,
    },
    /// Persist the merged delivery/read positions for one peer.
    PutPeerReceipts(PeerReceipts),
    /// Remember how far the sync-v1 feed has been read.
    SetCursor(Seq),
    /// Insert or replace a conversation row by `(peer, id)`, its reactions
    /// included. Boxed: a row is large and every other op is small.
    PutMessage(Box<Message>),
    /// New text for the row with this key, conversation or committed outgoing.
    /// Encrypted or sealed conversation rows ignore open-text edits; no row: nothing happens.
    EditMessage {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
        /// The new text.
        text: String,
        /// When it was edited.
        edited_at: Option<Ts>,
    },
    /// New text from an encrypted edit: applied only to a row `author` wrote
    /// (and, when `mine`, to this account's committed row), open or
    /// encrypted, never to a sealed one. No such row: nothing happens.
    SealedEdit {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
        /// Who sent the edit; it must be the message's author.
        author: Login,
        /// `author` is this account.
        mine: bool,
        /// The new text.
        text: String,
        /// When it was edited.
        edited_at: Ts,
    },
    /// Add or remove one person's emoji on the row with this key, conversation
    /// or committed outgoing. Idempotent; no row: nothing happens.
    SetReaction {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
        /// The emoji.
        emoji: String,
        /// Who.
        by: Login,
        /// Whether they have it now.
        add: bool,
    },
    /// Replace every reaction on the row with this key.
    PutReactions {
        /// The conversation.
        peer: Login,
        /// The message.
        id: MessageId,
        /// The full new set.
        reactions: Vec<Reaction>,
    },
    /// Delete these keys everywhere: conversation rows, committed outgoing
    /// rows and their reactions. Missing keys are ignored.
    RemoveMessages {
        /// The conversation.
        peer: Login,
        /// The messages.
        ids: Vec<MessageId>,
    },
    /// Upsert the history debt of one conversation.
    PutBackfill(Backfill),
    /// The conversation owes nothing any more.
    DropBackfill(Login),
    /// Upsert how far this account has read one conversation.
    PutOwnRead(OwnRead),
    /// Upsert the delivery receipt owed to one peer.
    PutAck(OwedAck),
    /// The receipt owed to this peer has been written to the socket.
    DropAck(Login),
    /// New content and protection for the row with this key, after its
    /// envelope was opened or refused for good. Keeps its reactions and
    /// edit time. No row: nothing happens.
    Unseal(Box<Message>),
    /// Replace this device's Olm account.
    PutCryptoAccount(Secret),
    /// Upsert one Olm channel by `(login, device)`.
    PutOlmChannel(OlmChannelRow),
    /// Upsert the sending session of one conversation by `peer`.
    PutOutboundGroup(OutboundRow),
    /// Upsert one reading session by `(sender, device, session)`.
    PutInboundGroup(InboundRow),
    /// Upsert a key message by its id; it moves to the end of the queue.
    PutToDevice(PendingToDevice),
    /// The server accepted (or refused for good) this key message.
    DropToDevice(String),
    /// This conversation carried an encrypted message. Never undone.
    MarkEncrypted(Login),
    /// Upsert a peer account's known master key and verification status by `peer`.
    PutPeerIdentity(PeerIdentity),
    /// Replace this account's encrypted key backup secret on this device.
    PutBackupKey(Secret),
}
