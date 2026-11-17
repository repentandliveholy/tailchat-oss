//! End-to-end encryption on the wire (spec E2EE §8.1): the answers of
//! `/api/e2ee/keys/*`, the `to-device` frames and the `e2ee` envelope of a
//! message. Everything here is the server's word about keys; the keys
//! themselves are checked by `tailchat-crypto` before anything is built from
//! them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::api::{Envelope, PendingToDevice};
use crate::error::CoreError;
use crate::ids::Seq;
use crate::login::Login;

use super::{MAX_INBOUND, MAX_OUTBOUND, num};

/// The capability that turns end-to-end encryption on, in `auth` and `ready`.
pub const E2EE_CAP: &str = "e2ee-v1";
/// The device capability that says its core reads an attachment as raw
/// bytes inside the ciphertext (spec E2EE §4.3). A device that does not
/// announce it — a core from before 1.148, a server that drops the list —
/// gets the attachment as the `dataUrl` every core reads, still sealed.
pub const BLOB_CAP: &str = "e2ee-blob-v1";
/// The code a queued picture or voice note fails with (`Receipt::Failed` and
/// `Event::ServerError` with this code, said by the core, not the server)
/// when a device of the conversation reads only the inline form and that
/// form does not fit one frame. Nothing of it left this device.
pub const PEER_OUTDATED: &str = "peer_outdated";
/// The envelope version this build writes and reads.
const ENVELOPE_VERSION: u64 = 1;

/// The answer to `POST /api/e2ee/keys/upload`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAnswer {
    /// The device id the server bound to this session.
    pub device_id: String,
    /// Whether the server holds this device's keys.
    #[serde(default)]
    pub registered: bool,
    /// One-time keys the server still holds for this device.
    #[serde(default)]
    pub one_time_key_count: usize,
    /// Whether the server holds a fallback key for this device.
    #[serde(default)]
    pub fallback_key: bool,
}

/// The answer to `POST /api/e2ee/keys/query`: only the asking account and
/// its friends are in it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct QueryAnswer {
    /// By login.
    #[serde(default)]
    pub users: BTreeMap<String, QueryUser>,
}

/// One account's devices.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct QueryUser {
    /// The account's cross-signing keys (`{master, selfSigning}`), or `{}` when
    /// none have been published yet.
    #[serde(default, rename = "crossSigning")]
    pub cross_signing: Value,
    /// By device id; each device's own signed statement.
    #[serde(default)]
    pub devices: BTreeMap<String, QueryDevice>,
    /// Recently used sessions of this account that cannot read anything
    /// encrypted (no device keys): while there are any, its conversations
    /// stay open (spec E2EE §4.1, §7).
    #[serde(default, rename = "legacySessions", deserialize_with = "num::de_u32")]
    pub legacy_sessions: u32,
    /// Only in the answer about the asking account itself: its signed
    /// statements on whom it verified, by peer login
    /// (`CrossSigning::attest_peer`). Checked by the reader, not the server.
    #[serde(default, rename = "peerTrust")]
    pub peer_trust: BTreeMap<String, Value>,
}

/// One device as `keys/query` lists it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct QueryDevice {
    /// Its signed keys, checked by `DeviceKeys::from_json`.
    #[serde(rename = "deviceKeys")]
    pub device_keys: Value,
    /// What the device calls itself; "" when it never said.
    #[serde(default)]
    pub name: String,
    /// What the device's core announced it can read (`caps` beside
    /// `deviceKeys` in its upload, unsigned like the name). Anything that is
    /// not a list of strings reads as nothing announced.
    #[serde(default, deserialize_with = "de_caps")]
    pub caps: Vec<String>,
}

/// Reads a device's `caps`: the strings of a list, everything else dropped.
fn de_caps<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    let raw: Option<Vec<Value>> = super::lossy::lenient(deserializer)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect())
}

/// A device name fit to put in front of the person: no control or
/// formatting characters, at most 64 characters (the server's own limit,
/// `normalizeDeviceName`), trimmed.
#[must_use]
pub fn clean_device_name(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
        .collect();
    kept.trim().chars().take(64).collect()
}

/// The answer to `POST /api/e2ee/keys/claim`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ClaimAnswer {
    /// `login → device → key`; a device with nothing left is missing.
    #[serde(default)]
    pub keys: BTreeMap<String, BTreeMap<String, ClaimedKey>>,
    /// The server held some claims back (per-pair limit).
    #[serde(default, rename = "rateLimited")]
    pub rate_limited: bool,
}

/// One claimed key.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ClaimedKey {
    /// The signed key, `{key, fallback?, signatures}`.
    pub key: Value,
}

/// `{k: "to-device"}` from the server: held for this device until it sends
/// `to-device-ack` with this `seq` (or a later one: the ack is cumulative).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToDeviceIn {
    /// The server's counter, increasing.
    #[serde(deserialize_with = "num::de_seq")]
    pub seq: Seq,
    /// The sending account.
    pub from: Login,
    /// The sending device, as the server knows it.
    #[serde(rename = "fromDevice")]
    pub from_device: String,
    /// The Olm message.
    pub body: Value,
}

/// `{k: "to-device-accepted"}`: one of our key messages is on the server's disk.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ToDeviceAccepted {
    /// Our id for it.
    pub id: String,
}

/// One AES-256-GCM encrypted blob in `/api/e2ee/backup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupEntryWire {
    /// Unpadded base64 96-bit nonce.
    pub nonce: String,
    /// Unpadded base64 ciphertext + tag.
    pub ct: String,
}

/// Optional Argon2id passphrase slot in `/api/e2ee/backup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassphraseSlotWire {
    /// Unpadded base64 128-bit salt.
    pub salt: String,
    /// Unpadded base64 96-bit nonce.
    pub nonce: String,
    /// Unpadded base64 ciphertext + tag.
    pub ct: String,
}

/// One Megolm session entry in `/api/e2ee/backup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSessionWire {
    /// First message index the exported session can decrypt.
    #[serde(deserialize_with = "num::de_u32")]
    pub first_known_index: u32,
    /// Unpadded base64 96-bit nonce.
    pub nonce: String,
    /// Unpadded base64 ciphertext + tag.
    pub ct: String,
}

/// The answer to `POST /api/e2ee/backup`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAnswer {
    /// Current backup version (`0` when no backup exists).
    #[serde(default)]
    pub version: u64,
    /// Encrypted self-signing key blob.
    pub cross_signing: Option<BackupEntryWire>,
    /// Optional passphrase slot.
    pub passphrase: Option<PassphraseSlotWire>,
    /// Total sessions stored on the server.
    #[serde(default)]
    pub session_count: usize,
    /// Encrypted sessions by `session_id` (present when `includeSessions` was true).
    #[serde(default)]
    pub sessions: BTreeMap<String, BackupSessionWire>,
}

/// Reads an upload answer, refusing an oversized body before parsing it.
pub fn decode_upload(raw: &str) -> Result<UploadAnswer, CoreError> {
    decode(raw)
}

/// Reads a query answer.
pub fn decode_query(raw: &str) -> Result<QueryAnswer, CoreError> {
    decode(raw)
}

/// Reads a claim answer.
pub fn decode_claim(raw: &str) -> Result<ClaimAnswer, CoreError> {
    decode(raw)
}

/// Reads a backup answer.
pub fn decode_backup(raw: &str) -> Result<BackupAnswer, CoreError> {
    decode(raw)
}

/// Size check first, then JSON.
fn decode<'a, T: Deserialize<'a>>(raw: &'a str) -> Result<T, CoreError> {
    if raw.len() > MAX_INBOUND {
        return Err(CoreError::FrameTooLarge {
            len: raw.len(),
            max: MAX_INBOUND,
        });
    }
    serde_json::from_str(raw).map_err(|error| CoreError::BadFrame(error.to_string()))
}

/// The body of `keys/query` for these accounts.
pub fn query_body<'a>(logins: impl IntoIterator<Item = &'a Login>) -> String {
    let logins: Vec<&str> = logins.into_iter().map(Login::as_str).collect();
    json!({ "logins": logins }).to_string()
}

/// The body of `POST /api/e2ee/trust`: signed statements by peer login.
pub fn trust_body(statements: &BTreeMap<Login, Value>) -> String {
    let statements: BTreeMap<&str, &Value> = statements
        .iter()
        .map(|(login, value)| (login.as_str(), value))
        .collect();
    json!({ "peerTrust": statements }).to_string()
}

/// The body of `keys/claim`: one key for each named device.
pub fn claim_body(claims: &BTreeMap<Login, Vec<String>>) -> String {
    let claims: BTreeMap<&str, &Vec<String>> = claims
        .iter()
        .map(|(login, ids)| (login.as_str(), ids))
        .collect();
    json!({ "claims": claims }).to_string()
}

/// The body of `POST /api/e2ee/backup` to read metadata (and optionally all sessions).
pub fn backup_read_body(include_sessions: bool) -> String {
    if include_sessions {
        json!({ "includeSessions": true }).to_string()
    } else {
        "{}".to_owned()
    }
}

/// The body of `POST /api/e2ee/backup` when creating or rotating a backup.
pub fn backup_create_body(
    version: u64,
    replace: bool,
    cross_signing: &BackupEntryWire,
    passphrase: Option<&PassphraseSlotWire>,
    sessions: &BTreeMap<String, BackupSessionWire>,
) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("version".into(), json!(version));
    if replace {
        obj.insert("replace".into(), json!(true));
    }
    obj.insert("crossSigning".into(), json!(cross_signing));
    if let Some(slot) = passphrase {
        obj.insert("passphrase".into(), json!(slot));
    }
    if !sessions.is_empty() {
        obj.insert("sessions".into(), json!(sessions));
    }
    Value::Object(obj).to_string()
}

/// The body of `POST /api/e2ee/backup` to upload encrypted Megolm sessions.
pub fn backup_sessions_body(
    version: u64,
    sessions: &BTreeMap<String, BackupSessionWire>,
) -> String {
    json!({
        "version": version,
        "sessions": sessions,
    })
    .to_string()
}

/// `{k: "to-device", id, to, device, body}`. The stored body is our own JSON;
/// one that no longer parses is refused rather than sent.
pub fn to_device(item: &PendingToDevice) -> Result<String, CoreError> {
    #[derive(Serialize)]
    struct Frame<'a> {
        k: &'static str,
        id: &'a str,
        to: &'a str,
        device: &'a str,
        body: Value,
    }
    let body: Value =
        serde_json::from_str(&item.body).map_err(|error| CoreError::BadFrame(error.to_string()))?;
    let text = serde_json::to_string(&Frame {
        k: "to-device",
        id: &item.id,
        to: item.to.as_str(),
        device: &item.device,
        body,
    })
    .map_err(|error| CoreError::BadFrame(error.to_string()))?;
    if text.len() > MAX_OUTBOUND {
        return Err(CoreError::FrameTooLarge {
            len: text.len(),
            max: MAX_OUTBOUND,
        });
    }
    Ok(text)
}

/// `{k: "to-device-ack", seq}`: everything up to `seq` is on this device's disk.
pub fn to_device_ack(seq: Seq) -> String {
    json!({ "k": "to-device-ack", "seq": seq.0 }).to_string()
}

/// The `e2ee` of a message, or `None` when it is not an envelope this build
/// reads. Nothing here is trusted: the session found with `dev`/`sid` is
/// checked against both, and against the frame.
pub fn envelope(value: &Value) -> Option<Envelope> {
    if value.get("v").and_then(Value::as_u64) != Some(ENVELOPE_VERSION) {
        return None;
    }
    let text = |field: &str| value.get(field).and_then(Value::as_str).map(str::to_owned);
    Some(Envelope {
        dev: text("dev")?,
        sid: text("sid")?,
        ct: text("ct")?,
    })
}

/// The wire form of an envelope.
pub fn envelope_json(envelope: &Envelope) -> Value {
    json!({"v": ENVELOPE_VERSION, "dev": envelope.dev, "sid": envelope.sid, "ct": envelope.ct})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_answer_reads_the_servers_shape() {
        let answer = decode_upload(
            r#"{"deviceId":"AAAAAAAAAAAAAAAA","registered":true,"oneTimeKeyCount":7,"fallbackKey":true}"#,
        )
        .unwrap();
        assert_eq!(answer.device_id, "AAAAAAAAAAAAAAAA");
        assert!(answer.registered && answer.fallback_key);
        assert_eq!(answer.one_time_key_count, 7);
        // The first call of a session: only the id.
        let first = decode_upload(r#"{"deviceId":"BBBBBBBBBBBBBBBB"}"#).unwrap();
        assert!(!first.registered);
        assert!(decode_upload("[]").is_err());
    }

    #[test]
    fn device_names_lose_what_could_disguise_them() {
        assert_eq!(clean_device_name("  Chrome · macOS "), "Chrome · macOS");
        // A right-to-left override would make the line read differently.
        assert_eq!(
            clean_device_name("Chrome\u{202e}SOcam\u{200b}\n"),
            "ChromeSOcam"
        );
        assert_eq!(clean_device_name(&"я".repeat(80)).chars().count(), 64);
        assert_eq!(clean_device_name("\u{7}"), "");
    }

    #[test]
    fn query_and_claim_answers_read_the_servers_shape() {
        let query = decode_query(
            r#"{"users":{"bob":{"crossSigning":{},"devices":{"D":{"deviceKeys":{"x":1},"name":"","createdAt":1}},"legacySessions":2}}}"#,
        )
        .unwrap();
        let bob = &query.users["bob"];
        assert_eq!(bob.legacy_sessions, 2);
        assert_eq!(bob.devices["D"].device_keys, json!({"x": 1}));
        assert_eq!(bob.devices["D"].name, "");
        // A server older than names leaves the field out.
        let old = decode_query(r#"{"users":{"bob":{"devices":{"D":{"deviceKeys":{}}}}}}"#).unwrap();
        assert_eq!(old.users["bob"].devices["D"].name, "");
        let claim = decode_claim(
            r#"{"keys":{"bob":{"D":{"keyId":"k","key":{"key":"K"},"fallback":false}}},"rateLimited":true}"#,
        )
        .unwrap();
        assert!(claim.rate_limited);
        assert_eq!(claim.keys["bob"]["D"].key, json!({"key": "K"}));
    }

    #[test]
    fn to_device_frames_and_envelopes_round_trip() {
        let item = PendingToDevice {
            id: "td-1".into(),
            to: Login::parse("bob").unwrap(),
            device: "D".into(),
            body: r#"{"v":1,"type":0,"ct":"AA"}"#.into(),
        };
        let frame: Value = serde_json::from_str(&to_device(&item).unwrap()).unwrap();
        assert_eq!(
            frame,
            json!({"k":"to-device","id":"td-1","to":"bob","device":"D","body":{"v":1,"type":0,"ct":"AA"}})
        );
        assert_eq!(to_device_ack(Seq(9)), r#"{"k":"to-device-ack","seq":9}"#);
        let sealed = Envelope {
            dev: "D".into(),
            sid: "S".into(),
            ct: "C".into(),
        };
        assert_eq!(envelope(&envelope_json(&sealed)), Some(sealed));
        assert_eq!(envelope(&json!({"v":2,"dev":"D","sid":"S","ct":"C"})), None);
        assert_eq!(envelope(&json!({"v":1,"dev":"D","sid":"S"})), None);
    }

    /// A device's `caps` from `keys/query`: the strings of a list; a server
    /// from before them (no field), or anything else, is nothing announced.
    #[test]
    fn query_device_caps_are_read_leniently() {
        let answer = decode_query(
            r#"{"users":{"bob":{"devices":{
                "AAAAAAAAAAAAAAAA":{"deviceKeys":{},"caps":["e2ee-blob-v1",7,"x"]},
                "BBBBBBBBBBBBBBBB":{"deviceKeys":{}},
                "CCCCCCCCCCCCCCCC":{"deviceKeys":{},"caps":"e2ee-blob-v1"}}}}}"#,
        )
        .unwrap();
        let devices = &answer.users["bob"].devices;
        assert_eq!(devices["AAAAAAAAAAAAAAAA"].caps, [BLOB_CAP, "x"]);
        assert!(devices["BBBBBBBBBBBBBBBB"].caps.is_empty());
        assert!(devices["CCCCCCCCCCCCCCCC"].caps.is_empty());
    }
}
