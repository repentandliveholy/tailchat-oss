/// Delivery state of a message we sent: the receipt ladder of AGENTS.md §12.
///
/// `Queued ⧗ → Sent ✓ → Delivered ✓✓ → Read ✓✓ (read colour)`, and `Failed ⚠`
/// beside the ladder. How a rung is drawn is the client's business; the rules
/// for moving between rungs live here and nowhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Receipt {
    /// ⧗ Written on this device, not yet committed by the server.
    Queued,
    /// ✓ The server committed it (`message-accepted`, after its fsync).
    Sent,
    /// ✓✓ The peer's device holds it (`ack`).
    Delivered,
    /// ✓✓ in the read colour: the peer opened it (`read`).
    Read,
    /// ⚠ Will not go out without the user pressing "retry".
    Failed,
}

impl Receipt {
    /// Applies news about the message and returns the rung it ends up on.
    ///
    /// - The ladder never walks backwards: Read beats Delivered beats Sent.
    /// - Only a message the server has not committed (`Queued`) can fail.
    /// - A failed message the server turns out to have climbs back on.
    /// - Nothing returns to `Queued` here; that is [`Receipt::retry`].
    pub fn advance(self, news: Receipt) -> Receipt {
        if news == Receipt::Queued {
            return self;
        }
        if news == Receipt::Failed {
            return if self == Receipt::Queued {
                Receipt::Failed
            } else {
                self
            };
        }
        if self == Receipt::Failed || news.rank() > self.rank() {
            news
        } else {
            self
        }
    }

    /// The user pressed "retry": a failed message goes back to the queue,
    /// anything else stays as it is (`None`).
    pub fn retry(self) -> Option<Receipt> {
        if self == Receipt::Failed {
            Some(Receipt::Queued)
        } else {
            None
        }
    }

    /// Height on the ladder. `Failed` is not on it; `advance` handles it first.
    fn rank(self) -> u8 {
        match self {
            Receipt::Queued | Receipt::Failed => 0,
            Receipt::Sent => 1,
            Receipt::Delivered => 2,
            Receipt::Read => 3,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Receipt::{self, *};

    #[test]
    fn climbs_the_ladder() {
        assert_eq!(Queued.advance(Sent), Sent);
        assert_eq!(Sent.advance(Delivered), Delivered);
        assert_eq!(Delivered.advance(Read), Read);
        assert_eq!(Queued.advance(Read), Read);
    }

    #[test]
    fn never_walks_backwards() {
        assert_eq!(Read.advance(Delivered), Read);
        assert_eq!(Delivered.advance(Sent), Delivered);
        assert_eq!(Sent.advance(Queued), Sent);
    }

    #[test]
    fn only_uncommitted_can_fail() {
        assert_eq!(Queued.advance(Failed), Failed);
        assert_eq!(Sent.advance(Failed), Sent);
        assert_eq!(Read.advance(Failed), Read);
    }

    #[test]
    fn failed_climbs_back_when_server_had_it() {
        assert_eq!(Failed.advance(Sent), Sent);
        assert_eq!(Failed.advance(Read), Read);
        assert_eq!(Failed.advance(Queued), Failed);
    }

    #[test]
    fn retry_only_from_failed() {
        assert_eq!(Failed.retry(), Some(Queued));
        let others: [Receipt; 4] = [Queued, Sent, Delivered, Read];
        assert!(others.iter().all(|r| r.retry().is_none()));
    }
}
