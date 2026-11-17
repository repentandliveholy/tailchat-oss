//! [`WebClient`]: the page's handle on the core, the browser twin of
//! `tailchat-node`'s `Client` — the same actions, the same notices (one JSON
//! shape, `tailchat_net::json`), the same rows.

use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_channel::mpsc;
use js_sys::Array;
use tailchat_core::{
    Action, BackupPassphraseKey, Image, Login, MessageId, Secret, Storage as _, Token,
};
use tailchat_net::exec::{Exec, Identity, Store, lock};
use tailchat_net::{Command, json};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use zeroize::Zeroizing;

use crate::KvStore;
use crate::driver::{Driver, In, JsFetch, notices};
use crate::host::{self, Host};

/// What `new WebClient(options, records, host)` takes as `options`.
#[wasm_bindgen]
extern "C" {
    /// `{login, token, socketUrl, httpBase, e2ee?, extraCaps?, deviceName?}`.
    pub type Options;

    #[wasm_bindgen(method, getter)]
    fn login(this: &Options) -> String;
    #[wasm_bindgen(method, getter)]
    fn token(this: &Options) -> String;
    #[wasm_bindgen(method, getter, js_name = socketUrl)]
    fn socket_url(this: &Options) -> String;
    #[wasm_bindgen(method, getter, js_name = httpBase)]
    fn http_base(this: &Options) -> String;
    #[wasm_bindgen(method, getter)]
    fn e2ee(this: &Options) -> Option<bool>;
    #[wasm_bindgen(method, getter, js_name = extraCaps)]
    fn extra_caps(this: &Options) -> Option<Vec<String>>;
    #[wasm_bindgen(method, getter, js_name = deviceName)]
    fn device_name(this: &Options) -> Option<String>;
}

/// An error the page can read: `{code, message}` folded into a JS `Error`
/// whose message starts with the code.
fn refused(code: &str, reason: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{code}: {reason}"))
}

fn login(value: &str) -> Result<Login, JsError> {
    Login::parse(value).map_err(|e| refused("invalid-argument", e))
}

fn id(value: &str) -> Result<MessageId, JsError> {
    MessageId::parse(value).map_err(|e| refused("invalid-argument", e))
}

/// The core of one signed-in account, running on the page's event loop.
#[wasm_bindgen]
pub struct WebClient {
    inbox: mpsc::UnboundedSender<In>,
    store: Store<KvStore>,
    stopping: Arc<AtomicBool>,
    login: String,
}

#[wasm_bindgen]
impl WebClient {
    /// Builds the store from `records` (every value IndexedDB holds, decrypted),
    /// starts the driver and dials at once. Progress arrives as notices on
    /// `host.notice`.
    ///
    /// # Errors
    /// `invalid-argument` (login, token, URLs), `store` (a record that does
    /// not decode).
    #[wasm_bindgen(constructor)]
    pub fn new(options: &Options, records: Vec<String>, host: Host) -> Result<WebClient, JsError> {
        let me = login(&options.login())?;
        let token = Zeroizing::new(options.token());
        Token::parse(&token).map_err(|e| refused("invalid-argument", e))?;
        let socket_url = options.socket_url();
        if !(socket_url.starts_with("wss://") || socket_url.starts_with("ws://")) {
            return Err(refused("invalid-argument", "socketUrl must be ws(s)://"));
        }
        let http_base = options.http_base().trim_end_matches('/').to_owned();
        if !(http_base.starts_with("https://") || http_base.starts_with("http://")) {
            return Err(refused("invalid-argument", "httpBase must be http(s)://"));
        }
        let kv = KvStore::from_records(records.iter().map(String::as_str))
            .map_err(|e| refused("store", e))?;
        let snapshot = kv.load().map_err(|e| refused("store", e))?;
        let identity = Identity {
            login: me,
            token: Arc::new(token.clone()),
            extra_caps: options.extra_caps().unwrap_or_default(),
            e2ee: options.e2ee().unwrap_or(false),
            // This driver only ever runs in the browser.
            web_features: true,
            device_name: options.device_name().unwrap_or_default(),
        };
        let core = identity
            .core(snapshot)
            .map_err(|e| refused("invalid-argument", e))?;
        let store: Store<KvStore> = Arc::new(Mutex::new(Some(kv)));
        let host = Rc::new(host);
        let queue = Arc::default();
        let stopping = Arc::new(AtomicBool::new(false));
        let fetch = JsFetch {
            host: Rc::clone(&host),
            store: Arc::clone(&store),
            base: http_base,
            token: Rc::new(token),
        };
        let exec = Exec::new(
            core,
            Arc::clone(&store),
            identity,
            notices(&queue, &stopping),
            fetch,
            host::now,
        );
        let (inbox, receiver) = mpsc::unbounded();
        let driver = Driver::new(
            exec,
            Arc::clone(&store),
            host,
            socket_url,
            receiver,
            queue,
            Arc::clone(&stopping),
        );
        spawn_local(driver.run());
        Ok(Self {
            inbox,
            store,
            stopping,
            login: options.login(),
        })
    }

    fn send(&self, message: In) -> Result<(), JsError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(refused("stopped", "client is closed"));
        }
        self.inbox
            .unbounded_send(message)
            .map_err(|_| refused("stopped", "client is closed"))
    }

    fn act(&self, action: Action) -> Result<(), JsError> {
        self.send(In::Command(Command::Action(action)))
    }

    /// Queues a message; it shows as a `message-added` notice.
    #[wasm_bindgen(js_name = sendText)]
    pub fn send_text(&self, id_: &str, peer: &str, text: String) -> Result<(), JsError> {
        self.act(Action::SendText {
            id: id(id_)?,
            peer: login(peer)?,
            text,
        })
    }

    /// Queues a picture with an optional caption; it shows as a
    /// `message-added` notice. `data_url` is a
    /// `data:image/{jpeg,png,gif,webp};base64,` URL.
    #[wasm_bindgen(js_name = sendImage)]
    pub fn send_image(
        &self,
        id_: &str,
        peer: &str,
        text: String,
        data_url: String,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<(), JsError> {
        self.act(Action::SendImage {
            id: id(id_)?,
            peer: login(peer)?,
            text,
            image: Image {
                data_url,
                width: width.map(i64::from),
                height: height.map(i64::from),
            },
        })
    }

    /// Queues a message with any of a picture, a quote, a forward label and
    /// a voice note; it shows as a `message-added` notice. `options` is
    /// `{image?, replyTo?, forwardedFrom?, voice?}`, spelled as a row reads
    /// back (`tailchat_net::json::send_with`). In an encrypted conversation
    /// all of it travels inside the ciphertext.
    ///
    /// # Errors
    /// `invalid-argument` (an id, a login or an option), `stopped`.
    #[wasm_bindgen(js_name = sendWith)]
    pub fn send_with(
        &self,
        id_: &str,
        peer: &str,
        text: String,
        options: JsValue,
    ) -> Result<(), JsError> {
        let options = host::from_js(&options).map_err(|e| refused("invalid-argument", e))?;
        let action = json::send_with(id(id_)?, login(peer)?, text, &options)
            .map_err(|e| refused("invalid-argument", e))?;
        self.act(action)
    }

    /// New text for a message of ours. In an encrypted conversation it goes
    /// as an encrypted carrier under `id_` (a row with `editOf: target`, which
    /// the page applies instead of drawing); otherwise as the server's open
    /// `edit`, and `id_` is not used.
    #[wasm_bindgen(js_name = editText)]
    pub fn edit_text(
        &self,
        id_: &str,
        peer: &str,
        target: &str,
        text: String,
    ) -> Result<(), JsError> {
        self.act(Action::EditText {
            id: id(id_)?,
            peer: login(peer)?,
            target: id(target)?,
            text,
        })
    }

    /// Sends a failed message again.
    pub fn retry(&self, peer: &str, id_: &str) -> Result<(), JsError> {
        self.act(Action::Retry {
            peer: login(peer)?,
            id: id(id_)?,
        })
    }

    /// Sends a held message without encryption, as the person chose.
    #[wasm_bindgen(js_name = sendUnencrypted)]
    pub fn send_unencrypted(&self, peer: &str, id_: &str) -> Result<(), JsError> {
        self.act(Action::SendUnencrypted {
            peer: login(peer)?,
            id: id(id_)?,
        })
    }

    /// Trusts a peer's new master key.
    #[wasm_bindgen(js_name = acceptPeerKey)]
    pub fn accept_peer_key(&self, peer: &str) -> Result<(), JsError> {
        self.act(Action::AcceptPeerKey { peer: login(peer)? })
    }

    /// Starts an emoji comparison with one of `peer`'s devices.
    #[wasm_bindgen(js_name = startSas)]
    pub fn start_sas(&self, peer: &str, device: String) -> Result<(), JsError> {
        self.act(Action::StartSas {
            peer: login(peer)?,
            device,
        })
    }

    /// Starts one emoji comparison with whichever of `peer`'s `devices`
    /// answers first; the others are told it was taken elsewhere.
    #[wasm_bindgen(js_name = startSasAny)]
    pub fn start_sas_any(&self, peer: &str, devices: Vec<String>) -> Result<(), JsError> {
        self.act(Action::StartSasAny {
            peer: login(peer)?,
            devices,
        })
    }

    /// The codes matched.
    #[wasm_bindgen(js_name = confirmSas)]
    pub fn confirm_sas(&self, transaction_id: String) -> Result<(), JsError> {
        self.act(Action::ConfirmSas { transaction_id })
    }

    /// The codes did not match, or the person gave up.
    #[wasm_bindgen(js_name = cancelSas)]
    pub fn cancel_sas(&self, transaction_id: String) -> Result<(), JsError> {
        self.act(Action::CancelSas { transaction_id })
    }

    /// Verifies a device from its scanned QR payload.
    #[wasm_bindgen(js_name = verifyWithQr)]
    pub fn verify_with_qr(&self, qr: String) -> Result<(), JsError> {
        self.act(Action::VerifyWithQr { qr })
    }

    /// Asks for the safety code with `peer`; it comes as a `safety-code`
    /// notice.
    #[wasm_bindgen(js_name = safetyCode)]
    pub fn safety_code(&self, peer: &str) -> Result<(), JsError> {
        self.act(Action::SafetyCode { peer: login(peer)? })
    }

    /// The safety code with `peer` matched: trust `master_key`, the key the
    /// shown code was made from.
    #[wasm_bindgen(js_name = confirmSafetyCode)]
    pub fn confirm_safety_code(&self, peer: &str, master_key: String) -> Result<(), JsError> {
        self.act(Action::ConfirmSafetyCode {
            peer: login(peer)?,
            master_key,
        })
    }

    /// Creates the key backup, optionally also openable with a passphrase.
    /// The passphrase is stretched here (Argon2id, 64 MiB): it takes seconds.
    #[wasm_bindgen(js_name = createBackup)]
    pub fn create_backup(&self, passphrase: Option<String>) -> Result<(), JsError> {
        let passphrase = passphrase.map(Zeroizing::new);
        let passphrase_key = passphrase
            .as_deref()
            .map(|p| BackupPassphraseKey::derive_new(p))
            .transpose()
            .map_err(|e| refused("invalid-argument", e))?;
        self.act(Action::CreateBackup { passphrase_key })
    }

    /// Asks the server what backup exists (`backup-info`).
    #[wasm_bindgen(js_name = fetchBackup)]
    pub fn fetch_backup(&self) -> Result<(), JsError> {
        self.act(Action::FetchBackup)
    }

    /// Restores the backup with the recovery key.
    #[wasm_bindgen(js_name = restoreBackupWithRecoveryKey)]
    pub fn restore_backup_with_recovery_key(&self, recovery_key: String) -> Result<(), JsError> {
        self.act(Action::RestoreBackupWithRecoveryKey {
            recovery_key: Secret::from_string(recovery_key),
        })
    }

    /// Restores the backup with its passphrase and the salt `backup-info` named.
    #[wasm_bindgen(js_name = restoreBackupWithPassphrase)]
    pub fn restore_backup_with_passphrase(
        &self,
        passphrase: String,
        salt: &str,
    ) -> Result<(), JsError> {
        let passphrase = Zeroizing::new(passphrase);
        let passphrase_key = BackupPassphraseKey::derive_with_salt(&passphrase, salt)
            .map_err(|e| refused("invalid-argument", e))?;
        self.act(Action::RestoreBackupWithPassphrase { passphrase_key })
    }

    /// Replaces the account's signing keys; the server asks for the password.
    #[wasm_bindgen(js_name = resetCrossSigning)]
    pub fn reset_cross_signing(&self, password: String) -> Result<(), JsError> {
        self.act(Action::ResetCrossSigning {
            password: Secret::from_string(password),
        })
    }

    /// Writes a frame as is, only while the connection is ready (otherwise a
    /// `raw-dropped` notice).
    #[wasm_bindgen(js_name = sendRaw)]
    pub fn send_raw(&self, raw: String) -> Result<(), JsError> {
        self.send(In::Command(Command::Raw(raw)))
    }

    /// Drops the socket and dials again at once.
    pub fn reconnect(&self) -> Result<(), JsError> {
        self.send(In::Command(Command::Reconnect))
    }

    /// The page is back in the foreground, or the network is: a socket heard
    /// from lately is asked to prove itself, anything else is replaced.
    pub fn probe(&self) -> Result<(), JsError> {
        self.send(In::Probe)
    }

    /// The host's socket opened.
    #[wasm_bindgen(js_name = socketOpen)]
    pub fn socket_open(&self) {
        let _ = self.send(In::Open);
    }

    /// A text frame arrived on the host's socket.
    #[wasm_bindgen(js_name = socketText)]
    pub fn socket_text(&self, text: String) {
        let _ = self.send(In::Text(text));
    }

    /// The host's socket closed (or never opened).
    #[wasm_bindgen(js_name = socketClosed)]
    pub fn socket_closed(&self) {
        let _ = self.send(In::Closed);
    }

    /// The newest `limit` rows with `peer` older than `(beforeTs, beforeId)`
    /// (both or neither), oldest first, as `tailchat_net::json::row` spells them.
    ///
    /// # Errors
    /// `invalid-argument`, `stopped`.
    pub fn conversation(
        &self,
        peer: &str,
        limit: u32,
        before_ts: Option<f64>,
        before_id: Option<String>,
    ) -> Result<Array, JsError> {
        let peer = login(peer)?;
        let before = match (before_ts, before_id) {
            (Some(ts), Some(raw)) => Some((host::millis(ts), id(&raw)?)),
            _ => None,
        };
        let guard = lock(&self.store);
        let kv = guard
            .as_ref()
            .ok_or_else(|| refused("stopped", "client is closed"))?;
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let rows = kv.conversation(&peer, before.as_ref().map(|(ts, id)| (*ts, id)), limit);
        Ok(rows
            .into_iter()
            .map(|row| host::to_js(&json::row(row, &self.login)))
            .collect())
    }

    /// Every conversation the store holds a row of.
    pub fn peers(&self) -> Array {
        let guard = lock(&self.store);
        guard
            .as_ref()
            .map(|kv| {
                kv.peers()
                    .iter()
                    .map(|p| JsValue::from(p.as_str()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Stops the driver: the socket is closed and no notice is delivered from
    /// now on. Idempotent.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.inbox.unbounded_send(In::Stop);
    }
}
