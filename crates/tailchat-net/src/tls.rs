//! One TLS configuration for both the WebSocket and the history GET.

use std::sync::Arc;

use rustls::{ClientConfig, RootCertStore};

/// rustls with Mozilla's roots (compiled in) and the `ring` provider, named
/// explicitly: this crate lives inside a Node process, and another addon there
/// may have installed a different process-wide default.
pub(crate) fn config() -> Result<Arc<ClientConfig>, rustls::Error> {
    config_with(RootCertStore::from_iter(
        webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
    ))
}

/// The same configuration trusting exactly `roots`.
pub(crate) fn config_with(roots: RootCertStore) -> Result<Arc<ClientConfig>, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}
