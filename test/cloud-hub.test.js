import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCloudHub } from '../src/cloud/hub.js';
import { createAccountStore as createLegacyStore } from '../src/cloud/accounts.js';
import { CLOUD_FRAME_MAX_CHARS } from '../src/cloud/limits.js';

const createAccountStore = (options) => createLegacyStore({ allowPlaintextLegacy: true, keyFile: null, ...options });

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A durable commit now goes through real disk I/O (open/write/fsync) before
// the hub delivers anything. `fsync` can legitimately take real wall-clock
// time — far more than an event-loop turn — so this polls with a short real
// delay instead of guessing a tick count.
async function until(predicate, attempts = 500) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never became true');
}

// Mirrors accounts.js's dedup rule for the fake in-memory queue: only
// human/AI messages count, and a repeated (sender, message id) pair collapses
// to one — control frames and id-less legacy frames never collapse.
function dedupedMessageCounts(items) {
  const counts = {};
  const seenIds = new Map();
  for (const item of items) {
    if (!['msg', 'ai'].includes(item.d?.t)) continue;
    const sender = item.from;
    const id = typeof item.d?.id === 'string' ? item.d.id : '';
    if (id !== '') {
      let ids = seenIds.get(sender);
      if (!ids) { ids = new Set(); seenIds.set(sender, ids); }
      if (ids.has(id)) continue;
      ids.add(id);
    }
    counts[sender] = (counts[sender] ?? 0) + 1;
  }
  return counts;
}

function fakeStore(logins = ['anna', 'boris', 'roman']) {
  const accounts = new Map(logins.map((login, index) => [login, {
    login,
    name: login[0].toUpperCase() + login.slice(1),
    lastSeen: 1000 + index,
  }]));
  const queue = new Map();
  const recorded = [];
  const committed = [];
  const events = new Map();
  let lastSeq = 0;
  const deleted = [];
  const hidden = [];
  const reads = [];
  const deliveryAdvances = [];
  const deliveries = new Map();
  const touched = [];
  const friendMap = new Map();
  const blockedMap = new Map();
  const removedMap = new Map();
  const aliasMap = new Map();
  const markedUnread = new Map();
  const reminders = [];
  let nextReminderId = 0;
  for (const login of logins) {
    friendMap.set(login, new Set(logins.filter((l) => l !== login)));
  }

  return {
    accounts,
    queue,
    recorded,
    committed,
    events,
    friendMap,
    blockedMap,
    removedMap,
    deleted,
    hidden,
    reads,
    deliveryAdvances,
    deliveries,
    touched,
    resolveToken(token) {
      if (typeof token !== 'string' || !token.startsWith('token-')) return null;
      const account = accounts.get(token.slice('token-'.length));
      return account ? { login: account.login, name: account.name } : null;
    },
    touch(login, at) {
      touched.push([login, at]);
      const account = accounts.get(login);
      if (account) account.lastSeen = at;
    },
    users() {
      return [...accounts.values()].map(({ login, name, lastSeen }) => ({ login, name, lastSeen }));
    },
    friends(login) {
      const list = [...(friendMap.get(login) || [])];
      return list
        .map((l) => accounts.get(l))
        .filter(Boolean)
        .map(({ login, name, lastSeen }) => ({ login, name, lastSeen }));
    },
    areFriends(a, b) {
      return Boolean(friendMap.get(a)?.has(b) && friendMap.get(b)?.has(a));
    },
    hasBlocked(a, b) {
      return Boolean(blockedMap.get(a)?.has(b));
    },
    blockUser(login, target) {
      const set = blockedMap.get(login) ?? new Set();
      set.add(target);
      blockedMap.set(login, set);
      return { ok: true };
    },
    unblockUser(login, target) {
      blockedMap.get(login)?.delete(target);
      return { ok: true };
    },
    isRemoved(owner, target) {
      return Boolean(removedMap.get(owner)?.has(target));
    },
    removedLogins(login) {
      return [...(removedMap.get(login) ?? new Set())];
    },
    // Nicknames the owner gave contacts (issue #28): private per owner, absent
    // when there is none — the same shape the real store answers with.
    setAlias(login, peer, name) {
      const byPeer = aliasMap.get(login) ?? new Map();
      if (name === undefined || name === null || String(name).trim() === '') byPeer.delete(peer);
      else byPeer.set(peer, String(name).trim());
      aliasMap.set(login, byPeer);
      return { ok: true, alias: byPeer.get(peer) ?? '' };
    },
    aliasOf(login, peer) {
      return aliasMap.get(login)?.get(peer) ?? '';
    },
    // One-sided, like the real store: the contact leaves this account's list
    // and this account's own queue loses the frames from it. The other side's
    // roster, queue and history are untouched.
    async removeContact(login, peer) {
      const set = removedMap.get(login) ?? new Set();
      set.add(peer);
      removedMap.set(login, set);
      const items = queue.get(login) ?? [];
      queue.set(login, items.filter((item) => item.from !== peer));
      return { ok: true, removed: true };
    },
    pending(login) {
      const counts = {};
      for (const item of queue.get(login) ?? []) counts[item.from] = (counts[item.from] ?? 0) + 1;
      return counts;
    },
    unreadCounts(login) {
      const counts = dedupedMessageCounts(queue.get(login) ?? []);
      for (const peer of markedUnread.get(login) ?? []) {
        if ((counts[peer] ?? 0) === 0) counts[peer] = 1;
      }
      return counts;
    },
    countMessageItems(items) {
      return Object.values(dedupedMessageCounts(items)).reduce((sum, n) => sum + n, 0);
    },
    enqueue(login, item) {
      const items = queue.get(login) ?? [];
      items.push(item);
      queue.set(login, items);
      return items.length;
    },
    drain(login, from) {
      const items = queue.get(login) ?? [];
      queue.set(login, items.filter((item) => item.from !== from));
      return items.filter((item) => item.from === from);
    },
    recordHistory(a, b, message) {
      recorded.push({ a, b, message });
      return true;
    },
    // The durable path. `failCommit` is what a disk that refuses the write
    // looks like from here.
    async commitHistory(a, b, message) {
      if (this.failCommit) throw new Error('journal write failed');
      recorded.push({ a, b, message });
      const seq = ++lastSeq;
      const stored = { ...message, seq };
      committed.push({ a, b, record: stored });
      for (const [login, peer] of [[a, b], [b, a]]) {
        if (login === b && a === b) continue;
        const list = events.get(login) ?? [];
        list.push({ seq, kind: 'message', peer, id: stored.id, ts: stored.ts, from: stored.from,
          ...(stored.from === login ? { self: true } : {}) });
        events.set(login, list);
      }
      return stored;
    },
    findHistoryMessage(a, b, id, from = null) {
      const entry = committed.find((row) => row.record.id === id
        && (from == null || row.record.from === from)
        && ((row.a === a && row.b === b) || (row.a === b && row.b === a)));
      return entry ? entry.record : null;
    },
    eventsSince(login, since = 0, limit = 200) {
      const list = events.get(login) ?? [];
      const remaining = list.filter((event) => event.seq > since);
      const page = remaining.slice(0, limit);
      return {
        events: page,
        cursor: page.length > 0 ? page[page.length - 1].seq : since,
        more: remaining.length > page.length,
        reset: since > 0 && list.length > 0 && since < list[0].seq,
      };
    },
    async deleteHistory(a, b, ids) {
      deleted.push({ a, b, ids });
      return ids;
    },
    hideHistory(login, peer, ids) {
      hidden.push({ login, peer, ids });
      return ids.length;
    },
    markRead(reader, peer, id) {
      const items = queue.get(reader) ?? [];
      queue.set(reader, items.filter((item) =>
        item.from !== peer || !['msg', 'ai'].includes(item.d?.t)));
      reads.push({ reader, peer, id });
      return 1;
    },
    markConversationUnread(reader, peer) {
      const peers = markedUnread.get(reader) ?? new Set();
      peers.add(peer);
      markedUnread.set(reader, peers);
      return true;
    },
    markConversationRead(reader, peer) {
      const items = queue.get(reader) ?? [];
      queue.set(reader, items.filter((item) => item.from !== peer));
      markedUnread.get(reader)?.delete(peer);
      reads.push({ reader, peer, id: null });
      return 7000;
    },
    lastMessage(owner, peer) {
      const item = [...recorded].reverse().find((entry) =>
        (entry.a === owner && entry.b === peer) || (entry.a === peer && entry.b === owner));
      return item ? { id: item.message.id, from: item.message.from, ts: item.message.ts, text: item.message.text } : null;
    },
    readTs() {
      return 0;
    },
    // The delivery watermark is the read one's forward-only twin: the same
    // message-timestamp bookkeeping, but it clears nothing — a delivered-but-
    // unread message is still owed to the reader.
    markDelivered(reader, peer, id) {
      const record = this.findHistoryMessage(reader, peer, id);
      const ts = Number.isFinite(record?.ts) ? record.ts : 0;
      const byPeer = deliveries.get(reader) ?? new Map();
      deliveries.set(reader, byPeer);
      if (ts > (byPeer.get(peer) ?? 0)) byPeer.set(peer, ts);
      deliveryAdvances.push({ reader, peer, id });
      return ts;
    },
    deliveredTs(reader, peer) {
      return deliveries.get(reader)?.get(peer) ?? 0;
    },
    nameOf(login) {
      return accounts.get(login)?.name ?? login;
    },
    scheduleReplyReminder(owner, peer, messageId, dueAt) {
      if (!this.findHistoryMessage(owner, peer, messageId) || !Number.isFinite(dueAt)) return null;
      const reminder = { id: `reminder-${++nextReminderId}`, peer, messageId, dueAt, createdAt: 5000 };
      reminders.push({ owner, ...reminder });
      return { ...reminder };
    },
    nextReplyReminderAt() {
      const pending = reminders.filter((item) => !Number.isFinite(item.firedAt));
      return pending.length ? Math.min(...pending.map((item) => item.dueAt)) : null;
    },
    dueReplyReminders(at) {
      const due = [];
      for (const item of reminders) {
        if (Number.isFinite(item.firedAt) || item.dueAt > at) continue;
        item.firedAt = at;
        due.push({ ...item });
      }
      return due;
    },
    firedReplyReminders(owner) {
      return reminders
        .filter((item) => item.owner === owner && Number.isFinite(item.firedAt))
        .map(({ owner: _owner, ...item }) => ({ ...item }));
    },
    pendingReplyReminders(owner) {
      return reminders
        .filter((item) => item.owner === owner && !Number.isFinite(item.firedAt))
        .map(({ owner: _owner, ...item }) => ({ ...item }));
    },
    // Bot accounts (`markBot`/`isBot` in src/cloud/accounts.js): durable there,
    // a set here — the hub's own behaviour is what these tests are about.
    bots: new Set(),
    markBot(login) {
      if (this.bots.has(login)) return false;
      this.bots.add(login);
      return true;
    },
    isBot(login) {
      return this.bots.has(login);
    },
    ackReplyReminder(owner, id) {
      const index = reminders.findIndex((item) => item.owner === owner && item.id === id && Number.isFinite(item.firedAt));
      if (index === -1) return false;
      reminders.splice(index, 1);
      return true;
    },
    reminders,
  };
}

// Kept in step with `USERS_COALESCE_MS` in src/cloud/hub.js by hand: the hub
// does not export it, and this is the test harness's own notion of "long enough
// that a coalesced roster pass has happened".
const USERS_COALESCE_MS = 250;
// Same hand-keeping for `PRESENCE_GRACE_MS`: how long a departure is held
// before anybody is told (see `world.away`).
const PRESENCE_GRACE_MS = 5000;
// Same hand-keeping for `CALL_CANCEL_GRACE_MS`: how long a caller's ring
// outlives the loss of its last call-capable socket, so a caller that is only
// reconnecting is not treated as one who gave up.
const CALL_CANCEL_GRACE_MS = 5000;

function harness({ store = fakeStore(), start = 5000, ...options } = {}) {
  let clock = start;
  const timers = [];
  // The operator-facing diagnostics, captured instead of printed: the
  // frame-budget line is what an operator has to identify a client by, so it
  // gets asserted like any other observable.
  const notes = [];
  const hub = createCloudHub({
    store,
    now: () => clock,
    note: (line) => notes.push(line),
    setTimer: (fn, ms) => {
      const handle = { fn, ms, at: clock + ms, cleared: false, ran: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) handle.cleared = true;
    },
    idFactory: (() => {
      let next = 0;
      return () => `conn-${++next}`;
    })(),
    ...options,
  });

  function open() {
    const events = [];
    const closes = [];
    const conn = hub.connect((payload) => events.push(payload), { close: (code) => closes.push(code) });
    return {
      conn,
      events,
      closes,
      send: (payload) => conn.receive(payload),
      last: (k) => [...events].reverse().find((event) => event.k === k),
      of: (k) => events.filter((event) => event.k === k),
      drop: () => { events.length = 0; },
    };
  }

  async function join(login) {
    const client = open();
    client.send({ k: 'auth', token: `token-${login}` });
    await tick();
    return client;
  }

  function runDueTimers() {
    // The clock is what a timer is measured against, so advancing it runs the
    // ones now due — in insertion order, once each, and never one that armed
    // itself during this pass (its due time is still in the future). Without
    // this the harness could advance time past a timer and leave it unrun, which
    // is a hole any test asserting on a delayed behaviour would fall into.
    for (const handle of timers) {
      if (handle.cleared || handle.ran || handle.at > clock) continue;
      handle.ran = true;
      handle.fn();
    }
  }

  return {
    hub,
    store,
    timers,
    notes,
    open,
    join,
    advance: (ms) => { clock += ms; runDueTimers(); return clock; },
    // Advances past the roster coalescing window (`USERS_COALESCE_MS` in hub.js)
    // and runs what it queued: what a test means when it asserts on the `users`
    // envelope that a change produces, 250 ms later in production.
    settle: () => { clock += USERS_COALESCE_MS; runDueTimers(); return clock; },
    // Advances past `PRESENCE_GRACE_MS` and runs what it queued: the point at
    // which a departure is finally announced to everybody.
    away: () => { clock += PRESENCE_GRACE_MS; runDueTimers(); return clock; },
    at: () => clock,
  };
}

// Every unread badge that nothing on screen could clear ends here: the queued
// frames go, the watermark jumps and the peer's own ✓ turns around.
test('mark-read empties the queue for one peer and tells both sides', async () => {
  const world = harness();
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm1', text: 'привет' } });
  await tick();

  const phone = await world.join('anna');
  world.store.queue.set('anna', [
    { from: 'boris', d: { t: 'msg', id: 'queued' }, at: 5000 },
    { from: 'roman', d: { t: 'msg', id: 'other' }, at: 5000 },
  ]);
  boris.drop();
  phone.drop();

  anna.send({ k: 'mark-read', peer: 'boris' });
  await tick();

  assert.deepEqual(world.store.queue.get('anna').map((item) => item.from), ['roman']);
  assert.deepEqual(phone.last('read-sync'), { k: 'read-sync', peer: 'boris', id: '', readTs: 7000 });
  assert.deepEqual(boris.last('frame'), { k: 'frame', from: 'anna', d: { t: 'read', id: 'm1', readTs: 7000 } });
  assert.equal(anna.last('read-sync'), undefined, 'the session that asked already knows');
});

// Readness is account-wide: `syncRead` clears the badge on every other session
// of the reader, and `state.reads`/`state.readAts` name no device — so «уже
// прочитано, а я его не видел» is answerable only by naming the session that
// moved the watermark. One operator line per advance, naming the client kind a
// connection already declares for other reasons: the browser's `webFeatures`,
// the phone's build, a terminal as neither.
test('a read watermark is logged once per advance, with the client that moved it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-read-note-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const annaUser = await store.register({ login: 'anna', password: 'test' });
  const borisUser = await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });

  const web = world.open();
  web.send({ k: 'auth', token: annaUser.token, webFeatures: true });
  await tick();
  web.send({ k: 'subscribe', peer: 'boris' });
  const boris = world.open();
  boris.send({ k: 'auth', token: borisUser.token });
  await tick();
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm1', text: 'привет', ts: 5 } });
  await until(() => boris.of('subscribed').length > 0 && store.history('anna', 'boris').length === 1);

  web.drop();
  web.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await until(() => world.notes.length > 0);
  assert.match(world.notes[0], /^Tailchat cloud: read login=anna peer=boris via=web readTs=5 at=\d+\n$/);

  // The same receipt again: the watermark cannot move, and one line per advance
  // is what keeps the one that did matter visible.
  web.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await tick();
  assert.equal(world.notes.length, 1);

  // The phone reports its build on `auth`; a terminal reports nothing.
  const phone = world.open();
  phone.send({ k: 'auth', token: annaUser.token, appVersion: 175 });
  await tick();
  phone.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm2', text: 'ещё', ts: 8 } });
  await until(() => store.history('anna', 'boris').length === 2);
  phone.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm2' } });
  await until(() => world.notes.length === 2);
  assert.match(world.notes[1], /via=android\/175 readTs=8 /);

  const cli = world.open();
  cli.send({ k: 'auth', token: annaUser.token });
  await tick();
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm3', text: 'и ещё', ts: 9 } });
  await until(() => store.history('anna', 'boris').length === 3);
  cli.send({ k: 'mark-read', peer: 'boris' });
  await until(() => world.notes.length === 3);
  assert.match(world.notes[2], /^Tailchat cloud: read login=anna peer=boris via=cli readTs=9 /);
});

// The same value the log line names rides the frames: the author sees which
// client read their message, the reader's other sessions hear it through
// `read-sync`, and the session that sent the receipt is told with `read-accepted`
// — so none of them has to guess «прочитано» without saying by what.
test('the receipt names the client that sent it, on every path it travels', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-read-via-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const annaUser = await store.register({ login: 'anna', password: 'test' });
  const borisUser = await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });

  const web = world.open();
  web.send({ k: 'auth', token: annaUser.token, webFeatures: true, caps: ['read-ack-v1'] });
  await tick();
  web.send({ k: 'subscribe', peer: 'boris' });
  const laptop = world.open();
  laptop.send({ k: 'auth', token: annaUser.token });
  await tick();
  const boris = world.open();
  boris.send({ k: 'auth', token: borisUser.token });
  await tick();
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm1', text: 'привет', ts: 5 } });
  await until(() => store.history('anna', 'boris').length === 1);

  web.drop(); laptop.drop(); boris.drop();
  web.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await until(() => boris.of('frame').some((event) => event.d.t === 'read'));
  assert.equal(boris.last('frame').d.via, 'web', 'the author learns which client read it');
  assert.equal(laptop.last('read-sync').via, 'web', 'the reader\'s other devices too');
  assert.equal(web.last('read-accepted').via, 'web', 'and the session that sent the receipt');
  assert.equal(store.readVia('anna', 'boris'), 'web');

  // The phone, by way of «отметить прочитанным»: same fact, same name.
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm2', text: 'ещё', ts: 8 } });
  await until(() => store.history('anna', 'boris').length === 2);
  const phone = world.open();
  phone.send({ k: 'auth', token: annaUser.token, appVersion: 175, caps: ['read-ack-v1'] });
  await tick();
  web.drop(); laptop.drop(); boris.drop();
  phone.send({ k: 'mark-read', peer: 'boris' });
  await until(() => boris.of('frame').some((event) => event.d.t === 'read' && event.d.id === 'm2'));
  assert.equal(boris.last('frame').d.via, 'android/175');
  assert.equal(laptop.last('read-sync').via, 'android/175');
  assert.equal(phone.last('read-accepted').via, 'android/175');
  assert.equal(store.readVia('anna', 'boris'), 'android/175');
});

test('mark-unread overlays one roster badge and mark-read clears it', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'mark-unread', peer: 'boris' });
  await tick();
  world.settle();

  assert.deepEqual(anna.last('mark-unread-accepted'), { k: 'mark-unread-accepted', peer: 'boris' });
  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').pending, 1);

  anna.send({ k: 'mark-read', peer: 'boris' });
  await tick();
  world.settle();
  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').pending, 0);
});

test('reply reminder fires live, pushes once, replays until its owner acknowledges it', async () => {
  const pushes = [];
  const world = harness({
    pushSender: { notify: async (login, payload) => { pushes.push({ login, payload }); } },
  });
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  const anna = await world.join('anna');
  boris.send({
    k: 'frame',
    to: 'anna',
    d: { t: 'msg', id: 'question-1', text: 'Ответишь?', ts: world.at() },
  });
  await until(() => world.store.committed.length === 1);

  anna.send({
    k: 'reply-reminder',
    peer: 'boris',
    messageId: 'question-1',
    dueAt: world.at() + 1000,
  });
  const accepted = anna.last('reply-reminder-set');
  assert.equal(accepted.reminder.peer, 'boris');
  assert.equal(accepted.reminder.messageId, 'question-1');

  world.advance(1000);
  await tick();
  assert.equal(anna.last('reply-reminder-fired').reminder.id, accepted.reminder.id);
  assert.deepEqual(
    pushes
      .filter(({ payload }) => payload.kind === 'reply-reminder')
      .map(({ login, payload }) => [login, payload.kind, payload.peer, payload.messageId]),
    [
      ['anna', 'reply-reminder', 'boris', 'question-1'],
    ],
  );

  const reconnected = await world.join('anna');
  assert.equal(reconnected.last('reply-reminder-fired').reminder.id, accepted.reminder.id);
  reconnected.send({ k: 'reply-reminder-ack', id: accepted.reminder.id });
  assert.deepEqual(reconnected.last('reply-reminder-acked'), {
    k: 'reply-reminder-acked',
    id: accepted.reminder.id,
  });

  const afterAck = await world.join('anna');
  assert.equal(afterAck.of('reply-reminder-fired').length, 0);
});

// The third push path (issue #28): the reminder that wakes the owner names the
// contact the way their account renamed them, exactly like a message push and a
// call offer do.
test('the reminder notification names the contact the way the owner renamed them (issue #28)', async () => {
  const pushes = [];
  const world = harness({
    pushSender: { notify: async (login, payload) => { pushes.push({ login, payload }); } },
  });
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  const anna = await world.join('anna');
  world.store.setAlias('anna', 'boris', 'Няша');
  boris.send({
    k: 'frame',
    to: 'anna',
    d: { t: 'msg', id: 'question-1', text: 'Ответишь?', ts: world.at() },
  });
  await until(() => world.store.committed.length === 1);

  anna.send({
    k: 'reply-reminder',
    peer: 'boris',
    messageId: 'question-1',
    dueAt: world.at() + 1000,
  });
  world.advance(1000);
  await tick();

  const reminder = pushes.find(({ payload }) => payload.kind === 'reply-reminder');
  assert.equal(reminder.login, 'anna', 'the owner of the reminder is the one woken');
  assert.equal(reminder.payload.body, 'Няша');
  assert.equal(reminder.payload.peer, 'boris');
});

test('a scheduled reminder marks the message on every session, and again on reconnect', async () => {
  const world = harness();
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  const phone = await world.join('anna');
  const laptop = await world.join('anna');
  phone.send({ k: 'subscribe', peer: 'boris' });
  boris.send({
    k: 'frame',
    to: 'anna',
    d: { t: 'msg', id: 'question-1', text: 'Ответишь?', ts: world.at() },
  });
  await until(() => world.store.committed.length === 1);

  phone.send({
    k: 'reply-reminder',
    peer: 'boris',
    messageId: 'question-1',
    dueAt: world.at() + 60_000,
  });
  await tick();

  assert.equal(phone.last('reply-reminder-set').reminder.messageId, 'question-1');
  assert.equal(
    laptop.last('reply-reminder-set').reminder.messageId,
    'question-1',
    "the same person's other session draws the mark on the same message",
  );

  // A device that was not connected when the reminder was set is told what is
  // still pending: the mark belongs to the message, not to the connection.
  const later = await world.join('anna');
  assert.equal(later.last('reply-reminder-set').reminder.messageId, 'question-1');
  assert.equal(later.of('reply-reminder-fired').length, 0, 'nothing has come due yet');
});

// `bots/client.mjs` says what it is in its own `hello` (`v: 'bot'`), and the
// roster carries the flag: a roster line, and a count of who is online, must
// not present a daemon as a person.
test('an account whose own client announces itself as a bot is marked in the roster', async () => {
  const world = harness({ store: fakeStore(['anna', 'boris', 'roman', 'reminder']) });
  const anna = await world.join('anna');
  const bot = await world.join('reminder');
  bot.send({ k: 'subscribe', peer: 'anna' });
  bot.send({
    k: 'frame',
    to: 'anna',
    d: { t: 'hello', name: 'reminder', connId: 'bot-1', v: 'bot' },
  });
  await tick();
  world.settle();

  assert.equal(world.store.isBot('reminder'), true);
  assert.equal(
    anna.last('users').users.find((user) => user.login === 'reminder').bot,
    true,
    'every roster, not only the bot\'s own',
  );

  // The greeting is relayed in the other direction too, and it says nothing
  // about the side receiving it.
  const human = await world.join('boris');
  human.send({ k: 'subscribe', peer: 'anna' });
  human.send({
    k: 'frame',
    to: 'anna',
    d: { t: 'hello', name: 'Boris', connId: 'phone-1', v: 'android' },
  });
  await tick();
  assert.equal(world.store.isBot('boris'), false);
});

// One phone running minutes fast used to plant its messages permanently at the
// bottom (or top) of everybody's transcript, since every client sorts by `ts`.
test('a message whose clock is far from the server is restamped, a normal one is not', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'skewed', ts: 5000 + 10 * 60_000 } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'fine', ts: 4000 } });
  await tick();

  assert.deepEqual(
    boris.of('frame').map((event) => [event.d.id, event.d.ts]),
    [['skewed', 5000], ['fine', 4000]],
  );
});

test('any action before auth is refused and a bad token closes the connection with 4401', async () => {
  const world = harness();
  const client = world.open();

  client.send({ k: 'who' });
  client.send({ k: 'subscribe', peer: 'anna' });
  assert.deepEqual(client.of('error').map((event) => event.code), ['auth_required', 'auth_required']);
  assert.match(client.of('error')[0].message, /авториз/i);

  client.send({ k: 'auth', token: 'token-nobody' });
  await tick();
  assert.equal(client.last('error').code, 'auth_failed');
  assert.deepEqual(client.closes, [4401]);

  client.drop();
  client.send({ k: 'auth', token: 'token-anna' });
  await tick();
  assert.deepEqual(client.events, [], 'a closed connection is never written to again');
  assert.equal(client.conn.login(), null);
});

test('the auth timeout closes the connection and is cleared once auth lands', async () => {
  const world = harness();
  const late = world.open();
  assert.equal(world.timers[0].ms, 5000);

  world.timers[0].fn();
  assert.equal(late.last('error').code, 'auth_failed');
  assert.match(late.last('error').message, /вовремя/);
  assert.deepEqual(late.closes, [4401]);

  const anna = await world.join('anna');
  assert.equal(world.timers[1].cleared, true);
  assert.equal(anna.last('ready').self.login, 'anna');
  assert.equal(anna.conn.login(), 'anna');
  assert.equal(typeof anna.conn.id, 'string');
});

test('ready carries the account and the roster without the account itself', async () => {
  const world = harness();
  world.store.enqueue('anna', { from: 'boris', d: { t: 'msg' }, at: 1 });
  const anna = await world.join('anna');
  const ready = { ...anna.last('ready') };
  delete ready.caps;

  assert.deepEqual(ready, {
    k: 'ready',
    // The same three fields `/login` and `/profile` answer with: a client that
    // replaces its `self` from whichever envelope spoke last must not lose
    // `extraPasswordEnabled` — that is what the profile dialog reads to decide
    // whether the additional-password switch starts on.
    self: { login: 'anna', name: 'Anna', extraPasswordEnabled: false },
    users: [
      { login: 'boris', name: 'Boris', online: false, state: 'away', lastSeen: 1001, pending: 1, callable: false },
      { login: 'roman', name: 'Roman', online: false, state: 'away', lastSeen: 1002, pending: 0, callable: false },
    ],
  });
  assert.deepEqual(world.store.touched, [['anna', 5000]]);

  anna.drop();
  anna.send({ k: 'who' });
  assert.equal(anna.last('users').users.length, 2);
});

test('a frame reaches only the connections subscribed to the sender', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  const roman = await world.join('roman');

  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  roman.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  boris.drop();
  roman.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'привет', ts: 42 } });
  await tick();
  assert.deepEqual(boris.events, [{ k: 'frame', from: 'anna', d: { t: 'msg', id: 'm1', text: 'привет', ts: 42 } }]);
  assert.equal(boris.events[0].self, undefined, 'ordinary conversation frames carry no self flag');
  assert.deepEqual(roman.events, [], 'a third party subscribed to the sender is not a recipient');
  assert.deepEqual(anna.events, [{ k: 'message-accepted', peer: 'boris', id: 'm1', ts: 42, seq: 1 }],
    'the sender gets acceptance but no peer echo');
  assert.deepEqual([...world.store.queue.values()].flat(), [], 'a delivered frame is not queued');
  assert.deepEqual(world.store.recorded, [{
    a: 'anna',
    b: 'boris',
    message: { id: 'm1', from: 'anna', text: 'привет', ts: 42, kind: 'human' },
  }]);
});

test('sendServiceMessage uses the same live and offline store-and-forward path', async () => {
  const world = harness({ store: fakeStore(['anna', 'boris', 'tailchat']), start: 9000 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'tailchat' });
  anna.drop();

  assert.equal(world.hub.sendServiceMessage('anna', {
    text: 'Tailchat 1.11', id: 'release-1.11', ts: 1234,
  }), true);
  assert.deepEqual(anna.events, [{
    k: 'frame',
    from: 'tailchat',
    d: { t: 'msg', id: 'release-1.11', text: 'Tailchat 1.11', ts: 1234 },
  }]);

  assert.equal(world.hub.sendServiceMessage('boris', { text: 'Tailchat 1.11' }), true);
  assert.equal(world.store.queue.get('boris').length, 1);
  assert.equal(world.store.queue.get('boris')[0].from, 'tailchat');
  assert.equal(world.store.queue.get('boris')[0].d.text, 'Tailchat 1.11');
  assert.deepEqual(
    world.store.recorded.map(({ a, b, message }) => [a, b, message.from, message.text]),
    [
      ['tailchat', 'anna', 'tailchat', 'Tailchat 1.11'],
      ['tailchat', 'boris', 'tailchat', 'Tailchat 1.11'],
    ],
  );
  assert.equal(world.hub.sendServiceMessage('tailchat', { text: 'self' }), false);
  assert.equal(world.hub.sendServiceMessage('anna', { text: '' }), false);
});

test('a msg frame carrying replyTo is delivered live and recorded into history with the snapshot attached', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');

  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  boris.drop();

  const replyTo = { id: 'm0', from: 'boris', text: 'привет' };
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'и тебе привет', ts: 43, replyTo } });
  await tick();

  assert.deepEqual(boris.events, [{
    k: 'frame', from: 'anna', d: { t: 'msg', id: 'm1', text: 'и тебе привет', ts: 43, replyTo },
  }]);
  assert.deepEqual(world.store.recorded, [{
    a: 'anna',
    b: 'boris',
    message: {
      id: 'm1', from: 'anna', text: 'и тебе привет', ts: 43, kind: 'human', replyTo,
    },
  }]);
});

test('a repeated message id is accepted again without duplicate delivery, history, or AI work', async () => {
  const aiBridge = {
    calls: [],
    async maybeRespond(args) {
      this.calls.push(args);
      return { from: 'roman', to: 'anna', text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const roman = await world.join('roman');
  anna.send({ k: 'subscribe', peer: 'roman' });
  roman.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  roman.drop();

  const frame = { k: 'frame', to: 'roman', d: { t: 'msg', id: 'stable-id', text: 'tailik, hi', ts: 10 } };
  anna.send(structuredClone(frame));
  await tick();
  await tick();
  anna.send(structuredClone(frame));
  await tick();
  await tick();

  assert.equal(aiBridge.calls.length, 1);
  assert.equal(world.store.recorded.filter((row) => row.message.id === 'stable-id').length, 1);
  assert.equal(roman.of('frame').filter((event) => event.d.id === 'stable-id').length, 1);
  assert.equal(anna.of('message-accepted').filter((event) => event.id === 'stable-id').length, 2);
});

test('a message reaching the hub is offered to the configured AI bridge, and its reply is delivered as an ai frame', async () => {
  const aiBridge = {
    calls: [],
    async maybeRespond(args) {
      this.calls.push(args);
      return { from: 'roman', to: 'anna', text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const roman = await world.join('roman');

  anna.send({ k: 'subscribe', peer: 'roman' });
  roman.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  roman.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm1', text: 'tailik, hi', ts: 10 } });
  await tick();
  await tick();

  assert.equal(aiBridge.calls.length, 1);
  assert.equal(aiBridge.calls[0].from, 'anna');
  assert.equal(aiBridge.calls[0].to, 'roman');
  assert.equal(aiBridge.calls[0].text, 'tailik, hi');
  assert.equal(typeof aiBridge.calls[0].isAiCapable, 'function');
  assert.ok(anna.of('frame').some((e) => e.d.t === 'ai' && e.d.text === 'Привет!'), 'the asker sees the reply');
  assert.ok(roman.of('frame').some((e) => e.d.t === 'ai' && e.d.text === 'Привет!'), 'the owner side sees it too');
  assert.deepEqual(
    world.store.recorded.filter((r) => r.message.kind === 'ai').map((r) => r.message.text),
    ['Привет!'],
  );
});

test('a connected terminal\'s caps.ai claim reaches the AI bridge as isAiCapable, so a second web device does not double-answer', async () => {
  const calls = [];
  const aiBridge = {
    async maybeRespond(args) {
      calls.push(args);
      // Exercise the real deference contract, not a stub that always answers.
      if (args.isAiCapable('roman')) return null;
      return { from: 'roman', to: 'anna', text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  // Two devices of the same account: a "terminal" that announces AI
  // capability via caps, and a "web" tab that sends the actual message —
  // reproducing a cloud-web message self-syncing to an AI-enabled terminal
  // that answers it unconditionally via sync-outgoing.
  const romanTerminal = await world.join('roman');
  const romanWeb = await world.join('roman');

  anna.send({ k: 'subscribe', peer: 'roman' });
  romanTerminal.send({ k: 'subscribe', peer: 'anna' });
  romanWeb.send({ k: 'subscribe', peer: 'anna' });
  romanTerminal.send({ k: 'frame', to: 'anna', d: { t: 'caps', ai: true } });
  anna.drop();
  romanTerminal.drop();
  romanWeb.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm4', text: 'tailik, hi', ts: 40 } });
  await tick();
  await tick();

  assert.equal(calls.length, 1, 'the bridge is still consulted');
  assert.deepEqual(romanWeb.of('frame').map((e) => e.d.t), ['msg'], 'no ai frame — the terminal owns this answer');
  assert.deepEqual(romanTerminal.of('frame').map((e) => e.d.t), ['msg']);
  assert.deepEqual(
    world.store.recorded.filter((r) => r.message.kind === 'ai'),
    [],
  );
});

test('an AI-capable terminal only owns the conversation it is watching, so tailik still answers the owner\'s other contacts', async () => {
  const aiBridge = {
    async maybeRespond(args) {
      const other = args.from === 'roman' ? args.to : args.from;
      if (args.isAiCapable('roman')) return null;
      return { from: 'roman', to: other, text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  const romanTerminal = await world.join('roman');

  anna.send({ k: 'subscribe', peer: 'roman' });
  boris.send({ k: 'subscribe', peer: 'roman' });
  // The terminal is looking at Anna: those are the only frames it will ever
  // be shown, so it can only answer for that thread.
  romanTerminal.send({ k: 'subscribe', peer: 'anna' });
  romanTerminal.send({ k: 'frame', to: 'anna', d: { t: 'caps', ai: true } });
  anna.drop();
  boris.drop();
  romanTerminal.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm8', text: 'tailik, hi', ts: 80 } });
  boris.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm9', text: 'tailik, hi', ts: 81 } });
  await tick();
  await tick();

  assert.deepEqual(anna.of('frame').map((e) => e.d.t), [], 'the terminal owns Anna\'s thread');
  assert.deepEqual(boris.of('frame').map((e) => e.d.t), ['ai'], 'nobody was going to answer Boris but the bridge');
});

test('once the AI-capable terminal disconnects, the bridge answers again', async () => {
  const aiBridge = {
    async maybeRespond(args) {
      if (args.isAiCapable('roman')) return null;
      return { from: 'roman', to: 'anna', text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const romanTerminal = await world.join('roman');

  romanTerminal.send({ k: 'subscribe', peer: 'anna' });
  anna.send({ k: 'subscribe', peer: 'roman' });
  romanTerminal.send({ k: 'frame', to: 'anna', d: { t: 'caps', ai: true } });
  romanTerminal.conn.close();
  anna.drop();

  // Long enough that the terminal is not merely reconnecting.
  world.advance(120_000);
  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm5', text: 'tailik, hi', ts: 50 } });
  await tick();

  assert.ok(anna.of('frame').some((e) => e.d.t === 'ai'), 'the bridge is the only capable client left');
});

// The other half of the same rule. A terminal's socket blipping is not the
// terminal going away, and treating it as such produced two answers to one
// question: the bridge replied into the gap, then the terminal reconnected,
// drained the same message from the queue and replied as well.
test('a terminal that drops and comes straight back keeps the answering to itself', async () => {
  const aiBridge = {
    async maybeRespond(args) {
      if (args.isAiCapable('roman')) return null;
      return { from: 'roman', to: 'anna', text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const romanTerminal = await world.join('roman');

  romanTerminal.send({ k: 'subscribe', peer: 'anna' });
  anna.send({ k: 'subscribe', peer: 'roman' });
  romanTerminal.send({ k: 'frame', to: 'anna', d: { t: 'caps', ai: true } });
  romanTerminal.conn.close();
  anna.drop();

  // A few seconds later — a reconnect, not a departure.
  world.advance(5_000);
  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm6', text: 'tailik, hi', ts: 60 } });
  await tick();

  assert.ok(
    !anna.of('frame').some((e) => e.d.t === 'ai'),
    'the bridge must leave this to the terminal that is on its way back',
  );
});

test('a terminal that says it no longer owns the answering is believed at once', async () => {
  const aiBridge = {
    async maybeRespond(args) {
      if (args.isAiCapable('roman')) return null;
      return { from: 'roman', to: 'anna', text: 'Привет!' };
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const romanTerminal = await world.join('roman');

  romanTerminal.send({ k: 'subscribe', peer: 'anna' });
  anna.send({ k: 'subscribe', peer: 'roman' });
  romanTerminal.send({ k: 'frame', to: 'anna', d: { t: 'caps', ai: true } });
  // Switching the AI off is a statement, not a disconnection: no grace applies.
  romanTerminal.send({ k: 'frame', to: 'anna', d: { t: 'caps', ai: false } });
  anna.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm7', text: 'tailik, hi', ts: 70 } });
  await tick();

  assert.ok(anna.of('frame').some((e) => e.d.t === 'ai'), 'the bridge takes over immediately');
});

test('an AI bridge that declines to answer leaves the conversation with only the human frame', async () => {
  const aiBridge = { async maybeRespond() { return null; } };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  const roman = await world.join('roman');

  anna.send({ k: 'subscribe', peer: 'roman' });
  roman.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  roman.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm2', text: 'just chatting', ts: 20 } });
  await tick();

  assert.deepEqual(roman.of('frame').map((e) => e.d.t), ['msg']);
});

test('with no AI bridge configured, an addressed message is relayed as plain human text and nothing else', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const roman = await world.join('roman');

  anna.send({ k: 'subscribe', peer: 'roman' });
  roman.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  roman.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm3', text: 'tailik, hi', ts: 30 } });
  await tick();

  assert.deepEqual(roman.of('frame').map((e) => e.d.t), ['msg']);
});

test('both devices of one account receive the conversation they subscribed to', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const phone = await world.join('boris');
  const laptop = await world.join('boris');

  anna.send({ k: 'subscribe', peer: 'boris' });
  phone.send({ k: 'subscribe', peer: 'anna' });
  laptop.send({ k: 'subscribe', peer: 'anna' });
  phone.drop();
  laptop.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'typing', state: 'start' } });
  assert.deepEqual(phone.events, [{ k: 'frame', from: 'anna', d: { t: 'typing', state: 'start' } }]);
  assert.deepEqual(laptop.events, phone.events);
});

test('only msg and ai self-sync or create unread notices across active sessions', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const laptop = await world.join('anna');
  const boris = await world.join('boris');

  phone.send({ k: 'subscribe', peer: 'boris' });
  laptop.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'roman' });
  phone.drop();
  laptop.drop();
  boris.drop();

  const types = [
    'msg', 'ai', 'typing', 'read', 'ack', 'ping', 'pong', 'hello',
    'focus', 'wake', 'logo', 'holiday', 'caps', 'devices', 'update',
  ];
  for (const t of types) {
    phone.send({ k: 'frame', to: 'boris', d: { t, id: t, text: `text-${t}` } });
  }
  await tick();

  assert.deepEqual(
    laptop.of('frame').map((event) => [event.d.t, event.from, event.self]),
    [['msg', 'boris', true], ['ai', 'boris', true]],
  );
  assert.deepEqual(
    boris.of('unread').map((event) => [event.text, event.from]),
    [['text-msg', 'anna'], ['text-ai', 'anna']],
  );
  assert.deepEqual(phone.of('frame'), [], 'the originating session gets no echo');
});

test('only msg, ai, ack and read are queued for a recipient nobody can reach', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });

  for (const t of ['msg', 'ai', 'ack', 'read', 'typing', 'focus', 'ping', 'pong', 'wake', 'logo', 'holiday', 'caps', 'devices', 'update', 'hello', 'file-offer', 'file-chunk', 'file-done', 'file-deny']) {
    anna.send({ k: 'frame', to: 'boris', d: { t, id: t } });
  }
  await tick();

  assert.deepEqual(new Set(world.store.queue.get('boris').map((item) => item.d.t)), new Set(['msg', 'ai', 'ack', 'read']));
  assert.deepEqual(
    world.store.queue.get('boris').find((item) => item.d.t === 'msg'),
    { from: 'anna', d: { t: 'msg', id: 'msg', ts: 5000 }, at: 5000 },
  );
  assert.deepEqual(world.store.recorded.map((entry) => entry.message.kind), ['human', 'ai']);
});

test('a frame stays queued while the recipient is connected but subscribed elsewhere', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'roman' });
  boris.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'позже' } });
  await tick();
  assert.deepEqual(boris.events, [{ k: 'unread', from: 'anna', text: 'позже', ts: 5000, count: 1 }]);
  assert.equal(world.store.queue.get('boris').length, 1);
});

test('subscribe hands over the queue as frames and then reports the count', async () => {
  const world = harness();
  world.store.enqueue('boris', { from: 'anna', d: { t: 'msg', id: 'm1' }, at: 1 });
  world.store.enqueue('boris', { from: 'anna', d: { t: 'ack', id: 'm0' }, at: 2 });
  world.store.enqueue('boris', { from: 'roman', d: { t: 'msg', id: 'r1' }, at: 3 });

  const boris = await world.join('boris');
  boris.drop();
  boris.send({ k: 'subscribe', peer: 'ANNA' });

  assert.deepEqual(boris.events, [
    { k: 'frame', from: 'anna', d: { t: 'msg', id: 'm1' } },
    { k: 'frame', from: 'anna', d: { t: 'ack', id: 'm0' } },
    // Only the msg counts toward the badge; the ack drained alongside it does not.
    { k: 'subscribed', peer: 'anna', online: false, state: 'away', pending: 1, callable: false },
  ]);
  assert.deepEqual(world.store.queue.get('boris').map((item) => item.from), ['roman']);

  boris.drop();
  boris.send({ k: 'subscribe', peer: 'anna' });
  assert.deepEqual(boris.events, [{ k: 'subscribed', peer: 'anna', online: false, state: 'away', pending: 0, callable: false }]);
});

test('a frame sent in the same tick as subscribe is already routed as subscribed', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.drop();

  // The client transport sends `subscribe` and its `hello` back to back without
  // waiting for `subscribed`; only `auth` may be answered on a later tick.
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'hello', name: 'Анна', connId: 'c1' } });

  assert.deepEqual(boris.events, [{ k: 'frame', from: 'anna', d: { t: 'hello', name: 'Анна', connId: 'c1' } }]);
  assert.equal(anna.last('subscribed').peer, 'boris');
  assert.deepEqual(anna.of('error'), []);
});

test('a second subscribe replaces the first one', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');

  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.send({ k: 'subscribe', peer: 'roman' });
  boris.drop();

  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1' } });
  await tick();
  assert.deepEqual(boris.events, [], 'an empty message creates no unread notice');
  assert.equal(world.store.queue.get('boris').length, 1);

  anna.drop();
  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm2' } });
  assert.equal(anna.last('error').code, 'not_subscribed');
  assert.equal(world.store.queue.get('roman'), undefined);
});

test('a blocked relationship refuses relay in both directions but leaves subscribe alone', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');

  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  world.store.blockUser('anna', 'boris');

  // Anna blocked Boris: her own outgoing frame is refused too, not only his.
  anna.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'hi' } });
  assert.equal(anna.last('error').code, 'blocked');
  assert.equal((world.store.queue.get('boris') ?? []).length, 0);

  // Boris -> Anna is refused the same way, from the other side of the block.
  boris.drop();
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm2', text: 'hey' } });
  assert.equal(boris.last('error').code, 'blocked');
  assert.equal((world.store.queue.get('anna') ?? []).length, 0);

  // Opening the conversation itself (history/subscribe) is not blocked —
  // only new live traffic is.
  boris.drop();
  boris.send({ k: 'subscribe', peer: 'anna' });
  assert.deepEqual(boris.of('error'), []);

  world.store.unblockUser('anna', 'boris');
  anna.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm3', text: 'unblocked' } });
  await tick();
  assert.deepEqual(anna.of('error'), []);
  // Boris stayed subscribed to anna throughout, so the unblocked message is
  // delivered live rather than queued.
  assert.deepEqual(boris.of('frame').map((event) => event.d.text), ['unblocked']);
});

test('the roster marks only the blocker\'s own side of a block', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  world.store.blockUser('anna', 'boris');

  anna.drop();
  boris.drop();
  world.hub.broadcastUsers();
  world.settle();

  const annaRoster = anna.last('users').users;
  const borisRoster = boris.last('users').users;
  assert.equal(annaRoster.find((u) => u.login === 'boris').blocked, true);
  // Boris never blocked anna, and is never told anna blocked him.
  assert.equal(borisRoster.find((u) => u.login === 'anna').blocked, undefined);
});

test('a deleted contact refuses relay and subscribe on the deleting side only', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');

  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  await world.store.removeContact('anna', 'boris');

  // Boris writing to the account that deleted him: refused, and answered
  // exactly as a missing contact would be — never as a deletion.
  boris.drop();
  boris.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm1', text: 'hi' } });
  assert.equal(boris.last('error').code, 'peer_not_found');
  assert.equal((world.store.queue.get('anna') ?? []).length, 0);

  // Anna no longer has the contact, so her own frame has nowhere to go either.
  anna.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm2', text: 'hey' } });
  assert.equal(anna.last('error').code, 'peer_not_found');

  // The conversation is closed for the account that deleted it and still open
  // for the other side, whose roster and history were never touched.
  anna.drop();
  anna.send({ k: 'subscribe', peer: 'boris' });
  assert.equal(anna.last('error').code, 'peer_not_found');
  boris.drop();
  boris.send({ k: 'subscribe', peer: 'anna' });
  assert.deepEqual(boris.of('error'), []);
});

test('the roster drops a deleted contact for its owner alone, and its queued frames with it', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  world.store.enqueue('anna', { from: 'boris', d: { t: 'msg', id: 'q1', text: 'queued' }, at: 1 });

  await world.store.removeContact('anna', 'boris');
  assert.equal((world.store.queue.get('anna') ?? []).length, 0);

  anna.drop();
  boris.drop();
  world.hub.broadcastUsers();
  world.settle();

  assert.equal(anna.last('users').users.some((u) => u.login === 'boris'), false);
  // The other side keeps the contact: deleting is «у себя», nobody else's
  // list is rewritten for it.
  assert.equal(boris.last('users').users.some((u) => u.login === 'anna'), true);
});

test('closing a conversation unsubscribes, so a later message from that peer is queued as unread instead of silently delivered as if already read', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  anna.send({ k: 'subscribe', peer: 'boris' });

  // Boris opens the conversation with Anna, then closes it — the client
  // sends an empty-peer subscribe on close (`CloudSocket.unsubscribe`).
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.send({ k: 'subscribe', peer: '' });
  boris.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'still here?' } });
  await tick();

  // Not delivered live — the whole point of unsubscribing — and genuinely
  // queued (this is the unread bookkeeping), not dropped.
  assert.deepEqual(boris.of('frame'), []);
  assert.equal(world.store.queue.get('boris').length, 1);
  assert.equal(world.store.queue.get('boris')[0].d.text, 'still here?');
  // The queued-unread push (`k: 'unread'`) is what a native client turns
  // into the roster badge; before the fix this never fired because
  // `deliverFrame` believed the connection was still watching Anna live.
  assert.equal(boris.last('unread').from, 'anna');
  assert.equal(boris.last('unread').count, 1);
});

test('subscribe refuses an unknown peer; an empty peer unsubscribes instead of erroring', async () => {
  const world = harness();
  const anna = await world.join('anna');

  anna.send({ k: 'subscribe', peer: 'ghost' });
  assert.equal(anna.last('error').code, 'peer_not_found');

  // No peer at all — and an explicit empty string — are the unsubscribe
  // signal (see `hub.js`'s `receive`), not a malformed subscribe: nothing
  // was subscribed yet, so both are harmless no-ops, but neither is an
  // error the way an actually-unknown peer is.
  anna.send({ k: 'subscribe' });
  anna.send({ k: 'subscribe', peer: '' });
  assert.deepEqual(anna.of('error').map((event) => event.code), ['peer_not_found']);

  anna.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg' } });
  assert.equal(anna.last('error').code, 'not_subscribed');

  anna.drop();
  anna.send({ k: 'nonsense' });
  anna.send({ k: 'auth', token: 'token-anna' });
  assert.deepEqual(anna.of('error').map((event) => event.code), ['unknown_action', 'unknown_action']);
});

test('subscribing to yourself opens Saved Messages, delivered once per other device', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const laptop = await world.join('anna');

  phone.send({ k: 'subscribe', peer: 'anna' });
  laptop.send({ k: 'subscribe', peer: 'anna' });
  assert.equal(phone.last('subscribed').peer, 'anna');
  phone.drop();
  laptop.drop();

  phone.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'note1', text: 'buy milk' } });
  await tick();

  assert.deepEqual(laptop.of('frame'), [{
    k: 'frame',
    from: 'anna',
    d: { t: 'msg', id: 'note1', text: 'buy milk', ts: 5000 },
    self: true,
  }]);
  assert.deepEqual(phone.of('frame'), [], 'the sending device gets no echo of its own note');
  assert.equal(world.store.recorded.length, 1);
});

test('a Saved note reaches an unsubscribed second session before a read can discard its queue copy', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const laptop = await world.join('anna');

  phone.send({ k: 'subscribe', peer: 'anna' });
  laptop.drop();
  phone.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'queued-note', text: 'buy milk' } });
  await tick();
  assert.deepEqual(laptop.of('frame'), [{
    k: 'frame',
    from: 'anna',
    d: { t: 'msg', id: 'queued-note', text: 'buy milk', ts: 5000 },
    self: true,
  }]);
  assert.deepEqual(
    (world.store.queue.get('anna') ?? []).filter((item) => item.d.t === 'msg'),
    [],
    'a live second session no longer relies on the one-shot Saved queue',
  );

  phone.send({ k: 'frame', to: 'anna', d: { t: 'read', id: 'queued-note' } });
  laptop.send({ k: 'subscribe', peer: 'anna' });
  assert.equal(laptop.of('frame').filter((event) => event.d.t === 'msg').length, 1, 'subscribe does not need to replay or lose the note');
});

test('a malformed frame body is dropped without an error or a queue entry', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  anna.send({ k: 'frame', to: 'boris' });
  anna.send({ k: 'frame', to: 'boris', d: 'msg' });
  anna.send({ k: 'frame', to: 'boris', d: { text: 'нет типа' } });
  anna.send('nonsense');
  assert.deepEqual(anna.events, []);
  assert.equal(world.store.queue.get('boris'), undefined);
});

test('a frame at the protocol limit is routed and one character more is refused', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  const base = { t: 'msg', id: 'm', text: '', ts: 1 };
  const legal = { ...base, text: 'x'.repeat(CLOUD_FRAME_MAX_CHARS - JSON.stringify(base).length) };
  assert.equal(JSON.stringify(legal).length, CLOUD_FRAME_MAX_CHARS);
  anna.send({ k: 'frame', to: 'boris', d: legal });
  await tick();
  assert.equal(world.store.recorded.length, 1);
  assert.equal(world.store.queue.get('boris').length, 1);

  anna.send({ k: 'frame', to: 'boris', d: { ...legal, text: `${legal.text}x` } });
  assert.equal(anna.last('error').code, 'frame_too_large');
  assert.match(anna.last('error').message, /больш/i);
  assert.equal(world.store.recorded.length, 1, 'a refused frame never reaches history');
  assert.equal(world.store.queue.get('boris').length, 1, 'a refused frame never reaches the queue');
  assert.deepEqual(anna.closes, [], 'a legal websocket stays usable after refusing one frame');
});

test('presence and the roster are announced on the first connection and the last disconnect', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  const phone = await world.join('boris');
  // The roster pass that announces boris is coalesced with anna's own, exactly
  // as it would be a quarter of a second later in production.
  world.settle();
  assert.deepEqual(anna.of('presence'), [{ k: 'presence', peer: 'boris', online: true, state: 'active' }]);
  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').online, true);
  // The roster reaches the arriving connection from its own `ready`. It may
  // still receive the one coalesced pass that was already pending when it
  // joined — that pass carries somebody else's change, and a client that joins
  // inside the window must not be the one connection excluded from it. What
  // must never happen is one pass per event; the read-receipt storm test below
  // pins that.
  assert.equal(phone.of('users').length, 1, 'at most the one pending pass, never a pass per event');
  assert.equal(world.hub.isOnline('boris'), true);
  assert.deepEqual([...world.hub.onlineLogins()], ['anna', 'boris']);

  anna.drop();
  const laptop = await world.join('boris');
  assert.deepEqual(anna.events, [], 'a second device of the same account changes nothing for others');

  world.advance(1000);
  phone.conn.close();
  assert.deepEqual(anna.events, []);
  assert.equal(world.hub.isOnline('boris'), true);

  world.advance(1000);
  // The moment the last device left, whatever the clock has done to get here:
  // `teardown` records the disconnect time and the roster carries it.
  const leftAt = world.at();
  laptop.conn.close();
  // Held, not announced: a phone that redials a second later was never gone.
  assert.deepEqual(anna.of('presence'), []);
  assert.equal(world.hub.isOnline('boris'), true, 'a departure inside the grace is not one yet');

  world.away();
  assert.deepEqual(anna.of('presence'), [{ k: 'presence', peer: 'boris', online: false, state: 'away' }]);
  const listed = anna.last('users').users.find((user) => user.login === 'boris');
  assert.deepEqual([listed.online, listed.lastSeen], [false, leftAt]);
  assert.equal(world.hub.isOnline('boris'), false);
});

test('a socket that comes back inside the grace is never reported as gone', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  const boris = await world.join('boris');
  anna.drop();
  world.settle();

  // The blip: the phone locks, or hops Wi-Fi→LTE and back. The APK redials a
  // second later (`SyncEngine.RETRY_MS`), the browser in 250 ms
  // (`RECONNECT_MIN_MS`) — and neither the `presence` frame nor the roster has
  // any business calling that an absence. A momentary transport drop must not
  // flicker the presence dot or conversation status.
  boris.conn.close();
  world.advance(1000);
  const back = await world.join('boris');

  world.away();
  assert.deepEqual(
    anna.of('presence').filter((event) => event.online === false), [],
    'a one-second blip is announced to nobody',
  );
  assert.equal(world.hub.isOnline('boris'), true);
  // The roster every other client rebuilds says the same thing, and so does the
  // subscription the returning socket itself reopens.
  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').online, true);
  back.send({ k: 'subscribe', peer: 'anna' });
  assert.equal(back.last('subscribed').online, true);
});

test('presence is not sent to connections subscribed to somebody else', async () => {
  const world = harness();
  const roman = await world.join('roman');
  roman.send({ k: 'subscribe', peer: 'anna' });
  roman.drop();

  const boris = await world.join('boris');
  world.settle();
  assert.deepEqual(roman.of('presence'), []);
  assert.equal(roman.of('users').length, 1);

  boris.conn.close();
  assert.deepEqual(roman.of('presence'), []);
});

test('a wake socket is served like a session but counts as nobody (issue #29)', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  // The phone FCM woke to fetch one message and post one notification. It is a
  // real socket that does real work, and it says so: `lurk-v1` means "deliver
  // to me, but I am not somebody being here".
  const wake = world.open();
  wake.send({ k: 'auth', token: 'token-boris', caps: ['lurk-v1', 'call-v1'] });
  await tick();
  world.settle();

  assert.deepEqual(anna.of('presence'), [], 'a wake socket announces no arrival');
  assert.equal(world.hub.isOnline('boris'), false, 'a fetch is not the person being online');
  assert.deepEqual([...world.hub.onlineLogins()], ['anna']);

  // Served like any other connection: the handshake answered, the hub still
  // talks to it. That is the point of the capability — everything is delivered,
  // nothing is *counted*.
  assert.ok(wake.last('ready'), 'the wake socket authenticates like a session');
  wake.send({ k: 'who' });
  assert.ok(wake.last('users'), 'and is answered like one');

  // What this account's own roster shows: the peer offline and not callable.
  anna.send({ k: 'who' });
  const listed = anna.last('users').users.find((user) => user.login === 'boris');
  assert.deepEqual([listed.online, listed.callable], [false, false]);

  // The departure it never announced is never announced either — a wake socket
  // that goes away takes nothing back and arms no hold.
  wake.conn.close();
  world.away();
  assert.deepEqual(anna.of('presence'), []);
  assert.equal(world.hub.isOnline('boris'), false);
});

test('a wake socket does not cancel a held departure; a present one does', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  const boris = await world.join('boris');
  anna.drop();
  world.settle();

  // The screen goes away — a departure nobody is told about yet, on purpose.
  boris.conn.close();

  const wake = world.open();
  wake.send({ k: 'auth', token: 'token-boris', caps: ['lurk-v1'] });
  await tick();
  assert.equal(world.hub.isOnline('boris'), true, 'the hold still owns the verdict');

  world.away();
  assert.deepEqual(
    anna.of('presence'),
    [{ k: 'presence', peer: 'boris', online: false, state: 'away' }],
    'the hold expires on schedule: a fetch is not the person coming back',
  );
  assert.equal(world.hub.isOnline('boris'), false);
});

test('the person arriving after their wake socket is still announced', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  const wake = world.open();
  wake.send({ k: 'auth', token: 'token-boris', caps: ['lurk-v1'] });
  await tick();
  assert.deepEqual(anna.of('presence'), [], 'the fetch alone is invisible');

  // The owner opens the app: the wake socket's account finally has somebody in
  // it, and only now is the arrival announced.
  const phone = world.open();
  phone.send({ k: 'auth', token: 'token-boris', caps: ['call-v1'] });
  await tick();
  world.settle();

  assert.deepEqual(anna.of('presence'), [{ k: 'presence', peer: 'boris', online: true, state: 'active' }]);
  assert.equal(world.hub.isOnline('boris'), true);
  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').online, true);

  phone.send({ k: 'subscribe', peer: 'anna' });
  assert.equal(phone.last('subscribed').online, true);
});

test('a wake socket does not move lastSeen either, and a real session still does (issue #29)', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  world.store.touched.length = 0;
  anna.drop();

  // The push wake: the phone fetches and goes away. Nothing about the person
  // arriving or leaving may be recorded — `usersFor` ships `lastSeen` to every
  // roster, so a bumped timestamp is the same lie as a green dot.
  const wake = world.open();
  wake.send({ k: 'auth', token: 'token-boris', caps: ['lurk-v1'] });
  await tick();
  wake.conn.close();
  world.away();
  assert.deepEqual(world.store.touched, [], 'the wake socket neither arrived nor left');

  // A real screen does both.
  const phone = await world.join('boris');
  const arrivedAt = world.at();
  assert.deepEqual(world.store.touched, [['boris', arrivedAt]], 'a present session records its arrival');
  phone.conn.close();
  world.away();
  assert.deepEqual(
    world.store.touched,
    [['boris', arrivedAt], ['boris', arrivedAt]],
    'and its departure, at the moment the person left',
  );
});

test('a wake socket still attached does not stop the departure being recorded (issue #29)', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  const phone = await world.join('boris');
  world.store.touched.length = 0;
  anna.drop();

  // A wake socket of the same account, still fetching while the screen goes.
  const wake = world.open();
  wake.send({ k: 'auth', token: 'token-boris', caps: ['lurk-v1'] });
  await tick();
  assert.deepEqual(world.store.touched, [], 'the wake socket itself records nothing');

  world.advance(1000);
  const leftAt = world.at();
  phone.conn.close();
  // The raw connection set is not empty — the wake socket is still in it — but
  // the person is gone, and that is what the timestamp tracks.
  assert.deepEqual(world.store.touched, [['boris', leftAt]]);
  // Held for the grace window like any other departure — the blip rule — but it
  // is the person's departure being held, which is what the timestamp records.
  assert.equal(world.hub.isOnline('boris'), true, 'a departure inside the grace is not one yet');
  world.away();
  assert.equal(world.hub.isOnline('boris'), false);
  assert.deepEqual(anna.of('presence'), [{ k: 'presence', peer: 'boris', online: false, state: 'away' }]);
});

test('a notification names a contact the way the owner renamed them (issue #28)', async () => {
  const pushes = [];
  const world = harness({
    pushSender: { notify: async (login, payload) => { pushes.push({ login, payload }); } },
  });
  const anna = await joinCaller(world, 'anna');
  world.store.setAlias('boris', 'anna', 'Няша');

  // A message to an offline contact: the lock screen has to say what the app
  // says, or one rename leaves two names for one person in one glance.
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'привет', ts: world.at() } });
  await tick();
  const message = pushes.find((event) => event.login === 'boris' && event.payload.kind !== 'call');
  assert.equal(message.payload.title, 'Няша');
  assert.equal(message.payload.body, 'привет');

  // And the call offer nobody live received.
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'x' } });
  await tick();
  const call = pushes.find((event) => event.payload.kind === 'call');
  assert.equal(call.login, 'boris');
  assert.equal(call.payload.title, 'Няша');
});

test('a wake socket does not keep «печатает…» alive after the last screen leaves (issue #29)', async () => {
  const aiBridge = {
    name: 'tailik',
    // Accepts the question and never answers: the typing lease stays up.
    maybeRespond({ onAccepted }) { onAccepted(); return new Promise(() => {}); },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  const phone = await world.join('boris');
  const wake = world.open();
  wake.send({ k: 'auth', token: 'token-boris', caps: ['lurk-v1'] });
  await tick();
  anna.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'tailik, hi', ts: world.at() } });
  await tick();
  assert.deepEqual(anna.of('frame').filter((e) => e.d.t === 'typing').map((e) => e.d.state), ['start']);

  phone.conn.close();
  await tick();
  assert.deepEqual(
    anna.of('frame').filter((e) => e.d.t === 'typing').map((e) => e.d.state),
    ['start', 'stop'],
    'the last screen leaving ends the lease, even with a wake socket still attached',
  );
});

test('a nickname the owner set is private and follows the account (issue #28)', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const annaPhone = world.open();
  annaPhone.send({ k: 'auth', token: 'token-anna' });
  await tick();
  const boris = await world.join('boris');
  world.settle();
  anna.drop();
  annaPhone.drop();
  boris.drop();

  world.store.setAlias('anna', 'boris', 'Боря');
  world.hub.broadcastAliases('anna');

  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').alias, 'Боря');
  assert.equal(
    annaPhone.last('users').users.find((user) => user.login === 'boris').alias,
    'Боря',
    'every session of the owner is rebuilt, not only the one that asked',
  );
  assert.deepEqual(boris.of('users'), [], 'the peer is never sent a roster carrying somebody else\'s nickname');
  boris.send({ k: 'who' });
  assert.equal(boris.last('users').users.find((user) => user.login === 'anna').alias, undefined);

  // A session that connects later reads the nickname out of its own `ready`.
  const annaTablet = await world.join('anna');
  assert.equal(annaTablet.last('ready').users.find((user) => user.login === 'boris').alias, 'Боря');

  // Clearing it puts the peer's own name back on the row.
  world.store.setAlias('anna', 'boris', '');
  world.hub.broadcastAliases('anna');
  assert.equal(anna.last('users').users.find((user) => user.login === 'boris').alias, undefined);
});

test('a burst over the frame budget is dropped and reported, not closed', async () => {
  const world = harness({ frameRateLimit: 3 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  for (let n = 0; n < 5; n += 1) anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: `m${n}` } });
  await tick();

  // A burst is not a client that will not stop. The socket stays, the three
  // frames inside the budget are routed, and the two that found it spent are
  // dropped — the sender is told, and its own durable queue is what resends
  // them, not a reconnect it never needed.
  assert.deepEqual(anna.closes, [], 'one window over budget does not close the socket');
  assert.equal(world.hub.isOnline('anna'), true);
  assert.equal(world.store.queue.get('boris').length, 3, 'only the frames within the limit were routed');
  // `throttle`, not `error`: an `error` envelope is how both clients are told
  // the connection is broken, and they answer it by tearing the link down and
  // showing «Too many attempts» — for frames nobody refused and a socket that
  // is still perfectly usable.
  assert.deepEqual(anna.of('error'), [], 'a spent budget is not a broken connection');
  assert.equal(anna.of('throttle').length, 1, 'one report per window, not one per dropped frame');
  assert.deepEqual(anna.of('throttle')[0], { k: 'throttle', windowMs: 1000, frames: 4, limit: 3 });
  // And the line an operator can actually act on: who, in which conversation,
  // doing what, against which limit.
  assert.equal(world.notes.length, 1);
  assert.match(world.notes[0], /frame budget over budget login=anna peer=boris type=msg frames=4\/3/);
});

test('the throttle report names the frame type that spent the budget', async () => {
  const world = harness({ frameRateLimit: 2 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  for (let n = 0; n < 3; n += 1) anna.send({ k: 'frame', to: 'boris', d: { t: 'typing', state: 'start' } });
  await tick();

  assert.match(world.notes[0], /type=typing/);
});

test('overage in every window for three seconds running closes the connection with 4429', async () => {
  const world = harness({ frameRateLimit: 3 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  for (let window = 0; window < 3; window += 1) {
    world.advance(1000);
    for (let n = 0; n < 4; n += 1) {
      anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: `w${window}-${n}` } });
    }
  }
  await tick();

  // Four frames over the limit in one window is one window over budget, so the
  // third window is the third strike. That is the sustained rate the close is
  // for: a client that has not once come back inside the limit.
  assert.deepEqual(anna.closes, [4429]);
  // Even a client the server itself refused keeps answering `isOnline` until
  // the hold expires: whether anybody is *told* about a departure is the
  // roster's question, and it is answered on one clock for every departure —
  // see `PRESENCE_GRACE_MS`. What changed at once is the transport.
  assert.equal(world.hub.isOnline('anna'), true);
  world.away();
  assert.equal(world.hub.isOnline('anna'), false);
});

test('a window back inside the budget clears the strikes', async () => {
  const world = harness({ frameRateLimit: 3 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  for (let window = 0; window < 4; window += 1) {
    world.advance(1000);
    // Alternating: over budget, then not. A client that comes back inside the
    // limit every other second is bursty, not runaway, and keeps its socket.
    const frames = window % 2 === 0 ? 4 : 3;
    for (let n = 0; n < frames; n += 1) {
      anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: `w${window}-${n}` } });
    }
  }
  await tick();

  assert.deepEqual(anna.closes, []);
  assert.equal(world.hub.isOnline('anna'), true);
});

test('frames the hub would refuse anyway do not spend the frame budget', async () => {
  const world = harness({ frameRateLimit: 2 });
  const anna = await world.join('anna');

  // No subscription to `boris`: every one of these is refused on its own terms.
  for (let n = 0; n < 10; n += 1) anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: `x${n}` } });
  // And one that is not a frame at all.
  anna.send({ k: 'frame', to: 'boris', d: [1, 2, 3] });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'still-wrong' } });
  await tick();

  assert.deepEqual(anna.of('error').map((event) => event.code), Array(12).fill('not_subscribed'));

  anna.drop();
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm2' } });
  await tick();

  // The two frames that are actually routed fit in the budget: a refused frame
  // was never going to be delivered, so charging its sender's budget for it only
  // made the refusal worse.
  assert.equal(anna.of('message-accepted').length, 2);
  assert.deepEqual(anna.closes, []);
});

test('a read-receipt storm rebuilds the roster twice, not once per receipt', async () => {
  const world = harness({ frameRateLimit: 1000 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.drop();

  // Land the joins' own pass, then step clear of its window so the first
  // receipt below is the one that announces itself at once.
  world.settle();
  world.advance(1000);
  const before = boris.of('users').length;

  for (let n = 0; n < 100; n += 1) {
    anna.send({ k: 'frame', to: 'boris', d: { t: 'read', id: `m${n}` } });
  }
  await tick();

  // One pass for the first receipt — a roster that is visibly behind is its own
  // bug — and then everything inside the coalescing window folded into a single
  // trailing pass. A client catching up on its transcript used to make the
  // deployment rebuild every roster once per receipt, and each rebuild is a
  // full walk of the roster for every connected account.
  assert.equal(boris.of('users').length - before, 1, 'the first receipt is announced at once');
  world.settle();
  assert.equal(boris.of('users').length - before, 2, 'the other ninety-nine are one pass, not ninety-nine');
  assert.equal(boris.last('users').users.length, 2);
});

test('the rate window reopens after a second', async () => {
  const world = harness({ frameRateLimit: 3 });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.drop();

  for (let n = 0; n < 3; n += 1) anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: `a${n}` } });
  world.advance(1000);
  for (let n = 0; n < 3; n += 1) anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: `b${n}` } });
  await tick();

  assert.equal(anna.of('message-accepted').length, 6);
  assert.deepEqual(anna.closes, []);
  assert.equal(world.store.queue.get('boris').length, 6);
});

test('a transport that throws on write is dropped instead of throwing back at the sender', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const events = [];
  const boris = world.hub.connect((payload) => {
    events.push(payload);
    if (payload.k === 'frame') throw new Error('socket gone');
  }, { close: () => {} });
  boris.receive({ k: 'auth', token: 'token-boris' });
  await tick();
  boris.receive({ k: 'subscribe', peer: 'anna' });

  anna.send({ k: 'subscribe', peer: 'boris' });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1' } });
  await tick();

  assert.equal(events.at(-1).k, 'frame');
  assert.equal(world.hub.isOnline('boris'), true, 'the departure is held, see PRESENCE_GRACE_MS');
  world.away();
  assert.equal(world.hub.isOnline('boris'), false);
  // The routed frame counted as delivered, so it is not queued: the recipient's
  // socket accepted it and then died, which is a reconnect, not a lost message.
  assert.deepEqual(world.store.queue.get('boris') ?? [], []);
});

test('a promise-returning resolveToken is awaited before ready', async () => {
  const base = fakeStore();
  const store = { ...base, resolveToken: async (token) => base.resolveToken(token) };
  const world = harness({ store });

  const anna = world.open();
  anna.send({ k: 'auth', token: 'token-anna' });
  assert.deepEqual(anna.events, [], 'nothing is answered before the store does');
  await tick();
  assert.equal(anna.last('ready').self.login, 'anna');
});

test('the hub works against the real account store: queued message survives until subscribe', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-hub-'));
  const store = createAccountStore({ dir, now: () => 9000, writeDelayMs: 5000 });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const anna = await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  const boris = await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });
  const invite = store.createInvite('anna');
  store.acceptInvite('boris', invite);
  const world = harness({ store });

  const annaClient = world.open();
  annaClient.send({ k: 'auth', token: anna.token });
  await tick();
  annaClient.send({ k: 'subscribe', peer: 'boris' });
  annaClient.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'привет', ts: 8000 } });
  await until(() => Object.keys(store.pending('boris')).length > 0);
  assert.deepEqual(store.pending('boris'), { anna: 1 });

  const borisClient = world.open();
  borisClient.send({ k: 'auth', token: boris.token });
  await tick();
  assert.deepEqual(borisClient.last('ready').users, [{
    login: 'anna',
    name: 'Анна',
    online: true,
    state: 'active',
    lastSeen: 5000,
    pending: 1,
    callable: false,
    // The roster's second line, sent with the list rather than assembled by the
    // client: on a fresh load the client has opened no conversation and so
    // knows nothing to put there.
    last: {
      id: 'm1', from: 'anna', ts: 8000, kind: 'human', text: 'привет', media: null,
    },
  }]);

  borisClient.drop();
  borisClient.send({ k: 'subscribe', peer: 'anna' });
  assert.deepEqual(borisClient.events, [
    { k: 'frame', from: 'anna', d: { t: 'msg', id: 'm1', text: 'привет', ts: 8000 } },
    { k: 'subscribed', peer: 'anna', online: true, state: 'active', pending: 1, callable: false },
  ]);
  assert.deepEqual(store.pending('boris'), {});
  assert.deepEqual(store.history('anna', 'boris'), [
    { id: 'm1', from: 'anna', text: 'привет', ts: 8000, kind: 'human', seq: 1 },
  ]);

  assert.equal(store.resolveToken(anna.token).name, 'Анна');
});

test('an offline recipient gets a push notification carrying the sender name and text', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'привет', ts: 10 } });
  await tick();

  assert.deepEqual(pushSender.calls, [{
    login: 'boris',
    payload: { title: 'Anna', body: 'привет', peer: 'anna', messageId: 'm1', tag: 'tailchat-msg-anna' },
  }]);
});

test('a push preview falls back to an attachment label when there is no text', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push(payload); } };
  const world = harness({ pushSender });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: '', image: { dataUrl: 'x' } } });
  await tick();

  assert.equal(pushSender.calls[0].body, '📷 Photo');
});

test('a push still fires for a recipient device that is connected and viewing the conversation live', async () => {
  // This is the fix: gating push on "did *anyone* on this login get it live"
  // meant one open tab silenced every other device on the account forever.
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'hi' } });
  await tick();

  assert.equal(boris.of('frame').some((e) => e.d.id === 'm1'), true, 'boris still gets it live');
  assert.deepEqual(pushSender.calls, [{
    login: 'boris',
    payload: { title: 'Anna', body: 'hi', peer: 'anna', messageId: 'm1', tag: 'tailchat-msg-anna' },
  }]);
});

test('a second device of the same login still gets pushed while the first has it open live', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await world.join('anna');
  const borisLaptop = await world.join('boris');
  await world.join('boris'); // borisPhone: never subscribes, stands in for a closed app
  borisLaptop.send({ k: 'subscribe', peer: 'anna' });
  anna.send({ k: 'subscribe', peer: 'boris' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'hi' } });
  await tick();

  assert.equal(pushSender.calls.length, 1);
  assert.equal(pushSender.calls[0].login, 'boris');
});

test('read receipts and acks never trigger a push even for an unreachable recipient', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push(payload); } };
  const world = harness({ pushSender });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'ack', id: 'm1' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await tick();

  assert.deepEqual(pushSender.calls, []);
});

// A relayed-but-forgotten receipt is why an author's own message went back to
// one ✓ on every reload: nothing in the store knew it had been read. An ack is
// the rung below that — the reader's device holds the message — and the server
// is the only place it can be remembered, since an ack sent peer-to-peer
// reaches nobody else.
test('a read receipt and a delivery ack are both recorded in the store', async () => {
  const store = fakeStore();
  const world = harness({ store });
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });

  boris.send({ k: 'frame', to: 'anna', d: { t: 'ack', id: 'm1' } });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'read', id: 'm1' } });
  await tick();

  assert.deepEqual(store.reads, [{ reader: 'boris', peer: 'anna', id: 'm1' }]);
  assert.deepEqual(store.deliveryAdvances, [{ reader: 'boris', peer: 'anna', id: 'm1' }]);
});

// An ack rides the relayed frame as `deliveredTs`, so every session of the
// author subscribed to the conversation draws the same ✓✓ — and a late ack for
// an older message carries the standing watermark rather than walking it back.
test('an ack carries the delivery watermark to the author and never moves it backwards', async () => {
  const world = harness();
  const reader = await world.join('boris');
  const author = await world.join('anna');
  const authorPhone = await world.join('anna');
  reader.send({ k: 'subscribe', peer: 'anna' });
  author.send({ k: 'subscribe', peer: 'boris' });
  authorPhone.send({ k: 'subscribe', peer: 'boris' });
  await tick();

  reader.drop(); author.drop(); authorPhone.drop();
  reader.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm1', text: 'первое', ts: world.at() } });
  await until(() => world.store.committed.length === 1);
  reader.send({ k: 'frame', to: 'anna', d: { t: 'msg', id: 'm2', text: 'второе', ts: world.at() } });
  await until(() => world.store.committed.length === 2);
  const newest = world.store.committed[1].record.ts;

  author.drop(); authorPhone.drop();
  reader.send({ k: 'frame', to: 'anna', d: { t: 'ack', id: 'm2' } });
  await tick();

  assert.deepEqual(author.last('frame'), {
    k: 'frame', from: 'boris', d: { t: 'ack', id: 'm2', deliveredTs: newest },
  });
  assert.deepEqual(
    authorPhone.last('frame'),
    { k: 'frame', from: 'boris', d: { t: 'ack', id: 'm2', deliveredTs: newest } },
    'every session of the author subscribed to the conversation gets the same watermark',
  );
  assert.equal(world.store.deliveredTs('boris', 'anna'), newest);

  // A late ack for an older message is not a step backwards: the standing
  // watermark rides the frame, and the stored one does not move.
  author.drop(); authorPhone.drop();
  reader.send({ k: 'frame', to: 'anna', d: { t: 'ack', id: 'm1' } });
  await tick();
  assert.deepEqual(author.last('frame'), {
    k: 'frame', from: 'boris', d: { t: 'ack', id: 'm1', deliveredTs: newest },
  });
  assert.equal(world.store.deliveredTs('boris', 'anna'), newest);
  // A delivery is not a read: the read watermark was never touched, so the
  // author's rebuild from `/api/history` still shows ✓✓ rather than ✓✓ green.
  assert.equal(world.store.readTs('boris', 'anna'), 0);
});

// An ack whose id the store cannot resolve carries no watermark: there is no
// rung to report, and a `deliveredTs: 0` would claim one the server cannot
// vouch for. The frame still reaches the author, bare.
test('an ack naming an unknown id is relayed without a watermark', async () => {
  const world = harness();
  const reader = await world.join('boris');
  const author = await world.join('anna');
  reader.send({ k: 'subscribe', peer: 'anna' });
  author.send({ k: 'subscribe', peer: 'boris' });
  await tick();

  author.drop();
  reader.send({ k: 'frame', to: 'anna', d: { t: 'ack', id: 'never-sent' } });
  await tick();

  assert.deepEqual(author.last('frame'), {
    k: 'frame', from: 'boris', d: { t: 'ack', id: 'never-sent' },
  });
  assert.equal(world.store.deliveredTs('boris', 'anna'), 0);
});

// A durable mutation changes what every session of the accounts involved owes
// its own cursor — not only the one watching that conversation. `sync-v1` alone
// left that to the client's own reconnect, so a socket that stayed up in another
// conversation (the phone in the background, a second tab on the roster, the
// sender's own other device) learned nothing until something unrelated forced a
// new connection: the message was never lost server-side, the device was just
// silently behind. The nudge is the signal that closes it — empty on purpose,
// because `sync` already answers with everything since a cursor.
test('a profile change reaches the account\'s sessions with every field the client replaces its self with', async () => {
  const world = harness();
  const session = world.open();
  const otherAccount = world.open();
  session.send({ k: 'auth', token: 'token-anna' });
  otherAccount.send({ k: 'auth', token: 'token-boris' });
  await tick();
  session.drop(); otherAccount.drop();

  world.hub.broadcastProfile({ login: 'anna', name: 'Анна', extraPasswordEnabled: true });

  // The client replaces its whole `self` from this envelope, so a field missing
  // here is a field lost until the next login: without `extraPasswordEnabled` the
  // profile dialog offered to *set* an additional password the account already
  // had — see `openProfileDialog` in web/cloud/app.js.
  assert.deepEqual(session.last('profile'), {
    k: 'profile',
    user: { login: 'anna', name: 'Анна', extraPasswordEnabled: true },
  });
  assert.deepEqual(otherAccount.of('profile'), [], 'a profile change is account-local');
});

test('a durable mutation nudges every capable session of both accounts, once per window', async () => {
  const world = harness();
  const annaLaptop = world.open();
  const annaPhone = world.open();
  // A session that never announced the capability must not be sent the
  // envelope: an unhandled frame is noise, and the server already knows which
  // clients can use it.
  const annaOld = world.open();
  annaLaptop.send({ k: 'auth', token: 'token-anna', caps: ['sync-nudge-v1'] });
  annaPhone.send({ k: 'auth', token: 'token-anna', caps: ['sync-nudge-v1'] });
  annaOld.send({ k: 'auth', token: 'token-anna', caps: [] });
  await tick();
  const boris = world.open();
  boris.send({ k: 'auth', token: 'token-boris', caps: ['sync-nudge-v1'] });
  await tick();
  annaLaptop.send({ k: 'subscribe', peer: 'boris' });
  annaPhone.send({ k: 'subscribe', peer: 'boris' });
  annaOld.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  await tick();

  annaLaptop.drop(); annaPhone.drop(); annaOld.drop(); boris.drop();
  // Two messages inside one coalescing window: one nudge each, not two. A
  // receipt storm is hundreds of durable mutations in a burst, and one feed pass
  // covers all of them.
  annaLaptop.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'one', ts: world.at() } });
  await until(() => world.store.committed.length === 1);
  annaLaptop.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm2', text: 'two', ts: world.at() } });
  await until(() => world.store.committed.length === 2);

  assert.deepEqual(annaLaptop.of('sync-nudge'), [], 'nothing is sent before the window closes');
  world.advance(250);

  assert.equal(annaLaptop.of('sync-nudge').length, 1, 'the sender\'s own devices owe their own copy');
  assert.equal(annaPhone.of('sync-nudge').length, 1);
  assert.equal(boris.of('sync-nudge').length, 1, 'the recipient learns its feed moved without a subscription');
  assert.deepEqual(annaOld.of('sync-nudge'), [], 'a session that announced nothing is not sent it');
  // The nudge rides its own envelope and never the transcript channel: what did
  // arrive as frames is the self-sync copy of the messages themselves — which is
  // the one thing this path already did, and the reason the nudge had to be a
  // separate signal rather than another frame (`SELF_SYNC` stays msg/ai).
  assert.deepEqual(annaPhone.of('frame').map((event) => event.d.id), ['m1', 'm2']);
  assert.ok(annaPhone.of('frame').every((event) => event.self === true));

  // A window later, the next mutation nudges again: the clients sync from their
  // own cursors, so one pass per mutation is not needed and one for all of them
  // is enough.
  annaLaptop.drop();
  annaLaptop.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm3', text: 'three', ts: world.at() } });
  await until(() => world.store.committed.length === 3);
  world.advance(250);
  assert.equal(annaLaptop.of('sync-nudge').length, 1);
});

test('a read receipt nudges the author, so their other devices see the double tick', async () => {
  const world = harness();
  const reader = world.open();
  const author = world.open();
  const authorPhone = world.open();
  reader.send({ k: 'auth', token: 'token-boris', caps: ['sync-nudge-v1'] });
  author.send({ k: 'auth', token: 'token-anna', caps: ['sync-nudge-v1'] });
  authorPhone.send({ k: 'auth', token: 'token-anna', caps: ['sync-nudge-v1'] });
  await tick();
  reader.send({ k: 'subscribe', peer: 'anna' });
  author.send({ k: 'subscribe', peer: 'boris' });
  authorPhone.send({ k: 'subscribe', peer: 'boris' });
  await tick();

  reader.drop(); author.drop(); authorPhone.drop();
  reader.send({ k: 'frame', to: 'anna', d: { t: 'read', id: 'm1' } });
  await tick();
  world.advance(250);

  assert.equal(
    authorPhone.of('sync-nudge').length,
    1,
    'the author\'s device that was not subscribed to this conversation learns from the feed',
  );
  // The reader's own sessions are deliberately *not* nudged here: they already
  // got the account-local `read-sync` envelope, which is the same fact without a
  // second feed pass — and a receipt storm is exactly the traffic a nudge per
  // receipt would double.
  assert.deepEqual(reader.of('sync-nudge'), []);
  assert.equal(reader.of('read-sync').length, 0, 'the originating session already cleared itself');
});

test('nothing is nudged when no session of an account can use it', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  await tick();

  anna.drop(); boris.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm1', text: 'one', ts: world.at() } });
  await until(() => world.store.committed.length === 1);
  world.advance(250);

  // No timer is armed at all for an account with no capable session, so an old
  // deployment pays nothing for a feature none of its clients implements.
  assert.deepEqual(anna.of('sync-nudge'), []);
  assert.deepEqual(boris.of('sync-nudge'), []);
});

test('a durable read time reaches the author with the live receipt', async () => {
  const store = fakeStore();
  store.readAt = () => 9000;
  const world = harness({ store });
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  boris.drop();

  boris.send({ k: 'frame', to: 'anna', d: { t: 'read', id: 'm1' } });
  await tick();

  assert.deepEqual(anna.last('frame'), {
    k: 'frame', from: 'boris', d: { t: 'read', id: 'm1', readAt: 9000, readTs: 1 },
  });
});

test('a read receipt clears the reader roster on every other session', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const laptop = await world.join('anna');
  const boris = await world.join('boris');
  phone.send({ k: 'subscribe', peer: 'boris' });
  laptop.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  phone.drop();
  laptop.drop();
  boris.drop();

  phone.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await tick();

  assert.deepEqual(phone.of('read-sync'), [], 'the originating session already cleared itself');
  assert.deepEqual(laptop.of('read-sync'), [{
    k: 'read-sync', peer: 'boris', id: 'm1', readTs: 1,
  }]);
  // `readTs` rides along with the id: a receipt is a watermark, so the author's
  // client advances every own message at or before it rather than the one bubble
  // this frame happens to name.
  assert.deepEqual(boris.of('frame'), [{
    k: 'frame', from: 'anna', d: { t: 'read', id: 'm1', readTs: 1 },
  }]);
});

// Regression: `broadcastWebEvent` only ever reaches `webFeatures`
// connections, so a reaction added on one of an account's own devices used
// to never reach a native (CLI) session of that same account, even one
// open on the very same conversation — reported as "реакция в web не видна
// в cli". `syncReact` mirrors `syncRead` immediately above: an
// account-local envelope to every one of this login's own connections,
// regardless of client type.
test('a reaction added on one native device reaches this account\'s other native devices, not the originator', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-react-sync-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const annaUser = await store.register({ login: 'anna', password: 'test' });
  const borisUser = await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });
  const phone = world.open(); const laptop = world.open(); const boris = world.open();
  phone.send({ k: 'auth', token: annaUser.token });
  laptop.send({ k: 'auth', token: annaUser.token });
  boris.send({ k: 'auth', token: borisUser.token });
  await tick();
  phone.send({ k: 'subscribe', peer: 'boris' });
  laptop.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });

  phone.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm-react', text: 'привет', ts: 1 } });
  await until(() => boris.of('frame').some((e) => e.d.t === 'msg'));

  phone.drop(); laptop.drop(); boris.drop();
  phone.send({ k: 'frame', to: 'boris', d: { t: 'react', id: 'm-react', emoji: '👍', add: true } });
  await until(() => laptop.of('react-sync').length > 0);

  assert.deepEqual(phone.of('react-sync'), [], 'the originating session already applied its own reaction');
  assert.deepEqual(laptop.of('react-sync'), [{
    k: 'react-sync', peer: 'boris', id: 'm-react', emoji: '👍', by: 'anna', add: true,
  }]);
  assert.deepEqual(boris.of('frame').filter((e) => e.d.t === 'react'), [{
    k: 'frame', from: 'anna', d: { t: 'react', id: 'm-react', emoji: '👍', by: 'anna', add: true },
  }]);
});

test('a read receipt gets read-accepted only when the client declared read-ack-v1', async () => {
  const world = harness();
  const phone = world.open();
  phone.send({ k: 'auth', token: 'token-anna', caps: ['read-ack-v1'] });
  await tick();
  const boris = await world.join('boris');
  phone.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  phone.drop();
  boris.drop();

  phone.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await tick();

  assert.deepEqual(phone.of('read-accepted'), [
    { k: 'read-accepted', peer: 'boris', id: 'm1', readTs: 1 },
  ]);
});

test('a read receipt from a client that never declared read-ack-v1 gets no read-accepted', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const boris = await world.join('boris');
  phone.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  phone.drop();
  boris.drop();

  phone.send({ k: 'frame', to: 'boris', d: { t: 'read', id: 'm1' } });
  await tick();

  assert.deepEqual(phone.of('read-accepted'), []);
});

test('mark-read gets read-accepted with a null id only when the client declared read-ack-v1', async () => {
  const world = harness();
  const phone = world.open();
  phone.send({ k: 'auth', token: 'token-anna', caps: ['read-ack-v1'] });
  await tick();

  phone.send({ k: 'mark-read', peer: 'boris' });
  await tick();

  assert.deepEqual(phone.of('read-accepted'), [
    { k: 'read-accepted', peer: 'boris', id: null, readTs: 7000 },
  ]);
});

test('mark-read from a client that never declared read-ack-v1 gets no read-accepted', async () => {
  const world = harness();
  const anna = await world.join('anna');

  anna.send({ k: 'mark-read', peer: 'boris' });
  await tick();

  assert.deepEqual(anna.of('read-accepted'), []);
});

test('op-ack-v1 confirms each applied edit, reaction, and delete by operation id', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-op-ack-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const annaUser = await store.register({ login: 'anna', password: 'test' });
  const borisUser = await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });
  const anna = world.open();
  const boris = world.open();
  anna.send({ k: 'auth', token: annaUser.token, caps: ['op-ack-v1'] });
  boris.send({ k: 'auth', token: borisUser.token });
  await tick();
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm-op', text: 'Original', ts: 100 } });
  await until(() => anna.of('message-accepted').length === 1);
  anna.drop();

  anna.send({ k: 'frame', to: 'boris', d: {
    t: 'react', id: 'm-op', emoji: '👍', add: true, opId: 'react-op-1',
  } });
  anna.send({ k: 'frame', to: 'boris', d: {
    t: 'edit', id: 'm-op', text: 'Edited', opId: 'edit-op-1',
  } });
  anna.send({ k: 'frame', to: 'boris', d: {
    t: 'del', ids: ['m-op'], scope: 'self', opId: 'delete-op-1',
  } });

  await until(() => anna.of('op-accepted').length === 3);

  assert.deepEqual(anna.of('op-accepted'), [
    { k: 'op-accepted', peer: 'boris', opKind: 'react', id: 'm-op', opId: 'react-op-1' },
    { k: 'op-accepted', peer: 'boris', opKind: 'edit', id: 'm-op', opId: 'edit-op-1' },
    { k: 'op-accepted', peer: 'boris', opKind: 'delete', id: 'm-op', opId: 'delete-op-1' },
  ]);
});

test('legacy clients receive no operation acknowledgements', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-op-ack-legacy-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const annaUser = await store.register({ login: 'anna', password: 'test' });
  await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });
  const anna = world.open();
  anna.send({ k: 'auth', token: annaUser.token });
  await tick();
  anna.send({ k: 'subscribe', peer: 'boris' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'm-legacy-op', text: 'Original', ts: 100 } });
  await until(() => anna.of('message-accepted').length === 1);
  anna.drop();
  anna.send({ k: 'frame', to: 'boris', d: {
    t: 'edit', id: 'm-legacy-op', text: 'Edited', opId: 'edit-op-legacy',
  } });

  await until(() => store.history('anna', 'boris')[0].text === 'Edited');
  assert.deepEqual(anna.of('op-accepted'), []);
  assert.equal(store.history('anna', 'boris')[0].text, 'Edited', 'legacy mutation still applies');
});

test('a del with scope all reaches the peer as a content-free tombstone', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push(payload); } };
  const world = harness({ pushSender });
  const phone = await world.join('anna');
  const laptop = await world.join('anna');
  const boris = await world.join('boris');
  phone.send({ k: 'subscribe', peer: 'boris' });
  laptop.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  phone.drop();
  laptop.drop();
  boris.drop();

  phone.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: ['m-1', '', 7, 'm-2'], scope: 'all' } });
  await tick();

  const cleaned = { t: 'del', ids: ['m-1', 'm-2'], scope: 'all', tombstone: true };
  assert.deepEqual(world.store.deleted, [{ a: 'anna', b: 'boris', ids: ['m-1', 'm-2'] }]);
  assert.deepEqual(world.store.hidden, []);
  assert.deepEqual(boris.of('frame'), [{ k: 'frame', from: 'anna', d: cleaned }]);
  assert.deepEqual(laptop.of('frame'), [{ k: 'frame', from: 'boris', d: cleaned, self: true }],
    'a deletion reaches this account\'s other devices too, not just the peer');
  assert.deepEqual(phone.of('frame'), [], 'the deleting session has already dropped them itself');
  assert.deepEqual(world.store.recorded, [], 'a deletion is not a message');
  assert.deepEqual(pushSender.calls, []);
});

test('a del with scope self hides the ids for the sender alone and never reaches the peer', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const laptop = await world.join('anna');
  const boris = await world.join('boris');
  phone.send({ k: 'subscribe', peer: 'boris' });
  laptop.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  phone.drop();
  laptop.drop();
  boris.drop();

  phone.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: ['m-1'], scope: 'self' } });
  await tick();

  assert.deepEqual(world.store.hidden, [{ login: 'anna', peer: 'boris', ids: ['m-1'] }]);
  assert.deepEqual(world.store.deleted, []);
  assert.deepEqual(boris.of('frame'), [], 'the other side keeps its copy and is told nothing');
  assert.deepEqual(laptop.of('frame'), [
    { k: 'frame', from: 'boris', d: { t: 'del', ids: ['m-1'], scope: 'self' }, self: true },
  ]);
  assert.equal((world.store.queue.get('boris') ?? []).length, 0, 'nothing was queued for the peer either');
});

test('a del batch is capped and a del without usable ids is dropped', async () => {
  const world = harness();
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'boris' });

  anna.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: [], scope: 'all' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: ['', ''], scope: 'self' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: 'm-1' } });
  assert.deepEqual(world.store.deleted, []);
  assert.deepEqual(world.store.hidden, []);
  assert.equal(world.store.queue.get('boris'), undefined);

  const many = Array.from({ length: 250 }, (_, index) => `m-${index}`);
  anna.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: many } });
  await tick();
  assert.equal(world.store.deleted[0].ids.length, 200);
  assert.equal(world.store.deleted[0].ids[199], 'm-199');
  assert.equal(world.store.queue.get('boris')[0].d.scope, 'all', 'a missing scope means everyone');
});

test('a del for an unreachable peer waits in the queue without an unread notice', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'roman' });
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: ['m-1'], scope: 'all' } });
  await tick();

  assert.deepEqual(
    world.store.queue.get('boris').map((item) => [item.from, item.d]),
    [['anna', { t: 'del', ids: ['m-1'], scope: 'all', tombstone: true }]],
  );
  assert.deepEqual(boris.of('unread'), [], 'nothing new to read was said');
});

test('a reported state moves the aggregate once and travels on presence and the roster', async () => {
  const world = harness();
  const phone = await world.join('anna');
  const boris = await world.join('boris');
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.drop();

  // Past the window the two joins armed, so the state change below is a pass of
  // its own rather than folded into theirs.
  world.settle();
  phone.send({ k: 'state', state: 'idle' });
  world.settle();
  assert.deepEqual(boris.of('presence'), [{ k: 'presence', peer: 'anna', online: true, state: 'idle' }]);
  assert.equal(boris.last('users').users.find((user) => user.login === 'anna').state, 'idle');
  boris.drop();

  phone.send({ k: 'state', state: 'idle' });
  phone.send({ k: 'state', state: 'somewhere' });
  assert.deepEqual(boris.events, [], 'an unchanged or unknown state fans out nothing');

  // The most present device wins: the phone stays idle, the laptop is new and
  // therefore active, and the account reads as active until both fall back.
  const laptop = await world.join('anna');
  boris.send({ k: 'who' });
  assert.equal(boris.last('users').users.find((user) => user.login === 'anna').state, 'active');
  boris.drop();

  phone.send({ k: 'state', state: 'away' });
  assert.deepEqual(boris.events, [], 'one device leaving the keyboard is not the person leaving');

  laptop.send({ k: 'state', state: 'away' });
  assert.deepEqual(boris.of('presence'), [{ k: 'presence', peer: 'anna', online: true, state: 'away' }]);
  assert.equal(world.hub.stateOf('anna'), 'away');
  assert.equal(world.hub.stateOf('roman'), 'away', 'nobody connected is nobody at the keyboard');
});

test('an inner focus frame updates the presence aggregate and is still relayed to the peer', async () => {
  const world = harness();
  const anna = await world.join('anna');
  const boris = await world.join('boris');
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.send({ k: 'subscribe', peer: 'anna' });
  anna.drop();
  boris.drop();

  anna.send({ k: 'frame', to: 'boris', d: { t: 'focus', state: 'inactive' } });

  assert.equal(world.hub.stateOf('anna'), 'idle', 'a 0.10.x terminal only says «inactive»');
  assert.deepEqual(boris.of('presence'), [{ k: 'presence', peer: 'anna', online: true, state: 'idle' }]);
  assert.deepEqual(boris.of('frame'), [{ k: 'frame', from: 'anna', d: { t: 'focus', state: 'inactive' } }]);
});

// A terminal announces its own «печатает…» while it thinks. The bridge answers
// with no terminal involved, so without the hub doing it the web client sat in
// silence for the whole round trip — and a slow answer reads as nothing
// happening at all.
test('the hub announces the assistant composing while the bridge works', async () => {
  let release;
  const aiBridge = {
    name: 'tailik',
    maybeRespond({ onAccepted }) {
      onAccepted();
      return new Promise((resolve) => { release = () => resolve({ from: 'roman', to: 'anna', text: 'Привет!' }); });
    },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'roman' });
  anna.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm8', text: 'tailik, hi', ts: 80 } });
  await tick();

  const started = anna.of('frame').filter((e) => e.d.t === 'typing');
  assert.deepEqual(started.map((e) => e.d.state), ['start']);
  assert.equal(started[0].d.name, 'tailik', 'signed with the name the answer will carry');

  release();
  await tick();
  await tick();
  const typing = anna.of('frame').filter((e) => e.d.t === 'typing');
  assert.deepEqual(typing.map((e) => e.d.state), ['start', 'stop']);
});

test('a message the bridge declines produces no phantom typing', async () => {
  const aiBridge = {
    name: 'tailik',
    // Never calls onAccepted: it decided not to answer.
    async maybeRespond() { return null; },
  };
  const world = harness({ aiBridge });
  const anna = await world.join('anna');
  anna.send({ k: 'subscribe', peer: 'roman' });
  anna.drop();

  anna.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'm9', text: 'just talking', ts: 90 } });
  await tick();
  await tick();

  assert.deepEqual(anna.of('frame').filter((e) => e.d.t === 'typing'), []);
});

test('web sessions receive off-chat events and reaction reads without legacy control echoes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-web-events-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const annaUser = await store.register({ login: 'anna', password: 'test' });
  const borisUser = await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });
  const anna = world.open(); const boris = world.open(); const legacy = world.open();
  anna.send({ k: 'auth', token: annaUser.token, webFeatures: true });
  boris.send({ k: 'auth', token: borisUser.token, webFeatures: true });
  legacy.send({ k: 'auth', token: borisUser.token });
  await tick();
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.drop(); legacy.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'web-m', text: 'Hello', ts: 12345 } });
  await until(() => boris.of('conversation-update').length > 0);
  assert.equal(boris.last('conversation-update').last.text, 'Hello');
  assert.equal(boris.of('unread').length, 0, 'no double counting with legacy unread envelopes');
  assert.equal(legacy.of('conversation-update').length, 0);
  anna.send({ k: 'frame', to: 'boris', d: { t: 'react', id: 'web-m', emoji: '👍', add: true } });
  await until(() => boris.of('message-event').some((event) => event.d.t === 'react'));
  world.settle();
  assert.equal(boris.last('message-event').d.t, 'react');
  const event = boris.last('users').users.find(user => user.login === 'anna').reactionEvents[0];
  assert.ok(event.id);
  boris.send({ k: 'reaction-read', peer: 'anna', ids: [event.id] });
  assert.deepEqual(store.reactionEvents('boris', 'anna'), []);
  anna.send({ k: 'frame', to: 'boris', d: { t: 'edit', id: 'web-m', text: 'Updated' } });
  await until(() => boris.last('message-event')?.d?.text === 'Updated');
  assert.equal(boris.last('message-event').d.text, 'Updated');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'del', ids: ['web-m'], scope: 'all' } });
  await until(() => boris.last('message-event')?.d?.tombstone === true);
  assert.equal(boris.last('message-event').d.tombstone, true);
  assert.equal(store.history('boris', 'anna', 60, { includeDeleted: true })[0].text, '');
  assert.equal(store.history('boris', 'anna').length, 0);
  assert.equal(legacy.of('message-event').length, 0);

});

// ---- Voice calls (docs/specs/2026-09-15-android-calls-plan.md §3.1, §6) ----

async function joinCaller(world, login, caps = ['addressed-send', 'call-v1']) {
  const client = world.open();
  client.send({ k: 'auth', token: `token-${login}`, caps });
  await tick();
  return client;
}

test('a call-offer reaches every connection of the callee, whatever conversation it has open', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  const borisIdle = await joinCaller(world, 'boris');
  boris.send({ k: 'subscribe', peer: 'roman' });
  boris.drop();
  borisIdle.drop();

  const offer = { t: 'call-offer', callId: 'c1', sdp: 'v=0', media: 'audio', ts: 5000 };
  anna.send({ k: 'frame', to: 'boris', d: offer });
  await tick();
  assert.deepEqual(boris.of('frame'), [{ k: 'frame', from: 'anna', d: offer }]);
  assert.deepEqual(borisIdle.of('frame'), [{ k: 'frame', from: 'anna', d: offer }]);
  assert.deepEqual(boris.of('unread'), []);
});

test('call signalling is never queued, stored, or turned into a conversation update', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  for (const t of ['call-offer', 'call-ring', 'call-answer', 'call-ice', 'call-end', 'call-taken']) {
    anna.send({ k: 'frame', to: 'boris', d: { t, callId: 'c1' } });
  }
  await tick();
  assert.equal((world.store.queue.get('boris') ?? []).length, 0);
  assert.deepEqual(world.store.recorded, []);
});

test('a call push goes out only for an offer nobody live received', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await joinCaller(world, 'anna');

  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'x' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-end', callId: 'c1', reason: 'hangup' } });
  await tick();
  assert.deepEqual(pushSender.calls, [
    { login: 'boris', payload: { kind: 'call', callId: 'c1', peer: 'anna', title: 'Anna' } },
  ]);

  await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c2', sdp: 'x' } });
  await tick();
  assert.equal(pushSender.calls.length, 1);
});

// «При закрытом приложении звонок не всегда проходит»: the phone's socket is
// one the server still believes open — frozen by Doze, or a TCP connection
// that died without a FIN. The write succeeds, `delivered > 0`, so neither
// the hold nor the push happened and the phone rang nothing for 45 seconds.
// A `call-ring` is the only proof a device is really ringing.
test('an offer a live socket took but never rang is pushed after the ring window', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await joinCaller(world, 'anna');
  const borisZombie = await joinCaller(world, 'boris');

  const offer = { t: 'call-offer', callId: 'c1', sdp: 'v=0' };
  anna.send({ k: 'frame', to: 'boris', d: offer });
  await tick();
  assert.deepEqual(borisZombie.of('frame'), [{ k: 'frame', from: 'anna', d: offer }]);
  assert.deepEqual(pushSender.calls, [], 'a socket that took the frame is given its chance first');

  world.advance(6_000);
  assert.deepEqual(pushSender.calls, [
    { login: 'boris', payload: { kind: 'call', callId: 'c1', peer: 'anna', title: 'Anna' } },
  ]);

  // And the offer the push wakes that phone for is still there to collect.
  const borisWoken = await joinCaller(world, 'boris');
  assert.deepEqual(borisWoken.of('frame'), [{ k: 'frame', from: 'anna', d: offer }]);
});

test('a device that answers with call-ring is neither pushed nor rung a second time', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');

  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.send({ k: 'frame', to: 'anna', d: { t: 'call-ring', callId: 'c1' } });
  await tick();

  world.advance(6_000);
  assert.deepEqual(pushSender.calls, [], 'the phone is ringing; waking it again is noise');

  // A reconnect inside the ring window must not replay the offer: the
  // device's CallController answers a second offer for a call it is already
  // showing with `busy`, which would kill the ring that is already up.
  const borisAgain = await joinCaller(world, 'boris');
  assert.deepEqual(borisAgain.of('frame'), []);
});

// The failure this pins: the owner's contact had a browser tab signed in
// while their phone's app was closed. The tab is a live socket, so the offer
// counted as delivered — no hold, no push — and the phone never rang.
test('a live connection that cannot take a call does not consume the offer', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await joinCaller(world, 'anna');
  const borisWeb = await world.join('boris');

  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();

  assert.deepEqual(pushSender.calls, [
    { login: 'boris', payload: { kind: 'call', callId: 'c1', peer: 'anna', title: 'Anna' } },
  ]);
  const borisPhone = await joinCaller(world, 'boris');
  assert.deepEqual(borisPhone.of('frame'), [
    { k: 'frame', from: 'anna', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } },
  ]);
  assert.equal(borisWeb.of('frame').length, 1);
});

// The push that wakes a phone is useless on its own: call frames are never
// put in the durable queue, so the offer the phone was woken *for* used to be
// gone by the time its socket came back — it connected, rang nothing, and the
// caller listened to a ring nobody could answer.
test('an offer nobody received is handed to the callee the moment a call-capable device connects', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const offer = { t: 'call-offer', callId: 'c1', sdp: 'v=0', media: 'audio', ts: 5000 };
  anna.send({ k: 'frame', to: 'boris', d: offer });
  await tick();

  const borisPhone = await joinCaller(world, 'boris');
  assert.deepEqual(borisPhone.of('frame'), [{ k: 'frame', from: 'anna', d: offer }]);

  // Handed over once: a second device must not ring for a call the first one
  // is already showing.
  const borisTablet = await joinCaller(world, 'boris');
  assert.deepEqual(borisTablet.of('frame'), []);
});

test('a held offer is dropped once the caller has stopped ringing', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  world.advance(45_000);

  const borisPhone = await joinCaller(world, 'boris');
  assert.deepEqual(borisPhone.of('frame'), []);
});

test('a call-end withdraws the held offer instead of ringing the next device to connect', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-end', callId: 'c1', reason: 'timeout' } });
  await tick();

  const borisPhone = await joinCaller(world, 'boris');
  assert.deepEqual(borisPhone.of('frame'), []);
});

// «Если я перестал звонить, смартфон абонента продолжает звонить»: the
// caller's app is swiped away or loses signal, so it never sends `call-end`,
// and the callee has no way to tell that from a caller still ringing.
test('a caller whose last call-capable socket disappears cancels its own ring', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.drop();

  anna.conn.close();
  await tick();
  // Held, not delivered on the spot: the teardown alone is not a verdict —
  // see the next test for the caller that is only reconnecting.
  assert.deepEqual(boris.of('frame'), []);

  world.advance(CALL_CANCEL_GRACE_MS);
  assert.deepEqual(boris.of('frame'), [
    { k: 'frame', from: 'anna', d: { t: 'call-end', callId: 'c1', reason: 'hangup' } },
  ]);
});

// The other half of «звонок сбрасывался»: the caller's socket blipped — a
// cellular handover, a Doze window, the tunnel recycling — and the ring was
// withdrawn from a phone its owner was still waiting on. A caller that is
// back before the grace expires is a caller still ringing.
test('a caller that reconnects inside the grace keeps its ring', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.drop();

  anna.conn.close();
  await tick();
  await joinCaller(world, 'anna');

  world.advance(CALL_CANCEL_GRACE_MS);
  assert.deepEqual(boris.of('frame'), []);
});

// An answered call's media path is peer-to-peer and needs no signalling
// socket. The leg is a *ring* left behind, and once the phone was picked up
// there is no ring to withdraw — treating the leg as live anyway is what sent
// `call-end{hangup}` into a conversation in progress the first time the
// caller's connection blipped.
test('a caller that drops its socket mid-conversation does not end the call', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.send({ k: 'frame', to: 'anna', d: { t: 'call-ring', callId: 'c1' } });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'call-answer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.drop();

  anna.conn.close();
  await tick();
  world.advance(CALL_CANCEL_GRACE_MS);
  assert.deepEqual(boris.of('frame'), []);
});

// A leg is one call to one peer, and a late frame about an earlier one must
// not judge it. `call-answer` for a call that has already been replaced is
// exactly the frame a retry or a reordered delivery produces.
test('an answer for an older call does not clear the ring of the current one', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-end', callId: 'c1', reason: 'hangup' } });
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c2', sdp: 'v=0' } });
  await tick();
  boris.drop();

  boris.send({ k: 'frame', to: 'anna', d: { t: 'call-answer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  anna.conn.close();
  await tick();
  world.advance(CALL_CANCEL_GRACE_MS);
  assert.deepEqual(boris.of('frame'), [
    { k: 'frame', from: 'anna', d: { t: 'call-end', callId: 'c2', reason: 'hangup' } },
  ]);
});

// A running call re-negotiating its media path after an ICE failure sends the
// same `call-offer` frame with `restart` set. It is not a new call: nothing
// about placing one may happen for it — no leg to cancel, no held offer, no
// push that would ring a phone already talking into this very call, and no
// charge against the rate limit that exists to stop repeated *call attempts*.
test('a restart offer is relayed without becoming a new call', async () => {
  const pushSender = { calls: [], async notify(login, payload) { this.calls.push({ login, payload }); } };
  const world = harness({ pushSender });
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.send({ k: 'frame', to: 'anna', d: { t: 'call-ring', callId: 'c1' } });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'call-answer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.drop();

  for (let i = 0; i < 8; i += 1) {
    anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: `v=${i}`, restart: true } });
  }
  await tick();
  assert.equal(boris.of('frame').length, 8);
  assert.equal(anna.of('error').length, 0, 'a restart is not a call attempt and is not rate limited');
  world.advance(6_000);
  assert.deepEqual(pushSender.calls, [], 'the callee is in this call; waking it again is noise');

  // And the leg it must not have created: the caller's own blip is only a
  // ring's business, and this call was answered.
  anna.conn.close();
  await tick();
  world.advance(CALL_CANCEL_GRACE_MS);
  assert.deepEqual(boris.of('frame').length, 8);
});

// The marker is a claim by the sender, not a fact. With no answered call
// behind it the offer is an attempt like any other: limited per minute, held
// for the callee's next device, and pushed — everything a real call gets,
// because that is what it is.
test('a restart marker on a call nobody answered is an offer like any other', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  await joinCaller(world, 'boris');

  for (let i = 0; i < 5; i += 1) {
    anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: `c${i}`, restart: i > 2 } });
  }
  await tick();
  assert.equal(anna.of('error').length, 0);

  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c6', restart: true } });
  assert.equal(anna.last('error').code, 'too_many_calls');

  const borisPhone = await joinCaller(world, 'boris');
  assert.deepEqual(borisPhone.of('frame'), [
    { k: 'frame', from: 'anna', d: { t: 'call-offer', callId: 'c4', restart: true } },
  ]);
});

test('a call already ended, or still reachable on another device, is not cancelled twice', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const annaTablet = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();
  boris.drop();

  // Another of the caller's own devices can still carry the call.
  anna.conn.close();
  await tick();
  assert.deepEqual(boris.of('frame'), []);

  // And a call that already ended leaves nothing to cancel.
  annaTablet.send({ k: 'frame', to: 'boris', d: { t: 'call-end', callId: 'c1', reason: 'hangup' } });
  await tick();
  boris.drop();
  annaTablet.conn.close();
  await tick();
  world.advance(CALL_CANCEL_GRACE_MS);
  assert.deepEqual(boris.of('frame'), []);
});

// A browser has nothing that could answer a call, and a device that never
// declared `call-v1` is exactly the phone whose engine failed to initialise.
test('a held offer is not handed to a connection that cannot take a call', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } });
  await tick();

  const borisWeb = await world.join('boris');
  assert.deepEqual(borisWeb.of('frame'), []);

  const borisPhone = await joinCaller(world, 'boris');
  assert.deepEqual(borisPhone.of('frame'), [
    { k: 'frame', from: 'anna', d: { t: 'call-offer', callId: 'c1', sdp: 'v=0' } },
  ]);
});

test('call-taken addressed to the own login reaches the other devices but not the sender', async () => {
  const world = harness();
  const phone = await joinCaller(world, 'boris');
  const tablet = await joinCaller(world, 'boris');
  phone.drop();
  tablet.drop();
  phone.send({ k: 'frame', to: 'boris', d: { t: 'call-taken', callId: 'c1' } });
  await tick();
  assert.deepEqual(tablet.of('frame'), [{ k: 'frame', from: 'boris', d: { t: 'call-taken', callId: 'c1' } }]);
  assert.deepEqual(phone.of('frame'), []);
  assert.deepEqual(phone.of('error'), []);
});

test('a call to a blocked pair or a non-friend is refused', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  world.store.blockUser('boris', 'anna');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c1' } });
  assert.equal(anna.last('error').code, 'blocked');
  assert.deepEqual(boris.of('frame'), []);

  anna.drop();
  anna.send({ k: 'frame', to: 'stranger', d: { t: 'call-offer', callId: 'c2' } });
  assert.equal(anna.last('error').code, 'not_subscribed');
});

test('the sixth call-offer to the same person within a minute is refused', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const boris = await joinCaller(world, 'boris');
  for (let i = 1; i <= 6; i += 1) {
    anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: `c${i}` } });
  }
  await tick();
  assert.equal(boris.of('frame').length, 5);
  assert.equal(anna.last('error').code, 'too_many_calls');

  world.advance(60_000);
  anna.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'call-offer', callId: 'c7' } });
  await tick();
  assert.deepEqual(anna.of('error'), []);
  assert.equal(boris.of('frame').length, 6);
});

test('callable follows live call-v1 connections in ready, users and subscribed', async () => {
  const world = harness();
  const anna = await joinCaller(world, 'anna');
  const callableBoris = () => anna.last('users').users.find((u) => u.login === 'boris').callable;

  // Boris only in the web: online, but nothing there can answer.
  const web = world.open();
  web.send({ k: 'auth', token: 'token-boris', webFeatures: true, caps: ['addressed-send'] });
  await tick();
  world.settle();
  assert.equal(callableBoris(), false);
  anna.send({ k: 'subscribe', peer: 'boris' });
  assert.equal(anna.last('subscribed').callable, false);

  // His phone comes online beside the web tab.
  const phone = await joinCaller(world, 'boris');
  world.settle();
  assert.equal(callableBoris(), true);
  anna.send({ k: 'subscribe', peer: 'boris' });
  assert.equal(anna.last('subscribed').callable, true);
  const roman = await joinCaller(world, 'roman');
  assert.equal(roman.last('ready').users.find((u) => u.login === 'boris').callable, true);

  // The phone leaves; the web tab keeps him online but no longer callable.
  phone.conn.close();
  world.settle();
  assert.equal(callableBoris(), false);
  assert.equal(anna.last('users').users.find((u) => u.login === 'boris').online, true);
});

test('native reaction receipts use their own capability without opting into web delivery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-native-reactions-'));
  const store = createAccountStore({ dir });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sender = await store.register({ login: 'anna', password: 'test' });
  const reader = await store.register({ login: 'boris', password: 'test' });
  store.linkFriends('anna', 'boris');
  const world = harness({ store });
  const anna = world.open(); const boris = world.open();
  anna.send({ k: 'auth', token: sender.token, webFeatures: true });
  boris.send({ k: 'auth', token: reader.token, caps: ['reaction-read-v1'], appVersion: 186 });
  await tick();
  assert.ok(boris.last('ready').caps.includes('reaction-read-v1'));
  anna.send({ k: 'subscribe', peer: 'boris' });
  boris.drop();
  anna.send({ k: 'frame', to: 'boris', d: { t: 'msg', id: 'native-react', text: 'Hello', ts: 12345 } });
  await until(() => boris.of('unread').length > 0);
  assert.equal(boris.of('conversation-update').length, 0, 'native transport must not turn into web transport');
  anna.send({ k: 'frame', to: 'boris', d: { t: 'react', id: 'native-react', emoji: '🤝', add: true } });
  await until(() => store.reactionEvents('boris', 'anna').length > 0);
  world.settle();
  const event = boris.last('users').users.find(user => user.login === 'anna').reactionEvents[0];
  assert.equal(event.messageId, 'native-react');
  assert.equal(event.emoji, '🤝');
  boris.send({ k: 'reaction-read', peer: 'anna', ids: [event.id] });
  assert.deepEqual(store.reactionEvents('boris', 'anna'), []);
  assert.equal(store.unreadCounts('boris').anna, 1, 'reading a reaction must not mark the message read');
  const message = store.history('boris', 'anna', 60)[0];
  boris.send({ k: 'subscribe', peer: 'anna' });
  boris.send({ k: 'frame', to: 'anna', d: { t: 'read', id: message.id, ts: message.ts } });
  await until(() => store.readTs('boris', 'anna') >= message.ts);
  assert.equal(store.readVia('boris', 'anna'), 'android/186');
});
