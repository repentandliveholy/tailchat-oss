//! What the UI draws: one row of a conversation, from any store.

use crate::api::{Message, Outgoing, PendingOutgoing, Reaction};
use crate::ids::{MessageId, Ts};

/// A committed outgoing row as the UI draws it: the message and what it has
/// collected since it was sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    /// The message and its rung.
    pub message: Outgoing,
    /// When its text was last edited (from another device of this account).
    pub edited_at: Option<Ts>,
    /// The reactions on it.
    pub reactions: Vec<Reaction>,
}

/// One row of a conversation as the UI draws it.
// Keep the public row contract unboxed and avoid an allocation per message.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    /// A conversation message, including messages from other devices.
    Message(Message),
    /// A committed outgoing message.
    Sent(Sent),
    /// An outgoing message still queued or failed.
    Pending(PendingOutgoing),
}

impl Row {
    /// The message identifier.
    pub fn id(&self) -> &MessageId {
        match self {
            Self::Message(row) => &row.id,
            Self::Sent(row) => &row.message.id,
            Self::Pending(row) => &row.message.id,
        }
    }

    /// The message timestamp.
    pub fn ts(&self) -> Ts {
        match self {
            Self::Message(row) => row.ts,
            Self::Sent(row) => row.message.ts,
            Self::Pending(row) => row.message.ts,
        }
    }
}
