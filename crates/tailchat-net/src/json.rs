//! The notices and rows as the JavaScript clients read them: one JSON shape
//! for the terminal (`tailchat-node`) and the browser (`tailchat-web`), so
//! `src/cloud/core-link.js` and the web client never drift apart.
//!
//! Absent fields are left out rather than written as `null`. The JSON carries
//! message text (and, for `backup-created`, the recovery key): never log it.

use serde_json::{Map, Value, json};
use tailchat_core::frames::inner::{Forwarded, MediaKind, Reply, WAVEFORM_MAX};
use tailchat_core::{
    Action, Event, Extra, Image, Login, MessageId, MessageKind, OutVoice, Outgoing, Protection,
    Reaction, Receipt, Row, Seal,
};

use crate::{ConnState, Notice};

/// One conversation row; `login` is this account (the author of its own rows).
pub fn row(value: Row, login: &str) -> Value {
    let mut value = row_value(value, login);
    omit_absent(&mut value);
    value
}

/// One driver notice.
pub fn notice(value: Notice) -> Value {
    let mut value = notice_value(value);
    omit_absent(&mut value);
    value
}

/// `sendWith(id, peer, text, options)` as an action. `options` is spelled
/// the way a row reads back (see [`row`]), every key optional, `null` the
/// same as absent:
///
/// ```text
/// { image?:         { dataUrl, width?, height? },
///   replyTo?:       { id, from, text?, media?: "image" | "voice" | "file" },
///   forwardedFrom?: { login?, name? },
///   voice?:         { dataUrl, duration?: seconds, waveform?: [0..=255] } }
/// ```
///
/// An unknown top-level key is refused rather than dropped: a client that
/// believed it sent a field must not lose it in silence. `editOf` is refused
/// by name — an edit is `editText`. Keys inside a part that the sealed form
/// has no place for (the web's `replyTo.author`) are ignored. What the core
/// itself refuses (a blank text with nothing attached, a picture and a voice
/// note together, a frame too large) comes back as `action-refused`.
///
/// # Errors
/// What is malformed, as a sentence for the `invalid-argument` error.
pub fn send_with(
    id: MessageId,
    peer: Login,
    text: String,
    options: &Value,
) -> Result<Action, String> {
    let empty = Map::new();
    let fields = match options {
        Value::Null => &empty,
        Value::Object(fields) => fields,
        _ => return Err("options must be an object".to_owned()),
    };
    let mut image = None;
    let mut extra = Extra::default();
    for (key, value) in fields {
        if value.is_null() {
            continue;
        }
        match key.as_str() {
            "image" => image = Some(image_of(object(value, "image")?)?),
            "replyTo" => extra.reply_to = Some(reply_of(object(value, "replyTo")?)?),
            "forwardedFrom" => {
                extra.forwarded_from = Some(forwarded_of(object(value, "forwardedFrom")?)?);
            }
            "voice" => extra.voice = Some(voice_of(object(value, "voice")?)?),
            "editOf" => return Err("an edit is editText, not sendWith".to_owned()),
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok(Action::SendWith {
        id,
        peer,
        text,
        image,
        extra: Box::new(extra),
    })
}

/// `value` as an object, or why not.
fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what} must be an object"))
}

/// An optional string field; `null` is absent.
fn opt_str<'a>(
    fields: &'a Map<String, Value>,
    what: &str,
    key: &str,
) -> Result<Option<&'a str>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) => Ok(Some(v)),
        Some(_) => Err(format!("{what}.{key} must be a string")),
    }
}

/// A required string field.
fn req_str<'a>(fields: &'a Map<String, Value>, what: &str, key: &str) -> Result<&'a str, String> {
    opt_str(fields, what, key)?.ok_or_else(|| format!("{what}.{key} is missing"))
}

/// An optional non-negative whole number; `null` is absent.
fn opt_size(fields: &Map<String, Value>, what: &str, key: &str) -> Result<Option<i64>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| i64::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("{what}.{key} must be a whole number ≥ 0")),
    }
}

/// `{dataUrl, width?, height?}`.
fn image_of(fields: &Map<String, Value>) -> Result<Image, String> {
    Ok(Image {
        data_url: req_str(fields, "image", "dataUrl")?.to_owned(),
        width: opt_size(fields, "image", "width")?,
        height: opt_size(fields, "image", "height")?,
    })
}

/// `{id, from, text?, media?}`.
fn reply_of(fields: &Map<String, Value>) -> Result<Reply, String> {
    let id = MessageId::parse(req_str(fields, "replyTo", "id")?)
        .map_err(|e| format!("replyTo.id: {e}"))?;
    let from = Login::parse(req_str(fields, "replyTo", "from")?)
        .map_err(|e| format!("replyTo.from: {e}"))?;
    let media = match opt_str(fields, "replyTo", "media")? {
        None => None,
        Some("image") => Some(MediaKind::Image),
        Some("voice") => Some(MediaKind::Voice),
        Some("file") => Some(MediaKind::File),
        Some(other) => {
            return Err(format!(
                "replyTo.media {other:?} is not image, voice or file"
            ));
        }
    };
    Ok(Reply {
        id,
        from,
        text: opt_str(fields, "replyTo", "text")?
            .unwrap_or_default()
            .to_owned(),
        media,
    })
}

/// `{login?, name?}`, at least one of them.
fn forwarded_of(fields: &Map<String, Value>) -> Result<Forwarded, String> {
    let login = opt_str(fields, "forwardedFrom", "login")?
        .map(|v| Login::parse(v).map_err(|e| format!("forwardedFrom.login: {e}")))
        .transpose()?;
    let name = opt_str(fields, "forwardedFrom", "name")?.map(str::to_owned);
    if login.is_none() && name.is_none() {
        return Err("forwardedFrom names nobody: give a login or a name".to_owned());
    }
    Ok(Forwarded { login, name })
}

/// `{dataUrl, duration?, waveform?}`; `duration` in seconds, as every client
/// writes it and as a row reads back.
fn voice_of(fields: &Map<String, Value>) -> Result<OutVoice, String> {
    let duration_ms = match fields.get("duration") {
        None | Some(Value::Null) => 0,
        Some(v) => v
            .as_f64()
            .and_then(seconds_to_ms)
            .ok_or("voice.duration must be a number of seconds ≥ 0")?,
    };
    let waveform = match fields.get("waveform") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(bars)) => {
            if bars.len() > WAVEFORM_MAX {
                return Err(format!("voice.waveform has at most {WAVEFORM_MAX} bars"));
            }
            bars.iter()
                .map(|bar| bar.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect::<Option<Vec<u8>>>()
                .ok_or("voice.waveform bars are whole numbers 0–255")?
        }
        Some(_) => return Err("voice.waveform must be an array".to_owned()),
    };
    Ok(OutVoice {
        data_url: req_str(fields, "voice", "dataUrl")?.to_owned(),
        duration_ms,
        waveform,
    })
}

/// Seconds as whole milliseconds, when they fit.
#[allow(clippy::as_conversions)] // Range-checked just above the cast.
fn seconds_to_ms(seconds: f64) -> Option<u32> {
    let ms = (seconds * 1000.0).round();
    (ms.is_finite() && (0.0..=f64::from(u32::MAX)).contains(&ms)).then_some(ms as u32)
}

/// The receipt ladder's rung, as the clients spell it.
pub fn receipt(value: Receipt) -> &'static str {
    match value {
        Receipt::Queued => "queued",
        Receipt::Sent => "sent",
        Receipt::Delivered => "delivered",
        Receipt::Read => "read",
        Receipt::Failed => "failed",
    }
}
/// Sets one field of an object (`value` is always one here).
fn set(value: &mut Value, key: &str, field: Value) {
    if let Some(fields) = value.as_object_mut() {
        fields.insert(key.to_owned(), field);
    }
}

/// Drops `null` fields, recursively.
fn omit_absent(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|_, field| !field.is_null());
            for field in fields.values_mut() {
                omit_absent(field);
            }
        }
        Value::Array(items) => {
            for item in items {
                omit_absent(item);
            }
        }
        _ => {}
    }
}
/// Reactions as `[{emoji, by: [login]}]`.
fn reactions(values: Vec<Reaction>) -> Value {
    Value::Array(values.into_iter().map(|r| json!({"emoji": r.emoji, "by": r.by.iter().map(|v| v.as_str()).collect::<Vec<_>>() })).collect())
}
/// An outgoing row's common fields.
fn outgoing(source: &str, value: Outgoing, login: &str) -> Value {
    let image = value
        .image
        .map(|i| json!({"dataUrl": i.data_url, "width": i.width, "height": i.height}));
    let mut row = json!({"source": source, "id": value.id.as_str(), "peer": value.peer.as_str(), "from": login, "ts": value.ts.0, "text": value.text, "receipt": receipt(value.receipt), "reactions": []});
    set(&mut row, "image", image.unwrap_or(Value::Null));
    let extra = value.extra;
    if let Some(v) = extra.voice {
        set(&mut row, "voice", json!({"dataUrl": v.data_url, "duration": f64::from(v.duration_ms) / 1000.0}));
    }
    if let Some(v) = extra.reply_to {
        set(&mut row, "replyTo", json!({"id": v.id.as_str(), "from": v.from.as_str(), "text": v.text}));
    }
    if let Some(v) = extra.forwarded_from {
        set(&mut row, "forwardedFrom", json!({"login": v.login.as_ref().map(Login::as_str), "name": v.name}));
    }
    if let Some(target) = extra.edit_of {
        set(&mut row, "editOf", json!(target.as_str()));
    }
    row
}
/// A row, before absent fields are dropped.
fn row_value(value: Row, login: &str) -> Value {
    match value {
        Row::Message(m) => {
            let image = m
                .image
                .map(|v| json!({"dataUrl": v.data_url, "width": v.width, "height": v.height}));
            let voice = m
                .voice
                .map(|v| json!({"dataUrl": v.data_url, "duration": v.duration}));
            let reply = m.reply_to.map(|v| json!({"id":v.id.as_str(), "from":v.from.as_str(), "text":v.text, "media":v.media.map(|m| match m { MediaKind::Image => "image", MediaKind::Voice => "voice", MediaKind::File => "file" })}));
            let forwarded = m
                .forwarded_from
                .map(|v| json!({"login":v.login.as_ref().map(Login::as_str), "name":v.name}));
            let buttons: Vec<Value> = m
                .buttons
                .into_iter()
                .map(|v| json!({"id":v.id,"label":v.label,"value":v.value}))
                .collect();
            let protection = match m.protection {
                Protection::Plain => "plain",
                Protection::Encrypted => "encrypted",
                Protection::Sealed { waiting: true, .. } => "waiting",
                Protection::Sealed { waiting: false, .. } => "undecryptable",
            };
            json!({"source":"message", "id":m.id.as_str(), "peer":m.peer.as_str(), "from":m.from.as_str(), "ts":m.ts.0, "text":m.text, "kind":match m.kind { MessageKind::Human => "human", MessageKind::Ai => "ai" }, "author":m.author, "image":image, "voice":voice, "replyTo":reply, "forwardedFrom":forwarded, "buttons":buttons, "mediaDropped":m.media_dropped, "editedAt":m.edited_at.map(|t| t.0), "reactions":reactions(m.reactions), "protection":protection, "editOf":m.edit_of.as_ref().map(MessageId::as_str)})
        }
        Row::Sent(s) => {
            let mut value = outgoing("sent", s.message, login);
            set(&mut value, "editedAt", json!(s.edited_at.map(|t| t.0)));
            set(&mut value, "reactions", reactions(s.reactions));
            value
        }
        Row::Pending(p) => {
            let mut value = outgoing("pending", p.message, login);
            set(&mut value, "attempts", json!(p.attempts));
            set(&mut value, "nextAttemptAt", json!(p.next_attempt_at.0));
            let seal = match p.seal {
                Seal::Undecided => "undecided",
                Seal::Plain => "plain",
                Seal::Encrypted(_) => "encrypted",
            };
            set(&mut value, "seal", json!(seal));
            value
        }
    }
}
/// A notice, before absent fields are dropped.
fn notice_value(value: Notice) -> Value {
    match value {
        Notice::Connection(state) => match state {
            ConnState::Connecting => json!({"kind":"connection","state":"connecting"}),
            ConnState::Open => json!({"kind":"connection","state":"open"}),
            ConnState::Ready => json!({"kind":"connection","state":"ready"}),
            ConnState::Closed { retry_in_ms } => {
                json!({"kind":"connection","state":"closed","retryInMs":retry_in_ms})
            }
            ConnState::AuthFailed => json!({"kind":"connection","state":"auth-failed"}),
        },
        Notice::Frame(raw) => json!({"kind":"frame","raw":raw}),
        Notice::RawDropped(raw) => json!({"kind":"raw-dropped","raw":raw}),
        Notice::ActionRefused {
            peer,
            id,
            held,
            reason,
        } => {
            json!({"kind":"action-refused","peer":peer.as_str(),"id":id.as_str(),"held":held,"reason":reason})
        }
        Notice::StorageFailed { reason } => json!({"kind":"storage-failed","reason":reason}),
        Notice::Event(event) => match event {
            Event::MessageAdded(m) => {
                // `editOf`: the row is an encrypted edit's carrier, which a
                // client applies to its target instead of drawing.
                json!({"kind":"message-added","peer":m.peer.as_str(),"id":m.id.as_str(),"ts":m.ts.0,"text":m.text,"receipt":receipt(m.receipt),"editOf":m.extra.edit_of.as_ref().map(MessageId::as_str)})
            }
            Event::ReceiptChanged {
                peer,
                id,
                ts,
                receipt: r,
            } => {
                json!({"kind":"receipt","peer":peer.as_str(),"id":id.as_str(),"ts":ts.0,"receipt":receipt(r)})
            }
            Event::ServerError { code, peer, id } => {
                json!({"kind":"server-error","code":code,"peer":peer.as_ref().map(Login::as_str),"id":id.as_ref().map(MessageId::as_str)})
            }
            Event::BadFrame { reason } => json!({"kind":"bad-frame","reason":reason}),
            Event::MessageStored { peer, id } => {
                json!({"kind":"stored","peer":peer.as_str(),"id":id.as_str()})
            }
            Event::OlderPage {
                peer,
                oldest,
                complete,
            } => {
                json!({"kind":"older-page","peer":peer.as_str(),"oldest":oldest.as_ref().map(|b| json!({"id":b.id.as_str(),"ts":b.ts.0})),"complete":complete})
            }
            Event::MessagesRemoved { peer, ids } => {
                json!({"kind":"removed","peer":peer.as_str(),"ids":ids.iter().map(MessageId::as_str).collect::<Vec<_>>()})
            }
            Event::OwnReadMoved { peer, read_ts } => {
                json!({"kind":"own-read","peer":peer.as_str(),"readTs":read_ts.0})
            }
            Event::DeviceRegistered { device_id } => {
                json!({"kind":"device-registered","deviceId":device_id})
            }
            Event::EncryptionFailed { reason } => {
                json!({"kind":"encryption-failed","reason":reason})
            }
            Event::PlaintextHeld { peer, id } => {
                json!({"kind":"plaintext-held","peer":peer.as_str(),"id":id.as_str()})
            }
            Event::EncryptionState { peer, encrypted } => {
                json!({"kind":"encryption-state","peer":peer.as_str(),"encrypted":encrypted})
            }
            Event::KeyChanged { peer } => {
                json!({"kind":"key-changed","peer":peer.as_str()})
            }
            Event::UnverifiedDevice { peer, device, name } => {
                json!({"kind":"unverified-device","peer":peer.as_str(),"device":device,"name":name})
            }
            Event::SasStarted {
                transaction_id,
                peer,
                device,
            } => {
                json!({"kind":"sas-started","transactionId":transaction_id,"peer":peer.as_str(),"device":device})
            }
            Event::SasCodeReady {
                transaction_id,
                peer,
                device,
                emoji_indices,
                decimals,
            } => {
                json!({"kind":"sas-code-ready","transactionId":transaction_id,"peer":peer.as_str(),"device":device,"emojiIndices":emoji_indices,"decimals":decimals})
            }
            Event::DeviceKeysConflict => json!({"kind":"device-keys-conflict"}),
            Event::SasCancelled {
                transaction_id,
                peer,
                device,
                name,
                reason,
            } => {
                json!({"kind":"sas-cancelled","transactionId":transaction_id,"peer":peer.as_str(),"device":device,"name":name,"reason":reason})
            }
            Event::DeviceVerified { peer, device, name } => {
                json!({"kind":"device-verified","peer":peer.as_str(),"device":device,"name":name})
            }
            Event::BackupCreated {
                version,
                recovery_key,
            } => {
                json!({"kind":"backup-created","version":version,"recoveryKey":recovery_key.expose()})
            }
            Event::BackupInfo {
                version,
                passphrase_salt,
                session_count,
            } => {
                json!({"kind":"backup-info","version":version,"passphraseSalt":passphrase_salt,"sessionCount":session_count})
            }
            Event::BackupRestored { version, sessions } => {
                json!({"kind":"backup-restored","version":version,"sessions":sessions})
            }
            Event::CrossSigningReset => json!({"kind":"cross-signing-reset"}),
            Event::CrossSigningResetFailed { reason } => {
                json!({"kind":"cross-signing-reset-failed","reason":reason})
            }
            Event::SafetyCode {
                peer,
                status,
                halves,
                master_key,
                number,
                verified,
            } => {
                let halves: Vec<Value> = halves
                    .iter()
                    .map(|h| json!({"login":h.login.as_str(),"emojiIndices":h.emoji_indices}))
                    .collect();
                json!({"kind":"safety-code","peer":peer.as_str(),"status":status,"halves":halves,"masterKey":master_key,"number":number,"verified":verified})
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use tailchat_core::{MessageId, PendingOutgoing, Sent, Ts};

    use super::*;

    fn outgoing_row(receipt: Receipt) -> Outgoing {
        Outgoing {
            extra: Default::default(),
            id: MessageId::parse("m-1").unwrap(),
            peer: Login::parse("bob").unwrap(),
            ts: Ts(5),
            text: "hi".to_owned(),
            image: None,
            receipt,
        }
    }

    #[test]
    fn a_sent_row_carries_its_edit_and_reactions_and_omits_what_is_absent() {
        let row = Row::Sent(Sent {
            message: outgoing_row(Receipt::Delivered),
            edited_at: None,
            reactions: vec![Reaction {
                emoji: "👍".to_owned(),
                by: vec![Login::parse("bob").unwrap()],
            }],
        });
        assert_eq!(
            super::row(row, "alice"),
            json!({"source": "sent", "id": "m-1", "peer": "bob", "from": "alice", "ts": 5,
                   "text": "hi", "receipt": "delivered",
                   "reactions": [{"emoji": "👍", "by": ["bob"]}]})
        );
    }

    #[test]
    fn a_pending_row_carries_its_attempts_and_seal() {
        let row = Row::Pending(PendingOutgoing {
            message: outgoing_row(Receipt::Queued),
            attempts: 2,
            next_attempt_at: Ts(9),
            seal: Seal::Plain,
        });
        assert_eq!(
            super::row(row, "alice"),
            json!({"source": "pending", "id": "m-1", "peer": "bob", "from": "alice", "ts": 5,
                   "text": "hi", "receipt": "queued", "reactions": [], "attempts": 2,
                   "nextAttemptAt": 9, "seal": "plain"})
        );
    }

    fn parse(options: Value) -> Result<(Option<Image>, Extra), String> {
        match send_with(
            MessageId::parse("m-1").unwrap(),
            Login::parse("bob").unwrap(),
            "hi".to_owned(),
            &options,
        )? {
            Action::SendWith { image, extra, .. } => Ok((image, *extra)),
            other => panic!("not a SendWith: {other:?}"),
        }
    }

    #[test]
    fn send_with_reads_the_row_shape_back_into_an_action() {
        let (image, extra) = parse(json!({
            "replyTo": {"id": "m-0", "from": "alice", "text": "quoted", "media": "voice", "author": "Alice"},
            "forwardedFrom": {"login": "carol", "name": "Кэрол"},
            "voice": {"dataUrl": "data:audio/mp4;base64,AAAA", "duration": 2.5, "waveform": [0, 128, 255]},
            "image": null,
        }))
        .unwrap();
        assert!(image.is_none(), "null is absent");
        let reply = extra.reply_to.unwrap();
        assert_eq!((reply.id.as_str(), reply.from.as_str(), reply.text.as_str()), ("m-0", "alice", "quoted"));
        assert_eq!(reply.media, Some(MediaKind::Voice));
        let forwarded = extra.forwarded_from.unwrap();
        assert_eq!(forwarded.login.as_ref().map(Login::as_str), Some("carol"));
        assert_eq!(forwarded.name.as_deref(), Some("Кэрол"));
        let voice = extra.voice.unwrap();
        assert_eq!((voice.duration_ms, voice.waveform), (2500, vec![0, 128, 255]));
        assert!(extra.edit_of.is_none());

        let (image, extra) = parse(json!({"image": {"dataUrl": "data:image/png;base64,AAAA", "width": 3}})).unwrap();
        let image = image.unwrap();
        assert_eq!((image.width, image.height), (Some(3), None));
        assert!(extra.is_empty());
        assert!(parse(Value::Null).unwrap().1.is_empty(), "no options is a plain text");
    }

    #[test]
    fn send_with_refuses_what_it_would_otherwise_drop() {
        for (options, says) in [
            (json!({"editOf": "m-0"}), "editText"),
            (json!({"buttons": []}), "unknown option"),
            (json!([]), "must be an object"),
            (json!({"replyTo": {"from": "alice"}}), "replyTo.id"),
            (json!({"replyTo": {"id": "m-0", "from": "alice", "media": "gif"}}), "replyTo.media"),
            (json!({"forwardedFrom": {}}), "names nobody"),
            (json!({"voice": {"dataUrl": "data:audio/mp4;base64,AA", "duration": -1}}), "voice.duration"),
            (json!({"voice": {"dataUrl": "data:audio/mp4;base64,AA", "waveform": [256]}}), "0–255"),
            (json!({"voice": {"dataUrl": "x", "waveform": vec![0; WAVEFORM_MAX + 1]}}), "at most"),
            (json!({"image": {"dataUrl": "x", "width": -3}}), "image.width"),
        ] {
            let error = parse(options.clone()).unwrap_err();
            assert!(error.contains(says), "{options} → {error}");
        }
    }

    #[test]
    fn a_carrier_says_what_it_edits_when_it_is_queued() {
        let mut carrier = outgoing_row(Receipt::Queued);
        carrier.extra.edit_of = Some(MessageId::parse("m-0").unwrap());
        assert_eq!(
            notice(Notice::Event(Event::MessageAdded(carrier))),
            json!({"kind": "message-added", "peer": "bob", "id": "m-1", "ts": 5, "text": "hi",
                   "receipt": "queued", "editOf": "m-0"})
        );
        assert!(notice(Notice::Event(Event::MessageAdded(outgoing_row(Receipt::Queued))))
            .get("editOf")
            .is_none());
    }

    #[test]
    fn connection_notices_spell_their_state() {
        assert_eq!(
            notice(Notice::Connection(ConnState::Closed { retry_in_ms: None })),
            json!({"kind": "connection", "state": "closed"})
        );
        assert_eq!(
            notice(Notice::Connection(ConnState::Closed {
                retry_in_ms: Some(1000)
            })),
            json!({"kind": "connection", "state": "closed", "retryInMs": 1000})
        );
        assert_eq!(
            notice(Notice::Event(Event::KeyChanged {
                peer: Login::parse("bob").unwrap()
            })),
            json!({"kind": "key-changed", "peer": "bob"})
        );
    }
}
