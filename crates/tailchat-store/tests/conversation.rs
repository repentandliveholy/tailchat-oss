//! Conversation paging, source precedence, and schema migration.

#![cfg(test)]

use rusqlite::Connection;
use tailchat_core::frames::inner::Image;
use tailchat_core::{
    Login, Message, MessageId, MessageKind, Outgoing, PendingOutgoing, Protection, Reaction,
    Receipt, Seal, Storage, StoreOp, Ts,
};
use tailchat_store::{Key, Row, SqliteStore};

fn login(s: &str) -> Login {
    Login::parse(s).unwrap()
}
fn id(s: &str) -> MessageId {
    MessageId::parse(s).unwrap()
}
fn outgoing(name: &str, ts: i64, receipt: Receipt) -> Outgoing {
    Outgoing {
        extra: Default::default(),
        peer: login("bob"),
        id: id(name),
        ts: Ts(ts),
        text: name.into(),
        image: None,
        receipt,
    }
}
fn pending(name: &str, ts: i64, receipt: Receipt) -> PendingOutgoing {
    PendingOutgoing {
        message: outgoing(name, ts, receipt),
        attempts: 3,
        next_attempt_at: Ts(123),
        seal: Seal::Undecided,
    }
}
fn message(name: &str, ts: i64) -> Message {
    Message {
        edit_of: None,
        peer: login("bob"),
        id: id(name),
        from: login("bob"),
        ts: Ts(ts),
        kind: MessageKind::Human,
        text: name.into(),
        author: None,
        image: None,
        voice: None,
        reply_to: None,
        forwarded_from: None,
        buttons: vec![],
        media_dropped: false,
        edited_at: None,
        reactions: vec![],
        protection: Protection::Plain,
    }
}

#[test]
fn an_outgoing_rows_extra_and_a_sealed_edit_survive_the_disk() {
    use tailchat_core::frames::inner::{Forwarded, Reply};
    use tailchat_core::{Extra, OutVoice};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let bob = login("bob");
    let extra = Extra {
        reply_to: Some(Reply {
            id: id("c"),
            from: bob.clone(),
            text: "quoted".into(),
            media: None,
        }),
        forwarded_from: Some(Forwarded {
            login: None,
            name: Some("Carol".into()),
        }),
        voice: Some(OutVoice {
            data_url: "data:audio/mp4;base64,AAAA".into(),
            duration_ms: 900,
            waveform: vec![3, 4, 5],
        }),
        edit_of: None,
    };
    let mut queued = pending("q", 10, Receipt::Queued);
    queued.message.extra = Box::new(extra.clone());
    let mut committed = outgoing("s", 11, Receipt::Sent);
    committed.extra = Box::new(Extra {
        edit_of: Some(id("c")),
        ..Extra::default()
    });
    let mut carrier = message("e", 12);
    carrier.edit_of = Some(id("c"));
    carrier.protection = Protection::Encrypted;
    {
        let mut store = SqliteStore::open(&path, &Key::from_bytes(&[7; 32])).unwrap();
        store
            .apply(&[
                StoreOp::PutPending(queued),
                StoreOp::PutOutgoing(committed),
                StoreOp::PutMessage(Box::new(message("c", 9))),
                StoreOp::PutMessage(Box::new(carrier)),
                // Not the author: nothing changes.
                StoreOp::SealedEdit {
                    peer: bob.clone(),
                    id: id("c"),
                    author: login("alice"),
                    mine: true,
                    text: "forged".into(),
                    edited_at: Ts(12),
                },
            ])
            .unwrap();
        assert_eq!(store.message(&bob, &id("c")).unwrap().unwrap().text, "c");
        store
            .apply(&[StoreOp::SealedEdit {
                peer: bob.clone(),
                id: id("c"),
                author: bob.clone(),
                mine: false,
                text: "edited".into(),
                edited_at: Ts(12),
            }])
            .unwrap();
    }
    let store = SqliteStore::open(&path, &Key::from_bytes(&[7; 32])).unwrap();
    let snapshot = store.load().unwrap();
    assert_eq!(*snapshot.pending[0].message.extra, extra);
    let sent = store.sent(&bob, &id("s")).unwrap().unwrap();
    assert_eq!(sent.message.extra.edit_of, Some(id("c")));
    let target = store.message(&bob, &id("c")).unwrap().unwrap();
    assert_eq!((target.text.as_str(), target.edited_at), ("edited", Some(Ts(12))));
    let carrier = store.message(&bob, &id("e")).unwrap().unwrap();
    assert_eq!(carrier.edit_of, Some(id("c")));
}

#[test]
fn pages_and_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let bob = login("bob");
    let mut store = SqliteStore::open(&dir.path().join("db"), &Key::from_bytes(&[7; 32])).unwrap();
    let reactions = vec![Reaction {
        emoji: "👍".into(),
        by: vec![bob.clone()],
    }];
    store
        .apply(&[
            StoreOp::PutPending(pending("a", 10, Receipt::Queued)),
            StoreOp::PutPending(pending("b", 10, Receipt::Failed)),
            StoreOp::PutMessage(Box::new(message("c", 10))),
            StoreOp::PutOutgoing(outgoing("d", 10, Receipt::Read)),
            StoreOp::EditMessage {
                peer: bob.clone(),
                id: id("d"),
                text: "edited".into(),
                edited_at: Some(Ts(20)),
            },
            StoreOp::PutReactions {
                peer: bob.clone(),
                id: id("d"),
                reactions: reactions.clone(),
            },
            // Store operations permit all three tables to hold the same key.
            StoreOp::PutMessage(Box::new(message("d", 99))),
            StoreOp::PutPending(pending("d", 100, Receipt::Failed)),
            StoreOp::PutPending(pending("c", 101, Receipt::Queued)),
            StoreOp::PutMessage(Box::new(message("e", 11))),
        ])
        .unwrap();
    let rows = store.conversation(&bob, None, usize::MAX).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id().as_str()).collect::<Vec<_>>(),
        ["a", "b", "c", "d", "e"]
    );
    assert!(
        matches!(&rows[0], Row::Pending(p) if p.message.receipt == Receipt::Queued && p.attempts == 3 && p.next_attempt_at == Ts(123))
    );
    assert!(matches!(&rows[1], Row::Pending(p) if p.message.receipt == Receipt::Failed));
    assert!(matches!(&rows[2], Row::Message(m) if m.ts == Ts(10)));
    assert!(
        matches!(&rows[3], Row::Sent(s) if s.message.receipt == Receipt::Read && s.edited_at == Some(Ts(20)) && s.reactions == reactions)
    );
    assert_eq!(rows[3].ts(), Ts(10));
    assert!(store.conversation(&bob, None, 0).unwrap().is_empty());
    assert!(
        store
            .conversation(&login("carol"), None, 10)
            .unwrap()
            .is_empty()
    );
    let last = store.conversation(&bob, None, 2).unwrap();
    assert_eq!(
        last.iter().map(|r| r.id().as_str()).collect::<Vec<_>>(),
        ["d", "e"]
    );
    let older = store
        .conversation(&bob, Some((last[0].ts(), last[0].id())), 2)
        .unwrap();
    assert_eq!(
        older.iter().map(|r| r.id().as_str()).collect::<Vec<_>>(),
        ["b", "c"]
    );
    let oldest = store
        .conversation(&bob, Some((older[0].ts(), older[0].id())), 2)
        .unwrap();
    assert_eq!(
        oldest.iter().map(|r| r.id().as_str()).collect::<Vec<_>>(),
        ["a"]
    );
    // A newer lower-priority copy must not leak through an older cursor.
    assert!(
        store
            .conversation(&bob, Some((Ts(10), &id("a"))), 20)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn migrates_encrypted_schema_one_file_without_losing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "07".repeat(32)))
        .unwrap();
    // This is the actual schema-1 DDL, not a simulated subset of its tables.
    let source = include_str!("../src/schema.rs");
    let schema = source
        .split_once("const SCHEMA_1: &str = \"")
        .unwrap()
        .1
        .split_once("\";")
        .unwrap()
        .0;
    conn.execute_batch(schema).unwrap();
    conn.execute_batch(
        "INSERT INTO pending VALUES ('bob', 'old', 12, 'old text', 'queued', 2, 30, 1);
         INSERT INTO messages VALUES ('carol', 'm1', 'carol', 5, 'human', 'hi', NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL,
             '[]', 0, NULL, '[]');",
    )
    .unwrap();
    drop(conn);
    let store = SqliteStore::open(&path, &Key::from_bytes(&[7; 32])).unwrap();
    let rows = store.conversation(&login("bob"), None, 10).unwrap();
    assert!(matches!(&rows[..], [Row::Pending(p)]
        if p.message.id == id("old") && p.attempts == 2 && p.seal == Seal::Undecided));
    // Rows from before end-to-end encryption came open.
    let old = store.message(&login("carol"), &id("m1")).unwrap().unwrap();
    assert_eq!(old.protection, Protection::Plain);
    assert!(store.load().unwrap().sealed.is_empty());
    drop(store);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "07".repeat(32)))
        .unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    for name in [
        "pending_conversation",
        "sent_conversation",
        "messages_conversation",
        "messages_waiting",
    ] {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}

/// One `SCHEMA_N` literal from the store's own source, so a migration test
/// opens the DDL the previous release actually wrote.
fn ddl(name: &str) -> String {
    let source = include_str!("../src/schema.rs");
    source
        .split_once(&format!("const {name}: &str = \""))
        .unwrap_or_else(|| panic!("no {name}"))
        .1
        .split_once("\";")
        .unwrap()
        .0
        .to_owned()
}

/// A schema-3 file (end-to-end encryption, no pictures in outgoing rows)
/// opens as schema 4 with its rows readable, and both outgoing tables keep a
/// picture from then on.
#[test]
fn migrates_a_schema_three_file_and_keeps_its_rows_readable() {
    let key = Key::from_bytes(&[7; 32]);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "07".repeat(32)))
        .unwrap();
    for name in ["SCHEMA_1", "SCHEMA_2", "SCHEMA_3"] {
        conn.execute_batch(&ddl(name)).unwrap();
    }
    conn.execute_batch(
        "INSERT INTO pending (peer, id, ts, text, receipt, attempts, next_attempt_at, ord)
             VALUES ('bob', 'q1', 12, 'queued before pictures', 'queued', 1, 30, 1);
         INSERT INTO sent (peer, id, ts, text, receipt, edited_at, reactions, ord)
             VALUES ('bob', 's1', 9, 'sent before pictures', 'read', NULL, '[]', 1);
         INSERT INTO messages (peer, id, sender, ts, kind, text, author,
             image_url, image_width, image_height, voice_url, voice_duration,
             reply_id, reply_from, reply_text, reply_media,
             forwarded, forwarded_login, forwarded_name,
             buttons, media_dropped, edited_at, reactions)
             VALUES ('carol', 'm1', 'carol', 5, 'human', 'hi', NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 0, NULL, NULL, '[]', 0, NULL, '[]');",
    )
    .unwrap();
    drop(conn);

    let mut store = SqliteStore::open(&path, &key).unwrap();
    let snapshot = store.load().unwrap();
    assert_eq!(
        snapshot
            .pending
            .iter()
            .find(|r| r.message.id == id("q1"))
            .and_then(|r| r.message.image.clone()),
        None,
        "a row from before pictures carries none"
    );
    assert_eq!(
        store
            .sent(&login("bob"), &id("s1"))
            .unwrap()
            .unwrap()
            .message
            .text,
        "sent before pictures"
    );

    // Both tables take a picture now, and read it back whole.
    let picture = Image {
        data_url: "data:image/webp;base64,AAAA".to_owned(),
        width: Some(640),
        height: None,
    };
    let mut queued = pending("q2", 14, Receipt::Queued);
    queued.message.image = Some(picture.clone());
    let mut committed = outgoing("s2", 15, Receipt::Sent);
    committed.image = Some(picture.clone());
    store
        .apply(&[
            StoreOp::PutPending(queued.clone()),
            StoreOp::PutOutgoing(committed),
        ])
        .unwrap();
    let reloaded = store.load().unwrap();
    assert_eq!(
        reloaded
            .pending
            .iter()
            .find(|r| r.message.id == id("q2"))
            .map(|r| r.message.image.clone()),
        Some(Some(picture.clone()))
    );
    assert_eq!(
        store
            .sent(&login("bob"), &id("s2"))
            .unwrap()
            .and_then(|s| s.message.image),
        Some(picture)
    );
    drop(store);

    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "07".repeat(32)))
        .unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
}
