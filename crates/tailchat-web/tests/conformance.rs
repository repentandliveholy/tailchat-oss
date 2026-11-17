//! `KvStore` against the reference `MemStore`: the same random batches go into
//! both, and after every batch both must agree on the outcome, the `Snapshot`
//! and every row a UI could re-read. Every few batches the store is rebuilt
//! from nothing but the records its journals wrote, as a page reload would.
//!
//! The generator is `tailchat-store/tests/conformance.rs`'s, kept identical so
//! the two stores are held to the same batches.

#![cfg(test)]

#[path = "../../tailchat-core/tests/common/mod.rs"]
mod common;

use common::MemStore;
use std::collections::BTreeMap;
use tailchat_core::frames::inner::{Button, Forwarded, Image, MediaKind, Reply, Voice};
use tailchat_core::{
    Backfill, Below, Envelope, InboundRow, Login, Message, MessageId, MessageKind, OlmChannelRow,
    OutboundRow, Outgoing, OwedAck, OwnRead, PeerIdentity, PeerReceipts, PendingOutgoing,
    PendingToDevice, Protection, Reaction, Receipt, Seal, Secret, Seq, Snapshot, Storage, StoreOp,
    Ts, WalkFrom,
};

use tailchat_core::Sent;
use tailchat_web::KvStore;
use zeroize::Zeroizing;

const PEERS: [&str; 3] = ["bob", "carol", "dave"];
/// Every key an op may name. Conversation rows and committed rows overlap on
/// `m4`/`m5` only, so both "edit the conversation row first" and "edit a
/// committed row" are exercised.
const IDS: [&str; 8] = ["m1", "m2", "m3", "m4", "m5", "s1", "s2", "s3"];
const MESSAGE_IDS: [&str; 5] = ["m1", "m2", "m3", "m4", "m5"];
const SENT_IDS: [&str; 5] = ["m4", "m5", "s1", "s2", "s3"];
const PEOPLE: [&str; 4] = ["bob", "carol", "dave", "me.self"];
const TEXTS: [&str; 5] = ["", "hi", "привет", "nul\u{0}inside", "😀 emoji"];
/// Pictures a row may carry: the same bytes in two of the allowed types.
const IMAGES: [&str; 2] = ["data:image/png;base64,AAAA", "data:image/webp;base64,AA=="];
const EMOJI: [&str; 3] = ["👍", "❤️", "😂"];
const DEVICES: [&str; 2] = ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"];
const SESSIONS: [&str; 2] = ["s+1", "s/2"];
const TO_DEVICE_IDS: [&str; 3] = ["td-1", "td-2", "td-3"];

/// xorshift64*: deterministic, so a failure names its seed and replays.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n).unwrap()).unwrap()
    }
    fn coin(&mut self) -> bool {
        self.next() & 1 == 1
    }
    fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
    fn login(&mut self, items: &[&str]) -> Login {
        Login::parse(items[self.below(items.len())]).unwrap()
    }
    fn id(&mut self) -> MessageId {
        MessageId::parse(self.pick(&IDS)).unwrap()
    }
    fn message_id(&mut self) -> MessageId {
        MessageId::parse(self.pick(&MESSAGE_IDS)).unwrap()
    }
    fn sent_id(&mut self) -> MessageId {
        MessageId::parse(self.pick(&SENT_IDS)).unwrap()
    }
    fn ts(&mut self) -> Ts {
        Ts([0, 1, 1_700_000_000_000, i64::MAX, i64::MIN][self.below(5)])
    }
    fn maybe_ts(&mut self) -> Option<Ts> {
        self.coin().then(|| self.ts())
    }
    fn text(&mut self) -> String {
        self.pick(&TEXTS).to_owned()
    }
    fn receipt(&mut self) -> Receipt {
        [
            Receipt::Queued,
            Receipt::Sent,
            Receipt::Delivered,
            Receipt::Read,
            Receipt::Failed,
        ][self.below(5)]
    }
    fn outgoing(&mut self) -> Outgoing {
        Outgoing {
            extra: Default::default(),
            id: self.sent_id(),
            peer: self.login(&PEERS),
            ts: self.ts(),
            text: self.text(),
            image: self.coin().then(|| Image {
                data_url: self.pick(&IMAGES).to_owned(),
                width: self.coin().then_some(640),
                height: self.coin().then_some(0),
            }),
            receipt: self.receipt(),
        }
    }
    fn reactions(&mut self) -> Vec<Reaction> {
        let mut out = Vec::new();
        for emoji in EMOJI {
            if self.coin() {
                let mut by = vec![self.login(&PEOPLE)];
                let other = self.login(&PEOPLE);
                if !by.contains(&other) {
                    by.push(other);
                }
                out.push(Reaction {
                    emoji: emoji.to_owned(),
                    by,
                });
            }
        }
        out
    }
    fn message(&mut self) -> Message {
        let peer = self.login(&PEERS);
        Message {
            edit_of: self.coin().then(|| MessageId::parse("m-edited").unwrap()),
            from: if self.coin() {
                peer.clone()
            } else {
                Login::parse("me.self").unwrap()
            },
            peer,
            id: self.message_id(),
            ts: self.ts(),
            kind: if self.coin() {
                MessageKind::Human
            } else {
                MessageKind::Ai
            },
            text: self.text(),
            author: self.coin().then(|| self.text()),
            image: self.coin().then(|| Image {
                data_url: "data:image/png;base64,AAAA".to_owned(),
                width: self.coin().then_some(640),
                height: self.coin().then_some(-1),
            }),
            voice: self.coin().then(|| Voice {
                waveform: None,
                data_url: "data:audio/webm;base64,BBBB".to_owned(),
                duration: self.coin().then_some(3.25),
            }),
            reply_to: self.coin().then(|| Reply {
                id: self.id(),
                from: self.login(&PEOPLE),
                text: self.text(),
                media: [
                    None,
                    Some(MediaKind::Image),
                    Some(MediaKind::Voice),
                    Some(MediaKind::File),
                ][self.below(4)],
            }),
            forwarded_from: self.coin().then(|| Forwarded {
                login: self.coin().then(|| self.login(&PEOPLE)),
                name: self.coin().then(|| self.text()),
            }),
            buttons: (0..self.below(3))
                .map(|n| Button {
                    id: format!("b{n}"),
                    label: self.text(),
                    value: self.text(),
                })
                .collect(),
            media_dropped: self.coin(),
            edited_at: self.maybe_ts(),
            reactions: self.reactions(),
            protection: self.protection(),
        }
    }
    fn envelope(&mut self) -> Envelope {
        Envelope {
            dev: self.pick(&DEVICES).to_owned(),
            sid: self.pick(&SESSIONS).to_owned(),
            ct: self.pick(&["AwgAEi", "AwgBEj", ""]).to_owned(),
        }
    }
    fn protection(&mut self) -> Protection {
        match self.below(4) {
            0 => Protection::Plain,
            1 => Protection::Encrypted,
            _ => Protection::Sealed {
                envelope: self.envelope(),
                waiting: self.coin(),
            },
        }
    }
    fn seal(&mut self) -> Seal {
        match self.below(3) {
            0 => Seal::Undecided,
            1 => Seal::Plain,
            _ => Seal::Encrypted(self.envelope()),
        }
    }
    fn secret(&mut self) -> Secret {
        Secret::new(Zeroizing::new(
            self.pick(&["{\"v\":1,\"p\":1}", "{\"v\":1,\"p\":2}", "ключ"])
                .to_owned(),
        ))
    }
    /// The ops end-to-end encryption added (sub-stage 6c).
    fn crypto_op(&mut self) -> StoreOp {
        match self.below(10) {
            0 => {
                let mut message = self.message();
                // Unseal names conversation rows; about half of them exist.
                message.id = self.message_id();
                StoreOp::Unseal(Box::new(message))
            }
            1 => StoreOp::PutCryptoAccount(self.secret()),
            2 => StoreOp::PutOlmChannel(OlmChannelRow {
                login: self.login(&PEOPLE),
                device: self.pick(&DEVICES).to_owned(),
                pickle: self.secret(),
            }),
            3 => StoreOp::PutOutboundGroup(OutboundRow {
                peer: self.login(&PEOPLE),
                pickle: self.secret(),
            }),
            4 => StoreOp::PutInboundGroup(InboundRow {
                sender: self.login(&PEOPLE),
                device: self.pick(&DEVICES).to_owned(),
                session: self.pick(&SESSIONS).to_owned(),
                pickle: self.secret(),
            }),
            5 => StoreOp::PutToDevice(PendingToDevice {
                id: self.pick(&TO_DEVICE_IDS).to_owned(),
                to: self.login(&PEOPLE),
                device: self.pick(&DEVICES).to_owned(),
                body: self.text(),
            }),
            6 => StoreOp::DropToDevice(self.pick(&TO_DEVICE_IDS).to_owned()),
            7 => StoreOp::MarkEncrypted(self.login(&PEOPLE)),
            8 => StoreOp::PutPeerIdentity(PeerIdentity {
                peer: self.login(&PEOPLE),
                master_key: self.pick(&DEVICES).to_owned(),
                verified: self.coin(),
            }),
            _ => StoreOp::PutBackupKey(self.secret()),
        }
    }
    fn walk(&mut self) -> Option<WalkFrom> {
        match self.below(3) {
            0 => None,
            1 => Some(WalkFrom::Newest),
            _ => Some(WalkFrom::Below(Below {
                id: self.id(),
                ts: self.ts(),
            })),
        }
    }
    fn op(&mut self) -> StoreOp {
        match self.below(20) {
            0 => StoreOp::PutOutgoing(self.outgoing()),
            1 => StoreOp::PutPending(PendingOutgoing {
                message: self.outgoing(),
                attempts: [0, 1, 8, 255][self.below(4)],
                next_attempt_at: self.ts(),
                seal: self.seal(),
            }),
            2 => StoreOp::SetAttempt {
                peer: self.login(&PEERS),
                id: self.sent_id(),
                attempts: [0, 3, 255][self.below(3)],
                next_attempt_at: self.ts(),
            },
            19 => StoreOp::DropPending {
                peer: self.login(&PEERS),
                id: self.sent_id(),
            },
            3 => StoreOp::PutPeerReceipts(PeerReceipts {
                peer: self.login(&PEERS),
                delivered_ts: self.maybe_ts(),
                read_ts: self.maybe_ts(),
            }),
            4 => StoreOp::SetCursor(Seq(self.ts().0)),
            5 | 6 => StoreOp::PutMessage(Box::new(self.message())),
            7 => StoreOp::EditMessage {
                peer: self.login(&PEERS),
                id: self.id(),
                text: self.text(),
                edited_at: self.maybe_ts(),
            },
            8 => StoreOp::SetReaction {
                peer: self.login(&PEERS),
                id: self.id(),
                emoji: self.pick(&EMOJI).to_owned(),
                by: self.login(&PEOPLE),
                add: self.coin(),
            },
            9 => StoreOp::PutReactions {
                peer: self.login(&PEERS),
                id: self.id(),
                reactions: self.reactions(),
            },
            10 => StoreOp::RemoveMessages {
                peer: self.login(&PEERS),
                ids: (0..self.below(3)).map(|_| self.id()).collect(),
            },
            11 => StoreOp::PutBackfill(Backfill {
                peer: self.login(&PEERS),
                owed: (0..self.below(4)).map(|_| self.id()).collect(),
                reseed: self.walk(),
            }),
            12 => {
                if self.coin() {
                    StoreOp::DropBackfill(self.login(&PEERS))
                } else {
                    StoreOp::DropAck(self.login(&PEERS))
                }
            }
            13 => StoreOp::PutOwnRead(OwnRead {
                peer: self.login(&PEERS),
                read_ts: self.ts(),
            }),
            14 => StoreOp::PutAck(OwedAck {
                peer: self.login(&PEERS),
                id: self.id(),
                ts: self.ts(),
            }),
            15 => StoreOp::SealedEdit {
                peer: self.login(&PEERS),
                id: self.id(),
                author: self.login(&PEOPLE),
                mine: self.coin(),
                text: self.text(),
                edited_at: self.ts(),
            },
            _ => self.crypto_op(),
        }
    }
}

/// Lists the core turns into maps lose their order; the rest keep it.
fn by_peer(mut snapshot: Snapshot) -> Snapshot {
    snapshot.receipts.sort_by(|a, b| a.peer.cmp(&b.peer));
    snapshot.backfill.sort_by(|a, b| a.peer.cmp(&b.peer));
    snapshot.own_reads.sort_by(|a, b| a.peer.cmp(&b.peer));
    snapshot.acks.sort_by(|a, b| a.peer.cmp(&b.peer));
    snapshot
        .olm_channels
        .sort_by(|a, b| (&a.login, &a.device).cmp(&(&b.login, &b.device)));
    snapshot.outbound_groups.sort_by(|a, b| a.peer.cmp(&b.peer));
    snapshot.inbound_groups.sort_by(|a, b| {
        (&a.sender, &a.device, &a.session).cmp(&(&b.sender, &b.device, &b.session))
    });
    snapshot.encrypted.sort();
    snapshot
        .sealed
        .sort_by(|a, b| (&a.peer, &a.id).cmp(&(&b.peer, &b.id)));
    snapshot.peer_identities.sort_by(|a, b| a.peer.cmp(&b.peer));
    snapshot
}

fn assert_same(mem: &MemStore, kv: &KvStore, context: &str) {
    assert_eq!(
        by_peer(mem.load().unwrap()),
        by_peer(kv.load().unwrap()),
        "snapshot, {context}"
    );
    for peer in PEERS {
        for id in IDS {
            let key = (Login::parse(peer).unwrap(), MessageId::parse(id).unwrap());
            assert_eq!(
                mem.messages.get(&key),
                kv.message(&key.0, &key.1).as_ref(),
                "message {peer}/{id}, {context}"
            );
            let sent = mem
                .snapshot
                .sent
                .iter()
                .find(|m| m.peer == key.0 && m.id == key.1)
                .map(|m| Sent {
                    message: m.clone(),
                    edited_at: mem.sent_edits.get(&key).copied(),
                    reactions: mem.sent_reactions.get(&key).cloned().unwrap_or_default(),
                });
            assert_eq!(sent, kv.sent(&key.0, &key.1), "sent {peer}/{id}, {context}");
        }
    }
}

/// IndexedDB as the journals left it: key → value.
type Disk = BTreeMap<String, String>;

fn commit(kv: &mut KvStore, disk: &mut Disk) {
    for entry in kv.take_journal() {
        match entry.value {
            Some(value) => disk.insert(entry.key, value),
            None => disk.remove(&entry.key),
        };
    }
}

#[test]
fn random_batches_match_the_reference_store_and_survive_a_reload() {
    for seed in [0x9e37_79b9_7f4a_7c15_u64, 42, 0xdead_beef] {
        let mut rng = Rng(seed);
        let mut mem = MemStore::default();
        let mut kv = KvStore::new();
        let mut disk = Disk::new();
        let mut refused = 0;
        for batch in 0..600 {
            let ops: Vec<StoreOp> = (0..=rng.below(4)).map(|_| rng.op()).collect();
            let context = format!("seed {seed:#x}, batch {batch}: {ops:?}");
            let expected = mem.apply(&ops);
            let got = kv.apply(&ops);
            assert_eq!(expected.is_ok(), got.is_ok(), "outcome, {context}");
            if got.is_err() {
                refused += 1;
                assert!(
                    !kv.has_journal(),
                    "a refused batch wrote nothing, {context}"
                );
            }
            commit(&mut kv, &mut disk);
            assert_same(&mem, &kv, &context);
            if batch % 50 == 49 {
                kv = KvStore::from_records(disk.values().map(String::as_str)).unwrap();
                assert_same(&mem, &kv, &format!("{context}, reloaded"));
                // A reload writes nothing, and a fresh full copy is the disk.
                assert!(!kv.has_journal());
                let full: Disk = kv
                    .all_records()
                    .into_iter()
                    .map(|e| (e.key, e.value.unwrap()))
                    .collect();
                assert_eq!(full, disk, "full copy, {context}");
            }
        }
        assert!(refused > 0, "seed {seed:#x} never exercised a rollback");
    }
}

#[test]
fn an_empty_store_loads_the_default_snapshot() {
    assert_eq!(KvStore::new().load().unwrap(), Snapshot::default());
    assert_eq!(
        KvStore::from_records(std::iter::empty())
            .unwrap()
            .load()
            .unwrap(),
        Snapshot::default()
    );
}
