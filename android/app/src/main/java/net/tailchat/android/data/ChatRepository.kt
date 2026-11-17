package net.tailchat.android.data

import android.database.sqlite.SQLiteException
import androidx.room.withTransaction
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.withContext

/**
 * The only writer of [TailchatDatabase], and the place every multi-table
 * invariant lives.
 *
 * The rule the rest of the app depends on: a call here either happened
 * completely or not at all. A message row without its pending operation is a
 * message that will never be sent and will never say so; a pending operation
 * without its message row is a send with nothing to show for it. Both are
 * written inside one transaction, always.
 *
 * [clock] is injected so that a test can make time an argument instead of a
 * race. [media] is where a message's image/voice actually lives — see
 * [MediaCache] for why a `data:` URL is never a column's content here.
 */
class ChatRepository(
    private val db: TailchatDatabase,
    private val media: MediaCache,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** A roster entry as the server's `users`/`conversation-update` envelopes
     *  describe it — everything else about a conversation is local. */
    data class RosterRow(
        val accountKey: String,
        val peer: String,
        val name: String,
        val online: Boolean,
        val lastSeen: Long?,
        val unread: Int,
        val previewFrom: String?,
        val previewText: String?,
        val previewMedia: String?,
        val previewTs: Long,
        /** The deployment's own service/AI account — see [net.tailchat.android.cloud.CloudUser.official]. */
        val official: Boolean = false,
        /** This account has blocked [peer] — see [net.tailchat.android.cloud.CloudUser.blocked]. */
        val blocked: Boolean = false,
        /** A program rather than a person — see [net.tailchat.android.cloud.CloudUser.bot].
         *  Server-authoritative: a roster frame with no `bot` clears whatever
         *  was stored. */
        val bot: Boolean = false,
        /** This account's own nickname for [peer] — see
         *  [net.tailchat.android.cloud.CloudUser.alias]. Server-authoritative:
         *  a roster frame with no `alias` clears whatever was stored. */
        val alias: String? = null,
    )

    data class NotificationCandidate(
        val accountKey: String,
        val peer: String,
        val messageId: String,
        val author: String,
        val text: String,
        val ts: Long,
    )

    suspend fun upsertAccount(account: AccountEntity) = db.accounts().upsert(account)

    suspend fun account(accountKey: String): AccountEntity? = db.accounts().find(accountKey)

    fun conversations(accountKey: String): Flow<List<ConversationEntity>> =
        db.conversations().observe(accountKey)

    /** The roster as one read: what `SyncEngine`'s prefetch walk needs to decide
     *  which transcripts are still missing, without holding a subscription of
     *  its own. */
    suspend fun conversationSnapshot(accountKey: String): List<ConversationEntity> =
        readSafely(accountKey) { db.conversations().all(accountKey) }

    suspend fun conversation(accountKey: String, peer: String): ConversationEntity? =
        db.conversations().find(accountKey, peer)

    /** Full control of one conversation row, for the cases the roster cannot
     *  describe — Saved, which is a self-conversation, above all. */
    suspend fun upsertConversation(row: ConversationEntity) = db.conversations().upsert(row)

    /**
     * Newest [limit] messages, oldest-first for display.
     *
     * The window is applied in SQL (`ORDER BY ts DESC LIMIT`) and reversed
     * here: loading a whole conversation to show its last screenful is the
     * kind of thing that makes an app feel heavy, and it gets worse exactly
     * where the transcript matters most.
     *
     * A row's `imageDataUrl`/`voiceDataUrl` comes back exactly as stored — a
     * short `media://` reference, not the multi-megabyte `data:` URL it
     * names. This used to be resolved here, which meant `CloudState.messages`
     * held one full-size `data:` URL per photo in the whole scroll window, on
     * screen or not, retained for as long as the conversation stayed open.
     * [resolveMedia] is the read the UI now does per bubble, only while it is
     * actually visible. `flowOn(Dispatchers.IO)` still keeps this query and
     * its repair retry off the collector's context.
     */
    fun messages(accountKey: String, peer: String, limit: Int): Flow<List<MessageEntity>> =
        db.messages().observe(accountKey, peer, limit)
            .map { it.asReversed() }
            .retryWhen { cause, attempt -> repairAndRetry(accountKey, cause, attempt) }
            .flowOn(Dispatchers.IO)

    /** The same window, one page back — same raw-reference contract, see
     *  [messages]. */
    suspend fun messagePage(
        accountKey: String,
        peer: String,
        beforeTs: Long,
        limit: Int,
    ): List<MessageEntity> = withContext(Dispatchers.IO) {
        readSafely(accountKey) {
            db.messages().page(accountKey, peer, beforeTs, limit).asReversed()
        }
    }

    suspend fun message(accountKey: String, peer: String, id: String): MessageEntity? =
        readSafely(accountKey) { db.messages().find(accountKey, peer, id) }

    /**
     * Resolves an image/voice value from a row returned by [messages],
     * [messagePage] or [message] back to its real `data:` URL — the read the
     * UI does per bubble, only for the one actually on screen, instead of
     * this repository doing it for the whole window whether anything looked
     * at it or not. Passing through a literal `data:` URL unresolved (a
     * transient message not yet round-tripped through Room) is exactly
     * [MediaCache.load]'s existing no-op case. Call off the main thread —
     * this is a file read.
     */
    fun resolveMedia(ref: String?): String? = media.load(ref)

    suspend fun hasMessage(accountKey: String, peer: String, id: String): Boolean =
        db.messages().count(accountKey, peer, id) > 0

    suspend fun newestIncoming(accountKey: String, peer: String): IncomingRef? =
        db.messages().newestIncoming(accountKey, peer)
    suspend fun notificationStatus(accountKey: String, peer: String, messageId: String): Int? =
        db.notificationDeliveries().status(accountKey, peer, messageId)

    /**
     * Atomically decides whether this message may alert. This is shared by
     * socket delivery and push/history recovery, so either path wins one claim
     * and every repeat observes the same terminal row.
     */
    suspend fun claimNotification(
        accountKey: String,
        peer: String,
        messageId: String,
        visible: Boolean,
    ): NotificationCandidate? = db.withTransaction {
        val now = clock()
        val deliveries = db.notificationDeliveries()
        deliveries.insertIfAbsent(
            NotificationDeliveryEntity(
                accountKey,
                peer,
                messageId,
                NotificationDeliveryStatus.PENDING,
                claimedAt = 0L,
                updatedAt = now,
            ),
        )
        val message = db.messages().find(accountKey, peer, messageId)
        val readWatermark = db.conversations().find(accountKey, peer)?.readWatermarkTs ?: 0L
        val eligible = message != null &&
            !visible &&
            !message.mine &&
            !message.system &&
            message.deletedAt == null &&
            message.delivery < DeliveryState.Read.ordinal &&
            message.ts > readWatermark &&
            message.text.isNotBlank()
        if (!eligible) {
            deliveries.complete(
                accountKey,
                peer,
                messageId,
                NotificationDeliveryStatus.SUPPRESSED,
                now,
            )
            return@withTransaction null
        }
        if (deliveries.claim(accountKey, peer, messageId, now, now - NOTIFICATION_CLAIM_MS) != 1) {
            return@withTransaction null
        }
        NotificationCandidate(accountKey, peer, messageId, message.author, message.text, message.ts)
    }

    suspend fun completeNotification(
        accountKey: String,
        peer: String,
        messageId: String,
        posted: Boolean,
    ) {
        db.notificationDeliveries().complete(
            accountKey,
            peer,
            messageId,
            if (posted) NotificationDeliveryStatus.POSTED else NotificationDeliveryStatus.SUPPRESSED,
            clock(),
        )
    }

    suspend fun suppressReadNotifications(accountKey: String, peer: String, readTs: Long) =
        db.notificationDeliveries().suppressRead(accountKey, peer, readTs, clock())

    /**
     * One transaction: message row + pending op + conversation preview.
     *
     * Returns false only when the write failed, and then nothing was written —
     * the caller keeps the draft, which is the difference between "the app
     * refused" and "the app lost it". That includes the media write: caching
     * an image/voice clip happens before the transaction (see [MediaCache.
     * store]), and a failure there is turned into the same `false` here
     * rather than thrown past this function's own contract.
     */
    suspend fun enqueueMessage(message: MessageEntity, op: PendingOperationEntity): Boolean {
        val cachedMessage = mediaCacheGuard { withCachedMedia(message) } ?: return false
        val cachedOp = mediaCacheGuard { withCachedMedia(op) } ?: return false
        return write {
            db.messages().insert(cachedMessage)
            db.pendingOps().insert(cachedOp)
            db.conversations().touchPreview(
                accountKey = cachedMessage.accountKey,
                peer = cachedMessage.peer,
                from = cachedMessage.author,
                text = cachedMessage.text,
                media = mediaTag(cachedMessage),
                ts = cachedMessage.ts,
                now = clock(),
            )
        }
    }

    /** Upsert by [PendingOperationEntity.opId]: re-enqueueing a known id is a
     *  resume of that operation, never a second copy of it. */
    suspend fun enqueueOperation(op: PendingOperationEntity): Boolean = write {
        db.pendingOps().upsert(withCachedMedia(op))
    }

    suspend fun operation(opId: String): PendingOperationEntity? = db.pendingOps().find(opId)

    suspend fun operationForMessage(accountKey: String, messageId: String): PendingOperationEntity? =
        db.pendingOps().findForMessage(accountKey, messageId)

    suspend fun operations(accountKey: String): List<PendingOperationEntity> = db.pendingOps().all(accountKey)

    /** Parked operations with their `lastError`, so a failure is a thing the
     *  user can see and retry rather than a queue that quietly stopped. */
    fun failedOperations(accountKey: String): Flow<List<PendingOperationEntity>> =
        db.pendingOps().failed(accountKey)

    suspend fun claimDue(
        accountKey: String,
        owner: String,
        now: Long,
        limit: Int,
    ): List<PendingOperationEntity> = readSafely(accountKey) {
        db.pendingOps().claimDue(accountKey, owner, now, now + LEASE_MS, limit).map(::withResolvedMedia)
    }

    suspend fun releaseLease(opId: String, nextAttemptAt: Long, error: String?, errorKind: Int) =
        db.pendingOps().release(opId, nextAttemptAt, error, errorKind)

    /**
     * Keeps the operations whose frames are still on their way out owned by
     * [owner] — the counterpart of [claimDue] for a send that takes longer than
     * [LEASE_MS]: a photo or a voice note on a slow uplink. Renewing costs one
     * statement per pass, and only while the socket still holds the bytes.
     */
    suspend fun renewLease(opIds: List<String>, owner: String) {
        if (opIds.isEmpty()) return
        db.pendingOps().renew(opIds, owner, clock() + LEASE_MS)
    }

    /**
     * The end of the automatic road: the operation is parked out of reach of
     * [claimDue] and the message shows as failed. Nothing is deleted — the row
     * is the only copy of what the user wrote, and a retry
     * (`releaseLease(opId, now, null, ErrorKind.None.ordinal)`) has to reuse
     * the same id or the eventual late acceptance becomes a duplicate.
     */
    suspend fun failOperation(opId: String, error: String, errorKind: Int) {
        db.withTransaction {
            val op = db.pendingOps().find(opId) ?: return@withTransaction
            db.pendingOps().park(opId, error, errorKind)
            op.messageId?.let { db.messages().markFailed(op.accountKey, op.peer, it) }
        }
    }

    /**
     * One transaction: drop the op and advance the message's delivery state.
     *
     * [serverTs] is the time the server committed the message to, when the
     * acceptance named one (`message-accepted`). It is applied because every
     * device has to sort this message the same way and the peer's copy carries
     * the server's number — see [MessageDao.confirm]. `null` (an older server,
     * or a receipt that names no time) leaves the local one standing, and a
     * history merge would have adopted the server's row anyway.
     */
    suspend fun completeOperation(
        opId: String,
        messageId: String?,
        delivery: DeliveryState,
        serverSeq: Long?,
        serverTs: Long? = null,
    ) {
        db.withTransaction {
            val op = db.pendingOps().find(opId)
            db.pendingOps().delete(opId)
            val id = messageId ?: op?.messageId ?: return@withTransaction
            val peer = op?.peer ?: return@withTransaction
            db.messages().confirm(op.accountKey, peer, id, delivery.ordinal, serverSeq, serverTs)
            // The watermarks skipped this row while it was not committed; the
            // peer may already be past it (see [MessageDao.raiseToWatermarks]).
            db.messages().raiseToWatermarks(op.accountKey, peer, id)
        }
    }

    /**
     * The server's own history says these messages of ours exist, which is
     * proof of acceptance that no receipt has to arrive for. Dropping the ops
     * and raising the delivery in one transaction is what stops a reconnect
     * from re-sending a message the server already has.
     */
    suspend fun acceptByServerProof(accountKey: String, peer: String, ids: List<String>) {
        if (ids.isEmpty()) return
        db.withTransaction {
            db.pendingOps().deleteForMessages(accountKey, peer, ids)
            db.messages().advanceMine(accountKey, peer, ids, DELIVERY_ACCEPTED)
        }
    }

    fun pendingCount(accountKey: String): Flow<Int> = db.pendingOps().countAll(accountKey)

    fun pendingCount(accountKey: String, peer: String): Flow<Int> = db.pendingOps().countPeer(accountKey, peer)

    /** See [net.tailchat.android.data.PendingOperationDao.oldestCreatedAt]. */
    fun oldestPendingCreatedAt(accountKey: String): Flow<Long?> = db.pendingOps().oldestCreatedAt(accountKey)

    /**
     * Roster metadata over local knowledge. The preview only moves forward
     * (a roster built a second ago must not undo a message that arrived since)
     * and `historySeeded` is never touched: whether this device has the
     * transcript is not something the roster can know.
     *
     * Returns `false` when the store refused the write; a caller that hears
     * that must report it rather than let the roster go quietly stale. See
     * [write] for why this is a return value and not an exception.
     */
    suspend fun applyRoster(accountKey: String, rows: List<RosterRow>): Boolean {
        if (rows.isEmpty()) return true
        val now = clock()
        return write {
            for (row in rows) {
                db.conversations().insertIfAbsent(
                    ConversationDao.blank(
                        accountKey = accountKey,
                        peer = row.peer,
                        from = row.previewFrom,
                        text = row.previewText,
                        media = row.previewMedia,
                        ts = row.previewTs,
                        now = now,
                    ).copy(
                        name = row.name, online = row.online, lastSeen = row.lastSeen, unread = row.unread,
                        official = row.official, blocked = row.blocked, alias = row.alias, bot = row.bot,
                    ),
                )
                db.conversations().updateRosterMeta(
                    accountKey, row.peer, row.name, row.alias, row.online, row.lastSeen, row.official, row.blocked,
                    row.bot, now,
                )
                db.conversations().updatePreview(
                    accountKey, row.peer, row.previewFrom, row.previewText, row.previewMedia, row.previewTs, now,
                )
                db.conversations().setUnread(accountKey, row.peer, row.unread, now)
            }
        }
    }

    /** Returns `false` when the store refused the write — see [applyRoster]. */
    suspend fun applyPresence(accountKey: String, peer: String, online: Boolean, lastSeen: Long?): Boolean =
        write { db.conversations().setPresence(accountKey, peer, online, lastSeen, clock()) }

    /** This account's own nickname for one contact (issue #28), applied to the
     *  roster row — the optimistic half of a rename, since the server also
     *  re-sends the roster. A blank [alias] clears the nickname. Returns `false`
     *  when the store refused the write. */
    suspend fun setAlias(accountKey: String, peer: String, alias: String?): Boolean =
        write { db.conversations().setAlias(accountKey, peer, alias?.takeIf(String::isNotBlank), clock()) }

    /** One transaction: the message, the preview it produces, and the unread
     *  badge it earns when the conversation is not the one being looked at.
     *  The badge only moves on a message id genuinely new to this
     *  conversation — a retry of an id already stored (self-sync echo,
     *  redelivered frame) merges its content but never counts twice.
     *
     *  Returns `false` when the store refused the write: a message that could
     *  not be stored is not a message this device may later claim to have —
     *  including its media, which is cached before the transaction below and
     *  guarded the same way as in [enqueueMessage]. */
    suspend fun applyIncoming(
        accountKey: String,
        peer: String,
        message: MessageEntity,
        countUnread: Boolean,
    ): Boolean {
        val cachedMessage = mediaCacheGuard { withCachedMedia(message) } ?: return false
        val now = clock()
        return write {
            val inserted = db.messages().merge(accountKey, peer, listOf(cachedMessage))
            db.conversations().touchPreview(
                accountKey = accountKey,
                peer = peer,
                from = cachedMessage.author,
                text = cachedMessage.text,
                media = mediaTag(cachedMessage),
                ts = cachedMessage.ts,
                now = now,
            )
            if (countUnread && cachedMessage.id in inserted) db.conversations().addUnread(accountKey, peer, 1, now)
        }
    }

    /** Stores [message] as a tombstone: no preview, no unread, nothing drawn. */
    suspend fun storeHidden(accountKey: String, peer: String, message: MessageEntity): Boolean =
        write { db.messages().merge(accountKey, peer, listOf(message)) }

    /**
     * A call this device's own `CallController` just finished. Recorded
     * locally only — `call-*` frames are never queued or journalled
     * server-side (`src/cloud/hub.js`), so each device signed into an
     * account logs its own view of what happened, and the same `callId`
     * legitimately producing a different row per device (one saw it
     * answered, another saw `call-taken`) is correct, not a bug.
     *
     * [message] is already built as `kind = MessageKind.CALL` by the caller
     * (`CloudMapping.kt`'s `CallLogEntry.toMessageEntity`), mirroring every
     * other kind's own construction site — this only knows how to store it,
     * the same split [applyIncoming] draws for a message that arrived over
     * the wire. [countUnread] is the caller's call: only a missed incoming
     * call earns the same unread bump a message would.
     */
    suspend fun recordCall(accountKey: String, peer: String, message: MessageEntity, countUnread: Boolean): Boolean {
        val now = clock()
        return write {
            val inserted = db.messages().merge(accountKey, peer, listOf(message))
            db.conversations().touchPreview(
                accountKey = accountKey,
                peer = peer,
                from = message.author,
                text = message.text,
                media = MessageKind.CALL,
                ts = message.ts,
                now = now,
            )
            if (countUnread && message.id in inserted) db.conversations().addUnread(accountKey, peer, 1, now)
        }
    }

    /** A conversation heard about without its messages — a push, typically.
     *  [count] is the server's absolute unread total for this peer, not a
     *  delta: applied with `setUnread`, never `addUnread`, so a client that
     *  already showed a stale count lands on the true one instead of piling
     *  its own increment on top of a snapshot it never had.
     *
     *  Returns `false` when the store refused the write — see [applyRoster]. */
    suspend fun setUnreadSnapshot(
        accountKey: String,
        peer: String,
        previewText: String?,
        previewTs: Long,
        count: Int,
    ): Boolean {
        val now = clock()
        return write {
            db.conversations().touchPreview(accountKey, peer, peer, previewText, null, previewTs, now)
            db.conversations().setUnread(accountKey, peer, count, now)
        }
    }

    /**
     * A history page, merged monotonically and — when [seed] — marked as
     * seeded: from here on the UI can say "this is the conversation" instead of
     * "not loaded yet", and every loader stops asking for it.
     *
     * [seed] is `false` for a page that is only part of a walk (a shrunk page
     * on the way to the newest page's worth of rows): the receipts it carries
     * are still merged, but the conversation keeps whatever seeded state it
     * had, so a walk interrupted there is asked for again instead of leaving
     * the fraction it got as "the conversation" for good.
     *
     * Returns `false` when the store refused the write — see [applyRoster].
     */
    suspend fun applyHistoryPage(
        accountKey: String,
        peer: String,
        messages: List<MessageEntity>,
        peerReadTs: Long,
        peerReadAt: Long = 0L,
        peerReadVia: String = "",
        peerDeliveredTs: Long = 0L,
        seed: Boolean = true,
    ): Boolean {
        val cachedMessages = messages.map { mediaCacheGuard { withCachedMedia(it) } ?: return false }
        val now = clock()
        return write {
            // A tombstone is not a preview. The newest row of a page is
            // routinely the message just deleted from another client, and
            // [ConversationDao.updatePreview] only ever moves forward: an empty
            // preview written from it outranks the live message behind it
            // (older `ts`) and the roster envelope — whose own preview already
            // skips deleted records, `accounts.js:2371` — could never correct
            // it again.
            val newest = cachedMessages.filter { it.deletedAt == null }.maxByOrNull(MessageEntity::ts)
            db.conversations().touchPreview(
                accountKey = accountKey,
                peer = peer,
                from = newest?.author,
                text = newest?.text,
                media = newest?.let(::mediaTag),
                ts = newest?.ts ?: 0L,
                now = now,
            )
            db.messages().merge(accountKey, peer, cachedMessages)
            // Delivered first, then read: the two rungs are one ladder and the
            // row's own `MAX` makes the order irrelevant to the result, but the
            // read watermark is the stronger fact — everything it covers is
            // delivered too — so whichever way a page or a receipt names them,
            // the row ends on the higher mark. `peerDeliveredTs` climbs on its
            // own even when the read watermark already implies it: a snapshot
            // from a server that predates delivery must not report "not
            // delivered" for a message the peer has plainly read once the
            // watermark does arrive (`deliveredTs` on the server is the same
            // `max(deliveries, reads)`).
            if (peerDeliveredTs > 0L) {
                db.messages().markOwnDeliveredUpTo(accountKey, peer, peerDeliveredTs)
                db.conversations().bumpPeerDeliveredWatermark(accountKey, peer, peerDeliveredTs, now)
            }
            if (peerReadTs > 0L) {
                db.messages().markOwnReadUpTo(accountKey, peer, peerReadTs)
            }
            if (seed) {
                db.conversations().markSeeded(accountKey, peer, peerReadTs, peerReadAt, peerReadVia, now)
            } else {
                db.conversations().bumpPeerReadWatermark(accountKey, peer, peerReadTs, peerReadAt, peerReadVia, now)
            }
        }
    }

    suspend fun markDelivery(accountKey: String, peer: String, id: String, delivery: DeliveryState) =
        db.messages().advanceDelivery(accountKey, peer, id, delivery.ordinal)

    /** For receipts that name a message but not its conversation. */
    suspend fun markDeliveryAnywhere(accountKey: String, id: String, delivery: DeliveryState) =
        db.messages().advanceDeliveryAnywhere(accountKey, id, delivery.ordinal)

    suspend fun noteServerSeq(accountKey: String, peer: String, id: String, seq: Long) =
        db.messages().setServerSeq(accountKey, peer, id, seq)

    suspend fun unreadIncoming(accountKey: String, peer: String, limit: Int): List<String> =
        db.messages().unreadIncoming(accountKey, peer, limit)

    suspend fun unreadIncomingAmong(accountKey: String, peer: String, ids: List<String>): List<String> =
        if (ids.isEmpty()) emptyList() else db.messages().unreadIncomingAmong(accountKey, peer, ids)

    /**
     * The read receipts for these incoming rows have left the socket, so this
     * device is finished with them — see [MessageDao.markIncomingRead] for why
     * this is the write that keeps a reconnect from replaying the whole
     * conversation. Monotonic; returns `false` when the store refused it.
     */
    suspend fun markIncomingRead(accountKey: String, ids: List<String>): Boolean =
        if (ids.isEmpty()) true else write { db.messages().markIncomingRead(accountKey, ids) }

    suspend fun applyEdit(accountKey: String, peer: String, id: String, text: String, editedAt: Long) =
        db.messages().applyEdit(accountKey, peer, id, text, editedAt)

    /** The row's tombstone clears its media columns; this is what frees the
     *  files those columns pointed at, or a deleted message's photo would sit
     *  on disk forever with nothing left in Room to name it. Best-effort and
     *  outside `db.messages().applyDelete`'s own write — a delete that never
     *  owned media makes both calls a no-op, and the ordering means a crash
     *  between them only ever leaks a file, never dangles a reference. */
    suspend fun applyDelete(accountKey: String, peer: String, ids: List<String>) {
        if (ids.isEmpty()) return
        db.messages().applyDelete(accountKey, peer, ids, clock())
        ids.forEach { media.deleteFor(accountKey, it) }
    }

    suspend fun applyReaction(
        accountKey: String,
        peer: String,
        id: String,
        emoji: String,
        by: String,
        add: Boolean,
    ) {
        db.withTransaction {
            val row = db.messages().find(accountKey, peer, id) ?: return@withTransaction
            val reactions = Payloads.decodeReactions(row.reactionsJson).toMutableMap()
            val logins = reactions[emoji].orEmpty().toMutableList()
            if (add) {
                if (!logins.contains(by)) logins += by
            } else {
                logins -= by
            }
            if (logins.isEmpty()) reactions.remove(emoji) else reactions[emoji] = logins
            db.messages().setReactions(accountKey, peer, id, Payloads.encodeReactions(reactions))
        }
    }

    suspend fun setUnread(accountKey: String, peer: String, unread: Int) =
        db.conversations().setUnread(accountKey, peer, unread, clock())

    suspend fun readWatermark(accountKey: String, peer: String, ts: Long) =
        db.conversations().bumpReadWatermark(accountKey, peer, ts, clock())

    /**
     * The peer read this conversation up to [ts]: their watermark moves, and
     * every one of this account's own messages at or before it becomes Read.
     *
     * [readAt] is when they reached it and [via] is the client that did
     * (`web`/`cli`/`android/<build>`, `''` when unknown), both stored beside
     * the watermark for the message menu's «Прочитано: …» line. They are the
     * server's `readAt`/`via` from the same frame, so the pair always
     * describes the watermark it arrived with — never a separately observed
     * time. A frame without them leaves the row's previous values alone when
     * it names an older watermark (see [ConversationDao.bumpPeerReadWatermark]).
     *
     * One transaction, because the two halves are one fact. A receipt that
     * moved the watermark but not the rows would leave the roster showing ✓✓
     * over a transcript still showing ✓; the reverse would make `unreadIncoming`
     * and the roster disagree about the same conversation.
     *
     * Nothing here touches `historySeeded`: a receipt proves what the *other*
     * side read, never that this device holds the conversation.
     */
    suspend fun peerReadWatermark(
        accountKey: String,
        peer: String,
        ts: Long,
        readAt: Long = 0L,
        via: String = "",
    ) {
        if (ts <= 0L) return
        val now = clock()
        db.withTransaction {
            db.messages().markOwnReadUpTo(accountKey, peer, ts)
            db.conversations().bumpPeerReadWatermark(accountKey, peer, ts, readAt, via, now)
        }
    }

    /**
     * The peer's device holds this conversation up to [ts]: their delivered
     * watermark moves, and every one of this account's own messages at or
     * before it becomes Delivered.
     *
     * The rung below [peerReadWatermark] and its mirror in every respect — one
     * transaction, because a watermark that moved without the rows (or the
     * reverse) would leave the roster and the transcript disagreeing about the
     * same conversation; monotonic, because a receipt is only ever news of how
     * far the other side got, and a duplicate drained out of order must not
     * pull a ✓✓ back to ✓.
     *
     * Deliberately narrower than the read path in three ways, all of them the
     * point of the split: it never touches the read watermark, so the roster
     * badge and the read detail stay read facts; it never touches the unread
     * badge or the offline queue, because a device holding a message is not a
     * person having seen one; and it has no `readAt`/`via` to store, because
     * there is no such thing as when or from which client a device *holds* a
     * message — only that it does.
     */
    suspend fun peerDeliveredWatermark(accountKey: String, peer: String, ts: Long) {
        if (ts <= 0L) return
        val now = clock()
        db.withTransaction {
            db.messages().markOwnDeliveredUpTo(accountKey, peer, ts)
            db.conversations().bumpPeerDeliveredWatermark(accountKey, peer, ts, now)
        }
    }

    /**
     * Records that [ids] were named by the account feed but are not in
     * `messages`, and that this conversation therefore owes a fetch for them.
     *
     * Called from inside the cursor transaction that applied the event naming
     * them (`advanceCursorWith`), which is the whole point: the cursor may not
     * move past an event whose content this device has not got, unless the debt
     * to fetch it is written in the same commit. Returns `false` when the store
     * refused the write, so the caller can report it.
     *
     * Bounded: an account that somehow accumulates more than [BACKFILL_MAX_IDS]
     * outstanding ids keeps the newest ones, since an unbounded column is a row
     * that eventually cannot be read back at all.
     */
    suspend fun addBackfill(accountKey: String, peer: String, ids: List<String>): Boolean {
        val fresh = ids.filter { it.isNotEmpty() }.distinct()
        if (fresh.isEmpty()) return true
        val now = clock()
        return write {
            val existing = Payloads.decodeIds(db.conversations().backfillOf(accountKey, peer))
            val merged = (existing + fresh).distinct()
            val kept = if (merged.size > BACKFILL_MAX_IDS) merged.takeLast(BACKFILL_MAX_IDS) else merged
            db.conversations().setBackfill(accountKey, peer, Payloads.encodeIds(kept), now)
        }
    }

    /** The ids this conversation still owes a fetch for, oldest-recorded
     *  first. Empty for a conversation that is whole. */
    suspend fun backfillIds(accountKey: String, peer: String): List<String> =
        Payloads.decodeIds(db.conversations().backfillOf(accountKey, peer))

    /** Conversations with a fetch still owing, in the order the backfill should
     *  be attempted — see [ConversationDao.peersWithBackfill]. */
    suspend fun backfillPeers(accountKey: String): List<String> =
        db.conversations().peersWithBackfill(accountKey)

    /**
     * These ids are in `messages` now, so the debt for them is over. Called
     * with what was actually found and not with the whole request: an id the
     * server no longer has — a tombstone past the retention window — would
     * otherwise keep a conversation on the worklist forever.
     */
    suspend fun clearBackfill(accountKey: String, peer: String, ids: List<String>): Boolean {
        if (ids.isEmpty()) return true
        val cleared = ids.toSet()
        val now = clock()
        return write {
            val remaining = Payloads.decodeIds(db.conversations().backfillOf(accountKey, peer))
                .filterNot { it in cleared }
            db.conversations().setBackfill(
                accountKey,
                peer,
                if (remaining.isEmpty()) null else Payloads.encodeIds(remaining),
                now,
            )
        }
    }

    suspend fun markConversationsUnseeded(accountKey: String) =
        db.conversations().markAllUnseeded(accountKey, clock())

    /**
     * Wipes locally cached history for the whole account so it re-downloads
     * clean, but never a message a pending operation still needs to send —
     * a cache clear must not be a way to lose an unsent queue. Conversations
     * are marked unseeded so the next open re-fetches instead of showing an
     * empty transcript that looks like a deleted one.
     *
     * The ids about to be deleted are read inside the same transaction as the
     * delete, with the exact predicate the delete itself uses — anything with
     * a pending operation is excluded from both, so the media freed below can
     * never be a photo or voice note the outbox still owns. Freeing happens
     * after the transaction commits: the settings sheet's "clear cache"
     * button reports [TailchatDatabase.storedBytes], which already counts
     * this cache, and used to leave it untouched — the figure barely moved
     * no matter how many times the button was pressed.
     */
    suspend fun clearTranscripts(accountKey: String) {
        val freedIds = db.withTransaction {
            val ids = db.messages().idsExceptPending(accountKey)
            db.messages().deleteAccountExceptPending(accountKey)
            db.conversations().markAllUnseeded(accountKey, clock())
            ids
        }
        freedIds.forEach { media.deleteFor(accountKey, it) }
    }

    /** Same as [clearTranscripts], scoped to one conversation ("/clear"). */
    suspend fun clearTranscript(accountKey: String, peer: String) {
        val freedIds = db.withTransaction {
            val ids = db.messages().conversationIdsExceptPending(accountKey, peer)
            db.messages().deleteConversationExceptPending(accountKey, peer)
            db.conversations().markUnseeded(accountKey, peer, clock())
            ids
        }
        freedIds.forEach { media.deleteFor(accountKey, it) }
    }

    /**
     * A contact this account deleted, and with it this account's whole local
     * copy of that conversation: the transcript, the conversation row, the
     * draft, the notification deliveries — one transaction, so a roster can
     * never lose the contact while the rows that named it survive.
     *
     * Unlike [forgetAccount]'s `keepPending` branch, the outbox rows for this
     * peer go too, and so do the messages they still own: the server refuses
     * frames between the two (`peer_not_found`) and keeps answering an empty
     * history page for this pair forever, so a queued message for a deleted
     * contact is a send that can never land. That is also why nothing here
     * re-seeds the conversation: there is no server state left to re-fetch —
     * the contact is gone from the roster, and [deletePeer] takes the row the
     * UI would have drawn with it.
     *
     * Media is freed after the transaction commits, never inside it: a
     * rollback must not have already deleted files a surviving row points at
     * (see [clearTranscript]).
     */
    suspend fun purgeContact(accountKey: String, peer: String) {
        val freedIds = db.withTransaction {
            val ids = db.messages().conversationIds(accountKey, peer)
            db.messages().deleteConversation(accountKey, peer)
            db.pendingOps().deletePeer(accountKey, peer)
            db.conversations().deletePeer(accountKey, peer)
            db.drafts().clear(accountKey, peer, sentText = null)
            db.notificationDeliveries().deletePeer(accountKey, peer)
            ids
        }
        freedIds.forEach { media.deleteFor(accountKey, it) }
    }

    /** Pulls a message out of the send queue before deleting it locally — a
     *  message still in flight must stop being owed, or the next queue pass
     *  would put back what was just deleted. */
    suspend fun cancelOperationsFor(accountKey: String, messageId: String) =
        db.pendingOps().deleteForMessage(accountKey, messageId)

    suspend fun draft(accountKey: String, peer: String): DraftEntity? = db.drafts().find(accountKey, peer)

    suspend fun saveDraft(draft: DraftEntity) = db.drafts().upsert(draft)

    /** Clears only if the stored text is still what was sent; anything typed
     *  since the send is newer than the send and survives it. */
    suspend fun clearDraft(accountKey: String, peer: String, sentText: String?) =
        db.drafts().clear(accountKey, peer, sentText)

    suspend fun cursor(accountKey: String): Long = db.syncState().find(accountKey)?.cursor ?: 0L

    /**
     * The cursor moves only with the changes it accounts for. A body that
     * throws leaves the cursor where it was, so the next sync asks for the
     * same page again — a page applied twice is harmless, a page skipped is
     * a message that never arrives.
     */
    suspend fun advanceCursorWith(accountKey: String, cursor: Long, body: suspend () -> Unit) {
        db.withTransaction {
            body()
            db.syncState().setCursor(accountKey, cursor, clock())
        }
    }

    /**
     * Logout. With [keepPending] the queue and the messages it owns stay: an
     * account switch is not the user asking to throw away what they wrote and
     * the app has not sent yet.
     */
    suspend fun forgetAccount(accountKey: String, keepPending: Boolean) {
        val now = clock()
        val freedIds = db.withTransaction {
            db.drafts().deleteAccount(accountKey)
            db.conversations().deleteAccount(accountKey)
            db.accounts().delete(accountKey)
            db.notificationDeliveries().suppressAccount(accountKey, now)
            if (keepPending) {
                val ids = db.messages().idsExceptPending(accountKey)
                db.messages().deleteAccountExceptPending(accountKey)
                db.syncState().resetCursorKeepImportMarker(accountKey, now)
                ids
            } else {
                db.pendingOps().deleteAccount(accountKey)
                db.messages().deleteAccount(accountKey)
                db.syncState().deleteAccount(accountKey)
                emptyList()
            }
        }
        // Outside the transaction: a rollback must not have already deleted
        // files a surviving row still points at. `keepPending` never reaches
        // the branch below — the queue it protects is exactly what still owns
        // media on disk. The rows deleted *above* in that same branch were
        // never pending, so `freedIds` frees exactly those, the same as
        // `clearTranscripts`.
        if (!keepPending) media.deleteAccount(accountKey) else freedIds.forEach { media.deleteFor(accountKey, it) }
    }

    internal suspend fun legacyImported(accountKey: String): Boolean =
        db.syncState().find(accountKey)?.importedLegacy == true

    internal suspend fun markLegacyImported(accountKey: String) =
        db.syncState().setImportedLegacy(accountKey, imported = true, now = clock())

    /**
     * A write that is allowed to fail: a full disk, a constraint violation on
     * a duplicate id. The transaction rolls back, so `false` really does mean
     * "no row exists".
     */

    private suspend fun write(body: suspend () -> Unit): Boolean = try {
        db.withTransaction { body() }
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        false
    }

    /** What the conversation list shows instead of an empty bubble. */
    private fun mediaTag(message: MessageEntity): String? = when {
        message.imageDataUrl != null -> MessageKind.IMAGE
        message.voiceDataUrl != null -> MessageKind.VOICE
        else -> null
    }

    /** Runs [block] — a [withCachedMedia] call, which can throw when
     *  [MediaCache.store] fails to write — and turns that failure into
     *  `null`, the same "the store refused it" signal every write in this
     *  class already returns instead of throwing past its own documented
     *  contract. Never swallows cancellation. */
    private inline fun <T> mediaCacheGuard(block: () -> T): T? = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    /** Takes a literal `data:` URL off a row about to be persisted and
     *  replaces it with the short `media://` reference [MediaCache] hands
     *  back — see [MediaCache] for why. A value that is already a reference
     *  (a retry re-enqueueing the same op, a second call for the message and
     *  its paired operation) is written again under the same name: harmless,
     *  since the key is derived from (accountKey, id, slot), not random. */
    private fun withCachedMedia(message: MessageEntity): MessageEntity {
        val image = message.imageDataUrl?.takeIf { it.startsWith("data:") }
            ?.let { media.store(message.accountKey, message.id, "img", it) } ?: message.imageDataUrl
        val voice = message.voiceDataUrl?.takeIf { it.startsWith("data:") }
            ?.let { media.store(message.accountKey, message.id, "voice", it) } ?: message.voiceDataUrl
        return if (image == message.imageDataUrl && voice == message.voiceDataUrl) message
        else message.copy(imageDataUrl = image, voiceDataUrl = voice)
    }

    /** Same rewrite, for the copy of the image/voice a `"message"` pending
     *  operation carries inside [PendingOperationEntity.payloadJson]. */
    private fun withCachedMedia(op: PendingOperationEntity): PendingOperationEntity {
        if (op.kind != OperationKind.MESSAGE) return op
        val payload = Payloads.parseMessagePayload(op.payloadJson) ?: return op
        val id = op.messageId ?: op.opId
        val image = payload.imageDataUrl?.takeIf { it.startsWith("data:") }
            ?.let { media.store(op.accountKey, id, "img", it) } ?: payload.imageDataUrl
        val voice = payload.voiceDataUrl?.takeIf { it.startsWith("data:") }
            ?.let { media.store(op.accountKey, id, "voice", it) } ?: payload.voiceDataUrl
        if (image == payload.imageDataUrl && voice == payload.voiceDataUrl) return op
        return op.copy(payloadJson = payload.copy(imageDataUrl = image, voiceDataUrl = voice).toJson())
    }

    /** What [SyncEngine] sends on the wire needs the real `data:` URL, not
     *  the reference stored on disk — the only remaining caller of this
     *  resolve step now that [messages]/[messagePage]/[message] hand the UI
     *  the raw reference and let it resolve on demand (see [resolveMedia]).
     *  A dangling reference (the file was cleared out from under it)
     *  resolves to `null` — the same as a row that never had media. */
    private fun withResolvedMedia(op: PendingOperationEntity): PendingOperationEntity {
        if (op.kind != OperationKind.MESSAGE) return op
        val payload = Payloads.parseMessagePayload(op.payloadJson) ?: return op
        val image = payload.imageDataUrl?.let(media::load)
        val voice = payload.voiceDataUrl?.let(media::load)
        if (image == payload.imageDataUrl && voice == payload.voiceDataUrl) return op
        return op.copy(payloadJson = payload.copy(imageDataUrl = image, voiceDataUrl = voice).toJson())
    }

    private fun MessagePayload.toJson(): String = Payloads.messagePayload(
        text = text, ts = ts, author = author,
        imageDataUrl = imageDataUrl, imageWidth = imageWidth, imageHeight = imageHeight,
        voiceDataUrl = voiceDataUrl, voiceDurationSec = voiceDurationSec,
        replyId = replyId, replyFrom = replyFrom, replyText = replyText, replyMedia = replyMedia,
        forwardLogin = forwardLogin, forwardName = forwardName,
    )

    /**
     * Runs [block]; on a `SQLiteException` — in practice always
     * `SQLiteBlobTooBigException`, a pre-[MediaCache] row whose inline media
     * alone is too big for any `CursorWindow` — repairs it and retries once.
     * A second failure is a different bug and is left to throw.
     */
    private suspend fun <T> readSafely(accountKey: String, block: suspend () -> T): T = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: SQLiteException) {
        repairOversizedRows(accountKey)
        block()
    }

    /** [Flow.retryWhen] shape of [readSafely]: `observe()`'s Room-generated
     *  Flow re-runs its query on the next table invalidation, which the
     *  repair's own writes trigger — no manual resubscribe needed beyond
     *  asking for one retry. */
    private suspend fun repairAndRetry(accountKey: String, cause: Throwable, attempt: Long): Boolean {
        if (cause !is SQLiteException || attempt > 0) return false
        repairOversizedRows(accountKey)
        return true
    }

    /**
     * A row written before [MediaCache] existed (or by a future bug) whose
     * inline media alone exceeds what any `CursorWindow` can return —
     * verified true even for a `SELECT` of that one column alone, so there is
     * no query that can recover its bytes. `LENGTH()` is computed by SQLite
     * and never materializes the column's content into a window, which is
     * what lets this find and drop the value without ever reading it.
     *
     * Nothing here can resend the lost photo — the honest move is to clear
     * it in place, drop the queue entry that could otherwise "retry" an empty
     * send, and mark a message of ours failed so the person sees it and can
     * attach the photo again, instead of every future read behind it silently
     * breaking forever.
     */
    private suspend fun repairOversizedRows(accountKey: String) {
        db.withTransaction {
            for (opId in db.pendingOps().oversizedPayloadIds(accountKey, SAFE_ROW_CHARS)) {
                val ref = db.pendingOps().findRef(opId) ?: continue
                db.pendingOps().delete(opId)
                ref.messageId?.let { db.messages().markFailed(accountKey, ref.peer, it) }
            }
            for (row in db.messages().oversizedMediaRefs(accountKey, SAFE_ROW_CHARS)) {
                db.messages().clearOversizedMedia(accountKey, row.peer, row.id)
                if (row.mine) db.messages().markFailed(accountKey, row.peer, row.id)
            }
        }
    }

    companion object {
        /**
         * How long a claimed operation stays owned. Long enough that a slow
         * send is not stolen mid-flight, short enough that a process killed by
         * the system does not hold its queue hostage for a user-visible time.
         */
        const val LEASE_MS = 60_000L
        const val NOTIFICATION_CLAIM_MS = 60_000L

        /**
         * How many outstanding backfill ids one conversation may hold. A bound
         * exists because the column is read back whole: a hundred thousand ids
         * would make the row itself the reason it cannot be loaded, and the
         * feed names everything still missing again on the next sync from the
         * cursor anyway.
         */
        const val BACKFILL_MAX_IDS = 2_000

        /**
         * The repair threshold, well under the ~2 MB a `CursorWindow`
         * typically allows for a whole row: [MediaCache] means no row written
         * from here on is ever within reach of this number, so it only ever
         * matches a row written before this cache existed.
         */
        const val SAFE_ROW_CHARS = 1_500_000
    }
}
