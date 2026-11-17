//! The browser driver: one async loop on the page's event loop, doing what the
//! native `driver.rs` does on its thread — the link state machine, the backoff,
//! the core's timers — with the socket and the clocks reached through
//! [`Host`]. The executor (`tailchat_net::exec`) is the native one, unchanged.
//!
//! The browser hides WebSocket pings from the page, and the cloud sends no
//! other traffic to an idle socket, so silence is probed the way the web
//! client always has: a `who` after [`PROBE_AFTER_MS`], and the socket is
//! given up after [`SILENT_FOR_MS`] without a frame.

use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_channel::mpsc;
use futures_util::future::{FusedFuture, LocalBoxFuture, pending};
use futures_util::stream::FuturesUnordered;
use futures_util::{FutureExt as _, StreamExt as _, select_biased};
use tailchat_core::{FetchError, Input};
use tailchat_net::exec::{Answer, Exec, Fetch, Flow, Notices, Store, Wire, WriteFailed};
use tailchat_net::timings::Backoff;
use tailchat_net::{Command, ConnState, Notice, json};
use zeroize::Zeroizing;

use crate::KvStore;
use crate::host::{self, Host};

/// A quiet socket is asked for a `users` answer after this long.
pub(crate) const PROBE_AFTER_MS: i64 = 15_000;
/// A socket silent this long, probe unanswered, is dead.
pub(crate) const SILENT_FOR_MS: i64 = 45_000;
/// A dial that has not opened by then has failed.
const DIAL_LIMIT_MS: i64 = 20_000;
/// The redial pause: the first, and the ceiling it doubles to.
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(15);
/// The probe: the hub answers it with `users` and does not rate-limit it.
const PROBE: &str = r#"{"k":"who"}"#;

/// What the page tells the loop.
pub(crate) enum In {
    /// Something for the core, a raw frame, or a reconnect.
    Command(Command),
    /// The socket from the last `connect` opened.
    Open,
    /// A text frame arrived on it.
    Text(String),
    /// It closed, or never opened.
    Closed,
    /// The page came back to the foreground or the network did: prove the
    /// socket alive or replace it.
    Probe,
    /// The client was stopped.
    Stop,
}

/// The socket as the loop sees it.
enum Link {
    /// No socket; dial again at `redial` (ms), or only when told to.
    Down { redial: Option<i64> },
    /// `connect` was called; it fails if it has not opened by `deadline`.
    Dialing { deadline: i64 },
    /// Open. `last_rx`: when the last frame came; `probed`: a `who` is out.
    Up { last_rx: i64, probed: bool },
}

/// The socket as the executor writes to it: every write waits for the journal
/// to be durable first.
struct JsWire {
    host: Rc<Host>,
    store: Store<KvStore>,
}

impl Wire for JsWire {
    async fn write(&mut self, text: &str) -> Result<(), WriteFailed> {
        host::flush(&self.host, &self.store)
            .await
            .map_err(|()| WriteFailed)?;
        if self.host.send(text) {
            Ok(())
        } else {
            Err(WriteFailed)
        }
    }
}

/// The cloud's HTTP side through the page.
pub(crate) struct JsFetch {
    pub(crate) host: Rc<Host>,
    pub(crate) store: Store<KvStore>,
    /// `http(s)://host[:port]/<prefix>`.
    pub(crate) base: String,
    pub(crate) token: Rc<Zeroizing<String>>,
}

impl JsFetch {
    fn request(
        &self,
        method: &'static str,
        path: &str,
        body: Option<String>,
    ) -> LocalBoxFuture<'static, Result<String, FetchError>> {
        let host = Rc::clone(&self.host);
        let store = Arc::clone(&self.store);
        let token = Rc::clone(&self.token);
        let url = format!("{}{path}", self.base);
        async move { host::request(&host, &store, method, &url, &token, body).await }.boxed_local()
    }
}

impl Fetch for JsFetch {
    fn get(&self, path: &str) -> LocalBoxFuture<'static, Result<String, FetchError>> {
        self.request("GET", path, None)
    }

    fn post(&self, path: &str, body: &str) -> LocalBoxFuture<'static, Result<String, FetchError>> {
        self.request("POST", path, Some(body.to_owned()))
    }
}

/// What woke the loop.
enum Step {
    In(Option<In>),
    Answer(Answer),
    Timer,
}

/// The next history or key answer; never resolves while none is in flight.
async fn next_answer(fetches: &mut FuturesUnordered<LocalBoxFuture<'static, Answer>>) -> Answer {
    if fetches.is_empty() {
        pending::<()>().await;
    }
    match fetches.next().await {
        Some(answer) => answer,
        None => pending().await,
    }
}

/// The loop's state.
pub(crate) struct Driver {
    pub(crate) exec: Exec<KvStore>,
    pub(crate) store: Store<KvStore>,
    pub(crate) host: Rc<Host>,
    pub(crate) socket_url: String,
    pub(crate) inbox: mpsc::UnboundedReceiver<In>,
    /// Filled by the executor's sink; drained to the page after every step.
    pub(crate) queue: Arc<Mutex<Vec<Notice>>>,
    /// Set by `stop`: nothing reaches the page any more.
    pub(crate) stopping: Arc<AtomicBool>,
    link: Link,
    backoff: Backoff,
    was_ready: bool,
    /// The armed timer and the deadline it was armed for.
    timer: Option<(i64, futures_util::future::Fuse<LocalBoxFuture<'static, ()>>)>,
}

/// A sink that queues notices for the loop to hand over.
pub(crate) fn notices(queue: &Arc<Mutex<Vec<Notice>>>, stopping: &Arc<AtomicBool>) -> Notices {
    let queue = Arc::clone(queue);
    Notices::new(
        Box::new(move |notice| tailchat_net::exec::lock(&queue).push(notice)),
        Arc::clone(stopping),
    )
}

impl Driver {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        exec: Exec<KvStore>,
        store: Store<KvStore>,
        host: Rc<Host>,
        socket_url: String,
        inbox: mpsc::UnboundedReceiver<In>,
        queue: Arc<Mutex<Vec<Notice>>>,
        stopping: Arc<AtomicBool>,
    ) -> Self {
        Self {
            exec,
            store,
            host,
            socket_url,
            inbox,
            queue,
            stopping,
            link: Link::Down { redial: None },
            backoff: Backoff::new(BACKOFF_MIN, BACKOFF_MAX),
            was_ready: false,
            timer: None,
        }
    }

    /// Runs until the client is stopped.
    pub(crate) async fn run(mut self) {
        self.dial();
        loop {
            self.hand_over();
            let deadline = self.deadline();
            self.arm(deadline);
            let step = {
                let timer = async {
                    match self.timer.as_mut() {
                        Some((_, fut)) if !fut.is_terminated() => fut.await,
                        _ => pending().await,
                    }
                };
                select_biased! {
                    message = self.inbox.next() => Step::In(message),
                    answer = next_answer(&mut self.exec.fetches).fuse() => Step::Answer(answer),
                    () = timer.fuse() => Step::Timer,
                }
            };
            match step {
                Step::In(None | Some(In::Stop)) => break,
                Step::In(Some(message)) => self.on(message).await,
                Step::Answer(answer) => self.input(answer.into_input()).await,
                Step::Timer => {
                    self.timer = None;
                    self.on_timer().await;
                }
            }
            self.commit().await;
        }
        self.host.close();
    }

    /// Hands every queued notice to the page, in order.
    fn hand_over(&mut self) {
        let notices = std::mem::take(&mut *tailchat_net::exec::lock(&self.queue));
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        for notice in notices {
            self.host.notice(host::to_js(&json::notice(notice)));
        }
    }

    /// Whatever the step stored becomes durable before the next step.
    async fn commit(&mut self) {
        if host::flush(&self.host, &self.store).await.is_err() {
            self.exec.notices.emit(Notice::StorageFailed {
                reason: "the local store failed to commit".to_owned(),
            });
        }
    }

    /// The earliest moment something is due: the core's timer, the redial,
    /// the dial limit, the silence probe.
    fn deadline(&self) -> Option<i64> {
        let link = match self.link {
            Link::Down { redial } => redial,
            Link::Dialing { deadline } => Some(deadline),
            Link::Up { last_rx, probed } => Some(last_rx.saturating_add(if probed {
                SILENT_FOR_MS
            } else {
                PROBE_AFTER_MS
            })),
        };
        let core = self.exec.core.next_wakeup().map(|ts| ts.0);
        match (link, core) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Keeps the armed timer when the deadline has not moved.
    fn arm(&mut self, deadline: Option<i64>) {
        let Some(at) = deadline else {
            self.timer = None;
            return;
        };
        if matches!(&self.timer, Some((armed, _)) if *armed == at) {
            return;
        }
        let host = Rc::clone(&self.host);
        let wait = at.saturating_sub(host::now().0);
        let fut = async move { host::sleep(&host, wait).await }
            .boxed_local()
            .fuse();
        self.timer = Some((at, fut));
    }

    async fn on(&mut self, message: In) {
        match message {
            In::Command(Command::Action(action)) => self.input(Input::Action(action)).await,
            In::Command(Command::Raw(text)) => self.raw(text).await,
            In::Command(Command::Reconnect) => self.reconnect().await,
            In::Open => {
                if matches!(self.link, Link::Dialing { .. }) {
                    self.link = Link::Up {
                        last_rx: host::now().0,
                        probed: false,
                    };
                    self.exec.notices.state(ConnState::Open);
                    self.input(Input::Connected).await;
                }
            }
            In::Text(raw) => {
                if let Link::Up { last_rx, probed } = &mut self.link {
                    *last_rx = host::now().0;
                    *probed = false;
                    self.frame(raw).await;
                }
            }
            In::Closed => match self.link {
                Link::Dialing { .. } => self.wait_to_redial(),
                Link::Up { .. } => self.lose().await,
                Link::Down { .. } => {}
            },
            In::Probe => self.probe().await,
            In::Stop => {}
        }
    }

    async fn on_timer(&mut self) {
        let now = host::now().0;
        match self.link {
            Link::Down { redial: Some(at) } if at <= now => self.dial(),
            Link::Dialing { deadline } if deadline <= now => {
                self.host.close();
                self.wait_to_redial();
            }
            Link::Up { last_rx, probed } => {
                let silence = now.saturating_sub(last_rx);
                if silence >= SILENT_FOR_MS {
                    self.lose().await;
                } else if silence >= PROBE_AFTER_MS && !probed {
                    self.send_probe().await;
                }
            }
            _ => {}
        }
        if self
            .exec
            .core
            .next_wakeup()
            .is_some_and(|at| at.0 <= host::now().0)
        {
            self.input(Input::Tick).await;
        }
    }

    /// Writes a `who`; a socket that will not take it is lost.
    async fn send_probe(&mut self) {
        if let Link::Up { probed, .. } = &mut self.link {
            *probed = true;
            if !self.host.send(PROBE) {
                self.lose().await;
            }
        }
    }

    /// Back in the foreground: a socket heard from recently is asked to prove
    /// itself, anything else is replaced at once.
    async fn probe(&mut self) {
        match self.link {
            Link::Up { last_rx, .. } if host::now().0.saturating_sub(last_rx) < PROBE_AFTER_MS => {
                self.send_probe().await;
            }
            _ => self.reconnect().await,
        }
    }

    async fn raw(&mut self, text: String) {
        let up = matches!(self.link, Link::Up { .. }) && self.exec.core.is_ready();
        if !up {
            self.exec.notices.emit(Notice::RawDropped(text));
            return;
        }
        let written = host::flush(&self.host, &self.store).await.is_ok() && self.host.send(&text);
        if !written {
            self.exec.notices.emit(Notice::RawDropped(text));
            self.lose().await;
        }
    }

    async fn reconnect(&mut self) {
        self.backoff.reset();
        if matches!(self.link, Link::Up { .. }) {
            self.close_link().await;
            self.exec.notices.state(ConnState::Closed {
                retry_in_ms: Some(0),
            });
        }
        self.dial();
    }

    async fn frame(&mut self, raw: String) {
        let flow = self.feed(Input::Frame(raw.clone())).await;
        self.observe_ready();
        self.exec.notices.emit(Notice::Frame(raw));
        self.settle(flow).await;
    }

    pub(crate) async fn input(&mut self, input: Input) {
        let flow = self.feed(input).await;
        self.observe_ready();
        self.settle(flow).await;
    }

    async fn feed(&mut self, input: Input) -> Flow {
        if matches!(self.link, Link::Up { .. }) {
            let mut wire = JsWire {
                host: Rc::clone(&self.host),
                store: Arc::clone(&self.store),
            };
            self.exec.feed(Some(&mut wire), input).await
        } else {
            self.exec.feed::<JsWire>(None, input).await
        }
    }

    fn observe_ready(&mut self) {
        let ready = self.exec.core.is_ready();
        if ready && !self.was_ready {
            self.backoff.reset();
            self.exec.notices.state(ConnState::Ready);
        }
        self.was_ready = ready;
    }

    async fn settle(&mut self, flow: Flow) {
        match flow {
            Flow::Continue => {}
            Flow::Drop => {
                if matches!(self.link, Link::Up { .. }) {
                    self.lose().await;
                }
            }
            Flow::AuthFailed => self.refuse().await,
        }
    }

    fn dial(&mut self) {
        self.exec.notices.state(ConnState::Connecting);
        if self.exec.heal() {
            self.host.connect(&self.socket_url);
            self.link = Link::Dialing {
                deadline: host::now().0.saturating_add(DIAL_LIMIT_MS),
            };
        } else {
            self.wait_to_redial();
        }
    }

    async fn lose(&mut self) {
        self.close_link().await;
        self.wait_to_redial();
    }

    async fn refuse(&mut self) {
        self.close_link().await;
        self.exec.notices.state(ConnState::AuthFailed);
        self.exec
            .notices
            .state(ConnState::Closed { retry_in_ms: None });
    }

    async fn close_link(&mut self) {
        let was_up = matches!(self.link, Link::Up { .. });
        self.link = Link::Down { redial: None };
        self.host.close();
        if was_up {
            self.exec.feed::<JsWire>(None, Input::Disconnected).await;
            self.was_ready = false;
        }
    }

    fn wait_to_redial(&mut self) {
        let wait = self.backoff.take();
        let ms = i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);
        self.link = Link::Down {
            redial: Some(host::now().0.saturating_add(ms)),
        };
        self.exec.notices.state(ConnState::Closed {
            retry_in_ms: Some(u64::try_from(ms).unwrap_or(0)),
        });
    }
}
