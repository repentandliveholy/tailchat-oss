//! This device's Olm account: identity keys, one-time and fallback keys.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use vodozemac::olm;
use zeroize::Zeroizing;

use crate::canonical::{device_key_id, sign_object};
use crate::device::check_device_id;
use crate::pickle::{from_pickle, to_pickle};
use crate::{CrossSigning, CryptoError, DeviceKeys, DeviceKind};

/// This device: who it is (`login`, `deviceId` the server issued, kind) and
/// its Olm account. The secret keys never leave it except in [`pickle`].
///
/// [`pickle`]: Account::pickle
pub struct Account {
    inner: olm::Account,
    login: String,
    device_id: String,
    kind: DeviceKind,
    cross: CrossSigning,
    cross_published: bool,
}

impl std::fmt::Debug for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Account")
            .field("login", &self.login)
            .field("device_id", &self.device_id)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl Account {
    /// New identity keys for `login`'s device `device_id` (from the first
    /// `keys/upload`). Randomness comes from the OS, inside vodozemac (§6).
    ///
    /// # Errors
    /// [`CryptoError::InvalidDeviceId`].
    pub fn new(login: &str, device_id: &str, kind: DeviceKind) -> Result<Self, CryptoError> {
        check_device_id(device_id)?;
        let cross = CrossSigning::new(login)?;
        Ok(Self {
            inner: olm::Account::new(),
            login: login.to_owned(),
            device_id: device_id.to_owned(),
            kind,
            cross,
            cross_published: false,
        })
    }

    /// The account's login.
    pub fn login(&self) -> &str {
        &self.login
    }

    /// The device id.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// This device's cross-signing identity (master key and self-signing key).
    pub fn cross_signing(&self) -> &CrossSigning {
        &self.cross
    }

    /// Replace this device's cross-signing keys with the account's established
    /// ones (received over Olm after SAS/QR verification, §4.2).
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] if `cross` belongs to another login.
    pub fn set_cross_signing(&mut self, cross: CrossSigning) -> Result<(), CryptoError> {
        if cross.login() != self.login {
            return Err(CryptoError::UntrustedDevice);
        }
        self.cross = cross;
        self.cross_published = true;
        Ok(())
    }

    /// This device as others see it, signed by the device and by its
    /// self-signing key.
    pub fn identity(&self) -> DeviceKeys {
        let keys = self.inner.identity_keys();
        let mut device = DeviceKeys::new(
            &self.login,
            &self.device_id,
            self.kind,
            keys.curve25519,
            keys.ed25519,
        );
        let mut object = device.to_unsigned_json();
        if self.sign(&mut object).is_ok()
            && self.cross.sign_device_object(&mut object).is_ok()
            && let Ok(signed) = DeviceKeys::from_json(&Value::Object(object))
        {
            device = signed;
        }
        device
    }
    /// Create up to `count` one-time keys, never more than the server keeps
    /// for a device (`E2EE_OTK_LIMIT`, 50).
    pub fn generate_one_time_keys(&mut self, count: usize) {
        let count = count.min(self.inner.max_number_of_one_time_keys());
        let _ = self.inner.generate_one_time_keys(count);
    }

    /// Replace the fallback key; the previous one stays usable until
    /// [`Account::forget_fallback_key`].
    pub fn generate_fallback_key(&mut self) {
        let _ = self.inner.generate_fallback_key();
    }

    /// Drop the fallback key before the current one.
    pub fn forget_fallback_key(&mut self) {
        let _ = self.inner.forget_fallback_key();
    }

    /// The body of `POST /api/e2ee/keys/upload` (§8.1): signed `deviceKeys`,
    /// the unpublished one-time keys and fallback key, each signed by this
    /// device. Call [`Account::mark_keys_as_published`] once the server has
    /// answered, and persist the account then.
    ///
    /// # Errors
    /// Only if signing produced a value canonical JSON refuses, which the
    /// shapes here never do.
    pub fn upload_body(&self) -> Result<Value, CryptoError> {
        self.upload_body_with(Some(&self.cross), !self.cross_published)
    }

    /// Like [`Account::upload_body`], also signing `deviceKeys` with `cross`
    /// (when given) and including `crossSigning` (when `include_cross` is true).
    ///
    /// # Errors
    /// [`CryptoError::UntrustedDevice`] if `cross` is for another account.
    pub fn upload_body_with(
        &self,
        cross: Option<&CrossSigning>,
        include_cross: bool,
    ) -> Result<Value, CryptoError> {
        let mut body = Map::new();
        let mut device = self.identity().to_unsigned_json();
        self.sign(&mut device)?;
        if let Some(cross) = cross {
            cross.sign_device_object(&mut device)?;
            if include_cross {
                body.insert("crossSigning".into(), cross.upload_json());
            }
        }
        body.insert("deviceKeys".into(), Value::Object(device));
        let mut one_time = Map::new();
        for (id, key) in self.inner.one_time_keys() {
            one_time.insert(id.to_base64(), self.signed_key(key, false)?);
        }
        body.insert("oneTimeKeys".into(), Value::Object(one_time));

        if let Some((id, key)) = self.inner.fallback_key().into_iter().next() {
            let mut fallback = Map::new();
            fallback.insert(id.to_base64(), self.signed_key(key, true)?);
            body.insert("fallbackKey".into(), Value::Object(fallback));
        }
        Ok(Value::Object(body))
    }

    /// The server took the keys of [`Account::upload_body`].
    pub fn mark_keys_as_published(&mut self) {
        self.inner.mark_keys_as_published();
        self.cross_published = true;
    }

    fn signed_key(
        &self,
        key: vodozemac::Curve25519PublicKey,
        fallback: bool,
    ) -> Result<Value, CryptoError> {
        let mut object = Map::new();
        object.insert("key".into(), Value::String(key.to_base64()));
        if fallback {
            object.insert("fallback".into(), Value::Bool(true));
        }
        self.sign(&mut object)?;
        Ok(Value::Object(object))
    }

    fn sign(&self, object: &mut Map<String, Value>) -> Result<(), CryptoError> {
        sign_object(object, &self.login, &device_key_id(&self.device_id), |m| {
            self.inner.sign(m)
        })
    }

    pub(crate) fn olm(&self) -> &olm::Account {
        &self.inner
    }

    pub(crate) fn olm_mut(&mut self) -> &mut olm::Account {
        &mut self.inner
    }

    /// The account with its secret keys, for storage (SQLCipher, §6).
    ///
    /// # Errors
    /// [`CryptoError::Pickle`] if serialisation fails.
    pub fn pickle(&self) -> Result<Zeroizing<String>, CryptoError> {
        let cross = self.cross.pickle()?;
        to_pickle(&AccountPickle {
            login: self.login.clone(),
            device_id: self.device_id.clone(),
            kind: self.kind,
            account: self.inner.pickle(),
            cross: Some((*cross).clone()),
            cross_published: self.cross_published,
        })
    }

    /// Restore from [`Account::pickle`].
    ///
    /// # Errors
    /// [`CryptoError::Pickle`] for anything that is not such a pickle.
    pub fn from_pickle(pickle: &str) -> Result<Self, CryptoError> {
        let p: AccountPickle = from_pickle(pickle)?;
        check_device_id(&p.device_id)?;
        let cross = match p.cross {
            Some(raw) => CrossSigning::from_pickle(&raw)?,
            None => CrossSigning::new(&p.login).map_err(|_| CryptoError::Pickle {
                reason: "unreadable",
            })?,
        };
        Ok(Self {
            inner: olm::Account::from_pickle(p.account),
            login: p.login,
            device_id: p.device_id,
            kind: p.kind,
            cross,
            cross_published: p.cross_published,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct AccountPickle {
    login: String,
    device_id: String,
    kind: DeviceKind,
    account: olm::AccountPickle,
    #[serde(default)]
    cross: Option<String>,
    #[serde(default)]
    cross_published: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_body_is_what_the_server_and_peers_accept() {
        let mut account = Account::new("alice", "AAAAAAAAAAAAAAAA", DeviceKind::Client).unwrap();
        account.generate_one_time_keys(80);
        account.generate_fallback_key();
        let body = account.upload_body().unwrap();

        let device = DeviceKeys::from_json(&body["deviceKeys"]).unwrap();
        assert_eq!(device, account.identity());
        let one_time = body["oneTimeKeys"].as_object().unwrap();
        assert_eq!(one_time.len(), 50, "capped at the server's limit");
        for key in one_time.values() {
            device.verify_signed_key(key).unwrap();
        }
        let fallback = body["fallbackKey"].as_object().unwrap();
        assert_eq!(fallback.len(), 1);
        let fallback = fallback.values().next().unwrap();
        assert_eq!(fallback["fallback"], true);
        device.verify_signed_key(fallback).unwrap();

        account.mark_keys_as_published();
        let again = account.upload_body().unwrap();
        assert!(again["oneTimeKeys"].as_object().unwrap().is_empty());
        assert!(again.get("fallbackKey").is_none());
    }

    #[test]
    fn pickle_keeps_identity_and_hides_it_from_debug() {
        let account = Account::new("alice", "AAAAAAAAAAAAAAAA", DeviceKind::Assistant).unwrap();
        let restored = Account::from_pickle(&account.pickle().unwrap()).unwrap();
        assert_eq!(restored.identity(), account.identity());
        let debug = format!("{account:?}");
        assert!(!debug.contains(&account.identity().curve25519()));
        assert!(Account::from_pickle("{}").is_err());
    }
}
