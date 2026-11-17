//! A writer process is killed (SIGKILL) at arbitrary moments while it applies
//! batches. Whatever it reported as applied must be there afterwards, and
//! every batch must be on disk whole or not at all.

#![cfg(test)]

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use tailchat_core::{
    Login, Message, MessageId, MessageKind, Outgoing, PendingOutgoing, Protection, Receipt, Seal,
    Seq, Storage, StoreOp, Ts,
};
use tailchat_store::{Key, SqliteStore};

/// Set for the child process: the store it writes to.
const CHILD_ENV: &str = "TAILCHAT_STORE_KILL_CHILD";
/// Conversation rows per batch: enough pages that a kill can land mid-commit.
const ROWS: usize = 24;

fn key() -> Key {
    Key::from_bytes(&[0x42; 32])
}

fn bob() -> Login {
    Login::parse("bob").unwrap()
}

fn row_id(batch: i64, row: usize) -> MessageId {
    MessageId::parse(&format!("b{batch}-{row}")).unwrap()
}

/// Batch `n`: `ROWS` conversation rows, one queue row, and the cursor `n`,
/// all in one `apply`.
fn batch(n: i64) -> Vec<StoreOp> {
    let mut ops: Vec<StoreOp> = (0..ROWS)
        .map(|row| {
            StoreOp::PutMessage(Box::new(Message {
                edit_of: None,
                peer: bob(),
                id: row_id(n, row),
                from: bob(),
                ts: Ts(n),
                kind: MessageKind::Human,
                text: format!("{n}:{row}:").repeat(200),
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
            }))
        })
        .collect();
    ops.push(StoreOp::PutPending(PendingOutgoing {
        message: Outgoing {
            extra: Default::default(),
            id: MessageId::parse(&format!("q{n}")).unwrap(),
            peer: bob(),
            ts: Ts(n),
            text: "queued".to_owned(),
            image: None,
            receipt: Receipt::Queued,
        },
        attempts: 0,
        next_attempt_at: Ts(n),
        seal: Seal::Undecided,
    }));
    ops.push(StoreOp::SetCursor(Seq(n)));
    ops
}

/// The writer: resumes after the last batch on disk and applies batches
/// until it is killed, printing each number once `apply` has returned.
#[test]
#[ignore = "run by batches_survive_sigkill as its child process"]
fn writer_child() {
    let path = std::env::var(CHILD_ENV).expect("only runs as a child");
    let mut store = SqliteStore::open(Path::new(&path), &key()).unwrap();
    let mut n = store.load().unwrap().cursor.0;
    loop {
        n += 1;
        store.apply(&batch(n)).unwrap();
        println!("applied {n}");
    }
}

/// Checks the store holds exactly batches `1..=cursor`, each one whole.
fn verify(path: &Path) -> i64 {
    let store = SqliteStore::open(path, &key()).unwrap();
    let snapshot = store.load().unwrap();
    let last = snapshot.cursor.0;
    let rows = usize::try_from(last).unwrap() * ROWS;
    assert_eq!(snapshot.held.len(), rows, "rows of batches 1..={last}");
    assert_eq!(
        snapshot.pending.len(),
        usize::try_from(last).unwrap(),
        "queue rows of batches 1..={last}"
    );
    for n in 1..=last {
        for row in [0, ROWS - 1] {
            let m = store.message(&bob(), &row_id(n, row)).unwrap().unwrap();
            assert_eq!(m.text, format!("{n}:{row}:").repeat(200));
        }
    }
    assert!(
        store
            .message(&bob(), &row_id(last + 1, 0))
            .unwrap()
            .is_none()
    );
    last
}

#[test]
fn batches_survive_sigkill() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.db");
    let exe = std::env::current_exe().unwrap();
    let mut reached = 0;
    for round in 0..8_u64 {
        let mut child = Command::new(&exe)
            .args(["writer_child", "--exact", "--ignored", "--nocapture"])
            .env(CHILD_ENV, &path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        // Let it get going, then kill it a little later each round so the
        // signal lands at different points of a commit.
        let mut confirmed = reached;
        for line in lines.by_ref() {
            let line = line.unwrap();
            if let Some(n) = line.strip_prefix("applied ") {
                confirmed = n.parse().unwrap();
                if confirmed >= reached + 3 {
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_micros(700 * round));
        child.kill().unwrap();
        child.wait().unwrap();
        // Lines it printed after the last one read are confirmed too.
        for line in lines {
            if let Some(n) = line.unwrap().strip_prefix("applied ") {
                confirmed = n.parse().unwrap();
            }
        }
        let last = verify(&path);
        assert!(
            last >= confirmed,
            "round {round}: batch {confirmed} was reported applied, the disk has {last}"
        );
        assert!(last > reached, "round {round}: no progress");
        reached = last;
    }
}
