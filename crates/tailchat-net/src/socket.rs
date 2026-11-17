//! The WebSocket: dialled, read under a watchdog, written frame by frame.
//!
//! tungstenite answers the server's pings by itself while the socket is being
//! read, which is why the driver reads it continuously and never lets a
//! handler hold it for long (every wait in a handler is bounded).

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::LocalBoxFuture;
use futures_util::{FutureExt as _, SinkExt as _, StreamExt as _};
use rustls::ClientConfig;
use tailchat_core::MAX_INBOUND;
use tokio::net::TcpStream;
use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::{IntoClientRequest, uri_mode};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
};

use crate::clock;
use crate::exec::{Wire, WriteFailed};
use crate::timings::Timings;

/// The socket type tokio-tungstenite hands out.
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A dial that did not end in an open socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DialFailed;

/// What it takes to open the socket again and again.
#[derive(Clone)]
pub(crate) struct Dialer {
    /// `ws(s)://host[:port]/<prefix>/ws`.
    url: String,
    /// TLS for `wss`.
    tls: Arc<ClientConfig>,
    /// The whole attempt, DNS to upgrade.
    limit: Duration,
}

impl Dialer {
    /// A dialer for `url`.
    pub(crate) fn new(url: String, tls: Arc<ClientConfig>, limit: Duration) -> Self {
        Self { url, tls, limit }
    }

    /// Whether `url` is something this dialer can dial: `ws` or `wss`, with a
    /// host.
    pub(crate) fn accepts(url: &str) -> bool {
        url.into_client_request()
            .is_ok_and(|request| uri_mode(request.uri()).is_ok())
    }

    /// One attempt. The frame and message size limit is [`MAX_INBOUND`]: a
    /// bigger frame is refused before it is allocated.
    pub(crate) fn dial(
        &self,
        timings: &Timings,
    ) -> LocalBoxFuture<'static, Result<Box<Socket>, DialFailed>> {
        let url = self.url.clone();
        let tls = Arc::clone(&self.tls);
        let limit = self.limit;
        let timings = timings.clone();
        async move {
            let request = url.as_str().into_client_request().map_err(|_| DialFailed)?;
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_INBOUND))
                .max_frame_size(Some(MAX_INBOUND));
            let attempt = connect_async_tls_with_config(
                request,
                Some(config),
                true,
                Some(Connector::Rustls(tls)),
            );
            match timeout(limit, attempt).await {
                Ok(Ok((ws, _response))) => Ok(Box::new(Socket::new(ws, &timings))),
                Ok(Err(_)) | Err(_) => Err(DialFailed),
            }
        }
        .boxed_local()
    }
}

/// What the read side has to say.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SocketEvent {
    /// One text frame, exactly as received.
    Text(String),
    /// The socket is gone: closed by the server, broken, or silent too long.
    Lost,
}

/// An open WebSocket with its watchdog.
pub(crate) struct Socket {
    /// The stream.
    ws: Ws,
    /// Wall-clock milliseconds when anything (frame, ping, pong) last arrived.
    last_rx: i64,
    /// Wakes the read side to compare the silence with `watchdog_ms`.
    poll: Interval,
    /// Silence that kills the socket, in milliseconds.
    watchdog_ms: i64,
    /// One write's time budget.
    write_limit: Duration,
}

impl Socket {
    /// Wraps a freshly upgraded stream.
    fn new(ws: Ws, timings: &Timings) -> Self {
        let mut poll = interval_at(
            Instant::now() + timings.watchdog_poll,
            timings.watchdog_poll,
        );
        poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Self {
            ws,
            last_rx: clock::now().0,
            poll,
            watchdog_ms: i64::try_from(timings.watchdog.as_millis()).unwrap_or(i64::MAX),
            write_limit: timings.write,
        }
    }

    /// The next text frame, or the end of the socket. Pings, pongs and binary
    /// frames only feed the watchdog. Cancel-safe: dropping the future between
    /// frames loses nothing.
    pub(crate) async fn next(&mut self) -> SocketEvent {
        loop {
            tokio::select! {
                message = self.ws.next() => {
                    let Some(Ok(message)) = message else {
                        return SocketEvent::Lost;
                    };
                    self.last_rx = clock::now().0;
                    match message {
                        Message::Text(text) => return SocketEvent::Text(text.as_str().to_owned()),
                        Message::Close(_) => return SocketEvent::Lost,
                        Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {}
                    }
                }
                _ = self.poll.tick() => {
                    if clock::now().0.saturating_sub(self.last_rx) > self.watchdog_ms {
                        return SocketEvent::Lost;
                    }
                }
            }
        }
    }

    /// Says goodbye, waiting no longer than `grace`, and lets the socket go.
    pub(crate) async fn close(mut self, grace: Duration) {
        let _ = timeout(grace, self.ws.close(None)).await;
    }
}

impl Wire for Socket {
    async fn write(&mut self, text: &str) -> Result<(), WriteFailed> {
        match timeout(self.write_limit, self.ws.send(Message::text(text))).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) | Err(_) => Err(WriteFailed),
        }
    }
}
