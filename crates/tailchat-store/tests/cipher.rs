//! The file is SQLCipher-encrypted: nothing a conversation says reaches the
//! disk readable, and only the right key opens it.

#![cfg(test)]

use std::path::Path;

use tailchat_core::{
    Login, Message, MessageId, MessageKind, Outgoing, Protection, Receipt, Storage, StoreOp, Ts,
};
use tailchat_store::{Error, Key, SqliteStore};

const CANARY: &str = "CANARY-the-text-must-never-be-on-disk";

fn message(text: &str) -> Message {
    Message {
        edit_of: None,
        peer: Login::parse("bob").unwrap(),
        id: MessageId::parse("m-canary").unwrap(),
        from: Login::parse("bob").unwrap(),
        ts: Ts(1),
        kind: MessageKind::Human,
        text: text.to_owned(),
        author: None,
        image: None,
        voice: None,
        reply_to: None,
        forwarded_from: None,
        buttons: Vec::new(),
        media_dropped: false,
        edited_at: None,
        reactions: Vec::new(),
        protection: Protection::Plain,
    }
}

/// Whether any file in `dir` (the database, its WAL, its index) holds `needle`.
fn on_disk(dir: &Path, needle: &str) -> bool {
    std::fs::read_dir(dir).unwrap().any(|entry| {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
    })
}

#[test]
fn message_text_never_reaches_the_disk_readable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.db");
    let mut store = SqliteStore::open(&path, &Key::from_bytes(&[3; 32])).unwrap();
    store
        .apply(&[
            StoreOp::PutMessage(Box::new(message(CANARY))),
            StoreOp::PutOutgoing(Outgoing {
                extra: Default::default(),
                id: MessageId::parse("m-mine").unwrap(),
                peer: Login::parse("bob").unwrap(),
                ts: Ts(2),
                text: CANARY.to_owned(),
                image: None,
                receipt: Receipt::Sent,
            }),
            StoreOp::PutCryptoAccount(tailchat_core::Secret::new(zeroize::Zeroizing::new(
                format!("{{\"v\":1,\"p\":\"{CANARY}\"}}"),
            ))),
        ])
        .unwrap();
    // While open the batch sits in the WAL; after close it is checkpointed.
    assert!(!on_disk(dir.path(), CANARY));
    drop(store);
    assert!(!on_disk(dir.path(), CANARY));
    // The canary is a fair probe: the store does hold it.
    let store = SqliteStore::open(&path, &Key::from_bytes(&[3; 32])).unwrap();
    let bob = Login::parse("bob").unwrap();
    let held = store
        .message(&bob, &MessageId::parse("m-canary").unwrap())
        .unwrap();
    assert_eq!(held.unwrap().text, CANARY);
    let account = store.load().unwrap().crypto_account.unwrap();
    assert!(account.expose().contains(CANARY));
}

#[test]
fn only_the_right_key_opens_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.db");
    let mut store = SqliteStore::open(&path, &Key::from_bytes(&[5; 32])).unwrap();
    store
        .apply(&[StoreOp::SetCursor(tailchat_core::Seq(77))])
        .unwrap();
    drop(store);

    let mut wrong = [5; 32];
    wrong[31] = 6;
    assert!(matches!(
        SqliteStore::open(&path, &Key::from_bytes(&wrong)),
        Err(Error::WrongKey)
    ));
    // A refused key changed nothing.
    let store = SqliteStore::open(&path, &Key::from_bytes(&[5; 32])).unwrap();
    assert_eq!(store.load().unwrap().cursor, tailchat_core::Seq(77));
}

#[test]
fn a_file_from_a_newer_build_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.db");
    drop(SqliteStore::open(&path, &Key::from_bytes(&[9; 32])).unwrap());
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "09".repeat(32)))
        .unwrap();
    raw.pragma_update(None, "user_version", 6).unwrap();
    drop(raw);

    assert!(matches!(
        SqliteStore::open(&path, &Key::from_bytes(&[9; 32])),
        Err(Error::NewerSchema {
            found: 6,
            supported: 5
        })
    ));
}

#[test]
fn the_key_never_prints() {
    assert_eq!(format!("{:?}", Key::from_bytes(&[0xab; 32])), "Key(***)");
}
