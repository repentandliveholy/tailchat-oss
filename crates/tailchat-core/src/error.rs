/// Every error the core can return.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoreError {
    /// A login that breaks the server's rule (`src/cloud/accounts.js`).
    #[error("invalid login: {reason}")]
    InvalidLogin {
        /// Which part of the rule it breaks.
        reason: &'static str,
    },
    /// An empty, overlong or control-character message id.
    #[error("invalid message id")]
    InvalidMessageId,
    /// A bearer token that is not 64 lowercase hex characters.
    #[error("invalid token")]
    InvalidToken,
    /// The user tried to send blank text.
    #[error("message text is empty")]
    EmptyText,
    /// A picture a send named is not one a frame can carry.
    #[error("invalid picture: {reason}")]
    InvalidImage {
        /// What is wrong with it.
        reason: &'static str,
    },
    /// This conversation already has the maximum number of uncommitted rows.
    #[error("outbox is full (limit {limit} per conversation)")]
    QueueFull {
        /// The per-conversation limit; existing rows were not removed.
        limit: usize,
    },
    /// A new send tried to reuse an existing id in the same conversation.
    #[error("message id is already used; retry with Action::Retry")]
    DuplicateMessageId,
    /// Manual retry did not name a failed row.
    #[error("message is not awaiting manual retry")]
    NotRetryable,
    /// A frame over the size limit, in either direction.
    #[error("frame is {len} bytes, limit is {max}")]
    FrameTooLarge {
        /// Its size in bytes.
        len: usize,
        /// The limit it broke.
        max: usize,
    },
    /// A `del` frame that names no message, or more of them than the server
    /// takes in one frame (`DEL_MAX_IDS`).
    #[error("delete names {count} message ids, the server takes 1 to {max}")]
    InvalidIdCount {
        /// How many ids the caller passed.
        count: usize,
        /// The most one `del` may name.
        max: usize,
    },
    /// The action needs the socket, and it is not ready.
    #[error("not connected")]
    NotReady,
    /// A frame from the server that is not the JSON we expect.
    #[error("malformed frame: {0}")]
    BadFrame(String),
    /// A backup passphrase shorter than 16 characters and fewer than 4 words (spec E2EE §4.5, §11).
    #[error("backup passphrase must be at least 16 characters or 4 words")]
    WeakPassphrase,
    /// A backup recovery key or salt that does not parse.
    #[error("invalid backup recovery key or salt")]
    InvalidBackupSecret,
}
