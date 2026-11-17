use std::fmt::Write;

use crate::error::CoreError;

/// Longest id we accept, in bytes. The server has no limit; this stops abuse.
const MESSAGE_ID_MAX: usize = 1024;

/// Message id. The client that writes a message picks it; the server only
/// checks it is a non-empty string (`src/cloud/hub.js`). Ids come from other
/// clients and bots too, so we accept anything except empty, control
/// characters and absurd lengths.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MessageId(String);

impl MessageId {
    /// Checks a message id from anywhere: our UI, the server, another client.
    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let ok =
            !raw.is_empty() && raw.len() <= MESSAGE_ID_MAX && !raw.chars().any(char::is_control);
        if ok {
            Ok(Self(raw.to_owned()))
        } else {
            Err(CoreError::InvalidMessageId)
        }
    }

    /// A fresh id from 16 random bytes: `m-` + 32 hex, the web client's shape.
    /// The driver supplies the bytes from the OS random source.
    pub fn from_random(bytes: [u8; 16]) -> Self {
        let mut id = String::with_capacity(2 + 32);
        id.push_str("m-");
        for byte in bytes {
            // Writing into a String cannot fail; the Result is only there for files and sockets.
            let _ = write!(id, "{byte:02x}");
        }
        Self(id)
    }

    /// The id as text, for frames and storage.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Milliseconds since the Unix epoch, UTC — the unit of every `ts` on the wire.
/// Signed, like JS numbers and Kotlin `Long`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ts(pub i64);

/// Position in the account's sync-v1 event feed (`sync` / `sync-page`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Seq(pub i64);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_id_shape_in_use() {
        for id in [
            "m-3f2a9c01d4e5b6a7c8d9e0f1",
            "0b6a3c1e-2f4d-4a5b-9c8d-7e6f5a4b3c2d",
            "android-184",
            "service-menu-v1",
            "id from a bot",
            "идентификатор",
        ] {
            assert!(MessageId::parse(id).is_ok(), "{id}");
        }
    }

    #[test]
    fn rejects_empty_controls_and_overlong() {
        assert!(MessageId::parse("").is_err());
        assert!(MessageId::parse("m-1\n").is_err());
        assert!(MessageId::parse("m-\u{0}1").is_err());
        assert!(MessageId::parse(&"a".repeat(1024)).is_ok());
        assert!(MessageId::parse(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn random_id_is_hex_of_the_bytes() {
        let mut bytes = [0u8; 16];
        bytes[0] = 0x0f;
        bytes[15] = 0xa0;
        let id = MessageId::from_random(bytes);
        assert_eq!(id.as_str(), format!("m-0f{}a0", "00".repeat(14)));
    }
}
