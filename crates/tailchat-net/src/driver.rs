//! The driver: one OS thread, one current-thread runtime, one `select!` loop.
//!
//! Everything that can happen — a command from the caller, a frame from the
//! server, the answer to a history request, the core's own timer, the link
//! coming up or going down — is one arm of that loop, handled to the end
//! before the next is looked at. That single order is what makes the notices
//! come out in the order things happened.
//!
//! The link is a small state machine (`Link`): `Down` (waiting out the backoff,
//! or for good after the server refused the token), `Dialing`, `Up`. Commands
//! and history answers are handled in every state: a message written while
//! offline is queued by the core, and a history request does not need the
//! socket.

use std::future::pending;
use std::mem;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use futures_util::StreamExt as _;
use futures_util::future::LocalBoxFuture;
use rustls::ClientConfig;
use tailchat_core::{Core, Input, MAX_INBOUND, Ts};
use tailchat_store::SqliteStore;
use tokio::runtime::Runtime;
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, sleep, sleep_until};

use crate::clock;
use crate::exec::{Exec, Flow, Identity, Notices, Store, Wire, lock};
use crate::http::{Endpoint, Fetcher};
use crate::lock::InstanceLock;
use crate::socket::{DialFailed, Dialer, Socket, SocketEvent};
use crate::timings::{Backoff, Timings};
use crate::{Command, ConnState, Notice};

/// How long the thread waits for blocking work (a DNS lookup stuck in
/// `getaddrinfo`) to finish once everything else is down.
const RUNTIME_GRACE: Duration = Duration::from_millis(500);

/// Where the connection stands.
enum Link {
    /// No socket. Dialling starts at `redial`; `None` is "not until told to":
    /// the server refused the token.
    Down {
        /// When to dial.
        redial: Option<Instant>,
    },
    /// A dial in flight.
    Dialing(LocalBoxFuture<'static, Result<Box<Socket>, DialFailed>>),
    /// An open socket.
    Up(Box<Socket>),
}

/// What the link has to report.
enum LinkEvent {
    /// The backoff is over.
    Redial,
    /// A dial ended.
    Dialed(Result<Box<Socket>, DialFailed>),
    /// The open socket has news.
    Socket(SocketEvent),
}

impl Link {
    /// The next thing that happens to the link. Cancel-safe: dropping the
    /// future between events loses nothing.
    async fn event(&mut self) -> LinkEvent {
        match self {
            Self::Down { redial: Some(at) } => {
                sleep_until(*at).await;
                LinkEvent::Redial
            }
            Self::Down { redial: None } => pending().await,
            Self::Dialing(dial) => LinkEvent::Dialed(dial.await),
            Self::Up(socket) => LinkEvent::Socket(socket.next().await),
        }
    }
}

/// Everything the driver thread is given, built by `start` on the caller's
/// thread so that every failure surfaces there.
pub(crate) struct Parts {
    /// The core, loaded from the store.
    pub(crate) core: Core,
    /// The store, shared with `Handle::conversation`.
    pub(crate) store: Store<SqliteStore>,
    /// What rebuilding the core needs.
    pub(crate) identity: Identity,
    /// The caller's sink.
    pub(crate) sink: Box<dyn FnMut(Notice) + Send>,
    /// Set by `Handle::stop`: no notice after it.
    pub(crate) stopping: Arc<AtomicBool>,
    /// Woken by `Handle::stop`.
    pub(crate) wake: Arc<Notify>,
    /// Commands from the handles.
    pub(crate) commands: mpsc::UnboundedReceiver<Command>,
    /// How to open the socket.
    pub(crate) dialer: Dialer,
    /// Where history lives.
    pub(crate) endpoint: Endpoint,
    /// TLS for both.
    pub(crate) tls: Arc<ClientConfig>,
    /// The clocks.
    pub(crate) timings: Timings,
    /// The runtime this thread blocks on.
    pub(crate) runtime: Runtime,
    /// The instance lock; released last.
    pub(crate) lock: InstanceLock,
}

/// The body of the driver thread. Returns once the driver has stopped, its
/// store is closed and the instance lock is released.
pub(crate) fn run_thread(parts: Parts) {
    let Parts {
        core,
        store,
        identity,
        sink,
        stopping,
        wake,
        commands,
        dialer,
        endpoint,
        tls,
        timings,
        runtime,
        lock: instance,
    } = parts;
    {
        let fetcher = Fetcher::new(
            endpoint,
            tls,
            Arc::clone(&identity.token),
            timings.fetch,
            MAX_INBOUND,
        );
        let notices = Notices::new(sink, stopping);
        let exec = Exec::new(
            core,
            Arc::clone(&store),
            identity,
            notices,
            Rc::new(fetcher),
            clock::now,
        );
        let mut driver = Driver::new(exec, commands, dialer, timings);
        runtime.block_on(async {
            tokio::select! {
                () = wake.notified() => {}
                () = driver.run() => {}
            }
            driver.shutdown().await;
        });
        // The driver, and with it the core, the sink and every request in
        // flight, is dropped here.
    }
    // Close the database before letting go of the lock, so that a new driver
    // never finds the old one's connection still open.
    drop(lock(&store).take());
    runtime.shutdown_timeout(RUNTIME_GRACE);
    drop(instance);
}

/// The loop's state.
struct Driver {
    /// The core and everything that carries out its outputs.
    exec: Exec<SqliteStore>,
    /// The connection.
    link: Link,
    /// Commands from the handles; closed when the last handle is gone.
    commands: mpsc::UnboundedReceiver<Command>,
    /// How to open the socket.
    dialer: Dialer,
    /// The clocks.
    timings: Timings,
    /// The pause before the next redial.
    backoff: Backoff,
    /// What `core.is_ready()` said after the last input, to announce the
    /// moment it turns true.
    was_ready: bool,
}

impl Driver {
    /// A driver that has not dialled yet.
    fn new(
        exec: Exec<SqliteStore>,
        commands: mpsc::UnboundedReceiver<Command>,
        dialer: Dialer,
        timings: Timings,
    ) -> Self {
        let backoff = Backoff::new(timings.backoff_min, timings.backoff_max);
        Self {
            exec,
            link: Link::Down { redial: None },
            commands,
            dialer,
            timings,
            backoff,
            was_ready: false,
        }
    }

    /// Dials, then runs until the last handle is dropped. `Handle::stop` ends
    /// it from outside, at whatever await it is in.
    async fn run(&mut self) {
        self.dial();
        loop {
            // The core's timer, re-armed on every pass: after each input the
            // core may want a different wakeup.
            let wake = self.exec.core.next_wakeup();
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(command) => self.command(command).await,
                    None => return,
                },
                Some(answer) = self.exec.fetches.next(), if !self.exec.fetches.is_empty() => {
                    self.input(answer.into_input()).await;
                }
                () = alarm(wake) => self.input(Input::Tick).await,
                event = self.link.event() => self.on_link(event).await,
            }
        }
    }

    /// Says goodbye to the server, quietly: no notice follows.
    async fn shutdown(&mut self) {
        if let Link::Up(socket) = mem::replace(&mut self.link, Link::Down { redial: None }) {
            socket.close(self.timings.close).await;
        }
    }

    /// One command from a handle.
    async fn command(&mut self, command: Command) {
        match command {
            Command::Action(action) => self.input(Input::Action(action)).await,
            Command::Raw(text) => self.raw(text).await,
            Command::Reconnect => self.reconnect().await,
        }
    }

    /// A frame for the socket, as is, if the core has seen `ready`.
    async fn raw(&mut self, text: String) {
        let written = match &mut self.link {
            Link::Up(socket) if self.exec.core.is_ready() => {
                Some(socket.write(&text).await.is_ok())
            }
            _ => None,
        };
        match written {
            Some(true) => {}
            Some(false) => {
                self.exec.notices.emit(Notice::RawDropped(text));
                self.lose().await;
            }
            None => self.exec.notices.emit(Notice::RawDropped(text)),
        }
    }

    /// Closes the socket now and dials at once, backoff forgotten.
    async fn reconnect(&mut self) {
        self.backoff.reset();
        if matches!(self.link, Link::Up(_)) {
            self.close_link().await;
            self.exec.notices.state(ConnState::Closed {
                retry_in_ms: Some(0),
            });
        }
        self.dial();
    }

    /// The link's news.
    async fn on_link(&mut self, event: LinkEvent) {
        match event {
            LinkEvent::Redial => self.dial(),
            LinkEvent::Dialed(Ok(socket)) => {
                self.link = Link::Up(socket);
                self.exec.notices.state(ConnState::Open);
                self.input(Input::Connected).await;
            }
            LinkEvent::Dialed(Err(DialFailed)) => self.wait_to_redial(),
            LinkEvent::Socket(SocketEvent::Text(raw)) => self.frame(raw).await,
            LinkEvent::Socket(SocketEvent::Lost) => self.lose().await,
        }
    }

    /// One text frame from the server. The core handles it first; the caller
    /// hears of it (verbatim) after the core's outputs have run.
    async fn frame(&mut self, raw: String) {
        let flow = self.feed(Input::Frame(raw.clone())).await;
        self.observe_ready();
        self.exec.notices.emit(Notice::Frame(raw));
        self.settle(flow).await;
    }

    /// Hands an input to the core and settles what it did to the link.
    async fn input(&mut self, input: Input) {
        let flow = self.feed(input).await;
        self.observe_ready();
        self.settle(flow).await;
    }

    /// The executor, with the socket if there is one.
    async fn feed(&mut self, input: Input) -> Flow {
        match &mut self.link {
            Link::Up(socket) => self.exec.feed(Some(socket.as_mut()), input).await,
            Link::Dialing(_) | Link::Down { .. } => self.exec.feed::<Socket>(None, input).await,
        }
    }

    /// Announces `ready` the moment the core has seen it, and forgets the
    /// backoff: the connection worked.
    fn observe_ready(&mut self) {
        let ready = self.exec.core.is_ready();
        if ready && !self.was_ready {
            self.backoff.reset();
            self.exec.notices.state(ConnState::Ready);
        }
        self.was_ready = ready;
    }

    /// Acts on what an input did to the link.
    async fn settle(&mut self, flow: Flow) {
        match flow {
            Flow::Continue => {}
            // Only an open socket is dropped; a link that is down or dialling
            // is already on its way and must not have its timer pushed back.
            Flow::Drop => {
                if matches!(self.link, Link::Up(_)) {
                    self.lose().await;
                }
            }
            Flow::AuthFailed => self.refuse().await,
        }
    }

    /// Starts a dial, unless the core cannot be trusted yet (then it is the
    /// same as a dial that failed).
    fn dial(&mut self) {
        self.exec.notices.state(ConnState::Connecting);
        if self.exec.heal() {
            self.link = Link::Dialing(self.dialer.dial(&self.timings));
        } else {
            self.wait_to_redial();
        }
    }

    /// The socket (if there was one) is gone: dial again after the backoff.
    async fn lose(&mut self) {
        self.close_link().await;
        self.wait_to_redial();
    }

    /// The server refused the token: stay down until told to dial again.
    async fn refuse(&mut self) {
        self.close_link().await;
        self.exec.notices.state(ConnState::AuthFailed);
        self.exec
            .notices
            .state(ConnState::Closed { retry_in_ms: None });
    }

    /// Lets go of an open socket: the core is told, the server gets a goodbye.
    /// The link is left `Down` with no redial scheduled.
    async fn close_link(&mut self) {
        if let Link::Up(socket) = mem::replace(&mut self.link, Link::Down { redial: None }) {
            self.exec.feed::<Socket>(None, Input::Disconnected).await;
            self.was_ready = false;
            socket.close(self.timings.close).await;
        }
    }

    /// Schedules the next dial and says so.
    fn wait_to_redial(&mut self) {
        let wait = self.backoff.take();
        self.link = Link::Down {
            redial: Some(Instant::now() + wait),
        };
        self.exec.notices.state(ConnState::Closed {
            retry_in_ms: Some(millis(wait)),
        });
    }
}

/// Sleeps until the core's wakeup; never, if it has none.
async fn alarm(at: Option<Ts>) {
    match at {
        Some(at) => sleep(clock::until(at)).await,
        None => pending().await,
    }
}

/// A duration in whole milliseconds, as the notices carry it.
fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
