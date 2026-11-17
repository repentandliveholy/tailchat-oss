# Durable operations protocol — Stage A and Stage B complete

Status: Stage A is complete. Stage B §3a (`read-ack-v1`), the transit-loss
half of §3b (`op-ack-v1`, implemented 2026-09-12), and the process-death half
of §3b (WAL durability for edit/react/delete/hide, implemented 2026-09-14)
are all in and covered by server tests.

This document started as the "contracts before code" deliverable required by
`android/plan_asra_12.09.2026.MD` §10. It records the corrected baseline, the
wire contracts now implemented, and the remaining durability boundary.

One concrete Stage-A-adjacent fix shipped in this same round — a real,
demonstrated duplicate-commit race in the *existing* durable path — is
recorded in §4. It required no wire change and no capability bump, so it did
not need to wait for the rest of this document.

## 1. Corrected baseline: durable-ack already exists, for messages only

`plan_asra_12.09.2026.MD` §3 says: "новая capability operation-ack-v1; название
— часть нового контракта, сейчас такой возможности нет." This is stale. The
server already declares three capabilities on `ready`
(`src/cloud/hub.js:54`, `SERVER_CAPS = ['durable-ack', 'sync-v1',
'addressed-send']`), and Android already negotiates and depends on them:

- `durable-ack` — gates nothing explicitly server-side (no `if
  (conn.caps.includes('durable-ack'))` branch exists), but is the client's
  signal that `message-accepted` following a **journaled, fsynced** commit is
  available to trust. Android's degraded-mode banner
  (`EphemeralState.kt:29`, `MISSING_CAP_TEXT`) tells the user when a
  connected server predates this.
- `sync-v1` — the account-scoped event feed (`eventsSince`/`appendEvent` in
  `accounts.js`), consumed by `SyncEngine.kt:952` (`refreshSyncFeed`-style
  reconciliation) to catch up on reconnect instead of only trusting live
  frames.
- `addressed-send` — lets a client send to a peer it has not `subscribe`d to
  (`SyncEngine.kt:747`, `hub.js:849`); without it a message can only go to
  the currently subscribed peer.

Android's outbox (`PendingOperationEntity`, `Entities.kt:167`) already
implements the client half of §3's requirements for **messages**: a stable
`opId` surviving retries, a lease (`leaseOwner`/`leaseUntil`) so a killed
process's in-flight send is resumable by exactly one sender, and
`ChatRepository.completeOperation`/`failOperation` gated on the server's
`message-accepted`/`error` reply (`SyncEngine.kt:882-895`,
`hub.js:961-1010`). The server assigns `seq`/`ts` only inside `commitHistory`
after `await wal.append(...)` resolves (`accounts.js:1387-1426`) — a message
is not acknowledged until it is fsynced, matching §3's "не обещать
долговечность квитанции, пока она не выдерживает восстановление" exactly.

**What Stage A had to establish beyond this:** message durability's
guarantees do not extend to the other four operation kinds §3 explicitly asks
for — edit, react, delete, read. That gap, not a from-scratch design, is what
Stage B is actually for.

## 2. Per-operation-kind contract, as it exists today

| kind | client completes on | server durability | server ack to sender | reconciliation on reconnect |
|---|---|---|---|---|
| message | `message-accepted` (`hub.js:970,1007`) after WAL fsync | WAL journal (`accounts.js:1409`, `journal.js`) + debounced snapshot | yes, `message-accepted`/`error` | `sync-v1` events + `findHistoryMessage` retry-dedup |
| edit | successful WAL fsync (`accounts.js:editHistory`) | WAL journal + debounced snapshot, same as messages | yes, when `op-ack-v1` (`op-accepted`) | `sync-v1` event (`kind:'edit'`) — present |
| react | successful WAL fsync (`accounts.js:reactHistory`) | WAL journal + debounced snapshot, same as messages | yes, when `op-ack-v1` | `sync-v1` event (`kind:'react'`) — present |
| delete (scope=all) | successful WAL fsync (`accounts.js:deleteHistory`) | WAL journal + debounced snapshot, same as messages | yes, when `op-ack-v1` | `sync-v1` event (`kind:'delete'`) — present |
| delete (scope=self) / hide | successful WAL fsync (`accounts.js:hideHistory`) | WAL journal + debounced snapshot, same as messages | yes, when `op-ack-v1` | `sync-v1` event, owner only — present |
| read (per-message receipt, `d.t:'read'`) | successful local socket write (`SyncEngine.kt` `drainReceipts`) | debounced snapshot only, no WAL (`accounts.js:1633-1646`) | **none to the sender** — `syncRead` explicitly excludes the sending connection (`hub.js:566-583`, `excludeConn`) | none: read state has no `sync-v1` event kind consumed by the *reading* device's own reconciliation, only `read-sync` to sibling sessions |
| read (bulk, `k:'mark-read'`) | successful local socket write | debounced snapshot only, no WAL (`accounts.js:1657-1684`) | **none to the sender** (same `syncRead` exclusion) | same as above |
| contact removal (`POST /api/contact/remove`) | the REST 200 — `removeContact` awaits `wal.append` before it answers, so the answer is the fsync | WAL journal kind `remove` + debounced snapshot (`accounts.js:applyRemoveMutation`/`removeContact`) | HTTP `200 {ok:true}`; idempotent, so a retry after a lost response is not an error | none: the per-owner state is replayed from the journal, `/api/history` is already empty for the owner on the next request, and the roster broadcast (`k:'users'`) tells every session of the account that the contact is gone — clients close the conversation whose peer left the roster |

Corrections this table makes to informal prior descriptions:

- `sync-v1` **does** carry edit/react/delete events (`recordEvent`/
  `appendEvent` calls exist in all three handlers). `SyncEngine.kt`'s comment
  "the change comes back through the sync feed" is accurate for those three,
  contrary to an initial reading of the code in isolation.
- It is **not** accurate for read: neither read path calls `appendEvent` for
  the reading account describing its own read watermark advancing — the only
  event that exists is what the *other* party's edit/delete/react would
  generate. A read receipt genuinely dropped in transit (frame never reached
  the server — the everyday failure mode on a flaky connection, not a
  disk/crash scenario) leaves no trace anywhere for the reader's own device
  to reconcile against. This matches and sharpens `CRASH_AND_LINK_BRIEF.md`
  §B1 and `handoff_opus_2026-09-12-09.03.MD` §4, which both diagnosed the
  *throttled-drop* case; the transit-drop case (connection dies between
  `socket.send()` returning and the server receiving the frame — see
  `CloudSocket.kt:244-379`, every one of `sendReceipt`/`sendEdit`/
  `sendReaction`/`sendDelete`/`sendMarkRead` is `socket?.send(...) ?: false`,
  a local queue-acceptance check only, never a delivery confirmation) is
  broader and was not called out by name before.
- Edit/react/delete/hide became WAL-durable the same way messages are on
  2026-09-14 (§3, below). Read remains the one kind that is not: a process
  that exits via `SIGINT`/`SIGTERM` is safe — `server.js:406-407` calls
  `store.flush()` then `store.close()` before exiting, and pm2's normal
  `restart`/memory-triggered restart is exactly this graceful path (confirmed
  live: `~/.pm2/logs` shows `SIGINT` in the restart sequence, not a bare
  kill). The **residual** exposure for read is an ungraceful exit —
  OOM-killed by the Linux kernel (SIGKILL, uncatchable) rather than by pm2's
  own `max_memory_restart` (which pm2 delivers as a catchable signal first)
  — on a box that also runs five other pm2 apps sharing the same memory
  ceiling. That window is the same order of magnitude as the debounced
  snapshot delay (`writeDelayMs`, 200ms in prod), not the multi-second gaps
  between restarts.

## 3. Stage B implementation status

The gaps remain independently deployable, in priority order:

### 3a. Read acknowledgment (highest value, smallest blast radius)

Capability `read-ack-v1` is implemented. When both sides declare it:

- Per-message receipt (`d.t:'read'`): after `store.markRead(...)` applies,
  reply to the **sending connection** (not just `syncRead`'s siblings) with
  `{ k: 'read-accepted', peer, id, readTs }`.
- Bulk mark (`k:'mark-read'`): reply with `{ k: 'read-accepted', peer, id:
  null, readTs }` where `readTs` is `markConversationRead`'s return value.
- Android: `SyncEngine.drainReceipts` keeps per-message rows in the existing
  `unreadIncoming` Room selection until the named acknowledgement arrives.
  Bulk `mark-read` remains in `pending_ops` and waits in `pendingReadAcks`.
  Both paths are released for retry on timeout/socket loss. A server that
  never declares `read-ack-v1` gets the prior fire-and-forget/throttle
  heuristic unchanged, with no new Room schema.
- Old clients (web, CLI): confirmed neither declares any `caps` in its `auth`
  frame (`web/cloud/app.js:7373` sends `{k:'auth', token, webFeatures:
  true}` with no `caps` key; CLI's own `sendCaps()` at `src/cli.js:2209` is
  the unrelated `caps.ai` frame, not the auth-time capability array) — so
  `conn.caps` is `[]` for both today, and a new capability is invisible to
  them by construction. This is the existing, already-proven migration
  pattern (`hub.js:1019-1023`), not a new one to invent.

The open storage question is resolved without a new table. Bulk `mark-read`
already has a durable `pending_ops` row. A per-message receipt remains durable
by *not* advancing its existing incoming message row to `Read` until
`read-accepted` names it; `unreadIncoming` naturally reconstructs the owed
receipt after reconnect. Moving those receipts into a second durable table
would duplicate the same fact and create a reconciliation problem rather than
solve one.

### 3b. Edit/react/delete/hide durability + acknowledgment (both halves done)

Two sub-problems that looked identical from the plan text but were not:

1. **Transit loss — implemented 2026-09-12.** Capability `op-ack-v1` adds
   `{k:'op-accepted', peer, opKind, id, opId?}` after `editHistory`/
   `reactHistory`/`deleteHistory`/`hideHistory` durably commits. `id` names
   the affected message; Android frames also carry a unique, retry-stable
   `opId`, echoed by the server, so two pending reactions on one message
   cannot acknowledge each other. Android holds the Room operation in
   `pendingOperationAcks` until the matching peer/kind/id/opId arrives; timeout
   or socket loss releases the lease for retry. A server or client without the
   capability retains successful-write completion and receives no new frame.
2. **Process-death loss — implemented 2026-09-14.** All four mutation
   functions now route through the same WAL shape `commitHistory` already
   used for messages: a seq is assigned and the mutation's full effect (the
   new text, the reaction toggle, the ids being removed/hidden, plus the
   `sync-v1` event(s) it produces) is `wal.append`ed and fsynced *before* the
   in-memory record is touched, exactly mirroring `commitHistory`'s
   assign-seq-then-fsync-then-apply order. `applyJournalEntry` dispatches on
   `entry.kind` (`edit`/`react`/`delete`/`hide`, alongside the pre-existing
   `history`) to one of four new pure `applyXMutation` functions shared
   between the live path and replay — each is idempotent by construction (
   setting the same text twice, or removing an already-absent id, changes
   nothing), which is what makes re-running a journal line the snapshot
   already covers safe. `commitEdit`/`commitReact`/`commitDelete`/
   `commitHide` in `hub.js` mirror `commitAndDeliver`'s fire-and-forget
   `void` + try/catch shape: a WAL failure leaves the mutation unacknowledged
   and undelivered (no `op-accepted`, no relayed frame) rather than
   pretending it landed, so the client's existing pending-operation lease
   retries it, the same way a lost `op-accepted` already did before this
   round. `test/cloud-accounts.test.js` has one test per mutation kind that
   commits a message and then a mutation through a store that is never
   `close()`d, opens a second store on the same directory (nothing reaches
   `accounts.json` either way — this is what a `kill -9` between the mutation
   and the next debounced snapshot leaves behind), and asserts the second
   store's journal replay reconstructs the fully mutated record.
   Read is deliberately **not** included here — see §2's correction above and
   §5 below; it stays on the fire-and-forget path this round.

### 3c. Account identity / dedup key — already correctly scoped, document it

The plan (§3, "Ключ дедупликации включает автора, беседу и opId") asks for a
dedup key of `(author, conversation, opId)`. What exists (`accounts.js:1387
-1426`, extended in this round) is `(conversationKey(a,b), message.id)`, with
`author` implicit — the server derives the author from `conn.login` (the
authenticated connection), never from client-supplied data, so it cannot be
spoofed; two different logins racing the same `id` in the same conversation
is not a real scenario `commitHistory`'s join needs to handle differently
from "different payload, same id", because the `from` field is part of what
`samePayload` — no, `samePayload` in the current fix compares text/media
only, not `from`. **Correction for Stage B**: if two *different* logins
raced an identical `id` with identical text (adversarial or a client bug
producing colliding non-UUID ids), the current fix would incorrectly coalesce
them under whichever login committed first. In practice Android's opId
space (`send:<uuid>`-shaped, `LegacyImporter.kt:122`) makes cross-account
collision astronomically unlikely, but Stage B's `samePayload`-equivalent for
3a/3b should compare `from` too, not just text/media, closing this before it
matters rather than after.

### 3d. Contact removal — a fifth durable mutation (2026-09-18)

`POST /api/contact/remove` deletes a contact together with this account's own
side of the conversation. It was built to the same shape as the four kinds above
rather than beside them: `removeContact` assigns a `seq`, `await
wal.append({ kind: 'remove', seq, owner, other })` fsyncs the owner, the peer and
the number, and only then does `applyRemoveMutation` touch the in-memory state.
`applyJournalEntry` dispatches `remove` to that same function, which is
idempotent by construction — the login list is a set and the purge watermark
(`state.purges[owner][conversation]`, a commit-sequence cut) only moves forward —
which is what makes a replayed line the snapshot already covers safe.

Two differences from the socket mutations, both deliberate:

- **The ack is the HTTP answer, not `op-accepted`.** There is no frame to
  acknowledge and no `opId` to echo; the request returns `{ok:true}` only after
  the fsync, and a retry after a lost response is answered `200` again rather
  than with an error, so a client never has to tell "already done" from "failed".
- **The durability promise is one-sided.** Nothing is promised to the other
  side: their roster, their copy of the log and their read state are untouched by
  design (that is the whole semantic — see the worklog entry for 2026-09-18), so
  there is nothing to tell them and nothing of theirs to reconcile. What *is*
  durable is the deleter's own view: the watermark and the removal survive a
  kill because they are replayed from the journal, and `/api/history` is empty
  for the owner on the first request after a restart.

## 4. Fixed this round, no capability needed: concurrent-commit duplicate

**Confirmed bug, not the ack gaps above.** `commitHistory`'s pre-existing
shape (`await wal.append(...)` between the decision "this id is new" and the
id becoming visible to `findHistoryMessage`) meant a client retry — ack
delayed past `ACK_TIMEOUT_MS` (20s, `SyncEngine.kt:1426`) by a backed-up WAL
queue, or the far more mundane case of the original commit still in-flight
when a reconnect-triggered resend of the same still-leased operation lands —
could reach `commitHistory` a second time before the first call's fsync
resolved. `findHistoryMessage`'s pre-check in `hub.js:961-977` only catches a
retry arriving *after* a commit finished; it has no view of one still on its
way to disk. Each concurrent call independently assigned a `seq` and pushed a
row — two records under one id in `state.history`, both delivered to the
peer.

Fixed in `accounts.js:1364-1426`: a same-conversation, same-id, same-payload
call arriving while an earlier one is still in flight now joins that
in-flight `Promise` instead of starting a second write. A differing payload
under a colliding id still commits independently (unchanged, pre-existing
behaviour for that separate, much rarer pathology — see the `from`-comparison
gap noted in §3c). No wire or capability change; purely a server-internal
correctness fix to the *existing* durable path. Verified by
`test/cloud-accounts.test.js` — two new tests fire concurrent
`commitHistory` calls via `Promise.all` (not sequentially awaited, so both
hit the join-check before either's `await wal.append` resolves) and assert a
single row/seq results; both were confirmed to fail against the pre-fix code
(row count 2, not 1) and pass against the fix.

## 5. What Stage B must not do (restated from plan §10/§3, not new)

- No second socket, no second cache, no bypassing `ChatRepository` as Room's
  only writer.
- No raising `frameRateLimit`/`PACE_BUDGET` to paper over an ack gap — none
  of the above changes frame volume in a way that would need it.
- No capability that changes behaviour for a connection that does not
  declare it. Web and CLI must see zero change until (if ever) they
  implement the new capabilities themselves.
- Ship 3a and 3b as separate rollouts. Do not let "acks for everything" become
  one PR — 3a has no durability-model change and is safe to ship alone; 3b
  does have one and deserves its own review/rollout cycle.
