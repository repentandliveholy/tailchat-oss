//! The driver against a local stand-in for the cloud server.
//!
//! The stand-in speaks just enough of the protocol (`auth` → `ready`,
//! `message-accepted`, relayed frames, `sync-page`) and serves `/api/history`
//! from a script. The driver under test is the real one: its own thread, real
//! sockets, a real SQLCipher store in a temporary directory. Clocks are
//! shrunk so that backoff and watchdog tests take milliseconds.

use std::net::TcpListener as StdListener;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use tailchat_core::{Action, MAX_INBOUND, Receipt};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::sync::{Notify, broadcast};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;

use rustls::ClientConfig;
use tailchat_core::Ts;
use tailchat_store::{Key, Row};

use super::*;
use crate::lock::InstanceLock;
use crate::native::start_with;
use crate::timings::Timings;

/// What a test can make the server do to its current connection.
#[derive(Clone, Debug)]
enum Push {
    Text(String),
    Binary(Vec<u8>),
    Ping,
    Close,
}

/// How the server behaves towards the next clients.
#[derive(Clone, Default)]
struct Script {
    /// Frames sent right after the client's `auth`.
    after_auth: Vec<String>,
    /// Close the connection after those.
    close_after_auth: bool,
    /// Frames sent in answer to every `{"k":"sync"}` request.
    on_sync: Vec<String>,
}

/// What `/api/history` answers.
#[derive(Default)]
struct History {
    /// The answer to request n (status, body); the last one repeats.
    answers: Vec<(u16, String)>,
    /// How long each answer is held back.
    delay: Duration,
    /// The head of every request received.
    requests: Vec<String>,
}

/// State shared by the server's tasks.
struct Ctx {
    frames: Mutex<mpsc::Sender<(usize, String)>>,
    push: broadcast::Sender<Push>,
    connections: AtomicUsize,
    script: Mutex<Script>,
    history: Mutex<History>,
}

/// The stand-in server: a WebSocket on one port, `/api/history` on another,
/// on its own thread. Plain, or TLS with a throwaway certificate.
struct Cloud {
    ws_port: u16,
    http_port: u16,
    tls: bool,
    ctx: Arc<Ctx>,
    frames: mpsc::Receiver<(usize, String)>,
    seen: Vec<(usize, String)>,
    stop: Arc<Notify>,
    thread: Option<JoinHandle<()>>,
}

/// A self-signed certificate for `localhost`, as the server's configuration
/// and as the client's (trusting exactly it).
fn tls_pair() -> (Arc<rustls::ServerConfig>, Arc<ClientConfig>) {
    let made =
        rcgen::generate_simple_self_signed(vec!["localhost".to_owned(), "127.0.0.1".to_owned()])
            .unwrap();
    let cert = made.cert.der().clone();
    let key = rustls::pki_types::PrivateKeyDer::try_from(made.signing_key.serialize_der()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key)
        .unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert).unwrap();
    (Arc::new(server), tls::config_with(roots).unwrap())
}

impl Cloud {
    fn start() -> Self {
        Self::launch(None)
    }

    fn start_tls(server: Arc<rustls::ServerConfig>) -> Self {
        Self::launch(Some(TlsAcceptor::from(server)))
    }

    fn launch(acceptor: Option<TlsAcceptor>) -> Self {
        let (frames_tx, frames) = mpsc::channel();
        let (push, _) = broadcast::channel(64);
        let ctx = Arc::new(Ctx {
            frames: Mutex::new(frames_tx),
            push,
            connections: AtomicUsize::new(0),
            script: Mutex::default(),
            history: Mutex::default(),
        });
        let stop = Arc::new(Notify::new());
        let (ports_tx, ports) = mpsc::channel();
        let tls = acceptor.is_some();
        let thread = std::thread::spawn({
            let ctx = Arc::clone(&ctx);
            let stop = Arc::clone(&stop);
            move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async move {
                    let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    ports_tx
                        .send((
                            ws.local_addr().unwrap().port(),
                            http.local_addr().unwrap().port(),
                        ))
                        .unwrap();
                    tokio::spawn(ws_loop(ws, acceptor.clone(), Arc::clone(&ctx)));
                    tokio::spawn(http_loop(http, acceptor, ctx));
                    stop.notified().await;
                });
            }
        });
        let (ws_port, http_port) = ports.recv().unwrap();
        Self {
            ws_port,
            http_port,
            tls,
            ctx,
            frames,
            seen: Vec::new(),
            stop,
            thread: Some(thread),
        }
    }

    fn host(&self) -> &'static str {
        if self.tls { "localhost" } else { "127.0.0.1" }
    }

    fn socket_url(&self) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!("{scheme}://{}:{}/tailchat/ws", self.host(), self.ws_port)
    }

    fn http_base(&self) -> String {
        let scheme = if self.tls { "https" } else { "http" };
        format!("{scheme}://{}:{}/tailchat", self.host(), self.http_port)
    }

    fn script(&self, edit: impl FnOnce(&mut Script)) {
        edit(&mut self.ctx.script.lock().unwrap());
    }

    fn history(&self, edit: impl FnOnce(&mut History)) {
        edit(&mut self.ctx.history.lock().unwrap());
    }

    fn push(&self, push: Push) {
        self.ctx.push.send(push).unwrap();
    }

    fn text(&self, frame: &str) {
        self.push(Push::Text(frame.to_owned()));
    }

    fn connections(&self) -> usize {
        self.ctx.connections.load(Ordering::SeqCst)
    }

    fn requests(&self) -> Vec<String> {
        self.ctx.history.lock().unwrap().requests.clone()
    }

    /// The next client frame (from any connection) that `pred` accepts;
    /// earlier ones are kept in `seen`.
    fn frame(&mut self, pred: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let (_, frame) = self
                .frames
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no matching frame; saw {:?}", self.seen));
            self.seen.push((0, frame.clone()));
            if pred(&frame) {
                return frame;
            }
        }
    }
}

impl Drop for Cloud {
    fn drop(&mut self) {
        self.stop.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// How long a test waits for something that must happen.
const WAIT: Duration = Duration::from_secs(10);

async fn ws_loop(listener: TcpListener, acceptor: Option<TlsAcceptor>, ctx: Arc<Ctx>) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let n = ctx.connections.fetch_add(1, Ordering::SeqCst) + 1;
        let push = ctx.push.subscribe();
        let ctx = Arc::clone(&ctx);
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            match acceptor {
                Some(acceptor) => {
                    if let Ok(stream) = acceptor.accept(tcp).await {
                        serve_ws(stream, n, push, ctx).await;
                    }
                }
                None => serve_ws(tcp, n, push, ctx).await,
            }
        });
    }
}

async fn serve_ws<S>(stream: S, n: usize, mut push: broadcast::Receiver<Push>, ctx: Arc<Ctx>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    loop {
        tokio::select! {
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let text = text.as_str().to_owned();
                    let auth = text.contains("\"k\":\"auth\"");
                    let sync = text.contains("\"k\":\"sync\"");
                    ctx.frames.lock().unwrap().send((n, text)).unwrap();
                    let script = ctx.script.lock().unwrap().clone();
                    if auth {
                        for frame in script.after_auth {
                            if ws.send(Message::text(frame)).await.is_err() {
                                return;
                            }
                        }
                        if script.close_after_auth {
                            let _ = ws.close(None).await;
                            return;
                        }
                    } else if sync {
                        for frame in script.on_sync {
                            if ws.send(Message::text(frame)).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return,
            },
            pushed = push.recv() => match pushed {
                Ok(Push::Text(text)) => {
                    if ws.send(Message::text(text)).await.is_err() {
                        return;
                    }
                }
                Ok(Push::Binary(bytes)) => {
                    if ws.send(Message::Binary(bytes.into())).await.is_err() {
                        return;
                    }
                }
                Ok(Push::Ping) => {
                    if ws.send(Message::Ping(Vec::new().into())).await.is_err() {
                        return;
                    }
                }
                Ok(Push::Close) => {
                    let _ = ws.close(None).await;
                    return;
                }
                Err(_) => {}
            },
        }
    }
}

async fn http_loop(listener: TcpListener, acceptor: Option<TlsAcceptor>, ctx: Arc<Ctx>) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let ctx = Arc::clone(&ctx);
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            match acceptor {
                Some(acceptor) => {
                    if let Ok(stream) = acceptor.accept(tcp).await {
                        serve_http(stream, ctx).await;
                    }
                }
                None => serve_http(tcp, ctx).await,
            }
        });
    }
}

async fn serve_http<S>(mut stream: S, ctx: Arc<Ctx>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.ends_with(b"\r\n\r\n") {
        let n = stream.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let (status, body, delay) = {
        let mut history = ctx.history.lock().unwrap();
        history
            .requests
            .push(String::from_utf8_lossy(&head).into_owned());
        let index = history.requests.len() - 1;
        let (status, body) = history
            .answers
            .get(index)
            .or(history.answers.last())
            .cloned()
            .unwrap_or((404, String::new()));
        (status, body, history.delay)
    };
    tokio::time::sleep(delay).await;
    let reply = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Clocks small enough for tests.
fn quick() -> Timings {
    Timings {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        watchdog: Duration::from_millis(400),
        watchdog_poll: Duration::from_millis(40),
        dial: Duration::from_secs(3),
        write: Duration::from_secs(5),
        fetch: Duration::from_secs(5),
        close: Duration::from_millis(100),
    }
}

fn token() -> String {
    "ab".repeat(32)
}

fn login(name: &str) -> Login {
    Login::parse(name).unwrap()
}

fn id(text: &str) -> MessageId {
    MessageId::parse(text).unwrap()
}

const KEY: [u8; 32] = [7; 32];

fn config(cloud: &Cloud, db: &Path) -> Config {
    Config {
        login: login("alice"),
        token: token(),
        socket_url: cloud.socket_url(),
        http_base: cloud.http_base(),
        db_path: db.to_owned(),
        key: Key::from_bytes(&KEY),
        extra_caps: vec!["read-ack-v1".to_owned()],
        e2ee: false,
        device_name: String::new(),
    }
}

/// A running driver and the notices it has produced.
struct Run {
    handle: Handle,
    notices: mpsc::Receiver<Notice>,
}

impl Run {
    fn begin(cloud: &Cloud, db: &Path) -> Self {
        Self::begin_with(config(cloud, db), quick(), None)
    }

    fn begin_with(config: Config, timings: Timings, tls: Option<Arc<ClientConfig>>) -> Self {
        let (tx, notices) = mpsc::channel();
        let handle = start_with(
            config,
            move |notice| {
                let _ = tx.send(notice);
            },
            timings,
            tls,
        )
        .unwrap();
        Self { handle, notices }
    }

    /// The next notice.
    fn next(&self) -> Notice {
        self.notices
            .recv_timeout(WAIT)
            .expect("a notice should have arrived")
    }

    /// Everything up to and including the first notice `pred` accepts.
    fn until(&self, pred: impl Fn(&Notice) -> bool) -> Vec<Notice> {
        let mut seen = Vec::new();
        loop {
            let notice = self.next();
            let done = pred(&notice);
            seen.push(notice);
            if done {
                return seen;
            }
        }
    }

    fn state(&self, state: ConnState) {
        assert_eq!(self.next(), Notice::Connection(state));
    }

    fn send(&self, command: Command) {
        self.handle.send(command).unwrap();
    }

    fn text(&self, peer: &str, id_text: &str, text: &str) {
        self.send(Command::Action(Action::SendText {
            id: id(id_text),
            peer: login(peer),
            text: text.to_owned(),
        }));
    }

    /// Nothing more arrives within `how_long`.
    fn quiet_for(&self, how_long: Duration) {
        if let Ok(notice) = self.notices.recv_timeout(how_long) {
            panic!("unexpected notice {notice:?}");
        }
    }
}

const READY: &str = r#"{"k":"ready","self":{"login":"alice","name":"Alice"},"users":[{"login":"bob","name":"Bob"}],"caps":["durable-ack"]}"#;
const READY_SYNC: &str = r#"{"k":"ready","self":{"login":"alice","name":"Alice"},"users":[{"login":"bob","name":"Bob"}],"caps":["durable-ack","sync-v1"]}"#;

fn is_auth(frame: &str) -> bool {
    frame.contains("\"k\":\"auth\"")
}

fn is_msg(frame: &str) -> bool {
    frame.contains("\"t\":\"msg\"")
}

/// A started driver that has been through `ready`.
fn ready(cloud: &mut Cloud, db: &Path) -> Run {
    cloud.script(|s| s.after_auth = vec![READY.to_owned()]);
    let run = Run::begin(cloud, db);
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    run.state(ConnState::Ready);
    assert_eq!(run.next(), Notice::Frame(READY.to_owned()));
    cloud.frame(is_auth);
    run
}

#[test]
fn a_message_climbs_the_ladder_and_survives_a_restart() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core").join("alice.db");
    let run = ready(&mut cloud, &db);
    let auth = cloud.seen.last().unwrap().1.clone();
    assert!(auth.contains(&token()));
    assert!(
        auth.contains("\"read-ack-v1\""),
        "extra caps are claimed: {auth}"
    );

    // ⧗ at once, and the frame reaches the server.
    run.text("bob", "m-1", "hello");
    let Notice::Event(Event::MessageAdded(added)) = run.next() else {
        panic!("expected the message to be shown")
    };
    assert_eq!(
        (added.receipt, added.text.as_str()),
        (Receipt::Queued, "hello")
    );
    let sent = cloud.frame(is_msg);
    assert!(
        sent.contains("\"to\":\"bob\"") && sent.contains("\"id\":\"m-1\""),
        "{sent}"
    );

    // ✓ the server committed it.
    let accepted = r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":5000,"seq":1}"#;
    cloud.text(accepted);
    assert_eq!(
        run.next(),
        Notice::Event(Event::ReceiptChanged {
            peer: login("bob"),
            id: id("m-1"),
            ts: Ts(5000),
            receipt: Receipt::Sent,
        })
    );
    assert_eq!(run.next(), Notice::Frame(accepted.to_owned()));

    // ✓✓ bob's device holds it.
    let ack = r#"{"k":"frame","from":"bob","d":{"t":"ack","id":"m-1","deliveredTs":5000}}"#;
    cloud.text(ack);
    assert_eq!(
        run.next(),
        Notice::Event(Event::ReceiptChanged {
            peer: login("bob"),
            id: id("m-1"),
            ts: Ts(5000),
            receipt: Receipt::Delivered,
        })
    );
    assert_eq!(run.next(), Notice::Frame(ack.to_owned()));

    // The row is readable through the handle while the driver runs.
    let rows = run.handle.conversation(&login("bob"), None, 10).unwrap();
    assert_eq!(rows.len(), 1);

    // Stop: deterministic, and silent afterwards.
    run.handle.stop();
    while run.notices.try_recv().is_ok() {}
    assert_eq!(run.handle.send(Command::Reconnect), Err(Stopped));
    assert!(matches!(
        run.handle.conversation(&login("bob"), None, 10),
        Err(ReadError::Stopped)
    ));
    run.handle.stop();
    run.quiet_for(Duration::from_millis(200));

    // Restart on the same file: the row is there before anything is dialled.
    let again = Run::begin(&cloud, &db);
    let rows = again.handle.conversation(&login("bob"), None, 10).unwrap();
    let [Row::Sent(row)] = rows.as_slice() else {
        panic!("expected the committed row: {rows:?}")
    };
    assert_eq!(row.message.id, id("m-1"));
    assert_eq!(row.message.text, "hello");
    assert_eq!(row.message.ts, Ts(5000));
    assert_eq!(row.message.receipt, Receipt::Delivered);
    again.handle.stop();
}

#[test]
fn a_blank_message_is_refused_not_sent() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let run = ready(&mut cloud, &dir.path().join("a.db"));
    run.text("bob", "m-1", "   ");
    assert!(matches!(run.next(), Notice::ActionRefused { .. }));
    run.handle.stop();
}

#[test]
fn a_gap_is_docked_through_the_feed_and_history() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("alice.db");

    // First run: nothing to dock yet.
    cloud.script(|s| {
        s.after_auth = vec![READY_SYNC.to_owned()];
        s.on_sync = vec![
            r#"{"k":"sync-page","events":[],"cursor":0,"more":false,"reset":false}"#.to_owned(),
        ];
    });
    let run = Run::begin(&cloud, &db);
    run.until(|n| matches!(n, Notice::Connection(ConnState::Ready)));
    cloud.frame(|f| f.contains("\"k\":\"sync\""));
    run.handle.stop();

    // While the driver is stopped, bob writes five messages.
    let events: Vec<String> = (1..=5)
        .map(|n| {
            format!(
                r#"{{"seq":{n},"kind":"message","peer":"bob","id":"m-{n}","ts":{},"from":"bob"}}"#,
                n * 1000
            )
        })
        .collect();
    cloud.script(|s| {
        s.on_sync = vec![format!(
            r#"{{"k":"sync-page","events":[{}],"cursor":5,"more":false,"reset":false}}"#,
            events.join(",")
        )];
    });
    let records: Vec<String> = (1..=5)
        .map(|n| {
            format!(
                r#"{{"id":"m-{n}","from":"bob","ts":{},"text":"while you were out {n}"}}"#,
                n * 1000
            )
        })
        .collect();
    cloud.history(|h| {
        h.answers = vec![(200, format!(r#"{{"messages":[{}]}}"#, records.join(",")))];
    });

    // Second run: feed, then history, then rows.
    let run = Run::begin(&cloud, &db);
    let notices = run.until(|n| {
        matches!(n, Notice::Event(Event::MessageStored { id: stored, .. }) if *stored == id("m-5"))
    });
    let stored = notices
        .iter()
        .filter(|n| matches!(n, Notice::Event(Event::MessageStored { .. })))
        .count();
    assert_eq!(stored, 5, "{notices:?}");
    let requests = cloud.requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    let request = requests.first().unwrap();
    assert!(
        request.starts_with("GET /tailchat/api/history?peer=bob&limit=200&deleted=1 HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(
        request.contains(&format!("Authorization: Bearer {}\r\n", token())),
        "{request}"
    );

    let rows = run.handle.conversation(&login("bob"), None, 100).unwrap();
    let texts: Vec<String> = rows
        .iter()
        .map(|row| match row {
            Row::Message(m) => m.text.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    let expected: Vec<String> = (1..=5).map(|n| format!("while you were out {n}")).collect();
    assert_eq!(texts, expected);

    // The newest incoming message is acknowledged to bob, after it was stored.
    let ack = cloud.frame(|f| f.contains("\"t\":\"ack\""));
    assert!(
        ack.contains("\"to\":\"bob\"") && ack.contains("\"id\":\"m-5\""),
        "{ack}"
    );

    // Paging through the handle: newest two, then the two before them.
    let newest = run.handle.conversation(&login("bob"), None, 2).unwrap();
    let ids: Vec<&str> = newest.iter().map(|r| r.id().as_str()).collect();
    assert_eq!(ids, ["m-4", "m-5"]);
    let before = newest.first().map(|r| (r.ts(), r.id().clone())).unwrap();
    let older = run
        .handle
        .conversation(&login("bob"), Some((before.0, &before.1)), 2)
        .unwrap();
    let ids: Vec<&str> = older.iter().map(|r| r.id().as_str()).collect();
    assert_eq!(ids, ["m-2", "m-3"]);
    run.handle.stop();

    // Third run: the cursor survived, so the feed is asked from 5, and the
    // rows are there from the start.
    let again = Run::begin(&cloud, &db);
    assert_eq!(
        again
            .handle
            .conversation(&login("bob"), None, 100)
            .unwrap()
            .len(),
        5
    );
    let sync = cloud.frame(|f| f.contains("\"k\":\"sync\"") && f.contains("\"since\":5"));
    assert!(sync.contains("\"since\":5"));
    again.handle.stop();
}

#[test]
fn a_dial_that_fails_is_retried_with_a_doubling_pause() {
    // A port nothing listens on.
    let port = StdListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let cloud_like = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&cloud_like, &dir.path().join("a.db"));
    cfg.socket_url = format!("ws://127.0.0.1:{port}/tailchat/ws");
    let run = Run::begin_with(cfg, quick(), None);
    let mut pauses = Vec::new();
    for _ in 0..5 {
        run.state(ConnState::Connecting);
        let Notice::Connection(ConnState::Closed {
            retry_in_ms: Some(ms),
        }) = run.next()
        else {
            panic!("expected a closed state with a retry")
        };
        pauses.push(ms);
    }
    assert_eq!(pauses, [20, 40, 80, 80, 80]);
    run.handle.stop();
}

#[test]
fn a_connection_that_reached_ready_starts_the_backoff_over() {
    let mut cloud = Cloud::start();
    cloud.script(|s| {
        s.after_auth = vec![READY.to_owned()];
        s.close_after_auth = true;
    });
    let dir = tempfile::tempdir().unwrap();
    let run = Run::begin(&cloud, &dir.path().join("a.db"));
    for _ in 0..3 {
        run.state(ConnState::Connecting);
        run.state(ConnState::Open);
        run.state(ConnState::Ready);
        assert_eq!(run.next(), Notice::Frame(READY.to_owned()));
        // The pause is the first one every time: `ready` reset it.
        run.state(ConnState::Closed {
            retry_in_ms: Some(20),
        });
    }
    assert!(cloud.connections() >= 3);
    cloud.frame(is_auth);
    run.handle.stop();
}

#[test]
fn a_refused_token_stops_the_dialling_until_told_to() {
    let cloud = Cloud::start();
    let refusal = r#"{"k":"error","code":"auth_failed","message":"no"}"#;
    cloud.script(|s| {
        s.after_auth = vec![refusal.to_owned()];
        s.close_after_auth = true;
    });
    let dir = tempfile::tempdir().unwrap();
    let run = Run::begin(&cloud, &dir.path().join("a.db"));
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    assert_eq!(
        run.next(),
        Notice::Event(Event::ServerError {
            code: "auth_failed".to_owned(),
            peer: None,
            id: None
        })
    );
    assert_eq!(run.next(), Notice::Frame(refusal.to_owned()));
    run.state(ConnState::AuthFailed);
    run.state(ConnState::Closed { retry_in_ms: None });
    // No loop with a dead token: nothing for many backoff periods.
    run.quiet_for(Duration::from_millis(500));
    assert_eq!(cloud.connections(), 1);

    // Asked to, it tries once more (and is refused once more).
    run.send(Command::Reconnect);
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    run.until(|n| {
        matches!(
            n,
            Notice::Connection(ConnState::Closed { retry_in_ms: None })
        )
    });
    run.quiet_for(Duration::from_millis(300));
    assert_eq!(cloud.connections(), 2);
    run.handle.stop();
}

#[test]
fn a_socket_that_goes_silent_is_dropped_by_the_watchdog_and_redialled() {
    let mut cloud = Cloud::start();
    // The server accepts and never says anything, not even `ready`.
    let dir = tempfile::tempdir().unwrap();
    let run = Run::begin(&cloud, &dir.path().join("a.db"));
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    let opened = Instant::now();
    run.state(ConnState::Closed {
        retry_in_ms: Some(20),
    });
    let waited = opened.elapsed();
    assert!(
        waited >= Duration::from_millis(350) && waited < Duration::from_secs(3),
        "{waited:?}"
    );
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    cloud.frame(is_auth);
    run.handle.stop();
}

#[test]
fn pings_and_binary_frames_keep_the_socket_alive_but_are_not_frames() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let run = ready(&mut cloud, &dir.path().join("a.db"));
    // Longer than the watchdog (400 ms) in total, never silent for as long.
    let until = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < until {
        cloud.push(Push::Ping);
        cloud.push(Push::Binary(vec![1, 2, 3]));
        std::thread::sleep(Duration::from_millis(100));
    }
    run.quiet_for(Duration::from_millis(50));
    assert_eq!(cloud.connections(), 1);
    run.handle.stop();
}

#[test]
fn raw_frames_go_out_only_while_ready() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.db");
    // Before `ready`: the server holds `ready` back until told.
    cloud.script(|s| s.after_auth = vec![]);
    let run = Run::begin(&cloud, &db);
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    let subscribe = r#"{"k":"subscribe","peer":"bob"}"#;
    run.send(Command::Raw(subscribe.to_owned()));
    assert_eq!(run.next(), Notice::RawDropped(subscribe.to_owned()));
    // After `ready`: written as is.
    cloud.text(READY);
    run.state(ConnState::Ready);
    assert_eq!(run.next(), Notice::Frame(READY.to_owned()));
    run.send(Command::Raw(subscribe.to_owned()));
    assert_eq!(cloud.frame(|f| f.contains("subscribe")), subscribe);
    // Reconnect: closed at once, dialled again at once, and not ready again
    // until the server says so.
    cloud.script(|s| s.after_auth = vec![]);
    run.send(Command::Reconnect);
    run.state(ConnState::Closed {
        retry_in_ms: Some(0),
    });
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    run.send(Command::Raw(subscribe.to_owned()));
    assert_eq!(run.next(), Notice::RawDropped(subscribe.to_owned()));
    run.handle.stop();
}

#[test]
fn stop_cuts_a_dial_in_progress_short() {
    // A server that accepts the TCP connection and never answers the upgrade.
    let hole = StdListener::bind("127.0.0.1:0").unwrap();
    let port = hole.local_addr().unwrap().port();
    let cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&cloud, &dir.path().join("a.db"));
    cfg.socket_url = format!("ws://127.0.0.1:{port}/tailchat/ws");
    let mut timings = quick();
    timings.dial = Duration::from_secs(30);
    let run = Run::begin_with(cfg, timings, None);
    run.state(ConnState::Connecting);
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    run.handle.stop();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    run.quiet_for(Duration::from_millis(100));
    drop(hole);
}

#[test]
fn stop_from_the_sink_only_signals_and_silences_everything_after() {
    let mut cloud = Cloud::start();
    cloud.script(|s| s.after_auth = vec![READY.to_owned()]);
    let dir = tempfile::tempdir().unwrap();
    let slot: Arc<Mutex<Option<Handle>>> = Arc::default();
    let (tx, notices) = mpsc::channel();
    let handle = start_with(
        config(&cloud, &dir.path().join("a.db")),
        {
            let slot = Arc::clone(&slot);
            move |notice| {
                let open = notice == Notice::Connection(ConnState::Open);
                let _ = tx.send(notice);
                if open && let Some(handle) = slot.lock().unwrap().as_ref() {
                    // Would deadlock if it tried to join its own thread.
                    handle.stop();
                }
            }
        },
        quick(),
        None,
    )
    .unwrap();
    *slot.lock().unwrap() = Some(handle.clone());
    let seen: Vec<Notice> =
        std::iter::from_fn(|| notices.recv_timeout(Duration::from_millis(500)).ok()).collect();
    assert_eq!(
        seen,
        [
            Notice::Connection(ConnState::Connecting),
            Notice::Connection(ConnState::Open)
        ]
    );
    // The server did answer; the driver just no longer tells anybody.
    cloud.frame(is_auth);
    handle.stop();
    assert_eq!(handle.send(Command::Reconnect), Err(Stopped));
    // Break the sink ↔ handle cycle so the driver's clone can go.
    slot.lock().unwrap().take();
}

#[test]
fn concurrent_stops_all_return_only_after_the_thread_is_gone() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.db");
    let run = ready(&mut cloud, &db);
    // One checker at a time: the probe itself takes the lock.
    let gate = Arc::new(Mutex::new(()));
    let stoppers: Vec<_> = (0..4)
        .map(|_| {
            let handle = run.handle.clone();
            let db = db.clone();
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                handle.stop();
                // Whoever comes back from `stop` finds the thread gone, so the
                // instance lock is free.
                let _turn = gate.lock().unwrap();
                InstanceLock::acquire(&db).is_ok()
            })
        })
        .collect();
    for stopper in stoppers {
        assert!(stopper.join().unwrap());
    }
    // And the handle that did not take part sees it too.
    run.handle.stop();
}

#[test]
fn a_server_that_hangs_up_is_redialled_and_ready_again() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let run = ready(&mut cloud, &dir.path().join("a.db"));
    cloud.push(Push::Close);
    run.state(ConnState::Closed {
        retry_in_ms: Some(20),
    });
    run.state(ConnState::Connecting);
    run.state(ConnState::Open);
    run.state(ConnState::Ready);
    assert_eq!(run.next(), Notice::Frame(READY.to_owned()));
    assert_eq!(cloud.connections(), 2);
    run.handle.stop();
}

#[test]
fn a_second_driver_on_the_same_store_is_refused_and_a_wrong_key_is_not_a_lock() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.db");
    let run = ready(&mut cloud, &db);
    let second = start_with(config(&cloud, &db), |_| {}, quick(), None);
    assert!(matches!(second, Err(StartError::Locked)));
    run.handle.stop();

    let mut wrong = config(&cloud, &db);
    wrong.key = Key::from_bytes(&[9; 32]);
    let refused = start_with(wrong, |_| {}, quick(), None);
    assert!(matches!(
        refused,
        Err(StartError::Store(tailchat_store::Error::WrongKey))
    ));
    // A refused start leaves no lock behind.
    Run::begin(&cloud, &db).handle.stop();
}

#[test]
fn unusable_configuration_is_refused_before_anything_starts() {
    let cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.db");
    let attempt = |edit: &dyn Fn(&mut Config)| {
        let mut cfg = config(&cloud, &db);
        edit(&mut cfg);
        start_with(cfg, |_| {}, quick(), None)
            .err()
            .map(|e| e.to_string())
    };
    assert!(
        attempt(&|c| c.token = "nope".to_owned())
            .unwrap()
            .contains("64 lowercase hex")
    );
    assert!(
        attempt(&|c| c.token = "AB".repeat(32))
            .unwrap()
            .contains("64 lowercase hex")
    );
    assert_eq!(
        attempt(&|c| c.socket_url = "http://x/ws".to_owned()).unwrap(),
        "bad URL in socket_url"
    );
    assert_eq!(
        attempt(&|c| c.socket_url = "not a url".to_owned()).unwrap(),
        "bad URL in socket_url"
    );
    assert_eq!(
        attempt(&|c| c.http_base = "ws://x".to_owned()).unwrap(),
        "bad URL in http_base"
    );
    assert_eq!(
        attempt(&|c| c.http_base = "http://x/?q".to_owned()).unwrap(),
        "bad URL in http_base"
    );
    // Nothing above touched the disk.
    assert!(!db.exists());
}

#[test]
fn config_debug_hides_the_token_and_the_key() {
    let cloud = Cloud::start();
    let text = format!("{:?}", config(&cloud, Path::new("a.db")));
    assert!(!text.contains(&token()));
    assert!(text.contains("***"));
}

#[test]
fn frames_up_to_max_inbound_are_read_and_bigger_ones_drop_the_socket() {
    let mut cloud = Cloud::start();
    let dir = tempfile::tempdir().unwrap();
    let run = ready(&mut cloud, &dir.path().join("a.db"));
    // Exactly the limit: a frame like any other (this one is not JSON).
    cloud.text(&"x".repeat(MAX_INBOUND));
    let notices = run.until(|n| matches!(n, Notice::Frame(_)));
    assert!(
        matches!(notices.first(), Some(Notice::Event(Event::BadFrame { .. }))),
        "{}",
        notices.len()
    );
    // One byte more: refused by the socket before it is read.
    cloud.text(&"x".repeat(MAX_INBOUND + 1));
    run.state(ConnState::Closed {
        retry_in_ms: Some(20),
    });
    run.handle.stop();
}

#[test]
fn wss_and_https_work_against_a_server_the_client_trusts() {
    let (server, client) = tls_pair();
    let cloud = Cloud::start_tls(server);
    let dir = tempfile::tempdir().unwrap();
    cloud.script(|s| {
        s.after_auth = vec![READY_SYNC.to_owned()];
        s.on_sync = vec![
            r#"{"k":"sync-page","events":[{"seq":1,"kind":"message","peer":"bob","id":"m-1","ts":1000,"from":"bob"}],"cursor":1,"more":false,"reset":false}"#.to_owned(),
        ];
    });
    cloud.history(|h| {
        h.answers = vec![(
            200,
            r#"{"messages":[{"id":"m-1","from":"bob","ts":1000,"text":"over tls"}]}"#.to_owned(),
        )];
    });
    let run = Run::begin_with(
        config(&cloud, &dir.path().join("a.db")),
        quick(),
        Some(client),
    );
    run.until(|n| matches!(n, Notice::Event(Event::MessageStored { .. })));
    let rows = run.handle.conversation(&login("bob"), None, 10).unwrap();
    assert!(matches!(rows.as_slice(), [Row::Message(m)] if m.text == "over tls"));
    run.handle.stop();
}

#[test]
fn a_certificate_the_client_does_not_trust_is_never_a_connection() {
    let (server, _client_that_trusts_it) = tls_pair();
    let cloud = Cloud::start_tls(server);
    let dir = tempfile::tempdir().unwrap();
    // The default configuration trusts Mozilla's roots only.
    let run = Run::begin_with(config(&cloud, &dir.path().join("a.db")), quick(), None);
    for _ in 0..2 {
        run.state(ConnState::Connecting);
        assert!(matches!(
            run.next(),
            Notice::Connection(ConnState::Closed {
                retry_in_ms: Some(_)
            })
        ));
    }
    run.handle.stop();
}
