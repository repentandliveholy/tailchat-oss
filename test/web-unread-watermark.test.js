import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
function loadReadState() {
  const thread = {
    peer: 'peer', unread: 2, readTs: 0,
    unreadIds: new Map([['old', 100], ['new', 200]]),
    reactionEvents: new Map(),
  };
  const frames = [];
  let now = 1000;
  const context = {
    threads: new Map([['peer', thread]]),
    threadFor: () => thread,
    users: [{ login: 'peer', pending: 2 }],
    serverCaps: new Set(['read-ack-v1']),
    Date: { now: () => now },
    sendFrame: (peer, frame) => { frames.push({ peer, ...frame }); return true; },
    sendEnvelope: () => true,
    clearInterval() {}, setInterval: () => 1,
    clearUnreadDivider() {}, paintReactionEvents() {},
    compareUsers: () => 0,
    renderRoster() {}, updateAppUnreadBadge() {}, renderInfoPanel() {},
  };
  const functions = ['queueReadReceipts', 'pumpReadReceipts', 'settleReadReceipt', 'applySyncedRead'].map((name) => {
    return source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
  });
  vm.createContext(context);
  vm.runInContext([
    'const READ_RECEIPT_BURST = 15; const READ_RECEIPT_INTERVAL_MS = 400;',
    'const readReceiptQueue = []; let readReceiptTimer = null;',
    ...functions,
    'globalThis.queueReadReceipts = queueReadReceipts;',
    'globalThis.pumpReadReceipts = pumpReadReceipts;',
    'globalThis.applySyncedRead = applySyncedRead;',
    'globalThis.queued = () => readReceiptQueue.map((entry) => entry.id);',
  ].join('\n'), context);
  return { context, thread, frames, advance: (ms) => { now += ms; } };
}

test('socket writes retain viewed messages until accepted, and missing acceptance retries the same receipt', () => {
  const h = loadReadState();
  h.context.queueReadReceipts('peer', ['new']);
  assert.deepEqual([...h.thread.unreadIds.keys()], ['old', 'new']);
  assert.equal(h.thread.unread, 2);
  h.context.pumpReadReceipts();
  assert.equal(h.frames.length, 1, 'a pending acknowledgement is not a receipt burst');
  h.advance(3000);
  h.context.pumpReadReceipts();
  assert.deepEqual(h.frames, [
    { peer: 'peer', t: 'read', id: 'new' },
    { peer: 'peer', t: 'read', id: 'new' },
  ]);
  h.context.applySyncedRead('peer', 200);
  assert.deepEqual([...h.thread.unreadIds], []);
  assert.equal(h.thread.unread, 0);
  assert.deepEqual(Array.from(h.context.queued()), []);
});

test('an older read-sync clears only its covered rows and cannot consume newer unread messages', () => {
  const h = loadReadState();
  h.context.queueReadReceipts('peer', ['new']);
  h.context.applySyncedRead('peer', 100);
  assert.deepEqual([...h.thread.unreadIds.keys()], ['new']);
  assert.equal(h.thread.unread, 1);
  assert.equal(h.context.users[0].pending, 1);
  assert.deepEqual(Array.from(h.context.queued()), ['new']);
  h.context.applySyncedRead('peer', 50);
  assert.equal(h.thread.readTs, 100);
  assert.deepEqual([...h.thread.unreadIds.keys()], ['new']);
});

test('unknown or zero read watermarks do not erase unread state', () => {
  const h = loadReadState();
  h.context.applySyncedRead('peer', 0);
  h.context.applySyncedRead('peer');
  assert.deepEqual([...h.thread.unreadIds.keys()], ['old', 'new']);
  assert.equal(h.thread.unread, 2);
});

test('horizontally clipped reactions stay unread until scrolled into view', () => {
  let left = 125;
  let accepted = false;
  const frames = [];
  const badge = {
    dataset: { emoji: '👍' },
    getBoundingClientRect: () => ({ top: 20, bottom: 38, height: 18, left, right: left + 30 }),
    closest: () => ({ getBoundingClientRect: () => ({ left: 10, right: 100 }) }),
  };
  const thread = {
    reactionEvents: new Map([['event-1', { messageId: 'm1', emoji: '👍' }]]),
    node: { querySelector: () => ({ querySelectorAll: () => [badge] }) },
  };
  const context = {
    activePeer: 'peer', authed: true, appIsForeground: () => true,
    wide: { matches: true },
    elements: { transcript: { getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 300 }) } },
    threads: new Map([['peer', thread]]),
    CSS: { escape: value => value },
    sendEnvelope(frame) { frames.push(frame); return accepted; },
    paintReactionEvents() {}, renderRoster() {}, updateAppUnreadBadge() {},
  };
  vm.createContext(context);
  vm.runInContext(source.match(/function flushReactionReads\([^]*?\n\}/)[0], context);
  context.flushReactionReads();
  assert.deepEqual(frames, []);
  assert.deepEqual([...thread.reactionEvents.keys()], ['event-1']);
  left = 80;
  context.flushReactionReads();
  assert.deepEqual(frames, [], 'a partially clipped chip is not yet read');
  left = 50;
  context.flushReactionReads();
  assert.deepEqual([...thread.reactionEvents.keys()], ['event-1'], 'a failed send retains the event');
  accepted = true;
  context.flushReactionReads();
  assert.deepEqual([...thread.reactionEvents.keys()], []);
  assert.deepEqual(JSON.parse(JSON.stringify(frames)), [
    { k: 'reaction-read', peer: 'peer', ids: ['event-1'] },
    { k: 'reaction-read', peer: 'peer', ids: ['event-1'] },
  ]);
});
