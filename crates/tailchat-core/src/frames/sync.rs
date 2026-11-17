//! The resumable account feed: `sync-page` and the events in it.
//!
//! One page is `{ k: "sync-page", events: [...], cursor, more, reset }`
//! (`accounts.js` `eventsSince`). Each event says one durable change happened
//! in one conversation; `seq` orders them across the account.

use serde::Deserialize;

use crate::ids::{MessageId, Seq, Ts};
use crate::login::Login;

use super::inner::{self, Scope};
use super::lossy::Lossy;
use super::num;

/// How many events one page may hold (`EVENT_PAGE_MAX`, `accounts.js`).
pub const SYNC_PAGE_MAX: usize = 500;

/// How many events the server keeps per account (`EVENT_LIMIT`): a cursor
/// older than that cannot be resumed, only re-seeded (`reset`).
pub const SYNC_EVENTS_MAX: usize = 2000;

/// One `sync-page` envelope.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct SyncPage {
    /// The events, oldest first. An entry that cannot be read is counted in
    /// `events.skipped` and costs nothing else on the page.
    #[serde(default)]
    pub events: Lossy<SyncEvent>,
    /// The newest event the page covers; ask for the next page from here.
    #[serde(default, deserialize_with = "num::de_seq")]
    pub cursor: Seq,
    /// Whether more events are waiting right now.
    #[serde(default)]
    pub more: bool,
    /// Whether `cursor` was older than anything the server still keeps: the
    /// feed cannot close that gap and the conversation must be re-seeded from
    /// `/api/history`.
    #[serde(default)]
    pub reset: bool,
}

impl SyncPage {
    /// Whether the page could be read cleanly: no event was dropped.
    pub fn is_clean(&self) -> bool {
        self.events.skipped == 0
    }
}

/// One durable change in one conversation.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SyncEvent {
    /// Position in the account's feed.
    #[serde(deserialize_with = "num::de_seq")]
    pub seq: Seq,
    /// What kind of change it is.
    #[serde(default)]
    pub kind: SyncKind,
    /// The conversation it happened in.
    pub peer: Login,
    /// The message it is about, when it names one.
    #[serde(default, deserialize_with = "inner::de_opt_message_id")]
    pub id: Option<MessageId>,
    /// The message's or the edit's time.
    #[serde(default, deserialize_with = "num::de_opt_ts")]
    pub ts: Option<Ts>,
    /// Who wrote the message (a `message` event only).
    #[serde(default, deserialize_with = "inner::de_optional_login")]
    pub from: Option<Login>,
    /// Whether this account is the author: the wire calls it `self`.
    #[serde(default, rename = "self")]
    pub own: bool,
    /// The new text of an `edit`.
    #[serde(default)]
    pub text: Option<String>,
    /// The emoji of a `react`.
    #[serde(default)]
    pub emoji: Option<String>,
    /// Who reacted.
    #[serde(default, deserialize_with = "inner::de_optional_login")]
    pub by: Option<Login>,
    /// Whether the reaction was added or removed.
    #[serde(default)]
    pub add: Option<bool>,
    /// The messages a `delete` names.
    #[serde(default, deserialize_with = "inner::de_message_ids")]
    pub ids: Lossy<MessageId>,
    /// Whether a `delete` is for both sides or one.
    #[serde(default)]
    pub scope: Option<Scope>,
    /// How far the reader got (`read` only).
    #[serde(default, rename = "readTs", deserialize_with = "num::de_opt_ts")]
    pub read_ts: Option<Ts>,
    /// When the reader got there, in their wall clock.
    #[serde(default, rename = "readAt", deserialize_with = "num::de_opt_ts")]
    pub read_at: Option<Ts>,
    /// The kind of client that read it.
    #[serde(default)]
    pub via: Option<String>,
}

/// What a [`SyncEvent`] says happened.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SyncKind {
    /// A message was committed.
    Message,
    /// A message's text changed.
    Edit,
    /// Messages were deleted or hidden.
    Delete,
    /// An emoji was toggled.
    React,
    /// A read watermark moved.
    Read,
    /// A kind this core does not know: a newer server's change, and also what
    /// an event with no `kind` at all reads as. Ignored.
    #[default]
    Other,
}

impl<'de> Deserialize<'de> for SyncKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw: Option<String> = crate::frames::lossy::lenient(deserializer)?;
        let Some(raw) = raw else {
            return Ok(Self::Other);
        };
        Ok(match raw.as_str() {
            "message" => Self::Message,
            "edit" => Self::Edit,
            "delete" => Self::Delete,
            "react" => Self::React,
            "read" => Self::Read,
            _ => Self::Other,
        })
    }
}
