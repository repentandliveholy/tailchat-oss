//! Reading back: the `Snapshot` the core restarts from, and the rows the UI
//! re-reads after `Event::MessageStored`.

use rusqlite::{Connection, OptionalExtension, Row, params};
use tailchat_core::frames::inner::{Forwarded, Image, Reply, Voice};
use tailchat_core::{
    Backfill, Below, Envelope, Held, InboundRow, Login, Message, MessageId, OlmChannelRow,
    OutboundRow, Outgoing, OwedAck, OwnRead, PeerIdentity, PeerReceipts, PendingOutgoing,
    PendingToDevice, SealedRow, Secret, Seq, Snapshot, Ts, WalkFrom,
};
use zeroize::Zeroizing;

use crate::codec::{self, corrupt, login, message_id};
use crate::{Error, Row as ConversationRow, Sent};

/// Everything the core needs after a restart, read in one transaction so the
/// tables agree with each other.
pub(crate) fn snapshot(conn: &Connection) -> Result<Snapshot, Error> {
    let tx = conn.unchecked_transaction()?;
    let cursor = tx
        .query_row("SELECT seq FROM cursor WHERE only = 0", [], |row| {
            row.get(0)
        })
        .optional()?
        .map_or(Seq::default(), Seq);

    let mut pending = Vec::new();
    let mut stmt = tx.prepare(&format!(
        "SELECT {PENDING_COLUMNS} FROM pending ORDER BY ord"
    ))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        pending.push(pending_row(row)?);
    }

    let mut sent = Vec::new();
    let mut sent_held = Vec::new();
    let mut stmt = tx.prepare(
        "SELECT peer, id, ts, text, receipt, image_url, image_width, image_height,
                edited_at, reactions, extra
         FROM sent ORDER BY ord",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let m = outgoing("sent", row, 10)?;
        sent_held.push(Held {
            peer: m.peer.clone(),
            id: m.id.clone(),
            edited_at: row.get::<_, Option<i64>>(8)?.map(Ts),
        });
        sent.push(m);
    }

    let mut receipts = Vec::new();
    let mut stmt =
        tx.prepare("SELECT peer, delivered_ts, read_ts FROM peer_receipts ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        receipts.push(PeerReceipts {
            peer: login("peer_receipts", &row.get::<_, String>(0)?)?,
            delivered_ts: row.get::<_, Option<i64>>(1)?.map(Ts),
            read_ts: row.get::<_, Option<i64>>(2)?.map(Ts),
        });
    }

    // Conversation rows first, by key, then committed outgoing rows: the
    // order `MemStore` lists them in.
    let mut held = Vec::new();
    let mut stmt = tx.prepare("SELECT peer, id, edited_at FROM messages ORDER BY peer, id")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        held.push(Held {
            peer: login("messages", &row.get::<_, String>(0)?)?,
            id: message_id("messages", &row.get::<_, String>(1)?)?,
            edited_at: row.get::<_, Option<i64>>(2)?.map(Ts),
        });
    }
    held.append(&mut sent_held);

    let mut backfill = Vec::new();
    let mut stmt =
        tx.prepare("SELECT peer, owed, reseed, below_id, below_ts FROM backfill ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let reseed = match row.get::<_, Option<String>>(2)?.as_deref() {
            None => None,
            Some("newest") => Some(WalkFrom::Newest),
            Some("below") => {
                let id: Option<String> = row.get(3)?;
                let ts: Option<i64> = row.get(4)?;
                match (id, ts) {
                    (Some(id), Some(ts)) => Some(WalkFrom::Below(Below {
                        id: message_id("backfill", &id)?,
                        ts: Ts(ts),
                    })),
                    _ => return Err(corrupt("backfill", "reseed below without a position")),
                }
            }
            Some(_) => return Err(corrupt("backfill", "bad reseed")),
        };
        backfill.push(Backfill {
            peer: login("backfill", &row.get::<_, String>(0)?)?,
            owed: codec::ids(&row.get::<_, String>(1)?)?,
            reseed,
        });
    }

    let mut own_reads = Vec::new();
    let mut stmt = tx.prepare("SELECT peer, read_ts FROM own_reads ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        own_reads.push(OwnRead {
            peer: login("own_reads", &row.get::<_, String>(0)?)?,
            read_ts: Ts(row.get(1)?),
        });
    }

    let mut acks = Vec::new();
    let mut stmt = tx.prepare("SELECT peer, id, ts FROM acks ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        acks.push(OwedAck {
            peer: login("acks", &row.get::<_, String>(0)?)?,
            id: message_id("acks", &row.get::<_, String>(1)?)?,
            ts: Ts(row.get(2)?),
        });
    }

    let crypto_account = tx
        .query_row(
            "SELECT pickle FROM crypto_account WHERE only = 0",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(secret);

    let mut olm_channels = Vec::new();
    let mut stmt =
        tx.prepare("SELECT login, device, pickle FROM olm_channels ORDER BY login, device")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        olm_channels.push(OlmChannelRow {
            login: login("olm_channels", &row.get::<_, String>(0)?)?,
            device: row.get(1)?,
            pickle: secret(row.get(2)?),
        });
    }

    let mut outbound_groups = Vec::new();
    let mut stmt = tx.prepare("SELECT peer, pickle FROM outbound_groups ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        outbound_groups.push(OutboundRow {
            peer: login("outbound_groups", &row.get::<_, String>(0)?)?,
            pickle: secret(row.get(1)?),
        });
    }

    let mut inbound_groups = Vec::new();
    let mut stmt = tx.prepare(
        "SELECT sender, device, session, pickle FROM inbound_groups
         ORDER BY sender, device, session",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        inbound_groups.push(InboundRow {
            sender: login("inbound_groups", &row.get::<_, String>(0)?)?,
            device: row.get(1)?,
            session: row.get(2)?,
            pickle: secret(row.get(3)?),
        });
    }

    let mut to_device = Vec::new();
    let mut stmt = tx.prepare("SELECT id, recipient, device, body FROM to_device ORDER BY ord")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        to_device.push(PendingToDevice {
            id: row.get(0)?,
            to: login("to_device", &row.get::<_, String>(1)?)?,
            device: row.get(2)?,
            body: row.get(3)?,
        });
    }

    let mut encrypted = Vec::new();
    let mut stmt = tx.prepare("SELECT peer FROM encrypted ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        encrypted.push(login("encrypted", &row.get::<_, String>(0)?)?);
    }

    let mut sealed = Vec::new();
    let mut stmt = tx.prepare(
        "SELECT peer, id, sender, ts, kind, env_dev, env_sid, env_ct FROM messages
         WHERE protection = 'waiting' ORDER BY peer, id",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        sealed.push(SealedRow {
            peer: login("messages", &row.get::<_, String>(0)?)?,
            id: message_id("messages", &row.get::<_, String>(1)?)?,
            from: login("messages", &row.get::<_, String>(2)?)?,
            ts: Ts(row.get(3)?),
            kind: codec::kind(&row.get::<_, String>(4)?)?,
            envelope: Envelope {
                dev: row.get(5)?,
                sid: row.get(6)?,
                ct: row.get(7)?,
            },
        });
    }
    let mut peer_identities = Vec::new();
    let mut stmt =
        tx.prepare("SELECT peer, master_key, verified FROM peer_identities ORDER BY peer")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        peer_identities.push(PeerIdentity {
            peer: login("peer_identities", &row.get::<_, String>(0)?)?,
            master_key: row.get(1)?,
            verified: row.get(2)?,
        });
    }
    let backup_key = tx
        .query_row("SELECT pickle FROM backup_key WHERE only = 0", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .map(secret);

    Ok(Snapshot {
        cursor,
        pending,
        sent,
        receipts,
        held,
        backfill,
        own_reads,
        acks,
        crypto_account,
        olm_channels,
        outbound_groups,
        inbound_groups,
        to_device,
        encrypted,
        sealed,
        peer_identities,
        backup_key,
    })
}

/// A pickle read back, wrapped before anything else can copy it. The
/// `String` rusqlite made is the one wiped; SQLite's own page cache is not
/// ours to wipe (SQLCipher keeps it encrypted on disk).
fn secret(raw: String) -> Secret {
    Secret::new(Zeroizing::new(raw))
}

/// The queue columns `pending_row` reads, in its order.
const PENDING_COLUMNS: &str = "peer, id, ts, text, receipt, image_url, image_width, image_height,
     attempts, next_attempt_at, seal, seal_dev, seal_sid, seal_ct, extra";

/// `peer, id, ts, text, receipt, image_url, image_width, image_height` as the
/// first eight columns of `row`, and its `extra` column at index `extra`.
fn outgoing(table: &'static str, row: &Row<'_>, extra: usize) -> Result<Outgoing, Error> {
    let image = match row.get::<_, Option<String>>(5)? {
        Some(data_url) => Some(Image {
            data_url,
            width: row.get(6)?,
            height: row.get(7)?,
        }),
        None => None,
    };
    Ok(Outgoing {
        extra: codec::extra(table, row.get::<_, Option<String>>(extra)?.as_deref())?,
        peer: login(table, &row.get::<_, String>(0)?)?,
        id: message_id(table, &row.get::<_, String>(1)?)?,
        ts: Ts(row.get(2)?),
        text: row.get(3)?,
        image,
        receipt: codec::receipt(table, &row.get::<_, String>(4)?)?,
    })
}

fn pending_row(row: &Row<'_>) -> Result<PendingOutgoing, Error> {
    let attempts: i64 = row.get(8)?;
    Ok(PendingOutgoing {
        message: outgoing("pending", row, 14)?,
        attempts: u8::try_from(attempts).map_err(|_| corrupt("pending", "bad attempts"))?,
        next_attempt_at: Ts(row.get(9)?),
        seal: codec::seal(row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?)?,
    })
}

/// Reads one page in a single snapshot, resolving duplicates before paging.
pub(crate) fn conversation(
    conn: &Connection,
    peer: &Login,
    before: Option<(Ts, &MessageId)>,
    limit: usize,
) -> Result<Vec<ConversationRow>, Error> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "SELECT source, id FROM (
            SELECT 0 AS source, id, ts FROM sent WHERE peer = ?1
            UNION ALL
            SELECT 1, m.id, m.ts FROM messages m WHERE m.peer = ?1
                AND NOT EXISTS (SELECT 1 FROM sent s WHERE s.peer = m.peer AND s.id = m.id)
            UNION ALL
            SELECT 2, p.id, p.ts FROM pending p WHERE p.peer = ?1
                AND NOT EXISTS (SELECT 1 FROM sent s WHERE s.peer = p.peer AND s.id = p.id)
                AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.peer = p.peer AND m.id = p.id)
        ) WHERE ?2 IS NULL OR (ts, id) < (?2, ?3)
        ORDER BY ts DESC, id DESC LIMIT ?4",
    )?;
    let mut rows = stmt.query(params![
        peer.as_str(),
        before.map(|(ts, _)| ts.0),
        before.map(|(_, id)| id.as_str()),
        i64::try_from(limit).unwrap_or(i64::MAX),
    ])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let source: i64 = row.get(0)?;
        let id = message_id("conversation", &row.get::<_, String>(1)?)?;
        let value = match source {
            0 => sent(&tx, peer, &id)?.map(ConversationRow::Sent),
            1 => message(&tx, peer, &id)?.map(ConversationRow::Message),
            2 => {
                let mut stmt = tx.prepare_cached(&format!(
                    "SELECT {PENDING_COLUMNS} FROM pending WHERE peer = ?1 AND id = ?2"
                ))?;
                let mut pending = stmt.query(params![peer.as_str(), id.as_str()])?;
                pending
                    .next()?
                    .map(pending_row)
                    .transpose()?
                    .map(ConversationRow::Pending)
            }
            _ => return Err(corrupt("conversation", "bad source")),
        };
        result.push(value.ok_or_else(|| corrupt("conversation", "missing row"))?);
    }
    result.reverse();
    Ok(result)
}

/// The queued outgoing row `(peer, id)`.
pub(crate) fn pending(
    conn: &Connection,
    peer: &Login,
    id: &MessageId,
) -> Result<Option<PendingOutgoing>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PENDING_COLUMNS} FROM pending WHERE peer = ?1 AND id = ?2"
    ))?;
    let mut rows = stmt.query(params![peer.as_str(), id.as_str()])?;
    rows.next()?.map(pending_row).transpose()
}

/// The conversation row `(peer, id)`, body and reactions included.
pub(crate) fn message(
    conn: &Connection,
    peer: &Login,
    id: &MessageId,
) -> Result<Option<Message>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT sender, ts, kind, text, author,
                image_url, image_width, image_height, voice_url, voice_duration,
                reply_id, reply_from, reply_text, reply_media,
                forwarded, forwarded_login, forwarded_name,
                buttons, media_dropped, edited_at, reactions,
                protection, env_dev, env_sid, env_ct, edit_of, voice_wave
         FROM messages WHERE peer = ?1 AND id = ?2",
    )?;
    let mut rows = stmt.query(params![peer.as_str(), id.as_str()])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let image = match row.get::<_, Option<String>>(5)? {
        Some(data_url) => Some(Image {
            data_url,
            width: row.get(6)?,
            height: row.get(7)?,
        }),
        None => None,
    };
    let voice = match row.get::<_, Option<String>>(8)? {
        Some(data_url) => Some(Voice {
            waveform: codec::waveform(row.get::<_, Option<String>>(26)?.as_deref())?,
            data_url,
            duration: row.get(9)?,
        }),
        None => None,
    };
    let reply_to = match (
        row.get::<_, Option<String>>(10)?,
        row.get::<_, Option<String>>(11)?,
    ) {
        (Some(reply_id), Some(from)) => Some(Reply {
            id: message_id("messages", &reply_id)?,
            from: login("messages", &from)?,
            text: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
            media: row
                .get::<_, Option<String>>(13)?
                .as_deref()
                .map(codec::media)
                .transpose()?,
        }),
        (None, None) => None,
        _ => return Err(corrupt("messages", "half a reply")),
    };
    let forwarded_from = if row.get(14)? {
        Some(Forwarded {
            login: row
                .get::<_, Option<String>>(15)?
                .as_deref()
                .map(|raw| login("messages", raw))
                .transpose()?,
            name: row.get(16)?,
        })
    } else {
        None
    };
    Ok(Some(Message {
        edit_of: row
            .get::<_, Option<String>>(25)?
            .map(|raw| message_id("messages", &raw))
            .transpose()?,
        peer: peer.clone(),
        id: id.clone(),
        from: login("messages", &row.get::<_, String>(0)?)?,
        ts: Ts(row.get(1)?),
        kind: codec::kind(&row.get::<_, String>(2)?)?,
        text: row.get(3)?,
        author: row.get(4)?,
        image,
        voice,
        reply_to,
        forwarded_from,
        buttons: codec::buttons(&row.get::<_, String>(17)?)?,
        media_dropped: row.get(18)?,
        edited_at: row.get::<_, Option<i64>>(19)?.map(Ts),
        reactions: codec::reactions("messages", &row.get::<_, String>(20)?)?,
        protection: codec::protection(
            &row.get::<_, String>(21)?,
            row.get(22)?,
            row.get(23)?,
            row.get(24)?,
        )?,
    }))
}

/// The committed outgoing row `(peer, id)`, with what it collected since.
pub(crate) fn sent(conn: &Connection, peer: &Login, id: &MessageId) -> Result<Option<Sent>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT peer, id, ts, text, receipt, image_url, image_width, image_height,
                edited_at, reactions, extra
         FROM sent WHERE peer = ?1 AND id = ?2",
    )?;
    let mut rows = stmt.query(params![peer.as_str(), id.as_str()])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(Sent {
        message: outgoing("sent", row, 10)?,
        edited_at: row.get::<_, Option<i64>>(8)?.map(Ts),
        reactions: codec::reactions("sent", &row.get::<_, String>(9)?)?,
    }))
}
