import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore as createLegacyStore } from '../src/cloud/accounts.js';

const createAccountStore = (options) => createLegacyStore({ allowPlaintextLegacy: true, keyFile: null, ...options });

test('accounts.history filters by since, before, and beforeId', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-test-history-'));
  const store = createAccountStore({ dir, writeDelayMs: 5000 });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const now = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  // Record messages over 5 days:
  // Day 5 ago: m1
  // Day 4 ago: m2
  // Day 2 ago: m3
  // Day 1 ago: m4
  // Today: m5
  store.recordHistory('anna', 'boris', { id: 'm1', from: 'anna', text: 'Day 5', ts: now - 5 * day });
  store.recordHistory('anna', 'boris', { id: 'm2', from: 'boris', text: 'Day 4', ts: now - 4 * day });
  store.recordHistory('anna', 'boris', { id: 'm3', from: 'anna', text: 'Day 2', ts: now - 2 * day });
  store.recordHistory('anna', 'boris', { id: 'm4', from: 'boris', text: 'Day 1', ts: now - 1 * day });
  store.recordHistory('anna', 'boris', { id: 'm5', from: 'anna', text: 'Today', ts: now });

  // 1. Default 3 days query: since = now - 3 * day
  const threeDaysAgo = now - 3 * day;
  const recent = store.history('anna', 'boris', 100, { since: threeDaysAgo });
  assert.deepEqual(recent.map((m) => m.id), ['m3', 'm4', 'm5'], 'returns only messages within last 3 days');

  // 2. Scroll up: load older messages before oldest seen (m3)
  const oldestSeen = recent[0];
  const older = store.history('anna', 'boris', 100, { before: oldestSeen.ts, beforeId: oldestSeen.id });
  assert.deepEqual(older.map((m) => m.id), ['m1', 'm2'], 'returns older messages before m3');

  // 3. Scroll up again: load older messages before m1
  const olderStill = store.history('anna', 'boris', 100, { before: older[0].ts, beforeId: older[0].id });
  assert.deepEqual(olderStill, [], 'returns empty array when start of history is reached');
});
