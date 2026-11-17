//! The executor: carries out what the core says, in the order it says it.
//!
//! This is the contract of spec §2 and the stage 2–3 contracts, in one place:
//!
//! - `Output`s run strictly in order. A `Persist` is applied (and durable)
//!   before any later `Send`.
//! - A failed `Persist` drops the rest of the batch, reports
//!   [`Notice::StorageFailed`] and rebuilds the core from the disk: the core
//!   never runs ahead of what is stored. Should the disk not read back either,
//!   the old core is kept out of play ("stale") and retried before the next
//!   dial.
//! - A failed `Send` drops the rest of the batch (except `Fetch`es, which the
//!   core waits for), feeds [`Input::SendFailed`] when the frame names a
//!   message or receipt (else [`Input::Disconnected`]) and tells the driver to
//!   close the socket.
//! - Every `Fetch` is started and answered exactly once, whatever the socket
//!   does meanwhile.
//! - A server refusal of the token (`auth_failed`, `auth_required`) is passed
//!   on as [`Flow::AuthFailed`]: no more dialling with a dead token.
//!
//! The executor is generic over the store and the socket so the ordering is
//! tested without either.

use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;
use futures_util::stream::FuturesUnordered;
use tailchat_core::{
    Action, ApiRequest, Core, CoreError, Event, FetchError, HistoryRequest, Input, Login,
    MessageId, Output, Snapshot, Storage, StoreOp, Token, Ts, frames,
};
use zeroize::Zeroizing;

use crate::{ConnState, Notice};

/// How many follow-up inputs one `feed` chases before giving up: a write that
/// fails answers with `SendFailed`, which must not write again. This only
/// bounds a core that would not honour that.
const HOPS_MAX: usize = 8;

/// The cloud's HTTP side as the executor sees it: the history GET and the key
/// POSTs, each with the bearer token. Every returned future resolves exactly
/// once, with the body of a `200` or the reason it is not one.
pub trait Fetch {
    /// `GET <base><path>`.
    fn get(&self, path: &str) -> LocalBoxFuture<'static, Result<String, FetchError>>;
    /// `POST <base><path>` with a JSON `body`.
    fn post(&self, path: &str, body: &str) -> LocalBoxFuture<'static, Result<String, FetchError>>;
}

/// A socket as the executor sees it.
#[allow(async_fn_in_trait)]
pub trait Wire {
    /// Writes one text frame and flushes it. `Err`: the socket did not take
    /// it and is unusable from now on.
    async fn write(&mut self, text: &str) -> Result<(), WriteFailed>;
}

/// The socket refused a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteFailed;

/// What the driver must do with the link after an input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    /// Nothing: the socket stays as it is.
    Continue,
    /// Close the socket and dial again after the backoff.
    Drop,
    /// The server refused the token: close the socket and stay down.
    AuthFailed,
}

/// The shared, lockable store. `None` once the driver has closed it.
pub type Store<S> = Arc<Mutex<Option<S>>>;

/// Locks `mutex`; a panic elsewhere never makes the store unreadable (every
/// batch is a transaction, there is no half-written state to protect).
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Where notices go. Nothing is delivered once `stopping` is set, not even the
/// rest of the batch that was in progress.
pub struct Notices {
    /// The caller's sink, called on the driver thread.
    sink: Box<dyn FnMut(Notice) + Send>,
    /// Set by `Handle::stop`.
    stopping: Arc<AtomicBool>,
    /// The last connection state announced, so a repeat is not announced twice.
    state: Option<ConnState>,
}

impl Notices {
    /// Notices into `sink` until `stopping` is set.
    pub fn new(sink: Box<dyn FnMut(Notice) + Send>, stopping: Arc<AtomicBool>) -> Self {
        Self {
            sink,
            stopping,
            state: None,
        }
    }

    /// Delivers one notice, unless the driver is stopping.
    pub fn emit(&mut self, notice: Notice) {
        if !self.stopping.load(Ordering::Acquire) {
            (self.sink)(notice);
        }
    }

    /// Announces a connection state, unless it is the one announced last.
    pub fn state(&mut self, state: ConnState) {
        if self.state != Some(state) {
            self.state = Some(state);
            self.emit(Notice::Connection(state));
        }
    }
}

/// Who the driver works for: what rebuilding the core needs.
pub struct Identity {
    /// The account.
    pub login: Login,
    /// The raw bearer token, wiped on drop.
    pub token: Arc<Zeroizing<String>>,
    /// Capabilities claimed on top of the core's own.
    pub extra_caps: Vec<String>,
    /// End-to-end encryption is on for this account.
    pub e2ee: bool,
    /// The browser's driver: `auth` says `webFeatures: true`.
    pub web_features: bool,
    /// What `keys/upload` calls this device; empty sends no name.
    pub device_name: String,
}

impl Identity {
    /// A core for this account from what the disk holds, claiming the extra
    /// capabilities. The first core and every rebuilt one come from here.
    pub fn core(&self, snapshot: Snapshot) -> Result<Core, CoreError> {
        let token = Token::parse(&self.token)?;
        let mut core = Core::new(self.login.clone(), token, snapshot);
        core.set_extra_caps(self.extra_caps.clone());
        core.set_e2ee(self.e2ee);
        core.set_web_features(self.web_features);
        core.set_device_name(self.device_name.clone());
        Ok(core)
    }
}

/// The answer to one `Output::Fetch` or `Output::Post`.
pub enum Answer {
    /// A history page.
    History {
        /// The request, as the core issued it.
        request: HistoryRequest,
        /// What came of it.
        outcome: Result<String, FetchError>,
    },
    /// A key request.
    Post {
        /// The request, as the core issued it.
        request: ApiRequest,
        /// What came of it.
        outcome: Result<String, FetchError>,
    },
}

impl Answer {
    /// The input that hands this answer to the core.
    pub fn into_input(self) -> Input {
        match self {
            Self::History {
                request,
                outcome: Ok(body),
            } => Input::History { request, body },
            Self::History {
                request,
                outcome: Err(error),
            } => Input::HistoryFailed { request, error },
            Self::Post {
                request,
                outcome: Ok(body),
            } => Input::Posted { request, body },
            Self::Post {
                request,
                outcome: Err(error),
            } => Input::PostFailed { request, error },
        }
    }
}

/// How one batch of outputs ended.
enum Batch {
    /// All of it ran.
    Done,
    /// A write failed; this input reports it.
    Failed(Input),
    /// A `Persist` failed; the core must be rebuilt from the disk.
    Stale,
}

/// The core, the store, the notices and the history requests in flight.
pub struct Exec<S: Storage> {
    /// The engine.
    pub core: Core,
    /// The disk, shared with `Handle::conversation`.
    store: Store<S>,
    /// What rebuilding the core needs.
    identity: Identity,
    /// Where the UI hears about things.
    pub notices: Notices,
    /// The history GET and the key POSTs.
    fetcher: Rc<dyn Fetch>,
    /// The wall clock, in milliseconds since the Unix epoch.
    now: fn() -> Ts,
    /// HTTP requests in flight; each yields exactly one [`Answer`].
    pub fetches: FuturesUnordered<LocalBoxFuture<'static, Answer>>,
    /// A write failed and the core could not be rebuilt from the disk since:
    /// it may be ahead of what is stored and sees no input until it is rebuilt.
    stale: bool,
    /// The server refused the token during the current input.
    refused: bool,
    /// The action being handled, until an event shows its row reached the
    /// disk: a storage failure before that refuses it.
    awaiting: Option<(Login, MessageId)>,
}

impl<S: Storage> Exec<S> {
    /// An executor around a core freshly built from `store`, reading the time
    /// from `now`.
    pub fn new(
        core: Core,
        store: Store<S>,
        identity: Identity,
        notices: Notices,
        fetcher: impl Fetch + 'static,
        now: fn() -> Ts,
    ) -> Self {
        Self {
            core,
            store,
            identity,
            notices,
            fetcher: Rc::new(fetcher),
            now,
            fetches: FuturesUnordered::new(),
            stale: false,
            refused: false,
            awaiting: None,
        }
    }

    /// Whether the core matches the disk; rebuilds it first if a failed write
    /// left it ahead. Reports [`Notice::StorageFailed`] when that fails.
    pub fn heal(&mut self) -> bool {
        if !self.stale {
            return true;
        }
        match self.rebuild() {
            Ok(()) => true,
            Err(reason) => {
                self.notices.emit(Notice::StorageFailed { reason });
                false
            }
        }
    }

    /// A new core from what the disk holds.
    fn rebuild(&mut self) -> Result<(), String> {
        let snapshot = {
            let guard = lock(&self.store);
            let store = guard.as_ref().ok_or("the store is closed")?;
            store.load().map_err(|error| error.to_string())?
        };
        self.core = self
            .identity
            .core(snapshot)
            .map_err(|error| error.to_string())?;
        self.stale = false;
        Ok(())
    }

    /// Hands one input to the core and carries out everything that follows.
    /// `wire` is the socket, if there is one.
    pub async fn feed<W: Wire>(&mut self, wire: Option<&mut W>, input: Input) -> Flow {
        let awaited = action_key(&input);
        if !self.heal() {
            if let Some((peer, id)) = awaited {
                self.notices.emit(Notice::ActionRefused {
                    peer,
                    id,
                    held: false,
                    reason: "the store is unavailable".to_owned(),
                });
            }
            return Flow::Drop;
        }
        self.refused = false;
        self.awaiting = awaited;
        let mut wire = wire;
        let mut flow = Flow::Continue;
        let mut next = Some(input);
        let mut hops = 0usize;
        while let Some(input) = next.take() {
            hops += 1;
            if hops > HOPS_MAX {
                flow = Flow::Drop;
                break;
            }
            let action = matches!(input, Input::Action(_));
            let outputs = match self.core.handle((self.now)(), input) {
                Ok(outputs) => outputs,
                Err(error) => {
                    // The core is where it was before the input.
                    let held = matches!(error, CoreError::DuplicateMessageId);
                    let reason = error.to_string();
                    match self.awaiting.take().filter(|_| action) {
                        Some((peer, id)) => self.notices.emit(Notice::ActionRefused {
                            peer,
                            id,
                            held,
                            reason,
                        }),
                        None => self.notices.emit(Notice::Event(Event::BadFrame { reason })),
                    }
                    continue;
                }
            };
            match self.run(outputs, wire.as_deref_mut()).await {
                Batch::Done => {}
                Batch::Failed(follow_up) => {
                    flow = Flow::Drop;
                    wire = None;
                    next = Some(follow_up);
                }
                Batch::Stale => {
                    flow = Flow::Drop;
                    // The action's own batch failed before its row was stored:
                    // the rebuilt core has never heard of it.
                    if let Some((peer, id)) = self.awaiting.take().filter(|_| action) {
                        self.notices.emit(Notice::ActionRefused {
                            peer,
                            id,
                            held: false,
                            reason: "the local store failed".to_owned(),
                        });
                    }
                    self.stale = true;
                    self.heal();
                    break;
                }
            }
        }
        self.awaiting = None;
        if self.refused {
            flow = Flow::AuthFailed;
        }
        flow
    }

    /// Carries out one batch, in order.
    async fn run<W: Wire>(&mut self, outputs: Vec<Output>, mut wire: Option<&mut W>) -> Batch {
        let mut rest = outputs.into_iter();
        while let Some(output) = rest.next() {
            match output {
                Output::Send(text) => {
                    // The auth frame carries the token: wipe our copy.
                    let text = Zeroizing::new(text);
                    let written = match wire.as_deref_mut() {
                        Some(wire) => wire.write(&text).await.is_ok(),
                        None => false,
                    };
                    if !written {
                        // The batch stops here. A `Fetch` or `Post` is
                        // neither disk nor socket and the core waits for its
                        // answer for good, so those still go.
                        for output in rest {
                            match output {
                                Output::Fetch(request) => self.fetch(request),
                                Output::Post(request) => self.post(request),
                                _ => {}
                            }
                        }
                        return Batch::Failed(match frames::send_key(&text) {
                            Some((peer, id)) => Input::SendFailed { peer, id },
                            None => Input::Disconnected,
                        });
                    }
                }
                Output::Persist(ops) => {
                    if let Err(reason) = self.persist(&ops) {
                        self.notices.emit(Notice::StorageFailed { reason });
                        return Batch::Stale;
                    }
                }
                Output::Event(event) => self.event(event),
                Output::Fetch(request) => self.fetch(request),
                Output::Post(request) => self.post(request),
            }
        }
        Batch::Done
    }

    /// Applies `ops` in one transaction. The lock is gone before this returns:
    /// no notice is ever delivered while it is held.
    fn persist(&self, ops: &[StoreOp]) -> Result<(), String> {
        let mut guard = lock(&self.store);
        let store = guard.as_mut().ok_or("the store is closed")?;
        store.apply(ops).map_err(|error| error.to_string())
    }

    /// Tells the UI, and notes a refused token and a stored action on the way.
    fn event(&mut self, event: Event) {
        if let Event::ServerError { code, .. } = &event
            && matches!(code.as_str(), "auth_failed" | "auth_required")
        {
            self.refused = true;
        }
        let stored = match &event {
            Event::MessageAdded(message) => Some((&message.peer, &message.id)),
            Event::ReceiptChanged { peer, id, .. } => Some((peer, id)),
            _ => None,
        };
        if let (Some((peer, id)), Some((awaited_peer, awaited_id))) = (stored, &self.awaiting)
            && peer == awaited_peer
            && id == awaited_id
        {
            self.awaiting = None;
        }
        self.notices.emit(Notice::Event(event));
    }

    /// Starts one history request; it is answered exactly once, through
    /// `fetches`.
    fn fetch(&mut self, request: HistoryRequest) {
        let pending = self.fetcher.get(&request.path());
        self.fetches.push(
            async move {
                let outcome = pending.await;
                Answer::History { request, outcome }
            }
            .boxed_local(),
        );
    }

    /// Starts one key request; it is answered exactly once, through
    /// `fetches`.
    fn post(&mut self, request: ApiRequest) {
        let pending = self.fetcher.post(request.call.path(), &request.body);
        self.fetches.push(
            async move {
                let outcome = pending.await;
                Answer::Post { request, outcome }
            }
            .boxed_local(),
        );
    }
}

/// The message an action names: a send's new id, the row `Retry` or
/// `SendUnencrypted` acts on, the message an edit changes.
fn action_key(input: &Input) -> Option<(Login, MessageId)> {
    match input {
        Input::Action(
            Action::SendText { peer, id, .. }
            | Action::SendImage { peer, id, .. }
            | Action::SendWith { peer, id, .. }
            | Action::EditText {
                peer, target: id, ..
            }
            | Action::Retry { peer, id }
            | Action::SendUnencrypted { peer, id },
        ) => Some((peer.clone(), id.clone())),
        _ => None,
    }
}

#[cfg(test)]
#[cfg(feature = "native")]
mod tests {
    use std::io;
    use std::net::TcpListener;
    use std::time::Duration;

    use futures_util::StreamExt as _;
    use tailchat_core::{
        Action, Backfill, Held, MessageId, Outgoing, PendingOutgoing, Receipt, Snapshot, Ts,
    };

    use super::*;

    use crate::mem_store::MemStore;

    /// The order in which the store and the socket were touched.
    type Log = Arc<Mutex<Vec<String>>>;

    /// `MemStore` that writes down every `apply` and can be made unreadable,
    /// or made to refuse the batches that carry one kind of op.
    struct Logged {
        inner: MemStore,
        log: Log,
        unreadable: Arc<AtomicBool>,
        fail_kind: Option<&'static str>,
    }

    impl Storage for Logged {
        type Error = io::Error;

        fn apply(&mut self, ops: &[StoreOp]) -> io::Result<()> {
            let kinds: Vec<&str> = ops
                .iter()
                .map(|op| match op {
                    StoreOp::PutPending(_) => "pending",
                    StoreOp::SetAttempt { .. } => "attempt",
                    StoreOp::DropPending { .. } => "drop",
                    StoreOp::PutOutgoing(_) => "outgoing",
                    _ => "other",
                })
                .collect();
            let result = if self.fail_kind.is_some_and(|kind| kinds.contains(&kind)) {
                Err(io::Error::other("refused by the test"))
            } else {
                self.inner.apply(ops)
            };
            let failed = if result.is_err() { "!" } else { "" };
            self.log
                .lock()
                .unwrap()
                .push(format!("apply[{}]{failed}", kinds.join(",")));
            result
        }

        fn load(&self) -> io::Result<Snapshot> {
            if self.unreadable.load(Ordering::SeqCst) {
                return Err(io::Error::other("unreadable"));
            }
            self.inner.load()
        }
    }

    /// A socket that records what it is given and refuses the n-th write.
    struct FakeWire {
        log: Log,
        frames: Vec<String>,
        writes: usize,
        fail_on: Option<usize>,
    }

    impl FakeWire {
        fn new(log: &Log) -> Self {
            Self {
                log: Arc::clone(log),
                frames: Vec::new(),
                writes: 0,
                fail_on: None,
            }
        }

        /// The next write is refused.
        fn refuse_next(&mut self) {
            self.fail_on = Some(self.writes + 1);
        }
    }

    impl Wire for FakeWire {
        async fn write(&mut self, text: &str) -> Result<(), WriteFailed> {
            self.writes += 1;
            if self.fail_on == Some(self.writes) {
                self.log.lock().unwrap().push("write!".to_owned());
                return Err(WriteFailed);
            }
            let kind = if text.contains("\"k\":\"auth\"") {
                "auth".to_owned()
            } else if text.contains("\"t\":\"msg\"") {
                "msg".to_owned()
            } else if text.contains("\"t\":\"ack\"") {
                "ack".to_owned()
            } else {
                "frame".to_owned()
            };
            self.log.lock().unwrap().push(format!("write {kind}"));
            self.frames.push(text.to_owned());
            Ok(())
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

    const READY: &str = r#"{"k":"ready","self":{"login":"alice","name":"Alice"},"users":[{"login":"bob","name":"Bob"}],"caps":["durable-ack"]}"#;

    /// An executor over a logged `MemStore`, plus handles to watch it.
    struct Rig {
        exec: Exec<Logged>,
        store: Store<Logged>,
        log: Log,
        queue: Arc<Mutex<Vec<Notice>>>,
        unreadable: Arc<AtomicBool>,
        /// Nothing listens here: a fetch is refused at once.
        dead_port: u16,
    }

    impl Rig {
        fn new() -> Self {
            Self::with_store(MemStore::default())
        }

        fn with_store(inner: MemStore) -> Self {
            let log: Log = Arc::default();
            let unreadable: Arc<AtomicBool> = Arc::default();
            let logged = Logged {
                inner,
                log: Arc::clone(&log),
                unreadable: Arc::clone(&unreadable),
                fail_kind: None,
            };
            let identity = Identity {
                login: login("alice"),
                token: Arc::new(Zeroizing::new(token())),
                extra_caps: vec!["read-ack-v1".to_owned()],
                e2ee: false,
                web_features: false,
                device_name: String::new(),
            };
            let core = identity.core(logged.load().unwrap()).unwrap();
            let store: Store<Logged> = Arc::new(Mutex::new(Some(logged)));
            let queue: Arc<Mutex<Vec<Notice>>> = Arc::default();
            let sink_queue = Arc::clone(&queue);
            let notices = Notices::new(
                Box::new(move |notice| sink_queue.lock().unwrap().push(notice)),
                Arc::default(),
            );
            let dead_port = TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            let fetcher = crate::http::Fetcher::new(
                crate::http::Endpoint::parse(&format!("http://127.0.0.1:{dead_port}/")).unwrap(),
                crate::tls::config().unwrap(),
                Arc::new(Zeroizing::new(token())),
                Duration::from_secs(5),
                1 << 20,
            );
            let exec = Exec::new(
                core,
                Arc::clone(&store),
                identity,
                notices,
                Rc::new(fetcher),
                crate::clock::now,
            );
            Self {
                exec,
                store,
                log,
                queue,
                unreadable,
                dead_port,
            }
        }

        /// Everything announced since the last call.
        fn seen(&self) -> Vec<Notice> {
            std::mem::take(&mut *self.queue.lock().unwrap())
        }

        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn forget_log(&self) {
            self.log.lock().unwrap().clear();
        }

        /// The pending rows on disk.
        fn pending(&self) -> Vec<PendingOutgoing> {
            self.store
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .inner
                .snapshot
                .pending
                .clone()
        }

        /// Takes the connection through `Connected` and a `ready` that
        /// whitelists bob.
        async fn ready(&mut self, wire: &mut FakeWire) {
            let flow = self.exec.feed(Some(wire), Input::Connected).await;
            assert_eq!(flow, Flow::Continue);
            let flow = self
                .exec
                .feed(Some(wire), Input::Frame(READY.to_owned()))
                .await;
            assert_eq!(flow, Flow::Continue);
            assert!(self.exec.core.is_ready());
        }
    }

    fn send_text(id_text: &str, text: &str) -> Input {
        Input::Action(Action::SendText {
            id: id(id_text),
            peer: login("bob"),
            text: text.to_owned(),
        })
    }

    fn send_image(id_image: &str, data_url: &str) -> Input {
        Input::Action(Action::SendImage {
            id: id(id_image),
            peer: login("bob"),
            text: String::new(),
            image: tailchat_core::Image {
                data_url: data_url.to_owned(),
                width: None,
                height: None,
            },
        })
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn auth_frame_goes_first_and_claims_the_extra_caps() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            let flow = rig.exec.feed(Some(&mut wire), Input::Connected).await;
            assert_eq!(flow, Flow::Continue);
            assert_eq!(rig.log(), ["write auth"]);
            let auth = wire.frames.first().unwrap();
            assert!(auth.contains(&token()));
            assert!(
                auth.contains("\"durable-ack\"") && auth.contains("\"read-ack-v1\""),
                "{auth}"
            );
        });
    }

    #[test]
    fn persist_is_applied_before_the_send_it_covers() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Continue);
            let log = rig.log();
            let apply = log.iter().position(|l| l == "apply[pending]").unwrap();
            let charged = log.iter().position(|l| l == "apply[attempt]").unwrap();
            let write = log.iter().position(|l| l == "write msg").unwrap();
            assert!(apply < charged && charged < write, "{log:?}");
            assert!(
                rig.seen().iter().any(
                    |n| matches!(n, Notice::Event(Event::MessageAdded(m)) if m.text == "hello")
                )
            );
        });
    }

    #[test]
    fn a_refused_write_feeds_send_failed_and_drops_the_rest_of_the_batch() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            // The socket refuses the message frame itself.
            wire.refuse_next();
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Drop);
            // The core was told: no longer ready, and the attempt it charged
            // before the write is back on the stored row.
            assert!(!rig.exec.core.is_ready());
            let pending = rig.pending();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending.first().unwrap().attempts, 0, "attempt refunded");
            // The refusal is the last thing that touched the socket, and the
            // refund was stored after it.
            let log = rig.log();
            let refused = log.iter().position(|l| l == "write!").unwrap();
            assert!(
                log.iter().skip(refused + 1).all(|l| l.starts_with("apply")),
                "{log:?}"
            );
            assert_eq!(log.last().unwrap(), "apply[attempt]", "{log:?}");
        });
    }

    #[test]
    fn a_refused_write_of_a_frame_without_a_key_means_disconnected() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            // The auth frame names no (peer, id).
            wire.refuse_next();
            let flow = rig.exec.feed(Some(&mut wire), Input::Connected).await;
            assert_eq!(flow, Flow::Drop);
            assert!(!rig.exec.core.is_ready());
            // Ready on the next connection works as usual.
            let mut next = FakeWire::new(&rig.log);
            rig.ready(&mut next).await;
        });
    }

    #[test]
    fn no_socket_at_all_refunds_like_a_refused_write() {
        // An output that needs a socket when there is none must not be
        // swallowed: the attempt it would have charged is given back.
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            let flow = rig
                .exec
                .feed::<FakeWire>(None, send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Drop);
            assert!(!rig.exec.core.is_ready());
            assert_eq!(rig.pending().first().unwrap().attempts, 0);
        });
    }

    #[test]
    fn a_failed_persist_rebuilds_the_core_from_the_disk() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            rig.store.lock().unwrap().as_mut().unwrap().inner.fail = true;
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Drop);
            // Persist came first, failed, and the send after it never happened.
            assert_eq!(rig.log(), ["apply[pending]!"]);
            let notices = rig.seen();
            assert!(
                notices
                    .iter()
                    .any(|n| matches!(n, Notice::StorageFailed { .. })),
                "{notices:?}"
            );
            // Not even the event for the row that never reached the disk, and
            // the action is refused by name: the UI takes that row back.
            assert!(
                !notices
                    .iter()
                    .any(|n| matches!(n, Notice::Event(Event::MessageAdded(_)))),
                "{notices:?}"
            );
            assert!(
                notices.iter().any(|n| matches!(
                    n,
                    Notice::ActionRefused { peer, id: refused, held: false, .. }
                        if peer == &login("bob") && refused == &id("m-1")
                )),
                "{notices:?}"
            );
            assert!(rig.pending().is_empty());
            // The core is a fresh one: not ready, and it does not remember the
            // message — the same id is accepted again instead of refused as a
            // duplicate.
            assert!(!rig.exec.core.is_ready());
            let mut next = FakeWire::new(&rig.log);
            rig.ready(&mut next).await;
            rig.forget_log();
            let flow = rig
                .exec
                .feed(Some(&mut next), send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Continue);
            assert!(rig.log().contains(&"write msg".to_owned()));
            assert!(
                !rig.seen()
                    .iter()
                    .any(|n| matches!(n, Notice::ActionRefused { .. })),
                "a duplicate id would be refused"
            );
            // The rebuilt core claims the extra caps like the first one did.
            let auth = next.frames.first().unwrap();
            assert!(auth.contains("\"read-ack-v1\""), "{auth}");
        });
    }

    #[test]
    fn a_storage_failure_after_the_row_is_stored_does_not_refuse_the_action() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            rig.seen();
            // The row is written, the attempt charge after it fails.
            rig.store.lock().unwrap().as_mut().unwrap().fail_kind = Some("attempt");
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Drop);
            assert_eq!(rig.log(), ["apply[pending]", "apply[attempt]!"]);
            let notices = rig.seen();
            assert!(
                notices
                    .iter()
                    .any(|n| matches!(n, Notice::Event(Event::MessageAdded(_)))),
                "{notices:?}"
            );
            assert!(
                !notices
                    .iter()
                    .any(|n| matches!(n, Notice::ActionRefused { .. })),
                "the message is queued on disk and will go: {notices:?}"
            );
            assert_eq!(rig.pending().len(), 1);
            // The rebuilt core holds it: the same id again is a duplicate.
            rig.store.lock().unwrap().as_mut().unwrap().fail_kind = None;
            rig.exec
                .feed::<FakeWire>(None, send_text("m-1", "hello"))
                .await;
            assert!(
                rig.seen().iter().any(|n| matches!(
                    n,
                    Notice::ActionRefused { id: refused, held: true, .. } if refused == &id("m-1")
                )),
                "a duplicate id is refused by name, as a message the core holds"
            );
        });
    }

    #[test]
    fn a_core_that_cannot_be_rebuilt_sees_nothing_until_it_can() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            // The write fails and the disk does not read back either.
            rig.store.lock().unwrap().as_mut().unwrap().inner.fail = true;
            rig.unreadable.store(true, Ordering::SeqCst);
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-1", "hello"))
                .await;
            assert_eq!(flow, Flow::Drop);
            let notices = rig.seen();
            assert_eq!(
                notices
                    .iter()
                    .filter(|n| matches!(n, Notice::StorageFailed { .. }))
                    .count(),
                2,
                "the write, then the rebuild: {notices:?}"
            );
            // The stale core is not fed: an action is refused outright.
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-2", "again"))
                .await;
            assert_eq!(flow, Flow::Drop);
            let notices = rig.seen();
            assert!(
                notices
                    .iter()
                    .any(|n| matches!(n, Notice::ActionRefused { .. })),
                "{notices:?}"
            );
            assert!(rig.pending().is_empty());
            // The disk reads again: the core is rebuilt before the next input.
            rig.unreadable.store(false, Ordering::SeqCst);
            assert!(rig.exec.heal());
            assert!(!rig.exec.core.is_ready());
            let mut next = FakeWire::new(&rig.log);
            rig.ready(&mut next).await;
        });
    }

    #[test]
    fn auth_refusal_is_a_flow_for_the_input_that_brought_it() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.exec.feed(Some(&mut wire), Input::Connected).await;
            let refusal = r#"{"k":"error","code":"auth_failed","message":"no"}"#;
            let flow = rig
                .exec
                .feed(Some(&mut wire), Input::Frame(refusal.to_owned()))
                .await;
            assert_eq!(flow, Flow::AuthFailed);
            assert!(rig.seen().iter().any(|n| matches!(
                n,
                Notice::Event(Event::ServerError { code, .. }) if code == "auth_failed"
            )));
            // The next input is judged on its own.
            let flow = rig.exec.feed(Some(&mut wire), Input::Tick).await;
            assert_eq!(flow, Flow::Continue);
            // Another server error is just an event.
            let other = r#"{"k":"error","code":"unknown_action","message":"?"}"#;
            let flow = rig
                .exec
                .feed(Some(&mut wire), Input::Frame(other.to_owned()))
                .await;
            assert_eq!(flow, Flow::Continue);
            let required = r#"{"k":"error","code":"auth_required","message":"?"}"#;
            let flow = rig
                .exec
                .feed(Some(&mut wire), Input::Frame(required.to_owned()))
                .await;
            assert_eq!(flow, Flow::AuthFailed);
        });
    }

    #[test]
    fn a_refused_action_is_reported_and_changes_nothing() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            rig.seen();
            let flow = rig
                .exec
                .feed(Some(&mut wire), send_text("m-1", "   "))
                .await;
            assert_eq!(flow, Flow::Continue);
            assert!(rig.log().is_empty());
            let notices = rig.seen();
            assert!(
                matches!(
                    notices.as_slice(),
                    [Notice::ActionRefused { held: false, .. }]
                ),
                "{notices:?}"
            );
        });
    }

    /// A picture the core refuses names its own id, not a generic bad frame.
    #[test]
    fn a_refused_picture_is_reported_as_its_action() {
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            rig.ready(&mut wire).await;
            rig.forget_log();
            rig.seen();
            let flow = rig
                .exec
                .feed(
                    Some(&mut wire),
                    send_image("m-1", "data:image/svg+xml;base64,AAAA"),
                )
                .await;
            assert_eq!(flow, Flow::Continue);
            assert!(rig.log().is_empty());
            let notices = rig.seen();
            assert!(
                matches!(
                    notices.as_slice(),
                    [Notice::ActionRefused { peer, id: refused, held: false, .. }]
                        if peer == &login("bob") && refused == &id("m-1")
                ),
                "{notices:?}"
            );
        });
    }

    #[test]
    fn a_fetch_started_before_a_refused_write_is_answered_anyway() {
        // The disk holds a queued message and a history debt. `ready` makes the
        // core start a walk and write the message in one batch; the socket
        // refuses the write. The walk was already under way and must be
        // answered: the core waits for it for good.
        block_on(async {
            let mut inner = MemStore::default();
            inner.snapshot.pending.push(PendingOutgoing {
                message: Outgoing {
                    extra: Default::default(),
                    id: id("m-1"),
                    peer: login("bob"),
                    ts: Ts(1),
                    text: "queued".to_owned(),
                    image: None,
                    receipt: Receipt::Queued,
                },
                attempts: 0,
                next_attempt_at: Ts(0),
                seal: tailchat_core::Seal::Undecided,
            });
            inner.snapshot.backfill.push(Backfill {
                peer: login("bob"),
                owed: vec![id("m-9")],
                reseed: None,
            });
            inner.snapshot.held.push(Held {
                peer: login("bob"),
                id: id("m-0"),
                edited_at: None,
            });
            let mut rig = Rig::with_store(inner);
            let mut wire = FakeWire::new(&rig.log);
            rig.exec.feed(Some(&mut wire), Input::Connected).await;
            wire.refuse_next();
            let flow = rig
                .exec
                .feed(Some(&mut wire), Input::Frame(READY.to_owned()))
                .await;
            assert_eq!(flow, Flow::Drop);
            assert_eq!(rig.exec.fetches.len(), 1, "the walk was started");
            // The queued message did not go out, and its attempt is refunded.
            assert_eq!(rig.pending().first().unwrap().attempts, 0);
            let answers = settle(&mut rig.exec).await;
            // Nothing listens on the fetcher's port: a network failure,
            // delivered as an answer rather than lost.
            assert!(
                matches!(
                    answers.into_input(),
                    Input::HistoryFailed {
                        error: FetchError::Network,
                        ..
                    }
                ),
                "port {}",
                rig.dead_port
            );
        });
    }

    #[test]
    fn a_fetch_after_a_refused_write_is_started_instead_of_dropped() {
        // A batch can hold a `Fetch` after a `Send` (a tick that writes a
        // queued message and then starts a walk). Refusing the write drops the
        // rest of the batch — except the `Fetch`, which nobody would ever
        // answer again.
        block_on(async {
            let mut rig = Rig::new();
            let mut wire = FakeWire::new(&rig.log);
            wire.refuse_next();
            let request = HistoryRequest {
                serial: 1,
                peer: login("bob"),
                below: None,
                limit: 200,
                sealed: false,
            };
            let batch = vec![
                Output::Send(r#"{"k":"subscribe","peer":"bob"}"#.to_owned()),
                Output::Persist(vec![StoreOp::SetCursor(tailchat_core::Seq(3))]),
                Output::Event(Event::BadFrame {
                    reason: "never delivered".to_owned(),
                }),
                Output::Fetch(request.clone()),
            ];
            let outcome = rig.exec.run(batch, Some(&mut wire)).await;
            assert!(matches!(outcome, Batch::Failed(Input::Disconnected)));
            // The cursor the dropped `Persist` would have moved is untouched…
            assert_eq!(
                rig.store
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .inner
                    .snapshot
                    .cursor
                    .0,
                0
            );
            // …the dropped event was never shown…
            assert!(!rig.seen().iter().any(|n| matches!(n, Notice::Event(_))));
            // …and the fetch is under way.
            let answers = settle(&mut rig.exec).await;
            assert!(matches!(
                answers.into_input(),
                Input::HistoryFailed {
                    request: answered,
                    error: FetchError::Network,
                } if answered == request
            ));
        });
    }

    /// Waits for the one fetch in flight and answers it.
    async fn settle(exec: &mut Exec<Logged>) -> Answer {
        let mut answers: Vec<Answer> = tokio::time::timeout(
            Duration::from_secs(10),
            exec.fetches.by_ref().take(1).collect(),
        )
        .await
        .unwrap();
        assert!(exec.fetches.is_empty(), "one answer per fetch");
        answers.pop().unwrap()
    }

    #[test]
    fn notices_stop_at_the_flag_and_a_repeated_state_is_swallowed() {
        let seen: Arc<Mutex<Vec<Notice>>> = Arc::default();
        let stopping = Arc::new(AtomicBool::new(false));
        let sink = Arc::clone(&seen);
        let mut notices = Notices::new(
            Box::new(move |notice| sink.lock().unwrap().push(notice)),
            Arc::clone(&stopping),
        );
        notices.state(ConnState::Connecting);
        notices.state(ConnState::Connecting);
        notices.state(ConnState::Open);
        notices.emit(Notice::Frame("one".to_owned()));
        stopping.store(true, Ordering::SeqCst);
        notices.state(ConnState::Ready);
        notices.emit(Notice::Frame("two".to_owned()));
        assert_eq!(
            *seen.lock().unwrap(),
            [
                Notice::Connection(ConnState::Connecting),
                Notice::Connection(ConnState::Open),
                Notice::Frame("one".to_owned()),
            ]
        );
    }
}
