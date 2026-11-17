//! An in-memory `Storage` that applies every `StoreOp` the way the contract
//! in `api.rs` describes it. Shared by the integration tests.

#![cfg(test)]
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::io;

use tailchat_core::{
    Held, Login, Message, MessageId, Outgoing, Protection, Reaction, SealedRow, Snapshot, Storage,
    StoreOp, Ts,
};

/// A message key.
pub type Key = (Login, MessageId);

/// Everything a real store would keep.
#[derive(Debug, Clone, Default)]
pub struct MemStore {
    /// Cursor, queue, committed rows, receipts, debt, own reads, owed acks.
    pub snapshot: Snapshot,
    /// Conversation rows with their bodies.
    pub messages: BTreeMap<Key, Message>,
    /// Edit times of committed outgoing rows.
    pub sent_edits: HashMap<Key, Ts>,
    /// Reactions on committed outgoing rows.
    pub sent_reactions: HashMap<Key, Vec<Reaction>>,
    /// The next `apply` fails without changing anything.
    pub fail: bool,
}

fn same(m: &Outgoing, peer: &Login, id: &MessageId) -> bool {
    m.peer == *peer && m.id == *id
}

fn react(reactions: &mut Vec<Reaction>, emoji: &str, by: &Login, add: bool) {
    match reactions.iter_mut().position(|r| r.emoji == emoji) {
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

impl MemStore {
    fn apply_one(&mut self, op: &StoreOp) -> io::Result<()> {
        let snap = &mut self.snapshot;
        match op {
            StoreOp::PutOutgoing(m) => {
                snap.pending.retain(|r| !same(&r.message, &m.peer, &m.id));
                snap.sent.retain(|old| !same(old, &m.peer, &m.id));
                snap.sent.push(m.clone());
            }
            StoreOp::PutPending(row) => {
                snap.pending
                    .retain(|r| !same(&r.message, &row.message.peer, &row.message.id));
                snap.pending.push(row.clone());
            }
            StoreOp::DropPending { peer, id } => {
                snap.pending.retain(|r| !same(&r.message, peer, id));
            }
            StoreOp::SetAttempt {
                peer,
                id,
                attempts,
                next_attempt_at,
            } => {
                let row = snap
                    .pending
                    .iter_mut()
                    .find(|r| same(&r.message, peer, id))
                    .ok_or_else(|| io::Error::other("attempt without pending row"))?;
                row.attempts = *attempts;
                row.next_attempt_at = *next_attempt_at;
            }
            StoreOp::PutPeerReceipts(r) => {
                snap.receipts.retain(|old| old.peer != r.peer);
                snap.receipts.push(r.clone());
            }
            StoreOp::SetCursor(seq) => snap.cursor = *seq,
            StoreOp::PutMessage(m) => {
                self.messages
                    .insert((m.peer.clone(), m.id.clone()), (**m).clone());
            }
            StoreOp::EditMessage {
                peer,
                id,
                text,
                edited_at,
            } => {
                let key = (peer.clone(), id.clone());
                if let Some(m) = self.messages.get_mut(&key) {
                    if m.protection == Protection::Plain {
                        m.text.clone_from(text);
                        m.edited_at = *edited_at;
                    }
                } else if let Some(m) = snap.sent.iter_mut().find(|m| same(m, peer, id)) {
                    m.text.clone_from(text);
                    if let Some(at) = edited_at {
                        self.sent_edits.insert(key, *at);
                    }
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
                let key = (peer.clone(), id.clone());
                if let Some(m) = self.messages.get_mut(&key) {
                    if &m.from == author && !matches!(m.protection, Protection::Sealed { .. }) {
                        m.text.clone_from(text);
                        m.edited_at = Some(*edited_at);
                    }
                } else if *mine
                    && let Some(m) = snap.sent.iter_mut().find(|m| same(m, peer, id))
                {
                    m.text.clone_from(text);
                    self.sent_edits.insert(key, *edited_at);
                }
            }
            StoreOp::SetReaction {
                peer,
                id,
                emoji,
                by,
                add,
            } => {
                let key = (peer.clone(), id.clone());
                if let Some(m) = self.messages.get_mut(&key) {
                    react(&mut m.reactions, emoji, by, *add);
                } else if snap.sent.iter().any(|m| same(m, peer, id)) {
                    react(self.sent_reactions.entry(key).or_default(), emoji, by, *add);
                }
            }
            StoreOp::PutReactions {
                peer,
                id,
                reactions,
            } => {
                let key = (peer.clone(), id.clone());
                if let Some(m) = self.messages.get_mut(&key) {
                    m.reactions.clone_from(reactions);
                } else if snap.sent.iter().any(|m| same(m, peer, id)) {
                    self.sent_reactions.insert(key, reactions.clone());
                }
            }
            StoreOp::RemoveMessages { peer, ids } => {
                for id in ids {
                    let key = (peer.clone(), id.clone());
                    self.messages.remove(&key);
                    self.sent_edits.remove(&key);
                    self.sent_reactions.remove(&key);
                    snap.sent.retain(|m| !same(m, peer, id));
                }
            }
            StoreOp::PutBackfill(b) => {
                snap.backfill.retain(|old| old.peer != b.peer);
                snap.backfill.push(b.clone());
            }
            StoreOp::DropBackfill(peer) => snap.backfill.retain(|old| old.peer != *peer),
            StoreOp::PutOwnRead(r) => {
                snap.own_reads.retain(|old| old.peer != r.peer);
                snap.own_reads.push(r.clone());
            }
            StoreOp::PutAck(a) => {
                snap.acks.retain(|old| old.peer != a.peer);
                snap.acks.push(a.clone());
            }
            StoreOp::DropAck(peer) => snap.acks.retain(|old| old.peer != *peer),
            StoreOp::Unseal(m) => {
                if let Some(row) = self.messages.get_mut(&(m.peer.clone(), m.id.clone())) {
                    row.text.clone_from(&m.text);
                    row.author.clone_from(&m.author);
                    row.image.clone_from(&m.image);
                    row.voice.clone_from(&m.voice);
                    row.reply_to.clone_from(&m.reply_to);
                    row.forwarded_from.clone_from(&m.forwarded_from);
                    row.buttons.clone_from(&m.buttons);
                    row.edit_of.clone_from(&m.edit_of);
                    row.protection.clone_from(&m.protection);
                }
            }
            StoreOp::PutCryptoAccount(pickle) => snap.crypto_account = Some(pickle.clone()),
            StoreOp::PutOlmChannel(c) => {
                snap.olm_channels
                    .retain(|old| (&old.login, &old.device) != (&c.login, &c.device));
                snap.olm_channels.push(c.clone());
            }
            StoreOp::PutOutboundGroup(g) => {
                snap.outbound_groups.retain(|old| old.peer != g.peer);
                snap.outbound_groups.push(g.clone());
            }
            StoreOp::PutInboundGroup(g) => {
                snap.inbound_groups.retain(|old| {
                    (&old.sender, &old.device, &old.session) != (&g.sender, &g.device, &g.session)
                });
                snap.inbound_groups.push(g.clone());
            }
            StoreOp::PutToDevice(t) => {
                snap.to_device.retain(|old| old.id != t.id);
                snap.to_device.push(t.clone());
            }
            StoreOp::DropToDevice(id) => snap.to_device.retain(|old| old.id != *id),
            StoreOp::MarkEncrypted(peer) => {
                if !snap.encrypted.contains(peer) {
                    snap.encrypted.push(peer.clone());
                }
            }
            StoreOp::PutPeerIdentity(identity) => {
                snap.peer_identities.retain(|old| old.peer != identity.peer);
                snap.peer_identities.push(identity.clone());
            }
            StoreOp::PutBackupKey(pickle) => snap.backup_key = Some(pickle.clone()),
        }
        Ok(())
    }

    /// The row with this key, if held.
    pub fn message(&self, peer: &str, id: &str) -> Option<&Message> {
        self.messages
            .get(&(Login::parse(peer).unwrap(), MessageId::parse(id).unwrap()))
    }

    /// Every held row of one conversation, oldest first.
    pub fn conversation(&self, peer: &str) -> Vec<&Message> {
        let peer = Login::parse(peer).unwrap();
        let mut rows: Vec<&Message> = self.messages.values().filter(|m| m.peer == peer).collect();
        rows.sort_by(|a, b| (a.ts, &a.id).cmp(&(b.ts, &b.id)));
        rows
    }
}

impl Storage for MemStore {
    type Error = io::Error;

    fn load(&self) -> io::Result<Snapshot> {
        let mut snapshot = self.snapshot.clone();
        snapshot.held = self
            .messages
            .values()
            .map(|m| Held {
                peer: m.peer.clone(),
                id: m.id.clone(),
                edited_at: m.edited_at,
            })
            .chain(self.snapshot.sent.iter().map(|m| {
                Held {
                    peer: m.peer.clone(),
                    id: m.id.clone(),
                    edited_at: self
                        .sent_edits
                        .get(&(m.peer.clone(), m.id.clone()))
                        .copied(),
                }
            }))
            .collect();
        snapshot.sealed = self
            .messages
            .values()
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
        Ok(snapshot)
    }

    fn apply(&mut self, ops: &[StoreOp]) -> io::Result<()> {
        if std::mem::take(&mut self.fail) {
            return Err(io::Error::other("disk unavailable"));
        }
        let mut next = self.clone();
        for op in ops {
            next.apply_one(op)?;
        }
        *self = next;
        Ok(())
    }
}
