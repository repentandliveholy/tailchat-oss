//! End-to-end encryption, the decisions (spec E2EE §4.1, §6): this device
//! gets a device id from the server, makes its Olm account, publishes its
//! keys and keeps enough one-time keys on the server.
//!
//! Persist before the wire holds for keys too: the account is on disk before
//! the request that publishes its keys, so a crash can never leave the server
//! holding a one-time key whose secret half this device lost.

use serde_json::Value;
use tailchat_crypto::{Account, CrossSigning, DeviceKind, InboundGroup, QrVerification};

use crate::api::{ApiCall, ApiRequest, Event, FetchError, Output, Refusal, StoreOp};
use crate::e2ee::{OTK_LOW, OTK_TARGET, PendingReset, Upload};
use crate::frames::{self, e2ee::UploadAnswer};
use crate::ids::Ts;
use crate::login::Login;
use crate::platform::Secret;

use super::Core;

impl Core {
    /// Turns end-to-end encryption on or off for later connections. Off (the
    /// default), the core behaves exactly as before stage 6.
    pub fn set_e2ee(&mut self, enabled: bool) {
        self.e2ee.enabled = enabled;
        self.sync.sealed = enabled;
    }

    /// The id the server gave this device, once it has one.
    pub fn device_id(&self) -> Option<&str> {
        self.e2ee.account.as_ref().map(Account::device_id)
    }

    /// Compact QR verification string (`tailchat-verify:v1:...`) for this
    /// device and its cross-signing master key, once registered.
    pub fn qr_verification(&self) -> Option<String> {
        let account = self.e2ee.account.as_ref()?;
        QrVerification::new(&account.identity(), account.cross_signing().public())
            .ok()
            .map(|q| q.encode())
    }

    /// Whether the inbound session `(sender, device, session)` came from a
    /// direct `SessionKey` (`Some(true)`) rather than a forwarded/backup
    /// `ExportedSessionKey` (`Some(false)`, spec E2EE §4.2).
    pub fn is_session_verified(&self, sender: &Login, device: &str, session: &str) -> Option<bool> {
        self.e2ee
            .inbound
            .get(&(sender.clone(), device.to_owned(), session.to_owned()))
            .map(InboundGroup::is_sender_verified)
    }

    /// The backup version active on this device, once a backup key is held.
    pub fn backup_version(&self) -> Option<u64> {
        self.e2ee
            .backup_key
            .as_ref()
            .map(tailchat_crypto::BackupKey::version)
    }

    /// The Argon2id salt of the server's passphrase slot, once backup metadata
    /// has been fetched.
    pub fn backup_passphrase_salt(&self) -> Option<&str> {
        self.e2ee
            .remote_backup
            .as_ref()
            .and_then(|b| b.passphrase.as_ref())
            .map(|p| p.salt.as_str())
    }
    /// The capabilities `auth` declares beyond the built-in ones.
    pub(super) fn auth_caps(&self) -> Vec<String> {
        let mut caps = self.extra_caps.clone();
        if self.e2ee.enabled {
            caps.push(frames::e2ee::E2EE_CAP.to_owned());
        }
        caps
    }

    /// A new authenticated socket: register (again) if the server can.
    pub(super) fn e2ee_connected(&mut self, available: bool) -> Vec<Output> {
        self.e2ee.connected(available);
        if self.e2ee.reset.is_some() {
            // The account's own keys settle a reset whose answer was lost.
            self.e2ee.wanted.insert(self.me.clone());
        }
        let mut out = self.tell_broken();
        if self.e2ee.enabled {
            // A conversation encrypted in an earlier run is still one: its
            // next row is sealed or held, never sent open. Without this the
            // state was first told at the next send, and a client drew an
            // open lock on every encrypted conversation until then.
            let untold: Vec<Login> = self
                .e2ee
                .encrypted
                .iter()
                .filter(|peer| !self.e2ee.told_state.contains_key(*peer))
                .cloned()
                .collect();
            for peer in untold {
                out.extend(self.tell_state(&peer, true));
            }
        }
        if self.e2ee.active() {
            out.extend(self.post_upload());
        }
        out
    }

    /// `EncryptionFailed`, once per broken state, only to a core that is on.
    fn tell_broken(&mut self) -> Vec<Output> {
        match &mut self.e2ee.broken {
            Some(broken) if self.e2ee.enabled && !broken.told => {
                broken.told = true;
                vec![Output::Event(Event::EncryptionFailed {
                    reason: broken.reason.clone(),
                })]
            }
            _ => Vec::new(),
        }
    }

    /// Stops encryption on this device and says why.
    fn e2ee_fail(&mut self, reason: &str) -> Vec<Output> {
        self.e2ee.break_with(reason);
        self.tell_broken()
    }

    /// `keys/upload`: an empty body asks for a device id; with an account,
    /// its signed keys and whatever one-time keys are not published yet.
    pub(super) fn post_upload(&mut self) -> Vec<Output> {
        let body = match &self.e2ee.account {
            None => "{}".to_owned(),
            Some(account) => match account.upload_body() {
                Ok(mut body) => {
                    // Beside `deviceKeys`, never inside it: the name and the
                    // capabilities are not signed, and the server stores them
                    // with the device. Every connection says them again, so
                    // a device that was registered by an older build is
                    // announced as soon as it runs this one.
                    if let Some(map) = body.as_object_mut() {
                        if !self.device_name.is_empty() {
                            map.insert("name".into(), self.device_name.clone().into());
                        }
                        map.insert("caps".into(), device_caps());
                    }
                    body.to_string()
                }
                Err(error) => return self.e2ee_fail(&format!("cannot sign keys: {error}")),
            },
        };
        let request = ApiRequest {
            serial: self.e2ee.next_serial(),
            call: ApiCall::KeysUpload,
            body,
        };
        self.e2ee.upload = Some(Upload {
            request: request.clone(),
        });
        vec![Output::Post(request)]
    }

    /// A paused key request whose time has come.
    pub(super) fn e2ee_drain(&mut self, now: Ts) -> Vec<Output> {
        if !self.e2ee.active() {
            return Vec::new();
        }
        if self.e2ee.retry_at.is_none_or(|at| now < at) {
            return Vec::new();
        }
        self.e2ee.retry_at = None;
        if !self.e2ee.registered && self.e2ee.upload.is_none() {
            self.post_upload()
        } else {
            self.seal_due(now)
        }
    }

    /// The account as an op, or why it could not be written.
    fn account_op(&mut self) -> Result<StoreOp, Vec<Output>> {
        let pickled = self.e2ee.account.as_ref().map(Account::pickle);
        match pickled {
            Some(Ok(pickle)) => Ok(StoreOp::PutCryptoAccount(Secret::new(pickle))),
            Some(Err(error)) => Err(self.e2ee_fail(&format!("cannot store keys: {error}"))),
            None => Err(Vec::new()),
        }
    }

    /// The body of a `200` to one of our posts. An answer to a request that
    /// is not in flight any more is ignored.
    pub(super) fn on_posted(&mut self, now: Ts, request: &ApiRequest, body: &str) -> Vec<Output> {
        match request.call {
            ApiCall::KeysUpload => {
                if self
                    .e2ee
                    .upload
                    .take_if(|upload| &upload.request == request)
                    .is_none()
                {
                    return Vec::new();
                }
                let reset = self.e2ee.reset.take_if(|reset| &reset.request == request);
                match frames::e2ee::decode_upload(body) {
                    Ok(answer) => {
                        self.e2ee.succeeded();
                        // A 200 to a reset is the server holding the new keys:
                        // they go into the account before `uploaded` stores it.
                        let mut out = match reset {
                            Some(reset) => self.apply_reset(reset.cross),
                            None => Vec::new(),
                        };
                        let was_registered = self.e2ee.registered;
                        out.extend(self.uploaded(answer));
                        if self.e2ee.registered && !was_registered {
                            // Whom this account vouches for, and its own
                            // devices, from the moment this one can read.
                            self.e2ee.wanted.insert(self.me.clone());
                            out.extend(self.post_query(now));
                        }
                        out
                    }
                    Err(error) => {
                        self.e2ee.failed(now);
                        vec![Output::Event(Event::BadFrame {
                            reason: format!("keys/upload: {error}"),
                        })]
                    }
                }
            }
            ApiCall::KeysQuery => self.queried(now, request, body),
            ApiCall::KeysClaim => self.claimed(now, request, body),
            ApiCall::Backup => self.backup_posted(now, request, body),
            ApiCall::Trust => self.trust_posted(request),
        }
    }

    /// What one `keys/upload` answer means for this device.
    fn uploaded(&mut self, answer: UploadAnswer) -> Vec<Output> {
        let Some(account) = &mut self.e2ee.account else {
            // The first answer of a session names the device id to sign.
            let mut account =
                match Account::new(self.me.as_str(), &answer.device_id, DeviceKind::Client) {
                    Ok(account) => account,
                    Err(error) => return self.e2ee_fail(&format!("server device id: {error}")),
                };
            account.generate_one_time_keys(OTK_TARGET);
            account.generate_fallback_key();
            self.e2ee.account = Some(account);
            let op = match self.account_op() {
                Ok(op) => op,
                Err(out) => return out,
            };
            let mut out = vec![Output::Persist(vec![op])];
            out.extend(self.post_upload());
            return out;
        };
        if answer.device_id != account.device_id() {
            return self.e2ee_fail("the server bound this session to another device");
        }
        if !answer.registered {
            return self.e2ee_fail("the server did not register this device's keys");
        }
        // No key was made since the request: what it carried is published.
        account.mark_keys_as_published();
        let mut more = false;
        if answer.one_time_key_count < OTK_LOW {
            account.generate_one_time_keys(OTK_TARGET.saturating_sub(answer.one_time_key_count));
            more = true;
        }
        if !answer.fallback_key {
            account.generate_fallback_key();
            more = true;
        }
        let device_id = account.device_id().to_owned();
        let op = match self.account_op() {
            Ok(op) => op,
            Err(out) => return out,
        };
        let mut out = vec![Output::Persist(vec![op])];
        if more {
            out.extend(self.post_upload());
        } else {
            self.e2ee.registered = true;
            out.push(Output::Event(Event::DeviceRegistered { device_id }));
            // Key messages that came before the account was ready.
            out.extend(self.process_inbox());
        }
        out
    }

    /// A post that produced no page.
    pub(super) fn on_post_failed(
        &mut self,
        now: Ts,
        request: &ApiRequest,
        error: FetchError,
    ) -> Vec<Output> {
        match request.call {
            ApiCall::KeysUpload => {
                if self
                    .e2ee
                    .upload
                    .take_if(|upload| &upload.request == request)
                    .is_none()
                {
                    return Vec::new();
                }
                if let Some(reset) = self.e2ee.reset.take_if(|reset| &reset.request == request) {
                    return self.reset_failed(now, reset, error);
                }
                match error {
                    FetchError::Status(401, _) => {
                        self.e2ee.refused = true;
                        Vec::new()
                    }
                    // This store is not the one that registered the session's
                    // device id: the person has to sign in again, and saying
                    // "keys/upload refused (409)" would not tell them so.
                    FetchError::Status(409, Some(Refusal::DeviceKeysChanged)) => {
                        self.e2ee.break_with("device_keys_changed");
                        if let Some(broken) = self.e2ee.broken.as_mut() {
                            broken.told = true;
                        }
                        vec![Output::Event(Event::DeviceKeysConflict)]
                    }
                    // `device_limit`, `invalid_*`: asking again cannot help.
                    FetchError::Status(status @ (400 | 409), _) => {
                        self.e2ee_fail(&format!("keys/upload refused ({status})"))
                    }
                    _ => {
                        self.e2ee.failed(now);
                        Vec::new()
                    }
                }
            }
            ApiCall::KeysQuery | ApiCall::KeysClaim | ApiCall::Backup | ApiCall::Trust => {
                self.key_request_failed(now, request, error);
                Vec::new()
            }
        }
    }

    /// `Action::ResetCrossSigning`: new account keys, made here, published in
    /// one `keys/upload` that also carries this device signed by them and the
    /// password the server checks. Nothing local changes until the server
    /// answers: a refused reset leaves the old keys exactly in force.
    pub(super) fn reset_cross_signing(&mut self, password: &Secret) -> Vec<Output> {
        let failed = |reason: &str| {
            vec![Output::Event(Event::CrossSigningResetFailed {
                reason: reason.to_owned(),
            })]
        };
        if !self.e2ee.active() || !self.e2ee.registered {
            return failed("not_ready");
        }
        if self.e2ee.upload.is_some() || self.e2ee.reset.is_some() {
            return failed("busy");
        }
        let Some(account) = self.e2ee.account.as_ref() else {
            return failed("not_ready");
        };
        let Ok(cross) = CrossSigning::new(self.me.as_str()) else {
            return failed("refused");
        };
        let Ok(Value::Object(mut body)) = account.upload_body_with(Some(&cross), true) else {
            return failed("refused");
        };
        body.insert("caps".into(), device_caps());
        body.insert("replaceCrossSigning".into(), Value::Bool(true));
        body.insert(
            "password".into(),
            Value::String(password.expose().to_owned()),
        );
        let request = ApiRequest {
            serial: self.e2ee.next_serial(),
            call: ApiCall::KeysUpload,
            body: Value::Object(body).to_string(),
        };
        self.e2ee.upload = Some(Upload {
            request: request.clone(),
        });
        self.e2ee.reset = Some(PendingReset {
            request: request.clone(),
            cross,
            in_doubt: false,
        });
        vec![Output::Post(request)]
    }

    /// The server holds `cross` as this account's keys: this device takes
    /// them, and what it knew about its own account is asked again.
    fn apply_reset(&mut self, cross: CrossSigning) -> Vec<Output> {
        let Some(account) = self.e2ee.account.as_mut() else {
            return Vec::new();
        };
        if account.set_cross_signing(cross).is_err() {
            return self.e2ee_fail("reset keys belong to another account");
        }
        let op = match self.account_op() {
            Ok(op) => op,
            Err(out) => return out,
        };
        let me = self.me.clone();
        self.e2ee.directory.remove(&me);
        self.e2ee.told_unverified.retain(|(login, _)| login != &me);
        // The new keys as published, and — since the old key's statements
        // are void — whom to vouch for again under them.
        self.e2ee.wanted.insert(me);
        // Re-sign this device's published keys with what it holds now — a
        // no-op after a normal 200, the repair after a settled doubt, when an
        // upload on the new socket may have gone out under the old keys.
        self.e2ee.needs_reupload = true;
        vec![
            Output::Persist(vec![op]),
            Output::Event(Event::CrossSigningReset),
        ]
    }

    /// A reset's request failed. A status is the server's verdict; no HTTP
    /// answer at all may still be a reset the server took, settled later.
    fn reset_failed(&mut self, now: Ts, reset: PendingReset, error: FetchError) -> Vec<Output> {
        let reason = match error {
            FetchError::Status(403, _) => "bad_password",
            FetchError::Status(429, _) => "too_many_attempts",
            FetchError::Status(401, _) => {
                self.e2ee.refused = true;
                "signed_out"
            }
            FetchError::Status(..) => "refused",
            FetchError::Network | FetchError::TooLarge => {
                self.e2ee.reset = Some(PendingReset {
                    in_doubt: true,
                    ..reset
                });
                self.e2ee.wanted.insert(self.me.clone());
                self.e2ee.failed(now);
                return Vec::new();
            }
        };
        vec![Output::Event(Event::CrossSigningResetFailed {
            reason: reason.to_owned(),
        })]
    }

    /// Settles a reset whose answer was lost, from this account's keys as
    /// `keys/query` just reported them: the new master key published means
    /// the server took it.
    pub(super) fn settle_reset(&mut self) -> Vec<Output> {
        if !self.e2ee.reset.as_ref().is_some_and(|reset| reset.in_doubt) {
            return Vec::new();
        }
        let Some(published) = self.e2ee.directory.get(&self.me) else {
            return Vec::new();
        };
        let published = published.cross.as_ref().map(|c| c.master_key());
        let Some(reset) = self.e2ee.reset.take() else {
            return Vec::new();
        };
        if published.as_deref() == Some(reset.cross.master_key().as_str()) {
            return self.apply_reset(reset.cross);
        }
        vec![Output::Event(Event::CrossSigningResetFailed {
            reason: "connection_lost".to_owned(),
        })]
    }
}

/// What this build's core reads, as a device announces it in `keys/upload`.
fn device_caps() -> Value {
    Value::from(vec![frames::e2ee::BLOB_CAP])
}
