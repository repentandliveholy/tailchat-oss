//! Tailchat end-to-end encryption: a wrapper of vodozemac (Olm/Megolm) for
//! one-to-one conversations (`docs/specs/2026-11-04-e2ee.md`).
//!
//! Sans-IO like the core: no network, disk or clock — time arrives as
//! `now_ms`. The one exception (§6): vodozemac takes its randomness from the
//! OS itself, so key bytes and ciphertexts are not deterministic; tests check
//! what decrypts, not the bytes. No vodozemac type is part of this API.
//!
//! Every object that holds a secret has `pickle`/`from_pickle` and a `Debug`
//! that prints no secret. Whatever a server or peer sends that cannot be read
//! ends in [`Undecryptable`], never in a [`CryptoError`].

/// This device's Olm account.
mod account;
/// Encrypted key backup (AES-256-GCM, recovery key, Argon2id passphrase).
mod backup;
/// Canonical JSON and signatures over it.
pub mod canonical;
/// Cross-signing (master key, self-signing key, QR verification).
mod cross_signing;
/// `DeviceKeys`: a device's signed identity.
mod device;
/// `CryptoError`, `Undecryptable`.
mod error;
/// Conversation messages (Megolm).
mod megolm;
/// To-device messages (Olm).
mod olm;
/// The stored form of secret-holding objects.
mod pickle;
/// The safety code: two accounts' master keys as emojis that do not change.
mod safety;
/// Short authentication string (SAS) verification.
mod sas;

pub use account::Account;
pub use backup::{
    ARGON2_M_COST_KIB, ARGON2_P_COST, ARGON2_T_COST, BackupKey, DerivedPassphraseKey,
    EncryptedBackupEntry, EncryptedSessionBackup, PASSPHRASE_MIN_CHARS, PASSPHRASE_MIN_WORDS,
    PassphraseSlot, ReceivedBackupKey, RecoveryKey, SharedBackupKey, validate_passphrase,
};
pub use cross_signing::{
    AttestedPeer, CrossSigning, CrossSigningPublic, QrVerification, ReceivedCrossSigningKey,
    SharedCrossSigningKey,
};
pub use device::{DeviceKeys, DeviceKind};
pub use error::{CryptoError, Undecryptable};
pub use megolm::{
    Conversation, Decrypted, Envelope, ForwardedRoomKey, Frame, InboundGroup, MessageKind,
    OutboundGroup, ROTATE_AFTER_MESSAGES, ROTATE_AFTER_MS, ReceivedForwardedKey, ReceivedRoomKey,
    RoomKey, RoomKeyRequest, Rotation,
};
pub use olm::{OlmChannel, Received, ToDevice};
pub use safety::{
    SAFETY_EMOJIS_PER_ACCOUNT, SAFETY_NUMBER_GROUPS_PER_ACCOUNT, SafetyHalf, safety_code,
    safety_number,
};
pub use sas::{SAS_EMOJIS, SasCode, SasMessage, SasSession, SasVerified};
