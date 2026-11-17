use crate::error::CoreError;

/// Shortest login, in characters (server: `{2,31}` after the first one).
const MIN_LEN: usize = 3;
/// Longest login, in characters.
const MAX_LEN: usize = 32;

/// A Tailchat account login, already normalized and validated.
///
/// Same rule as the server (`src/cloud/accounts.js`):
/// trim + lowercase, then `/^[a-z0-9][a-z0-9._-]{2,31}$/`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Login(String);

impl Login {
    /// The only way to obtain a `Login`.
    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let normalized = raw.trim().to_lowercase();

        let mut chars = normalized.chars();
        match chars.next() {
            Some(c) if is_head(c) => {}
            Some(_) => return Err(invalid("must start with a-z or 0-9")),
            None => return Err(invalid("too short")),
        }
        if !chars.all(is_tail) {
            return Err(invalid("only a-z 0-9 . _ - allowed"));
        }

        let len = normalized.len();
        if len < MIN_LEN {
            return Err(invalid("too short"));
        }
        if len > MAX_LEN {
            return Err(invalid("too long"));
        }

        Ok(Self(normalized))
    }

    /// The login as text, for frames and storage.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The error for a login that breaks the rule in the way `reason` says.
fn invalid(reason: &'static str) -> CoreError {
    CoreError::InvalidLogin { reason }
}

/// Allowed as the first character: `a-z` or `0-9`.
fn is_head(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

/// Allowed after the first character: the same, plus `.`, `_` and `-`.
fn is_tail(c: char) -> bool {
    is_head(c) || matches!(c, '.' | '_' | '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(raw: &str) -> &'static str {
        match Login::parse(raw) {
            Err(CoreError::InvalidLogin { reason }) => reason,
            other => panic!("{raw:?} gave {other:?}"),
        }
    }

    #[test]
    fn normalizes_case_and_spaces() {
        assert_eq!(Login::parse("  GodSheep ").unwrap().as_str(), "godsheep");
    }

    #[test]
    fn length_boundaries() {
        assert!(Login::parse("abc").is_ok());
        assert!(Login::parse(&"a".repeat(32)).is_ok());
        assert_eq!(reason("ab"), "too short");
        assert_eq!(reason(""), "too short");
        assert_eq!(reason(&"a".repeat(33)), "too long");
    }

    #[test]
    fn first_char_must_be_letter_or_digit() {
        assert_eq!(reason("_abc"), "must start with a-z or 0-9");
        assert!(Login::parse("9abc").is_ok());
    }

    #[test]
    fn rejects_foreign_characters() {
        assert!(Login::parse("a.b_c-d").is_ok());
        assert_eq!(reason("ab c"), "only a-z 0-9 . _ - allowed");
        assert_eq!(reason("алиса"), "must start with a-z or 0-9");
        assert_eq!(reason("abc@d"), "only a-z 0-9 . _ - allowed");
    }
}
