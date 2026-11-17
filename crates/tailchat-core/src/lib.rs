//! Tailchat core: one engine for every client.
//!
//! Sans-IO: the core never touches the network, disk or clock itself.
//! A driver feeds it `Input`s and carries out the `Output`s it returns.

/// The contract: `Input`, `Action`, `Output`, `Event`, `StoreOp`.
mod api;
/// End-to-end encryption state: this device's account and keys.
mod e2ee;
/// `Core`: the engine and its `handle`.
mod engine;
/// `CoreError`: everything that can go wrong.
mod error;
pub mod frames;
/// `MessageId`, `Ts`, `Seq`.
mod ids;
/// `Login`, checked by the server's rule.
mod login;
/// Uncommitted messages, retry scheduling, pacing and durable receipt positions.
mod outbox;
/// What the platform provides: `Token`, `Storage`, `Snapshot`.
mod platform;
/// `Receipt`: the ⧗ ✓ ✓✓ ⚠ ladder.
mod receipt;
/// `Row`: one conversation row as the UI draws it.
mod row;
/// What this device holds and what the feed says it still owes.
mod sync;

pub use api::{
    Action, ApiCall, ApiRequest, Backfill, Below, Envelope, Event, Extra, FetchError, Held,
    HistoryRequest, InboundRow, Input, Message, MessageKind, OlmChannelRow, OutVoice, OutboundRow, Outgoing,
    Output, OwedAck, OwnRead, PeerIdentity, PeerReceipts, PendingOutgoing, PendingToDevice,
    Protection, Reaction, Refusal, SafetyHalf, Seal, SealedRow, StoreOp, WalkFrom,
};
pub use engine::Core;
pub use error::CoreError;
pub use frames::inner::Image;
pub use frames::{MAX_INBOUND, MAX_OUTBOUND};
pub use ids::{MessageId, Seq, Ts};
pub use login::Login;
pub use platform::{BackupPassphraseKey, Secret, Snapshot, Storage, Token};
pub use receipt::Receipt;
pub use row::{Row, Sent};
