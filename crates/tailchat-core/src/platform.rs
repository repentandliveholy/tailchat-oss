use std::fmt;

use zeroize::Zeroizing;

use crate::api::{
    Backfill, Held, InboundRow, OlmChannelRow, OutboundRow, Outgoing, OwedAck, OwnRead,
    PeerIdentity, PeerReceipts, PendingOutgoing, PendingToDevice, SealedRow, StoreOp,
};
use crate::error::CoreError;
use crate::ids::Seq;
use crate::login::Login;

/// Bearer token: 64 lowercase hex characters, as the server issues it.
/// `{:?}` never prints it; our own copy is wiped on drop.
pub struct Token(Zeroizing<String>);

impl Token {
    /// Checks a token exactly as the server issues it; anything else is refused.
    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
        if raw.len() == 64 && raw.bytes().all(hex) {
            Ok(Self(Zeroizing::new(raw.to_owned())))
        } else {
            Err(CoreError::InvalidToken)
        }
    }

    /// The token as text; only `frames::auth` needs it.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(***)")
    }
}

/// Secret key material at rest: a pickle of an Olm account or session.
/// `{:?}` prints `[redacted]`; our copy is wiped on drop.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Takes ownership of `value`; nothing else keeps a copy.
    pub fn new(value: Zeroizing<String>) -> Self {
        Self(value)
    }

    /// Wraps `value` in a wiped-on-drop buffer.
    pub fn from_string(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    /// The secret text, for the store to write and the core to unpickle.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// An Argon2id key (64 MiB, `t = 3`) derived from the user's backup passphrase
/// in the driver outside `Core::handle` (spec E2EE §4.5).
#[derive(Clone, PartialEq, Eq)]
pub struct BackupPassphraseKey {
    pub(crate) inner: tailchat_crypto::DerivedPassphraseKey,
}

impl fmt::Debug for BackupPassphraseKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BackupPassphraseKey")
            .field("salt", &self.inner.salt())
            .field("key", &"[redacted]")
            .finish()
    }
}

impl BackupPassphraseKey {
    /// Validate `passphrase` (>= 16 chars or >= 4 words), generate a fresh
    /// 128-bit salt and derive a 256-bit wrapping key with Argon2id.
    ///
    /// # Errors
    /// [`CoreError::WeakPassphrase`], [`CoreError::InvalidBackupSecret`].
    pub fn derive_new(passphrase: &str) -> Result<Self, CoreError> {
        tailchat_crypto::DerivedPassphraseKey::derive_new(passphrase)
            .map(|inner| Self { inner })
            .map_err(|e| match e {
                tailchat_crypto::CryptoError::WeakPassphrase => CoreError::WeakPassphrase,
                _ => CoreError::InvalidBackupSecret,
            })
    }

    /// Validate `passphrase` and derive the 256-bit wrapping key for an
    /// existing base64 `salt` from the server's backup metadata.
    ///
    /// # Errors
    /// [`CoreError::WeakPassphrase`], [`CoreError::InvalidBackupSecret`].
    pub fn derive_with_salt(passphrase: &str, salt: &str) -> Result<Self, CoreError> {
        tailchat_crypto::DerivedPassphraseKey::derive_with_salt(passphrase, salt)
            .map(|inner| Self { inner })
            .map_err(|e| match e {
                tailchat_crypto::CryptoError::WeakPassphrase => CoreError::WeakPassphrase,
                _ => CoreError::InvalidBackupSecret,
            })
    }

    /// The unpadded base64 Argon2id salt.
    pub fn salt(&self) -> &str {
        self.inner.salt()
    }
}

/// What the core needs back after a restart. Message bodies are not part of
/// it: the core only needs to know which keys this device holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// How far the sync-v1 feed had been read.
    pub cursor: Seq,
    /// Uncommitted and failed rows, including their durable attempt counts.
    pub pending: Vec<PendingOutgoing>,
    /// Committed outgoing rows, needed to apply later receipt positions.
    pub sent: Vec<Outgoing>,
    /// Last known delivery/read positions, restored with the message rows.
    pub receipts: Vec<PeerReceipts>,
    /// Every conversation row and committed outgoing row on disk, by key.
    pub held: Vec<Held>,
    /// History each conversation still owes.
    pub backfill: Vec<Backfill>,
    /// How far this account has read each conversation.
    pub own_reads: Vec<OwnRead>,
    /// Delivery receipts not yet written to a socket.
    pub acks: Vec<OwedAck>,
    /// This device's Olm account, once the server gave it a device id.
    pub crypto_account: Option<Secret>,
    /// Olm channels, one per peer device.
    pub olm_channels: Vec<OlmChannelRow>,
    /// This device's sending session, one per conversation.
    pub outbound_groups: Vec<OutboundRow>,
    /// Sessions to read other devices' messages with.
    pub inbound_groups: Vec<InboundRow>,
    /// Key messages the server has not accepted yet, oldest first.
    pub to_device: Vec<PendingToDevice>,
    /// Conversations that carried an encrypted message (spec E2EE §7).
    pub encrypted: Vec<Login>,
    /// Rows whose envelope waits for its session key, from the stored rows.
    pub sealed: Vec<SealedRow>,
    /// Known master keys of peer accounts (TOFU and verified, spec E2EE §4.2).
    pub peer_identities: Vec<PeerIdentity>,
    /// This account's key backup secret, once created, restored or shared over Olm (spec E2EE §4.5).
    pub backup_key: Option<Secret>,
}

/// Durable storage. The core never calls it; the driver does.
pub trait Storage {
    /// The storage's own error type (SQLite, IndexedDB, …).
    type Error: std::error::Error;

    /// All ops land, or none do.
    fn apply(&mut self, ops: &[StoreOp]) -> Result<(), Self::Error>;

    /// Reads back everything the core needs after a restart.
    fn load(&self) -> Result<Snapshot, Self::Error>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_accepts_64_lowercase_hex() {
        let raw = "0a".repeat(32);
        assert_eq!(Token::parse(&raw).unwrap().expose(), raw);
    }

    #[test]
    fn token_rejects_wrong_length_case_or_alphabet() {
        assert!(Token::parse(&"a".repeat(63)).is_err());
        assert!(Token::parse(&"A".repeat(64)).is_err());
        assert!(Token::parse(&"g".repeat(64)).is_err());
    }

    #[test]
    fn token_never_prints_itself() {
        let token = Token::parse(&"a".repeat(64)).unwrap();
        assert_eq!(format!("{token:?}"), "Token(***)");
    }
}
