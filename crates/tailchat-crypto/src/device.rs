//! A device as it describes itself: `deviceKeys` of `keys/upload` and
//! `keys/query` (`docs/specs/2026-11-04-e2ee.md` §8.1).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey};

use crate::CryptoError;
use crate::canonical::{device_key_id, verify_object};

/// What a device is for (§4.1). Signed with its keys, so the server cannot
/// relabel it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    /// A person's client.
    Client,
    /// The Tailik device: receives no conversation keys unless enabled there.
    Assistant,
}

impl DeviceKind {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Client => "client",
            Self::Assistant => "assistant",
        }
    }
}

/// A device id as the server issues it: 16 base64url characters.
pub(crate) fn check_device_id(id: &str) -> Result<(), CryptoError> {
    let valid = id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(CryptoError::InvalidDeviceId)
    }
}

/// One device's public identity, checked: the self-signature verified, the
/// keys parsed. The login is the one the device signed; the core compares it
/// with the account the server filed it under.
///
/// Equality compares the device's identity (`login`, `device_id`, `kind`,
/// `curve25519`, `ed25519`); extra signatures (cross-signing) are checked with
/// [`DeviceKeys::is_signed_by`].
#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "DeviceKeysRaw", into = "DeviceKeysRaw")]
pub struct DeviceKeys {
    login: String,
    device_id: String,
    kind: DeviceKind,
    curve25519: Curve25519PublicKey,
    ed25519: Ed25519PublicKey,
    signatures: BTreeMap<String, String>,
}

impl PartialEq for DeviceKeys {
    fn eq(&self, other: &Self) -> bool {
        self.login == other.login
            && self.device_id == other.device_id
            && self.kind == other.kind
            && self.curve25519 == other.curve25519
            && self.ed25519 == other.ed25519
    }
}

impl Eq for DeviceKeys {}

impl std::fmt::Debug for DeviceKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKeys")
            .field("login", &self.login)
            .field("device_id", &self.device_id)
            .field("kind", &self.kind)
            .field("ed25519", &self.ed25519.to_base64())
            .finish_non_exhaustive()
    }
}

impl DeviceKeys {
    pub(crate) fn new(
        login: &str,
        device_id: &str,
        kind: DeviceKind,
        curve25519: Curve25519PublicKey,
        ed25519: Ed25519PublicKey,
    ) -> Self {
        Self {
            login: login.to_owned(),
            device_id: device_id.to_owned(),
            kind,
            curve25519,
            ed25519,
            signatures: BTreeMap::new(),
        }
    }

    /// Parse signed device keys and verify the device's own signature.
    ///
    /// # Errors
    /// [`CryptoError::InvalidDeviceKeys`] for the wrong shape,
    /// [`CryptoError::InvalidKey`] for a key that is not canonical base64 of
    /// 32 bytes, [`CryptoError::BadSignature`] when the self-signature is
    /// missing or does not verify.
    pub fn from_json(value: &Value) -> Result<Self, CryptoError> {
        let object = value.as_object().ok_or(CryptoError::InvalidDeviceKeys {
            reason: "not an object",
        })?;
        let text = |field: &'static str| {
            object
                .get(field)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(CryptoError::InvalidDeviceKeys { reason: field })
        };
        let login = text("login")?;
        let device_id = text("deviceId")?;
        check_device_id(device_id)?;
        let kind = serde_json::from_value::<DeviceKind>(
            object.get("kind").cloned().unwrap_or(Value::Null),
        )
        .map_err(|_| CryptoError::InvalidDeviceKeys { reason: "kind" })?;
        let keys = object
            .get("keys")
            .and_then(Value::as_object)
            .ok_or(CryptoError::InvalidDeviceKeys { reason: "keys" })?;
        let key_text = |field: &'static str| {
            keys.get(field)
                .and_then(Value::as_str)
                .ok_or(CryptoError::InvalidKey { what: field })
        };
        let curve25519 = parse_curve(key_text("curve25519")?)?;
        let ed25519 = parse_ed(key_text("ed25519")?)?;
        verify_object(object, login, &device_key_id(device_id), &ed25519)?;
        let mut signatures = BTreeMap::new();
        if let Some(by_login) = object
            .get("signatures")
            .and_then(|s| s.get(login))
            .and_then(Value::as_object)
        {
            for (k, v) in by_login {
                if let Some(sig) = v.as_str() {
                    signatures.insert(k.clone(), sig.to_owned());
                }
            }
        }
        let mut out = Self::new(login, device_id, kind, curve25519, ed25519);
        out.signatures = signatures;
        Ok(out)
    }

    /// The login the device signed.
    pub fn login(&self) -> &str {
        &self.login
    }

    /// The device id the device signed.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// What the device is for.
    pub fn kind(&self) -> DeviceKind {
        self.kind
    }

    /// Its Curve25519 identity key, unpadded base64.
    pub fn curve25519(&self) -> String {
        self.curve25519.to_base64()
    }

    /// Its Ed25519 signing key, unpadded base64.
    pub fn ed25519(&self) -> String {
        self.ed25519.to_base64()
    }

    pub(crate) fn curve25519_key(&self) -> Curve25519PublicKey {
        self.curve25519
    }

    /// The unsigned statement, as the device signs it.
    pub(crate) fn to_unsigned_json(&self) -> Map<String, Value> {
        let mut keys = Map::new();
        keys.insert("curve25519".into(), Value::String(self.curve25519()));
        keys.insert("ed25519".into(), Value::String(self.ed25519()));
        let mut object = Map::new();
        object.insert("login".into(), Value::String(self.login.clone()));
        object.insert("deviceId".into(), Value::String(self.device_id.clone()));
        object.insert("kind".into(), Value::String(self.kind.as_str().into()));
        object.insert("keys".into(), Value::Object(keys));
        object
    }

    /// Whether `key` (signing under `ed25519:<key_id>`) signed this device's
    /// statement under its own `login`.
    pub fn is_signed_by(&self, key_id: &str, key: &Ed25519PublicKey) -> bool {
        let mut object = self.to_unsigned_json();
        let mut by_login = Map::new();
        for (k, v) in &self.signatures {
            by_login.insert(k.clone(), Value::String(v.clone()));
        }
        let mut sigs = Map::new();
        sigs.insert(self.login.clone(), Value::Object(by_login));
        object.insert("signatures".into(), Value::Object(sigs));
        verify_object(&object, &self.login, &device_key_id(key_id), key).is_ok()
    }

    /// Whether `other` carries the exact same set of signatures as `self`.
    pub fn has_same_signatures(&self, other: &Self) -> bool {
        self.signatures == other.signatures
    }

    /// The signed JSON object for `keys/upload`, with every signature this
    /// `DeviceKeys` currently holds.
    pub fn to_signed_json(&self) -> Value {
        let mut object = self.to_unsigned_json();
        if !self.signatures.is_empty() {
            let mut by_login = Map::new();
            for (k, v) in &self.signatures {
                by_login.insert(k.clone(), Value::String(v.clone()));
            }
            let mut sigs = Map::new();
            sigs.insert(self.login.clone(), Value::Object(by_login));
            object.insert("signatures".into(), Value::Object(sigs));
        }
        Value::Object(object)
    }

    /// Verify a key this device signed (a one-time or fallback key from
    /// `keys/claim`) and return it.
    pub(crate) fn verify_signed_key(
        &self,
        value: &Value,
    ) -> Result<Curve25519PublicKey, CryptoError> {
        let object = value
            .as_object()
            .ok_or(CryptoError::InvalidKey { what: "one-time" })?;
        let key = object
            .get("key")
            .and_then(Value::as_str)
            .ok_or(CryptoError::InvalidKey { what: "one-time" })?;
        let key = parse_curve(key)?;
        verify_object(
            object,
            &self.login,
            &device_key_id(&self.device_id),
            &self.ed25519,
        )?;
        Ok(key)
    }
}

/// A key only in its one spelling, so that one key cannot pass for two.
pub(crate) fn parse_curve(text: &str) -> Result<Curve25519PublicKey, CryptoError> {
    Curve25519PublicKey::from_base64(text)
        .ok()
        .filter(|k| k.to_base64() == text)
        .ok_or(CryptoError::InvalidKey { what: "curve25519" })
}

pub(crate) fn parse_ed(text: &str) -> Result<Ed25519PublicKey, CryptoError> {
    Ed25519PublicKey::from_base64(text)
        .ok()
        .filter(|k| k.to_base64() == text)
        .ok_or(CryptoError::InvalidKey { what: "ed25519" })
}

/// The stored form: keys as base64, parsed back on load.
#[derive(Serialize, Deserialize)]
struct DeviceKeysRaw {
    login: String,
    device_id: String,
    kind: DeviceKind,
    curve25519: String,
    ed25519: String,
    #[serde(default)]
    signatures: BTreeMap<String, String>,
}

impl From<DeviceKeys> for DeviceKeysRaw {
    fn from(d: DeviceKeys) -> Self {
        Self {
            curve25519: d.curve25519(),
            ed25519: d.ed25519(),
            login: d.login,
            device_id: d.device_id,
            kind: d.kind,
            signatures: d.signatures,
        }
    }
}

impl TryFrom<DeviceKeysRaw> for DeviceKeys {
    type Error = CryptoError;

    fn try_from(raw: DeviceKeysRaw) -> Result<Self, Self::Error> {
        check_device_id(&raw.device_id)?;
        let mut out = Self::new(
            &raw.login,
            &raw.device_id,
            raw.kind,
            parse_curve(&raw.curve25519)?,
            parse_ed(&raw.ed25519)?,
        );
        out.signatures = raw.signatures;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector() -> Value {
        let v: Value =
            serde_json::from_str(include_str!("../tests/fixtures/signing-vectors.json")).unwrap();
        v["deviceKeys"]["value"].clone()
    }

    #[test]
    fn reads_the_javascript_signed_vector() {
        let device = DeviceKeys::from_json(&vector()).unwrap();
        assert_eq!(device.login(), "alice");
        assert_eq!(device.device_id(), "AAAAAAAAAAAAAAAA");
        assert_eq!(device.kind(), DeviceKind::Client);
        assert_eq!(
            device.ed25519(),
            "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
        );
    }

    #[test]
    fn refuses_what_the_server_could_rewrite() {
        let refused = |edit: &dyn Fn(&mut Value)| {
            let mut v = vector();
            edit(&mut v);
            DeviceKeys::from_json(&v).unwrap_err()
        };
        // Filed under another account, relabelled, keys swapped: the
        // signature no longer covers it.
        assert_eq!(
            refused(&|v| v["kind"] = "assistant".into()),
            CryptoError::BadSignature
        );
        assert_eq!(
            refused(
                &|v| v["keys"]["curve25519"] = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj4".into()
            ),
            CryptoError::BadSignature
        );
        assert_eq!(
            refused(&|v| v["login"] = "mallory".into()),
            CryptoError::BadSignature
        );
        assert_eq!(
            refused(&|v| {
                v["signatures"].as_object_mut().unwrap().remove("alice");
            }),
            CryptoError::BadSignature
        );
        assert_eq!(
            refused(&|v| v["deviceId"] = "short".into()),
            CryptoError::InvalidDeviceId
        );
        assert_eq!(
            refused(&|v| v["kind"] = "server".into()),
            CryptoError::InvalidDeviceKeys { reason: "kind" }
        );
        // The same key in a padded spelling is not accepted as the same key.
        assert_eq!(
            refused(
                &|v| v["keys"]["ed25519"] = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=".into()
            ),
            CryptoError::InvalidKey { what: "ed25519" }
        );
    }

    #[test]
    fn stored_form_round_trips() {
        let device = DeviceKeys::from_json(&vector()).unwrap();
        let stored = serde_json::to_string(&device).unwrap();
        assert_eq!(serde_json::from_str::<DeviceKeys>(&stored).unwrap(), device);
    }
}
