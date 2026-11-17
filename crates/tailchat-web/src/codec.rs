//! Records ↔ JSON text. Each record names its own table (`t`) and carries
//! every field of its key, so the IndexedDB key is never needed to read it
//! back. Everything read back is checked again (`Login::parse`,
//! `MessageId::parse`): a damaged record is [`KvError::Corrupt`], never a
//! value the core's types promise cannot exist.

use serde_json::{Map, Value, json};
use tailchat_core::frames::inner::{Button, Forwarded, Image, MediaKind, Reply, Voice};
use tailchat_core::{
    Backfill, Below, Envelope, Extra, OutVoice, InboundRow, Login, Message, MessageId, MessageKind, OlmChannelRow,
    OutboundRow, Outgoing, OwedAck, OwnRead, PeerIdentity, PeerReceipts, PendingOutgoing,
    PendingToDevice, Protection, Reaction, Receipt, Seal, Secret, Seq, Ts, WalkFrom,
};

use crate::store::{KvError, PendingRow, SentRow, ToDeviceRow};

/// One stored record.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Record {
    Cursor(Seq),
    Pending(PendingRow),
    Sent(SentRow),
    Message(Box<Message>),
    Receipts(PeerReceipts),
    Backfill(Backfill),
    OwnRead(OwnRead),
    Ack(OwedAck),
    Account(Secret),
    Olm(OlmChannelRow),
    Outbound(OutboundRow),
    Inbound(InboundRow),
    ToDevice(ToDeviceRow),
    Encrypted(Login),
    Identity(PeerIdentity),
    BackupKey(Secret),
}

/// The record as JSON text.
pub(crate) fn encode(record: &Record) -> String {
    let value = match record {
        Record::Cursor(seq) => json!({"t": "cursor", "seq": seq.0}),
        Record::Pending(r) => {
            let mut v = outgoing(&r.row.message);
            insert(&mut v, "t", json!("pending"));
            insert(&mut v, "ord", json!(r.ord));
            insert(&mut v, "attempts", json!(r.row.attempts));
            insert(&mut v, "next", json!(r.row.next_attempt_at.0));
            insert(&mut v, "seal", seal(&r.row.seal));
            v
        }
        Record::Sent(r) => {
            let mut v = outgoing(&r.message);
            insert(&mut v, "t", json!("sent"));
            insert(&mut v, "ord", json!(r.ord));
            insert(&mut v, "edited", json!(r.edited_at.map(|t| t.0)));
            insert(&mut v, "reactions", reactions(&r.reactions));
            v
        }
        Record::Message(m) => message(m),
        Record::Receipts(r) => json!({
            "t": "receipts",
            "peer": r.peer.as_str(),
            "delivered": r.delivered_ts.map(|t| t.0),
            "read": r.read_ts.map(|t| t.0),
        }),
        Record::Backfill(b) => json!({
            "t": "backfill",
            "peer": b.peer.as_str(),
            "owed": b.owed.iter().map(MessageId::as_str).collect::<Vec<_>>(),
            "reseed": match &b.reseed {
                None => Value::Null,
                Some(WalkFrom::Newest) => json!("newest"),
                Some(WalkFrom::Below(below)) => json!({"id": below.id.as_str(), "ts": below.ts.0}),
            },
        }),
        Record::OwnRead(r) => {
            json!({"t": "own_read", "peer": r.peer.as_str(), "read": r.read_ts.0})
        }
        Record::Ack(a) => {
            json!({"t": "ack", "peer": a.peer.as_str(), "id": a.id.as_str(), "ts": a.ts.0})
        }
        Record::Account(s) => json!({"t": "account", "pickle": s.expose()}),
        Record::Olm(c) => json!({
            "t": "olm", "login": c.login.as_str(), "device": c.device, "pickle": c.pickle.expose(),
        }),
        Record::Outbound(g) => {
            json!({"t": "outbound", "peer": g.peer.as_str(), "pickle": g.pickle.expose()})
        }
        Record::Inbound(g) => json!({
            "t": "inbound", "sender": g.sender.as_str(), "device": g.device,
            "session": g.session, "pickle": g.pickle.expose(),
        }),
        Record::ToDevice(r) => json!({
            "t": "to_device", "ord": r.ord, "id": r.row.id, "to": r.row.to.as_str(),
            "device": r.row.device, "body": r.row.body,
        }),
        Record::Encrypted(peer) => json!({"t": "encrypted", "peer": peer.as_str()}),
        Record::Identity(i) => json!({
            "t": "identity", "peer": i.peer.as_str(), "masterKey": i.master_key, "verified": i.verified,
        }),
        Record::BackupKey(s) => json!({"t": "backup_key", "pickle": s.expose()}),
    };
    value.to_string()
}

/// Sets one field of an object.
fn insert(value: &mut Value, key: &str, field: Value) {
    if let Some(fields) = value.as_object_mut() {
        fields.insert(key.to_owned(), field);
    }
}

fn receipt_text(receipt: Receipt) -> &'static str {
    match receipt {
        Receipt::Queued => "queued",
        Receipt::Sent => "sent",
        Receipt::Delivered => "delivered",
        Receipt::Read => "read",
        Receipt::Failed => "failed",
    }
}

fn outgoing(m: &Outgoing) -> Value {
    let mut value = json!({
        "peer": m.peer.as_str(),
        "id": m.id.as_str(),
        "ts": m.ts.0,
        "text": m.text,
        "receipt": receipt_text(m.receipt),
    });
    insert(
        &mut value,
        "image",
        m.image.as_ref().map_or(
            Value::Null,
            |i| json!({"url": i.data_url, "w": i.width, "h": i.height}),
        ),
    );
    if !m.extra.is_empty() {
        insert(&mut value, "extra", extra(&m.extra));
    }
    value
}

fn reply(r: &Reply) -> Value {
    json!({
        "id": r.id.as_str(), "from": r.from.as_str(), "text": r.text,
        "media": r.media.map(media_text),
    })
}

fn forwarded(f: &Forwarded) -> Value {
    json!({"login": f.login.as_ref().map(Login::as_str), "name": f.name})
}

fn extra(e: &Extra) -> Value {
    json!({
        "reply": e.reply_to.as_ref().map(reply),
        "forwarded": e.forwarded_from.as_ref().map(forwarded),
        "voice": e.voice.as_ref().map(|v| json!({"url": v.data_url, "ms": v.duration_ms, "wave": v.waveform})),
        "editOf": e.edit_of.as_ref().map(MessageId::as_str),
    })
}

fn envelope(e: &Envelope) -> Value {
    json!({"dev": e.dev, "sid": e.sid, "ct": e.ct})
}

fn seal(s: &Seal) -> Value {
    match s {
        Seal::Undecided => Value::Null,
        Seal::Plain => json!("plain"),
        Seal::Encrypted(e) => envelope(e),
    }
}

fn reactions(values: &[Reaction]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|r| json!({"emoji": r.emoji, "by": r.by.iter().map(Login::as_str).collect::<Vec<_>>()}))
            .collect(),
    )
}

fn media_text(media: MediaKind) -> &'static str {
    match media {
        MediaKind::Image => "image",
        MediaKind::Voice => "voice",
        MediaKind::File => "file",
    }
}

fn message(m: &Message) -> Value {
    json!({
        "t": "message",
        "peer": m.peer.as_str(),
        "id": m.id.as_str(),
        "from": m.from.as_str(),
        "ts": m.ts.0,
        "kind": match m.kind { MessageKind::Human => "human", MessageKind::Ai => "ai" },
        "text": m.text,
        "author": m.author,
        "image": m.image.as_ref().map(|i| json!({"url": i.data_url, "w": i.width, "h": i.height})),
        "voice": m.voice.as_ref().map(|v| json!({"url": v.data_url, "duration": v.duration, "wave": v.waveform})),
        "reply": m.reply_to.as_ref().map(reply),
        "forwarded": m.forwarded_from.as_ref().map(forwarded),
        "editOf": m.edit_of.as_ref().map(MessageId::as_str),
        "buttons": m.buttons.iter().map(|b| json!({"id": b.id, "label": b.label, "value": b.value})).collect::<Vec<_>>(),
        "mediaDropped": m.media_dropped,
        "edited": m.edited_at.map(|t| t.0),
        "reactions": reactions(&m.reactions),
        "protection": match &m.protection {
            Protection::Plain => json!("plain"),
            Protection::Encrypted => json!("encrypted"),
            Protection::Sealed { envelope: e, waiting } => {
                let mut v = envelope(e);
                insert(&mut v, "waiting", json!(waiting));
                v
            }
        },
    })
}

// ---- decoding ----

/// A damaged record.
const fn bad(reason: &'static str) -> KvError {
    KvError::Corrupt(reason)
}

/// Field access on one decoded object.
struct Fields<'a>(&'a Map<String, Value>);

impl<'a> Fields<'a> {
    fn of(value: &'a Value) -> Result<Self, KvError> {
        value.as_object().map(Fields).ok_or(bad("not an object"))
    }
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.0.get(key).filter(|v| !v.is_null())
    }
    fn str(&self, key: &str) -> Result<&'a str, KvError> {
        self.get(key)
            .and_then(Value::as_str)
            .ok_or(bad("missing text"))
    }
    fn opt_str(&self, key: &str) -> Result<Option<String>, KvError> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_str()
                .map(|s| Some(s.to_owned()))
                .ok_or(bad("bad text")),
        }
    }
    fn string(&self, key: &str) -> Result<String, KvError> {
        self.str(key).map(str::to_owned)
    }
    fn i64(&self, key: &str) -> Result<i64, KvError> {
        self.get(key)
            .and_then(Value::as_i64)
            .ok_or(bad("missing number"))
    }
    fn opt_i64(&self, key: &str) -> Result<Option<i64>, KvError> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => v.as_i64().map(Some).ok_or(bad("bad number")),
        }
    }
    fn u64(&self, key: &str) -> Result<u64, KvError> {
        self.get(key)
            .and_then(Value::as_u64)
            .ok_or(bad("missing order"))
    }
    fn bool(&self, key: &str) -> Result<bool, KvError> {
        self.get(key)
            .and_then(Value::as_bool)
            .ok_or(bad("missing flag"))
    }
    fn login(&self, key: &str) -> Result<Login, KvError> {
        Login::parse(self.str(key)?).map_err(|_| bad("bad login"))
    }
    fn id(&self, key: &str) -> Result<MessageId, KvError> {
        MessageId::parse(self.str(key)?).map_err(|_| bad("bad message id"))
    }
    fn secret(&self, key: &str) -> Result<Secret, KvError> {
        Ok(Secret::from_string(self.string(key)?))
    }
    fn ts(&self, key: &str) -> Result<Ts, KvError> {
        self.i64(key).map(Ts)
    }
    fn opt_ts(&self, key: &str) -> Result<Option<Ts>, KvError> {
        self.opt_i64(key).map(|v| v.map(Ts))
    }
    fn array(&self, key: &str) -> Result<&'a Vec<Value>, KvError> {
        self.get(key)
            .and_then(Value::as_array)
            .ok_or(bad("missing list"))
    }
}

/// One record from its JSON text.
pub(crate) fn decode(text: &str) -> Result<Record, KvError> {
    let value: Value = serde_json::from_str(text).map_err(|_| bad("not JSON"))?;
    let f = Fields::of(&value)?;
    Ok(match f.str("t")? {
        "cursor" => Record::Cursor(Seq(f.i64("seq")?)),
        "pending" => Record::Pending(PendingRow {
            ord: f.u64("ord")?,
            row: PendingOutgoing {
                message: decode_outgoing(&f)?,
                attempts: u8::try_from(f.i64("attempts")?).map_err(|_| bad("bad attempts"))?,
                next_attempt_at: f.ts("next")?,
                seal: decode_seal(f.get("seal"))?,
            },
        }),
        "sent" => Record::Sent(SentRow {
            ord: f.u64("ord")?,
            message: decode_outgoing(&f)?,
            edited_at: f.opt_ts("edited")?,
            reactions: decode_reactions(f.array("reactions")?)?,
        }),
        "message" => Record::Message(Box::new(decode_message(&f)?)),
        "receipts" => Record::Receipts(PeerReceipts {
            peer: f.login("peer")?,
            delivered_ts: f.opt_ts("delivered")?,
            read_ts: f.opt_ts("read")?,
        }),
        "backfill" => Record::Backfill(Backfill {
            peer: f.login("peer")?,
            owed: f
                .array("owed")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .and_then(|s| MessageId::parse(s).ok())
                        .ok_or(bad("bad owed id"))
                })
                .collect::<Result<_, _>>()?,
            reseed: match f.get("reseed") {
                None => None,
                Some(Value::String(s)) if s == "newest" => Some(WalkFrom::Newest),
                Some(v) => {
                    let b = Fields::of(v)?;
                    Some(WalkFrom::Below(Below {
                        id: b.id("id")?,
                        ts: b.ts("ts")?,
                    }))
                }
            },
        }),
        "own_read" => Record::OwnRead(OwnRead {
            peer: f.login("peer")?,
            read_ts: f.ts("read")?,
        }),
        "ack" => Record::Ack(OwedAck {
            peer: f.login("peer")?,
            id: f.id("id")?,
            ts: f.ts("ts")?,
        }),
        "account" => Record::Account(f.secret("pickle")?),
        "olm" => Record::Olm(OlmChannelRow {
            login: f.login("login")?,
            device: f.string("device")?,
            pickle: f.secret("pickle")?,
        }),
        "outbound" => Record::Outbound(OutboundRow {
            peer: f.login("peer")?,
            pickle: f.secret("pickle")?,
        }),
        "inbound" => Record::Inbound(InboundRow {
            sender: f.login("sender")?,
            device: f.string("device")?,
            session: f.string("session")?,
            pickle: f.secret("pickle")?,
        }),
        "to_device" => Record::ToDevice(ToDeviceRow {
            ord: f.u64("ord")?,
            row: PendingToDevice {
                id: f.string("id")?,
                to: f.login("to")?,
                device: f.string("device")?,
                body: f.string("body")?,
            },
        }),
        "encrypted" => Record::Encrypted(f.login("peer")?),
        "identity" => Record::Identity(PeerIdentity {
            peer: f.login("peer")?,
            master_key: f.string("masterKey")?,
            verified: f.bool("verified")?,
        }),
        "backup_key" => Record::BackupKey(f.secret("pickle")?),
        _ => return Err(bad("unknown table")),
    })
}

fn decode_receipt(raw: &str) -> Result<Receipt, KvError> {
    match raw {
        "queued" => Ok(Receipt::Queued),
        "sent" => Ok(Receipt::Sent),
        "delivered" => Ok(Receipt::Delivered),
        "read" => Ok(Receipt::Read),
        "failed" => Ok(Receipt::Failed),
        _ => Err(bad("bad receipt")),
    }
}

fn decode_outgoing(f: &Fields<'_>) -> Result<Outgoing, KvError> {
    Ok(Outgoing {
        extra: match f.get("extra") {
            None => Box::default(),
            Some(v) => Box::new(decode_extra(&Fields::of(v)?)?),
        },
        id: f.id("id")?,
        peer: f.login("peer")?,
        ts: f.ts("ts")?,
        text: f.string("text")?,
        image: decode_image(f.get("image"))?,
        receipt: decode_receipt(f.str("receipt")?)?,
    })
}

fn decode_reply(v: &Value) -> Result<Reply, KvError> {
    let r = Fields::of(v)?;
    Ok(Reply {
        id: r.id("id")?,
        from: r.login("from")?,
        text: r.string("text")?,
        media: r.opt_str("media")?.map(|m| decode_media(&m)).transpose()?,
    })
}

fn decode_forwarded(v: &Value) -> Result<Forwarded, KvError> {
    let r = Fields::of(v)?;
    Ok(Forwarded {
        login: match r.opt_str("login")? {
            None => None,
            Some(l) => Some(Login::parse(&l).map_err(|_| bad("bad forwarded login"))?),
        },
        name: r.opt_str("name")?,
    })
}

fn decode_wave(value: Option<&Value>) -> Result<Option<Vec<u8>>, KvError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let bars = value.as_array().ok_or(bad("bad waveform"))?;
    bars.iter()
        .map(|b| {
            b.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or(bad("bad waveform"))
        })
        .collect::<Result<Vec<u8>, KvError>>()
        .map(Some)
}

fn decode_extra(e: &Fields<'_>) -> Result<Extra, KvError> {
    let voice = match e.get("voice") {
        None => None,
        Some(v) => {
            let v = Fields::of(v)?;
            Some(OutVoice {
                data_url: v.string("url")?,
                duration_ms: u32::try_from(v.i64("ms")?).map_err(|_| bad("bad duration"))?,
                waveform: decode_wave(v.get("wave"))?.unwrap_or_default(),
            })
        }
    };
    Ok(Extra {
        reply_to: e.get("reply").map(decode_reply).transpose()?,
        forwarded_from: e.get("forwarded").map(decode_forwarded).transpose()?,
        voice,
        edit_of: e.opt_str("editOf")?.map(|id| MessageId::parse(&id).map_err(|_| bad("bad edit target"))).transpose()?,
    })
}

fn decode_image(value: Option<&Value>) -> Result<Option<Image>, KvError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let i = Fields::of(value)?;
    Ok(Some(Image {
        data_url: i.string("url")?,
        width: i.opt_i64("w")?,
        height: i.opt_i64("h")?,
    }))
}

fn decode_envelope(f: &Fields<'_>) -> Result<Envelope, KvError> {
    Ok(Envelope {
        dev: f.string("dev")?,
        sid: f.string("sid")?,
        ct: f.string("ct")?,
    })
}

fn decode_seal(value: Option<&Value>) -> Result<Seal, KvError> {
    match value {
        None => Ok(Seal::Undecided),
        Some(Value::String(s)) if s == "plain" => Ok(Seal::Plain),
        Some(v @ Value::Object(_)) => Ok(Seal::Encrypted(decode_envelope(&Fields::of(v)?)?)),
        Some(_) => Err(bad("bad seal")),
    }
}

fn decode_reactions(values: &[Value]) -> Result<Vec<Reaction>, KvError> {
    values
        .iter()
        .map(|v| {
            let r = Fields::of(v)?;
            Ok(Reaction {
                emoji: r.string("emoji")?,
                by: r
                    .array("by")?
                    .iter()
                    .map(|who| {
                        who.as_str()
                            .and_then(|s| Login::parse(s).ok())
                            .ok_or(bad("bad reaction login"))
                    })
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect()
}

fn decode_media(raw: &str) -> Result<MediaKind, KvError> {
    match raw {
        "image" => Ok(MediaKind::Image),
        "voice" => Ok(MediaKind::Voice),
        "file" => Ok(MediaKind::File),
        _ => Err(bad("bad reply media")),
    }
}

fn decode_message(f: &Fields<'_>) -> Result<Message, KvError> {
    let image = decode_image(f.get("image"))?;
    let voice = match f.get("voice") {
        None => None,
        Some(v) => {
            let i = Fields::of(v)?;
            let duration = match i.get("duration") {
                None => None,
                Some(d) => Some(d.as_f64().ok_or(bad("bad duration"))?),
            };
            Some(Voice {
                waveform: decode_wave(i.get("wave"))?,
                data_url: i.string("url")?,
                duration,
            })
        }
    };
    let reply_to = f.get("reply").map(decode_reply).transpose()?;
    let forwarded_from = f.get("forwarded").map(decode_forwarded).transpose()?;
    let buttons = f
        .array("buttons")?
        .iter()
        .map(|v| {
            let b = Fields::of(v)?;
            Ok(Button {
                id: b.string("id")?,
                label: b.string("label")?,
                value: b.string("value")?,
            })
        })
        .collect::<Result<_, KvError>>()?;
    let protection = match f.get("protection") {
        Some(Value::String(s)) if s == "plain" => Protection::Plain,
        Some(Value::String(s)) if s == "encrypted" => Protection::Encrypted,
        Some(v @ Value::Object(_)) => {
            let p = Fields::of(v)?;
            Protection::Sealed {
                envelope: decode_envelope(&p)?,
                waiting: p.bool("waiting")?,
            }
        }
        _ => return Err(bad("bad protection")),
    };
    Ok(Message {
        edit_of: f.opt_str("editOf")?.map(|id| MessageId::parse(&id).map_err(|_| bad("bad edit target"))).transpose()?,
        peer: f.login("peer")?,
        id: f.id("id")?,
        from: f.login("from")?,
        ts: f.ts("ts")?,
        kind: match f.str("kind")? {
            "human" => MessageKind::Human,
            "ai" => MessageKind::Ai,
            _ => return Err(bad("bad kind")),
        },
        text: f.string("text")?,
        author: f.opt_str("author")?,
        image,
        voice,
        reply_to,
        forwarded_from,
        buttons,
        media_dropped: f.bool("mediaDropped")?,
        edited_at: f.opt_ts("edited")?,
        reactions: decode_reactions(f.array("reactions")?)?,
        protection,
    })
}
