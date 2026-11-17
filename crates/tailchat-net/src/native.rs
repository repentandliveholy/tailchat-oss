//! The native driver's API: [`start`] and the [`Handle`] it returns.

use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, ThreadId};

use rustls::ClientConfig;
use tailchat_core::{Login, MessageId, Storage as _, Token, Ts};
use tailchat_store::{Key, Row, SqliteStore};
use tokio::sync::{Notify, mpsc};
use zeroize::Zeroizing;

use crate::driver::{Parts, run_thread};
use crate::exec::{Identity, Store, lock as lock_mutex};
use crate::http::Endpoint;
use crate::lock::InstanceLock;
use crate::socket::Dialer;
use crate::timings::Timings;
use crate::{Command, Notice, tls};

/// Everything [`start`] needs.
///
/// `Debug` hides the token and the key.
pub struct Config {
    /// The account.
    pub login: Login,
    /// The bearer token, 64 lowercase hex characters (`Token::parse`). The
    /// driver keeps a wiped-on-drop copy; the caller's buffer is the caller's
    /// to wipe.
    pub token: String,
    /// The WebSocket to dial: `ws(s)://host[:port]/<prefix>/ws`.
    pub socket_url: String,
    /// The cloud's HTTP side: `http(s)://host[:port]/<prefix>`. History is
    /// fetched from `http_base` + `HistoryRequest::path()`, keys are posted
    /// to `http_base` + `ApiCall::path()`.
    pub http_base: String,
    /// The store file. Its parent directory is created if missing; the
    /// instance lock is `<db_path>.lock`.
    pub db_path: PathBuf,
    /// The SQLCipher key. Used to open the store and then dropped (wiped).
    pub key: Key,
    /// Capabilities claimed in `auth` on top of the core's own; invalid ones
    /// are dropped by the core (lowercase `a-z0-9-`, at most 64 bytes).
    pub extra_caps: Vec<String>,
    /// End-to-end encryption (stage 6): register this device's keys and
    /// claim `e2ee-v1`. Off, the driver behaves as before stage 6.
    pub e2ee: bool,
    /// What `keys/upload` calls this device ("Terminal · macOS"); empty
    /// sends no name.
    pub device_name: String,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("login", &self.login)
            .field("token", &"***")
            .field("socket_url", &self.socket_url)
            .field("http_base", &self.http_base)
            .field("db_path", &self.db_path)
            .field("key", &self.key)
            .field("extra_caps", &self.extra_caps)
            .field("e2ee", &self.e2ee)
            .field("device_name", &self.device_name)
            .finish()
    }
}

/// The driver has stopped (or is stopping): the command was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the driver has stopped")]
pub struct Stopped;

/// Why [`Handle::conversation`] could not answer.
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    /// The driver has stopped and closed the store.
    #[error("the driver has stopped")]
    Stopped,
    /// The store failed.
    #[error(transparent)]
    Store(#[from] tailchat_store::Error),
}

/// Why [`start`] did not start.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// Another driver (in this process or another) holds this store file.
    #[error("another Tailchat driver holds this store")]
    Locked,
    /// The store did not open: wrong key, not a store, newer schema, I/O.
    #[error("store: {0}")]
    Store(#[from] tailchat_store::Error),
    /// The token is not 64 lowercase hex characters.
    #[error("the token is not 64 lowercase hex characters")]
    BadToken,
    /// A URL that cannot be used; names the `Config` field.
    #[error("bad URL in {0}")]
    BadUrl(&'static str),
    /// The lock file, the directory, the runtime or the thread failed.
    #[error("io: {0}")]
    Io(#[from] io::Error),
}

/// A running driver. Clone it freely; all clones drive the same connection.
///
/// # Guarantees
///
/// - Commands are handled in the order they were sent (per sender), each to
///   the end before the next.
/// - Notices reach the sink in the order things happened.
/// - [`Handle::stop`] returns after the driver thread has exited: the socket
///   is closed, the store is closed, the instance lock is released, and **no
///   notice is delivered once `stop` has been called** (not even from a
///   command or frame already being handled).
/// - Dropping the last clone stops the driver the same way.
#[derive(Clone)]
pub struct Handle {
    /// Shared by every clone; stops the driver when the last one goes.
    inner: Arc<Inner>,
}

/// What every [`Handle`] clone shares.
struct Inner {
    /// Commands to the driver thread.
    commands: mpsc::UnboundedSender<Command>,
    /// The store, shared with the driver; `None` once the driver closed it.
    store: Store<SqliteStore>,
    /// Set by `stop`: no more commands, no more notices.
    stopping: Arc<AtomicBool>,
    /// Wakes the driver to stop.
    wake: Arc<Notify>,
    /// The driver thread, until somebody has joined it.
    thread: Mutex<Option<JoinHandle<()>>>,
    /// The driver thread's id, so that `stop` called from the sink does not
    /// try to join the thread it is running on.
    driver: ThreadId,
}

impl Inner {
    /// Signals the driver and, unless called from the driver thread itself,
    /// waits for it. Concurrent callers all return after the thread exited.
    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.wake.notify_one();
        if thread::current().id() == self.driver {
            return;
        }
        let mut slot = lock_mutex(&self.thread);
        if let Some(join) = slot.take() {
            // A panic on the driver thread has nothing left to tell us.
            let _ = join.join();
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Handle {
    /// Queues a command for the driver. Never blocks.
    ///
    /// `Err(Stopped)` once [`Handle::stop`] has been called or the driver
    /// thread is gone.
    pub fn send(&self, command: Command) -> Result<(), Stopped> {
        if self.inner.stopping.load(Ordering::Acquire) {
            return Err(Stopped);
        }
        self.inner.commands.send(command).map_err(|_| Stopped)
    }

    /// The newest `limit` rows of the conversation with `peer` strictly older
    /// than `before` (by `(ts, id)`), oldest first, read through the store the
    /// driver writes. A row appears once; see `SqliteStore::conversation`.
    ///
    /// Blocks for as long as the driver's current write to the store takes
    /// (milliseconds). `Err(ReadError::Stopped)` after the driver has stopped.
    pub fn conversation(
        &self,
        peer: &Login,
        before: Option<(Ts, &MessageId)>,
        limit: usize,
    ) -> Result<Vec<Row>, ReadError> {
        let guard = lock_mutex(&self.inner.store);
        let store = guard.as_ref().ok_or(ReadError::Stopped)?;
        Ok(store.conversation(peer, before, limit)?)
    }

    /// The one row `(peer, id)`, as [`Handle::conversation`] would show it;
    /// `None` when the store holds no such row.
    pub fn row(&self, peer: &Login, id: &MessageId) -> Result<Option<Row>, ReadError> {
        let guard = lock_mutex(&self.inner.store);
        let store = guard.as_ref().ok_or(ReadError::Stopped)?;
        Ok(store.row(peer, id)?)
    }

    /// Stops the driver and waits until its thread has exited. Idempotent;
    /// safe to call from any thread, including the sink (where it only
    /// signals, because the sink is the thread being stopped).
    ///
    /// When it returns (anywhere but the sink): the socket is closed, the
    /// store is closed, the instance lock is released, and no notice will be
    /// delivered any more.
    pub fn stop(&self) {
        self.inner.stop();
    }
}

/// Opens the store and starts the driver thread.
///
/// Everything that can fail on the caller's side fails here, before the thread
/// exists: the token ([`StartError::BadToken`]), the URLs
/// ([`StartError::BadUrl`]), the lock ([`StartError::Locked`]), the store
/// ([`StartError::Store`]). Dialling begins at once; progress arrives as
/// [`Notice`]s on `sink`, called on the driver thread (see the crate docs).
pub fn start(
    config: Config,
    sink: impl FnMut(Notice) + Send + 'static,
) -> Result<Handle, StartError> {
    start_with(config, sink, Timings::default(), None)
}

/// [`start`] with explicit clocks and, optionally, a TLS configuration other
/// than the default (Mozilla's roots): for tests.
pub(crate) fn start_with(
    config: Config,
    sink: impl FnMut(Notice) + Send + 'static,
    timings: Timings,
    tls: Option<Arc<ClientConfig>>,
) -> Result<Handle, StartError> {
    let Config {
        login,
        token,
        socket_url,
        http_base,
        db_path,
        key,
        extra_caps,
        e2ee,
        device_name,
    } = config;
    let token = Arc::new(Zeroizing::new(token));
    // A bad token is the caller's mistake: refuse it before touching the disk.
    Token::parse(&token).map_err(|_| StartError::BadToken)?;
    if !Dialer::accepts(&socket_url) {
        return Err(StartError::BadUrl("socket_url"));
    }
    let endpoint = Endpoint::parse(&http_base).ok_or(StartError::BadUrl("http_base"))?;
    let tls = match tls {
        Some(tls) => tls,
        None => tls::config().map_err(io::Error::other)?,
    };

    let instance = InstanceLock::acquire(&db_path)?;
    let store = SqliteStore::open(&db_path, &key)?;
    // The store holds its own copy now; ours is wiped here.
    drop(key);
    let identity = Identity {
        login,
        token,
        extra_caps,
        e2ee,
        web_features: false,
        device_name,
    };
    let core = identity
        .core(store.load()?)
        .map_err(|_| StartError::BadToken)?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let stopping = Arc::new(AtomicBool::new(false));
    let wake = Arc::new(Notify::new());
    let store: Store<SqliteStore> = Arc::new(Mutex::new(Some(store)));
    let (commands, receiver) = mpsc::unbounded_channel();
    let parts = Parts {
        core,
        store: Arc::clone(&store),
        identity,
        sink: Box::new(sink),
        stopping: Arc::clone(&stopping),
        wake: Arc::clone(&wake),
        commands: receiver,
        dialer: Dialer::new(socket_url, Arc::clone(&tls), timings.dial),
        endpoint,
        tls,
        timings,
        runtime,
        lock: instance,
    };
    let join = thread::Builder::new()
        .name("tailchat-net".to_owned())
        .spawn(move || run_thread(parts))?;
    let driver = join.thread().id();
    Ok(Handle {
        inner: Arc::new(Inner {
            commands,
            store,
            stopping,
            wake,
            thread: Mutex::new(Some(join)),
            driver,
        }),
    })
}
