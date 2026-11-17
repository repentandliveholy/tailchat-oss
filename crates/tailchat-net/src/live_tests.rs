//! The driver's network half against the real cloud, over the real internet.
//!
//! Everything in `tests.rs` runs against a local stand-in with a self-signed
//! certificate the client is told to trust. That proves the protocol, not the
//! TLS: Mozilla's roots, the server's actual chain, SNI, ALPN through Caddy and
//! the HTTP framing Caddy really uses were never exercised. These tests are.
//!
//! They are `#[ignore]` (they need the network and a live server) and they are
//! anonymous on purpose: a made-up token, so nothing is stored, no device is
//! announced and no account is touched. The server's refusal *is* the proof —
//! a `401` can only be read after the handshake verified the chain, and an
//! `auth_failed` frame can only arrive over an upgraded `wss` socket.
//!
//! ```text
//! cargo test -p tailchat-net live_ -- --ignored
//! TAILCHAT_LIVE_BASE=https://host/tailchat cargo test -p tailchat-net live_ -- --ignored
//! ```

use std::sync::Arc;
use std::time::Duration;

use rustls::RootCertStore;
use tailchat_core::FetchError;
use zeroize::Zeroizing;

use crate::exec::Wire as _;
use crate::http::{Endpoint, Fetcher};
use crate::socket::{DialFailed, Dialer, SocketEvent};
use crate::timings::Timings;
use crate::tls;

/// The production cloud's HTTP base, unless `TAILCHAT_LIVE_BASE` names another.
fn base() -> String {
    std::env::var("TAILCHAT_LIVE_BASE")
        .unwrap_or_else(|_| "https://repentandliveholy.org/tailchat".to_owned())
}

/// The socket beside `base`, the way `core-link.js` pairs them.
fn socket_url(base: &str) -> String {
    format!("{}/ws", base.replacen("http", "ws", 1))
}

/// A token no account has.
const BOGUS: &str = "tailchat-net-live-test-not-a-token";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn fetcher(roots: Option<RootCertStore>) -> Fetcher {
    let endpoint =
        Endpoint::parse(&base()).expect("TAILCHAT_LIVE_BASE is not http(s)://host[/prefix]");
    let config = roots.map_or_else(tls::config, tls::config_with).unwrap();
    Fetcher::new(
        endpoint,
        config,
        Arc::new(Zeroizing::new(BOGUS.to_owned())),
        Duration::from_secs(20),
        tailchat_core::MAX_INBOUND,
    )
}

#[test]
#[ignore = "needs the network and the live cloud"]
fn live_https_reaches_the_server_through_the_real_chain() {
    let answer = runtime().block_on(fetcher(None).get("/api/history?peer=tailchat&limit=1"));
    // Only a verified handshake and a correctly framed answer get as far as a
    // status; a TLS or parsing failure would be `Network`.
    assert!(
        matches!(answer, Err(FetchError::Status(401, None))),
        "expected a clean 401 from the cloud, got {answer:?}"
    );
}

#[test]
#[ignore = "needs the network and the live cloud"]
fn live_https_refuses_a_chain_it_does_not_trust() {
    // The control: with no roots at all the same request must fail before any
    // byte of HTTP. If this ever passed, the test above would prove nothing.
    let answer = runtime().block_on(fetcher(Some(RootCertStore::empty())).get("/api/history"));
    assert_eq!(answer, Err(FetchError::Network));
}

#[test]
#[ignore = "needs the network and the live cloud"]
fn live_wss_upgrades_and_hears_the_refusal() {
    let url = socket_url(&base());
    assert!(Dialer::accepts(&url), "{url}");
    let timings = Timings::default();
    let dialer = Dialer::new(url, tls::config().unwrap(), Duration::from_secs(20));
    runtime().block_on(async {
        let mut socket = dialer.dial(&timings).await.expect("the wss dial failed");
        let auth = format!(r#"{{"k":"auth","token":"{BOGUS}","caps":[]}}"#);
        socket
            .write(&auth)
            .await
            .expect("the auth frame did not leave");
        let reply = tokio::time::timeout(Duration::from_secs(20), socket.next())
            .await
            .expect("the server said nothing");
        let SocketEvent::Text(text) = reply else {
            panic!("expected the refusal frame, got {reply:?}");
        };
        assert!(
            text.contains(r#""k":"error""#) && text.contains("auth_failed"),
            "unexpected frame: {text}"
        );
        socket.close(Duration::from_secs(2)).await;
    });
}

#[test]
#[ignore = "needs the network and the live cloud"]
fn live_wss_refuses_a_chain_it_does_not_trust() {
    let dialer = Dialer::new(
        socket_url(&base()),
        tls::config_with(RootCertStore::empty()).unwrap(),
        Duration::from_secs(20),
    );
    let outcome = runtime().block_on(dialer.dial(&Timings::default()));
    assert!(matches!(outcome, Err(DialFailed)));
}
