//! The wire: size limits, reading every server frame, writing ours.
//!
//! The core speaks one protocol: JSON text over one WebSocket to the cloud
//! server (`src/cloud/`). This module is the only place that knows that JSON.
//!
//! # Reading
//!
//! [`decode`] turns one text frame into a [`ServerFrame`]. It never panics and
//! never calls anything: a frame that is not JSON, or JSON of the wrong shape,
//! is a [`CoreError::BadFrame`] the engine turns into an event and drops.
//! Reading is deliberately generous, in the three places the spec (§4) says a
//! newer or rougher server must not cost a connection:
//!
//! - an envelope or inner frame with a `k`/`t` this core has no type for is
//!   [`ServerFrame::Other`] / [`inner::Inner::Unknown`], not an error;
//! - a number is a number: `ts` and `seq` accept any finite JSON number and are
//!   floored to milliseconds, because the server passes a client's own float
//!   time through (`hub.js` keeps `d.ts` when it is within the clock window);
//! - a list is read entry by entry ([`Lossy`]): one unusable entry is counted
//!   and skipped, and a `sync-page` with one broken event still delivers the
//!   rest of its page.
//!
//! Fields are typed as strictly as the server's own store types them
//! (`accounts.js` `normalizeMessage`): what the envelope says about routing is
//! strict, what a peer wrote inside a message is as forgiving as the store.
//!
//! # Writing
//!
//! [`en`] has one encoder per envelope this client sends. Each borrows its
//! arguments, writes the JSON the server parses, and refuses a frame larger
//! than [`MAX_OUTBOUND`] — the server's own `CLOUD_FRAME_MAX_CHARS`.

/// End-to-end encryption: the `/api/e2ee/keys/*` answers and key frames.
pub mod e2ee;
/// Our frames: one encoder per envelope, all of them size-checked.
pub mod en;
/// `/api/history`: the request and the page it answers with.
pub mod history;
/// Inner frames: the `d` of a `frame` envelope.
pub mod inner;
/// Tolerant lists: one unusable entry costs that entry.
mod lossy;
/// Wire numbers: floats on the wire, milliseconds here.
mod num;
/// Server-to-client envelopes, keyed by `k`.
pub mod server;
/// The resumable feed: `sync-page` and its events.
pub mod sync;
/// `Login` and `MessageId`, read from the strings the wire carries them as.
mod wire;

#[cfg(test)]
mod tests;

use crate::error::CoreError;
use crate::ids::MessageId;
use crate::login::Login;
use serde::Deserialize;

pub use self::en::{
    CAPS, ack, auth, auth_for, auth_with, del, edit, mark_read, msg, react, read, state, subscribe,
    sync as sync_request, typing, unsubscribe,
};
pub use self::history::{HISTORY_PAGE, HistoryPage, HistoryRecord, decode_history};
pub use self::inner::{Inner, MessageBody};
pub use self::lossy::Lossy;
pub use self::server::{
    Accepted, ConversationUpdate, MessageEvent, OpAccepted, OpKind, Presence, PresenceState,
    Preview, PreviewKind, Profile, ReactSync, ReactionEvent, ReadAccepted, ReadSync, Ready,
    Relayed, Reminder, Roster, SelfInfo, ServerError, ServerFrame, Subscribed, Throttle, Unread,
    User,
};
pub use self::sync::{SYNC_PAGE_MAX, SyncEvent, SyncKind, SyncPage};

/// `CLOUD_FRAME_MAX_CHARS` from `src/cloud/limits.js`: 10 MiB + 1024.
pub const MAX_OUTBOUND: usize = 10 * 1024 * 1024 + 1024;
/// `CLOUD_MEDIA_MAX_CHARS`: the data URL itself must fit durable history,
/// independently of the enclosing WebSocket frame's extra headroom.
pub const MAX_MEDIA_URL: usize = 10 * 1024 * 1024;
/// Largest frame an end-to-end encrypted message may be:
/// `CLOUD_E2EE_FRAME_MAX_CHARS` (`src/cloud/limits.js`). The ciphertext
/// carries the same media inside it plus the Megolm MAC and signature, so the
/// server gives those frames exactly this much headroom.
pub const MAX_SEALED: usize = MAX_OUTBOUND + 16 * 1024;
/// Largest frame the core reads. The driver sets its WebSocket max payload
/// to this, so a bigger frame is refused before it is even allocated.
/// The server counts UTF-16 units, UTF-8 can take 3 bytes per unit: 4x.
pub const MAX_INBOUND: usize = 4 * MAX_OUTBOUND;
/// Most message ids one `del` may name (`DEL_MAX_IDS`, `hub.js`).
pub const DELETE_IDS_MAX: usize = 200;

/// Reads one frame from the server, refusing oversized ones before parsing.
///
/// The size check comes first so a hostile frame is dropped before
/// `serde_json` allocates anything for it. A frame that is not JSON, or not a
/// JSON object at all, is an `Err`; every object that carries a `k` lands in
/// [`ServerFrame`], with [`ServerFrame::Other`] for a kind this core has no
/// type for yet.
pub fn decode(raw: &str) -> Result<ServerFrame, CoreError> {
    if raw.len() > MAX_INBOUND {
        return Err(CoreError::FrameTooLarge {
            len: raw.len(),
            max: MAX_INBOUND,
        });
    }
    serde_json::from_str(raw).map_err(|error| CoreError::BadFrame(error.to_string()))
}

/// Extracts the destination and message id from an outbound message or receipt.
///
/// Other frames, invalid identifiers and malformed JSON have no send key.
pub fn send_key(frame: &str) -> Option<(Login, MessageId)> {
    #[derive(Deserialize)]
    struct Envelope {
        k: String,
        to: Login,
        d: Body,
    }
    #[derive(Deserialize)]
    struct Body {
        t: String,
        id: MessageId,
    }

    let envelope: Envelope = serde_json::from_str(frame).ok()?;
    if envelope.k == "frame" && matches!(envelope.d.t.as_str(), "msg" | "ai" | "ack" | "read") {
        Some((envelope.to, envelope.d.id))
    } else {
        None
    }
}
