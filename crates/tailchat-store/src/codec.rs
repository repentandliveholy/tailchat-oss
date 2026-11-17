//! How core values become columns and come back. Everything read back is
//! checked again (`Login::parse`, `MessageId::parse`): a damaged file is a
//! [`Error::Corrupt`], never a value the core's types promise cannot exist.

use serde_json::{Map, Value, json};
use tailchat_core::frames::inner::{Button, Forwarded, MediaKind, Reply, WAVEFORM_MAX};
use tailchat_core::{Envelope, Extra, Login, OutVoice, MessageId, MessageKind, Protection, Reaction, Receipt, Seal};

use crate::Error;

/// The error for a column whose contents break the type it holds.
pub(crate) fn corrupt(table: &'static str, reason: &'static str) -> Error {
    Error::Corrupt { table, reason }
}

/// A login read back from `table`.
pub(crate) fn login(table: &'static str, raw: &str) -> Result<Login, Error> {
    Login::parse(raw).map_err(|_| corrupt(table, "bad login"))
}

/// A message id read back from `table`.
pub(crate) fn message_id(table: &'static str, raw: &str) -> Result<MessageId, Error> {
    MessageId::parse(raw).map_err(|_| corrupt(table, "bad message id"))
}

/// The column text of a receipt rung.
pub(crate) fn receipt_text(receipt: Receipt) -> &'static str {
    match receipt {
        Receipt::Queued => "queued",
        Receipt::Sent => "sent",
        Receipt::Delivered => "delivered",
        Receipt::Read => "read",
        Receipt::Failed => "failed",
    }
}

/// A receipt rung read back from `table`.
pub(crate) fn receipt(table: &'static str, raw: &str) -> Result<Receipt, Error> {
    match raw {
        "queued" => Ok(Receipt::Queued),
        "sent" => Ok(Receipt::Sent),
        "delivered" => Ok(Receipt::Delivered),
        "read" => Ok(Receipt::Read),
        "failed" => Ok(Receipt::Failed),
        _ => Err(corrupt(table, "bad receipt")),
    }
}

/// The column text of a message kind.
pub(crate) fn kind_text(kind: MessageKind) -> &'static str {
    match kind {
        MessageKind::Human => "human",
        MessageKind::Ai => "ai",
    }
}

/// A message kind read back.
pub(crate) fn kind(raw: &str) -> Result<MessageKind, Error> {
    match raw {
        "human" => Ok(MessageKind::Human),
        "ai" => Ok(MessageKind::Ai),
        _ => Err(corrupt("messages", "bad kind")),
    }
}

/// The four columns of an envelope: kind, `dev`, `sid`, `ct`.
pub(crate) type EnvelopeColumns<'a> = (
    Option<&'static str>,
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
);

fn envelope_columns<'a>(kind: &'static str, e: &'a Envelope) -> EnvelopeColumns<'a> {
    (
        Some(kind),
        Some(e.dev.as_str()),
        Some(e.sid.as_str()),
        Some(e.ct.as_str()),
    )
}

/// A queue row's seal as `seal, seal_dev, seal_sid, seal_ct`.
pub(crate) fn seal_columns(seal: &Seal) -> EnvelopeColumns<'_> {
    match seal {
        Seal::Undecided => (None, None, None, None),
        Seal::Plain => (Some("plain"), None, None, None),
        Seal::Encrypted(e) => envelope_columns("encrypted", e),
    }
}

/// A seal read back from the queue.
pub(crate) fn seal(
    kind: Option<String>,
    dev: Option<String>,
    sid: Option<String>,
    ct: Option<String>,
) -> Result<Seal, Error> {
    match (kind.as_deref(), dev, sid, ct) {
        (None, None, None, None) => Ok(Seal::Undecided),
        (Some("plain"), None, None, None) => Ok(Seal::Plain),
        (Some("encrypted"), Some(dev), Some(sid), Some(ct)) => {
            Ok(Seal::Encrypted(Envelope { dev, sid, ct }))
        }
        _ => Err(corrupt("pending", "bad seal")),
    }
}

/// A row's protection as `protection, env_dev, env_sid, env_ct`; the first
/// is never null (`plain` is the column default).
pub(crate) fn protection_columns(protection: &Protection) -> EnvelopeColumns<'_> {
    match protection {
        Protection::Plain => (Some("plain"), None, None, None),
        Protection::Encrypted => (Some("encrypted"), None, None, None),
        Protection::Sealed {
            envelope,
            waiting: true,
        } => envelope_columns("waiting", envelope),
        Protection::Sealed {
            envelope,
            waiting: false,
        } => envelope_columns("refused", envelope),
    }
}

/// A protection read back from `messages`.
pub(crate) fn protection(
    kind: &str,
    dev: Option<String>,
    sid: Option<String>,
    ct: Option<String>,
) -> Result<Protection, Error> {
    match (kind, dev, sid, ct) {
        ("plain", None, None, None) => Ok(Protection::Plain),
        ("encrypted", None, None, None) => Ok(Protection::Encrypted),
        (waiting @ ("waiting" | "refused"), Some(dev), Some(sid), Some(ct)) => {
            Ok(Protection::Sealed {
                envelope: Envelope { dev, sid, ct },
                waiting: waiting == "waiting",
            })
        }
        _ => Err(corrupt("messages", "bad protection")),
    }
}

/// The column text of a quoted attachment's kind: the server's own words.
pub(crate) fn media_text(media: MediaKind) -> &'static str {
    match media {
        MediaKind::Image => "image",
        MediaKind::Voice => "voice",
        MediaKind::File => "file",
    }
}

/// A quoted attachment's kind read back.
pub(crate) fn media(raw: &str) -> Result<MediaKind, Error> {
    match raw {
        "image" => Ok(MediaKind::Image),
        "voice" => Ok(MediaKind::Voice),
        "file" => Ok(MediaKind::File),
        _ => Err(corrupt("messages", "bad reply media")),
    }
}

/// Reactions as JSON: `[[emoji, [login, …]], …]`, in their order.
pub(crate) fn reactions_json(reactions: &[Reaction]) -> Result<String, Error> {
    let rows: Vec<(&str, Vec<&str>)> = reactions
        .iter()
        .map(|r| (r.emoji.as_str(), r.by.iter().map(Login::as_str).collect()))
        .collect();
    Ok(serde_json::to_string(&rows)?)
}

/// Reactions read back from `table`.
pub(crate) fn reactions(table: &'static str, raw: &str) -> Result<Vec<Reaction>, Error> {
    let rows: Vec<(String, Vec<String>)> =
        serde_json::from_str(raw).map_err(|_| corrupt(table, "bad reactions"))?;
    rows.into_iter()
        .map(|(emoji, by)| {
            let by = by
                .iter()
                .map(|who| login(table, who))
                .collect::<Result<_, _>>()?;
            Ok(Reaction { emoji, by })
        })
        .collect()
}

/// Buttons as JSON: `[[id, label, value], …]`.
pub(crate) fn buttons_json(buttons: &[Button]) -> Result<String, Error> {
    let rows: Vec<(&str, &str, &str)> = buttons
        .iter()
        .map(|b| (b.id.as_str(), b.label.as_str(), b.value.as_str()))
        .collect();
    Ok(serde_json::to_string(&rows)?)
}

/// Buttons read back.
pub(crate) fn buttons(raw: &str) -> Result<Vec<Button>, Error> {
    let rows: Vec<(String, String, String)> =
        serde_json::from_str(raw).map_err(|_| corrupt("messages", "bad buttons"))?;
    Ok(rows
        .into_iter()
        .map(|(id, label, value)| Button { id, label, value })
        .collect())
}

/// Owed message ids as a JSON array of strings, in their order.
pub(crate) fn ids_json(ids: &[MessageId]) -> Result<String, Error> {
    let rows: Vec<&str> = ids.iter().map(MessageId::as_str).collect();
    Ok(serde_json::to_string(&rows)?)
}

/// Owed message ids read back.
pub(crate) fn ids(raw: &str) -> Result<Vec<MessageId>, Error> {
    let rows: Vec<String> =
        serde_json::from_str(raw).map_err(|_| corrupt("backfill", "bad owed ids"))?;
    rows.iter().map(|id| message_id("backfill", id)).collect()
}

/// The same toggle `MemStore` makes: `by` leaves the emoji, and comes back at
/// the end of its list when `add`; an emoji nobody has any more goes, a new
/// one joins at the end.
pub(crate) fn react(reactions: &mut Vec<Reaction>, emoji: &str, by: &Login, add: bool) {
    match reactions.iter().position(|r| r.emoji == emoji) {
        Some(index) => {
            if let Some(entry) = reactions.get_mut(index) {
                entry.by.retain(|who| who != by);
                if add {
                    entry.by.push(by.clone());
                }
                if entry.by.is_empty() {
                    reactions.remove(index);
                }
            }
        }
        None if add => reactions.push(Reaction {
            emoji: emoji.to_owned(),
            by: vec![by.clone()],
        }),
        None => {}
    }
}

/// The `extra` column of an outgoing row: `NULL` when there is nothing
/// besides text and picture, otherwise JSON with only the parts present.
pub(crate) fn extra_json(extra: &Extra) -> Result<Option<String>, Error> {
    if extra.is_empty() {
        return Ok(None);
    }
    let mut out = Map::new();
    if let Some(reply) = &extra.reply_to {
        let mut value = json!({"id": reply.id.as_str(), "from": reply.from.as_str(), "text": reply.text});
        if let (Some(media), Value::Object(map)) = (reply.media, &mut value) {
            map.insert("media".into(), Value::from(media_text(media)));
        }
        out.insert("replyTo".into(), value);
    }
    if let Some(forwarded) = &extra.forwarded_from {
        out.insert(
            "forwardedFrom".into(),
            json!({"login": forwarded.login.as_ref().map(Login::as_str), "name": forwarded.name}),
        );
    }
    if let Some(voice) = &extra.voice {
        out.insert(
            "voice".into(),
            json!({"dataUrl": voice.data_url, "durationMs": voice.duration_ms, "waveform": voice.waveform}),
        );
    }
    if let Some(target) = &extra.edit_of {
        out.insert("editOf".into(), Value::from(target.as_str()));
    }
    serde_json::to_string(&Value::Object(out))
        .map(Some)
        .map_err(|_| corrupt("extra", "not serializable"))
}

/// An outgoing row's `extra` column read back from `table`.
pub(crate) fn extra(table: &'static str, raw: Option<&str>) -> Result<Box<Extra>, Error> {
    let Some(raw) = raw else {
        return Ok(Box::default());
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| corrupt(table, "bad extra"))?;
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
    let reply_to = match value.get("replyTo") {
        Some(reply) => Some(Reply {
            id: message_id(table, &text(reply, "id").unwrap_or_default())?,
            from: login(table, &text(reply, "from").unwrap_or_default())?,
            text: text(reply, "text").unwrap_or_default(),
            media: text(reply, "media").as_deref().map(media).transpose()?,
        }),
        None => None,
    };
    let forwarded_from = match value.get("forwardedFrom") {
        Some(forwarded) => Some(Forwarded {
            login: text(forwarded, "login")
                .as_deref()
                .map(|raw| login(table, raw))
                .transpose()?,
            name: text(forwarded, "name"),
        }),
        None => None,
    };
    let voice = match value.get("voice") {
        Some(voice) => Some(OutVoice {
            data_url: text(voice, "dataUrl").ok_or_else(|| corrupt(table, "voice without data"))?,
            duration_ms: voice
                .get("durationMs")
                .and_then(Value::as_u64)
                .and_then(|ms| u32::try_from(ms).ok())
                .unwrap_or(0),
            waveform: wave_values(voice.get("waveform")),
        }),
        None => None,
    };
    let edit_of = text(&value, "editOf")
        .as_deref()
        .map(|raw| message_id(table, raw))
        .transpose()?;
    Ok(Box::new(Extra {
        reply_to,
        forwarded_from,
        voice,
        edit_of,
    }))
}

/// The `voice_wave` column of a conversation row.
pub(crate) fn waveform_json(wave: Option<&Vec<u8>>) -> Option<String> {
    wave.and_then(|wave| serde_json::to_string(wave).ok())
}

/// A conversation row's `voice_wave` column read back.
pub(crate) fn waveform(raw: Option<&str>) -> Result<Option<Vec<u8>>, Error> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value: Value =
        serde_json::from_str(raw).map_err(|_| corrupt("messages", "bad waveform"))?;
    Ok(Some(wave_values(Some(&value))))
}

/// Bars 0–255 from a JSON list; anything else is skipped.
fn wave_values(value: Option<&Value>) -> Vec<u8> {
    value
        .and_then(Value::as_array)
        .map(|bars| {
            bars.iter()
                .take(WAVEFORM_MAX)
                .filter_map(|bar| bar.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect()
        })
        .unwrap_or_default()
}
