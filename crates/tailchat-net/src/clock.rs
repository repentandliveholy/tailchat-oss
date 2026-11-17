//! The driver's wall clock: the core has none of its own.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tailchat_core::Ts;

/// Milliseconds since the Unix epoch; a clock set before 1970 reads as 0.
pub(crate) fn now() -> Ts {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    Ts(i64::try_from(ms).unwrap_or(i64::MAX))
}

/// How long until `at`: zero when it is already past.
pub(crate) fn until(at: Ts) -> Duration {
    let ms = at.0.saturating_sub(now().0);
    Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn until_counts_forward_and_floors_at_zero() {
        let now = now();
        assert_eq!(until(Ts(now.0 - 10_000)), Duration::ZERO);
        let ahead = until(Ts(now.0 + 5_000));
        assert!(ahead <= Duration::from_millis(5_000) && ahead > Duration::from_millis(4_000));
        assert_eq!(until(Ts(i64::MIN)), Duration::ZERO);
    }
}
