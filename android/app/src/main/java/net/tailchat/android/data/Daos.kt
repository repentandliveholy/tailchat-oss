package net.tailchat.android.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * [DeliveryState] ordinals as compile-time constants: SQL cannot read a Kotlin
 * enum, and the monotonic rule below has to name the states it treats
 * specially. `ChatRepositoryTest` pins these to the enum.
 */
const val DELIVERY_ACCEPTED = 2
const val DELIVERY_DELIVERED = 3
const val DELIVERY_READ = 4
const val DELIVERY_FAILED = 5

/** `nextAttemptAt` of a parked operation — see [PendingOperationDao.park]. */
const val NEVER_DUE = Long.MAX_VALUE

@Dao
interface AccountDao {
    @Upsert
    suspend fun upsert(account: AccountEntity)

    @Query("SELECT * FROM accounts WHERE accountKey = :accountKey")
    suspend fun find(accountKey: String): AccountEntity?

    @Query("DELETE FROM accounts WHERE accountKey = :accountKey")
    suspend fun delete(accountKey: String)
}

@Dao
interface ConversationDao {
    /** Newest conversation first; `peer` only breaks ties so the list order is
     *  stable between two emissions with identical timestamps. */
    @Query("SELECT * FROM conversations WHERE accountKey = :accountKey ORDER BY previewTs DESC, peer ASC")
    fun observe(accountKey: String): Flow<List<ConversationEntity>>

    /** Every row as it stands, for the prefetch walk in `SyncEngine`: it needs
     *  the whole roster in one read, not a subscription it would have to keep
     *  and tear down. */
    @Query("SELECT * FROM conversations WHERE accountKey = :accountKey")
    suspend fun all(accountKey: String): List<ConversationEntity>

    @Query("SELECT * FROM conversations WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun find(accountKey: String, peer: String): ConversationEntity?

    @Upsert
    suspend fun upsert(conversation: ConversationEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfAbsent(conversation: ConversationEntity): Long

    /** Only forwards: a roster or history page full of old rows must not
     *  overwrite the preview with something the user already scrolled past. */
    @Query(
        """UPDATE conversations
           SET previewFrom = :from, previewText = :text, previewMedia = :media,
               previewTs = :ts, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer AND previewTs <= :ts""",
    )
    suspend fun updatePreview(
        accountKey: String,
        peer: String,
        from: String?,
        text: String?,
        media: String?,
        ts: Long,
        now: Long,
    )

    /** Roster metadata only. `historySeeded`, the preview and the transcript
     *  are local knowledge the roster envelope knows nothing about. */
    @Query(
        """UPDATE conversations SET name = :name, alias = :alias, online = :online, lastSeen = :lastSeen,
               official = :official, blocked = :blocked, bot = :bot, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun updateRosterMeta(
        accountKey: String,
        peer: String,
        name: String,
        alias: String?,
        online: Boolean,
        lastSeen: Long?,
        official: Boolean,
        blocked: Boolean,
        bot: Boolean,
        now: Long,
    )

    /** This account's own nickname for one contact (issue #28) — written both by
     *  the roster envelope and by [net.tailchat.android.cloud.CloudController.renameContact]'s
     *  optimistic local apply. */
    @Query(
        """UPDATE conversations SET alias = :alias, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun setAlias(accountKey: String, peer: String, alias: String?, now: Long)

    @Query(
        """UPDATE conversations SET online = :online, lastSeen = COALESCE(:lastSeen, lastSeen), updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun setPresence(accountKey: String, peer: String, online: Boolean, lastSeen: Long?, now: Long)

    @Query("UPDATE conversations SET unread = :unread, updatedAt = :now WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun setUnread(accountKey: String, peer: String, unread: Int, now: Long)

    @Query(
        """UPDATE conversations SET unread = unread + :delta, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun addUnread(accountKey: String, peer: String, delta: Int, now: Long)

    @Query(
        """UPDATE conversations SET readWatermarkTs = MAX(readWatermarkTs, :ts), updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun bumpReadWatermark(accountKey: String, peer: String, ts: Long, now: Long)

    /**
     * How far the *peer* has read this conversation — the other monotone
     * watermark, answering the opposite question from [bumpReadWatermark].
     *
     * Kept apart from [markSeeded] on purpose. That one is the history path
     * (it also flags the transcript as loaded, which is what its callers have
     * just proved); a receipt only ever says what the other side read, and
     * writing `historySeeded` from it claimed this device held a conversation
     * it had never fetched. That single conflation is how a read receipt could
     * stand in for a history page.
     */
    @Query(
        """UPDATE conversations
           SET peerReadTs = MAX(peerReadTs, :ts),
               peerReadAt = CASE WHEN :ts >= peerReadTs THEN :readAt ELSE peerReadAt END,
               peerReadVia = CASE WHEN :ts >= peerReadTs THEN :via ELSE peerReadVia END,
               updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun bumpPeerReadWatermark(
        accountKey: String,
        peer: String,
        ts: Long,
        readAt: Long,
        via: String,
        now: Long,
    )

    /**
     * How far the peer's *device* holds this conversation — the delivered
     * twin of [bumpPeerReadWatermark], and the rung directly below it.
     *
     * Only ever forwards, like both read watermarks: a duplicate `ack` drained
     * out of order, or a reconnect replaying an older frame, must not pull the
     * mark back and turn a ✓✓ into a ✓. Nothing but `peerDeliveredTs` moves
     * here — this watermark says what the peer's device holds and, unlike
     * [bumpPeerReadWatermark], never that anyone read anything.
     */
    @Query(
        """UPDATE conversations SET peerDeliveredTs = MAX(peerDeliveredTs, :ts), updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun bumpPeerDeliveredWatermark(accountKey: String, peer: String, ts: Long, now: Long)

    /** The outstanding backfill obligation of one conversation — see
     *  [net.tailchat.android.data.ConversationEntity.backfillJson]. */
    @Query("SELECT backfillJson FROM conversations WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun backfillOf(accountKey: String, peer: String): String?

    @Query(
        """UPDATE conversations SET backfillJson = :json, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun setBackfill(accountKey: String, peer: String, json: String?, now: Long)

    /** Every conversation still owing a fetch, newest activity first so a gap
     *  in the thread the user is most likely to open closes first. */
    @Query(
        """SELECT peer FROM conversations
           WHERE accountKey = :accountKey AND backfillJson IS NOT NULL AND backfillJson != '[]'
           ORDER BY previewTs DESC, peer ASC""",
    )
    suspend fun peersWithBackfill(accountKey: String): List<String>

    @Query(
        """UPDATE conversations
           SET peerReadTs = MAX(peerReadTs, :ts),
               peerReadAt = CASE WHEN :ts >= peerReadTs THEN :readAt ELSE peerReadAt END,
               peerReadVia = CASE WHEN :ts >= peerReadTs THEN :via ELSE peerReadVia END,
               historySeeded = 1,
               updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun markSeeded(
        accountKey: String,
        peer: String,
        ts: Long,
        readAt: Long,
        via: String,
        now: Long,
    )

    @Query(
        """UPDATE conversations SET historySeeded = 0, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer""",
    )
    suspend fun markUnseeded(accountKey: String, peer: String, now: Long)

    /** What a `reset:true` sync page means: every transcript on this device is
     *  now suspect and must be re-seeded before it can be trusted. */
    @Query("UPDATE conversations SET historySeeded = 0, updatedAt = :now WHERE accountKey = :accountKey")
    suspend fun markAllUnseeded(accountKey: String, now: Long)

    @Query("DELETE FROM conversations WHERE accountKey = :accountKey")
    suspend fun deleteAccount(accountKey: String)

    /** One contact gone, not the whole account — the deletion a roster row
     *  disappearing stands for. See `ChatRepository.purgeContact`, which is
     *  the only writer of it. */
    @Query("DELETE FROM conversations WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun deletePeer(accountKey: String, peer: String)

    /**
     * Creates the row if this is the first thing ever heard about the peer.
     * A conversation invented here is deliberately minimal — name = peer,
     * history not seeded — because the roster, not a message, is what knows
     * the display name, and claiming otherwise would show a login where a name
     * belongs until the next roster arrives.
     */
    @Transaction
    suspend fun touchPreview(
        accountKey: String,
        peer: String,
        from: String?,
        text: String?,
        media: String?,
        ts: Long,
        now: Long,
    ) {
        insertIfAbsent(blank(accountKey, peer, from, text, media, ts, now))
        updatePreview(accountKey, peer, from, text, media, ts, now)
    }

    companion object {
        fun blank(
            accountKey: String,
            peer: String,
            from: String? = null,
            text: String? = null,
            media: String? = null,
            ts: Long = 0L,
            now: Long = 0L,
        ) = ConversationEntity(
            accountKey = accountKey,
            peer = peer,
            name = peer,
            self = false,
            previewFrom = from,
            previewText = text,
            previewMedia = media,
            previewTs = ts,
            unread = 0,
            readWatermarkTs = 0L,
            peerReadTs = 0L,
            online = false,
            lastSeen = null,
            historySeeded = false,
            updatedAt = now,
            official = false,
            blocked = false,
            bot = false,
        )
    }
}

@Dao
interface MessageDao {
    /**
     * Newest first and bounded — the transcript is read from the bottom, and a
     * `SELECT *` over a two-year conversation is the kind of query that turns
     * opening a chat into a visible pause. The repository reverses the window
     * into display order.
     */
    @Query(
        """SELECT * FROM messages WHERE accountKey = :accountKey AND peer = :peer
           ORDER BY ts DESC, id DESC LIMIT :limit""",
    )
    fun observe(accountKey: String, peer: String, limit: Int): Flow<List<MessageEntity>>

    @Query(
        """SELECT * FROM messages WHERE accountKey = :accountKey AND peer = :peer AND ts < :beforeTs
           ORDER BY ts DESC, id DESC LIMIT :limit""",
    )
    suspend fun page(accountKey: String, peer: String, beforeTs: Long, limit: Int): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE accountKey = :accountKey AND peer = :peer AND id = :id")
    suspend fun find(accountKey: String, peer: String, id: String): MessageEntity?

    /** The newest row the `unread` envelope could be describing — same
     *  exclusions as a notification (own, system and tombstoned rows are not
     *  something to alert about), newest first, one row. */
    @Query(
        """SELECT id, ts FROM messages
           WHERE accountKey = :accountKey AND peer = :peer AND mine = 0 AND system = 0
             AND deletedAt IS NULL
           ORDER BY ts DESC, id DESC LIMIT 1""",
    )
    suspend fun newestIncoming(accountKey: String, peer: String): IncomingRef?

    @Query("SELECT COUNT(*) FROM messages WHERE accountKey = :accountKey AND peer = :peer AND id = :id")
    suspend fun count(accountKey: String, peer: String, id: String): Int

    @Query(
        """SELECT id, delivery, deletedAt, buttonsJson FROM messages
           WHERE accountKey = :accountKey AND peer = :peer AND id IN (:ids)""",
    )
    suspend fun localStates(accountKey: String, peer: String, ids: List<String>): List<DeliveryRow>

    /** [PendingOpRef]-style repair helper: which rows have media too big for
     *  any `SELECT *` on this table to return, without ever selecting that
     *  media itself. See `ChatRepository.repairOversizedRows`. */
    @Query(
        """SELECT peer, id, mine FROM messages
           WHERE accountKey = :accountKey
             AND (LENGTH(imageDataUrl) > :maxChars OR LENGTH(voiceDataUrl) > :maxChars)""",
    )
    suspend fun oversizedMediaRefs(accountKey: String, maxChars: Int): List<OversizedMediaRow>

    /** Drops just the media a repaired row can never have read back — the
     *  text, if any, is untouched, unlike the tombstone [applyDelete] leaves. */
    @Query(
        """UPDATE messages
           SET imageDataUrl = NULL, imageWidth = NULL, imageHeight = NULL,
               voiceDataUrl = NULL, voiceDurationSec = NULL
           WHERE accountKey = :accountKey AND peer = :peer AND id = :id""",
    )
    suspend fun clearOversizedMedia(accountKey: String, peer: String, id: String)

    /**
     * Everything incoming this conversation still owes a read receipt for.
     * Own messages are excluded (a device does not read itself) and so is
     * anything already at [DeliveryState.Read].
     *
     * That last part used to be a promise the code did not keep: incoming rows
     * are stored at [DELIVERY_ACCEPTED] and nothing ever moved them up, so this
     * query returned the *entire* incoming history of a conversation on every
     * reconnect and `flushReads` replayed it as receipts — a two-thousand
     * message thread was two thousand frames at 37.5 frames/second, well past
     * the hub's own ceiling, on every single connect. What closes the loop is
     * [markIncomingRead], called once a receipt has actually left the socket,
     * plus the `2 -> 3` migration that brings rows written before this existed
     * up to the conversation's read watermark.
     *
     * [limit] is the second half of the guarantee: oldest first, so a thread
     * with more unread rows than the bound still drains in order and a
     * pathological row count can never turn one reconnect into an unbounded
     * burst.
     */
    @Query(
        """SELECT id FROM messages
           WHERE accountKey = :accountKey AND peer = :peer AND mine = 0 AND system = 0
             AND delivery < $DELIVERY_READ
           ORDER BY ts ASC
           LIMIT :limit""",
    )
    suspend fun unreadIncoming(accountKey: String, peer: String, limit: Int): List<String>

    /** Only the bubbles a foreground transcript actually presented may earn
     *  automatic read receipts; a later stored row is not part of that view. */
    @Query(
        """SELECT id FROM messages
           WHERE accountKey = :accountKey AND peer = :peer AND id IN (:ids)
             AND mine = 0 AND system = 0 AND deletedAt IS NULL
             AND delivery < $DELIVERY_READ
           ORDER BY ts ASC, id ASC""",
    )
    suspend fun unreadIncomingAmong(accountKey: String, peer: String, ids: List<String>): List<String>

    /**
     * The receipt for these incoming rows has left the socket, so this device
     * is done with them: monotonic, `mine = 0` only, and scoped by message id
     * rather than by conversation because the queue that sent them spans peers.
     *
     * Deliberately *after* the send, not before: a row marked read is
     * permanently one this device will never mention again, and marking it
     * optimistically would turn a dropped frame into a lost receipt. The cost
     * of being honest is that a receipt written and then lost to a reconnect is
     * re-sent — bounded, because only rows the server was actually told about
     * are ever skipped
     */
    @Query(
        """UPDATE messages SET delivery = MAX(delivery, $DELIVERY_READ)
           WHERE accountKey = :accountKey AND mine = 0 AND id IN (:ids)""",
    )
    suspend fun markIncomingRead(accountKey: String, ids: List<String>)
    /**
     * Only a row the server committed ([DELIVERY_ACCEPTED] and up) can be
     * read or held by the peer. A watermark is a point in time, and a row
     * still on this device (Queued, Sending) or one the queue gave up on
     * (Failed) can sit below it without the server ever having seen it.
     * Raising those turned an unsent message into ✓✓. Such a row catches up
     * with the watermark once its acceptance lands ([raiseToWatermarks]).
     */
    @Query(
        """UPDATE messages SET delivery = MAX(delivery, $DELIVERY_READ)
           WHERE accountKey = :accountKey AND peer = :peer AND mine = 1 AND ts <= :peerReadTs
             AND delivery BETWEEN $DELIVERY_ACCEPTED AND $DELIVERY_READ""",
    )
    suspend fun markOwnReadUpTo(accountKey: String, peer: String, peerReadTs: Long)

    /**
     * The delivered twin of [markOwnReadUpTo], one rung below it: the peer's
     * device holds these rows, but their eyes have not reached them.
     *
     * Same shape and same monotonic reason — a page or a receipt settles
     * everything of ours at or before a watermark, not just the one bubble it
     * happened to name, or a receipt lost to a reconnect leaves every earlier
     * message on one ✓ forever. `MAX` on the row's own delivery is what keeps
     * this from walking backwards over a row that is already Read, and only
     * `mine = 1` is touched: an incoming row's delivery is this device's own
     * receipt state and has nothing to do with the peer's. Committed rows
     * only, for the reason given on [markOwnReadUpTo].
     */
    @Query(
        """UPDATE messages SET delivery = MAX(delivery, $DELIVERY_DELIVERED)
           WHERE accountKey = :accountKey AND peer = :peer AND mine = 1 AND ts <= :ts
             AND delivery BETWEEN $DELIVERY_ACCEPTED AND $DELIVERY_READ""",
    )
    suspend fun markOwnDeliveredUpTo(accountKey: String, peer: String, ts: Long)

    /**
     * A row the server just accepted takes the conversation's watermarks it
     * was too early for: [markOwnReadUpTo] and [markOwnDeliveredUpTo] skip
     * rows that are not committed yet, and an acceptance that lost its first
     * reply arrives after the peer has already read the message. Measured
     * against the row's own (by now server) `ts`; monotonic like the rest.
     */
    @Query(
        """UPDATE messages SET delivery = CASE
               WHEN ts <= (SELECT c.peerReadTs FROM conversations c
                           WHERE c.accountKey = :accountKey AND c.peer = :peer)
                   THEN MAX(delivery, $DELIVERY_READ)
               WHEN ts <= (SELECT c.peerDeliveredTs FROM conversations c
                           WHERE c.accountKey = :accountKey AND c.peer = :peer)
                   THEN MAX(delivery, $DELIVERY_DELIVERED)
               ELSE delivery END
           WHERE accountKey = :accountKey AND peer = :peer AND id = :id AND mine = 1
             AND delivery BETWEEN $DELIVERY_ACCEPTED AND $DELIVERY_READ""",
    )
    suspend fun raiseToWatermarks(accountKey: String, peer: String, id: String)


    /** Aborts on a duplicate id: the enqueue path wants the constraint, not a
     *  silent overwrite of a message already in flight. */
    @Insert
    suspend fun insert(message: MessageEntity)

    @Upsert
    suspend fun upsert(message: MessageEntity)

    @Upsert
    suspend fun upsertAll(messages: List<MessageEntity>)

    /**
     * The monotonic rule, in the one place it is written.
     *
     * A late `Accepted` arriving after the peer's read receipt must not pull
     * the row back to two ticks, so the state only ever climbs — except out of
     * [DeliveryState.Failed], which is a dead end the row is allowed to leave
     * when a retry finally gets an answer.
     */
    @Query(
        """UPDATE messages
           SET delivery = CASE WHEN delivery = $DELIVERY_FAILED THEN :delivery ELSE MAX(delivery, :delivery) END
           WHERE accountKey = :accountKey AND peer = :peer AND id = :id""",
    )
    suspend fun advanceDelivery(accountKey: String, peer: String, id: String, delivery: Int)

    /** Same rule, for receipts that name a message without naming the
     *  conversation it belongs to. */
    @Query(
        """UPDATE messages
           SET delivery = CASE WHEN delivery = $DELIVERY_FAILED THEN :delivery ELSE MAX(delivery, :delivery) END
           WHERE accountKey = :accountKey AND id = :id""",
    )
    suspend fun advanceDeliveryAnywhere(accountKey: String, id: String, delivery: Int)

    @Query(
        """UPDATE messages
           SET delivery = CASE WHEN delivery = $DELIVERY_FAILED THEN :delivery ELSE MAX(delivery, :delivery) END
           WHERE accountKey = :accountKey AND peer = :peer AND id IN (:ids) AND mine = 1""",
    )
    suspend fun advanceMine(accountKey: String, peer: String, ids: List<String>, delivery: Int)

    /**
     * The server's acceptance of one of this device's own messages: the state
     * climbs, the sequence is remembered, and — when the server names a time —
     * so is that time.
     *
     * The timestamp is not decoration. Every client sorts a conversation by
     * `ts`, and the peer's copy of this message carries the *server's* number
     * (the hub rewrites a clock skewed beyond `CLOCK_SKEW_TOLERANCE_MS` before
     * it is stored, and the record — not the frame — is what everybody else
     * reads back). A row that kept the sender's own skewed time therefore sat
     * in a different place in the two transcripts, and — worse — the peer's
     * read watermark, which is measured against the stored ts, could never
     * reach it, so its ✓✓ was unreachable no matter how many times it was read.
     * Adopting the accepted time is what makes "one order for everybody" true
     * rather than merely intended; a history merge does the same thing
     * ([MessageDao.merge]).
     *
     * A retry of the same id names the same stored time, so this cannot make a
     * repeated frame move a row; and it is never *cleared*, so an old server
     * that sends no `ts` leaves the local value standing.
     */
    @Query(
        """UPDATE messages
           SET delivery = CASE WHEN delivery = $DELIVERY_FAILED THEN :delivery ELSE MAX(delivery, :delivery) END,
               serverSeq = COALESCE(:serverSeq, serverSeq),
               ts = COALESCE(:serverTs, ts)
           WHERE accountKey = :accountKey AND peer = :peer AND id = :id""",
    )
    suspend fun confirm(
        accountKey: String,
        peer: String,
        id: String,
        delivery: Int,
        serverSeq: Long?,
        serverTs: Long? = null,
    )

    @Query("UPDATE messages SET serverSeq = :seq WHERE accountKey = :accountKey AND peer = :peer AND id = :id")
    suspend fun setServerSeq(accountKey: String, peer: String, id: String, seq: Long)

    @Query("UPDATE messages SET delivery = $DELIVERY_FAILED WHERE accountKey = :accountKey AND peer = :peer AND id = :id")
    suspend fun markFailed(accountKey: String, peer: String, id: String)

    @Query(
        """UPDATE messages SET text = :text, editedAt = :editedAt
           WHERE accountKey = :accountKey AND peer = :peer AND id = :id""",
    )
    suspend fun applyEdit(accountKey: String, peer: String, id: String, text: String, editedAt: Long)

    /**
     * A tombstone keeps the id and loses the content: the id is what stops a
     * stale history page from resurrecting the message, and the content is the
     * thing the user asked to be gone.
     */
    @Query(
        """UPDATE messages
           SET deletedAt = COALESCE(deletedAt, :deletedAt), text = '',
               imageDataUrl = NULL, imageWidth = NULL, imageHeight = NULL,
               voiceDataUrl = NULL, voiceDurationSec = NULL
           WHERE accountKey = :accountKey AND peer = :peer AND id IN (:ids)""",
    )
    suspend fun applyDelete(accountKey: String, peer: String, ids: List<String>, deletedAt: Long)

    @Query(
        """UPDATE messages SET reactionsJson = :reactionsJson
           WHERE accountKey = :accountKey AND peer = :peer AND id = :id""",
    )
    suspend fun setReactions(accountKey: String, peer: String, id: String, reactionsJson: String?)

    @Query("DELETE FROM messages WHERE accountKey = :accountKey")
    suspend fun deleteAccount(accountKey: String)

    /** Everything except what a queued operation still needs — logging out
     *  must not be a way to silently throw away an unsent message. */
    @Query(
        """DELETE FROM messages WHERE accountKey = :accountKey AND NOT EXISTS (
             SELECT 1 FROM pending_ops p
             WHERE p.accountKey = messages.accountKey AND p.peer = messages.peer AND p.messageId = messages.id)""",
    )
    suspend fun deleteAccountExceptPending(accountKey: String)

    /** Ids [deleteAccountExceptPending] is about to remove, read first so the
     *  caller can free their media files once the transaction that runs both
     *  commits — must mirror that query's predicate exactly, or a pending
     *  attachment's file could be freed while the row (and the queued
     *  operation that still owns it) survives. */
    @Query(
        """SELECT id FROM messages WHERE accountKey = :accountKey AND NOT EXISTS (
             SELECT 1 FROM pending_ops p
             WHERE p.accountKey = messages.accountKey AND p.peer = messages.peer AND p.messageId = messages.id)""",
    )
    suspend fun idsExceptPending(accountKey: String): List<String>

    /** Same shape as [idsExceptPending], scoped to one conversation — mirrors
     *  [deleteConversationExceptPending]. */
    @Query(
        """SELECT id FROM messages WHERE accountKey = :accountKey AND peer = :peer AND NOT EXISTS (
             SELECT 1 FROM pending_ops p
             WHERE p.accountKey = messages.accountKey AND p.peer = messages.peer AND p.messageId = messages.id)""",
    )
    suspend fun conversationIdsExceptPending(accountKey: String, peer: String): List<String>

    /** Every id of one conversation, pending rows included — the predicate
     *  [deleteConversation] uses, read first for the same reason
     *  [conversationIdsExceptPending] exists: [ChatRepository.purgeContact]
     *  frees these messages' media once the transaction that deletes them
     *  commits. */
    @Query("SELECT id FROM messages WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun conversationIds(accountKey: String, peer: String): List<String>

    /** The whole conversation, deliberately *including* rows a pending
     *  operation still owns — unlike [deleteConversationExceptPending]. A
     *  contact this account deleted is not somebody it still owes a message
     *  to, so the outbox rows for the peer go with the rows they point at. */
    @Query("DELETE FROM messages WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun deleteConversation(accountKey: String, peer: String)

    /** Same shape as [deleteAccountExceptPending], scoped to one conversation —
     *  what "/clear" and per-chat cache clearing use. */
    @Query(
        """DELETE FROM messages WHERE accountKey = :accountKey AND peer = :peer AND NOT EXISTS (
             SELECT 1 FROM pending_ops p
             WHERE p.accountKey = messages.accountKey AND p.peer = messages.peer AND p.messageId = messages.id)""",
    )
    suspend fun deleteConversationExceptPending(accountKey: String, peer: String)

    /**
     * Server truth applied over local truth, per row, keeping what the device
     * already proved.
     *
     * A history page carries whatever the server knew when it was built, which
     * is routinely older than the read receipt that arrived over the socket a
     * second ago — hence the delivery floor. A row deleted locally is skipped
     * outright: the tombstone is a decision, and a page fetched before it must
     * not undo it.
     */
    @Transaction
    suspend fun merge(accountKey: String, peer: String, rows: List<MessageEntity>): Set<String> {
        if (rows.isEmpty()) return emptySet()
        val local = localStates(accountKey, peer, rows.map(MessageEntity::id)).associateBy(DeliveryRow::id)
        val merged = ArrayList<MessageEntity>(rows.size)
        // Ids genuinely new to this conversation — what `applyIncoming` uses to
        // decide whether a message earns an unread badge increment. A retry of
        // an id already stored merges its (possibly updated) delivery state but
        // is not a second unread item.
        val inserted = mutableSetOf<String>()
        for (row in rows) {
            val known = local[row.id]
            if (known == null) {
                merged += row
                inserted += row.id
                continue
            }
            if (known.deletedAt != null) continue
            val mergedButtons = row.buttonsJson ?: known.buttonsJson
            merged += if (known.delivery == DELIVERY_FAILED || known.delivery <= row.delivery) {
                row.copy(buttonsJson = mergedButtons)
            } else {
                row.copy(delivery = known.delivery, buttonsJson = mergedButtons)
            }
        }
        if (merged.isNotEmpty()) upsertAll(merged)
        return inserted
    }
}

@Dao
interface PendingOperationDao {
    @Insert
    suspend fun insert(op: PendingOperationEntity)

    /** Re-enqueueing the same opId is a resume, not a second operation. */
    @Upsert
    suspend fun upsert(op: PendingOperationEntity)

    @Query("SELECT * FROM pending_ops WHERE opId = :opId")
    suspend fun find(opId: String): PendingOperationEntity?

    /** No `nextAttemptAt` predicate anywhere here: a parked (failed) operation
     *  must stay findable, or the retry button has nothing to retry. */
    @Query("SELECT * FROM pending_ops WHERE accountKey = :accountKey AND messageId = :messageId LIMIT 1")
    suspend fun findForMessage(accountKey: String, messageId: String): PendingOperationEntity?

    /** Which operations have a payload too big for any `SELECT *` on this
     *  table to return, without ever selecting that payload itself — see
     *  [MessageDao.oversizedMediaRefs] and `ChatRepository.repairOversizedRows`. */
    @Query("SELECT opId FROM pending_ops WHERE accountKey = :accountKey AND LENGTH(payloadJson) > :maxChars")
    suspend fun oversizedPayloadIds(accountKey: String, maxChars: Int): List<String>

    /** peer/messageId only — enough to mark the message failed and nothing
     *  else, safe to read regardless of how big [PendingOperationEntity.payloadJson] is. */
    @Query("SELECT peer, messageId FROM pending_ops WHERE opId = :opId")
    suspend fun findRef(opId: String): PendingOpRef?

    @Query("SELECT COUNT(*) FROM pending_ops WHERE accountKey = :accountKey")
    fun countAll(accountKey: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM pending_ops WHERE accountKey = :accountKey AND peer = :peer")
    fun countPeer(accountKey: String, peer: String): Flow<Int>

    /** How long the oldest still-queued operation has been waiting — the
     *  diagnostics panel's one number for "is the outbox actually stuck".
     *  Null when the queue is empty. */
    @Query("SELECT MIN(createdAt) FROM pending_ops WHERE accountKey = :accountKey")
    fun oldestCreatedAt(accountKey: String): Flow<Long?>

    /** Parked rows, so the UI can show `lastError` and offer the retry instead
     *  of leaving the message in a queue that will never run again. */
    @Query(
        """SELECT * FROM pending_ops WHERE accountKey = :accountKey AND nextAttemptAt = $NEVER_DUE
           ORDER BY createdAt ASC""",
    )
    fun failed(accountKey: String): Flow<List<PendingOperationEntity>>

    @Query("SELECT * FROM pending_ops WHERE accountKey = :accountKey ORDER BY createdAt ASC")
    suspend fun all(accountKey: String): List<PendingOperationEntity>

    /**
     * Due and unowned. `leaseUntil <= :now` is what makes a process death
     * recoverable: the lease of a sender that never came back expires and the
     * operation becomes claimable again, without anybody having to notice the
     * crash.
     */
    @Query(
        """SELECT * FROM pending_ops
           WHERE accountKey = :accountKey AND nextAttemptAt <= :now
             AND (leaseOwner IS NULL OR leaseUntil <= :now)
           ORDER BY createdAt ASC LIMIT :limit""",
    )
    suspend fun due(accountKey: String, now: Long, limit: Int): List<PendingOperationEntity>

    /**
     * Returns 1 only for the claimer that got there first — the same predicate
     * as [due], re-checked inside the write, so two senders racing on the same
     * row cannot both walk away with it.
     */
    @Query(
        """UPDATE pending_ops SET leaseOwner = :owner, leaseUntil = :leaseUntil
           WHERE opId = :opId AND (leaseOwner IS NULL OR leaseUntil <= :now)""",
    )
    suspend fun stamp(opId: String, owner: String, leaseUntil: Long, now: Long): Int

    /** Extends a lease that is still being held, for an operation whose frame
     *  has not finished leaving the socket — see `SyncEngine`'s
     *  `deadlinesDeferred`. A large frame can occupy [LEASE_MS] and more on a
     *  slow uplink, and a lease that runs out under it is what let the same
     *  pump claim the operation again and upload the whole attachment a second
     *  time. Scoped to [owner]: a renewal must never reach a lease another
     *  connection took over after this one's generation ended. */
    @Query(
        """UPDATE pending_ops SET leaseUntil = :leaseUntil
           WHERE opId IN (:opIds) AND leaseOwner = :owner""",
    )
    suspend fun renew(opIds: List<String>, owner: String, leaseUntil: Long)

    @Query(
        """UPDATE pending_ops
           SET attempts = attempts + 1, nextAttemptAt = :nextAttemptAt, lastError = :error,
               errorKind = :errorKind, leaseOwner = NULL, leaseUntil = 0
           WHERE opId = :opId""",
    )
    suspend fun release(opId: String, nextAttemptAt: Long, error: String?, errorKind: Int)

    /** Parked, not deleted: the row is the only copy of what the user wrote,
     *  and a retry has to be able to reuse its id. `nextAttemptAt` is put out
     *  of reach so no automatic claim picks it up again; `releaseLease` with a
     *  real timestamp is what brings it back. */
    @Query(
        """UPDATE pending_ops
           SET lastError = :error, errorKind = :errorKind, nextAttemptAt = $NEVER_DUE,
               leaseOwner = NULL, leaseUntil = 0
           WHERE opId = :opId""",
    )
    suspend fun park(opId: String, error: String, errorKind: Int)

    @Query("DELETE FROM pending_ops WHERE opId = :opId")
    suspend fun delete(opId: String)

    @Query("DELETE FROM pending_ops WHERE accountKey = :accountKey AND peer = :peer AND messageId IN (:messageIds)")
    suspend fun deleteForMessages(accountKey: String, peer: String, messageIds: List<String>)

    /** A message pulled from the queue before it was ever accounted for by
     *  conversation — the delete path knows the account and the message id,
     *  not which peer it was headed to. */
    @Query("DELETE FROM pending_ops WHERE accountKey = :accountKey AND messageId = :messageId")
    suspend fun deleteForMessage(accountKey: String, messageId: String)

    @Query("DELETE FROM pending_ops WHERE accountKey = :accountKey")
    suspend fun deleteAccount(accountKey: String)

    /** The queue's rows for one contact, unsent messages included — see
     *  [MessageDao.deleteConversation] for why a deleted contact's outbox rows
     *  are not protected by `keepPending` the way a logout's are. */
    @Query("DELETE FROM pending_ops WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun deletePeer(accountKey: String, peer: String)

    @Transaction
    suspend fun claimDue(
        accountKey: String,
        owner: String,
        now: Long,
        leaseUntil: Long,
        limit: Int,
    ): List<PendingOperationEntity> {
        val candidates = due(accountKey, now, limit)
        if (candidates.isEmpty()) return emptyList()
        val claimed = ArrayList<PendingOperationEntity>(candidates.size)
        for (candidate in candidates) {
            if (stamp(candidate.opId, owner, leaseUntil, now) == 1) {
                claimed += candidate.copy(leaseOwner = owner, leaseUntil = leaseUntil)
            }
        }
        return claimed
    }
}

@Dao
interface NotificationDeliveryDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfAbsent(row: NotificationDeliveryEntity): Long

    @Query(
        """UPDATE notification_deliveries
           SET status = 1, claimedAt = :now, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer AND messageId = :messageId
             AND (status = 0 OR (status = 1 AND claimedAt <= :staleBefore))""",
    )
    suspend fun claim(
        accountKey: String,
        peer: String,
        messageId: String,
        now: Long,
        staleBefore: Long,
    ): Int

    @Query(
        """UPDATE notification_deliveries SET status = :status, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer AND messageId = :messageId
             AND status IN (0, 1)""",
    )
    suspend fun complete(accountKey: String, peer: String, messageId: String, status: Int, now: Long)

    @Query(
        """SELECT status FROM notification_deliveries
           WHERE accountKey = :accountKey AND peer = :peer AND messageId = :messageId""",
    )
    suspend fun status(accountKey: String, peer: String, messageId: String): Int?

    @Query(
        """UPDATE notification_deliveries SET status = 3, updatedAt = :now
           WHERE accountKey = :accountKey AND peer = :peer AND status IN (0, 1)
             AND messageId IN (
               SELECT id FROM messages
               WHERE accountKey = :accountKey AND peer = :peer AND ts <= :readTs
             )""",
    )
    suspend fun suppressRead(accountKey: String, peer: String, readTs: Long, now: Long)

    @Query(
        """UPDATE notification_deliveries SET status = 3, updatedAt = :now
           WHERE accountKey = :accountKey AND status IN (0, 1)""",
    )
    suspend fun suppressAccount(accountKey: String, now: Long)

    /** A deleted contact's deliveries go, rather than being suppressed the way
     *  [suppressAccount] leaves a logout's: the rows name messages this device
     *  no longer has anything to alert about, and nothing will look them up
     *  again. */
    @Query("DELETE FROM notification_deliveries WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun deletePeer(accountKey: String, peer: String)
}

@Dao
interface DraftDao {
    @Query("SELECT * FROM drafts WHERE accountKey = :accountKey AND peer = :peer")
    suspend fun find(accountKey: String, peer: String): DraftEntity?

    @Upsert
    suspend fun upsert(draft: DraftEntity)

    /** A null [sentText] clears unconditionally; otherwise the draft survives
     *  if the user has typed anything since the send. */
    @Query(
        """DELETE FROM drafts WHERE accountKey = :accountKey AND peer = :peer
           AND (:sentText IS NULL OR text = :sentText)""",
    )
    suspend fun clear(accountKey: String, peer: String, sentText: String?)

    @Query("DELETE FROM drafts WHERE accountKey = :accountKey")
    suspend fun deleteAccount(accountKey: String)
}

@Dao
interface SyncStateDao {
    @Query("SELECT * FROM sync_state WHERE accountKey = :accountKey")
    suspend fun find(accountKey: String): SyncCheckpointEntity?

    @Upsert
    suspend fun upsert(state: SyncCheckpointEntity)

    @Query("DELETE FROM sync_state WHERE accountKey = :accountKey")
    suspend fun deleteAccount(accountKey: String)

    @Transaction
    suspend fun setCursor(accountKey: String, cursor: Long, now: Long) {
        val current = find(accountKey)
        upsert(
            current?.copy(cursor = cursor, updatedAt = now)
                ?: SyncCheckpointEntity(accountKey, cursor, importedLegacy = false, updatedAt = now),
        )
    }

    @Transaction
    suspend fun setImportedLegacy(accountKey: String, imported: Boolean, now: Long) {
        val current = find(accountKey)
        upsert(
            current?.copy(importedLegacy = imported, updatedAt = now)
                ?: SyncCheckpointEntity(accountKey, cursor = 0L, importedLegacy = imported, updatedAt = now),
        )
    }

    /** Logout with a surviving queue: the cursor is worthless (the account will
     *  re-sync from scratch) but the import marker must outlive it, or the next
     *  login re-reads the legacy files and re-queues what is already queued. */
    @Transaction
    suspend fun resetCursorKeepImportMarker(accountKey: String, now: Long) {
        val current = find(accountKey) ?: return
        upsert(current.copy(cursor = 0L, updatedAt = now))
    }
}
