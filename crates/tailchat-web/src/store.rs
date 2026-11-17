//! [`KvStore`]: the browser's [`Storage`], held in memory and mirrored record
//! by record into IndexedDB.
//!
//! Every op means what the reference `MemStore` says it means
//! (`tailchat-core/tests/common/mod.rs`; `tests/conformance.rs` runs both side
//! by side). What is different is durability: `apply` changes memory at once
//! and notes every record it touched; [`KvStore::take_journal`] hands those
//! records over, and the driver must see them committed to IndexedDB before
//! anything leaves the device (the next socket write or key POST waits for
//! that). A journal that does not commit [`poison`](KvStore::poison)s the
//! store: memory is then ahead of the disk, so the driver restarts from the
//! disk instead of trusting it.

use std::collections::{BTreeMap, BTreeSet};

use tailchat_core::{
    Backfill, Held, InboundRow, Login, Message, MessageId, OlmChannelRow, OutboundRow, Outgoing,
    OwedAck, OwnRead, PeerIdentity, PeerReceipts, PendingOutgoing, PendingToDevice, Protection,
    Reaction, Row, SealedRow, Secret, Sent, Seq, Snapshot, Storage, StoreOp, Ts,
};

use crate::codec::{self, Record};

/// What can go wrong. No variant carries message text or key material.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KvError {
    /// `StoreOp::SetAttempt` named a message that is not queued.
    #[error("retry metadata for a message that is not queued")]
    MissingPending,
    /// A record read back from IndexedDB breaks the type it holds.
    #[error("corrupt record: {0}")]
    Corrupt(&'static str),
    /// A journal did not commit: memory is ahead of the disk.
    #[error("the local store failed to commit; restart from disk")]
    Poisoned,
}

/// Where one record lives: the IndexedDB key, before it is spelled as text.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum RecKey {
    /// The feed cursor.
    Cursor,
    /// A queue row.
    Pending(Login, MessageId),
    /// A committed outgoing row.
    Sent(Login, MessageId),
    /// A conversation row.
    Message(Login, MessageId),
    /// A peer's delivery/read positions.
    Receipts(Login),
    /// A conversation's history debt.
    Backfill(Login),
    /// How far this account read a conversation.
    OwnRead(Login),
    /// The delivery receipt owed to a peer.
    Ack(Login),
    /// This device's Olm account.
    Account,
    /// An Olm channel.
    Olm(Login, String),
    /// A conversation's sending session.
    Outbound(Login),
    /// A reading session.
    Inbound(Login, String, String),
    /// A key message not yet accepted.
    ToDevice(String),
    /// A conversation that carried an encrypted message.
    Encrypted(Login),
    /// A peer account's master key.
    Identity(Login),
    /// The key backup secret.
    BackupKey,
}

impl RecKey {
    /// The IndexedDB key: a JSON array, so no part can run into the next.
    pub(crate) fn text(&self) -> String {
        let parts: Vec<&str> = match self {
            Self::Cursor => vec!["cursor"],
            Self::Pending(p, i) => vec!["pending", p.as_str(), i.as_str()],
            Self::Sent(p, i) => vec!["sent", p.as_str(), i.as_str()],
            Self::Message(p, i) => vec!["message", p.as_str(), i.as_str()],
            Self::Receipts(p) => vec!["receipts", p.as_str()],
            Self::Backfill(p) => vec!["backfill", p.as_str()],
            Self::OwnRead(p) => vec!["own_read", p.as_str()],
            Self::Ack(p) => vec!["ack", p.as_str()],
            Self::Account => vec!["account"],
            Self::Olm(l, d) => vec!["olm", l.as_str(), d],
            Self::Outbound(p) => vec!["outbound", p.as_str()],
            Self::Inbound(s, d, i) => vec!["inbound", s.as_str(), d, i],
            Self::ToDevice(id) => vec!["to_device", id],
            Self::Encrypted(p) => vec!["encrypted", p.as_str()],
            Self::Identity(p) => vec!["identity", p.as_str()],
            Self::BackupKey => vec!["backup_key"],
        };
        serde_json::Value::from(parts).to_string()
    }
}

/// A committed outgoing row and what it collected since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SentRow {
    /// Upsert order: `load` lists committed rows by it.
    pub(crate) ord: u64,
    /// The message and its rung.
    pub(crate) message: Outgoing,
    /// When another device of this account last edited it.
    pub(crate) edited_at: Option<Ts>,
    /// The reactions on it.
    pub(crate) reactions: Vec<Reaction>,
}

/// A queue row and its upsert order (the outbox's round-robin starts from it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingRow {
    /// Upsert order.
    pub(crate) ord: u64,
    /// The row.
    pub(crate) row: PendingOutgoing,
}

/// A key message and its queue position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToDeviceRow {
    /// Upsert order: the queue is sent oldest first.
    pub(crate) ord: u64,
    /// The message.
    pub(crate) row: PendingToDevice,
}

/// One message map per conversation.
type ByPeer<T> = BTreeMap<Login, BTreeMap<MessageId, T>>;

/// Everything the store holds.
#[derive(Debug, Clone, Default)]
pub(crate) struct Tables {
    pub(crate) cursor: Seq,
    pub(crate) pending: ByPeer<PendingRow>,
    pub(crate) sent: ByPeer<SentRow>,
    pub(crate) messages: ByPeer<Message>,
    pub(crate) receipts: BTreeMap<Login, PeerReceipts>,
    pub(crate) backfill: BTreeMap<Login, Backfill>,
    pub(crate) own_reads: BTreeMap<Login, OwnRead>,
    pub(crate) acks: BTreeMap<Login, OwedAck>,
    pub(crate) account: Option<Secret>,
    pub(crate) olm: BTreeMap<(Login, String), OlmChannelRow>,
    pub(crate) outbound: BTreeMap<Login, OutboundRow>,
    pub(crate) inbound: BTreeMap<(Login, String, String), InboundRow>,
    pub(crate) to_device: BTreeMap<String, ToDeviceRow>,
    pub(crate) encrypted: BTreeSet<Login>,
    pub(crate) identities: BTreeMap<Login, PeerIdentity>,
    pub(crate) backup_key: Option<Secret>,
}

/// One change for IndexedDB: the key, and the record's JSON (`None`: delete).
///
/// The JSON holds message text and secret pickles: the JavaScript side
/// encrypts it before it reaches the disk and never logs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    /// The record's key (a JSON array as text).
    pub key: String,
    /// The record (JSON text), or `None` when it is gone.
    pub value: Option<String>,
}

/// The browser's store of one account.
#[derive(Debug, Default)]
pub struct KvStore {
    /// What the store holds now.
    tables: Tables,
    /// Records changed since the last [`KvStore::take_journal`].
    dirty: BTreeSet<RecKey>,
    /// The next upsert order.
    next_ord: u64,
    /// A journal failed to commit.
    poisoned: bool,
}

/// `(peer, id)` of a message map, if present.
fn get<'a, T>(map: &'a ByPeer<T>, peer: &Login, id: &MessageId) -> Option<&'a T> {
    map.get(peer).and_then(|rows| rows.get(id))
}

/// `(peer, id)` of a message map, mutably.
fn get_mut<'a, T>(map: &'a mut ByPeer<T>, peer: &Login, id: &MessageId) -> Option<&'a mut T> {
    map.get_mut(peer).and_then(|rows| rows.get_mut(id))
}

/// Inserts `(peer, id)` into a message map.
fn put<T>(map: &mut ByPeer<T>, peer: &Login, id: &MessageId, value: T) {
    map.entry(peer.clone())
        .or_default()
        .insert(id.clone(), value);
}

/// Removes `(peer, id)` from a message map, and the conversation once empty.
fn take<T>(map: &mut ByPeer<T>, peer: &Login, id: &MessageId) -> Option<T> {
    let rows = map.get_mut(peer)?;
    let gone = rows.remove(id);
    if rows.is_empty() {
        map.remove(peer);
    }
    gone
}

/// One person's emoji on or off, exactly as `MemStore` does it.
fn react(reactions: &mut Vec<Reaction>, emoji: &str, by: &Login, add: bool) {
    match reactions.iter().position(|r| r.emoji == emoji) {
        Some(index) => {
            if let Some(entry) = reactions.get_mut(index) {
                entry.by.retain(|who| who != by);
                if add {
                    entry.by.push(by.clone());
                }
                if entry.by.is_empty() {
                    reactions.remove(index);
                }
            }
        }
        None if add => reactions.push(Reaction {
            emoji: emoji.to_owned(),
            by: vec![by.clone()],
        }),
        None => {}
    }
}

impl KvStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// A store from every record IndexedDB holds (the values only: each record
    /// carries its own key). The order of `values` does not matter.
    ///
    /// # Errors
    /// [`KvError::Corrupt`] when a record does not decode.
    pub fn from_records<'a>(values: impl IntoIterator<Item = &'a str>) -> Result<Self, KvError> {
        let mut store = Self::new();
        for value in values {
            let record = codec::decode(value)?;
            store.restore(record);
        }
        Ok(store)
    }

    /// Puts one decoded record back where it belongs.
    fn restore(&mut self, record: Record) {
        let t = &mut self.tables;
        let ord = match &record {
            Record::Pending(r) => Some(r.ord),
            Record::Sent(r) => Some(r.ord),
            Record::ToDevice(r) => Some(r.ord),
            _ => None,
        };
        if let Some(ord) = ord {
            self.next_ord = self.next_ord.max(ord.saturating_add(1));
        }
        match record {
            Record::Cursor(seq) => t.cursor = seq,
            Record::Pending(r) => {
                let (peer, id) = (r.row.message.peer.clone(), r.row.message.id.clone());
                put(&mut t.pending, &peer, &id, r);
            }
            Record::Sent(r) => {
                let (peer, id) = (r.message.peer.clone(), r.message.id.clone());
                put(&mut t.sent, &peer, &id, r);
            }
            Record::Message(m) => {
                let (peer, id) = (m.peer.clone(), m.id.clone());
                put(&mut t.messages, &peer, &id, *m);
            }
            Record::Receipts(r) => {
                t.receipts.insert(r.peer.clone(), r);
            }
            Record::Backfill(b) => {
                t.backfill.insert(b.peer.clone(), b);
            }
            Record::OwnRead(r) => {
                t.own_reads.insert(r.peer.clone(), r);
            }
            Record::Ack(a) => {
                t.acks.insert(a.peer.clone(), a);
            }
            Record::Account(s) => t.account = Some(s),
            Record::Olm(c) => {
                t.olm.insert((c.login.clone(), c.device.clone()), c);
            }
            Record::Outbound(g) => {
                t.outbound.insert(g.peer.clone(), g);
            }
            Record::Inbound(g) => {
                t.inbound
                    .insert((g.sender.clone(), g.device.clone(), g.session.clone()), g);
            }
            Record::ToDevice(r) => {
                t.to_device.insert(r.row.id.clone(), r);
            }
            Record::Encrypted(peer) => {
                t.encrypted.insert(peer);
            }
            Record::Identity(i) => {
                t.identities.insert(i.peer.clone(), i);
            }
            Record::BackupKey(s) => t.backup_key = Some(s),
        }
    }

    /// The record stored under `key` now, if any.
    fn record(&self, key: &RecKey) -> Option<Record> {
        let t = &self.tables;
        Some(match key {
            RecKey::Cursor => Record::Cursor(t.cursor),
            RecKey::Pending(p, i) => Record::Pending(get(&t.pending, p, i)?.clone()),
            RecKey::Sent(p, i) => Record::Sent(get(&t.sent, p, i)?.clone()),
            RecKey::Message(p, i) => Record::Message(Box::new(get(&t.messages, p, i)?.clone())),
            RecKey::Receipts(p) => Record::Receipts(t.receipts.get(p)?.clone()),
            RecKey::Backfill(p) => Record::Backfill(t.backfill.get(p)?.clone()),
            RecKey::OwnRead(p) => Record::OwnRead(t.own_reads.get(p)?.clone()),
            RecKey::Ack(p) => Record::Ack(t.acks.get(p)?.clone()),
            RecKey::Account => Record::Account(t.account.clone()?),
            RecKey::Olm(l, d) => Record::Olm(t.olm.get(&(l.clone(), d.clone()))?.clone()),
            RecKey::Outbound(p) => Record::Outbound(t.outbound.get(p)?.clone()),
            RecKey::Inbound(s, d, i) => {
                Record::Inbound(t.inbound.get(&(s.clone(), d.clone(), i.clone()))?.clone())
            }
            RecKey::ToDevice(id) => Record::ToDevice(t.to_device.get(id)?.clone()),
            RecKey::Encrypted(p) => Record::Encrypted(t.encrypted.get(p)?.clone()),
            RecKey::Identity(p) => Record::Identity(t.identities.get(p)?.clone()),
            RecKey::BackupKey => Record::BackupKey(t.backup_key.clone()?),
        })
    }

    /// Every record changed since the last call, in key order, as IndexedDB
    /// must write them: all in one transaction.
    pub fn take_journal(&mut self) -> Vec<JournalEntry> {
        let dirty = std::mem::take(&mut self.dirty);
        dirty
            .into_iter()
            .map(|key| JournalEntry {
                value: self.record(&key).map(|record| codec::encode(&record)),
                key: key.text(),
            })
            .collect()
    }

    /// Whether `apply` has changed anything not yet taken by `take_journal`.
    pub fn has_journal(&self) -> bool {
        !self.dirty.is_empty()
    }

    /// Every record the store holds, as `from_records` reads them back: for
    /// writing a fresh copy of the store (and for the tests).
    pub fn all_records(&self) -> Vec<JournalEntry> {
        let t = &self.tables;
        let mut keys = vec![RecKey::Cursor];
        for (peer, rows) in &t.pending {
            keys.extend(
                rows.keys()
                    .map(|id| RecKey::Pending(peer.clone(), id.clone())),
            );
        }
        for (peer, rows) in &t.sent {
            keys.extend(rows.keys().map(|id| RecKey::Sent(peer.clone(), id.clone())));
        }
        for (peer, rows) in &t.messages {
            keys.extend(
                rows.keys()
                    .map(|id| RecKey::Message(peer.clone(), id.clone())),
            );
        }
        keys.extend(t.receipts.keys().cloned().map(RecKey::Receipts));
        keys.extend(t.backfill.keys().cloned().map(RecKey::Backfill));
        keys.extend(t.own_reads.keys().cloned().map(RecKey::OwnRead));
        keys.extend(t.acks.keys().cloned().map(RecKey::Ack));
        keys.push(RecKey::Account);
        keys.extend(t.olm.keys().cloned().map(|(l, d)| RecKey::Olm(l, d)));
        keys.extend(t.outbound.keys().cloned().map(RecKey::Outbound));
        keys.extend(
            t.inbound
                .keys()
                .cloned()
                .map(|(s, d, i)| RecKey::Inbound(s, d, i)),
        );
        keys.extend(t.to_device.keys().cloned().map(RecKey::ToDevice));
        keys.extend(t.encrypted.iter().cloned().map(RecKey::Encrypted));
        keys.extend(t.identities.keys().cloned().map(RecKey::Identity));
        keys.push(RecKey::BackupKey);
        keys.into_iter()
            .filter_map(|key| {
                let record = self.record(&key)?;
                Some(JournalEntry {
                    key: key.text(),
                    value: Some(codec::encode(&record)),
                })
            })
            .collect()
    }

    /// A journal did not commit: memory is ahead of the disk from now on, and
    /// every `apply` and `load` refuses until the store is rebuilt from disk.
    pub fn poison(&mut self) {
        self.poisoned = true;
    }

    /// Whether a journal failed to commit.
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// The upsert order for a row written now.
    fn ord(&mut self) -> u64 {
        let ord = self.next_ord;
        self.next_ord = self.next_ord.saturating_add(1);
        ord
    }

    /// The only op that can fail is `SetAttempt` on a row that is not queued
    /// at that point of the batch; checking the queue keys first lets the
    /// batch then run without a way to fail halfway.
    fn check(&self, ops: &[StoreOp]) -> Result<(), KvError> {
        let mut added: BTreeSet<(&Login, &MessageId)> = BTreeSet::new();
        let mut removed: BTreeSet<(&Login, &MessageId)> = BTreeSet::new();
        for op in ops {
            match op {
                StoreOp::PutPending(row) => {
                    let key = (&row.message.peer, &row.message.id);
                    removed.remove(&key);
                    added.insert(key);
                }
                StoreOp::PutOutgoing(m) => {
                    let key = (&m.peer, &m.id);
                    added.remove(&key);
                    removed.insert(key);
                }
                StoreOp::DropPending { peer, id } => {
                    let key = (peer, id);
                    added.remove(&key);
                    removed.insert(key);
                }
                StoreOp::SetAttempt { peer, id, .. } => {
                    let key = (peer, id);
                    let queued = added.contains(&key)
                        || (!removed.contains(&key)
                            && get(&self.tables.pending, peer, id).is_some());
                    if !queued {
                        return Err(KvError::MissingPending);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// One op, which cannot fail once `check` passed.
    fn apply_one(&mut self, op: &StoreOp) {
        match op {
            StoreOp::PutOutgoing(m) => {
                if take(&mut self.tables.pending, &m.peer, &m.id).is_some() {
                    self.dirty
                        .insert(RecKey::Pending(m.peer.clone(), m.id.clone()));
                }
                let ord = self.ord();
                let (edited_at, reactions) = match get(&self.tables.sent, &m.peer, &m.id) {
                    Some(old) => (old.edited_at, old.reactions.clone()),
                    None => (None, Vec::new()),
                };
                let row = SentRow {
                    ord,
                    message: m.clone(),
                    edited_at,
                    reactions,
                };
                put(&mut self.tables.sent, &m.peer, &m.id, row);
                self.dirty
                    .insert(RecKey::Sent(m.peer.clone(), m.id.clone()));
            }
            StoreOp::PutPending(row) => {
                let ord = self.ord();
                let (peer, id) = (&row.message.peer, &row.message.id);
                let value = PendingRow {
                    ord,
                    row: row.clone(),
                };
                put(&mut self.tables.pending, peer, id, value);
                self.dirty.insert(RecKey::Pending(peer.clone(), id.clone()));
            }
            StoreOp::DropPending { peer, id } => {
                if take(&mut self.tables.pending, peer, id).is_some() {
                    self.dirty.insert(RecKey::Pending(peer.clone(), id.clone()));
                }
            }
            StoreOp::SetAttempt {
                peer,
                id,
                attempts,
                next_attempt_at,
            } => {
                if let Some(r) = get_mut(&mut self.tables.pending, peer, id) {
                    r.row.attempts = *attempts;
                    r.row.next_attempt_at = *next_attempt_at;
                    self.dirty.insert(RecKey::Pending(peer.clone(), id.clone()));
                }
            }
            StoreOp::PutPeerReceipts(r) => {
                self.tables.receipts.insert(r.peer.clone(), r.clone());
                self.dirty.insert(RecKey::Receipts(r.peer.clone()));
            }
            StoreOp::SetCursor(seq) => {
                self.tables.cursor = *seq;
                self.dirty.insert(RecKey::Cursor);
            }
            StoreOp::PutMessage(m) => {
                put(&mut self.tables.messages, &m.peer, &m.id, (**m).clone());
                self.dirty
                    .insert(RecKey::Message(m.peer.clone(), m.id.clone()));
            }
            StoreOp::EditMessage {
                peer,
                id,
                text,
                edited_at,
            } => {
                if let Some(m) = get_mut(&mut self.tables.messages, peer, id) {
                    if m.protection == Protection::Plain {
                        m.text.clone_from(text);
                        m.edited_at = *edited_at;
                        self.dirty.insert(RecKey::Message(peer.clone(), id.clone()));
                    }
                } else if let Some(s) = get_mut(&mut self.tables.sent, peer, id) {
                    s.message.text.clone_from(text);
                    if let Some(at) = edited_at {
                        s.edited_at = Some(*at);
                    }
                    self.dirty.insert(RecKey::Sent(peer.clone(), id.clone()));
                }
            }
            StoreOp::SealedEdit {
                peer,
                id,
                author,
                mine,
                text,
                edited_at,
            } => {
                if let Some(m) = get_mut(&mut self.tables.messages, peer, id) {
                    if &m.from == author && !matches!(m.protection, Protection::Sealed { .. }) {
                        m.text.clone_from(text);
                        m.edited_at = Some(*edited_at);
                        self.dirty.insert(RecKey::Message(peer.clone(), id.clone()));
                    }
                } else if *mine && let Some(s) = get_mut(&mut self.tables.sent, peer, id) {
                    s.message.text.clone_from(text);
                    s.edited_at = Some(*edited_at);
                    self.dirty.insert(RecKey::Sent(peer.clone(), id.clone()));
                }
            }
            StoreOp::SetReaction {
                peer,
                id,
                emoji,
                by,
                add,
            } => {
                if let Some(m) = get_mut(&mut self.tables.messages, peer, id) {
                    react(&mut m.reactions, emoji, by, *add);
                    self.dirty.insert(RecKey::Message(peer.clone(), id.clone()));
                } else if let Some(s) = get_mut(&mut self.tables.sent, peer, id) {
                    react(&mut s.reactions, emoji, by, *add);
                    self.dirty.insert(RecKey::Sent(peer.clone(), id.clone()));
                }
            }
            StoreOp::PutReactions {
                peer,
                id,
                reactions,
            } => {
                if let Some(m) = get_mut(&mut self.tables.messages, peer, id) {
                    m.reactions.clone_from(reactions);
                    self.dirty.insert(RecKey::Message(peer.clone(), id.clone()));
                } else if let Some(s) = get_mut(&mut self.tables.sent, peer, id) {
                    s.reactions.clone_from(reactions);
                    self.dirty.insert(RecKey::Sent(peer.clone(), id.clone()));
                }
            }
            StoreOp::RemoveMessages { peer, ids } => {
                for id in ids {
                    if take(&mut self.tables.messages, peer, id).is_some() {
                        self.dirty.insert(RecKey::Message(peer.clone(), id.clone()));
                    }
                    if take(&mut self.tables.sent, peer, id).is_some() {
                        self.dirty.insert(RecKey::Sent(peer.clone(), id.clone()));
                    }
                }
            }
            StoreOp::PutBackfill(b) => {
                self.tables.backfill.insert(b.peer.clone(), b.clone());
                self.dirty.insert(RecKey::Backfill(b.peer.clone()));
            }
            StoreOp::DropBackfill(peer) => {
                if self.tables.backfill.remove(peer).is_some() {
                    self.dirty.insert(RecKey::Backfill(peer.clone()));
                }
            }
            StoreOp::PutOwnRead(r) => {
                self.tables.own_reads.insert(r.peer.clone(), r.clone());
                self.dirty.insert(RecKey::OwnRead(r.peer.clone()));
            }
            StoreOp::PutAck(a) => {
                self.tables.acks.insert(a.peer.clone(), a.clone());
                self.dirty.insert(RecKey::Ack(a.peer.clone()));
            }
            StoreOp::DropAck(peer) => {
                if self.tables.acks.remove(peer).is_some() {
                    self.dirty.insert(RecKey::Ack(peer.clone()));
                }
            }
            StoreOp::Unseal(m) => {
                if let Some(row) = get_mut(&mut self.tables.messages, &m.peer, &m.id) {
                    row.text.clone_from(&m.text);
                    row.author.clone_from(&m.author);
                    row.image.clone_from(&m.image);
                    row.voice.clone_from(&m.voice);
                    row.reply_to.clone_from(&m.reply_to);
                    row.forwarded_from.clone_from(&m.forwarded_from);
                    row.buttons.clone_from(&m.buttons);
                    row.edit_of.clone_from(&m.edit_of);
                    row.protection.clone_from(&m.protection);
                    self.dirty
                        .insert(RecKey::Message(m.peer.clone(), m.id.clone()));
                }
            }
            StoreOp::PutCryptoAccount(pickle) => {
                self.tables.account = Some(pickle.clone());
                self.dirty.insert(RecKey::Account);
            }
            StoreOp::PutOlmChannel(c) => {
                let key = (c.login.clone(), c.device.clone());
                self.tables.olm.insert(key, c.clone());
                self.dirty
                    .insert(RecKey::Olm(c.login.clone(), c.device.clone()));
            }
            StoreOp::PutOutboundGroup(g) => {
                self.tables.outbound.insert(g.peer.clone(), g.clone());
                self.dirty.insert(RecKey::Outbound(g.peer.clone()));
            }
            StoreOp::PutInboundGroup(g) => {
                let key = (g.sender.clone(), g.device.clone(), g.session.clone());
                self.tables.inbound.insert(key, g.clone());
                self.dirty.insert(RecKey::Inbound(
                    g.sender.clone(),
                    g.device.clone(),
                    g.session.clone(),
                ));
            }
            StoreOp::PutToDevice(t) => {
                let ord = self.ord();
                let row = ToDeviceRow {
                    ord,
                    row: t.clone(),
                };
                self.tables.to_device.insert(t.id.clone(), row);
                self.dirty.insert(RecKey::ToDevice(t.id.clone()));
            }
            StoreOp::DropToDevice(id) => {
                if self.tables.to_device.remove(id).is_some() {
                    self.dirty.insert(RecKey::ToDevice(id.clone()));
                }
            }
            StoreOp::MarkEncrypted(peer) => {
                if self.tables.encrypted.insert(peer.clone()) {
                    self.dirty.insert(RecKey::Encrypted(peer.clone()));
                }
            }
            StoreOp::PutPeerIdentity(identity) => {
                self.tables
                    .identities
                    .insert(identity.peer.clone(), identity.clone());
                self.dirty.insert(RecKey::Identity(identity.peer.clone()));
            }
            StoreOp::PutBackupKey(pickle) => {
                self.tables.backup_key = Some(pickle.clone());
                self.dirty.insert(RecKey::BackupKey);
            }
        }
    }

    /// The conversation row `(peer, id)`, as `Event::MessageStored` asks the
    /// UI to re-read it.
    pub fn message(&self, peer: &Login, id: &MessageId) -> Option<Message> {
        get(&self.tables.messages, peer, id).cloned()
    }

    /// The committed outgoing row `(peer, id)`.
    pub fn sent(&self, peer: &Login, id: &MessageId) -> Option<Sent> {
        get(&self.tables.sent, peer, id).map(|s| Sent {
            message: s.message.clone(),
            edited_at: s.edited_at,
            reactions: s.reactions.clone(),
        })
    }

    /// The newest `limit` rows strictly older than `before` by `(ts, id)`,
    /// oldest first. A committed row wins over a conversation row, which wins
    /// over a queue row (as `SqliteStore::conversation`).
    pub fn conversation(
        &self,
        peer: &Login,
        before: Option<(Ts, &MessageId)>,
        limit: usize,
    ) -> Vec<Row> {
        if limit == 0 {
            return Vec::new();
        }
        let t = &self.tables;
        let older = |ts: Ts, id: &MessageId| before.is_none_or(|(bts, bid)| (ts, id) < (bts, bid));
        let mut rows: Vec<(Ts, MessageId, Row)> = Vec::new();
        let sent = t.sent.get(peer);
        let messages = t.messages.get(peer);
        let held_sent = |id: &MessageId| sent.is_some_and(|rows| rows.contains_key(id));
        let held_message = |id: &MessageId| messages.is_some_and(|rows| rows.contains_key(id));
        for (id, s) in sent.into_iter().flatten() {
            if older(s.message.ts, id) {
                let row = Row::Sent(Sent {
                    message: s.message.clone(),
                    edited_at: s.edited_at,
                    reactions: s.reactions.clone(),
                });
                rows.push((s.message.ts, id.clone(), row));
            }
        }
        for (id, m) in messages.into_iter().flatten() {
            if !held_sent(id) && older(m.ts, id) {
                rows.push((m.ts, id.clone(), Row::Message(m.clone())));
            }
        }
        for (id, p) in t.pending.get(peer).into_iter().flatten() {
            if !held_sent(id) && !held_message(id) && older(p.row.message.ts, id) {
                rows.push((p.row.message.ts, id.clone(), Row::Pending(p.row.clone())));
            }
        }
        rows.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        let skip = rows.len().saturating_sub(limit);
        rows.into_iter().skip(skip).map(|(_, _, row)| row).collect()
    }

    /// Every conversation the store holds a row of.
    pub fn peers(&self) -> Vec<Login> {
        let t = &self.tables;
        let mut peers: BTreeSet<Login> = BTreeSet::new();
        peers.extend(t.messages.keys().cloned());
        peers.extend(t.sent.keys().cloned());
        peers.extend(t.pending.keys().cloned());
        peers.into_iter().collect()
    }
}

impl Storage for KvStore {
    type Error = KvError;

    fn apply(&mut self, ops: &[StoreOp]) -> Result<(), KvError> {
        if self.poisoned {
            return Err(KvError::Poisoned);
        }
        self.check(ops)?;
        for op in ops {
            self.apply_one(op);
        }
        Ok(())
    }

    fn load(&self) -> Result<Snapshot, KvError> {
        if self.poisoned {
            return Err(KvError::Poisoned);
        }
        let t = &self.tables;
        let mut pending: Vec<&PendingRow> = t.pending.values().flat_map(BTreeMap::values).collect();
        pending.sort_by_key(|r| r.ord);
        let mut sent: Vec<&SentRow> = t.sent.values().flat_map(BTreeMap::values).collect();
        sent.sort_by_key(|r| r.ord);
        let mut to_device: Vec<&ToDeviceRow> = t.to_device.values().collect();
        to_device.sort_by_key(|r| r.ord);
        let messages = || t.messages.values().flat_map(BTreeMap::values);
        let held = messages()
            .map(|m| Held {
                peer: m.peer.clone(),
                id: m.id.clone(),
                edited_at: m.edited_at,
            })
            .chain(sent.iter().map(|s| Held {
                peer: s.message.peer.clone(),
                id: s.message.id.clone(),
                edited_at: s.edited_at,
            }))
            .collect();
        let sealed = messages()
            .filter_map(|m| match &m.protection {
                Protection::Sealed {
                    envelope,
                    waiting: true,
                } => Some(SealedRow {
                    peer: m.peer.clone(),
                    id: m.id.clone(),
                    from: m.from.clone(),
                    ts: m.ts,
                    kind: m.kind,
                    envelope: envelope.clone(),
                }),
                _ => None,
            })
            .collect();
        Ok(Snapshot {
            cursor: t.cursor,
            pending: pending.into_iter().map(|r| r.row.clone()).collect(),
            sent: sent.iter().map(|r| r.message.clone()).collect(),
            receipts: t.receipts.values().cloned().collect(),
            held,
            backfill: t.backfill.values().cloned().collect(),
            own_reads: t.own_reads.values().cloned().collect(),
            acks: t.acks.values().cloned().collect(),
            crypto_account: t.account.clone(),
            olm_channels: t.olm.values().cloned().collect(),
            outbound_groups: t.outbound.values().cloned().collect(),
            inbound_groups: t.inbound.values().cloned().collect(),
            to_device: to_device.into_iter().map(|r| r.row.clone()).collect(),
            encrypted: t.encrypted.iter().cloned().collect(),
            sealed,
            peer_identities: t.identities.values().cloned().collect(),
            backup_key: t.backup_key.clone(),
        })
    }
}
