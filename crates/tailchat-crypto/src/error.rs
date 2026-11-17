/// A mistake by the caller, or data this device stored that no longer reads.
///
/// Nothing a server or a peer sends is a `CryptoError` once it has reached a
/// decrypt path: those end in [`Undecryptable`] instead. Key material from the
/// server (`keys/query`, `keys/claim`) is checked before anything is built
/// from it, and is refused here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    /// A device id that is not the server's 16 base64url characters.
    #[error("invalid device id")]
    InvalidDeviceId,
    /// Signed device keys with the wrong shape, or naming somebody else.
    #[error("invalid device keys: {reason}")]
    InvalidDeviceKeys {
        /// Which part is wrong.
        reason: &'static str,
    },
    /// A key that is not 32 bytes of unpadded standard base64.
    #[error("invalid {what} key")]
    InvalidKey {
        /// Which key.
        what: &'static str,
    },
    /// The signature is missing or does not verify.
    #[error("signature missing or invalid")]
    BadSignature,
    /// A value canonical JSON cannot carry (a float, an integer outside
    /// ±(2⁵³ − 1)): JavaScript would print it differently, so no signature
    /// over it could be checked by both.
    #[error("not canonical JSON: {reason}")]
    NotCanonical {
        /// What was found.
        reason: &'static str,
    },
    /// No Olm session with this device yet: claim a one-time key first.
    #[error("no Olm session with this device")]
    NoSession,
    /// The key exchange produced a weak shared secret (a low-order key).
    #[error("key exchange refused: non-contributory key")]
    WeakKey,
    /// The message content uses a field the envelope binds itself
    /// (`from`, `to`, `id`, `kind`).
    #[error("content field {field:?} is reserved")]
    ReservedField {
        /// The field.
        field: &'static str,
    },
    /// The session belongs to another conversation or another device.
    #[error("session does not belong to this conversation or device")]
    WrongSession,
    /// A header or attachment over the plaintext format's limits.
    #[error("plaintext is too large")]
    TooLarge,
    /// A pickle that does not parse: storage is corrupt or from a newer build.
    /// Carries no detail: a parser's message could quote secret key bytes.
    #[error("unreadable pickle: {reason}")]
    Pickle {
        /// `unreadable` or `version`.
        reason: &'static str,
    },
    /// Cross-signing keys with the wrong shape, usage or signature.
    #[error("invalid cross-signing keys: {reason}")]
    InvalidCrossSigning {
        /// Which part is wrong.
        reason: &'static str,
    },
    /// Refused to sign or forward keys to an untrusted or foreign device.
    #[error("device is not trusted for this operation")]
    UntrustedDevice,
    /// A QR verification payload that does not parse.
    #[error("invalid QR verification code")]
    InvalidQrCode,
    /// A SAS call made in the wrong step of the handshake.
    #[error("invalid SAS state for this operation")]
    SasState,
    /// A backup recovery key or salt that does not parse.
    #[error("invalid backup recovery key or salt")]
    InvalidBackupSecret,
    /// A backup passphrase shorter than 16 characters and fewer than 4 words (§4.5, §11).
    #[error("backup passphrase must be at least 16 characters or 4 words")]
    WeakPassphrase,
    /// AES-256-GCM or OS RNG failed while encrypting a backup entry.
    #[error("backup encryption failed")]
    BackupEncryption,
}

/// Why an encrypted message or to-device message could not be read.
///
/// Never an `Err` of the caller's: the frame stays in storage with its
/// envelope (`docs/specs/2026-11-04-e2ee.md` §4.3) and the conversation shows
/// it as undecryptable. Only [`Undecryptable::UnknownSession`] may become
/// readable later, when its key arrives.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Undecryptable {
    /// Not an envelope or to-device body of a version this build reads.
    #[error("malformed envelope")]
    Malformed,
    /// No session with this id: the key has not arrived (yet).
    #[error("session key not received")]
    UnknownSession,
    /// `sid`/`dev` of the envelope do not name the session it was opened with.
    #[error("envelope names another session or device")]
    SessionMismatch,
    /// MAC, signature, padding or ratchet index refused the ciphertext.
    #[error("ciphertext does not verify")]
    BadCiphertext,
    /// The session or Olm channel is not the outer sender's.
    #[error("not from the claimed sender")]
    WrongSender,
    /// The session was shared for another conversation.
    #[error("session belongs to another conversation")]
    WrongConversation,
    /// An Olm message addressed to another account or device.
    #[error("addressed to another device")]
    WrongRecipient,
    /// Decrypted, but not the plaintext format this build writes.
    #[error("unreadable plaintext")]
    BadPlaintext,
    /// The ciphertext says something else than the frame around it.
    #[error("envelope field {field:?} does not match the frame")]
    FieldMismatch {
        /// `from`, `to`, `id` or `kind`.
        field: &'static str,
    },
    /// This message index already carried another message id: a replay.
    #[error("message index {index} already used by another message")]
    Replay {
        /// The Megolm message index.
        index: u32,
    },
    /// An edit of a message written by another account.
    #[error("edit of another account's message")]
    EditByOtherAccount,
    /// A SAS key arrived before the responder committed to its key, or in the wrong step.
    #[error("SAS message out of order or missing commitment")]
    SasWithoutCommitment,
    /// The responder's SAS public key does not match its earlier commitment.
    #[error("SAS public key does not match commitment")]
    SasCommitmentMismatch,
    /// The SAS MAC over the master keys and device keys did not verify.
    #[error("SAS MAC verification failed")]
    SasMacInvalid,
}
