//! What the page supplies: the WebSocket, `fetch`, IndexedDB and the timers,
//! as one JavaScript object (`web/cloud/core/host.js` in the page, a fake in
//! the tests). The driver never touches a browser API itself.
//!
//! # The contract
//!
//! - `connect(url)` opens a WebSocket, replacing (and silently closing) any
//!   earlier one: only the newest socket reports. It reports through the
//!   client: `socketOpen()`, `socketText(text)` for every text frame,
//!   `socketClosed()` once, whether it never opened or dropped later.
//! - `send(text)` writes one frame and returns whether the socket took it.
//! - `close()` closes the socket without reporting it.
//! - `fetch(method, url, token, body)` resolves `{status, body}` for any HTTP
//!   answer and rejects only when there is none (network, timeout).
//! - `commit(entries)` writes `[{key, value}]` (`value: null` deletes) in one
//!   IndexedDB transaction and resolves once it is durable. Commits apply in
//!   the order they were called; after one fails, every later one rejects.
//! - `sleep(ms)` resolves after `ms` milliseconds.
//! - `notice(value)` hands the page one driver notice (see `tailchat_net::json`).

use js_sys::{Array, JSON, Object, Promise, Reflect};
use serde_json::Value;
use tailchat_core::{FetchError, MAX_INBOUND, Refusal, Ts};
use tailchat_net::exec::{Store, lock};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::{JournalEntry, KvStore};

#[wasm_bindgen]
extern "C" {
    /// The page's half of the driver.
    pub type Host;

    #[wasm_bindgen(method)]
    pub(crate) fn connect(this: &Host, url: &str);

    #[wasm_bindgen(method)]
    pub(crate) fn send(this: &Host, text: &str) -> bool;

    #[wasm_bindgen(method)]
    pub(crate) fn close(this: &Host);

    #[wasm_bindgen(method)]
    fn fetch(this: &Host, method: &str, url: &str, token: &str, body: Option<String>) -> Promise;

    #[wasm_bindgen(method)]
    fn commit(this: &Host, entries: Array) -> Promise;

    #[wasm_bindgen(method)]
    fn sleep(this: &Host, ms: f64) -> Promise;

    #[wasm_bindgen(method)]
    pub(crate) fn notice(this: &Host, value: JsValue);
}

/// The wall clock, in milliseconds since the Unix epoch.
pub(crate) fn now() -> Ts {
    millis(js_sys::Date::now())
}

/// Whole milliseconds of a JavaScript time value; `NaN` reads as 0.
#[allow(clippy::as_conversions)] // f64 → i64 saturates and maps NaN to 0.
pub(crate) fn millis(ms: f64) -> Ts {
    Ts(ms as i64)
}

/// Milliseconds as a JavaScript number.
#[allow(clippy::as_conversions)] // Every delay we wait on is far below 2^53.
pub(crate) fn js_ms(ms: i64) -> f64 {
    ms as f64
}

/// A JSON value as a JavaScript value.
pub(crate) fn to_js(value: &Value) -> JsValue {
    JSON::parse(&value.to_string()).unwrap_or(JsValue::NULL)
}

/// A JavaScript value as JSON; `undefined` and `null` are `null`.
pub(crate) fn from_js(value: &JsValue) -> Result<Value, String> {
    if value.is_undefined() || value.is_null() {
        return Ok(Value::Null);
    }
    let text = JSON::stringify(value)
        .ok()
        .and_then(|s| s.as_string())
        .ok_or("not a JSON value")?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Resolves after `ms` milliseconds (at once for a deadline already past).
pub(crate) async fn sleep(host: &Host, ms: i64) {
    let _ = JsFuture::from(host.sleep(js_ms(ms.max(0)))).await;
}

/// The journal as the array `commit` takes.
fn entries(journal: Vec<JournalEntry>) -> Array {
    journal
        .into_iter()
        .map(|entry| {
            let object = Object::new();
            let value = entry.value.map_or(JsValue::NULL, JsValue::from);
            let _ = Reflect::set(&object, &"key".into(), &entry.key.into());
            let _ = Reflect::set(&object, &"value".into(), &value);
            JsValue::from(object)
        })
        .collect()
}

/// Makes everything the store applied so far durable. `Err`: it is not, the
/// store is poisoned, and nothing may leave the device on the strength of it.
pub(crate) async fn flush(host: &Host, store: &Store<KvStore>) -> Result<(), ()> {
    let journal = {
        let mut guard = lock(store);
        match guard.as_mut() {
            Some(kv) if kv.is_poisoned() => return Err(()),
            Some(kv) if kv.has_journal() => kv.take_journal(),
            Some(_) => return Ok(()),
            None => return Err(()),
        }
    };
    match JsFuture::from(host.commit(entries(journal))).await {
        Ok(_) => Ok(()),
        Err(_) => {
            if let Some(kv) = lock(store).as_mut() {
                kv.poison();
            }
            Err(())
        }
    }
}

/// One HTTP request through the page, after the journal is durable: a key
/// POST must never reach the server ahead of the keys it names on disk.
pub(crate) async fn request(
    host: &Host,
    store: &Store<KvStore>,
    method: &str,
    url: &str,
    token: &str,
    body: Option<String>,
) -> Result<String, FetchError> {
    flush(host, store).await.map_err(|()| FetchError::Network)?;
    let answer = JsFuture::from(host.fetch(method, url, token, body))
        .await
        .map_err(|_| FetchError::Network)?;
    let status = Reflect::get(&answer, &"status".into())
        .ok()
        .and_then(|v| v.as_f64())
        .ok_or(FetchError::Network)?;
    let body = Reflect::get(&answer, &"body".into())
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default();
    let status = u16::try_from(millis(status).0).map_err(|_| FetchError::Network)?;
    if status != 200 {
        return Err(FetchError::Status(status, refusal_in(&body)));
    }
    if body.len() > MAX_INBOUND {
        return Err(FetchError::TooLarge);
    }
    Ok(body)
}

/// The refusal named by `{"error": "<code>", …}`, as the native client reads it.
fn refusal_in(body: &str) -> Option<Refusal> {
    let value: Value = serde_json::from_str(body).ok()?;
    Refusal::from_code(value.get("error")?.as_str()?)
}
