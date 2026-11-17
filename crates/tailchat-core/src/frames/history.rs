//! `GET /api/history`: the request the core asks the driver to make, and the
//! page it gets back.
//!
//! The page is the server's stored records (`accounts.js` `history`), read as
//! tolerantly as [`crate::frames::inner`] reads a live message: one unusable record is
//! counted in `messages.skipped` and costs nothing else. The core always asks
//! with `deleted=1`, so a message deleted for everyone comes back as a
//! tombstone (`deletedAt`) and a walk can tell "deleted" from "not here".

use std::fmt::{self, Write};

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};

use crate::api::{HistoryRequest, Message, MessageKind, Protection, Reaction};
use crate::error::CoreError;
use crate::ids::{MessageId, Ts};
use crate::login::Login;

use super::MAX_INBOUND;
use super::inner::{
    Button, Forwarded, Image, Reply, Voice, de_buttons, de_media, de_optional_string, de_text,
};
use super::lossy::{self, Lossy};
use super::num;

/// How many messages one walk step asks for: the server's own default page.
pub const HISTORY_PAGE: u16 = 200;

/// Longest emoji the server keeps, in UTF-16 units (`normalizeReactions`).
const EMOJI_MAX_UNITS: usize = 16;
/// Most people one emoji lists (`normalizeReactions`).
const REACTORS_MAX: usize = 100;

impl HistoryRequest {
    /// Path and query, relative to the cloud's base URL, e.g.
    /// `/api/history?peer=bob&limit=200&deleted=1`; `&e2ee=1` asks for
    /// envelopes instead of the server's stub text.
    pub fn path(&self) -> String {
        let mut path = format!(
            "/api/history?peer={}&limit={}&deleted=1",
            self.peer.as_str(),
            self.limit
        );
        if self.sealed {
            path.push_str("&e2ee=1");
        }
        if let Some(below) = &self.below {
            // Writing into a String cannot fail.
            let _ = write!(path, "&before={}&beforeId=", below.ts.0);
            percent_encode(below.id.as_str(), &mut path);
        }
        path
    }
}

/// One `/api/history` answer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HistoryPage {
    /// The records, oldest first.
    #[serde(default)]
    pub messages: Lossy<HistoryRecord>,
    /// How far the peer has read; `0` on the wire means "nothing".
    #[serde(default, rename = "peerReadTs", deserialize_with = "de_position")]
    pub peer_read_ts: Option<Ts>,
    /// How far the peer's device holds the conversation.
    #[serde(default, rename = "peerDeliveredTs", deserialize_with = "de_position")]
    pub peer_delivered_ts: Option<Ts>,
}

impl HistoryPage {
    /// Entries the server sent, readable or not: what decides whether the
    /// page was full.
    pub fn len(&self) -> usize {
        self.messages
            .items
            .len()
            .saturating_add(self.messages.skipped)
    }

    /// Whether the server sent no entries at all.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One stored message (`normalizeMessage`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HistoryRecord {
    /// Its id.
    pub id: MessageId,
    /// Who wrote it.
    pub from: Login,
    /// The server's time for it.
    #[serde(deserialize_with = "num::de_ts")]
    pub ts: Ts,
    /// The text.
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    /// Person or assistant.
    #[serde(default, deserialize_with = "de_kind")]
    pub kind: MessageKind,
    /// The display name the author claimed.
    #[serde(default, deserialize_with = "de_optional_string")]
    pub author: Option<String>,
    /// An inline picture.
    #[serde(default, deserialize_with = "de_media")]
    pub image: Option<Image>,
    /// An inline voice note.
    #[serde(default, deserialize_with = "de_media")]
    pub voice: Option<Voice>,
    /// The quoted message.
    #[serde(default, rename = "replyTo", deserialize_with = "de_media")]
    pub reply_to: Option<Reply>,
    /// Who said it before it was forwarded.
    #[serde(default, rename = "forwardedFrom", deserialize_with = "de_media")]
    pub forwarded_from: Option<Forwarded>,
    /// Buttons a bot offers.
    #[serde(default, deserialize_with = "de_buttons")]
    pub buttons: Lossy<Button>,
    /// The attachment was evicted for good.
    #[serde(default, rename = "mediaDropped", deserialize_with = "de_flag")]
    pub media_dropped: bool,
    /// When the text was last edited.
    #[serde(default, rename = "editedAt", deserialize_with = "num::de_opt_ts")]
    pub edited_at: Option<Ts>,
    /// Set when the message was deleted for everyone: a tombstone.
    #[serde(default, rename = "deletedAt", deserialize_with = "num::de_opt_ts")]
    pub deleted_at: Option<Ts>,
    /// The reactions, in the server's order.
    #[serde(default, deserialize_with = "de_reactions")]
    pub reactions: Vec<Reaction>,
    /// The `e2ee` envelope of an encrypted message (asked with `e2ee=1`).
    #[serde(default)]
    pub e2ee: Option<serde_json::Value>,
}

impl HistoryRecord {
    /// The row this record becomes in conversation `peer`.
    pub(crate) fn into_message(self, peer: Login) -> Message {
        Message {
            edit_of: None,
            peer,
            id: self.id,
            from: self.from,
            ts: self.ts,
            kind: self.kind,
            text: self.text,
            author: self.author,
            image: self.image,
            voice: self.voice,
            reply_to: self.reply_to,
            forwarded_from: self.forwarded_from,
            buttons: self.buttons.items,
            media_dropped: self.media_dropped,
            edited_at: self.edited_at,
            reactions: self.reactions,
            protection: Protection::Plain,
        }
    }
}

/// Reads one history answer, refusing an oversized body before parsing it.
pub fn decode_history(raw: &str) -> Result<HistoryPage, CoreError> {
    if raw.len() > MAX_INBOUND {
        return Err(CoreError::FrameTooLarge {
            len: raw.len(),
            max: MAX_INBOUND,
        });
    }
    serde_json::from_str(raw).map_err(|error| CoreError::BadFrame(error.to_string()))
}

/// Percent-encodes everything but RFC 3986 unreserved characters.
fn percent_encode(raw: &str, out: &mut String) {
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            // Writing into a String cannot fail.
            let _ = write!(out, "%{byte:02X}");
        }
    }
}

/// `"ai"` is the assistant; anything else, or nothing, is a person.
fn de_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<MessageKind, D::Error> {
    let raw: Option<String> = lossy::lenient(deserializer)?;
    Ok(match raw.as_deref() {
        Some("ai") => MessageKind::Ai,
        _ => MessageKind::Human,
    })
}

/// A flag that is only `true` when the wire says exactly `true`.
fn de_flag<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(lossy::lenient::<_, bool>(deserializer)?.unwrap_or(false))
}

/// A watermark: `0`, negative, missing or unreadable all mean "none".
fn de_position<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Ts>, D::Error> {
    Ok(num::de_opt_ts(deserializer)?.filter(|ts| ts.0 > 0))
}

/// `{ "👍": ["bob", "carol"], … }`, keeping the server's order. An entry that
/// is not a list, an emoji the server would not store, and a name that is not
/// a login are each dropped alone.
fn de_reactions<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Reaction>, D::Error> {
    Ok(lossy::lenient::<_, ReactionsOf>(deserializer)?
        .map(|reactions| reactions.0)
        .unwrap_or_default())
}

/// The reactions object, read entry by entry by [`ReactionsMap`].
struct ReactionsOf(Vec<Reaction>);

impl<'de> Deserialize<'de> for ReactionsOf {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(ReactionsMap).map(Self)
    }
}

/// Reads a value of any shape, keeping it only when it is a list.
struct LenientSeed;

impl<'de> serde::de::DeserializeSeed<'de> for LenientSeed {
    type Value = Option<Lossy<String>>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        lossy::lenient(deserializer)
    }
}

/// Visits the reactions object entry by entry, in the server's order.
struct ReactionsMap;

impl<'de> Visitor<'de> for ReactionsMap {
    type Value = Vec<Reaction>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an object of emoji to logins")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut reactions = Vec::new();
        while let Some(emoji) = map.next_key::<String>()? {
            let Some(members) = map.next_value_seed(LenientSeed)? else {
                continue;
            };
            let units = emoji.encode_utf16().count();
            if units == 0 || units > EMOJI_MAX_UNITS {
                continue;
            }
            let mut by: Vec<Login> = Vec::new();
            for raw in members.items {
                if by.len() >= REACTORS_MAX {
                    break;
                }
                if let Ok(login) = Login::parse(&raw)
                    && !by.contains(&login)
                {
                    by.push(login);
                }
            }
            if !by.is_empty() {
                reactions.push(Reaction { emoji, by });
            }
        }
        Ok(reactions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Below;

    fn request(below: Option<Below>) -> HistoryRequest {
        HistoryRequest {
            serial: 1,
            peer: Login::parse("bob").unwrap(),
            below,
            limit: HISTORY_PAGE,
            sealed: false,
        }
    }

    #[test]
    fn the_newest_page_asks_for_tombstones_too() {
        assert_eq!(
            request(None).path(),
            "/api/history?peer=bob&limit=200&deleted=1"
        );
    }

    #[test]
    fn a_message_id_below_is_percent_encoded() {
        let below = Below {
            id: MessageId::parse("id from a bot&x=1/ё").unwrap(),
            ts: Ts(1_793_622_386_663),
        };
        assert_eq!(
            request(Some(below)).path(),
            "/api/history?peer=bob&limit=200&deleted=1&before=1793622386663\
             &beforeId=id%20from%20a%20bot%26x%3D1%2F%D1%91"
        );
    }

    #[test]
    fn a_device_that_decrypts_asks_for_envelopes() {
        let mut sealed = request(None);
        sealed.sealed = true;
        assert_eq!(
            sealed.path(),
            "/api/history?peer=bob&limit=200&deleted=1&e2ee=1"
        );
    }

    #[test]
    fn one_unreadable_record_costs_only_itself_and_still_counts() {
        let page = decode_history(
            r#"{"messages":[
                {"id":"m1","from":"bob","ts":1.5,"text":"hi","kind":"ai","editedAt":3,
                 "reactions":{"👍":["bob","Carol","not a login","bob"],"":["bob"],"x":7}},
                {"id":"","from":"bob","ts":2},
                {"id":"m3","from":"bob","ts":4,"deletedAt":5,"text":""}
            ],"peerReadTs":0,"peerDeliveredTs":1793622386663}"#,
        )
        .unwrap();
        assert_eq!(page.len(), 3, "the full-page test counts what was skipped");
        assert_eq!(page.messages.skipped, 1);
        let first = &page.messages.items[0];
        assert_eq!(
            (first.ts, first.kind, first.edited_at),
            (Ts(1), MessageKind::Ai, Some(Ts(3)))
        );
        assert_eq!(first.reactions.len(), 1);
        let who: Vec<&str> = first.reactions[0].by.iter().map(Login::as_str).collect();
        assert_eq!(who, ["bob", "carol"]);
        assert_eq!(page.messages.items[1].deleted_at, Some(Ts(5)));
        assert_eq!(page.peer_read_ts, None, "0 is no position");
        assert_eq!(page.peer_delivered_ts, Some(Ts(1_793_622_386_663)));
    }

    #[test]
    fn an_oversized_body_is_refused_before_parsing() {
        let body = " ".repeat(MAX_INBOUND + 1);
        assert!(matches!(
            decode_history(&body),
            Err(CoreError::FrameTooLarge { .. })
        ));
    }
}
