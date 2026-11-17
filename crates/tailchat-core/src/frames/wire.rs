//! The two ids that arrive as plain strings, read by their own rules.
//!
//! `Login` and `MessageId` are already the only way to hold a valid one, so
//! the wire simply calls their parsers: a string that does not fit is a frame
//! error, and the codec never constructs one of these by hand.

use std::fmt;

use serde::Deserialize;
use serde::de::{self, Deserializer, Visitor};

use crate::ids::MessageId;
use crate::login::Login;

impl<'de> Deserialize<'de> for Login {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_str(LoginVisitor).and_then(|raw| {
            Self::parse(&raw).map_err(|error| de::Error::custom(error_message(&error)))
        })
    }
}

impl<'de> Deserialize<'de> for MessageId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer
            .deserialize_str(MessageIdVisitor)
            .and_then(|raw| {
                Self::parse(&raw).map_err(|error| de::Error::custom(error_message(&error)))
            })
    }
}

/// Why a string is not a login or a message id, for the log.
fn error_message(error: &crate::error::CoreError) -> String {
    error.to_string()
}

/// Reads a borrowed string without copying it twice.
struct LoginVisitor;

impl Visitor<'_> for LoginVisitor {
    type Value = String;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a login")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(value.to_owned())
    }
}

/// Reads a borrowed string without copying it twice.
struct MessageIdVisitor;

impl Visitor<'_> for MessageIdVisitor {
    type Value = String;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a message id")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logins_are_normalized_as_the_server_normalizes_them() {
        let login: Login = serde_json::from_str("\"  GodSheep \"").expect("valid login");
        assert_eq!(login.as_str(), "godsheep");
    }

    #[test]
    fn a_bad_login_or_id_is_a_frame_error() {
        assert!(serde_json::from_str::<Login>(r#""not a login""#).is_err());
        assert!(serde_json::from_str::<Login>("5").is_err());
        assert!(serde_json::from_str::<MessageId>(r#""""#).is_err());
        assert!(serde_json::from_str::<MessageId>(r#""m-1""#).is_ok());
    }
}
