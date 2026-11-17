//! The wire: the WebSocket (dialled, read under a watchdog, reconnected with a
//! backoff) and the few HTTP calls the cloud has no socket frame for.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use rustls::{ClientConfig, RootCertStore};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
};

/// What this client consumes: `message-accepted` (the server's proof of ✓) and
/// frames addressed to a contact without borrowing the subscription.
const CAPS: [&str; 2] = ["durable-ack", "addressed-send"];
/// The server pings every ~12 s; silence this long means the link is dead.
const WATCHDOG: Duration = Duration::from_secs(40);
/// One dial, DNS to upgrade.
const DIAL_LIMIT: Duration = Duration::from_secs(10);
/// First reconnect delay; doubles up to [`RETRY_MAX`].
const RETRY_MIN: Duration = Duration::from_secs(1);
/// Longest reconnect delay.
const RETRY_MAX: Duration = Duration::from_secs(30);
/// One HTTP call, connect to last byte.
const HTTP_LIMIT: Duration = Duration::from_secs(15);
/// Largest HTTP body read: matches the server's per-conversation media budget (64 MiB).
const BODY_LIMIT: u64 = 64 * 1024 * 1024;

/// Where the cloud lives: its socket and its HTTP API.
#[derive(Clone)]
pub struct Endpoints {
    pub ws: String,
    pub api: String,
}

impl Endpoints {
    /// Takes what a person types for a server (`example.org`,
    /// `https://example.org/`, `http://127.0.0.1:7683`) and refuses what cannot
    /// carry a session.
    pub fn parse(server: &str) -> Option<Self> {
        let raw = server.trim();
        let full = if raw.contains("://") {
            raw.to_owned()
        } else {
            format!("https://{raw}")
        };
        let (scheme, rest) = full.split_once("://")?;
        let (ws_scheme, http_scheme) = match scheme.to_ascii_lowercase().as_str() {
            "https" => ("wss", "https"),
            "http" => ("ws", "http"),
            _ => return None,
        };
        let rest = rest.trim_end_matches('/');
        let rest = rest
            .strip_suffix("/tailchat")
            .or_else(|| rest.strip_suffix("/cloud"))
            .unwrap_or(rest);
        if rest.is_empty() || rest.contains(['/', '@', ' ']) {
            return None;
        }
        Some(Self {
            ws: format!("{ws_scheme}://{rest}/tailchat/ws"),
            api: format!("{http_scheme}://{rest}/tailchat/api"),
        })
    }
}

pub fn tls_config() -> Result<Arc<ClientConfig>, rustls::Error> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What the read side has to say.
pub enum Net {
    Text(String),
    Lost,
}

/// Whether a frame reached the socket.
#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    Ok,
    /// There is no socket right now; the model keeps what matters.
    NoLink,
    /// The socket broke under the write.
    Broken,
}

/// The socket and its reconnect schedule.
pub struct Link {
    ws: Option<Ws>,
    pub retry_at: Instant,
    backoff: Duration,
}

impl Link {
    pub fn new() -> Self {
        Self {
            ws: None,
            retry_at: Instant::now(),
            backoff: RETRY_MIN,
        }
    }

    pub fn is_up(&self) -> bool {
        self.ws.is_some()
    }

    /// One attempt; on success the socket is open and `auth` is on its way.
    pub async fn dial(
        &mut self,
        endpoints: &Endpoints,
        tls: &Arc<ClientConfig>,
        token: &str,
    ) -> Result<(), String> {
        let request = endpoints
            .ws
            .as_str()
            .into_client_request()
            .map_err(|e| e.to_string())?;
        let attempt = connect_async_tls_with_config(
            request,
            None,
            true,
            Some(Connector::Rustls(tls.clone())),
        );
        let ws = match timeout(DIAL_LIMIT, attempt).await {
            Ok(Ok((ws, _response))) => ws,
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => return Err("timed out".to_owned()),
        };
        self.ws = Some(ws);
        let auth = json!({"k": "auth", "token": token, "caps": CAPS});
        match self.send(&auth).await {
            Sent::Ok => Ok(()),
            _ => {
                self.ws = None;
                Err("the socket closed during sign-in".to_owned())
            }
        }
    }

    /// `ready` arrived: the link is good, the next outage starts from one second.
    pub fn settled(&mut self) {
        self.backoff = RETRY_MIN;
    }

    /// The socket is gone (or never opened): schedule the next dial, and say
    /// how long it will be.
    pub fn lost(&mut self) -> Duration {
        self.ws = None;
        let delay = self.backoff;
        self.retry_at = Instant::now() + delay;
        self.backoff = (self.backoff * 2).min(RETRY_MAX);
        delay
    }

    pub async fn send(&mut self, frame: &Value) -> Sent {
        let Some(ws) = self.ws.as_mut() else {
            return Sent::NoLink;
        };
        match ws.send(Message::text(frame.to_string())).await {
            Ok(()) => Sent::Ok,
            Err(_) => Sent::Broken,
        }
    }

    /// The next text frame. Pings and pongs only feed the watchdog (tungstenite
    /// answers pings itself while it is being read). Cancel-safe.
    pub async fn recv(&mut self) -> Net {
        let Some(ws) = self.ws.as_mut() else {
            return std::future::pending().await;
        };
        loop {
            match timeout(WATCHDOG, ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return Net::Text(text.as_str().to_owned()),
                Ok(Some(Ok(Message::Close(_)) | Err(_)) | None) | Err(_) => return Net::Lost,
                Ok(Some(Ok(_))) => {}
            }
        }
    }

    pub async fn close(&mut self) {
        if let Some(mut ws) = self.ws.take() {
            let _ = timeout(Duration::from_secs(1), ws.close(None)).await;
        }
    }
}

/// An HTTP answer: the status and the JSON body (`Null` when there was none).
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    /// The server's own error code, `bad_credentials` and the like.
    pub fn code(&self) -> String {
        self.body
            .get("error")
            .and_then(Value::as_str)
            .map_or_else(|| format!("HTTP {}", self.status), str::to_owned)
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Blocking; callers on the runtime run it on the blocking pool. A transport
/// fault is `Err`; any answer the server gave, errors included, is `Ok`.
pub fn call(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<Reply, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_LIMIT))
        .http_status_as_error(false)
        .build()
        .into();
    let bearer = token.map(|t| format!("Bearer {t}"));
    let response = if method == "GET" {
        let mut request = agent.get(url);
        if let Some(bearer) = &bearer {
            request = request.header("authorization", bearer);
        }
        request.call()
    } else {
        let mut request = agent.post(url).header("content-type", "application/json");
        if let Some(bearer) = &bearer {
            request = request.header("authorization", bearer);
        }
        request.send(body.map_or_else(|| "{}".to_owned(), Value::to_string))
    };
    let mut response = response.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = serde_json::from_reader(std::io::BufReader::new(
        response.body_mut().with_config().limit(BODY_LIMIT).reader(),
    ))
    .unwrap_or(Value::Null);
    Ok(Reply { status, body })
}

/// Percent-encodes everything but unreserved characters.
fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// One page of a conversation.
pub fn history(api: &str, token: &str, peer: &str, limit: u32) -> Result<Value, String> {
    let url = format!("{api}/history?peer={}&limit={limit}", encode(peer));
    let reply = call("GET", &url, Some(token), None)?;
    if reply.ok() {
        Ok(reply.body)
    } else {
        Err(reply.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_take_what_a_person_types() {
        for server in [
            "example.org",
            "https://example.org/",
            "https://example.org/tailchat",
            "  https://example.org/cloud/ ",
        ] {
            let ep = Endpoints::parse(server).expect(server);
            assert_eq!(ep.ws, "wss://example.org/tailchat/ws", "{server}");
            assert_eq!(ep.api, "https://example.org/tailchat/api", "{server}");
        }
        let local = Endpoints::parse("http://127.0.0.1:7683").expect("local");
        assert_eq!(local.ws, "ws://127.0.0.1:7683/tailchat/ws");
        assert_eq!(local.api, "http://127.0.0.1:7683/tailchat/api");
        for bad in ["ftp://example.org", "https://user@example.org", "https://a.org/x", ""] {
            assert!(Endpoints::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn query_values_are_escaped() {
        assert_eq!(encode("bob"), "bob");
        assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
    }
}
