import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRemindkaSync,
  MAX_CHANGES,
  SyncError,
} from '../bots/remindka-sync.mjs';

const KEY = 'rmk_' + 'a'.repeat(32);
const MIN = 60_000;
const cadence = { nagMs: 15 * MIN, nagMax: 2, dayMs: 24 * 60 * MIN };

// The server side of the protocol, with the real server's rules: a key nobody
// linked is `401 unlinked`, a change wins only with a strictly newer
// `updated_at`, and a pull returns everything after the cursor — including the
// caller's own just-applied changes. One vault per key.
function fakeServer({ linked = [KEY] } = {}) {
  const vaults = new Map();
  const rowsOf = (key) => {
    if (!vaults.has(key)) vaults.set(key, new Map());
    return vaults.get(key);
  };
  let seq = 0;
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const key = /^Bearer (.+)$/.exec(init.headers.Authorization)?.[1];
    if (!linked.includes(key)) {
      return new Response(JSON.stringify({ error: 'unlinked' }), { status: 401 });
    }
    const rows = rowsOf(key);
    const applied = [];
    const rejected = [];
    for (const change of body.changes) {
      const existing = rows.get(change.sync_id);
      if (existing && change.updated_at <= existing.updated_at) {
        rejected.push(change.sync_id);
        continue;
      }
      seq += 1;
      rows.set(change.sync_id, { ...change, seq });
      applied.push(change.sync_id);
    }
    const items = [...rows.values()].filter((row) => row.seq > body.cursor).sort((a, b) => a.seq - b.seq);
    return new Response(JSON.stringify({
      ok: true,
      cursor: items.length > 0 ? items[items.length - 1].seq : body.cursor,
      applied,
      rejected,
      items,
      server_time: Date.now(),
    }), { status: 200 });
  };
  const put = (change, key = KEY) => {
    seq += 1;
    rowsOf(key).set(change.sync_id, { ...change, seq });
  };
  return { fetchImpl, rows: rowsOf(KEY), put, requests };
}

function setup({ server = fakeServer(), reminders = [], clock = { t: 1_000_000 } } = {}) {
  const store = { reminders, users: {}, save() {} };
  const sync = createRemindkaSync({
    store,
    ownerOf: (reminder) => reminder.ownerId,
    cadence,
    baseUrl: 'https://sync.test/sync/',
    fetchImpl: server.fetchImpl,
    now: () => clock.t,
  });
  return { store, sync, server, clock };
}

const remote = (over = {}) => ({
  sync_id: 'bot-1', text: 'from telegram', origin: null, origin_url: null,
  due_at: 5_000_000, status: 'scheduled', next_nag_at: null, nag_count: 0,
  created_at: 900_000, updated_at: 950_000, ...over,
});

const local = (over = {}) => ({
  id: 'abc-1', ownerId: 'olga', text: 'позвонить маме', dueAt: 4_000_000,
  status: 'scheduled', createdAt: 800_000, ...over,
});

test('linking pushes local reminders and imports the main database, at the key\'s own URL', async () => {
  const server = fakeServer();
  server.put(remote());
  server.put(remote({ sync_id: 'bot-2', status: 'done' }));
  server.put(remote({ sync_id: 'bot-3', status: 'cancelled' }));
  const { store, sync } = setup({ server, reminders: [local()] });

  const result = await sync.link('olga', KEY);

  assert.equal(server.requests[0].url, 'https://sync.test/sync/v1/sync');
  assert.deepEqual(result, { pushed: 1, imported: 1 });
  assert.equal(server.rows.get('tc-abc-1').text, 'позвонить маме');
  assert.equal(server.rows.get('tc-abc-1').status, 'scheduled');
  // Finished or deleted elsewhere, and never here: nothing to show.
  assert.deepEqual(store.reminders.map((reminder) => reminder.syncId).sort(), ['bot-1', 'tc-abc-1']);
  const imported = store.reminders.find((reminder) => reminder.syncId === 'bot-1');
  assert.equal(imported.ownerId, 'olga');
  assert.equal(imported.text, 'from telegram');
  assert.equal(imported.dueAt, 5_000_000);
  assert.equal(store.users.olga.sync.key, KEY);
});

test('a key the main database does not know is refused and never kept', async () => {
  const { store, sync } = setup({ server: fakeServer({ linked: [] }), reminders: [local()] });

  await assert.rejects(sync.link('olga', KEY), (error) => error instanceof SyncError && error.code === 'unlinked');

  assert.equal(store.users.olga.sync, undefined);
  assert.equal(sync.isLinked('olga'), false);
});

test('an unreachable server fails the link instead of half-saving it', async () => {
  const store = { reminders: [local()], users: {}, save() {} };
  const down = createRemindkaSync({
    store, ownerOf: (r) => r.ownerId, cadence,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });

  await assert.rejects(down.link('olga', KEY), (error) => error.code === 'network');

  assert.equal(store.users.olga.sync, undefined);
  assert.equal(down.isLinked('olga'), false);
});

test('a second round with nothing changed pushes nothing, and our own echo changes nothing', async () => {
  const { store, sync, server } = setup({ reminders: [local()] });
  await sync.link('olga', KEY);
  const before = JSON.stringify(store.reminders);

  await sync.syncPeer('olga');

  assert.deepEqual(server.requests.at(-1).body.changes, []);
  assert.equal(JSON.stringify(store.reminders), before);
});

test('last write wins in both directions', async () => {
  const server = fakeServer();
  server.put(remote());
  const { store, sync, clock } = setup({ server });
  await sync.link('olga', KEY);
  const mine = store.reminders[0];

  // Newer on the server: the other surface moved it.
  server.put(remote({ text: 'moved in the app', due_at: 6_000_000, updated_at: 2_000_000 }));
  clock.t = 1_500_000;
  await sync.syncPeer('olga');
  assert.equal(mine.text, 'moved in the app');
  assert.equal(mine.dueAt, 6_000_000);

  // Newer here: the person snoozed it in Tailchat.
  mine.dueAt = 7_000_000;
  clock.t = 3_000_000;
  await sync.syncPeer('olga');
  assert.equal(server.rows.get('bot-1').due_at, 7_000_000);
  assert.equal(server.rows.get('bot-1').updated_at, 3_000_000);

  // An older write from the server never overrides a newer local one.
  server.put(remote({ text: 'stale', due_at: 7_000_000, updated_at: 2_500_000 }));
  await sync.syncPeer('olga');
  assert.equal(mine.text, 'moved in the app');
});

test('a deletion in a linked chat reaches the main database as cancelled and stops being pending', async () => {
  const { store, sync, server, clock } = setup({ reminders: [local()] });
  await sync.link('olga', KEY);
  const mine = store.reminders[0];

  mine.status = 'cancelled';
  assert.equal(sync.isPending(mine), true);
  clock.t += 10;
  await sync.syncPeer('olga');

  assert.equal(server.rows.get('tc-abc-1').status, 'cancelled');
  assert.equal(sync.isPending(mine), false);
});

test('a reminder deleted elsewhere disappears here', async () => {
  const server = fakeServer();
  server.put(remote());
  const { store, sync } = setup({ server });
  await sync.link('olga', KEY);
  assert.equal(store.reminders.length, 1);

  server.put(remote({ status: 'cancelled', updated_at: 2_000_000 }));
  await sync.syncPeer('olga');

  assert.equal(store.reminders.length, 0);
});

test('a reminder another surface already delivered is open here but not repeated here', async () => {
  const server = fakeServer();
  server.put(remote({ status: 'sent', next_nag_at: 9_000_000, nag_count: 1 }));
  const { store, sync } = setup({ server });
  await sync.link('olga', KEY);

  const [reminder] = store.reminders;
  assert.equal(reminder.status, 'fired');
  assert.equal(reminder.remoteFired, true);
  assert.equal(reminder.nagCount, 1);
  // What we hold is what the server holds: nothing to push back, and in
  // particular no locally invented repeat time written over the other bot's.
  await sync.syncPeer('olga');
  assert.deepEqual(server.requests.at(-1).body.changes, []);
  assert.equal(server.rows.get('bot-1').next_nag_at, 9_000_000);
});

test('answering a delivered reminder pushes done', async () => {
  const server = fakeServer();
  server.put(remote({ status: 'sent', next_nag_at: 9_000_000 }));
  const { store, sync, clock } = setup({ server });
  await sync.link('olga', KEY);

  const [reminder] = store.reminders;
  reminder.ackedAt = 1_700_000;
  reminder.status = 'done';
  clock.t = 2_000_000;
  await sync.syncPeer('olga');

  assert.equal(server.rows.get('bot-1').status, 'done');
  assert.equal(server.rows.get('bot-1').next_nag_at, null);
});

test('a reminder this bot delivered is sent with its next repeat time', async () => {
  const fired = local({ status: 'fired', firedAt: 3_000_000, lastNagAt: 3_000_000, nagCount: 0 });
  const { sync, server, clock } = setup({ reminders: [fired] });
  await sync.link('olga', KEY);

  const row = server.rows.get('tc-abc-1');
  assert.equal(row.status, 'sent');
  assert.equal(row.next_nag_at, 3_000_000 + cadence.nagMs);

  fired.nagCount = 2;
  fired.lastNagAt = 3_900_000;
  clock.t += 10;
  await sync.syncPeer('olga');
  assert.equal(server.rows.get('tc-abc-1').next_nag_at, 3_900_000 + cadence.dayMs);
});

test('text longer than the server accepts is cut instead of failing the whole batch', async () => {
  const { sync, server } = setup({
    reminders: [local({ text: 'я'.repeat(5000) }), local({ id: 'abc-2', text: 'ok' })],
  });

  await sync.link('olga', KEY);

  assert.equal(server.rows.get('tc-abc-1').text.length, 4096);
  assert.equal(server.rows.get('tc-abc-2').text, 'ok');
});

test('a push is split at the server limit and the rest follows', async () => {
  const many = Array.from({ length: MAX_CHANGES + 20 }, (_, i) => local({ id: `r${i}`, text: `t${i}` }));
  const { sync, server } = setup({ reminders: many });

  await sync.link('olga', KEY);

  assert.equal(server.rows.size, MAX_CHANGES + 20);
  assert.ok(server.requests.every((request) => request.body.changes.length <= MAX_CHANGES));
});

test('unlinking keeps reminders, forgets the key, and drops deletions nobody can carry any more', async () => {
  const { store, sync } = setup({ reminders: [local(), local({ id: 'abc-2', status: 'cancelled' })] });
  await sync.link('olga', KEY);

  assert.equal(sync.unlink('olga'), true);

  assert.equal(sync.isLinked('olga'), false);
  assert.deepEqual(store.reminders.map((reminder) => reminder.id), ['abc-1']);
  assert.equal(sync.unlink('olga'), false);
});

test('two chats link to two vaults without seeing each other', async () => {
  const other = 'rmk_' + 'b'.repeat(32);
  const server = fakeServer({ linked: [KEY, other] });
  const { store, sync } = setup({
    server,
    reminders: [local(), local({ id: 'x-1', ownerId: 'ivan', text: 'ivan only' })],
  });

  await sync.link('olga', KEY);
  await sync.link('ivan', other);

  assert.deepEqual(server.requests[0].body.changes.map((change) => change.text), ['позвонить маме']);
  assert.deepEqual(server.requests[1].body.changes.map((change) => change.text), ['ivan only']);
  assert.equal(store.users.ivan.sync.key, other);
});
