//! Node.js bridge for the native Tailchat driver.

use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;
use serde_json::Value;
use tailchat_core::{Action, BackupPassphraseKey, Image, Login, MessageId, Secret, Ts};
use tailchat_net::{Command, Config, Handle, ReadError, StartError, json};
use tailchat_store::Key;

type JsResult<T> = napi::Result<T, String>;

fn error(code: &str, reason: impl std::fmt::Display) -> napi::Error<String> {
    napi::Error::new(code.to_owned(), reason.to_string())
}
fn invalid(reason: impl std::fmt::Display) -> napi::Error<String> {
    error("invalid-argument", reason)
}
fn parse_login(value: &str) -> JsResult<Login> {
    Login::parse(value).map_err(invalid)
}
fn parse_id(value: &str) -> JsResult<MessageId> {
    MessageId::parse(value).map_err(invalid)
}
#[napi(object)]
pub struct OpenOptions {
    pub login: String,
    pub token: String,
    pub socket_url: String,
    pub http_base: String,
    pub db_path: String,
    pub key: Buffer,
    pub extra_caps: Vec<String>,
    /// End-to-end encryption (stage 6); absent is off. Named explicitly:
    /// napi-rs would split the digit and call it `e2Ee`.
    #[napi(js_name = "e2ee")]
    pub e2ee: Option<bool>,
    /// What `keys/upload` calls this device ("Terminal · macOS").
    pub device_name: Option<String>,
}
#[napi(object)]
pub struct Before {
    pub ts: i64,
    pub id: String,
}

#[napi]
pub struct Client {
    handle: Option<Handle>,
    active: Arc<AtomicBool>,
    login: String,
}

#[napi]
impl Client {
    #[napi]
    pub fn send_text(&self, id: String, peer: String, text: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::SendText {
            id: parse_id(&id)?,
            peer: parse_login(&peer)?,
            text,
        }))
    }
    /// Queues a picture with an optional caption; `data_url` is a
    /// `data:image/{jpeg,png,gif,webp};base64,` URL.
    #[napi]
    pub fn send_image(
        &self,
        id: String,
        peer: String,
        text: String,
        data_url: String,
        width: Option<u32>,
        height: Option<u32>,
    ) -> napi::Result<(), String> {
        self.send(Command::Action(Action::SendImage {
            id: parse_id(&id)?,
            peer: parse_login(&peer)?,
            text,
            image: Image {
                data_url,
                width: width.map(i64::from),
                height: height.map(i64::from),
            },
        }))
    }
    /// Queues a message with any of a picture, a quote, a forward label and
    /// a voice note: `options` is `{image?, replyTo?, forwardedFrom?, voice?}`,
    /// spelled as a row reads back (`tailchat_net::json::send_with`). In an
    /// encrypted conversation all of it travels inside the ciphertext.
    #[napi]
    pub fn send_with(
        &self,
        id: String,
        peer: String,
        text: String,
        options: Option<Value>,
    ) -> napi::Result<(), String> {
        let action = json::send_with(
            parse_id(&id)?,
            parse_login(&peer)?,
            text,
            &options.unwrap_or(Value::Null),
        )
        .map_err(invalid)?;
        self.send(Command::Action(action))
    }
    /// New text for a message of ours. In an encrypted conversation it goes
    /// as an encrypted carrier under `id` (a row with `editOf: target`, which
    /// a client applies instead of drawing); otherwise as the server's open
    /// `edit`, and `id` is not used.
    #[napi]
    pub fn edit_text(
        &self,
        id: String,
        peer: String,
        target: String,
        text: String,
    ) -> napi::Result<(), String> {
        self.send(Command::Action(Action::EditText {
            id: parse_id(&id)?,
            peer: parse_login(&peer)?,
            target: parse_id(&target)?,
            text,
        }))
    }
    #[napi]
    pub fn retry(&self, peer: String, id: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::Retry {
            peer: parse_login(&peer)?,
            id: parse_id(&id)?,
        }))
    }
    #[napi]
    pub fn send_unencrypted(&self, peer: String, id: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::SendUnencrypted {
            peer: parse_login(&peer)?,
            id: parse_id(&id)?,
        }))
    }
    #[napi]
    pub fn accept_peer_key(&self, peer: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::AcceptPeerKey {
            peer: parse_login(&peer)?,
        }))
    }
    #[napi]
    pub fn start_sas(&self, peer: String, device: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::StartSas {
            peer: parse_login(&peer)?,
            device,
        }))
    }
    #[napi]
    pub fn start_sas_any(&self, peer: String, devices: Vec<String>) -> napi::Result<(), String> {
        self.send(Command::Action(Action::StartSasAny {
            peer: parse_login(&peer)?,
            devices,
        }))
    }
    #[napi]
    pub fn confirm_sas(&self, transaction_id: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::ConfirmSas { transaction_id }))
    }
    #[napi]
    pub fn cancel_sas(&self, transaction_id: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::CancelSas { transaction_id }))
    }
    #[napi]
    pub fn verify_with_qr(&self, qr: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::VerifyWithQr { qr }))
    }
    #[napi]
    pub fn safety_code(&self, peer: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::SafetyCode {
            peer: parse_login(&peer)?,
        }))
    }
    #[napi]
    pub fn confirm_safety_code(
        &self,
        peer: String,
        master_key: String,
    ) -> napi::Result<(), String> {
        self.send(Command::Action(Action::ConfirmSafetyCode {
            peer: parse_login(&peer)?,
            master_key,
        }))
    }
    #[napi]
    pub fn create_backup(&self, passphrase: Option<String>) -> napi::Result<(), String> {
        let passphrase_key = passphrase
            .as_deref()
            .map(BackupPassphraseKey::derive_new)
            .transpose()
            .map_err(invalid)?;
        self.send(Command::Action(Action::CreateBackup { passphrase_key }))
    }
    #[napi]
    pub fn fetch_backup(&self) -> napi::Result<(), String> {
        self.send(Command::Action(Action::FetchBackup))
    }
    #[napi]
    pub fn restore_backup_with_recovery_key(
        &self,
        recovery_key: String,
    ) -> napi::Result<(), String> {
        self.send(Command::Action(Action::RestoreBackupWithRecoveryKey {
            recovery_key: Secret::from_string(recovery_key),
        }))
    }
    #[napi]
    pub fn restore_backup_with_passphrase(
        &self,
        passphrase: String,
        salt: String,
    ) -> napi::Result<(), String> {
        let passphrase_key =
            BackupPassphraseKey::derive_with_salt(&passphrase, &salt).map_err(invalid)?;
        self.send(Command::Action(Action::RestoreBackupWithPassphrase {
            passphrase_key,
        }))
    }
    /// Replaces the account's cross-signing keys (spec E2EE §8.7); the server
    /// checks `password`. Answered by `cross-signing-reset` or
    /// `cross-signing-reset-failed`.
    #[napi]
    pub fn reset_cross_signing(&self, password: String) -> napi::Result<(), String> {
        self.send(Command::Action(Action::ResetCrossSigning {
            password: Secret::from_string(password),
        }))
    }
    #[napi]
    pub fn send_raw(&self, raw: String) -> napi::Result<(), String> {
        self.send(Command::Raw(raw))
    }
    #[napi]
    pub fn reconnect(&self) -> napi::Result<(), String> {
        self.send(Command::Reconnect)
    }
    #[napi]
    pub fn conversation(
        &self,
        peer: String,
        limit: u32,
        before: Option<Before>,
    ) -> napi::Result<Vec<Value>, String> {
        let peer = parse_login(&peer)?;
        let before = before
            .map(|v| parse_id(&v.id).map(|id| (Ts(v.ts), id)))
            .transpose()?;
        let rows = self
            .handle
            .as_ref()
            .ok_or_else(|| error("stopped", "client is closed"))?
            .conversation(
                &peer,
                before.as_ref().map(|(ts, id)| (*ts, id)),
                limit as usize,
            )
            .map_err(|e| match e {
                ReadError::Stopped => error("stopped", e),
                ReadError::Store(_) => error("store", e),
            })?;
        Ok(rows
            .into_iter()
            .map(|v| json::row(v, &self.login))
            .collect())
    }
    #[napi]
    pub fn close(&mut self) {
        self.active.store(false, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            handle.stop();
        }
    }
}
impl Client {
    fn send(&self, command: Command) -> JsResult<()> {
        self.handle
            .as_ref()
            .ok_or_else(|| error("stopped", "client is closed"))?
            .send(command)
            .map_err(|e| error("stopped", e))
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
pub fn open(
    env: Env,
    options: OpenOptions,
    callback: Function<'_, Value, ()>,
) -> napi::Result<Client, String> {
    let login = parse_login(&options.login)?;
    let bytes: &[u8; 32] = options
        .key
        .as_ref()
        .try_into()
        .map_err(|_| invalid("key must be 32 bytes"))?;
    let key = Key::from_bytes(bytes);
    let active = Arc::new(AtomicBool::new(true));
    let enabled = active.clone();
    let reference = callback.create_ref().map_err(invalid)?;
    let wrapper: Function<'_, Value, ()> = env
        .create_function_from_closure("tailchatNotice", move |ctx| {
            if enabled.load(Ordering::Acquire) {
                let value: Value = ctx.get(0)?;
                reference.borrow_back(ctx.env)?.call(value)?;
            }
            Ok(())
        })
        .map_err(invalid)?;
    let sink = wrapper
        .build_threadsafe_function::<Value>()
        .weak::<true>()
        .build()
        .map_err(invalid)?;
    let config = Config {
        login: login.clone(),
        token: options.token,
        socket_url: options.socket_url,
        http_base: options.http_base,
        db_path: PathBuf::from(options.db_path),
        key,
        extra_caps: options.extra_caps,
        e2ee: options.e2ee.unwrap_or(false),
        device_name: options.device_name.unwrap_or_default(),
    };
    let handle = tailchat_net::start(config, move |value| {
        let value = json::notice(value);
        let _ = sink.call(value, ThreadsafeFunctionCallMode::NonBlocking);
    })
    .map_err(|e| {
        let code = match &e {
            StartError::Locked => "locked",
            StartError::Store(_) => "store",
            StartError::BadToken => "bad-token",
            StartError::BadUrl(_) => "bad-url",
            _ => "store",
        };
        error(code, e)
    })?;
    Ok(Client {
        handle: Some(handle),
        active,
        login: login.as_str().to_owned(),
    })
}
