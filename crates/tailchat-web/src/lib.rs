//! Tailchat core in the browser (stage 7).
//!
//! The sans-IO core and its executor are the same code the native driver runs
//! (`tailchat-net` without its `native` feature). What this crate adds is what
//! the browser has instead of a thread, tokio and SQLCipher:
//!
//! - [`KvStore`]: the store, in memory and mirrored record by record into
//!   IndexedDB through a journal the JavaScript side commits;
//! - on `wasm32`, the driver loop and its `wasm-bindgen` surface, which reach
//!   the WebSocket, `fetch`, IndexedDB and the timers through a host object
//!   the page supplies.

/// `WebClient`: the page's handle on the core.
#[cfg(target_arch = "wasm32")]
mod client;
/// Records ↔ JSON.
mod codec;
/// The driver loop.
#[cfg(target_arch = "wasm32")]
mod driver;
/// What the page supplies: socket, fetch, IndexedDB, timers.
#[cfg(target_arch = "wasm32")]
mod host;
/// The browser's `Storage`.
mod store;

#[cfg(target_arch = "wasm32")]
pub use client::WebClient;
#[cfg(target_arch = "wasm32")]
pub use host::Host;
pub use store::{JournalEntry, KvError, KvStore};
