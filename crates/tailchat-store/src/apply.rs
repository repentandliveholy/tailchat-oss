//! One `StoreOp` inside the batch's transaction, with the semantics of the
//! reference `MemStore` (`tailchat-core/tests/common/mod.rs`).

use rusqlite::{OptionalExtension, Transaction, params};
use tailchat_core::{
    Backfill, InboundRow, Login, Message, MessageId, OlmChannelRow, Outgoing, OwedAck, OwnRead,
    PeerReceipts, PendingOutgoing, PendingToDevice, Reaction, StoreOp, WalkFrom,
};

use crate::Error;
use crate::codec::{self, kind_text, media_text, protection_columns, receipt_text, seal_columns};

/// Applies `op`. An `Err` leaves the transaction to be rolled back.
pub(crate) fn apply_one(tx: &Transaction<'_>, op: &StoreOp) -> Result<(), Error> {
    match op {
        StoreOp::PutOutgoing(m) => {
            tx.prepare_cached("DELETE FROM pending WHERE peer = ?1 AND id = ?2")?
                .execute(params![m.peer.as_str(), m.id.as_str()])?;
            let (image_url, image_width, image_height) = image_columns(m);
            let extra = codec::extra_json(&m.extra)?;
            // An upsert, not a replace: the edit time and reactions a
            // committed row has collected stay.
            tx.prepare_cached(
                "INSERT INTO sent (peer, id, ts, text, receipt,
                                   image_url, image_width, image_height,
                                   edited_at, reactions, ord, extra)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '[]',
                         (SELECT coalesce(max(ord), 0) + 1 FROM sent), ?9)
                 ON CONFLICT (peer, id) DO UPDATE SET
                     ts = excluded.ts, text = excluded.text,
                     receipt = excluded.receipt,
                     image_url = excluded.image_url,
                     image_width = excluded.image_width,
                     image_height = excluded.image_height,
                     ord = excluded.ord, extra = excluded.extra",
            )?
            .execute(params![
                m.peer.as_str(),
                m.id.as_str(),
                m.ts.0,
                m.text,
                receipt_text(m.receipt),
                image_url,
                image_width,
                image_height,
                extra
            ])?;
        }
        StoreOp::PutPending(row) => put_pending(tx, row)?,
        StoreOp::DropPending { peer, id } => {
            tx.prepare_cached("DELETE FROM pending WHERE peer = ?1 AND id = ?2")?
                .execute(params![peer.as_str(), id.as_str()])?;
        }
        StoreOp::SetAttempt {
            peer,
            id,
            attempts,
            next_attempt_at,
        } => {
            let changed = tx
                .prepare_cached(
                    "UPDATE pending SET attempts = ?3, next_attempt_at = ?4
                     WHERE peer = ?1 AND id = ?2",
                )?
                .execute(params![
                    peer.as_str(),
                    id.as_str(),
                    i64::from(*attempts),
                    next_attempt_at.0
                ])?;
            if changed == 0 {
                return Err(Error::MissingPending);
            }
        }
        StoreOp::PutPeerReceipts(r) => put_receipts(tx, r)?,
        StoreOp::SetCursor(seq) => {
            tx.prepare_cached(
                "INSERT INTO cursor (only, seq) VALUES (0, ?1)
                 ON CONFLICT (only) DO UPDATE SET seq = excluded.seq",
            )?
            .execute([seq.0])?;
        }
        StoreOp::PutMessage(m) => put_message(tx, m)?,
        StoreOp::EditMessage {
            peer,
            id,
            text,
            edited_at,
        } => {
            let edited_at = edited_at.map(|t| t.0);
            let changed = tx
                .prepare_cached(
                    "UPDATE messages
                     SET text = CASE WHEN protection = 'plain' THEN ?3 ELSE text END,
                         edited_at = CASE WHEN protection = 'plain' THEN ?4 ELSE edited_at END
                     WHERE peer = ?1 AND id = ?2",
                )?
                .execute(params![peer.as_str(), id.as_str(), text, edited_at])?;
            if changed == 0 {
                // A committed row keeps its last edit time when none is given.
                tx.prepare_cached(
                    "UPDATE sent SET text = ?3, edited_at = coalesce(?4, edited_at)
                     WHERE peer = ?1 AND id = ?2",
                )?
                .execute(params![peer.as_str(), id.as_str(), text, edited_at])?;
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
            // The author check is the server's own rule for an open edit
            // (`editHistory`), which cannot see this one. A conversation row
            // under the key decides, as for `EditMessage`: a committed row is
            // edited only when there is none (the reference `MemStore` and
            // the browser's `KvStore` do the same).
            let edits = "sender = ?5 AND protection IN ('plain', 'encrypted')";
            let changed = tx
                .prepare_cached(&format!(
                    "UPDATE messages
                     SET text = CASE WHEN {edits} THEN ?3 ELSE text END,
                         edited_at = CASE WHEN {edits} THEN ?4 ELSE edited_at END
                     WHERE peer = ?1 AND id = ?2"
                ))?
                .execute(params![peer.as_str(), id.as_str(), text, edited_at.0, author.as_str()])?;
            if *mine && changed == 0 {
                tx.prepare_cached(
                    "UPDATE sent SET text = ?3, edited_at = ?4 WHERE peer = ?1 AND id = ?2",
                )?
                .execute(params![peer.as_str(), id.as_str(), text, edited_at.0])?;
            }
        }
        StoreOp::SetReaction {
            peer,
            id,
            emoji,
            by,
            add,
        } => {
            for table in [Table::Messages, Table::Sent] {
                if let Some(mut reactions) = reactions_of(tx, table, peer, id)? {
                    codec::react(&mut reactions, emoji, by, *add);
                    set_reactions(tx, table, peer, id, &reactions)?;
                    break;
                }
            }
        }
        StoreOp::PutReactions {
            peer,
            id,
            reactions,
        } => {
            if !set_reactions(tx, Table::Messages, peer, id, reactions)? {
                set_reactions(tx, Table::Sent, peer, id, reactions)?;
            }
        }
        StoreOp::RemoveMessages { peer, ids } => {
            // Queue rows are not touched: a delete names what the server has.
            let mut messages =
                tx.prepare_cached("DELETE FROM messages WHERE peer = ?1 AND id = ?2")?;
            let mut sent = tx.prepare_cached("DELETE FROM sent WHERE peer = ?1 AND id = ?2")?;
            for id in ids {
                messages.execute(params![peer.as_str(), id.as_str()])?;
                sent.execute(params![peer.as_str(), id.as_str()])?;
            }
        }
        StoreOp::PutBackfill(b) => put_backfill(tx, b)?,
        StoreOp::DropBackfill(peer) => {
            tx.prepare_cached("DELETE FROM backfill WHERE peer = ?1")?
                .execute([peer.as_str()])?;
        }
        StoreOp::PutOwnRead(r) => put_own_read(tx, r)?,
        StoreOp::PutAck(a) => put_ack(tx, a)?,
        StoreOp::DropAck(peer) => {
            tx.prepare_cached("DELETE FROM acks WHERE peer = ?1")?
                .execute([peer.as_str()])?;
        }
        StoreOp::Unseal(m) => unseal(tx, m)?,
        StoreOp::PutCryptoAccount(pickle) => {
            tx.prepare_cached(
                "INSERT INTO crypto_account (only, pickle) VALUES (0, ?1)
                 ON CONFLICT (only) DO UPDATE SET pickle = excluded.pickle",
            )?
            .execute([pickle.expose()])?;
        }
        StoreOp::PutOlmChannel(c) => put_channel(tx, c)?,
        StoreOp::PutOutboundGroup(g) => {
            tx.prepare_cached(
                "INSERT INTO outbound_groups (peer, pickle) VALUES (?1, ?2)
                 ON CONFLICT (peer) DO UPDATE SET pickle = excluded.pickle",
            )?
            .execute(params![g.peer.as_str(), g.pickle.expose()])?;
        }
        StoreOp::PutInboundGroup(g) => put_inbound(tx, g)?,
        StoreOp::PutToDevice(t) => put_to_device(tx, t)?,
        StoreOp::DropToDevice(id) => {
            tx.prepare_cached("DELETE FROM to_device WHERE id = ?1")?
                .execute([id])?;
        }
        StoreOp::MarkEncrypted(peer) => {
            tx.prepare_cached("INSERT OR IGNORE INTO encrypted (peer) VALUES (?1)")?
                .execute([peer.as_str()])?;
        }
        StoreOp::PutPeerIdentity(tailchat_core::PeerIdentity {
            peer,
            master_key,
            verified,
        }) => {
            tx.prepare_cached(
                "INSERT INTO peer_identities (peer, master_key, verified) VALUES (?1, ?2, ?3)
                 ON CONFLICT (peer) DO UPDATE SET
                     master_key = excluded.master_key, verified = excluded.verified",
            )?
            .execute(params![peer.as_str(), master_key, *verified])?;
        }
        StoreOp::PutBackupKey(pickle) => {
            tx.prepare_cached(
                "INSERT INTO backup_key (only, pickle) VALUES (0, ?1)
                 ON CONFLICT (only) DO UPDATE SET pickle = excluded.pickle",
            )?
            .execute([pickle.expose()])?;
        }
    }
    Ok(())
}

/// The two tables whose rows carry reactions.
#[derive(Clone, Copy)]
enum Table {
    /// Conversation rows.
    Messages,
    /// Committed outgoing rows.
    Sent,
}

impl Table {
    /// Reads the reactions of one row.
    fn select(self) -> &'static str {
        match self {
            Self::Messages => "SELECT reactions FROM messages WHERE peer = ?1 AND id = ?2",
            Self::Sent => "SELECT reactions FROM sent WHERE peer = ?1 AND id = ?2",
        }
    }

    /// Replaces the reactions of one row.
    fn update(self) -> &'static str {
        match self {
            Self::Messages => "UPDATE messages SET reactions = ?3 WHERE peer = ?1 AND id = ?2",
            Self::Sent => "UPDATE sent SET reactions = ?3 WHERE peer = ?1 AND id = ?2",
        }
    }

    /// Its name, for errors.
    fn name(self) -> &'static str {
        match self {
            Self::Messages => "messages",
            Self::Sent => "sent",
        }
    }
}

/// The reactions on `(peer, id)` in `table`; `None` when there is no such row.
fn reactions_of(
    tx: &Transaction<'_>,
    table: Table,
    peer: &Login,
    id: &MessageId,
) -> Result<Option<Vec<Reaction>>, Error> {
    let raw: Option<String> = tx
        .prepare_cached(table.select())?
        .query_row(params![peer.as_str(), id.as_str()], |row| row.get(0))
        .optional()?;
    raw.map(|raw| codec::reactions(table.name(), &raw))
        .transpose()
}

/// Replaces the reactions on `(peer, id)` in `table`; `false` when there is
/// no such row.
fn set_reactions(
    tx: &Transaction<'_>,
    table: Table,
    peer: &Login,
    id: &MessageId,
    reactions: &[Reaction],
) -> Result<bool, Error> {
    let json = codec::reactions_json(reactions)?;
    let changed =
        tx.prepare_cached(table.update())?
            .execute(params![peer.as_str(), id.as_str(), json])?;
    Ok(changed > 0)
}

/// Upserts a queue row and moves it to the end of the queue order.
fn put_pending(tx: &Transaction<'_>, row: &PendingOutgoing) -> Result<(), Error> {
    let m = &row.message;
    let (seal, dev, sid, ct) = seal_columns(&row.seal);
    let (image_url, image_width, image_height) = image_columns(m);
    let extra = codec::extra_json(&m.extra)?;
    tx.prepare_cached(
        "INSERT INTO pending (peer, id, ts, text, receipt,
                              image_url, image_width, image_height,
                              attempts, next_attempt_at,
                              seal, seal_dev, seal_sid, seal_ct, ord, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 (SELECT coalesce(max(ord), 0) + 1 FROM pending), ?15)
         ON CONFLICT (peer, id) DO UPDATE SET
             extra = excluded.extra,
             ts = excluded.ts, text = excluded.text, receipt = excluded.receipt,
             image_url = excluded.image_url,
             image_width = excluded.image_width,
             image_height = excluded.image_height,
             attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
             seal = excluded.seal, seal_dev = excluded.seal_dev,
             seal_sid = excluded.seal_sid, seal_ct = excluded.seal_ct,
             ord = excluded.ord",
    )?
    .execute(params![
        m.peer.as_str(),
        m.id.as_str(),
        m.ts.0,
        m.text,
        receipt_text(m.receipt),
        image_url,
        image_width,
        image_height,
        i64::from(row.attempts),
        row.next_attempt_at.0,
        seal,
        dev,
        sid,
        ct,
        extra
    ])?;
    Ok(())
}

/// The three picture columns of an outgoing row.
fn image_columns(m: &Outgoing) -> (Option<&str>, Option<i64>, Option<i64>) {
    match &m.image {
        Some(image) => (Some(image.data_url.as_str()), image.width, image.height),
        None => (None, None, None),
    }
}

/// New content for a stored conversation row; reactions and edit time stay.
fn unseal(tx: &Transaction<'_>, m: &Message) -> Result<(), Error> {
    let image = m.image.as_ref();
    let voice = m.voice.as_ref();
    let reply = m.reply_to.as_ref();
    let forwarded = m.forwarded_from.as_ref();
    let (protection, dev, sid, ct) = protection_columns(&m.protection);
    tx.prepare_cached(
        "UPDATE messages SET text = ?3, author = ?4,
             image_url = ?5, image_width = ?6, image_height = ?7,
             voice_url = ?8, voice_duration = ?9,
             reply_id = ?10, reply_from = ?11, reply_text = ?12, reply_media = ?13,
             forwarded = ?14, forwarded_login = ?15, forwarded_name = ?16,
             buttons = ?17, protection = ?18, env_dev = ?19, env_sid = ?20, env_ct = ?21,
             edit_of = ?22, voice_wave = ?23
         WHERE peer = ?1 AND id = ?2",
    )?
    .execute(params![
        m.peer.as_str(),
        m.id.as_str(),
        m.text,
        m.author,
        image.map(|i| i.data_url.as_str()),
        image.and_then(|i| i.width),
        image.and_then(|i| i.height),
        voice.map(|v| v.data_url.as_str()),
        voice.and_then(|v| v.duration),
        reply.map(|r| r.id.as_str()),
        reply.map(|r| r.from.as_str()),
        reply.map(|r| r.text.as_str()),
        reply.and_then(|r| r.media).map(media_text),
        forwarded.is_some(),
        forwarded.and_then(|f| f.login.as_ref()).map(Login::as_str),
        forwarded.and_then(|f| f.name.as_deref()),
        codec::buttons_json(&m.buttons)?,
        protection,
        dev,
        sid,
        ct,
        m.edit_of.as_ref().map(MessageId::as_str),
        codec::waveform_json(voice.and_then(|v| v.waveform.as_ref()))
    ])?;
    Ok(())
}

/// Upserts one Olm channel.
fn put_channel(tx: &Transaction<'_>, c: &OlmChannelRow) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO olm_channels (login, device, pickle) VALUES (?1, ?2, ?3)
         ON CONFLICT (login, device) DO UPDATE SET pickle = excluded.pickle",
    )?
    .execute(params![c.login.as_str(), c.device, c.pickle.expose()])?;
    Ok(())
}

/// Upserts one reading session.
fn put_inbound(tx: &Transaction<'_>, g: &InboundRow) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO inbound_groups (sender, device, session, pickle) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (sender, device, session) DO UPDATE SET pickle = excluded.pickle",
    )?
    .execute(params![
        g.sender.as_str(),
        g.device,
        g.session,
        g.pickle.expose()
    ])?;
    Ok(())
}

/// Upserts a key message and moves it to the end of its queue.
fn put_to_device(tx: &Transaction<'_>, t: &PendingToDevice) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO to_device (id, recipient, device, body, ord)
         VALUES (?1, ?2, ?3, ?4, (SELECT coalesce(max(ord), 0) + 1 FROM to_device))
         ON CONFLICT (id) DO UPDATE SET
             recipient = excluded.recipient, device = excluded.device,
             body = excluded.body, ord = excluded.ord",
    )?
    .execute(params![t.id, t.to.as_str(), t.device, t.body])?;
    Ok(())
}

/// Upserts one conversation's receipt positions.
fn put_receipts(tx: &Transaction<'_>, r: &PeerReceipts) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO peer_receipts (peer, delivered_ts, read_ts) VALUES (?1, ?2, ?3)
         ON CONFLICT (peer) DO UPDATE SET
             delivered_ts = excluded.delivered_ts, read_ts = excluded.read_ts",
    )?
    .execute(params![
        r.peer.as_str(),
        r.delivered_ts.map(|t| t.0),
        r.read_ts.map(|t| t.0)
    ])?;
    Ok(())
}

/// Inserts or replaces a whole conversation row, reactions included.
fn put_message(tx: &Transaction<'_>, m: &Message) -> Result<(), Error> {
    let image = m.image.as_ref();
    let voice = m.voice.as_ref();
    let reply = m.reply_to.as_ref();
    let forwarded = m.forwarded_from.as_ref();
    let (protection, dev, sid, ct) = protection_columns(&m.protection);
    tx.prepare_cached(
        "INSERT OR REPLACE INTO messages (
             peer, id, sender, ts, kind, text, author,
             image_url, image_width, image_height, voice_url, voice_duration,
             reply_id, reply_from, reply_text, reply_media,
             forwarded, forwarded_login, forwarded_name,
             buttons, media_dropped, edited_at, reactions,
             protection, env_dev, env_sid, env_ct, edit_of, voice_wave)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
                 ?24, ?25, ?26, ?27, ?28, ?29)",
    )?
    .execute(params![
        m.peer.as_str(),
        m.id.as_str(),
        m.from.as_str(),
        m.ts.0,
        kind_text(m.kind),
        m.text,
        m.author,
        image.map(|i| i.data_url.as_str()),
        image.and_then(|i| i.width),
        image.and_then(|i| i.height),
        voice.map(|v| v.data_url.as_str()),
        voice.and_then(|v| v.duration),
        reply.map(|r| r.id.as_str()),
        reply.map(|r| r.from.as_str()),
        reply.map(|r| r.text.as_str()),
        reply.and_then(|r| r.media).map(media_text),
        forwarded.is_some(),
        forwarded.and_then(|f| f.login.as_ref()).map(Login::as_str),
        forwarded.and_then(|f| f.name.as_deref()),
        codec::buttons_json(&m.buttons)?,
        m.media_dropped,
        m.edited_at.map(|t| t.0),
        codec::reactions_json(&m.reactions)?,
        protection,
        dev,
        sid,
        ct,
        m.edit_of.as_ref().map(MessageId::as_str),
        codec::waveform_json(voice.and_then(|v| v.waveform.as_ref()))
    ])?;
    Ok(())
}

/// Upserts one conversation's history debt.
fn put_backfill(tx: &Transaction<'_>, b: &Backfill) -> Result<(), Error> {
    let (reseed, below_id, below_ts) = match &b.reseed {
        None => (None, None, None),
        Some(WalkFrom::Newest) => (Some("newest"), None, None),
        Some(WalkFrom::Below(below)) => (Some("below"), Some(below.id.as_str()), Some(below.ts.0)),
    };
    tx.prepare_cached(
        "INSERT INTO backfill (peer, owed, reseed, below_id, below_ts) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (peer) DO UPDATE SET
             owed = excluded.owed, reseed = excluded.reseed,
             below_id = excluded.below_id, below_ts = excluded.below_ts",
    )?
    .execute(params![
        b.peer.as_str(),
        codec::ids_json(&b.owed)?,
        reseed,
        below_id,
        below_ts
    ])?;
    Ok(())
}

/// Upserts how far this account has read one conversation.
fn put_own_read(tx: &Transaction<'_>, r: &OwnRead) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO own_reads (peer, read_ts) VALUES (?1, ?2)
         ON CONFLICT (peer) DO UPDATE SET read_ts = excluded.read_ts",
    )?
    .execute(params![r.peer.as_str(), r.read_ts.0])?;
    Ok(())
}

/// Upserts the delivery receipt owed to one peer.
fn put_ack(tx: &Transaction<'_>, a: &OwedAck) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO acks (peer, id, ts) VALUES (?1, ?2, ?3)
         ON CONFLICT (peer) DO UPDATE SET id = excluded.id, ts = excluded.ts",
    )?
    .execute(params![a.peer.as_str(), a.id.as_str(), a.ts.0])?;
    Ok(())
}
