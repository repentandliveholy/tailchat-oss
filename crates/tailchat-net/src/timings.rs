//! Every duration the driver waits on, in one place so tests can shrink them.

use std::time::Duration;

/// The driver's clocks. [`Default`] is what ships; tests use smaller ones.
#[cfg(feature = "native")]
#[derive(Debug, Clone)]
pub(crate) struct Timings {
    /// First pause before redialling; doubles on every failure.
    pub(crate) backoff_min: Duration,
    /// The pause never grows past this.
    pub(crate) backoff_max: Duration,
    /// Silence (no frame, no ping) after which the socket is declared dead.
    pub(crate) watchdog: Duration,
    /// How often the silence is measured. It is measured against the wall
    /// clock, so a laptop that slept notices on the first check after waking.
    pub(crate) watchdog_poll: Duration,
    /// Dialling: DNS, TCP, TLS and the WebSocket upgrade together.
    pub(crate) dial: Duration,
    /// One frame written and flushed. A write that is neither done nor failed
    /// by now is a dead link.
    pub(crate) write: Duration,
    /// One history request, connect to last byte.
    pub(crate) fetch: Duration,
    /// How long a goodbye (`Close` frame) may take before the socket is just
    /// dropped.
    pub(crate) close: Duration,
}

#[cfg(feature = "native")]
impl Default for Timings {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            watchdog: Duration::from_secs(35),
            watchdog_poll: Duration::from_secs(5),
            dial: Duration::from_secs(20),
            write: Duration::from_secs(60),
            fetch: Duration::from_secs(30),
            close: Duration::from_millis(250),
        }
    }
}

/// The redial pause: `min`, doubling after every failure up to `max`, back to
/// `min` once a connection got as far as `ready`.
#[derive(Debug, Clone)]
pub struct Backoff {
    /// The first pause, and the one after a reset.
    min: Duration,
    /// The ceiling.
    max: Duration,
    /// The pause to hand out next.
    next: Duration,
}

impl Backoff {
    /// A backoff that starts at `min`.
    pub fn new(min: Duration, max: Duration) -> Self {
        Self {
            min,
            max,
            next: min,
        }
    }

    /// The pause to wait now; the one after it doubles.
    pub fn take(&mut self) -> Duration {
        let now = self.next;
        self.next = self.next.saturating_mul(2).min(self.max);
        now
    }

    /// Back to the first pause.
    pub fn reset(&mut self) {
        self.next = self.min;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_the_ceiling_and_resets() {
        let t = Timings::default();
        let mut backoff = Backoff::new(t.backoff_min, t.backoff_max);
        let seen: Vec<u64> = (0..8).map(|_| backoff.take().as_secs()).collect();
        assert_eq!(seen, [1, 2, 4, 8, 16, 30, 30, 30]);
        backoff.reset();
        assert_eq!(backoff.take(), Duration::from_secs(1));
        assert_eq!(backoff.take(), Duration::from_secs(2));
    }
}
