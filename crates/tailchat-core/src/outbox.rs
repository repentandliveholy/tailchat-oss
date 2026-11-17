//! The uncommitted queue, the committed rows that receipt positions upgrade,
//! and the delivery receipts this device owes. Every socket write here shares
//! one pace. No I/O: even the retry jitter is derived from the driver's
//! random message id.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};

use crate::api::{Event, Outgoing, Output, OwedAck, PeerReceipts, PendingOutgoing, Seal, StoreOp};
use crate::error::CoreError;
use crate::frames;
use crate::ids::{MessageId, Ts};
use crate::login::Login;
use crate::receipt::Receipt;

/// Uncommitted rows per conversation, including rows awaiting manual retry.
const LIMIT: usize = 1000;
/// Writes allowed before the message needs a manual retry.
const ATTEMPTS: u8 = 8;
/// One message per 34 ms: never more than 30 writes in any one-second window.
const SPACING_MS: i64 = 34;
/// Backoff ceiling, including jitter.
const MAX_DELAY_MS: i64 = 300_000;

/// The last socket write, so a throttle or a refused write can be undone.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Write {
    /// A message of ours.
    Message(Login, MessageId),
    /// A delivery receipt for a peer's message.
    Ack(OwedAck),
}

/// Owns queued rows, retry deadlines, the durable receipt ladder and the
/// delivery receipts still owed.
pub(crate) struct Outbox {
    /// Round-robin order prevents retries at the front starving new messages.
    pending: VecDeque<PendingOutgoing>,
    /// Committed rows still need delivery/read upgrades.
    sent: Vec<Outgoing>,
    /// Monotonic positions; read always implies delivered.
    receipts: HashMap<Login, PeerReceipts>,
    /// One owed `ack` per peer: the newest stored message from them.
    acks: BTreeMap<Login, OwedAck>,
    /// The newest time acknowledged or owed per peer this session, so an
    /// older message stored later does not cost another frame.
    ack_floor: HashMap<Login, Ts>,
    /// Global pacing or throttle deadline on the current socket.
    gate: Option<Ts>,
    /// The most recent write, used to undo it when it was not accepted.
    last_write: Option<Write>,
}

impl Outbox {
    /// Restores rows without charging an attempt for restarting the client.
    pub(crate) fn restore(
        pending: Vec<PendingOutgoing>,
        sent: Vec<Outgoing>,
        receipts: Vec<PeerReceipts>,
        acks: Vec<OwedAck>,
    ) -> Self {
        let receipts = receipts.into_iter().map(|r| (r.peer.clone(), r)).collect();
        let ack_floor = acks.iter().map(|a| (a.peer.clone(), a.ts)).collect();
        let acks = acks.into_iter().map(|a| (a.peer.clone(), a)).collect();
        Self {
            pending: pending.into(),
            sent,
            receipts,
            acks,
            ack_floor,
            gate: None,
            last_write: None,
        }
    }

    /// Queues new text without evicting any old row when the queue is full.
    pub(crate) fn enqueue(&mut self, message: Outgoing, now: Ts) -> Result<Vec<Output>, CoreError> {
        if self
            .pending
            .iter()
            .any(|r| same(&r.message, &message.peer, &message.id))
            || self
                .sent
                .iter()
                .any(|m| same(m, &message.peer, &message.id))
        {
            return Err(CoreError::DuplicateMessageId);
        }
        if self
            .pending
            .iter()
            .filter(|r| r.message.peer == message.peer)
            .count()
            >= LIMIT
        {
            return Err(CoreError::QueueFull { limit: LIMIT });
        }
        let row = PendingOutgoing {
            message,
            attempts: 0,
            next_attempt_at: now,
            seal: Seal::Undecided,
        };
        let out = vec![
            Output::Persist(vec![StoreOp::PutPending(row.clone())]),
            Output::Event(Event::MessageAdded(row.message.clone())),
        ];
        self.pending.push_back(row);
        Ok(out)
    }

    /// Makes queued rows immediately eligible on a new authenticated socket.
    /// Previous attempts survive; offline time and reconnects do not spend any.
    pub(crate) fn connected(&mut self, now: Ts) {
        self.gate = None;
        self.last_write = None;
        for row in &mut self.pending {
            if row.message.receipt == Receipt::Queued {
                row.next_attempt_at = now;
            }
        }
    }

    /// The next time the driver should feed Tick; the core suppresses this
    /// offline. Rows `sendable` refuses (waiting for an encryption decision)
    /// set no timer of their own: whatever unblocks them wakes the core.
    pub(crate) fn next_wakeup(&self, sendable: &dyn Fn(&PendingOutgoing) -> bool) -> Option<Ts> {
        let acks = (!self.acks.is_empty()).then(|| self.gate.unwrap_or(Ts(i64::MIN)));
        self.pending
            .iter()
            .filter(|r| r.message.receipt == Receipt::Queued && sendable(r))
            .map(|r| {
                self.gate
                    .map_or(r.next_attempt_at, |g| g.max(r.next_attempt_at))
            })
            .chain(acks)
            .min()
    }

    /// Whether the shared pace allows a write now.
    pub(crate) fn gate_open(&self, now: Ts) -> bool {
        self.gate.is_none_or(|g| now >= g)
    }

    /// When the shared pace allows the next write, if it is closed.
    pub(crate) fn gate(&self) -> Option<Ts> {
        self.gate
    }

    /// Another module wrote a frame (a key message): it takes the slot, and
    /// a `throttle` after it must not refund the queue's last write.
    pub(crate) fn foreign_write(&mut self, now: Ts) {
        self.gate = Some(after(now, SPACING_MS));
        self.last_write = None;
    }

    /// Writes at most one frame: an owed receipt first, because one per peer
    /// is all there can be, then a message. Failed rows cannot block the rest
    /// of the queue; rows `sendable` refuses wait without spending an attempt.
    pub(crate) fn poll(
        &mut self,
        now: Ts,
        roster: &HashSet<Login>,
        me: &Login,
        sendable: &dyn Fn(&PendingOutgoing) -> bool,
    ) -> Vec<Output> {
        let mut out = Vec::new();
        if self.gate.is_some_and(|g| now < g) {
            return out;
        }
        while let Some((peer, owed)) = self.acks.pop_first() {
            // Unencodable or no longer a friend: the server would refuse it.
            let frame = roster
                .contains(&peer)
                .then(|| frames::ack(&peer, &owed.id).ok())
                .flatten();
            if let Some(frame) = frame {
                self.gate = Some(after(now, SPACING_MS));
                self.last_write = Some(Write::Ack(owed));
                out.push(Output::Send(frame));
                out.push(Output::Persist(vec![StoreOp::DropAck(peer)]));
                return out;
            }
            out.push(Output::Persist(vec![StoreOp::DropAck(peer)]));
        }
        for _ in 0..self.pending.len() {
            let Some(mut row) = self.pending.pop_front() else {
                break;
            };
            if row.message.receipt != Receipt::Queued
                || row.next_attempt_at > now
                || !sendable(&row)
            {
                self.pending.push_back(row);
                continue;
            }
            if &row.message.peer != me && !roster.contains(&row.message.peer) {
                fail(&mut row, "peer_not_found", &mut out);
                self.pending.push_back(row);
                continue;
            }
            if row.attempts >= ATTEMPTS {
                fail(&mut row, "no_acceptance", &mut out);
                self.pending.push_back(row);
                continue;
            }
            let frame = match &row.seal {
                Seal::Encrypted(envelope) => frames::en::msg_sealed(&row.message, envelope),
                Seal::Undecided | Seal::Plain => frames::msg(&row.message),
            };
            match frame {
                Ok(frame) => {
                    row.attempts += 1;
                    row.next_attempt_at = after(now, delay(&row));
                    self.gate = Some(after(now, SPACING_MS));
                    self.last_write = Some(Write::Message(
                        row.message.peer.clone(),
                        row.message.id.clone(),
                    ));
                    out.push(Output::Persist(vec![attempt_op(&row)]));
                    out.push(Output::Send(frame));
                    self.pending.push_back(row);
                    break;
                }
                Err(_) => {
                    fail(&mut row, "frame_too_large", &mut out);
                    self.pending.push_back(row);
                }
            }
        }
        out
    }

    /// Resets only a failed row, keeping its original id, text and timestamp.
    pub(crate) fn retry(
        &mut self,
        now: Ts,
        peer: &Login,
        id: &MessageId,
    ) -> Result<Vec<Output>, CoreError> {
        let row = self
            .pending
            .iter_mut()
            .find(|r| same(&r.message, peer, id))
            .ok_or(CoreError::NotRetryable)?;
        row.message.receipt = row.message.receipt.retry().ok_or(CoreError::NotRetryable)?;
        row.attempts = 0;
        row.next_attempt_at = now;
        Ok(vec![
            Output::Persist(vec![StoreOp::PutPending(row.clone())]),
            Output::Event(changed(&row.message)),
        ])
    }

    /// Takes a queued row out without committing it (a withdrawn message).
    pub(crate) fn discard(&mut self, peer: &Login, id: &MessageId) -> Option<PendingOutgoing> {
        let index = self.pending.iter().position(|r| same(&r.message, peer, id))?;
        self.pending.remove(index)
    }

    /// Acceptance replaces the timestamp before applying saved watermarks.
    /// An unrelated or repeated acceptance does not invent or regress a row.
    pub(crate) fn accepted(&mut self, peer: &Login, id: &MessageId, ts: Ts) -> Vec<Output> {
        let Some(index) = self.pending.iter().position(|r| same(&r.message, peer, id)) else {
            return Vec::new();
        };
        let Some(row) = self.pending.remove(index) else {
            return Vec::new();
        };
        let mut message = row.message;
        message.ts = ts;
        message.receipt = message.receipt.advance(Receipt::Sent);
        if let Some(receipts) = self.receipts.get(peer) {
            upgrade(&mut message, receipts);
        }
        let event = changed(&message);
        let op = StoreOp::PutOutgoing(message.clone());
        self.sent.push(message);
        vec![Output::Persist(vec![op]), Output::Event(event)]
    }

    /// A permanent refusal fails only the identified uncommitted row.
    pub(crate) fn rejected(&mut self, peer: &Login, id: &MessageId, code: &str) -> Vec<Output> {
        let mut out = Vec::new();
        if let Some(row) = self.pending.iter_mut().find(|r| same(&r.message, peer, id))
            && row.message.receipt == Receipt::Queued
        {
            fail(row, code, &mut out);
        }
        out
    }

    /// Throttling spends no attempt. Pause all rows, undo the latest rejected
    /// write if still queued, and keep a non-zero wakeup instead of busy-looping.
    pub(crate) fn throttle(&mut self, now: Ts, window_ms: i64) -> Vec<Output> {
        let until = after(now, window_ms.max(1000));
        self.gate = Some(self.gate.map_or(until, |g| g.max(until)));
        let mut ops = Vec::new();
        let last = match self.last_write.take() {
            Some(Write::Ack(owed)) => {
                self.reowe(owed, &mut ops);
                None
            }
            Some(Write::Message(peer, id)) => Some((peer, id)),
            None => None,
        };
        for row in &mut self.pending {
            if row.message.receipt != Receipt::Queued {
                continue;
            }
            if last
                .as_ref()
                .is_some_and(|(peer, id)| same(&row.message, peer, id))
            {
                row.attempts = row.attempts.saturating_sub(1);
            }
            row.next_attempt_at = row.next_attempt_at.max(until);
            ops.push(attempt_op(row));
        }
        if ops.is_empty() {
            Vec::new()
        } else {
            vec![Output::Persist(ops)]
        }
    }

    /// Refunds an identified write the socket refused. This is not delivery
    /// uncertainty: the driver explicitly knows no bytes were accepted.
    pub(crate) fn write_failed(&mut self, peer: &Login, id: &MessageId) -> Vec<Output> {
        match self.last_write.take() {
            Some(Write::Message(p, i)) if &p == peer && &i == id => {
                let Some(row) = self.pending.iter_mut().find(|r| same(&r.message, peer, id)) else {
                    return Vec::new();
                };
                row.attempts = row.attempts.saturating_sub(1);
                vec![Output::Persist(vec![attempt_op(row)])]
            }
            Some(Write::Ack(owed)) if &owed.peer == peer && &owed.id == id => {
                let mut ops = Vec::new();
                self.reowe(owed, &mut ops);
                if ops.is_empty() {
                    Vec::new()
                } else {
                    vec![Output::Persist(ops)]
                }
            }
            other => {
                self.last_write = other;
                Vec::new()
            }
        }
    }

    /// Owes `peer` a receipt for a message just stored, unless a newer one is
    /// already owed or written this session.
    pub(crate) fn owe_ack(&mut self, owed: OwedAck) -> Vec<Output> {
        if self
            .ack_floor
            .get(&owed.peer)
            .is_some_and(|&ts| ts >= owed.ts)
        {
            return Vec::new();
        }
        self.ack_floor.insert(owed.peer.clone(), owed.ts);
        let op = StoreOp::PutAck(owed.clone());
        self.acks.insert(owed.peer.clone(), owed);
        vec![Output::Persist(vec![op])]
    }

    /// Puts back a receipt whose write did not count, unless a newer one has
    /// been owed since.
    fn reowe(&mut self, owed: OwedAck, ops: &mut Vec<StoreOp>) {
        if self.acks.get(&owed.peer).is_some_and(|a| a.ts >= owed.ts) {
            return;
        }
        ops.push(StoreOp::PutAck(owed.clone()));
        self.acks.insert(owed.peer.clone(), owed);
    }

    /// Whether `(peer, id)` is one of ours still waiting for the server.
    pub(crate) fn is_pending(&self, peer: &Login, id: &MessageId) -> bool {
        self.pending.iter().any(|r| same(&r.message, peer, id))
    }

    /// Queued rows whose seal is still undecided and whose time has come,
    /// grouped by conversation in queue order.
    pub(crate) fn undecided_due(&self, now: Ts) -> Vec<(Login, Vec<MessageId>)> {
        let mut groups: Vec<(Login, Vec<MessageId>)> = Vec::new();
        for row in &self.pending {
            if row.message.receipt != Receipt::Queued
                || row.seal != Seal::Undecided
                || row.next_attempt_at > now
            {
                continue;
            }
            match groups
                .iter_mut()
                .find(|(peer, _)| *peer == row.message.peer)
            {
                Some((_, ids)) => ids.push(row.message.id.clone()),
                None => groups.push((row.message.peer.clone(), vec![row.message.id.clone()])),
            }
        }
        groups
    }

    /// The queued row, for a seal decision that needs all of it (the caption
    /// and the picture's URL, not only the text).
    pub(crate) fn pending_row(&self, peer: &Login, id: &MessageId) -> Option<&PendingOutgoing> {
        self.pending.iter().find(|r| same(&r.message, peer, id))
    }

    /// Decides a queued row's seal; the row to persist, if it exists.
    pub(crate) fn set_seal(
        &mut self,
        peer: &Login,
        id: &MessageId,
        seal: Seal,
    ) -> Option<PendingOutgoing> {
        let row = self
            .pending
            .iter_mut()
            .find(|r| same(&r.message, peer, id))?;
        row.seal = seal;
        Some(row.clone())
    }

    /// Fails a queued row before anything of it was written to the socket:
    /// its seal stays undecided, so "retry" decides it again.
    pub(crate) fn fail_unsealed(
        &mut self,
        peer: &Login,
        id: &MessageId,
        code: &str,
    ) -> Vec<Output> {
        let mut out = Vec::new();
        if let Some(row) = self
            .pending
            .iter_mut()
            .find(|r| same(&r.message, peer, id) && r.seal == Seal::Undecided)
        {
            fail(row, code, &mut out);
        }
        out
    }

    /// The keys of every committed outgoing row.
    pub(crate) fn sent_keys(&self) -> impl Iterator<Item = (&Login, &MessageId)> {
        self.sent.iter().map(|m| (&m.peer, &m.id))
    }

    /// Keeps the in-memory copy of a committed row in step with an edit made
    /// on another device, so a later receipt upgrade does not write old text.
    pub(crate) fn edit_sent(&mut self, peer: &Login, id: &MessageId, text: &str) {
        if let Some(message) = self.sent.iter_mut().find(|m| same(m, peer, id)) {
            text.clone_into(&mut message.text);
        }
    }

    /// Forgets committed rows deleted or hidden on another device.
    pub(crate) fn remove_sent(&mut self, peer: &Login, ids: &[MessageId]) {
        self.sent
            .retain(|m| &m.peer != peer || !ids.contains(&m.id));
    }

    /// Merges durable delivery/read positions. Queued/failed rows never inherit
    /// watermarks until their own server acceptance supplies the correct time.
    pub(crate) fn watermarks(&mut self, news: PeerReceipts) -> Vec<Output> {
        let merged = self
            .receipts
            .entry(news.peer.clone())
            .or_insert(PeerReceipts {
                peer: news.peer.clone(),
                delivered_ts: None,
                read_ts: None,
            });
        let previous = merged.clone();
        merged.read_ts = merged.read_ts.max(news.read_ts);
        merged.delivered_ts = merged
            .delivered_ts
            .max(news.delivered_ts)
            .max(merged.read_ts);
        if *merged == previous {
            return Vec::new();
        }
        let mut ops = vec![StoreOp::PutPeerReceipts(merged.clone())];
        let mut events = Vec::new();
        for message in &mut self.sent {
            if message.peer != news.peer {
                continue;
            }
            let before = message.receipt;
            upgrade(message, merged);
            if message.receipt != before {
                ops.push(StoreOp::PutOutgoing(message.clone()));
                events.push(Output::Event(changed(message)));
            }
        }
        let mut out = vec![Output::Persist(ops)];
        out.extend(events);
        out
    }

    /// Applies a relayed receipt. Older servers may omit the timestamp; only
    /// an already committed matching id can supply it in that case.
    pub(crate) fn receipt(
        &mut self,
        peer: &Login,
        id: &MessageId,
        ts: Option<Ts>,
        read: bool,
    ) -> Vec<Output> {
        let ts = ts.or_else(|| self.sent.iter().find(|m| same(m, peer, id)).map(|m| m.ts));
        let Some(ts) = ts else { return Vec::new() };
        self.watermarks(PeerReceipts {
            peer: peer.clone(),
            delivered_ts: Some(ts),
            read_ts: if read { Some(ts) } else { None },
        })
    }
}

/// The same id in different conversations is not the same message.
fn same(message: &Outgoing, peer: &Login, id: &MessageId) -> bool {
    &message.peer == peer && &message.id == id
}

/// Adds elapsed milliseconds without wrapping at the edge of the wire's i64.
fn after(now: Ts, ms: i64) -> Ts {
    Ts(now.0.saturating_add(ms))
}

/// Exponential delay plus up to 25% spread, capped at five minutes. Message
/// ids already contain OS randomness: hashing their bytes spreads clients
/// without doing I/O here. This hash is scheduling only, never cryptography.
fn delay(row: &PendingOutgoing) -> i64 {
    let shift = u32::from(row.attempts.saturating_sub(1).min(8));
    let base = (1000_i64 << shift).min(MAX_DELAY_MS);
    let mut hash = DefaultHasher::new();
    row.message.peer.hash(&mut hash);
    row.message.id.hash(&mut hash);
    row.attempts.hash(&mut hash);
    let [low, high, ..] = hash.finish().to_le_bytes();
    let sample = i64::from(u16::from_le_bytes([low, high]));
    (base + sample % (base / 4 + 1)).min(MAX_DELAY_MS)
}

/// Metadata-only update: retrying a large text need not copy it into the store.
fn attempt_op(row: &PendingOutgoing) -> StoreOp {
    StoreOp::SetAttempt {
        peer: row.message.peer.clone(),
        id: row.message.id.clone(),
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at,
    }
}

/// A UI receipt update always carries the authoritative timestamp too.
fn changed(message: &Outgoing) -> Event {
    Event::ReceiptChanged {
        peer: message.peer.clone(),
        id: message.id.clone(),
        ts: message.ts,
        receipt: message.receipt,
    }
}

/// Fails the one row and records why; other conversations continue sending.
fn fail(row: &mut PendingOutgoing, code: &str, out: &mut Vec<Output>) {
    row.message.receipt = row.message.receipt.advance(Receipt::Failed);
    out.push(Output::Persist(vec![StoreOp::PutPending(row.clone())]));
    out.push(Output::Event(changed(&row.message)));
    out.push(Output::Event(Event::ServerError {
        code: code.to_owned(),
        peer: Some(row.message.peer.clone()),
        id: Some(row.message.id.clone()),
    }));
}

/// Receipt precedence applies only to server-committed rows.
fn upgrade(message: &mut Outgoing, receipts: &PeerReceipts) {
    if receipts.read_ts.is_some_and(|ts| message.ts <= ts) {
        message.receipt = message.receipt.advance(Receipt::Read);
    } else if receipts.delivered_ts.is_some_and(|ts| message.ts <= ts) {
        message.receipt = message.receipt.advance(Receipt::Delivered);
    }
}
