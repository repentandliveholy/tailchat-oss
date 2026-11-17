import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecureStore } from '../src/secure-store.js';
import {
  parseReminderTime,
  formatReminderRemaining,
  formatClockTime,
  createReminderEngine,
} from '../src/reminders.js';

test('parseReminderTime parses relative durations in English and compact formats', () => {
  const base = 1_700_000_000_000; // fixed epoch
  const r1 = parseReminderTime('10s check logs', base);
  assert.ok(r1);
  assert.equal(r1.delayMs, 10_000);
  assert.equal(r1.dueTs, base + 10_000);
  assert.equal(r1.text, 'check logs');

  const r2 = parseReminderTime('5m check oven', base);
  assert.ok(r2);
  assert.equal(r2.delayMs, 5 * 60 * 1000);
  assert.equal(r2.text, 'check oven');

  const r3 = parseReminderTime('1h30m team meeting', base);
  assert.ok(r3);
  assert.equal(r3.delayMs, (60 + 30) * 60 * 1000);
  assert.equal(r3.text, 'team meeting');

  const r4 = parseReminderTime('in 2 hours call Alice', base);
  assert.ok(r4);
  assert.equal(r4.delayMs, 2 * 3600 * 1000);
  assert.equal(r4.text, 'call Alice');
});

test('parseReminderTime parses Russian relative phrases and units', () => {
  const base = 1_700_000_000_000;
  const r1 = parseReminderTime('через 15 минут проверить бэкап', base);
  assert.ok(r1);
  assert.equal(r1.delayMs, 15 * 60 * 1000);
  assert.equal(r1.text, 'проверить бэкап');

  const r2 = parseReminderTime('2 часа 30 минут созвон', base);
  assert.ok(r2);
  assert.equal(r2.delayMs, (2 * 3600 + 30 * 60) * 1000);
  assert.equal(r2.text, 'созвон');

  const r3 = parseReminderTime('через 30 сек перезагрузка', base);
  assert.ok(r3);
  assert.equal(r3.delayMs, 30 * 1000);
  assert.equal(r3.text, 'перезагрузка');
});

test('parseReminderTime parses absolute time specifications', () => {
  const fixedNow = new Date('2026-08-29T12:00:00.000Z').getTime();
  const r1 = parseReminderTime('18:30 dinner', fixedNow);
  assert.ok(r1);
  assert.equal(r1.text, 'dinner');
  const d1 = new Date(r1.dueTs);
  assert.equal(d1.getHours(), 18);
  assert.equal(d1.getMinutes(), 30);

  const r2 = parseReminderTime('tomorrow 10:00 sync', fixedNow);
  assert.ok(r2);
  assert.equal(r2.text, 'sync');
  const d2 = new Date(r2.dueTs);
  assert.equal(d2.getHours(), 10);
  assert.equal(d2.getMinutes(), 0);
  assert.ok(r2.dueTs > fixedNow + 12 * 3600 * 1000);
});

test('formatClockTime formats timestamp to HH:MM', () => {
  const fixed = new Date('2026-08-29T14:05:00.000').getTime();
  assert.equal(formatClockTime(fixed), '14:05');
});

test('parseReminderTime returns null for invalid input', () => {
  assert.equal(parseReminderTime(''), null);
  assert.equal(parseReminderTime('hello world'), null);
  assert.equal(parseReminderTime('bad 999999'), null);
});
test('formatReminderRemaining formats intervals accurately', () => {
  assert.equal(formatReminderRemaining(5000), '5s');
  assert.equal(formatReminderRemaining(65000), '1m 5s');
  assert.equal(formatReminderRemaining(120000), '2m');
  assert.equal(formatReminderRemaining(3600000), '1h');
  assert.equal(formatReminderRemaining(3660000), '1h 1m');
  assert.equal(formatReminderRemaining(86400000), '1d');
});

test('createReminderEngine adds, persists, lists, triggers, and cancels reminders', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reminders-test-'));
  try {
    const store = createSecureStore(crypto.randomBytes(32));
    let triggered = null;
    let mockTime = 1_000_000;

    const engine = createReminderEngine({
      stateDir: tmpDir,
      store,
      onTrigger: (rem) => { triggered = rem; },
      now: () => mockTime,
    });

    const rem1 = engine.add({
      text: 'Water plants',
      dueTs: mockTime + 5000,
      targetUser: 'alice',
    });

    assert.ok(rem1.id.startsWith('rem_'));
    assert.equal(rem1.text, 'Water plants');

    const list = engine.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, rem1.id);
    assert.equal(list[0].remainingMs, 5000);

    // Check persistence to disk
    const savedFile = path.join(tmpDir, 'reminders.json');
    assert.equal(fs.existsSync(savedFile), false);
    assert.equal(fs.readFileSync(store.fileFor(savedFile), 'utf8').includes('Water plants'), false);
    const savedContent = JSON.parse(store.read(savedFile).toString('utf8'));
    assert.equal(savedContent[0].id, rem1.id);

    // Cancel test
    const rem2 = engine.add({
      text: 'Temporary',
      dueTs: mockTime + 10000,
      targetUser: 'alice',
    });
    assert.equal(engine.list().length, 2);
    const cancelled = engine.cancel(rem2.id);
    assert.equal(cancelled, true);
    assert.equal(engine.list().length, 1);

    // Trigger test: advance mock time
    mockTime += 6000;
    // Re-create engine from disk to simulate trigger / restart
    const engine2 = createReminderEngine({
      stateDir: tmpDir,
      store,
      onTrigger: (rem) => { triggered = rem; },
      now: () => mockTime,
    });

    assert.ok(triggered);
    assert.equal(triggered.id, rem1.id);
    assert.equal(triggered.text, 'Water plants');
    assert.equal(engine2.list().length, 0);

    engine.destroy();
    engine2.destroy();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createReminderEngine triggers immediately on startup for pre-expired reminders', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-expired-rem-test-'));
  try {
    const store = createSecureStore(crypto.randomBytes(32));
    const preExpired = [{
      id: 'rem_expired1',
      text: 'Pre-expired task',
      targetUser: 'alice',
      dueTs: 1000,
      createdTs: 500,
    }];
    store.write(path.join(tmpDir, 'reminders.json'), Buffer.from(JSON.stringify(preExpired)));

    let triggered = null;
    const engine = createReminderEngine({
      stateDir: tmpDir,
      store,
      onTrigger: (rem) => { triggered = rem; },
      now: () => 5000, // now is past dueTs
    });

    assert.ok(triggered, 'pre-expired reminder should trigger immediately on startup');
    assert.equal(triggered.id, 'rem_expired1');
    assert.equal(triggered.text, 'Pre-expired task');
    assert.equal(engine.list().length, 0);

    engine.destroy();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
