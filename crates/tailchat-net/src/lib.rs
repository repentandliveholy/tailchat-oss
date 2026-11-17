//! Native driver for the Tailchat core (stage 5): the sockets, the disk and the
//! clock that the sans-IO `tailchat-core` leaves to its driver.
//!
//! [`start`] opens the account's SQLCipher store, builds a [`tailchat_core::Core`]
//! from it and hands both to one dedicated OS thread (`tailchat-net`) running a
//! current-thread tokio runtime. That thread dials the cloud's WebSocket, feeds
//! the core every frame, command, timer tick and history answer, one at a time,
//! and carries out its outputs strictly in order (see [`Handle`] for the
//! guarantees, `exec.rs` for the ordering rules).
//!
//! # Threads
//!
//! - The **sink** passed to [`start`] is called on the driver thread, one
//!   [`Notice`] at a time, in the order things happened. It must return
//!   quickly (the socket is not read while it runs) and must not panic. It is
//!   never called with the store locked, so it may call [`Handle::send`] and
//!   [`Handle::conversation`] (a handle held by the sink keeps the driver
//!   alive: call [`Handle::stop`] to end it).
//! - [`Handle`] is `Clone + Send + Sync`; every method may be called from any
//!   thread. [`Handle::stop`] blocks until the driver thread has exited.
//!
//! # Secrets
//!
//! The token is kept in a wiped-on-drop buffer for rebuilding the core and for
//! the history request, and our copy of every frame is wiped after it is
//! written. The copies that pass through tungstenite and rustls buffers are not
//! ours to wipe (spec §3). `Debug` of [`Notice`] and [`Command`] prints message
//! text: never log them.

/// The wall clock.
#[cfg(feature = "native")]
mod clock;
/// The thread, the `select!` loop and the link state machine.
#[cfg(feature = "native")]
mod driver;
/// The executor: the core's outputs, in order. Shared with the browser
/// driver (`tailchat-web`), which brings its own socket, store and fetches.
pub mod exec;
/// The history GET.
#[cfg(feature = "native")]
mod http;
/// The notices and rows as the JavaScript clients read them.
pub mod json;
/// The instance lock.
#[cfg(feature = "native")]
mod lock;
/// [`start`], [`Handle`], [`Config`]: the native driver's API.
#[cfg(feature = "native")]
mod native;
/// The WebSocket.
#[cfg(feature = "native")]
mod socket;
/// Every duration the driver waits on.
pub mod timings;
/// TLS configuration shared by the socket and the history GET.
#[cfg(feature = "native")]
mod tls;

#[cfg(test)]
#[cfg(feature = "native")]
mod live_tests;
/// The core's reference `MemStore`, shared by the tests (the file gates
/// itself behind `cfg(test)`).
#[cfg(feature = "native")]
#[path = "../../tailchat-core/tests/common/mod.rs"]
mod mem_store;
#[cfg(test)]
#[cfg(feature = "native")]
mod tests;

#[cfg(feature = "native")]
pub use native::{Config, Handle, ReadError, StartError, Stopped, start};

use tailchat_core::{Action, Event, Login, MessageId};

/// What the caller can ask of the driver.
///
/// `Debug` prints message text: never log it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Something for the core: send a message, retry a failed one. A refusal
    /// comes back as [`Notice::ActionRefused`].
    Action(Action),
    /// A text frame written to the socket as is, only while the core has seen
    /// `ready` on this connection. Otherwise (or if the write fails) it is
    /// dropped and answered with [`Notice::RawDropped`].
    Raw(String),
    /// Close the socket now and dial again at once, with the backoff reset.
    /// Also the way out of [`ConnState::AuthFailed`] (it dials once; a token
    /// that is still dead lands there again).
    Reconnect,
}

/// Where the connection stands.
///
/// A connection attempt reads `Connecting`, `Open` (the socket is up, `auth`
/// is written), `Ready` (the server accepted the token), then `Closed` when it
/// ends. A `Ready` connection's `Closed` carries the redial pause. A dial that fails goes straight from `Connecting` to
/// `Closed`. Every `Closed` is followed by `Connecting` after its
/// `retry_in_ms`, except `Closed { retry_in_ms: None }`, which follows
/// `AuthFailed` and waits for [`Command::Reconnect`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    /// Dialling (DNS, TCP, TLS, WebSocket upgrade).
    Connecting,
    /// The socket is open and the core is told to send `auth`.
    Open,
    /// The server answered `ready`: the connection is usable.
    Ready,
    /// The socket is gone (or never came up). The driver dials again in
    /// `retry_in_ms` milliseconds (`0`: at once, after a [`Command::Reconnect`]),
    /// or not by itself at all (`None`).
    Closed {
        /// The pause before the next dial.
        retry_in_ms: Option<u64>,
    },
    /// The server refused the token (`auth_failed` or `auth_required`). The
    /// driver does not dial again by itself. The notices of the refusal itself
    /// come first: [`Notice::Event`]`(ServerError)`, the [`Notice::Frame`] that
    /// carried it, then this, then `Closed { retry_in_ms: None }`.
    AuthFailed,
}

/// What the driver tells the caller, in the order it happened.
///
/// `Debug` prints message text: never log it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    /// The connection changed state. Never the same state twice in a row.
    Connection(ConnState),
    /// News from the core: a message added, a receipt moved, a row stored.
    /// Events of one input arrive before the [`Notice::Frame`] of that input.
    Event(Event),
    /// Every inbound text frame, verbatim, after the core handled it and its
    /// outputs ran. `Connection(Ready)` comes before the `Frame` of `ready`.
    Frame(String),
    /// A [`Command::Raw`] that was not written.
    RawDropped(String),
    /// The core refused an [`Action`]: blank text, a full queue, a duplicate
    /// id, a retry of a message that is not failed, an unavailable store, or
    /// a store that failed before the action's row reached it. Nothing of the
    /// action is on disk: a refused `SendText` never became a message, a
    /// refused `Retry` left its row failed.
    ActionRefused {
        /// The conversation the action named.
        peer: Login,
        /// `SendText`'s new id or `Retry`'s failed one.
        id: MessageId,
        /// The core already holds a message under this id (a `SendText` that
        /// reused one): nothing new was queued, but that message exists and
        /// its notices keep coming.
        held: bool,
        /// Why, for the log (never contains message text).
        reason: String,
    },
    /// Storage failed. The core was rebuilt from disk, the socket closed and
    /// a redial scheduled. Reported once for the failed write and once more
    /// for every rebuild that fails too.
    StorageFailed {
        /// What the store said (never contains message text or keys).
        reason: String,
    },
}
