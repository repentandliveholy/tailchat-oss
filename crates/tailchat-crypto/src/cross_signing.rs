//! Cross-signing (`docs/specs/2026-11-04-e2ee.md` §4.2): an account's master
//! key (Ed25519) signs its self-signing key, and the self-signing key signs
//! the account's devices.
//!
//! TOFU and QR/SAS verification check the master key, not every device: a new
//! device signed by the account's self-signing key is trusted automatically,
//! while an unsigned device receives no conversation keys and raises a warning.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use vodozemac::{Ed25519PublicKey, Ed25519SecretKey};
use zeroize::Zeroizing;

use crate::canonical::{device_key_id, sign_object, verify_object};
use crate::device::{check_device_id, parse_ed};
use crate::pickle::{from_pickle, to_pickle};
use crate::{Account, CryptoError, DeviceKeys, DeviceKind, Undecryptable};

const MASTER_USAGE: &str = "master";
const SELF_SIGNING_USAGE: &str = "self_signing";
const PEER_VERIFIED_USAGE: &str = "peer_verified";
const QR_PREFIX: &str = "tailchat-verify:v1:";

/// What a valid [`CrossSigning::attest_peer`] statement vouches for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestedPeer {
    /// The account that was verified.
    pub peer: String,
    /// Its master key as verified, unpadded base64.
    pub master_key: String,
}

/// The public cross-signing keys of an account (`crossSigning` in `keys/query`
/// and `keys/upload`, §8.1), with both signatures checked:
/// `master` is self-signed, and `selfSigning` is signed by `master`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CrossSigningPublicRaw", into = "CrossSigningPublicRaw")]
pub struct CrossSigningPublic {
    login: String,
    master: Ed25519PublicKey,
    self_signing: Ed25519PublicKey,
    master_json: Value,
    self_signing_json: Value,
}

impl std::fmt::Debug for CrossSigningPublic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CrossSigningPublic")
            .field("login", &self.login)
            .field("master", &self.master.to_base64())
            .field("self_signing", &self.self_signing.to_base64())
            .finish()
    }
}

impl CrossSigningPublic {
    /// Parse `crossSigning` of `login` from `keys/query` (`{}` when the
    /// account has published no cross-signing keys yet).
    ///
    /// # Errors
    /// [`CryptoError::InvalidCrossSigning`], [`CryptoError::InvalidKey`],
    /// [`CryptoError::BadSignature`].
    pub fn from_json(login: &str, value: &Value) -> Result<Option<Self>, CryptoError> {
        if value.is_null() {
            return Ok(None);
        }
        let object = value.as_object().ok_or(CryptoError::InvalidCrossSigning {
            reason: "not an object",
        })?;
        if object.is_empty() {
            return Ok(None);
        }
        let master_val = object
            .get("master")
            .ok_or(CryptoError::InvalidCrossSigning { reason: "master" })?;
        let self_val = object
            .get("selfSigning")
            .ok_or(CryptoError::InvalidCrossSigning {
                reason: "selfSigning",
            })?;
        let master = parse_slot(login, MASTER_USAGE, master_val, None)?;
        let self_signing = parse_slot(login, SELF_SIGNING_USAGE, self_val, Some(&master))?;
        Ok(Some(Self {
            login: login.to_owned(),
            master,
            self_signing,
            master_json: master_val.clone(),
            self_signing_json: self_val.clone(),
        }))
    }

    /// The account login these keys belong to.
    pub fn login(&self) -> &str {
        &self.login
    }

    /// The account's master Ed25519 public key, unpadded base64.
    pub fn master_key(&self) -> String {
        self.master.to_base64()
    }

    /// The account's self-signing Ed25519 public key, unpadded base64.
    pub fn self_signing_key(&self) -> String {
        self.self_signing.to_base64()
    }

    /// Whether `device` belongs to this account and carries a valid signature
    /// by this account's self-signing key.
    pub fn verifies(&self, device: &DeviceKeys) -> bool {
        device.login() == self.login
            && device.is_signed_by(&self.self_signing.to_base64(), &self.self_signing)
    }

    /// The peer and master key `value` vouches for, when it is a
    /// [`CrossSigning::attest_peer`] statement of this account signed by this
    /// account's current self-signing key; `None` for anything else — another
    /// account's statement, a different `usage`, a statement about this
    /// account itself, or one signed before a key reset.
    pub fn attested_peer(&self, value: &Value) -> Option<AttestedPeer> {
        let object = value.as_object()?;
        if object.get("login").and_then(Value::as_str) != Some(self.login.as_str())
            || object.get("usage").and_then(Value::as_str) != Some(PEER_VERIFIED_USAGE)
        {
            return None;
        }
        let peer = object.get("peer").and_then(Value::as_str)?;
        if peer.is_empty() || peer == self.login {
            return None;
        }
        let key = parse_ed(object.get("key").and_then(Value::as_str)?).ok()?;
        let key_id = device_key_id(&self.self_signing.to_base64());
        verify_object(object, &self.login, &key_id, &self.self_signing).ok()?;
        Some(AttestedPeer {
            peer: peer.to_owned(),
            master_key: key.to_base64(),
        })
    }

    /// The wire form (`{master, selfSigning}`) for `keys/upload` or `keys/query`.
    pub fn to_json(&self) -> Value {
        json!({
            "master": self.master_json,
            "selfSigning": self.self_signing_json,
        })
    }
}

fn parse_slot(
    login: &str,
    expected_usage: &'static str,
    value: &Value,
    signer: Option<&Ed25519PublicKey>,
) -> Result<Ed25519PublicKey, CryptoError> {
    let object = value.as_object().ok_or(CryptoError::InvalidCrossSigning {
        reason: expected_usage,
    })?;
    if object.get("login").and_then(Value::as_str) != Some(login) {
        return Err(CryptoError::InvalidCrossSigning { reason: "login" });
    }
    if object.get("usage").and_then(Value::as_str) != Some(expected_usage) {
        return Err(CryptoError::InvalidCrossSigning { reason: "usage" });
    }
    let key_text = object
        .get("key")
        .and_then(Value::as_str)
        .ok_or(CryptoError::InvalidKey {
            what: expected_usage,
        })?;
    let key = parse_ed(key_text)?;
    let verifying_key = signer.unwrap_or(&key);
    verify_object(
        object,
        login,
        &device_key_id(&verifying_key.to_base64()),
        verifying_key,
    )?;
    Ok(key)
}

#[derive(Serialize, Deserialize)]
struct CrossSigningPublicRaw {
    login: String,
    master: Value,
    #[serde(rename = "selfSigning")]
    self_signing: Value,
}

impl From<CrossSigningPublic> for CrossSigningPublicRaw {
    fn from(c: CrossSigningPublic) -> Self {
        Self {
            login: c.login,
            master: c.master_json,
            self_signing: c.self_signing_json,
        }
    }
}

impl TryFrom<CrossSigningPublicRaw> for CrossSigningPublic {
    type Error = CryptoError;

    fn try_from(raw: CrossSigningPublicRaw) -> Result<Self, Self::Error> {
        let value = json!({
            "master": raw.master,
            "selfSigning": raw.self_signing,
        });
        Self::from_json(&raw.login, &value)?.ok_or(CryptoError::InvalidCrossSigning {
            reason: "empty crossSigning",
        })
    }
}

/// An account's cross-signing identity with its secret self-signing key, held
/// by the account's verified devices (§4.2, §4.5).
pub struct CrossSigning {
    public: CrossSigningPublic,
    self_signing: Ed25519SecretKey,
}

impl std::fmt::Debug for CrossSigning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CrossSigning")
            .field("public", &self.public)
            .field("self_signing", &"[redacted]")
            .finish()
    }
}

impl CrossSigning {
    /// Generate a fresh master key and self-signing key for `login`. The
    /// master secret key signs `master` and `selfSigning` and is dropped at
    /// once; the self-signing secret key is kept to sign this account's devices.
    ///
    /// # Errors
    /// Only if canonical signing fails, which the shapes here never do.
    pub fn new(login: &str) -> Result<Self, CryptoError> {
        if login.is_empty() {
            return Err(CryptoError::InvalidCrossSigning { reason: "login" });
        }
        let master_secret = Ed25519SecretKey::new();
        let master_pub = master_secret.public_key();
        let master_id = device_key_id(&master_pub.to_base64());

        let self_secret = Ed25519SecretKey::new();
        let self_pub = self_secret.public_key();

        let mut master_obj = Map::new();
        master_obj.insert("login".into(), Value::String(login.to_owned()));
        master_obj.insert("usage".into(), Value::String(MASTER_USAGE.to_owned()));
        master_obj.insert("key".into(), Value::String(master_pub.to_base64()));
        sign_object(&mut master_obj, login, &master_id, |m| {
            master_secret.sign(m)
        })?;

        let mut self_obj = Map::new();
        self_obj.insert("login".into(), Value::String(login.to_owned()));
        self_obj.insert("usage".into(), Value::String(SELF_SIGNING_USAGE.to_owned()));
        self_obj.insert("key".into(), Value::String(self_pub.to_base64()));
        sign_object(&mut self_obj, login, &master_id, |m| master_secret.sign(m))?;

        let public = CrossSigningPublic {
            login: login.to_owned(),
            master: master_pub,
            self_signing: self_pub,
            master_json: Value::Object(master_obj),
            self_signing_json: Value::Object(self_obj),
        };
        Ok(Self {
            public,
            self_signing: self_secret,
        })
    }

    /// The public half (`master` and `selfSigning`).
    pub fn public(&self) -> &CrossSigningPublic {
        &self.public
    }

    /// The account login.
    pub fn login(&self) -> &str {
        self.public.login()
    }

    /// The master Ed25519 public key, unpadded base64.
    pub fn master_key(&self) -> String {
        self.public.master_key()
    }

    /// The self-signing Ed25519 public key, unpadded base64.
    pub fn self_signing_key(&self) -> String {
        self.public.self_signing_key()
    }

    /// Whether `device` belongs to this account and is signed by this
    /// self-signing key.
    pub fn verifies(&self, device: &DeviceKeys) -> bool {
        self.public.verifies(device)
    }

    /// The `crossSigning` object for `POST /api/e2ee/keys/upload`.
    pub fn upload_json(&self) -> Value {
        self.public.to_json()
    }

    /// Add this self-signing key's signature to a `deviceKeys` JSON map of
    /// the same account.
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] if `object` is not for this account.
    pub(crate) fn sign_device_object(
        &self,
        object: &mut Map<String, Value>,
    ) -> Result<(), CryptoError> {
        if object.get("login").and_then(Value::as_str) != Some(self.public.login()) {
            return Err(CryptoError::UntrustedDevice);
        }
        let key_id = device_key_id(&self.public.self_signing.to_base64());
        sign_object(object, self.public.login(), &key_id, |m| {
            self.self_signing.sign(m)
        })
    }

    /// Sign `device` of this account with the self-signing key, preserving its
    /// device self-signature.
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] when `device` belongs to another account.
    pub fn sign_device(&self, device: &DeviceKeys) -> Result<DeviceKeys, CryptoError> {
        if device.login() != self.public.login() {
            return Err(CryptoError::UntrustedDevice);
        }
        let mut value = device.to_signed_json();
        let Some(object) = value.as_object_mut() else {
            return Err(CryptoError::UntrustedDevice);
        };
        self.sign_device_object(object)?;
        DeviceKeys::from_json(&value)
    }

    /// This account's word that `peer_master` is `peer`'s master key, checked
    /// by a person (safety code, SAS or QR): `{login, usage: "peer_verified",
    /// peer, key}` signed by the self-signing key. The server keeps it for this
    /// account alone, so a verification made on one device holds on all of
    /// them ([`CrossSigningPublic::attested_peer`]). The master secret that
    /// Matrix signs such statements with is gone the moment the account is
    /// made, so the self-signing key — which every signed device of the
    /// account holds — signs them, under a `usage` no device object carries.
    ///
    /// # Errors
    /// [`CryptoError::InvalidCrossSigning`] for an empty `peer`, this account
    /// itself, or a `peer_master` that is not an Ed25519 key.
    pub fn attest_peer(&self, peer: &str, peer_master: &str) -> Result<Value, CryptoError> {
        if peer.is_empty() || peer == self.public.login() {
            return Err(CryptoError::InvalidCrossSigning { reason: "peer" });
        }
        let key = parse_ed(peer_master)?;
        let mut object = Map::new();
        object.insert(
            "login".into(),
            Value::String(self.public.login().to_owned()),
        );
        object.insert(
            "usage".into(),
            Value::String(PEER_VERIFIED_USAGE.to_owned()),
        );
        object.insert("peer".into(), Value::String(peer.to_owned()));
        object.insert("key".into(), Value::String(key.to_base64()));
        let key_id = device_key_id(&self.public.self_signing.to_base64());
        sign_object(&mut object, self.public.login(), &key_id, |m| {
            self.self_signing.sign(m)
        })?;
        Ok(Value::Object(object))
    }

    /// Package the cross-signing secret to send over Olm to another verified
    /// client device of the same account (§4.2).
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] if `recipient` is not a client device
    /// of `own`'s account or `self` does not belong to `own`.
    pub fn share(
        &self,
        own: &Account,
        recipient: &DeviceKeys,
    ) -> Result<SharedCrossSigningKey, CryptoError> {
        if self.public.login() != own.login()
            || recipient.login() != own.login()
            || recipient.kind() != DeviceKind::Client
        {
            return Err(CryptoError::UntrustedDevice);
        }
        Ok(SharedCrossSigningKey {
            public: self.public.clone(),
            self_signing_secret: Zeroizing::new(self.self_signing.to_base64()),
        })
    }

    /// Accept the cross-signing secret received over Olm from another device of
    /// `own`'s account that is itself signed by `public`.
    ///
    /// # Errors
    /// [`Undecryptable`] if the sender is not a cross-signed device of `own` or
    /// the secret key does not match `public.selfSigning`.
    pub fn from_shared(
        own: &Account,
        received: ReceivedCrossSigningKey,
    ) -> Result<Self, Undecryptable> {
        let ReceivedCrossSigningKey { sender, key } = received;
        if sender.login() != own.login() || key.public.login() != own.login() {
            return Err(Undecryptable::WrongSender);
        }
        if !key.public.verifies(&sender) {
            return Err(Undecryptable::WrongSender);
        }
        let secret = Ed25519SecretKey::from_base64(&key.self_signing_secret)
            .map_err(|_| Undecryptable::BadPlaintext)?;
        if secret.public_key() != key.public.self_signing {
            return Err(Undecryptable::BadPlaintext);
        }
        Ok(Self {
            public: key.public,
            self_signing: secret,
        })
    }

    /// Base64 of the secret self-signing key, for encrypted key backup (§4.5).
    pub(crate) fn self_signing_base64(&self) -> Zeroizing<String> {
        Zeroizing::new(self.self_signing.to_base64())
    }

    /// Reconstruct from verified public cross-signing keys and a decrypted
    /// base64 self-signing secret (§4.5).
    pub(crate) fn from_parts(
        public: CrossSigningPublic,
        self_signing_b64: &str,
    ) -> Result<Self, Undecryptable> {
        let secret = Ed25519SecretKey::from_base64(self_signing_b64)
            .map_err(|_| Undecryptable::BadPlaintext)?;
        if secret.public_key() != public.self_signing {
            return Err(Undecryptable::BadPlaintext);
        }
        Ok(Self {
            public,
            self_signing: secret,
        })
    }

    /// Pickle for storage in SQLCipher (§6).
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn pickle(&self) -> Result<Zeroizing<String>, CryptoError> {
        to_pickle(&CrossSigningPickle {
            public: self.public.clone(),
            self_signing: Zeroizing::new(self.self_signing.to_base64()),
        })
    }

    /// Restore from [`CrossSigning::pickle`].
    ///
    /// # Errors
    /// [`CryptoError::Pickle`].
    pub fn from_pickle(pickle: &str) -> Result<Self, CryptoError> {
        let p: CrossSigningPickle = from_pickle(pickle)?;
        let secret =
            Ed25519SecretKey::from_base64(&p.self_signing).map_err(|_| CryptoError::Pickle {
                reason: "unreadable",
            })?;
        if secret.public_key() != p.public.self_signing {
            return Err(CryptoError::Pickle {
                reason: "unreadable",
            });
        }
        Ok(Self {
            public: p.public,
            self_signing: secret,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct CrossSigningPickle {
    public: CrossSigningPublic,
    self_signing: Zeroizing<String>,
}

/// The account's cross-signing secret packaged for Olm delivery to another
/// device of the same account.
pub struct SharedCrossSigningKey {
    public: CrossSigningPublic,
    self_signing_secret: Zeroizing<String>,
}

impl std::fmt::Debug for SharedCrossSigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedCrossSigningKey")
            .field("public", &self.public)
            .field("self_signing_secret", &"[redacted]")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedCrossSigningWire {
    public: CrossSigningPublic,
    self_signing_secret: Zeroizing<String>,
}

impl SharedCrossSigningKey {
    pub(crate) fn wire(&self) -> SharedCrossSigningWire {
        SharedCrossSigningWire {
            public: self.public.clone(),
            self_signing_secret: self.self_signing_secret.clone(),
        }
    }

    pub(crate) fn from_wire(wire: SharedCrossSigningWire) -> Self {
        Self {
            public: wire.public,
            self_signing_secret: wire.self_signing_secret,
        }
    }

    /// The public cross-signing keys.
    pub fn public(&self) -> &CrossSigningPublic {
        &self.public
    }
}

/// A [`SharedCrossSigningKey`] as it came out of Olm, bound to the device that
/// sent it. Only [`crate::OlmChannel::decrypt`] makes one.
#[derive(Debug)]
pub struct ReceivedCrossSigningKey {
    sender: DeviceKeys,
    key: SharedCrossSigningKey,
}

impl ReceivedCrossSigningKey {
    pub(crate) fn new(sender: DeviceKeys, key: SharedCrossSigningKey) -> Self {
        Self { sender, key }
    }

    /// The device that sent it.
    pub fn sender(&self) -> &DeviceKeys {
        &self.sender
    }

    /// The key.
    pub fn key(&self) -> &SharedCrossSigningKey {
        &self.key
    }
}

/// What a QR verification code carries (§1.1, §4.2): the account login,
/// device id, device Ed25519 key and account master Ed25519 key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrVerification {
    /// The account login.
    pub login: String,
    /// The device showing or scanning the code.
    pub device_id: String,
    /// That device's Ed25519 public key (unpadded base64).
    pub device_ed25519: String,
    /// That account's master Ed25519 public key (unpadded base64).
    pub master_key: String,
}

impl QrVerification {
    /// Build a QR payload for `device` under `cross`.
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] when `device` is not for `cross.login()`.
    pub fn new(device: &DeviceKeys, cross: &CrossSigningPublic) -> Result<Self, CryptoError> {
        if device.login() != cross.login() {
            return Err(CryptoError::UntrustedDevice);
        }
        Ok(Self {
            login: device.login().to_owned(),
            device_id: device.device_id().to_owned(),
            device_ed25519: device.ed25519(),
            master_key: cross.master_key(),
        })
    }

    /// Compact string representation (`tailchat-verify:v1:<login>:<device>:<dev_ed>:<master>`).
    pub fn encode(&self) -> String {
        format!(
            "{QR_PREFIX}{}:{}:{}:{}",
            self.login, self.device_id, self.device_ed25519, self.master_key
        )
    }

    /// Parse a compact string produced by [`QrVerification::encode`].
    ///
    /// # Errors
    /// [`CryptoError::InvalidQrCode`].
    pub fn decode(raw: &str) -> Result<Self, CryptoError> {
        let rest = raw
            .strip_prefix(QR_PREFIX)
            .ok_or(CryptoError::InvalidQrCode)?;
        let mut parts = rest.split(':');
        let (Some(login), Some(device_id), Some(device_ed), Some(master), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return Err(CryptoError::InvalidQrCode);
        };
        if login.is_empty() {
            return Err(CryptoError::InvalidQrCode);
        }
        check_device_id(device_id).map_err(|_| CryptoError::InvalidQrCode)?;
        parse_ed(device_ed).map_err(|_| CryptoError::InvalidQrCode)?;
        parse_ed(master).map_err(|_| CryptoError::InvalidQrCode)?;
        Ok(Self {
            login: login.to_owned(),
            device_id: device_id.to_owned(),
            device_ed25519: device_ed.to_owned(),
            master_key: master.to_owned(),
        })
    }

    /// Whether this QR code matches `cross` and `device` from `keys/query`.
    pub fn matches(&self, cross: &CrossSigningPublic, device: &DeviceKeys) -> bool {
        self.login == cross.login()
            && self.login == device.login()
            && self.device_id == device.device_id()
            && self.device_ed25519 == device.ed25519()
            && self.master_key == cross.master_key()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_signs_self_signing_and_self_signing_verifies_devices() {
        let cross = CrossSigning::new("alice").unwrap();
        let account = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let unsigned =
            DeviceKeys::from_json(&account.upload_body().unwrap()["deviceKeys"]).unwrap();
        assert!(!cross.verifies(&unsigned), "not cross-signed yet");

        let signed = cross.sign_device(&unsigned).unwrap();
        assert_eq!(signed, unsigned, "same device identity");
        assert!(!signed.has_same_signatures(&unsigned));
        assert!(cross.verifies(&signed));

        let wire = cross.upload_json();
        let parsed = CrossSigningPublic::from_json("alice", &wire)
            .unwrap()
            .unwrap();
        assert_eq!(parsed, *cross.public());
        assert!(parsed.verifies(&signed));
        assert!(
            CrossSigningPublic::from_json("bob", &wire).is_err(),
            "cannot be filed under another login"
        );
    }

    #[test]
    fn a_peer_attestation_holds_only_for_its_own_account_and_self_signing_key() {
        let alice = CrossSigning::new("alice").unwrap();
        let bob = CrossSigning::new("bob").unwrap();
        let bob_master = bob.master_key();
        let statement = alice.attest_peer("bob", &bob_master).unwrap();
        assert_eq!(
            alice.public().attested_peer(&statement),
            Some(AttestedPeer {
                peer: "bob".into(),
                master_key: bob_master.clone(),
            })
        );
        // Through the wire form, as another device of alice reads it.
        let read = CrossSigningPublic::from_json("alice", &alice.upload_json())
            .unwrap()
            .unwrap();
        assert!(read.attested_peer(&statement).is_some());

        // Another account's statement says nothing about alice's trust.
        assert_eq!(bob.public().attested_peer(&statement), None);
        // After alice resets her keys, what the old key signed is void.
        let reset = CrossSigning::new("alice").unwrap();
        assert_eq!(reset.public().attested_peer(&statement), None);

        // Any edit breaks the signature: the peer, the key, the usage.
        for (field, value) in [
            ("peer", json!("carol")),
            ("key", json!(CrossSigning::new("bob").unwrap().master_key())),
            ("usage", json!("self_signing")),
        ] {
            let mut forged = statement.clone();
            forged[field] = value;
            assert_eq!(alice.public().attested_peer(&forged), None, "{field}");
        }
        // A device object signed by the same key is not a statement about anyone.
        let account = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let device = DeviceKeys::from_json(&account.upload_body().unwrap()["deviceKeys"]).unwrap();
        let signed = alice.sign_device(&device).unwrap().to_signed_json();
        assert_eq!(alice.public().attested_peer(&signed), None);

        // Nobody attests themselves, and the key must be a key.
        assert!(alice.attest_peer("alice", &alice.master_key()).is_err());
        assert!(alice.attest_peer("", &bob_master).is_err());
        assert!(alice.attest_peer("bob", "not a key").is_err());
    }

    #[test]
    fn qr_verification_round_trips_and_checks_keys() {
        let cross = CrossSigning::new("alice").unwrap();
        let account = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let device = cross.sign_device(&account.identity()).unwrap();
        let qr = QrVerification::new(&device, cross.public()).unwrap();
        let decoded = QrVerification::decode(&qr.encode()).unwrap();
        assert_eq!(decoded, qr);
        assert!(decoded.matches(cross.public(), &device));

        let other_cross = CrossSigning::new("alice").unwrap();
        assert!(!decoded.matches(other_cross.public(), &device));
    }
}
