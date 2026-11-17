//! What the core remembers about the account feed and `/api/history`: which
//! keys this device holds, what each conversation still owes, and the one
//! history walk in flight. The decisions are in `engine/sync.rs`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::api::{Backfill, Below, Held, HistoryRequest, OwnRead, StoreOp, WalkFrom};
use crate::ids::{MessageId, Ts};
use crate::login::Login;

/// First pause after a failed history request.
const RETRY_FIRST_MS: i64 = 5_000;
/// Longest pause between history attempts.
const RETRY_MAX_MS: i64 = 300_000;

/// What one conversation owes, in memory.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Debt {
    /// Message ids the feed named that this device does not hold.
    pub(crate) owed: BTreeSet<MessageId>,
    /// A whole-conversation re-read after `reset`.
    pub(crate) reseed: Option<WalkFrom>,
}

impl Debt {
    /// Nothing left to fetch.
    pub(crate) fn is_empty(&self) -> bool {
        self.owed.is_empty() && self.reseed.is_none()
    }
}

/// Why a walk is running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WalkKind {
    /// Looking for the ids owed when the walk began, newest page first. Ids
    /// owed later are newer than its position and get a walk of their own.
    Owed(BTreeSet<MessageId>),
    /// Re-reading the whole conversation after `reset`.
    Reseed,
    /// One page a reader asked for (`Action::LoadOlder`).
    Older,
}

/// The one history walk in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Walk {
    /// The request awaiting an answer.
    pub(crate) request: HistoryRequest,
    /// Why.
    pub(crate) kind: WalkKind,
    /// A reaction in this conversation was applied while the request was in
    /// flight: the page's reaction sets may be older than what is on disk.
    pub(crate) reacted: bool,
    /// How many times this page was asked again because of that.
    pub(crate) repeats: u8,
}

/// Feed and history state.
#[derive(Debug, Default)]
pub(crate) struct SyncState {
    /// The server announced `sync-v1`.
    pub(crate) supported: bool,
    /// A `sync` request is waiting for its page.
    pub(crate) page_in_flight: bool,
    /// The feed moved while a page was in flight: read it once more.
    pub(crate) again: bool,
    /// Every key this device holds, with its last edit time, per conversation.
    pub(crate) held: HashMap<Login, HashMap<MessageId, Option<Ts>>>,
    /// Keys removed this session. A history page fetched before the removal
    /// must not bring them back.
    pub(crate) gone: HashMap<Login, HashSet<MessageId>>,
    /// What each conversation owes.
    pub(crate) debts: BTreeMap<Login, Debt>,
    /// Older pages readers asked for and not fetched yet, in memory only: a
    /// reader that restarts asks again.
    pub(crate) older: BTreeMap<Login, Option<Below>>,
    /// The walk in flight.
    pub(crate) walk: Option<Walk>,
    /// The serial of the last request issued.
    pub(crate) serial: u64,
    /// No walk before this time, after a failure.
    pub(crate) retry_at: Option<Ts>,
    /// Failures in a row, for the pause.
    pub(crate) failures: u32,
    /// The server refused the token: no more requests until the next `ready`.
    pub(crate) refused: bool,
    /// How far this account has read each conversation.
    pub(crate) own_reads: HashMap<Login, Ts>,
    /// History requests ask for envelopes: this device decrypts.
    pub(crate) sealed: bool,
}

impl SyncState {
    /// From what the driver loaded.
    pub(crate) fn restore(
        held: Vec<Held>,
        backfill: Vec<Backfill>,
        own_reads: Vec<OwnRead>,
    ) -> Self {
        let mut state = Self {
            debts: backfill
                .into_iter()
                .map(|b| {
                    let debt = Debt {
                        owed: b.owed.into_iter().collect(),
                        reseed: b.reseed,
                    };
                    (b.peer, debt)
                })
                .filter(|(_, debt)| !debt.is_empty())
                .collect(),
            own_reads: own_reads.into_iter().map(|r| (r.peer, r.read_ts)).collect(),
            ..Self::default()
        };
        for row in held {
            state.hold(row.peer, row.id, row.edited_at);
        }
        state
    }

    /// Whether this device holds `(peer, id)`.
    pub(crate) fn holds(&self, peer: &Login, id: &MessageId) -> bool {
        self.held.get(peer).is_some_and(|ids| ids.contains_key(id))
    }

    /// The edit time of a held row; `None` when it is not held.
    pub(crate) fn edited(&self, peer: &Login, id: &MessageId) -> Option<Option<Ts>> {
        self.held.get(peer).and_then(|ids| ids.get(id)).copied()
    }

    /// Records that `(peer, id)` is on disk, edited at `edited_at`.
    pub(crate) fn hold(&mut self, peer: Login, id: MessageId, edited_at: Option<Ts>) {
        self.held.entry(peer).or_default().insert(id, edited_at);
    }

    /// Forgets `(peer, id)` for this session. `true` if it was held.
    pub(crate) fn release(&mut self, peer: &Login, id: MessageId) -> bool {
        let held = self
            .held
            .get_mut(peer)
            .is_some_and(|ids| ids.remove(&id).is_some());
        self.gone.entry(peer.clone()).or_default().insert(id);
        held
    }

    /// Whether `(peer, id)` was removed this session.
    pub(crate) fn is_gone(&self, peer: &Login, id: &MessageId) -> bool {
        self.gone.get(peer).is_some_and(|ids| ids.contains(id))
    }

    /// Every conversation with a row on disk.
    pub(crate) fn held_peers(&self) -> impl Iterator<Item = &Login> {
        self.held
            .iter()
            .filter(|(_, ids)| !ids.is_empty())
            .map(|(peer, _)| peer)
    }

    /// A new authenticated socket: whatever was in flight is abandoned.
    pub(crate) fn connected(&mut self, supported: bool) {
        self.supported = supported;
        self.page_in_flight = false;
        self.again = false;
        // A reader's page is still wanted on the new socket.
        if let Some(walk) = self.walk.take()
            && walk.kind == WalkKind::Older
        {
            self.older
                .entry(walk.request.peer)
                .or_insert(walk.request.below);
        }
        self.retry_at = None;
        self.failures = 0;
        self.refused = false;
    }

    /// The op that makes `peer`'s debt on disk match memory.
    pub(crate) fn debt_op(&self, peer: &Login) -> StoreOp {
        match self.debts.get(peer) {
            Some(debt) if !debt.is_empty() => StoreOp::PutBackfill(Backfill {
                peer: peer.clone(),
                owed: debt.owed.iter().cloned().collect(),
                reseed: debt.reseed.clone(),
            }),
            _ => StoreOp::DropBackfill(peer.clone()),
        }
    }

    /// Owes `id` in `peer`'s conversation. `true` if it was not owed yet.
    pub(crate) fn owe(&mut self, peer: &Login, id: MessageId) -> bool {
        self.debts.entry(peer.clone()).or_default().owed.insert(id)
    }

    /// No longer owes `id`. `true` if it was owed.
    pub(crate) fn settle(&mut self, peer: &Login, id: &MessageId) -> bool {
        let Some(debt) = self.debts.get_mut(peer) else {
            return false;
        };
        let settled = debt.owed.remove(id);
        if debt.is_empty() {
            self.debts.remove(peer);
        }
        settled
    }

    /// The next request number.
    pub(crate) fn next_serial(&mut self) -> u64 {
        self.serial = self.serial.wrapping_add(1);
        self.serial
    }

    /// A request failed: back off, doubling up to five minutes.
    pub(crate) fn failed(&mut self, now: Ts) {
        self.walk = None;
        let shift = self.failures.min(6);
        let pause = (RETRY_FIRST_MS << shift).min(RETRY_MAX_MS);
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(Ts(now.0.saturating_add(pause)));
    }

    /// When the next walk may start, if one is owed and waiting on a pause.
    pub(crate) fn wakeup(&self) -> Option<Ts> {
        if self.walk.is_some() || self.refused || (self.debts.is_empty() && self.older.is_empty())
        {
            return None;
        }
        self.retry_at
    }

    /// The first request of a walk over `peer`'s conversation.
    pub(crate) fn request(
        &mut self,
        peer: Login,
        below: Option<Below>,
        limit: u16,
    ) -> HistoryRequest {
        HistoryRequest {
            serial: self.next_serial(),
            peer,
            below,
            limit,
            sealed: self.sealed,
        }
    }
}
