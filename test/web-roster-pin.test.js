import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/cloud-ping.test.js
// and test/web-forward.test.js check their pieces of it: app.js is a
// bundler-less browser script with no module boundary to import from.
function loadRosterHelpers({ storedPinned } = {}) {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const key = source.match(/const PINNED_KEY = 'tailchat-cloud-pinned';/);
  const load = source.match(/function loadPinnedPeers\(\) \{[\s\S]*?\n\}/);
  const pinnedInit = source.match(/const pinnedPeers = new Set\(loadPinnedPeers\(\)\);/);
  const save = source.match(/function savePinnedPeers\(\) \{[\s\S]*?\n\}/);
  const isPinnedFn = source.match(/function isPinned\(login\) \{[\s\S]*?\n\}/);
  const toggle = source.match(/function togglePin\(login\) \{[\s\S]*?\n\}/);
  const preview = source.match(/function rosterPreviewOf\(user\) \{[\s\S]*?\n\}/);
  const compare = source.match(/function compareUsers\(a, b\) \{[\s\S]*?\n\}/);
  const label = source.match(/function peerLabel\(user\) \{[\s\S]*?\n\}/);
  for (const [name, m] of [
    ['PINNED_KEY', key], ['loadPinnedPeers', load], ['pinnedPeers init', pinnedInit], ['savePinnedPeers', save],
    ['isPinned', isPinnedFn], ['togglePin', toggle], ['rosterPreviewOf', preview], ['compareUsers', compare],
    ['peerLabel', label],
  ]) assert.ok(m, `${name} exists in web/cloud/app.js`);

  const store = new Map(storedPinned ? [['tailchat-cloud-pinned', JSON.stringify(storedPinned)]] : []);
  const context = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
    threads: new Map(),
    renderRoster: () => {}, // togglePin's UI side effect, irrelevant here
  };
  vm.createContext(context);
  vm.runInContext(
    [
      key[0], load[0], pinnedInit[0], save[0], isPinnedFn[0], toggle[0], preview[0], label[0], compare[0],
      'globalThis.isPinned = isPinned;',
      'globalThis.togglePin = togglePin;',
      'globalThis.compareUsers = compareUsers;',
      'globalThis.pinnedPeers = pinnedPeers;',
    ].join('\n'),
    context,
  );
  return context;
}

test('a pinned chat sorts before every unpinned one, regardless of recency', () => {
  const ctx = loadRosterHelpers();
  ctx.togglePin('carl');
  const anna = { login: 'anna', name: 'Anna', last: { ts: 9000, text: 'just now' } };
  const carl = { login: 'carl', name: 'Carl', last: { ts: 1, text: 'ages ago' } };
  const ranked = [anna, carl].sort(ctx.compareUsers);
  assert.deepEqual(ranked.map((u) => u.login), ['carl', 'anna']);
});

test('two pinned chats still sort by recency between themselves', () => {
  const ctx = loadRosterHelpers();
  ctx.togglePin('anna');
  ctx.togglePin('boris');
  const anna = { login: 'anna', name: 'Anna', last: { ts: 100, text: 'old' } };
  const boris = { login: 'boris', name: 'Boris', last: { ts: 200, text: 'new' } };
  const ranked = [anna, boris].sort(ctx.compareUsers);
  assert.deepEqual(ranked.map((u) => u.login), ['boris', 'anna']);
});

test('blocked contacts sort after unblocked contacts', () => {
  const ctx = loadRosterHelpers();
  const anna = { login: 'anna', name: 'Anna', last: { ts: 100, text: 'old' }, blocked: true };
  const boris = { login: 'boris', name: 'Boris', last: { ts: 50, text: 'older' } };
  const ranked = [anna, boris].sort(ctx.compareUsers);
  assert.deepEqual(ranked.map((u) => u.login), ['boris', 'anna']);
});

test('nicknames decide the alphabetical tie-break, not the account names (issue #28)', () => {
  const ctx = loadRosterHelpers();
  // Equal recency, so the name is what orders them: by account name Anna comes
  // first. The nicknames this account gave them say the opposite, and the
  // roster paints the nicknames, so it has to sort by them.
  const anna = { login: 'anna', name: 'Anna', alias: 'Zed', last: { ts: 100, text: 'old' } };
  const boris = { login: 'boris', name: 'Boris', alias: 'Abe', last: { ts: 100, text: 'older' } };
  const ranked = [anna, boris].sort(ctx.compareUsers);
  assert.deepEqual(ranked.map((u) => u.login), ['boris', 'anna']);

  // Same two contacts with no nicknames keep the account-name order.
  const plain = [{ login: 'anna', name: 'Anna', last: { ts: 100 } }, { login: 'boris', name: 'Boris', last: { ts: 100 } }];
  assert.deepEqual(plain.sort(ctx.compareUsers).map((u) => u.login), ['anna', 'boris']);
});

test('togglePin flips membership and persists across a fresh load', () => {
  const ctx = loadRosterHelpers();
  assert.equal(ctx.isPinned('anna'), false);
  ctx.togglePin('anna');
  assert.equal(ctx.isPinned('anna'), true);

  const reloaded = loadRosterHelpers({ storedPinned: ['anna'] });
  assert.equal(reloaded.isPinned('anna'), true);
  assert.equal(reloaded.isPinned('boris'), false);

  ctx.togglePin('anna');
  assert.equal(ctx.isPinned('anna'), false);
});

test('a corrupt pinned-peers value in storage reads as no pins instead of crashing', () => {
  const ctx = loadRosterHelpers({ storedPinned: 'not-an-array' });
  assert.equal(ctx.isPinned('anna'), false);
  assert.equal(ctx.pinnedPeers.size, 0);
});
