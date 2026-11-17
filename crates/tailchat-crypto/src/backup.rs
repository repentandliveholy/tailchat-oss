//! Encrypted key backup (`docs/specs/2026-11-04-e2ee.md` §4.5): AES-256-GCM
//! encryption of Megolm inbound session keys (`export_at_first_known_index`)
//! and of the account's secret self-signing key, unlocked by a 256-bit random
//! recovery key (no KDF) or by an optional passphrase derived with Argon2id
//! (64 MiB, `t = 3`, `p = 1`).
//!
//! Every session entry carries a random 96-bit nonce and binds
//! `AAD = (login, sid, version)` so the server cannot swap ciphertexts between
//! sessions, accounts or backup versions.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use serde_json::json;
use vodozemac::{base64_decode, base64_encode};
use zeroize::Zeroizing;

use crate::canonical;
use crate::megolm::Conversation;
use crate::pickle::{from_pickle, to_pickle};
use crate::{
    Account, CrossSigning, CrossSigningPublic, CryptoError, DeviceKeys, DeviceKind, InboundGroup,
    Undecryptable,
};

/// Argon2id memory cost in KiB: 64 MiB (§4.5).
pub const ARGON2_M_COST_KIB: u32 = 64 * 1024;
/// Argon2id time cost (iterations): 3 (§4.5).
pub const ARGON2_T_COST: u32 = 3;
/// Argon2id parallelism: 1 (§4.5).
pub const ARGON2_P_COST: u32 = 1;
/// Minimum passphrase character length when fewer than [`PASSPHRASE_MIN_WORDS`] words (§4.5, §11).
pub const PASSPHRASE_MIN_CHARS: usize = 16;
/// Minimum passphrase word count when shorter than [`PASSPHRASE_MIN_CHARS`] characters (§4.5, §11).
pub const PASSPHRASE_MIN_WORDS: usize = 4;

const RECOVERY_PREFIX: &str = "tailchat-backup:v1:";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;

/// Check whether `passphrase` meets the owner-confirmed minimum (§4.5, §11):
/// at least 4 whitespace-separated words or at least 16 characters.
///
/// # Errors
/// [`CryptoError::WeakPassphrase`].
pub fn validate_passphrase(passphrase: &str) -> Result<(), CryptoError> {
    let trimmed = passphrase.trim();
    let chars = trimmed.chars().count();
    let words = trimmed.split_whitespace().count();
    if chars >= PASSPHRASE_MIN_CHARS || words >= PASSPHRASE_MIN_WORDS {
        Ok(())
    } else {
        Err(CryptoError::WeakPassphrase)
    }
}

/// A 256-bit recovery key generated on the device and shown once (§1.2, §4.5).
/// Requires no KDF.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryKey(Zeroizing<String>);

impl std::fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryKey([redacted])")
    }
}

impl RecoveryKey {
    /// Wrap a recovery key string; wiped on drop.
    pub fn new(raw: Zeroizing<String>) -> Self {
        Self(raw)
    }

    /// The recovery key string, to display once to the user or parse back.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

/// A key derived from the user's passphrase via Argon2id (64 MiB, `t = 3`).
///
/// Computed in the driver outside `Core::handle` (§4.5).
#[derive(Clone, PartialEq, Eq)]
pub struct DerivedPassphraseKey {
    salt: String,
    key: Zeroizing<[u8; KEY_LEN]>,
}

impl std::fmt::Debug for DerivedPassphraseKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DerivedPassphraseKey")
            .field("salt", &self.salt)
            .field("key", &"[redacted]")
            .finish()
    }
}

impl DerivedPassphraseKey {
    /// Validate `passphrase`, generate a fresh 128-bit random salt and derive a
    /// 256-bit wrapping key with Argon2id (`m = 64 MiB`, `t = 3`, `p = 1`).
    ///
    /// # Errors
    /// [`CryptoError::WeakPassphrase`], [`CryptoError::BackupEncryption`].
    pub fn derive_new(passphrase: &str) -> Result<Self, CryptoError> {
        validate_passphrase(passphrase)?;
        let mut salt_bytes = [0u8; SALT_LEN];
        getrandom::fill(&mut salt_bytes).map_err(|_| CryptoError::BackupEncryption)?;
        let salt = base64_encode(salt_bytes);
        Self::derive_with_params(
            passphrase,
            &salt,
            ARGON2_M_COST_KIB,
            ARGON2_T_COST,
            ARGON2_P_COST,
        )
    }

    /// Validate `passphrase` and derive the 256-bit wrapping key for an
    /// existing base64 `salt` from the server's backup metadata.
    ///
    /// # Errors
    /// [`CryptoError::WeakPassphrase`], [`CryptoError::InvalidBackupSecret`],
    /// [`CryptoError::BackupEncryption`].
    pub fn derive_with_salt(passphrase: &str, salt: &str) -> Result<Self, CryptoError> {
        validate_passphrase(passphrase)?;
        Self::derive_with_params(
            passphrase,
            salt,
            ARGON2_M_COST_KIB,
            ARGON2_T_COST,
            ARGON2_P_COST,
        )
    }

    fn derive_with_params(
        passphrase: &str,
        salt: &str,
        m_cost: u32,
        t_cost: u32,
        p_cost: u32,
    ) -> Result<Self, CryptoError> {
        let salt_bytes = base64_decode(salt).map_err(|_| CryptoError::InvalidBackupSecret)?;
        if salt_bytes.len() < SALT_LEN {
            return Err(CryptoError::InvalidBackupSecret);
        }
        let params = Params::new(m_cost, t_cost, p_cost, Some(KEY_LEN))
            .map_err(|_| CryptoError::BackupEncryption)?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        argon2
            .hash_password_into(passphrase.trim().as_bytes(), &salt_bytes, key.as_mut())
            .map_err(|_| CryptoError::BackupEncryption)?;
        Ok(Self {
            salt: base64_encode(&salt_bytes),
            key,
        })
    }

    /// The unpadded base64 salt stored with the backup metadata on the server.
    pub fn salt(&self) -> &str {
        &self.salt
    }
}

/// Optional passphrase slot stored in the server's backup metadata: the Argon2id
/// salt and the AES-256-GCM wrapped [`BackupKey`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassphraseSlot {
    /// Unpadded base64 128-bit Argon2id salt.
    pub salt: String,
    /// Unpadded base64 96-bit AES-256-GCM nonce.
    pub nonce: String,
    /// Unpadded base64 AES-256-GCM ciphertext + tag of the 32-byte backup key.
    pub ct: String,
}

/// One AES-256-GCM encrypted backup blob (`nonce` + `ct`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedBackupEntry {
    /// Unpadded base64 96-bit AES-256-GCM nonce.
    pub nonce: String,
    /// Unpadded base64 AES-256-GCM ciphertext + 128-bit tag.
    pub ct: String,
}

/// One Megolm inbound session encrypted for the server backup (`POST /api/e2ee/backup`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSessionBackup {
    /// The Megolm session id (`sid`, bound in AAD).
    pub session_id: String,
    /// First message index this exported session can decrypt.
    pub first_known_index: u32,
    /// Unpadded base64 96-bit AES-256-GCM nonce.
    pub nonce: String,
    /// Unpadded base64 AES-256-GCM ciphertext + 128-bit tag.
    pub ct: String,
}

/// The account's 256-bit backup key, held in SQLCipher by every verified own
/// device and shared over Olm or recovered from [`RecoveryKey`] / [`PassphraseSlot`] (§4.5).
#[derive(Clone, PartialEq, Eq)]
pub struct BackupKey {
    login: String,
    version: u64,
    key: Zeroizing<[u8; KEY_LEN]>,
}

impl std::fmt::Debug for BackupKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupKey")
            .field("login", &self.login)
            .field("version", &self.version)
            .field("key", &"[redacted]")
            .finish()
    }
}

impl BackupKey {
    /// Generate a fresh 256-bit backup key for `(login, version)` and its
    /// one-time display [`RecoveryKey`] (§4.5).
    ///
    /// # Errors
    /// [`CryptoError::InvalidBackupSecret`] if `login` is empty or `version == 0`,
    /// [`CryptoError::BackupEncryption`] if the OS RNG fails.
    pub fn new(login: &str, version: u64) -> Result<(Self, RecoveryKey), CryptoError> {
        if login.is_empty() || version == 0 {
            return Err(CryptoError::InvalidBackupSecret);
        }
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::fill(key.as_mut()).map_err(|_| CryptoError::BackupEncryption)?;
        let backup = Self {
            login: login.to_owned(),
            version,
            key,
        };
        let recovery = backup.recovery_key();
        Ok((backup, recovery))
    }

    /// Reconstruct from the user's [`RecoveryKey`] string (`tailchat-backup:v1:<version>:<base64>`),
    /// without any KDF (§4.5).
    ///
    /// # Errors
    /// [`CryptoError::InvalidBackupSecret`].
    pub fn from_recovery_key(login: &str, recovery_key: &str) -> Result<Self, CryptoError> {
        if login.is_empty() {
            return Err(CryptoError::InvalidBackupSecret);
        }
        let rest = recovery_key
            .trim()
            .strip_prefix(RECOVERY_PREFIX)
            .ok_or(CryptoError::InvalidBackupSecret)?;
        let (version_str, key_b64) = rest
            .split_once(':')
            .ok_or(CryptoError::InvalidBackupSecret)?;
        let version: u64 = version_str
            .parse()
            .map_err(|_| CryptoError::InvalidBackupSecret)?;
        if version == 0 || key_b64.len() != 43 {
            return Err(CryptoError::InvalidBackupSecret);
        }
        let decoded =
            Zeroizing::new(base64_decode(key_b64).map_err(|_| CryptoError::InvalidBackupSecret)?);
        let bytes: &[u8; KEY_LEN] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| CryptoError::InvalidBackupSecret)?;
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(bytes);
        Ok(Self {
            login: login.to_owned(),
            version,
            key,
        })
    }

    /// Format the [`RecoveryKey`] for this backup key.
    pub fn recovery_key(&self) -> RecoveryKey {
        let encoded = Zeroizing::new(base64_encode(self.key.as_ref()));
        RecoveryKey(Zeroizing::new(format!(
            "{RECOVERY_PREFIX}{}:{}",
            self.version,
            encoded.as_str()
        )))
    }

    /// The account login this backup key belongs to.
    pub fn login(&self) -> &str {
        &self.login
    }

    /// The backup version number (`>= 1`).
    pub fn version(&self) -> u64 {
        self.version
    }

    /// Wrap this backup key under a passphrase-derived key so the backup can
    /// also be unlocked with the passphrase (§4.5).
    ///
    /// # Errors
    /// [`CryptoError::BackupEncryption`].
    pub fn wrap_with_passphrase(
        &self,
        derived: &DerivedPassphraseKey,
    ) -> Result<PassphraseSlot, CryptoError> {
        let aad = aad_passphrase(&self.login, self.version)?;
        let entry = aead_encrypt(&derived.key, self.key.as_ref(), &aad)?;
        Ok(PassphraseSlot {
            salt: derived.salt.clone(),
            nonce: entry.nonce,
            ct: entry.ct,
        })
    }

    /// Unwrap a [`BackupKey`] from the server's [`PassphraseSlot`] using the
    /// Argon2id [`DerivedPassphraseKey`].
    ///
    /// # Errors
    /// [`Undecryptable`] when the passphrase, salt, version or login does not match.
    pub fn from_passphrase_slot(
        login: &str,
        version: u64,
        slot: &PassphraseSlot,
        derived: &DerivedPassphraseKey,
    ) -> Result<Self, Undecryptable> {
        if login.is_empty() || version == 0 || slot.salt != derived.salt {
            return Err(Undecryptable::BadCiphertext);
        }
        let aad = aad_passphrase(login, version).map_err(|_| Undecryptable::Malformed)?;
        let entry = EncryptedBackupEntry {
            nonce: slot.nonce.clone(),
            ct: slot.ct.clone(),
        };
        let plain = aead_decrypt(&derived.key, &entry, &aad)?;
        let bytes: &[u8; KEY_LEN] = plain
            .as_slice()
            .try_into()
            .map_err(|_| Undecryptable::BadPlaintext)?;
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(bytes);
        Ok(Self {
            login: login.to_owned(),
            version,
            key,
        })
    }

    /// Encrypt the account's [`CrossSigning`] (including the secret
    /// self-signing key) for the backup (§4.2, §4.5).
    ///
    /// # Errors
    /// [`CryptoError::WrongSession`] if `cross` belongs to another login,
    /// [`CryptoError::BackupEncryption`].
    pub fn encrypt_cross_signing(
        &self,
        cross: &CrossSigning,
    ) -> Result<EncryptedBackupEntry, CryptoError> {
        if cross.login() != self.login {
            return Err(CryptoError::WrongSession);
        }
        let payload = CrossSigningBackupPlain {
            public: cross.public().clone(),
            self_signing_secret: cross.self_signing_base64(),
        };
        let bytes = Zeroizing::new(
            serde_json::to_vec(&payload).map_err(|_| CryptoError::BackupEncryption)?,
        );
        let aad = aad_self_signing(&self.login, self.version)?;
        aead_encrypt(&self.key, &bytes, &aad)
    }

    /// Decrypt the account's [`CrossSigning`] from the backup and verify that
    /// it belongs to this account and matches `expected_public` when known (§4.2, §4.5).
    ///
    /// # Errors
    /// [`Undecryptable`] if the ciphertext, login, signature or expected public
    /// key does not match.
    pub fn decrypt_cross_signing(
        &self,
        entry: &EncryptedBackupEntry,
        expected_public: Option<&CrossSigningPublic>,
    ) -> Result<CrossSigning, Undecryptable> {
        let aad =
            aad_self_signing(&self.login, self.version).map_err(|_| Undecryptable::Malformed)?;
        let plain = aead_decrypt(&self.key, entry, &aad)?;
        let parsed: CrossSigningBackupPlain =
            serde_json::from_slice(&plain).map_err(|_| Undecryptable::BadPlaintext)?;
        if parsed.public.login() != self.login {
            return Err(Undecryptable::WrongSender);
        }
        if let Some(expected) = expected_public
            && &parsed.public != expected
        {
            return Err(Undecryptable::WrongSender);
        }
        CrossSigning::from_parts(parsed.public, &parsed.self_signing_secret)
    }

    /// Encrypt one [`InboundGroup`] at its `first_known_index` with a fresh
    /// 96-bit nonce and `AAD = (login, sid, version)` (§4.5).
    ///
    /// # Errors
    /// [`CryptoError::WrongSession`] if the session's conversation does not
    /// include `self.login`, [`CryptoError::BackupEncryption`].
    pub fn encrypt_session(
        &self,
        session: &InboundGroup,
    ) -> Result<EncryptedSessionBackup, CryptoError> {
        if !session.conversation().contains(&self.login) {
            return Err(CryptoError::WrongSession);
        }
        let session_id = session.session_id();
        let first_known_index = session.first_known_index();
        let payload = SessionBackupPlain {
            conversation: session.conversation().clone(),
            sender: session.sender().clone(),
            session_id: session_id.clone(),
            first_known_index,
            session_key: session.export_at_first_known_index_base64(),
        };
        let bytes = Zeroizing::new(
            serde_json::to_vec(&payload).map_err(|_| CryptoError::BackupEncryption)?,
        );
        let aad = aad_session(&self.login, &session_id, self.version)?;
        let entry = aead_encrypt(&self.key, &bytes, &aad)?;
        Ok(EncryptedSessionBackup {
            session_id,
            first_known_index,
            nonce: entry.nonce,
            ct: entry.ct,
        })
    }

    /// Decrypt one [`InboundGroup`] from the backup, checking `AAD = (login,
    /// sid, version)` so the server cannot move a record between sessions,
    /// accounts or backup versions (§4.5). The restored session has
    /// `is_sender_verified() == false` until a direct `SessionKey` arrives (§4.2).
    ///
    /// # Errors
    /// [`Undecryptable`].
    pub fn decrypt_session(
        &self,
        session_id: &str,
        nonce: &str,
        ct: &str,
    ) -> Result<InboundGroup, Undecryptable> {
        let aad = aad_session(&self.login, session_id, self.version)
            .map_err(|_| Undecryptable::Malformed)?;
        let entry = EncryptedBackupEntry {
            nonce: nonce.to_owned(),
            ct: ct.to_owned(),
        };
        let plain = aead_decrypt(&self.key, &entry, &aad)?;
        let parsed: SessionBackupPlain =
            serde_json::from_slice(&plain).map_err(|_| Undecryptable::BadPlaintext)?;
        if parsed.session_id != session_id {
            return Err(Undecryptable::SessionMismatch);
        }
        InboundGroup::from_exported(
            &self.login,
            parsed.conversation,
            parsed.sender,
            session_id,
            &parsed.session_key,
        )
    }

    /// Package this backup key to send over Olm to another cross-signed client
    /// device of the same account (§4.5).
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`].
    pub fn share(
        &self,
        own: &Account,
        own_cross: &CrossSigningPublic,
        recipient: &DeviceKeys,
    ) -> Result<SharedBackupKey, CryptoError> {
        if self.login != own.login()
            || own_cross.login() != own.login()
            || recipient.login() != own.login()
            || recipient.device_id() == own.device_id()
            || recipient.kind() != DeviceKind::Client
            || !own_cross.verifies(recipient)
        {
            return Err(CryptoError::UntrustedDevice);
        }
        Ok(SharedBackupKey {
            login: self.login.clone(),
            version: self.version,
            key: Zeroizing::new(base64_encode(self.key.as_ref())),
        })
    }

    /// Accept a [`BackupKey`] received over Olm from another cross-signed
    /// client device of `own`'s account (§4.5).
    ///
    /// # Errors
    /// [`Undecryptable`].
    pub fn from_shared(
        own: &Account,
        own_cross: &CrossSigningPublic,
        received: ReceivedBackupKey,
    ) -> Result<Self, Undecryptable> {
        let ReceivedBackupKey { sender, key } = received;
        if own_cross.login() != own.login()
            || sender.login() != own.login()
            || sender.kind() != DeviceKind::Client
            || !own_cross.verifies(&sender)
            || key.login != own.login()
            || key.version == 0
        {
            return Err(Undecryptable::WrongSender);
        }
        let decoded =
            Zeroizing::new(base64_decode(&key.key).map_err(|_| Undecryptable::BadPlaintext)?);
        let bytes: &[u8; KEY_LEN] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| Undecryptable::BadPlaintext)?;
        let mut raw = Zeroizing::new([0u8; KEY_LEN]);
        raw.copy_from_slice(bytes);
        Ok(Self {
            login: key.login,
            version: key.version,
            key: raw,
        })
    }

    /// Pickle for storage in SQLCipher (§4.5, §6).
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn pickle(&self) -> Result<Zeroizing<String>, CryptoError> {
        to_pickle(&BackupKeyPickle {
            login: self.login.clone(),
            version: self.version,
            key: Zeroizing::new(base64_encode(self.key.as_ref())),
        })
    }

    /// Restore from [`BackupKey::pickle`].
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn from_pickle(pickle: &str) -> Result<Self, CryptoError> {
        let p: BackupKeyPickle = from_pickle(pickle)?;
        if p.login.is_empty() || p.version == 0 {
            return Err(CryptoError::Pickle {
                reason: "unreadable",
            });
        }
        let decoded = Zeroizing::new(base64_decode(&p.key).map_err(|_| CryptoError::Pickle {
            reason: "unreadable",
        })?);
        let bytes: &[u8; KEY_LEN] =
            decoded
                .as_slice()
                .try_into()
                .map_err(|_| CryptoError::Pickle {
                    reason: "unreadable",
                })?;
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(bytes);
        Ok(Self {
            login: p.login,
            version: p.version,
            key,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct BackupKeyPickle {
    login: String,
    version: u64,
    key: Zeroizing<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrossSigningBackupPlain {
    public: CrossSigningPublic,
    self_signing_secret: Zeroizing<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionBackupPlain {
    conversation: Conversation,
    sender: DeviceKeys,
    session_id: String,
    first_known_index: u32,
    session_key: Zeroizing<String>,
}

/// A [`BackupKey`] packaged for Olm delivery to another cross-signed client
/// device of the same account (§4.5).
pub struct SharedBackupKey {
    login: String,
    version: u64,
    key: Zeroizing<String>,
}

impl std::fmt::Debug for SharedBackupKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedBackupKey")
            .field("login", &self.login)
            .field("version", &self.version)
            .field("key", &"[redacted]")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedBackupKeyWire {
    login: String,
    version: u64,
    key: Zeroizing<String>,
}

impl SharedBackupKey {
    pub(crate) fn wire(&self) -> SharedBackupKeyWire {
        SharedBackupKeyWire {
            login: self.login.clone(),
            version: self.version,
            key: self.key.clone(),
        }
    }

    pub(crate) fn from_wire(wire: SharedBackupKeyWire) -> Self {
        Self {
            login: wire.login,
            version: wire.version,
            key: wire.key,
        }
    }

    /// The backup version.
    pub fn version(&self) -> u64 {
        self.version
    }
}

/// A [`SharedBackupKey`] as it came out of Olm, bound to the device that sent
/// it. Only [`crate::OlmChannel::decrypt`] makes one.
#[derive(Debug)]
pub struct ReceivedBackupKey {
    sender: DeviceKeys,
    key: SharedBackupKey,
}

impl ReceivedBackupKey {
    pub(crate) fn new(sender: DeviceKeys, key: SharedBackupKey) -> Self {
        Self { sender, key }
    }

    /// The device that sent it.
    pub fn sender(&self) -> &DeviceKeys {
        &self.sender
    }

    /// The shared backup key.
    pub fn key(&self) -> &SharedBackupKey {
        &self.key
    }
}

/// Canonical AAD for a backed-up Megolm session: `(login, sid, version)` (§4.5).
fn aad_session(login: &str, sid: &str, version: u64) -> Result<Vec<u8>, CryptoError> {
    canonical::canonical_json(&json!({
        "login": login,
        "sid": sid,
        "version": version,
    }))
    .map(String::into_bytes)
}

/// Canonical AAD for the backed-up self-signing key: distinct shape from
/// [`aad_session`] (`kind` instead of `sid`).
fn aad_self_signing(login: &str, version: u64) -> Result<Vec<u8>, CryptoError> {
    canonical::canonical_json(&json!({
        "kind": "self_signing",
        "login": login,
        "version": version,
    }))
    .map(String::into_bytes)
}

/// Canonical AAD for the passphrase-wrapped backup key.
fn aad_passphrase(login: &str, version: u64) -> Result<Vec<u8>, CryptoError> {
    canonical::canonical_json(&json!({
        "kind": "passphrase",
        "login": login,
        "version": version,
    }))
    .map(String::into_bytes)
}
fn aead_encrypt(
    key: &[u8; KEY_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<EncryptedBackupEntry, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::BackupEncryption)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|_| CryptoError::BackupEncryption)?;
    let nonce = Nonce::from(nonce_bytes);
    let ct = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::BackupEncryption)?;
    Ok(EncryptedBackupEntry {
        nonce: base64_encode(nonce_bytes),
        ct: base64_encode(ct),
    })
}

fn aead_decrypt(
    key: &[u8; KEY_LEN],
    entry: &EncryptedBackupEntry,
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, Undecryptable> {
    let nonce_vec = base64_decode(&entry.nonce).map_err(|_| Undecryptable::Malformed)?;
    let nonce_bytes: [u8; NONCE_LEN] = nonce_vec
        .as_slice()
        .try_into()
        .map_err(|_| Undecryptable::Malformed)?;
    let ct = base64_decode(&entry.ct).map_err(|_| Undecryptable::Malformed)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Undecryptable::BadCiphertext)?;
    let nonce = Nonce::from(nonce_bytes);
    cipher
        .decrypt(&nonce, Payload { msg: &ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| Undecryptable::BadCiphertext)
}

#[cfg(test)]
mod tests {
    use serde_json::Map;

    use super::*;
    use crate::megolm::{Frame, MessageKind, OutboundGroup};

    #[test]
    fn recovery_key_and_passphrase_unlock_the_same_backup_key() {
        let (backup, recovery) = BackupKey::new("alice", 1).unwrap();
        let secret_part = recovery.expose().split(':').next_back().unwrap();
        assert!(!format!("{backup:?}").contains(secret_part));
        assert_eq!(format!("{recovery:?}"), "RecoveryKey([redacted])");

        let from_rk = BackupKey::from_recovery_key("alice", recovery.expose()).unwrap();
        assert_eq!(from_rk, backup);
        assert!(BackupKey::from_recovery_key("bob", recovery.expose()).unwrap() != backup);
        assert!(BackupKey::from_recovery_key("alice", "tailchat-backup:v1:0:abc").is_err());

        // Passphrase validation (§4.5, §11): >= 4 words or >= 16 chars.
        assert_eq!(
            validate_passphrase("too short"),
            Err(CryptoError::WeakPassphrase)
        );
        assert!(validate_passphrase("correct horse battery staple").is_ok());
        assert!(validate_passphrase("sixteen-char-pwd").is_ok());

        // Fast test params for unit check + real production Argon2id (64 MiB, t=3) round-trip.
        let derived = DerivedPassphraseKey::derive_new("correct horse battery staple").unwrap();
        let slot = backup.wrap_with_passphrase(&derived).unwrap();
        let redrived =
            DerivedPassphraseKey::derive_with_salt("correct horse battery staple", &slot.salt)
                .unwrap();
        let from_pw = BackupKey::from_passphrase_slot("alice", 1, &slot, &redrived).unwrap();
        assert_eq!(from_pw, backup);

        // Wrong passphrase, wrong login, or wrong version is refused by AES-GCM AAD/tag.
        let wrong_pw = DerivedPassphraseKey::derive_with_params(
            "wrong horse battery staple",
            &slot.salt,
            64,
            1,
            1,
        )
        .unwrap();
        assert_eq!(
            BackupKey::from_passphrase_slot("alice", 1, &slot, &wrong_pw),
            Err(Undecryptable::BadCiphertext)
        );
        assert_eq!(
            BackupKey::from_passphrase_slot("bob", 1, &slot, &redrived),
            Err(Undecryptable::BadCiphertext)
        );
        assert_eq!(
            BackupKey::from_passphrase_slot("alice", 2, &slot, &redrived),
            Err(Undecryptable::BadCiphertext)
        );
    }

    #[test]
    fn session_and_self_signing_backup_bind_login_sid_and_version_in_aad() {
        let (backup, _) = BackupKey::new("alice", 1).unwrap();
        let alice = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let cross = alice.cross_signing();

        let enc_cross = backup.encrypt_cross_signing(cross).unwrap();
        let dec_cross = backup
            .decrypt_cross_signing(&enc_cross, Some(cross.public()))
            .unwrap();
        assert_eq!(dec_cross.public(), cross.public());

        let (mut out, inbound) = OutboundGroup::create(&alice, "bob", 1_000);
        let mut content = Map::new();
        content.insert("text".into(), json!("secret history"));
        let frame = Frame {
            from: "alice",
            to: "bob",
            id: "m-1",
            kind: MessageKind::Msg,
        };
        let env = out.encrypt(&alice, &frame, &content, None).unwrap();

        let enc_sess = backup.encrypt_session(&inbound).unwrap();
        let mut restored = backup
            .decrypt_session(&enc_sess.session_id, &enc_sess.nonce, &enc_sess.ct)
            .unwrap();
        assert!(
            !restored.is_sender_verified(),
            "restored from backup is marked sender-unverified until direct SessionKey arrives"
        );
        let opened = restored.decrypt(&frame, &env, None).unwrap();
        assert_eq!(opened.content.get("text"), Some(&json!("secret history")));

        // Server cannot swap ciphertexts between session IDs, accounts or versions.
        assert_eq!(
            backup
                .decrypt_session("other-session-id", &enc_sess.nonce, &enc_sess.ct)
                .unwrap_err(),
            Undecryptable::BadCiphertext
        );
        let (v2_same_bytes, _) = BackupKey::new("alice", 2).unwrap();
        assert!(
            v2_same_bytes
                .decrypt_session(&enc_sess.session_id, &enc_sess.nonce, &enc_sess.ct)
                .is_err()
        );
        // Nor can the self-signing ciphertext be passed off as a session named "self_signing".
        assert_eq!(
            backup
                .decrypt_session("self_signing", &enc_cross.nonce, &enc_cross.ct)
                .unwrap_err(),
            Undecryptable::BadCiphertext
        );
    }
}
