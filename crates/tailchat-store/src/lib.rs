//! Tailchat's native [`Storage`]: one SQLCipher file per account.
//!
//! [`SqliteStore::apply`] runs a whole `StoreOp` batch in one transaction and
//! returns only after it is durable: WAL with `synchronous = FULL` (and
//! `F_FULLFSYNC` on Apple), so `Output::Persist` is on disk before the driver
//! writes the next `Output::Send`. A failed op rolls the whole batch back.
//! The semantics of every op are the reference `MemStore`'s
//! (`tailchat-core/tests/common/mod.rs`); this crate's tests run both side by
//! side.
//!
//! The file is encrypted with a raw 256-bit [`Key`] the driver keeps
//! (keychain, keystore); nothing is ever written unencrypted, and a build of
//! SQLite without SQLCipher is refused at [`SqliteStore::open`].

use std::fmt::{self, Write as _};
use std::path::Path;

use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior};
use tailchat_core::{Login, Message, MessageId, Snapshot, Storage, StoreOp, Ts};
pub use tailchat_core::{Row, Sent};
use zeroize::Zeroizing;

/// `StoreOp` → SQL, one op at a time.
mod apply;
/// Core values ↔ column values.
mod codec;
/// `Snapshot` and single rows, read back.
mod read;
/// Tables and their version.
mod schema;

/// Length of a [`Key`] in bytes.
pub const KEY_LEN: usize = 32;

/// The raw SQLCipher key: 32 random bytes, used as-is (no passphrase KDF).
/// `{:?}` never prints it; our copy is wiped on drop.
pub struct Key(Zeroizing<[u8; KEY_LEN]>);

impl Key {
    /// Copies the key in. The caller's buffer is the caller's to wipe.
    pub fn from_bytes(bytes: &[u8; KEY_LEN]) -> Self {
        Self(Zeroizing::new(*bytes))
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Key(***)")
    }
}

/// Everything that can go wrong with the store. No variant carries message
/// text or key material.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// SQLite itself failed: I/O, a full disk, a locked file.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The linked SQLite has no SQLCipher, so the file would be plaintext.
    #[error("this SQLite build has no SQLCipher; refusing to store messages unencrypted")]
    NotSqlCipher,
    /// The key does not open the file, or the file is not a database.
    #[error("wrong key, or not a Tailchat store")]
    WrongKey,
    /// The file was written by a newer build.
    #[error("store schema {found} is newer than this build's {supported}")]
    NewerSchema {
        /// The file's `user_version`.
        found: i64,
        /// The newest this build understands.
        supported: i64,
    },
    /// A row read back breaks the type it holds.
    #[error("corrupt row in {table}: {reason}")]
    Corrupt {
        /// The table.
        table: &'static str,
        /// What is wrong with it.
        reason: &'static str,
    },
    /// `StoreOp::SetAttempt` named a message that is not queued.
    #[error("retry metadata for a message that is not queued")]
    MissingPending,
    /// A list column could not be encoded.
    #[error("encode: {0}")]
    Encode(#[from] serde_json::Error),
}

/// The SQLCipher store of one account. One process, one `SqliteStore` per
/// file: two cores writing the same file would each trust their own memory.
pub struct SqliteStore {
    /// The keyed, migrated connection.
    conn: Connection,
}

impl SqliteStore {
    /// Opens (or creates) the store at `path` with `key`.
    ///
    /// Fails with [`Error::WrongKey`] when `key` does not open an existing
    /// file, [`Error::NotSqlCipher`] when SQLite was built without
    /// encryption, and [`Error::NewerSchema`] for a file from a newer build.
    ///
    /// SQLite keeps a copy of the keying statement until it is finalized and
    /// does not wipe it; SQLCipher holds the key itself while the file is open.
    pub fn open(path: &Path, key: &Key) -> Result<Self, Error> {
        let mut conn = Connection::open(path)?;
        key_connection(&conn, key)?;
        let cipher: Option<String> = conn
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .optional()?;
        if cipher.is_none_or(|version| version.is_empty()) {
            return Err(Error::NotSqlCipher);
        }
        // The first read decrypts page 1: this is where a wrong key shows.
        match conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        }) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == ErrorCode::NotADatabase => {
                return Err(Error::WrongKey);
            }
            Err(e) => return Err(e.into()),
        }
        // WAL where the file system allows it; SQLite's answer is the mode it
        // kept. Either journal is atomic and, with `synchronous = FULL`, durable.
        let _mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "fullfsync", true)?;
        conn.pragma_update(None, "checkpoint_fullfsync", true)?;
        schema::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// The conversation row `(peer, id)`, as `Event::MessageStored` asks the
    /// UI to re-read it. `None`: not held (any more).
    pub fn message(&self, peer: &Login, id: &MessageId) -> Result<Option<Message>, Error> {
        read::message(&self.conn, peer, id)
    }

    /// The committed outgoing row `(peer, id)`. `None`: not committed, or gone.
    pub fn sent(&self, peer: &Login, id: &MessageId) -> Result<Option<Sent>, Error> {
        read::sent(&self.conn, peer, id)
    }

    /// The one row `(peer, id)` as [`SqliteStore::conversation`] would show
    /// it, with the same precedence: committed, conversation, queued.
    pub fn row(&self, peer: &Login, id: &MessageId) -> Result<Option<Row>, Error> {
        if let Some(sent) = read::sent(&self.conn, peer, id)? {
            return Ok(Some(Row::Sent(sent)));
        }
        if let Some(message) = read::message(&self.conn, peer, id)? {
            return Ok(Some(Row::Message(message)));
        }
        Ok(read::pending(&self.conn, peer, id)?.map(Row::Pending))
    }

    /// The newest `limit` rows strictly older than `before` by `(ts, id)`,
    /// returned oldest to newest. Committed rows take precedence over
    /// conversation rows, which take precedence over pending rows.
    pub fn conversation(
        &self,
        peer: &Login,
        before: Option<(Ts, &MessageId)>,
        limit: usize,
    ) -> Result<Vec<Row>, Error> {
        read::conversation(&self.conn, peer, before, limit)
    }
}

/// `PRAGMA key = "x'…'"`: the raw-key form, which skips SQLCipher's
/// passphrase KDF. The statement text lives in a buffer we wipe.
fn key_connection(conn: &Connection, key: &Key) -> Result<(), Error> {
    let mut sql = Zeroizing::new(String::with_capacity(96));
    sql.push_str("PRAGMA key = \"x'");
    for byte in key.0.iter() {
        // Writing into a String cannot fail.
        let _ = write!(sql, "{byte:02x}");
    }
    sql.push_str("'\";");
    conn.execute_batch(&sql)?;
    Ok(())
}

impl Storage for SqliteStore {
    type Error = Error;

    fn apply(&mut self, ops: &[StoreOp]) -> Result<(), Error> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for op in ops {
            // Dropping `tx` on the way out rolls the batch back.
            apply::apply_one(&tx, op)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn load(&self) -> Result<Snapshot, Error> {
        read::snapshot(&self.conn)
    }
}
