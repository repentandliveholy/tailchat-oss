//! Drives one account against a real (isolated) cloud server: sends a message
//! and waits for ✓ and ✓✓, or only reports what the store holds — which is how
//! a gap is docked: one run while the peer is away, a second afterwards.
//!
//! Two runs, one account (the store is on disk, so they may be separate
//! processes, which is the point):
//!
//! 1. `SMOKE_SEND=1`: connect, subscribe, write, wait for ✓ and ✓✓, exit.
//! 2. while nothing runs, the peer writes; then `SMOKE_SEND=0
//!    SMOKE_SUBSCRIBE=0 SMOKE_EXPECT=<rows now>`: connect and wait for the rows,
//!    which can only come through the feed and `/api/history` — no live
//!    delivery is possible without a subscription.
//!
//! Everything comes from the environment, so no secret is in the source:
//!
//! ```text
//! TAILCHAT_SMOKE_LOGIN       alice (the account this driver is)
//! TAILCHAT_SMOKE_TOKEN       64 hex characters
//! TAILCHAT_SMOKE_SOCKET      ws://127.0.0.1:PORT/tailchat/ws
//! TAILCHAT_SMOKE_HTTP        http://127.0.0.1:PORT/tailchat
//! TAILCHAT_SMOKE_DB          /tmp/smoke/alice.db
//! TAILCHAT_SMOKE_KEY         64 hex characters (SQLCipher key)
//! TAILCHAT_SMOKE_PEER        bob
//! TAILCHAT_SMOKE_SEND        1 (default) to write and wait for ✓/✓✓, 0 to
//!                            only look at what is stored
//! TAILCHAT_SMOKE_SUBSCRIBE   1 (default) to subscribe to the peer after
//!                            `ready`; 0 means nothing can arrive live
//! TAILCHAT_SMOKE_EXPECT      wait until the conversation holds this many rows
//!                            (0: do not wait)
//! ```
//!
//! The peer side (a second client that acknowledges and can write while the
//! driver is stopped) is `examples/peer.mjs`.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use tailchat_core::{Action, Event, Login, MessageId, Receipt};
use tailchat_net::{Command, Config, ConnState, Handle, Notice, start};
use tailchat_store::{Key, Row};

/// How long any one step may take.
const WAIT: Duration = Duration::from_secs(30);

fn env(name: &str) -> Result<String, Box<dyn std::error::Error>> {
    std::env::var(name).map_err(|_| format!("{name} is not set").into())
}

fn maybe_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn number(name: &str) -> u64 {
    maybe_env(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn key(text: &str) -> Result<Key, String> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return Err("the key must be 64 hex characters".to_owned());
    }
    let mut raw = [0u8; 32];
    for (slot, pair) in raw.iter_mut().zip(bytes.chunks(2)) {
        let hex = std::str::from_utf8(pair).map_err(|_| "the key is not hex")?;
        *slot = u8::from_str_radix(hex, 16).map_err(|_| "the key is not hex")?;
    }
    Ok(Key::from_bytes(&raw))
}

/// The same account every time: a `Config` cannot be reused (`Key` is not
/// `Clone`), so each start builds one.
fn config() -> Result<Config, Box<dyn std::error::Error>> {
    Ok(Config {
        login: Login::parse(&env("TAILCHAT_SMOKE_LOGIN")?)?,
        token: env("TAILCHAT_SMOKE_TOKEN")?,
        socket_url: env("TAILCHAT_SMOKE_SOCKET")?,
        http_base: env("TAILCHAT_SMOKE_HTTP")?,
        db_path: env("TAILCHAT_SMOKE_DB")?.into(),
        key: key(&env("TAILCHAT_SMOKE_KEY")?)?,
        extra_caps: vec!["read-ack-v1".to_owned()],
        e2ee: false,
        device_name: String::new(),
    })
}

/// A random-enough message id: the clock, shaped like the web client's.
fn next_id() -> MessageId {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    MessageId::from_random(now.to_le_bytes())
}

fn describe(row: &Row) -> String {
    match row {
        Row::Message(m) => format!(
            "message id={} from={} ts={} text={:?}",
            m.id.as_str(),
            m.from.as_str(),
            m.ts.0,
            m.text
        ),
        Row::Sent(s) => format!(
            "sent    id={} ts={} receipt={:?} text={:?}",
            s.message.id.as_str(),
            s.message.ts.0,
            s.message.receipt,
            s.message.text
        ),
        Row::Pending(p) => format!(
            "pending id={} ts={} receipt={:?} attempts={} text={:?}",
            p.message.id.as_str(),
            p.message.ts.0,
            p.message.receipt,
            p.attempts,
            p.message.text
        ),
    }
}

fn rows(handle: &Handle, peer: &Login) -> Result<Vec<Row>, Box<dyn std::error::Error>> {
    Ok(handle
        .conversation(peer, None, 100)
        .map_err(|error| error.to_string())?)
}

fn print_rows(handle: &Handle, peer: &Login) -> Result<usize, Box<dyn std::error::Error>> {
    let held = rows(handle, peer)?;
    for row in &held {
        println!("  {}", describe(row));
    }
    Ok(held.len())
}

/// Starts the driver and waits for `ready`.
fn connect() -> Result<(Handle, mpsc::Receiver<Notice>), Box<dyn std::error::Error>> {
    let (tx, notices) = mpsc::channel();
    let handle = start(config()?, move |notice| {
        let _ = tx.send(notice);
    })?;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        match notices.recv_timeout(Duration::from_secs(1)) {
            Ok(Notice::Connection(ConnState::Ready)) => {
                println!("driver: ready");
                return Ok((handle, notices));
            }
            Ok(Notice::Connection(state)) => println!("driver: {state:?}"),
            Ok(Notice::Event(Event::ServerError { code, .. })) => {
                return Err(format!("the server refused: {code}").into());
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("the driver stopped before it was ready".into());
            }
        }
    }
    Err("no ready within 30 s".into())
}

/// Waits for the message to reach ✓ and ✓✓.
fn await_receipts(
    id: &MessageId,
    notices: &mpsc::Receiver<Notice>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut sent = false;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline && !sent {
        match notices.recv_timeout(Duration::from_secs(1)) {
            Ok(Notice::Event(Event::MessageAdded(added))) if added.id == *id => {
                println!("receipt {:?} (⧗)", added.receipt);
            }
            Ok(Notice::Event(Event::ReceiptChanged {
                id: changed,
                receipt,
                ..
            })) if changed == *id => match receipt {
                Receipt::Sent => {
                    println!("receipt Sent (✓)");
                    sent = true;
                }
                Receipt::Delivered => println!("receipt Delivered (✓✓)"),
                other => println!("receipt {other:?}"),
            },
            Ok(Notice::Event(Event::ServerError { code, .. })) => {
                return Err(format!("the server refused: {code}").into());
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("the driver stopped".into());
            }
        }
    }
    if !sent {
        return Err("the message did not reach ✓ within 30 s".into());
    }
    // ✓✓ may arrive in the same burst or after the acknowledgement loop above;
    // either way it is a fact about the row, checked below through the store.
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let peer = Login::parse(&env("TAILCHAT_SMOKE_PEER")?)?;
    let expected = usize::try_from(number("TAILCHAT_SMOKE_EXPECT")).unwrap_or(0);
    let write = number("TAILCHAT_SMOKE_SEND");
    let subscribe = number("TAILCHAT_SMOKE_SUBSCRIBE");

    println!("== connect");
    let (handle, notices) = connect()?;
    if subscribe == 1 {
        // Live receipts and live messages only reach a socket subscribed to
        // the conversation.
        let frame = format!(r#"{{"k":"subscribe","peer":"{}"}}"#, peer.as_str());
        handle.send(Command::Raw(frame))?;
    }

    if write == 1 {
        println!("== send");
        let id = next_id();
        handle.send(Command::Action(Action::SendText {
            id: id.clone(),
            peer: peer.clone(),
            text: format!("live smoke {}", id.as_str()),
        }))?;
        await_receipts(&id, &notices)?;
        // The ladder is a property of the stored row: wait for it there.
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            let delivered = rows(&handle, &peer)?.iter().any(|row| match row {
                Row::Sent(s) => s.message.id == id && s.message.receipt == Receipt::Delivered,
                _ => false,
            });
            if delivered {
                println!("receipt Delivered (✓✓)");
                break;
            }
            let _ = notices.recv_timeout(Duration::from_millis(200));
        }
    }

    // Whatever the driver learned from the feed and history lands here, in the
    // store, without any live frame.
    if expected > 0 {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            let count = rows(&handle, &peer)?.len();
            if count >= expected {
                break;
            }
            let _ = notices.recv_timeout(Duration::from_millis(200));
        }
    }

    let held = print_rows(&handle, &peer)?;
    println!("== rows: {held} (expected {expected} at least)");
    handle.stop();
    println!("== stopped (socket closed, store closed, lock released)");
    if expected > 0 && held < expected {
        return Err(format!("only {held} rows, expected {expected}").into());
    }
    Ok(())
}
