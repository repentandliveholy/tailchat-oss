// Cloud Sync between this bot's reminders and Remindka's main database.
//
// "Main database" is the one the Telegram bot and the desktop app already
// share: `POST <base>/v1/sync` with `Authorization: Bearer rmk_…`, a monotonic
// `seq` cursor for pulling and last-write-wins on `updated_at` for pushing
// (see remindka/src/sync.ts and remindka/flutter_app/lib/core/sync_service.dart,
// whose wire format and conflict rule this file mirrors on purpose).
//
// The key is linked to a Telegram account by the Telegram bot's own `/sync`;
// the server answers `401 unlinked` for a key nobody linked, so this side can
// neither create a vault nor take one over.
//
// This module owns only the protocol and the merge. The bot's own state file,
// clock and chat are handed in, so the same code runs under test with a fake
// server.

export const DEFAULT_SYNC_URL = 'https://remindka.repentandliveholy.org/sync';
export const SYNC_KEY_RE = /^rmk_[A-Za-z0-9_-]{24,64}$/;
export const MAX_CHANGES = 500;

const PULL_LIMIT = 1000;
const MAX_PASSES = 10;
const MAX_TEXT = 4096;
const MAX_OPT_STRING = 4096;
const MAX_SYNC_ID = 64;
const REQUEST_TIMEOUT_MS = 12_000;
const DEBOUNCE_MS = 250;

export class SyncError extends Error {
  // code: unlinked | unauthorized | network | http | bad_response
  constructor(code, detail = '') {
    super(detail === '' ? code : `${code}: ${detail}`);
    this.name = 'SyncError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Local reminder <-> wire item.
// ---------------------------------------------------------------------------

// The bot's own states are scheduled / fired / done (+ `cancelled`, a deletion
// that has not reached the server yet); the wire's are scheduled / sent / done
// / cancelled.
export function statusOf(reminder) {
  if (reminder.status === 'cancelled') return 'cancelled';
  if (reminder.status === 'done' || reminder.ackedAt !== undefined) return 'done';
  return reminder.firedAt !== undefined ? 'sent' : 'scheduled';
}

export function syncIdOf(reminder) {
  return `tc-${reminder.id}`.slice(0, MAX_SYNC_ID);
}

const int = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
};

// When the next repeat of a delivered-and-unanswered reminder is due. A
// reminder that another surface (the Telegram bot) delivered keeps *its*
// schedule, because that surface is the one repeating it.
function nextNagAt(reminder, { nagMs, nagMax, dayMs }) {
  if (reminder.remoteFired) return reminder.remoteNextNagAt ?? null;
  if (reminder.lastNagAt === undefined) return null;
  const count = int(reminder.nagCount);
  return reminder.lastNagAt + (nagMax > 0 && count < nagMax ? nagMs : dayMs);
}

export function toWire(reminder, cadence) {
  const status = statusOf(reminder);
  const origin = reminder.source?.name ? String(reminder.source.name).slice(0, MAX_OPT_STRING) : null;
  return {
    sync_id: reminder.syncId,
    text: String(reminder.text ?? '').slice(0, MAX_TEXT),
    origin,
    origin_url: null,
    due_at: int(reminder.dueAt),
    status,
    next_nag_at: status === 'sent' ? nextNagAt(reminder, cadence) : null,
    nag_count: int(reminder.nagCount),
    created_at: int(reminder.createdAt, int(reminder.dueAt)),
    updated_at: int(reminder.updatedAt),
  };
}

// Everything that makes two versions of a reminder different, i.e. everything
// but the stamp. A change is detected by comparing this with the one recorded
// at the last sync, so no mutation site in the bot has to remember to mark a
// reminder dirty.
export function fingerprint(wire) {
  return JSON.stringify([
    wire.sync_id, wire.text, wire.origin, wire.due_at, wire.status,
    wire.next_nag_at, wire.nag_count, wire.created_at,
  ]);
}

function validItem(item) {
  return item && typeof item === 'object'
    && typeof item.sync_id === 'string' && item.sync_id !== '' && item.sync_id.length <= MAX_SYNC_ID
    && typeof item.status === 'string'
    && Number.isFinite(Number(item.due_at))
    && Number.isFinite(Number(item.updated_at));
}

// Applies one server item to a local reminder. Returns the reminder to keep,
// or `null` when the item means "nothing here" (a reminder that is already
// finished or deleted elsewhere and that we never had).
export function reminderFromRemote(existing, item, { ownerId, now }) {
  if (item.status === 'cancelled') return null;
  if (item.status === 'done') {
    if (!existing) return null;
    existing.status = 'done';
    existing.ackedAt = existing.ackedAt ?? int(item.updated_at, now);
    return existing;
  }
  if (item.status !== 'scheduled' && item.status !== 'sent') return existing ?? null;

  const reminder = existing ?? {
    id: `remote-${item.sync_id}`,
    ownerId,
    syncId: item.sync_id,
    createdAt: int(item.created_at, now),
  };
  reminder.text = typeof item.text === 'string' && item.text.trim() !== '' ? item.text.trim() : 'Reminder';
  reminder.dueAt = int(item.due_at);
  reminder.nagCount = int(item.nag_count);
  delete reminder.ackedAt;
  if (typeof item.origin === 'string' && item.origin !== '') {
    if (reminder.source?.name !== item.origin) reminder.source = { login: '', name: item.origin };
  } else {
    delete reminder.source;
  }
  if (item.status === 'scheduled') {
    reminder.status = 'scheduled';
    delete reminder.firedAt;
    delete reminder.lastNagAt;
    delete reminder.remoteFired;
    delete reminder.remoteNextNagAt;
  } else {
    // Somebody else delivered it. It is open and answerable here, but repeating
    // it is that surface's job, or the same reminder would arrive twice.
    reminder.status = 'fired';
    reminder.firedAt = reminder.firedAt ?? now;
    reminder.lastNagAt = now;
    reminder.remoteFired = true;
    reminder.remoteNextNagAt = item.next_nag_at == null ? null : int(item.next_nag_at);
  }
  return reminder;
}

// ---------------------------------------------------------------------------
// Engine.
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {{reminders: object[], users: object, save: () => void}} options.store
 * @param {(reminder: object) => string} options.ownerOf
 * @param {{nagMs: number, nagMax: number, dayMs: number}} options.cadence
 */
export function createRemindkaSync({
  store,
  ownerOf,
  cadence,
  baseUrl = DEFAULT_SYNC_URL,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {},
}) {
  const root = String(baseUrl).trim().replace(/\/+$/, '');
  const inflight = new Map();
  const followUp = new Set();
  const debounce = new Map();
  let periodic = null;
  let applying = false;

  // The bot's own `store.save()` is what asks for a push (see `schedule`). A
  // save made by sync itself must not, or a failing round would retry itself
  // in a tight loop.
  const quietSave = () => {
    applying = true;
    try { store.save(); } finally { applying = false; }
  };

  const stateOf = (peer) => store.users[peer]?.sync ?? null;
  const mine = (peer) => store.reminders.filter((reminder) => ownerOf(reminder) === peer);
  const wireOf = (reminder) => toWire(reminder, cadence);

  async function post(key, body) {
    let response;
    try {
      response = await fetchImpl(`${root}/v1/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SyncError('network', error?.message ?? String(error));
    }
    let text = '';
    try { text = await response.text(); } catch { /* handled by the status below */ }
    if (response.status === 401) {
      throw new SyncError(/unlinked/i.test(text) ? 'unlinked' : 'unauthorized');
    }
    if (!response.ok) throw new SyncError('http', `${response.status} ${text.slice(0, 120)}`);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new SyncError('bad_response', 'not JSON'); }
    if (!payload || payload.ok !== true || !Number.isSafeInteger(payload.cursor)
      || !Array.isArray(payload.items) || !Array.isArray(payload.applied) || !Array.isArray(payload.rejected)) {
      throw new SyncError('bad_response', 'unexpected shape');
    }
    return payload;
  }

  // One push + pull round. Synchronous before and after the request, so the
  // state it reads and the state it writes back are never interleaved with a
  // chat command.
  async function round(peer, sync) {
    const t = now();
    for (const reminder of mine(peer)) {
      if (!reminder.syncId) reminder.syncId = syncIdOf(reminder);
      const print = fingerprint(wireOf(reminder));
      if (print !== reminder.syncStamp) {
        reminder.syncStamp = print;
        reminder.updatedAt = t;
      }
    }
    const dirty = mine(peer).filter((reminder) => fingerprint(wireOf(reminder)) !== reminder.syncBase);
    const batch = dirty.slice(0, MAX_CHANGES);
    const sent = new Map(batch.map((reminder) => [reminder.syncId, fingerprint(wireOf(reminder))]));

    const payload = await post(sync.key, { cursor: sync.cursor, changes: batch.map(wireOf) });

    applying = true;
    let imported = 0;
    let removed = 0;
    try {
      // Accepted and server-superseded changes are both settled: for the
      // second kind the newer server version comes back in `items` below. A
      // reminder edited again while the request was in flight stays dirty.
      for (const id of [...payload.applied, ...payload.rejected]) {
        const reminder = mine(peer).find((candidate) => candidate.syncId === id);
        if (reminder && fingerprint(wireOf(reminder)) === sent.get(id)) reminder.syncBase = sent.get(id);
      }

      for (const item of payload.items) {
        if (!validItem(item)) continue;
        const local = mine(peer).find((candidate) => candidate.syncId === item.sync_id);
        if (local) {
          // Last write wins, like the server: equal stamps are our own echo.
          if (int(item.updated_at) <= int(local.updatedAt)) continue;
          // Edited since it was stamped, i.e. while the request was in flight:
          // the newer local edit goes out next round and wins there.
          if (fingerprint(wireOf(local)) !== local.syncStamp) continue;
        }
        const next = reminderFromRemote(local, item, { ownerId: peer, now: t });
        if (next === null) {
          if (local) {
            store.reminders.splice(store.reminders.indexOf(local), 1);
            removed += 1;
          }
          continue;
        }
        if (!local) {
          store.reminders.push(next);
          imported += 1;
        }
        next.updatedAt = int(item.updated_at);
        next.syncStamp = next.syncBase = fingerprint(wireOf(next));
      }
      const changed = batch.length > 0 || imported > 0 || removed > 0 || payload.cursor !== sync.cursor;
      sync.cursor = payload.cursor;
      sync.lastSyncedAt = t;
      delete sync.lastError;
      if (changed) store.save();
    } finally {
      applying = false;
    }
    return {
      pushed: batch.filter((reminder) => payload.applied.includes(reminder.syncId)).length,
      imported,
      removed,
      more: dirty.length > MAX_CHANGES || payload.items.length >= PULL_LIMIT,
    };
  }

  async function passes(peer) {
    const total = { pushed: 0, imported: 0, removed: 0 };
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const sync = stateOf(peer);
      if (!sync) break;
      let result;
      try {
        result = await round(peer, sync);
      } catch (error) {
        if (error instanceof SyncError) sync.lastError = error.code;
        throw error;
      }
      total.pushed += result.pushed;
      total.imported += result.imported;
      total.removed += result.removed;
      if (!result.more) break;
    }
    return total;
  }

  function exclusive(peer, work) {
    const run = (async () => {
      try {
        return await work();
      } finally {
        inflight.delete(peer);
        if (followUp.delete(peer) && stateOf(peer)) void syncPeer(peer);
      }
    })();
    inflight.set(peer, run);
    return run;
  }

  // Never throws: a failed round is a fact on the peer's sync state (`lastError`)
  // and a line in the log, and the next round retries from the same cursor.
  async function syncPeer(peer) {
    if (!stateOf(peer)) return null;
    if (inflight.has(peer)) {
      followUp.add(peer);
      return inflight.get(peer).catch(() => null);
    }
    return exclusive(peer, async () => {
      try {
        const total = await passes(peer);
        if (total.imported > 0 || total.pushed > 0 || total.removed > 0) {
          log(`sync ${peer}: pushed ${total.pushed}, imported ${total.imported}, removed ${total.removed}`);
        }
        return total;
      } catch (error) {
        log(`sync ${peer} failed: ${error.message}`);
        return null;
      }
    });
  }

  // Links `peer` to a key. The key is kept only if the first round succeeds, so
  // a mistyped or unlinked key is never persisted. Throws SyncError otherwise.
  async function link(peer, key) {
    if (!SYNC_KEY_RE.test(key)) throw new SyncError('bad_key');
    if (stateOf(peer)) throw new SyncError('already_linked');
    const user = store.users[peer] ?? (store.users[peer] = {});
    user.sync = { key, cursor: 0 };
    for (const reminder of mine(peer)) delete reminder.syncBase;
    return exclusive(peer, async () => {
      try {
        const first = await round(peer, user.sync);
        const rest = first.more ? await passes(peer).catch(() => ({ pushed: 0, imported: 0, removed: 0 })) : { pushed: 0, imported: 0, removed: 0 };
        return {
          pushed: first.pushed + rest.pushed,
          imported: first.imported + rest.imported,
        };
      } catch (error) {
        delete user.sync;
        quietSave();
        throw error;
      }
    });
  }

  // Stops syncing. Local reminders stay; deletions that never reached the
  // server are dropped with the link, since nothing will ever carry them.
  function unlink(peer) {
    const user = store.users[peer];
    if (!user?.sync) return false;
    delete user.sync;
    for (let i = store.reminders.length - 1; i >= 0; i -= 1) {
      const reminder = store.reminders[i];
      if (ownerOf(reminder) !== peer) continue;
      if (reminder.status === 'cancelled') store.reminders.splice(i, 1);
      delete reminder.syncBase;
      delete reminder.remoteFired;
      delete reminder.remoteNextNagAt;
    }
    quietSave();
    return true;
  }

  function schedule() {
    if (applying) return;
    for (const peer of linkedPeers()) {
      if (debounce.has(peer)) continue;
      const timer = setTimeout(() => {
        debounce.delete(peer);
        void syncPeer(peer);
      }, DEBOUNCE_MS);
      timer.unref?.();
      debounce.set(peer, timer);
    }
  }

  function linkedPeers() {
    return Object.keys(store.users).filter((peer) => store.users[peer]?.sync);
  }

  // A reminder whose latest state the server has not seen yet. The bot's own
  // clean-up must keep these, or a deletion could vanish before it was pushed.
  function isPending(reminder) {
    const owner = ownerOf(reminder);
    if (!stateOf(owner)) return false;
    return reminder.syncId === undefined || fingerprint(wireOf(reminder)) !== reminder.syncBase;
  }

  function start(intervalMs = 30_000) {
    stop();
    for (const peer of linkedPeers()) void syncPeer(peer);
    periodic = setInterval(() => {
      for (const peer of linkedPeers()) void syncPeer(peer);
    }, intervalMs);
    periodic.unref?.();
  }

  function stop() {
    if (periodic) clearInterval(periodic);
    periodic = null;
    for (const timer of debounce.values()) clearTimeout(timer);
    debounce.clear();
  }

  return {
    isLinked: (peer) => stateOf(peer) !== null,
    linkedPeers,
    stateOf,
    isPending,
    syncPeer,
    link,
    unlink,
    schedule,
    start,
    stop,
  };
}
