//! The tables, and the one place that knows which version of them a file has.

use rusqlite::{Connection, TransactionBehavior};

use crate::Error;

/// The schema this build writes, kept in `PRAGMA user_version`.
pub(crate) const VERSION: i64 = 5;

/// Schema 1. Every table is keyed the way `Snapshot` is: messages by
/// `(peer, id)`, per-conversation state by `peer`.
///
/// `ord` keeps the order `MemStore` keeps: an upsert moves the row to the end,
/// and the outbox's round-robin starts from that order after a restart.
/// Lists nobody queries by (reactions, buttons, owed ids) are JSON text.
const SCHEMA_1: &str = "
CREATE TABLE cursor (
    only INTEGER PRIMARY KEY CHECK (only = 0),
    seq INTEGER NOT NULL
);
CREATE TABLE pending (
    peer TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    text TEXT NOT NULL,
    receipt TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    PRIMARY KEY (peer, id)
);
CREATE TABLE sent (
    peer TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    text TEXT NOT NULL,
    receipt TEXT NOT NULL,
    edited_at INTEGER,
    reactions TEXT NOT NULL,
    ord INTEGER NOT NULL,
    PRIMARY KEY (peer, id)
);
CREATE TABLE messages (
    peer TEXT NOT NULL,
    id TEXT NOT NULL,
    sender TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    author TEXT,
    image_url TEXT,
    image_width INTEGER,
    image_height INTEGER,
    voice_url TEXT,
    voice_duration REAL,
    reply_id TEXT,
    reply_from TEXT,
    reply_text TEXT,
    reply_media TEXT,
    forwarded INTEGER NOT NULL,
    forwarded_login TEXT,
    forwarded_name TEXT,
    buttons TEXT NOT NULL,
    media_dropped INTEGER NOT NULL,
    edited_at INTEGER,
    reactions TEXT NOT NULL,
    PRIMARY KEY (peer, id)
);
CREATE TABLE peer_receipts (
    peer TEXT PRIMARY KEY,
    delivered_ts INTEGER,
    read_ts INTEGER
);
CREATE TABLE backfill (
    peer TEXT PRIMARY KEY,
    owed TEXT NOT NULL,
    reseed TEXT,
    below_id TEXT,
    below_ts INTEGER
);
CREATE TABLE own_reads (
    peer TEXT PRIMARY KEY,
    read_ts INTEGER NOT NULL
);
CREATE TABLE acks (
    peer TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL
);
PRAGMA user_version = 1;
";

/// Schema 2 adds conversation paging indexes without changing stored rows.
const SCHEMA_2: &str = "
CREATE INDEX pending_conversation ON pending (peer, ts, id);
CREATE INDEX sent_conversation ON sent (peer, ts, id);
CREATE INDEX messages_conversation ON messages (peer, ts, id);
PRAGMA user_version = 2;
";

/// Schema 3: end-to-end encryption (E2EE spec §6, sub-stage 6c). The queue
/// row keeps the decision made at its first write (`seal`: null undecided,
/// `plain`, `encrypted` + envelope); a conversation row keeps how it came
/// (`protection`: `plain`, `encrypted`, or sealed — `waiting`/`refused` +
/// envelope). Pickles are the crate's own `{v, p}` JSON: no separate key,
/// SQLCipher encrypts them with the file.
const SCHEMA_3: &str = "
ALTER TABLE pending ADD COLUMN seal TEXT;
ALTER TABLE pending ADD COLUMN seal_dev TEXT;
ALTER TABLE pending ADD COLUMN seal_sid TEXT;
ALTER TABLE pending ADD COLUMN seal_ct TEXT;
ALTER TABLE messages ADD COLUMN protection TEXT NOT NULL DEFAULT 'plain';
ALTER TABLE messages ADD COLUMN env_dev TEXT;
ALTER TABLE messages ADD COLUMN env_sid TEXT;
ALTER TABLE messages ADD COLUMN env_ct TEXT;
CREATE INDEX messages_waiting ON messages (peer, id) WHERE protection = 'waiting';
CREATE TABLE crypto_account (
    only INTEGER PRIMARY KEY CHECK (only = 0),
    pickle TEXT NOT NULL
);
CREATE TABLE olm_channels (
    login TEXT NOT NULL,
    device TEXT NOT NULL,
    pickle TEXT NOT NULL,
    PRIMARY KEY (login, device)
);
CREATE TABLE outbound_groups (
    peer TEXT PRIMARY KEY,
    pickle TEXT NOT NULL
);
CREATE TABLE inbound_groups (
    sender TEXT NOT NULL,
    device TEXT NOT NULL,
    session TEXT NOT NULL,
    pickle TEXT NOT NULL,
    PRIMARY KEY (sender, device, session)
);
CREATE TABLE to_device (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    device TEXT NOT NULL,
    body TEXT NOT NULL,
    ord INTEGER NOT NULL
);
CREATE TABLE encrypted (
    peer TEXT PRIMARY KEY
);
CREATE TABLE peer_identities (
    peer TEXT PRIMARY KEY,
    master_key TEXT NOT NULL,
    verified INTEGER NOT NULL
);
CREATE TABLE backup_key (
    only INTEGER PRIMARY KEY CHECK (only = 0),
    pickle TEXT NOT NULL
);
PRAGMA user_version = 3;
";

/// Schema 4: a picture travels with an outgoing message (spec E2EE §4.3).
/// Queue and committed rows keep its `dataUrl` and the size the sender
/// claimed, so a restart re-sends exactly what was queued and the UI draws it
/// before the server answers.
const SCHEMA_4: &str = "
ALTER TABLE pending ADD COLUMN image_url TEXT;
ALTER TABLE pending ADD COLUMN image_width INTEGER;
ALTER TABLE pending ADD COLUMN image_height INTEGER;
ALTER TABLE sent ADD COLUMN image_url TEXT;
ALTER TABLE sent ADD COLUMN image_width INTEGER;
ALTER TABLE sent ADD COLUMN image_height INTEGER;
PRAGMA user_version = 4;
";

/// Schema 5: an outgoing row keeps its quote, forward label, voice note and
/// edit target (`extra`, JSON, `NULL` for none) so a restart re-sends the same
/// sealed header; a conversation row keeps the edit it carried (`edit_of`)
/// and its voice note's waveform (`voice_wave`, JSON list of bars).
const SCHEMA_5: &str = "
ALTER TABLE pending ADD COLUMN extra TEXT;
ALTER TABLE sent ADD COLUMN extra TEXT;
ALTER TABLE messages ADD COLUMN edit_of TEXT;
ALTER TABLE messages ADD COLUMN voice_wave TEXT;
PRAGMA user_version = 5;
";

/// Brings a freshly keyed connection to [`VERSION`], or refuses a file
/// written by a newer build rather than guess at its tables.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Exclusive)?;
    let found: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let steps: &[&str] = match found {
        0 => &[SCHEMA_1, SCHEMA_2, SCHEMA_3, SCHEMA_4, SCHEMA_5],
        1 => &[SCHEMA_2, SCHEMA_3, SCHEMA_4, SCHEMA_5],
        2 => &[SCHEMA_3, SCHEMA_4, SCHEMA_5],
        3 => &[SCHEMA_4, SCHEMA_5],
        4 => &[SCHEMA_5],
        VERSION => &[],
        _ => {
            return Err(Error::NewerSchema {
                found,
                supported: VERSION,
            });
        }
    };
    for step in steps {
        tx.execute_batch(step)?;
    }
    tx.commit()?;
    Ok(())
}
