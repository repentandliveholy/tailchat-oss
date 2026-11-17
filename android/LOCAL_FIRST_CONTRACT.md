# Local-first cutover contract

Frozen interfaces for the migration described in `LOCAL_FIRST_EXECUTION_PLAN.md`.
Owners implement against this document; it is the single source of truth for
schema names, wire formats and ownership boundaries. Anything not named here is
the implementing owner's local decision.

## 0. Ownership

| Owner | Files it may write |
|---|---|
| Server | `src/cloud/journal.js`, `src/cloud/accounts.js`, `src/cloud/hub.js`, `test/cloud-*.test.js` |
| Storage | `android/app/src/main/java/net/tailchat/android/data/**`, `android/app/src/test/java/net/tailchat/android/data/**` |
| Integration (main agent) | `cloud/CloudController.kt`, `cloud/SyncEngine.kt`, `cloud/CloudModels.kt`, `cloud/CloudSocket.kt`, `ui/**`, `MainActivity.kt`, `ChatService.kt`, `app/build.gradle.kts` |

## 1. Server wire contract

### 1.1 Capabilities

Inbound: `{k:'auth', token, webFeatures?, caps?: string[]}`.
`caps` is an array of opaque capability strings the *client* implements.
Recognised: `durable-ack`, `sync-v1`, `addressed-send`.

Outbound `ready` gains one field:

```
{k:'ready', self:{login,name}, users:[…], caps:['durable-ack','sync-v1','addressed-send']}
```

`caps` on `ready` is what the *server* supports. A client that sees no `caps`
key is talking to an old server and MUST keep its queue, degrade to the
subscription-scoped path and surface the limitation. Absent `caps` on `auth`
means a legacy client: every behaviour below stays exactly as it is today.

### 1.2 Durable acceptance

`relay` for `d.t === 'msg'` / `'ai'`:

1. Idempotency lookup `store.findHistoryMessage(from, to, d.id, from)`.
   - Found and `text`/media identical → re-send the original receipt built from
     the **stored** record (`id`, `ts` from storage). No delivery, no history
     write, no AI call.
   - Found and content differs → `{k:'error', code:'message_id_conflict'}`;
     the stored message is not overwritten.
2. Otherwise `await store.commitHistory(from, to, record)`, which appends to the
   write-ahead journal, fsyncs, and only then applies in memory.
3. Acceptance is emitted **after** a successful commit:
   `{k:'message-accepted', peer, id, ts, seq}` where `ts` and `seq` come from
   the committed record. A commit rejection emits
   `{k:'error', code:'store_failed'}` and no acceptance.

`seq` is the account-scoped monotonic sequence number assigned by the commit.

`store_failed` and `message_id_conflict` are the only error envelopes that
carry correlation fields, because they are the only ones a per-operation state
machine has to attribute to one queued message:
`{k:'error', code, peer, id, message}`. Every other error keeps its current
shape.

### 1.3 Resumable sync

Every durable mutation appends an event to both participants' account logs.

Inbound: `{k:'sync', since?: number, limit?: number}`.
Outbound:

```
{k:'sync-page', events:[Event], cursor:<number>, more:<bool>, reset:<bool>}
```

`reset:true` means `since` is older than the retained window: the client must
re-seed affected conversations from `/api/history` and keep its outbox.

```
Event = {
  seq: number,          // monotonic per account, gap-free ordering not promised
  kind: 'message' | 'edit' | 'delete' | 'react' | 'read',
  peer: string,         // the other side of the conversation
  id?: string,          // message id
  ts?: number,
  text?: string,        // 'edit'
  emoji?: string, by?: string, add?: boolean,   // 'react'
  ids?: string[],       // 'delete'
  scope?: 'self'|'all', // 'delete'
  readTs?: number,      // 'read'
  from?: string,        // 'message' author login
  self?: boolean,       // 'message' authored by this account
}
```

Retention: `EVENT_LIMIT` newest events per account.

### 1.4 Addressed send

When `to !== conn.peer` the relay is accepted if and only if the sender
declared `addressed-send` **and** (`to === conn.login` or
`store.areFriends(conn.login, to)`). Otherwise the existing
`not_subscribed` error is unchanged. Delivery, queueing, self-sync, push and
`conversation-update` behaviour is identical to the subscribed path.

### 1.5 AI typing lease

`announceAiTyping(from, to, 'start')` starts a renewal interval that re-emits
`start` every 3 s until the bridge promise settles; settle/reject clears the
interval and emits `stop` exactly once.

## 2. Android storage contract (Room, database version 1)

Database file `tailchat.db`, class `TailchatDatabase`, package
`net.tailchat.android.data`. Schemas exported to `app/schemas`.

`accountKey` = `"<normalised server origin>|<login>"`. Every row is
account-scoped by it; nothing is keyed by login alone.

```kotlin
@Entity(tableName = "accounts")
AccountEntity(accountKey PK, server, login, name)

@Entity(tableName = "conversations", primaryKeys = ["accountKey","peer"])
ConversationEntity(
  accountKey, peer, name, self: Boolean,
  previewFrom: String?, previewText: String?, previewMedia: String?, previewTs: Long,
  unread: Int, readWatermarkTs: Long, peerReadTs: Long,
  online: Boolean, lastSeen: Long?,
  historySeeded: Boolean,       // false = local history has never been fetched
  updatedAt: Long,
)

@Entity(tableName = "messages", primaryKeys = ["accountKey","peer","id"])
MessageEntity(
  accountKey, peer, id, text, ts, author, mine: Boolean,
  delivery: Int,                // ordinal of DeliveryState below
  system: Boolean, kind: String,
  imageDataUrl: String?, imageWidth: Int?, imageHeight: Int?,
  voiceDataUrl: String?, voiceDurationSec: Int?,
  reactionsJson: String?, replyJson: String?, forwardJson: String?,
  editedAt: Long?, deletedAt: Long?, serverSeq: Long?,
)

@Entity(tableName = "pending_ops")
PendingOperationEntity(
  opId PK: String,              // stable, survives retries
  accountKey, peer, kind: String, messageId: String?,
  payloadJson: String, attempts: Int, nextAttemptAt: Long,
  lastError: String?, errorKind: Int, leaseOwner: String?, leaseUntil: Long,
  createdAt: Long,
)

@Entity(tableName = "drafts", primaryKeys = ["accountKey","peer"])
DraftEntity(accountKey, peer, text, replyJson: String?, editingId: String?, updatedAt)

@Entity(tableName = "sync_state", primaryKeys = ["accountKey"])
SyncCheckpointEntity(accountKey, cursor: Long, importedLegacy: Boolean, updatedAt)
```

`DeliveryState` ordinals are frozen:
`0 Queued, 1 Sending, 2 Accepted, 3 Delivered, 4 Read, 5 Failed`.

`errorKind` ordinals: `0 None, 1 Retryable, 2 Permanent, 3 Unsupported`.

`kind` for `PendingOperationEntity`: `"message"`, `"edit"`, `"delete"`,
`"react"`, `"read"`.

### 2.1 Repository API (`ChatRepository`)

```kotlin
class ChatRepository(private val db: TailchatDatabase, private val clock: () -> Long)

suspend fun upsertAccount(account: AccountEntity)
fun conversations(accountKey: String): Flow<List<ConversationEntity>>
fun messages(accountKey: String, peer: String, limit: Int): Flow<List<MessageEntity>>
suspend fun messagePage(accountKey: String, peer: String, beforeTs: Long, limit: Int): List<MessageEntity>
suspend fun conversation(accountKey: String, peer: String): ConversationEntity?
/** The roster as one read, for the engine's background prefetch walk — it
 *  needs to know which transcripts are still missing, not a subscription. */
suspend fun conversationSnapshot(accountKey: String): List<ConversationEntity>

/** One transaction: message row + pending op + conversation preview. */
suspend fun enqueueMessage(message: MessageEntity, op: PendingOperationEntity): Boolean
suspend fun enqueueOperation(op: PendingOperationEntity): Boolean

suspend fun claimDue(accountKey: String, owner: String, now: Long, limit: Int): List<PendingOperationEntity>
suspend fun releaseLease(opId: String, nextAttemptAt: Long, error: String?, errorKind: Int)
suspend fun failOperation(opId: String, error: String, errorKind: Int)
/** One transaction: drop the op and advance the message's delivery state.
 *  `ts` is never rewritten here — a queued send keeps the composer's own
 *  timestamp so a slow acceptance can never reorder it past an
 *  already-visible newer peer message. */
suspend fun completeOperation(opId: String, messageId: String?, delivery: DeliveryState, serverSeq: Long?)
suspend fun pendingCount(accountKey: String): Flow<Int>
suspend fun pendingCount(accountKey: String, peer: String): Flow<Int>

suspend fun applyIncoming(accountKey: String, messages: List<MessageEntity>, previewFrom: String?)
suspend fun applyHistoryPage(accountKey: String, peer: String, messages: List<MessageEntity>, peerReadTs: Long)
suspend fun markDelivery(accountKey: String, peer: String, id: String, delivery: DeliveryState)
suspend fun applyEdit(accountKey: String, peer: String, id: String, text: String, editedAt: Long)
suspend fun applyDelete(accountKey: String, peer: String, ids: List<String>)
suspend fun applyReaction(accountKey: String, peer: String, id: String, emoji: String, by: String, add: Boolean)
suspend fun setUnread(accountKey: String, peer: String, unread: Int)
suspend fun readWatermark(accountKey: String, peer: String, ts: Long)

suspend fun draft(accountKey: String, peer: String): DraftEntity?
suspend fun saveDraft(draft: DraftEntity)
suspend fun clearDraft(accountKey: String, peer: String, sentText: String?)

suspend fun cursor(accountKey: String): Long
suspend fun advanceCursorWith(accountKey: String, cursor: Long, body: suspend () -> Unit)
suspend fun forgetAccount(accountKey: String, keepPending: Boolean)
```

Invariants the repository owns:
- `enqueueMessage` returns `false` only when the write failed; on `false` no row
  exists and the caller must keep the draft.
- Delivery state never moves backwards (`markDelivery` takes the max ordinal,
  except `Failed`, which is set explicitly).
- `clearDraft(sentText)` clears only when the stored text still equals
  `sentText`; newer typing survives.
- `advanceCursorWith` commits body and cursor in one transaction.
- The engine's background prefetch (`SyncEngine.prefetch`, gated by the
  «Conversation cache» setting) reaches Room only through
  `applyHistoryPage`/`acceptByServerProof` and therefore inherits every rule
  above; it never writes unread, read watermarks, view interest, subscriptions
  or receipts, and the open conversation is always served by the interactive
  path instead.

### 2.2 Legacy import

`LegacyImporter(context, repository)` with
`suspend fun importOnce(accountKey: String): ImportReport`.

- Source: `filesDir/cloud-outbox.json` and `filesDir/history/*`.
- Guarded by `SyncCheckpointEntity.importedLegacy`; the second call is a no-op.
- Source files are **left in place**; the importer never deletes them.
- Pending entries keep their original message ids and become both a
  `MessageEntity` (Queued) and a `PendingOperationEntity` in one transaction.
- Import is idempotent: re-running after a crash inserts no duplicates.

## 3. Android runtime ownership

- `SyncEngine` is the only owner of `CloudSocket`, of retry scheduling and of
  the reconciliation loop. It never reads Compose state.
- `EphemeralState` holds link/typing/presence with TTL and connection
  generation. Nothing ephemeral is written to Room.
- `ServiceCloudController` is a façade: commands, media encoding, voice capture,
  live file transfer, and delegation to repository + engine.
- `CloudUiState` (ViewModel + SavedStateHandle) owns route stack, selection,
  overlay stack, viewport anchors. One `BackHandler`, in `MainActivity`.
- WorkManager unique work `tailchat-outbox` with a network constraint resumes
  the queue; it calls the same engine, never a second sender.
