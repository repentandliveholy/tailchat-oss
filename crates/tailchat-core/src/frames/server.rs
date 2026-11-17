//! Every server-to-client envelope, keyed by `k`.
//!
//! What the server sends is listed in `src/cloud/hub.js`; the shapes here are
//! captured from a live server (`tests/fixtures/frames.json`). The envelope is
//! the server's own statement, so its fields are typed strictly; whatever a
//! peer wrote inside a relayed `frame` is typed in [`crate::frames::inner`], as
//! tolerantly as the server's own store reads it.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::ids::{MessageId, Seq, Ts};
use crate::login::Login;

use super::inner::{self, Inner, MediaKind};
use super::lossy::{self, Lossy};
use super::num;
use super::sync::SyncPage;

/// One frame from the server.
///
/// An envelope this core has no type for is [`ServerFrame::Other`], never an
/// error: a newer server may say more than this client knows (spec §3).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "k", rename_all = "kebab-case")]
pub enum ServerFrame {
    /// Authenticated: who we are, the roster, and what the server supports.
    Ready(Ready),
    /// The roster, again, after somebody's presence or badge changed.
    Users(Roster),
    /// A peer's presence moved.
    Presence(Presence),
    /// The answer to `subscribe`: the conversation is now this socket's.
    Subscribed(Subscribed),
    /// One relayed inner frame from `from`.
    Frame(Relayed),
    /// The server committed one of our messages.
    MessageAccepted(Accepted),
    /// The server applied a read receipt we sent (`read-ack-v1`).
    ReadAccepted(ReadAccepted),
    /// The server applied an edit, reaction or delete (`op-ack-v1`).
    OpAccepted(OpAccepted),
    /// A page of the account's durable feed.
    SyncPage(SyncPage),
    /// "Your feed moved": ask for a `sync-page`.
    SyncNudge,
    /// This account read a conversation from another of its devices.
    ReadSync(ReadSync),
    /// This account reacted to something from another of its devices.
    ReactSync(ReactSync),
    /// A message arrived for a conversation this socket is not showing.
    Unread(Unread),
    /// The newest message of a conversation this browser tab is not showing.
    ConversationUpdate(ConversationUpdate),
    /// A mutation, to every `webFeatures` session of both sides.
    MessageEvent(MessageEvent),
    /// This account's own name changed (all of its sessions).
    Profile(Profile),
    /// A reply reminder was set on a message.
    ReplyReminderSet {
        /// The reminder itself.
        reminder: Reminder,
    },
    /// A reply reminder came due.
    ReplyReminderFired {
        /// The reminder itself, now with `firedAt`.
        reminder: Reminder,
    },
    /// A reminder was dismissed.
    ReplyReminderAcked {
        /// Which reminder.
        id: String,
    },
    /// A conversation was marked unread from a device that asked to.
    MarkUnreadAccepted {
        /// The conversation.
        peer: Login,
    },
    /// A key message for this device (`e2ee-v1`), held until acknowledged.
    ToDevice(super::e2ee::ToDeviceIn),
    /// The server stored one of our key messages.
    ToDeviceAccepted(super::e2ee::ToDeviceAccepted),
    /// The devices of `login` changed: ask again before encrypting to them.
    DeviceListChanged {
        /// Whose devices.
        login: Login,
    },
    /// This socket is over its frame budget; the server dropped the frame.
    Throttle(Throttle),
    /// The server refused something.
    Error(ServerError),
    /// An envelope this core has no type for.
    #[serde(other)]
    Other,
}

/// `k: "ready"`: the socket is authenticated.
///
/// Every field is optional so that an older server, or one that sends a
/// narrower roster, still makes the connection usable.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Ready {
    /// Who this socket is signed in as.
    #[serde(default, rename = "self")]
    pub me: Option<SelfInfo>,
    /// The friends this account can talk to.
    #[serde(default)]
    pub users: Lossy<User>,
    /// What the server implements (`SERVER_CAPS`).
    #[serde(default)]
    pub caps: Lossy<String>,
}

impl Ready {
    /// Whether the server claims `cap` (`sync-v1`, `durable-ack`, …).
    pub fn has_cap(&self, cap: &str) -> bool {
        self.caps.items.iter().any(|item| item == cap)
    }
}

/// `k: "users"`: the roster.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Roster {
    /// One entry per friend, with this account's own badges.
    #[serde(default)]
    pub users: Lossy<User>,
}

/// One friend, as this account's roster shows them.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct User {
    /// Their login.
    pub login: Login,
    /// Their display name.
    #[serde(default)]
    pub name: String,
    /// Whether they have a socket that is somebody being there.
    #[serde(default)]
    pub online: bool,
    /// How present that socket is.
    #[serde(default, deserialize_with = "de_presence")]
    pub state: Option<PresenceState>,
    /// When they were last here, in milliseconds.
    #[serde(default, rename = "lastSeen", deserialize_with = "num::de_opt_ts")]
    pub last_seen: Option<Ts>,
    /// Unread messages waiting for this account from them.
    #[serde(default, deserialize_with = "num::de_opt_u32")]
    pub pending: Option<u32>,
    /// Whether a call would reach them.
    #[serde(default)]
    pub callable: bool,
    /// The nickname this account gave them (nobody else sees it).
    #[serde(default)]
    pub alias: Option<String>,
    /// The newest message of the conversation, for the roster line.
    #[serde(default)]
    pub last: Option<Preview>,
    /// Unread reactions on their messages.
    #[serde(default, rename = "reactionEvents")]
    pub reaction_events: Lossy<ReactionEvent>,
    /// Whether the account is run by the server itself.
    #[serde(default)]
    pub official: bool,
    /// Whether the account is a program rather than a person.
    #[serde(default)]
    pub bot: bool,
    /// Whether this account has blocked them.
    #[serde(default)]
    pub blocked: bool,
}

impl User {
    /// What to show for them: the private nickname outranks the chosen name.
    pub fn shown_name(&self) -> &str {
        match &self.alias {
            Some(alias) if !alias.is_empty() => alias,
            _ => &self.name,
        }
    }
}

/// The newest message of a conversation, as a roster line shows it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Preview {
    /// The message.
    pub id: MessageId,
    /// Who wrote it.
    pub from: Login,
    /// When.
    #[serde(deserialize_with = "num::de_ts")]
    pub ts: Ts,
    /// A message or an assistant's answer.
    #[serde(default, deserialize_with = "de_preview_kind")]
    pub kind: PreviewKind,
    /// Its text.
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    /// What attachment it had, if any.
    #[serde(default)]
    pub media: Option<MediaKind>,
    /// The name the author is shown under.
    #[serde(default, deserialize_with = "de_optional_text")]
    pub author: Option<String>,
}

/// Whether a message came from a person or the assistant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PreviewKind {
    /// A person's message.
    #[default]
    Human,
    /// The assistant's answer.
    Ai,
}

/// One unread reaction on a message of this account's.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReactionEvent {
    /// The reaction's own id, for acknowledging it.
    pub id: String,
    /// Who reacted.
    pub by: Login,
    /// The emoji.
    pub emoji: String,
    /// When.
    #[serde(deserialize_with = "num::de_ts")]
    pub ts: Ts,
    /// Whether it has been seen.
    #[serde(default)]
    pub read: bool,
    /// The message it is on.
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}

/// Who this socket is.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SelfInfo {
    /// The login.
    pub login: Login,
    /// The display name.
    #[serde(default)]
    pub name: String,
    /// Whether the account has an additional password set.
    #[serde(default, rename = "extraPasswordEnabled")]
    pub extra_password_enabled: bool,
}

/// How present an account is (`src/presence.js`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceState {
    /// At the screen.
    Active,
    /// At the machine but not looking at this conversation.
    Idle,
    /// Gone.
    Away,
}

impl PresenceState {
    /// The wire word for this state.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Idle => "idle",
            Self::Away => "away",
        }
    }
}

/// `k: "presence"`: a peer's presence moved.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Presence {
    /// Whose presence.
    pub peer: Login,
    /// Whether they are there at all.
    #[serde(default)]
    pub online: bool,
    /// How present they are, when the server says.
    #[serde(default, deserialize_with = "de_presence")]
    pub state: Option<PresenceState>,
}

/// `k: "subscribed"`: the answer to `subscribe`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Subscribed {
    /// The conversation this socket now shows.
    pub peer: Login,
    /// Whether the peer is there.
    #[serde(default)]
    pub online: bool,
    /// How present they are.
    #[serde(default, deserialize_with = "de_presence")]
    pub state: Option<PresenceState>,
    /// Queued messages the server handed over just before this frame.
    #[serde(default, deserialize_with = "num::de_opt_u32")]
    pub pending: Option<u32>,
    /// Whether a call would reach them.
    #[serde(default)]
    pub callable: bool,
}

/// `k: "frame"`: one inner frame relayed from `from`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Relayed {
    /// The peer whose conversation this frame belongs to. For a frame from
    /// another device of this account it is the peer of that conversation,
    /// not this account (`selfSync`, `hub.js`).
    pub from: Login,
    /// Whether this account wrote it: the wire calls it `self`.
    #[serde(default, rename = "self")]
    pub own: bool,
    /// The frame itself.
    pub d: Inner,
}

/// `k: "message-accepted"`: the server committed one of our messages.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Accepted {
    /// The conversation.
    pub peer: Login,
    /// The message.
    pub id: MessageId,
    /// The time it was stored under; the server may have replaced ours.
    #[serde(deserialize_with = "num::de_ts")]
    pub ts: Ts,
    /// Its position in the feed, when the record carries one (records written
    /// before the feed existed do not).
    #[serde(default, deserialize_with = "num::de_opt_seq")]
    pub seq: Option<Seq>,
}

/// `k: "read-accepted"`: the server applied a read receipt we sent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReadAccepted {
    /// The conversation.
    pub peer: Login,
    /// The message, or `null` for a whole-conversation `mark-read`.
    #[serde(default, deserialize_with = "inner::de_opt_message_id")]
    pub id: Option<MessageId>,
    /// How far the account has read.
    #[serde(rename = "readTs", deserialize_with = "num::de_ts")]
    pub read_ts: Ts,
    /// When the reader got there.
    #[serde(default, rename = "readAt", deserialize_with = "num::de_opt_ts")]
    pub read_at: Option<Ts>,
    /// The kind of client that read it.
    #[serde(default)]
    pub via: Option<String>,
}

/// What kind of mutation an `op-accepted` confirms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpKind {
    /// An edit.
    Edit,
    /// A reaction.
    React,
    /// A delete or hide.
    Delete,
    /// A mutation this core has no name for.
    Other(String),
}

impl OpKind {
    /// The wire word for this mutation kind.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Edit => "edit",
            Self::React => "react",
            Self::Delete => "delete",
            Self::Other(raw) => raw,
        }
    }
}

impl<'de> Deserialize<'de> for OpKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw: Option<String> = lossy::lenient(deserializer)?;
        Ok(match raw.as_deref() {
            Some("edit") => Self::Edit,
            Some("react") => Self::React,
            Some("delete") => Self::Delete,
            Some(other) => Self::Other(other.to_owned()),
            None => return Err(de::Error::custom("op-accepted without an opKind")),
        })
    }
}

/// `k: "op-accepted"`: the server applied an edit, reaction or delete.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OpAccepted {
    /// The conversation.
    pub peer: Login,
    /// Which kind of mutation it was.
    #[serde(rename = "opKind")]
    pub op_kind: OpKind,
    /// The message it was about.
    #[serde(default, deserialize_with = "inner::de_opt_message_id")]
    pub id: Option<MessageId>,
    /// The client's own id for the operation, when it sent one.
    #[serde(default, rename = "opId")]
    pub op_id: Option<String>,
}

/// `k: "read-sync"`: this account read a conversation from another device.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReadSync {
    /// The conversation.
    pub peer: Login,
    /// The message, empty for a whole-conversation read.
    #[serde(default, deserialize_with = "inner::de_opt_message_id")]
    pub id: Option<MessageId>,
    /// How far the account has read.
    #[serde(rename = "readTs", deserialize_with = "num::de_ts")]
    pub read_ts: Ts,
    /// When the reader got there.
    #[serde(default, rename = "readAt", deserialize_with = "num::de_opt_ts")]
    pub read_at: Option<Ts>,
    /// The kind of client that read it.
    #[serde(default)]
    pub via: Option<String>,
}

/// `k: "react-sync"`: this account reacted from another device.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReactSync {
    /// The conversation.
    pub peer: Login,
    /// The message.
    pub id: MessageId,
    /// The emoji.
    #[serde(default, deserialize_with = "de_text")]
    pub emoji: String,
    /// Who reacted.
    pub by: Login,
    /// Whether it was added or removed.
    #[serde(default = "default_true")]
    pub add: bool,
}

/// `k: "unread"`: a message arrived for a conversation this socket is not on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Unread {
    /// Who sent it.
    pub from: Login,
    /// What it says.
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    /// When it was written.
    #[serde(default, deserialize_with = "num::de_opt_ts")]
    pub ts: Option<Ts>,
    /// The account's whole unread count from them, not an increment.
    #[serde(default, deserialize_with = "num::de_opt_u32")]
    pub count: Option<u32>,
}

/// `k: "conversation-update"`: a conversation's newest message changed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ConversationUpdate {
    /// The conversation.
    pub from: Login,
    /// Whether this account wrote it: the wire calls it `self`.
    #[serde(default, rename = "self")]
    pub own: bool,
    /// The new roster line.
    #[serde(default)]
    pub last: Option<Preview>,
}

/// `k: "message-event"`: a mutation, to every browser session of both sides.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MessageEvent {
    /// The conversation.
    pub from: Login,
    /// Whether this account did it: the wire calls it `self`.
    #[serde(default, rename = "self")]
    pub own: bool,
    /// The inner frame describing the change.
    pub d: Inner,
}

/// `k: "profile"`: this account's own name changed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Profile {
    /// Who this account now is.
    pub user: SelfInfo,
}

/// A reply reminder, as the server stores it (`accounts.js`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Reminder {
    /// Its id, for acknowledging it.
    pub id: String,
    /// The conversation it belongs to.
    pub peer: Login,
    /// The message to answer.
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    /// When it comes due.
    #[serde(rename = "dueAt", deserialize_with = "num::de_ts")]
    pub due_at: Ts,
    /// When it was set.
    #[serde(default, rename = "createdAt", deserialize_with = "num::de_opt_ts")]
    pub created_at: Option<Ts>,
    /// When it fired; present only on a fired reminder.
    #[serde(default, rename = "firedAt", deserialize_with = "num::de_opt_ts")]
    pub fired_at: Option<Ts>,
}

/// `k: "throttle"`: this socket went over its frame budget.
///
/// Not an error: the connection lives and the dropped frame is the client's
/// own queue's business (`chargeFrame`, `hub.js`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Throttle {
    /// The window the budget is measured over.
    #[serde(default, rename = "windowMs", deserialize_with = "num::de_u32")]
    pub window_ms: u32,
    /// How many frames arrived in it.
    #[serde(default, deserialize_with = "num::de_u32")]
    pub frames: u32,
    /// How many were allowed.
    #[serde(default, deserialize_with = "num::de_u32")]
    pub limit: u32,
}

/// `k: "error"`: the server refused something.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServerError {
    /// The server's code, e.g. `store_failed`, `not_subscribed`.
    pub code: String,
    /// What the server says about it, for the log.
    #[serde(default, deserialize_with = "de_optional_text")]
    pub message: Option<String>,
    /// The conversation, when the server names one.
    #[serde(default, deserialize_with = "inner::de_optional_login")]
    pub peer: Option<Login>,
    /// The message, when the server names one.
    #[serde(default, deserialize_with = "inner::de_opt_message_id")]
    pub id: Option<MessageId>,
}

/// Whether a flag the server omits means "yes".
fn default_true() -> bool {
    true
}

/// Reads a presence state, losing one this core has no name for.
fn de_presence<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<PresenceState>, D::Error> {
    let raw: Option<String> = lossy::lenient(deserializer)?;
    Ok(match raw.as_deref() {
        Some("active") => Some(PresenceState::Active),
        Some("idle") => Some(PresenceState::Idle),
        Some("away") => Some(PresenceState::Away),
        _ => None,
    })
}

/// Reads the kind of a previewed message; anything unknown is a person's.
fn de_preview_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<PreviewKind, D::Error> {
    let raw: Option<String> = lossy::lenient(deserializer)?;
    Ok(match raw.as_deref() {
        Some("ai") => PreviewKind::Ai,
        _ => PreviewKind::Human,
    })
}

/// Reads a string, or empty when it is anything else.
fn de_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(de_optional_text(deserializer)?.unwrap_or_default())
}

/// Reads a string, or `None` when it is anything else.
fn de_optional_text<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    lossy::lenient(deserializer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_with_nothing_but_its_tag_is_usable() {
        let frame: ServerFrame = serde_json::from_str(r#"{"k":"ready"}"#).expect("decodes");
        let ServerFrame::Ready(ready) = frame else {
            panic!("not ready: {frame:?}");
        };
        assert!(ready.me.is_none());
        assert!(ready.users.items.is_empty());
        assert!(!ready.has_cap("sync-v1"));
    }

    #[test]
    fn ready_lists_the_server_caps() {
        let frame: ServerFrame =
            serde_json::from_str(r#"{"k":"ready","caps":["durable-ack","sync-v1",7]}"#)
                .expect("decodes");
        let ServerFrame::Ready(ready) = frame else {
            panic!("not ready");
        };
        assert!(ready.has_cap("sync-v1"));
        assert_eq!(ready.caps.skipped, 1);
    }

    #[test]
    fn unknown_envelope_is_not_an_error() {
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"k":"brand-new-thing","x":1}"#).ok(),
            Some(ServerFrame::Other)
        );
    }

    #[test]
    fn a_non_string_tag_is_a_bad_frame() {
        for raw in [
            r#"{"k":0}"#,
            r#"{"k":null}"#,
            r#"{"k":["ready"]}"#,
            r#"[]"#,
            r#"{"x":1}"#,
        ] {
            assert!(serde_json::from_str::<ServerFrame>(raw).is_err(), "{raw}");
        }
    }
}
