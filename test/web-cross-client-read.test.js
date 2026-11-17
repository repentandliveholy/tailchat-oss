import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Two halves of «сообщения, отправленные с телефона, остаются непрочитанными
// в вебе, пока их не откроешь в приложении»:
//
//  * a message this tab sent from another device of the same account keeps a
//    single ✓ because the peer's `read` frame only reaches a session
//    subscribed to that conversation — `/api/history`'s `peerReadTs` was
//    already saying ✓✓, and `populateHistory` ignored it for rows it had
//    drawn before;
//  * a roster badge whose frames this tab never saw (it arrived as
//    `conversation-update`/`unread`/`pending`) has no message id to receipt,
//    so `clearUnread` sent nothing at all and the server handed the same
//    count straight back on the next roster pass.
//
// Extracted from web/cloud/app.js the same way test/web-unread-watermark.test.js
// does: app.js is a bundler-less browser script with no module boundary.
function source() {
  return fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
}

function extract(name, pattern) {
  const match = source().match(pattern);
  assert.ok(match, `${name} exists in web/cloud/app.js`);
  return match[0];
}

// Every watermark pass skips marks the server never committed (`markCommitted`)
// and a mark that becomes committed catches up with them (`settleCommittedMark`).
function committedHelpers() {
  return [
    extract('markCommitted', /function markCommitted\(mark\) \{[\s\S]*?\n\}/),
    extract('settleCommittedMark', /function settleCommittedMark\(thread, mark\) \{[\s\S]*?\n\}/),
  ].join('\n');
}

function loadHistoryPainter() {
  const populate = extract('populateHistory', /function populateHistory\(thread, messages, peerReadTs = 0, peerReadAt = 0, peerReadVia = '', peerDeliveredTs = 0\) \{[\s\S]*?\n\}/);
  const setMark = extract('setMark', /function setMark\(mark, state, readAt = 0, readVia = ''\) \{[\s\S]*?\n\}/);
  // The delivered watermark is applied by the painter itself, before the read
  // pass (see the function): extracted here so the two rungs of one reload are
  // checked as they are written, not as a copy of them.
  const deliveredWatermark = extract(
    'applyPeerDeliveredWatermark',
    /function applyPeerDeliveredWatermark\(thread, deliveredTs\) \{[\s\S]*?\n\}/,
  );
  // The menu's own line is derived here from the row's mark, so the two halves
  // — what `populateHistory` writes onto the mark and what `messageMenuDetails`
  // reads back — are checked against each other rather than in isolation.
  const readViaLabel = extract('readViaLabel', /function readViaLabel\(via\) \{[\s\S]*?\n\}/);
  const menuDetails = extract('messageMenuDetails', /function messageMenuDetails\(\{ own, readAt = 0, editedAt = 0, readVia = '' \}\) \{[\s\S]*?\n\}/);
  // The reminder mark is thread state applied as a row is drawn
  // (`thread.reminded`), so the painter reads it — the same way it reads
  // `thread.marks` above.
  const markRemindedIfPending = extract(
    'markMessageRemindedIfPending',
    /function markMessageRemindedIfPending\(thread, row, id\) \{[\s\S]*?\n\}/,
  );
  const markReminded = extract('markMessageReminded', /function markMessageReminded\(row\) \{[\s\S]*?\n\}/);
  // Every attachment in a history page goes through `mediaSource` (inline or
  // a `/api/media` reference) before a row is drawn.
  const isMediaRef = extract('isMediaRef', /function isMediaRef\(media\) \{[\s\S]*?\n\}/);
  const mediaSource = extract('mediaSource', /function mediaSource\(peer, id, media, slot\) \{[\s\S]*?\n\}/);
  // A history page passes through here first; with the core off it is the
  // page unchanged.
  const decryptHistory = extract('decryptHistoryPage', /function decryptHistoryPage\(peer, messages\) \{[\s\S]*?\n\}/);

  const appended = [];
  const forgotten = [];
  const repaints = { roster: 0 };
  const context = {
    self: { login: 'olga', name: 'Olga' },
    CSS: { escape: (value) => value },
    structuredClone: (value) => JSON.parse(JSON.stringify(value ?? null)),
    requestAnimationFrame: () => {},
    // Both watermarks repaint the roster when they move, and both are moved by
    // one of these tests.
    scheduleRosterRender: () => { repaints.roster += 1; },
    t: (key, ...args) => (args.length > 0 ? `${key}:${args.join('|')}` : key),
    messageEventTime: (value) => `at-${value}`,
    appendMessage: (thread, row) => appended.push(row),
    appendVoiceMessage: (thread, row) => appended.push(row),
    tombstoneMessage: () => {},
    updateMessageText: () => {},
    markMessageEdited: () => {},
    renderReactionButtons: () => {},
    normalizeDateDividers: () => {},
    paintReactionEvents: () => {},
    flushReactionReads: () => {},
    displayName: (login) => login,
    // The durable send queue's two touch points inside `populateHistory`: a
    // message the server returned has been accepted, so its queue entry is over
    // (`forgetPendingSend`) and any entry still unanswered is drawn as a row of
    // its own (`ensurePendingRows`, which this test has nothing pending for).
    forgetPendingSend: (peer, id) => forgotten.push({ peer, id }),
    pendingFor: () => [],
    ensurePendingRows: () => {},
    // `populateHistory` ends by repainting the bot-actions bar — its own
    // derivation is covered by test/web-bot-actions.test.js. `activePeer` is
    // named because the branch reads it: an undeclared identifier in a VM
    // context throws rather than reading as undefined.
    activePeer: 'roman',
    renderBotActions: () => {},
    coreSession: null,
  };
  vm.createContext(context);
  vm.runInContext([
    setMark, committedHelpers(), deliveredWatermark, isMediaRef, mediaSource, decryptHistory, populate, markRemindedIfPending, markReminded, readViaLabel, menuDetails,
    'globalThis.populateHistory = populateHistory;',
    'globalThis.messageMenuDetails = messageMenuDetails;',
  ].join('\n'), context);
  return { context, appended, forgotten, repaints };
}

function makeMark(state = 'ack') {
  return { dataset: { state }, textContent: state === 'read' ? '✓✓' : '✓' };
}

function makeThread(rows) {
  const marks = new Map();
  const nodes = new Map();
  for (const [id, mark] of Object.entries(rows)) {
    marks.set(id, mark);
    nodes.set(id, { dataset: { id } });
  }
  return {
    peer: 'roman',
    oldestTs: null,
    oldestId: null,
    lastDay: null,
    marks,
    // Nothing pending on it in these tests — the record carries the set
    // because the real one does (`threadFor`).
    reminded: new Set(),
    node: {
      childNodes: [],
      querySelector: (selector) => {
        const id = selector.match(/data-id="(.*)"/)?.[1];
        return (id && nodes.get(id)) || null;
      },
    },
  };
}

test('history reconciliation lifts an already-drawn own message to ✓✓ from the server watermark', () => {
  const { context, appended } = loadHistoryPainter();
  const mark = makeMark();
  const thread = makeThread({ m1: mark });

  context.populateHistory(thread, [
    { id: 'm1', from: 'olga', text: 'отправлено с телефона', ts: 1000 },
  ], 2000, 2500);

  assert.equal(mark.dataset.state, 'read', 'the peer has read past this message');
  assert.equal(mark.textContent, '✓✓');
  assert.equal(mark.dataset.readAt, '2500', 'the menu can show the actual persisted read time');
  assert.equal(appended.length, 0, 'the row was already on screen, not redrawn');
});

test('a watermark older than the message leaves its single ✓ alone, and a peer message is never marked', () => {
  const { context } = loadHistoryPainter();
  const own = makeMark();
  const incoming = makeMark();
  const thread = makeThread({ m2: own, m3: incoming });

  context.populateHistory(thread, [
    { id: 'm2', from: 'olga', text: 'ещё не прочитано', ts: 3000 },
    { id: 'm3', from: 'roman', text: 'его сообщение', ts: 1000 },
  ], 2000);

  assert.equal(own.dataset.state, 'ack', 'nothing claims a read the peer has not made');
  assert.equal(incoming.dataset.state, 'ack', 'the peer watermark says nothing about their own message');
});
test('a delayed history page uses the newer live watermark for newly rendered older messages', () => {
  const { context, appended } = loadHistoryPainter();
  const thread = makeThread({});
  thread.peerReadTs = 5000;
  thread.peerReadAt = 6000;
  thread.peerReadVia = 'web';
  context.populateHistory(thread, [
    { id: 'older', from: 'olga', text: 'read before this history response arrived', ts: 4000 },
  ], 1000, 2000, 'cli');
  assert.equal(appended[0].read, true);
  assert.equal(appended[0].readAt, 6000);
  assert.equal(appended[0].readVia, 'web');
  assert.equal(thread.peerReadTs, 5000);
});

test('the client that read a conversation is carried onto the row and into the menu line', () => {
  const { context, appended } = loadHistoryPainter();
  const drawn = makeMark();
  const thread = makeThread({ m1: drawn });

  context.populateHistory(thread, [
    { id: 'm1', from: 'olga', text: 'прочитано в браузере', ts: 1000 },
  ], 2000, 2500, 'web');

  assert.equal(drawn.dataset.readVia, 'web', 'the mark remembers the client next to the time');
  assert.deepEqual(
    Array.from(context.messageMenuDetails({
      own: true, readAt: Number(drawn.dataset.readAt), readVia: drawn.dataset.readVia,
    })),
    ['msgReadAt:at-2500 · viaWeb'],
    'the menu names the client the history watermark recorded',
  );

  // A row drawn fresh by the same page carries it too, exactly as the server
  // sent it — the build suffix is stored, and only the menu drops it.
  context.populateHistory(makeThread({}), [
    { id: 'm2', from: 'olga', text: 'свежее', ts: 3000 },
  ], 4000, 4500, 'android/1234');
  assert.equal(appended.at(-1).readVia, 'android/1234', 'the mark is given the raw kind');
  assert.deepEqual(
    Array.from(context.messageMenuDetails({ own: true, readAt: 4500, readVia: 'android/1234' })),
    ['msgReadAt:at-4500 · viaAndroid'],
    'the menu says «телефон», not a build id',
  );
});

test('an unknown or missing client renders as the read time alone', () => {
  const { context } = loadHistoryPainter();
  const mark = makeMark();
  const thread = makeThread({ m1: mark });

  context.populateHistory(thread, [
    { id: 'm1', from: 'olga', text: 'без пометки', ts: 1000 },
  ], 2000, 2500);

  assert.equal(mark.dataset.readVia, undefined, 'nothing is invented when the server sent no client');
  assert.deepEqual(
    Array.from(context.messageMenuDetails({ own: true, readAt: 2500, readVia: '' })),
    ['msgReadAt:at-2500'],
    'the line is byte-for-byte what it was before a client could be named',
  );
  assert.deepEqual(
    Array.from(context.messageMenuDetails({ own: true, readAt: 2500, readVia: 'desktop' })),
    ['msgReadAt:at-2500'],
    'a kind this client does not know never becomes a guessed name',
  );
});

// The delivered rung as a reload sees it: `/api/history`'s `peerDeliveredTs` is
// the server's record of how far the peer's *device* holds the conversation,
// and it paints the same ✓✓ the live `ack` does — while the read watermark,
// applied after it, still turns the same mark green. A message their phone has
// received but not opened must stop looking like one their server never got,
// and a message they have read must not lose the accent to it.
test('history paints ✓✓ from the delivered watermark, and the read watermark over it', () => {
  const { context, repaints } = loadHistoryPainter();
  const queued = { dataset: { state: 'queued', ts: '1000' }, textContent: '⧗' };
  const middle = { dataset: { state: 'sent', ts: '2000' }, textContent: '✓' };
  const above = { dataset: { state: 'sent', ts: '3000' }, textContent: '✓' };
  const thread = makeThread({ m1: queued, m2: middle, m3: above });
  thread.peerReadTs = 0;
  thread.peerReadVia = '';
  thread.peerDeliveredTs = 0;

  context.populateHistory(thread, [], 0, 0, '', 2000);

  assert.equal(
    queued.dataset.state,
    'queued',
    'not in the server\'s answer: nothing says the server has it, so no watermark can reach it (FAILME)',
  );
  assert.equal(queued.textContent, '⧗');
  assert.equal(middle.dataset.state, 'ack', 'the watermark covers everything at or below it');
  assert.equal(middle.textContent, '✓✓');
  assert.equal(above.dataset.state, 'sent', 'past the watermark: still ✓, never an invented delivery');
  assert.equal(above.textContent, '✓');
  assert.equal(thread.peerDeliveredTs, 2000, 'the thread keeps the watermark the roster preview reads');

  // The next page does carry it: the server committed it, and the delivered
  // watermark it was too early for applies at once.
  context.populateHistory(thread, [
    { id: 'm1', from: 'olga', text: 'на телефоне', ts: 1000 },
  ], 0, 0, '', 2000);
  assert.equal(queued.dataset.state, 'ack', 'the server returned it, so it is committed and on their device');
  assert.equal(queued.textContent, '✓✓');

  context.populateHistory(thread, [
    { id: 'm1', from: 'olga', text: 'на телефоне', ts: 1000 },
    { id: 'm2', from: 'olga', text: 'прочитано', ts: 2000 },
  ], 2500, 4000, 'web', 2000);

  assert.equal(queued.dataset.state, 'read', 'a read is higher than a delivery over the same run');
  assert.equal(queued.textContent, '✓✓');
  assert.equal(queued.dataset.readAt, '4000');
  assert.equal(queued.dataset.readVia, 'web');
  assert.equal(above.dataset.state, 'sent', 'and still nothing above either watermark');
  assert.ok(repaints.roster >= 2, 'both watermarks repaint the roster when they move');
});

test('a reloaded transcript draws the delivered rung on the rows it builds', () => {
  const { context, appended } = loadHistoryPainter();
  const thread = makeThread({});
  thread.peerReadTs = 0;
  thread.peerReadVia = '';
  thread.peerDeliveredTs = 0;

  context.populateHistory(thread, [
    { id: 'n1', from: 'olga', text: 'на телефоне', ts: 1000 },
    { id: 'n2', from: 'olga', text: 'уже прочитано', ts: 2000 },
    { id: 'n3', from: 'olga', text: 'ещё в пути', ts: 3000 },
    { id: 'n4', from: 'roman', text: 'его сообщение', ts: 3000 },
  ], 2000, 4000, 'web', 2000);

  assert.deepEqual(
    appended.map((row) => [row.delivered, row.read]),
    [[true, true], [true, true], [false, false], [false, false]],
    'two rungs from two watermarks, and nothing claimed for the peer’s own message',
  );
  assert.equal(appended[0].readVia, 'web', 'the read rung still names the client that moved it');
  assert.equal(appended[2].readAt, 0, 'a message past both watermarks carries no read time');
});

// `clearUnread` (the explicit «open this conversation» path) now hands its
// receipt to the same queue the flush path uses, so this harness owns that
// queue too: the bindings, the pump and the settle step are the real ones, and
// only the socket and the DOM are stubbed.
function loadClearUnread() {
  const clearUnread = extract('clearUnread', /function clearUnread\(peer\) \{[\s\S]*?\n\}/);
  const newestUnreadId = extract('newestUnreadId', /function newestUnreadId\(thread\) \{[\s\S]*?\n\}/);
  const pump = extract('pumpReadReceipts', /function pumpReadReceipts\(\) \{[\s\S]*?\n\}/);
  const settle = extract('settleReadReceipt', /function settleReadReceipt\(entry\) \{[\s\S]*?\n\}/);
  const queue = extract('queueReadReceipts', /function queueReadReceipts\(peer, ids\) \{[\s\S]*?\n\}/);

  const sent = { frames: [], envelopes: [] };
  const threads = new Map();
  let deliverable = true;
  const timers = [];
  const cleared = [];
  const context = {
    threads,
    appIsForeground: () => true,
    messageIsOnScreen: () => true,
    serverCaps: new Set(),
    // A `false` here is a dropped frame — no socket, or a subscription that has
    // moved on — which is exactly the case the queue has to survive.
    sendFrame: (peer, frame) => {
      if (!deliverable) return false;
      sent.frames.push({ peer, frame });
      return true;
    },
    sendEnvelope: (payload) => sent.envelopes.push(payload),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { cleared.push(id); },
    clearUnreadDivider: () => {},
    renderRoster: () => {},
    updateAppUnreadBadge: () => {},
    renderInfoPanel: () => {},
  };
  vm.createContext(context);
  vm.runInContext([
    'const READ_RECEIPT_BURST = 15;',
    'const READ_RECEIPT_INTERVAL_MS = 400;',
    'const readReceiptQueue = [];',
    'let readReceiptTimer = null;',
    newestUnreadId, pump, settle, queue, clearUnread,
    'globalThis.queueReadReceipts = queueReadReceipts;',
    'globalThis.pumpReadReceipts = pumpReadReceipts;',
    'globalThis.clearUnread = clearUnread;',
    'globalThis.queuedReceipts = () => JSON.parse(JSON.stringify(readReceiptQueue));',
  ].join('\n'), context);
  // The payloads are built inside the vm realm, so their prototypes are not
  // this realm's: compare the data, not the identity of Object.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return {
    context,
    threads,
    sent,
    plain,
    timers,
    cleared,
    setDeliverable: (value) => { deliverable = value; },
    queued: () => plain(context.queuedReceipts()),
  };
}

test('opening an unread thread with no rendered messages does not mark the unseen server tail read', () => {
  const { context, threads, sent, plain } = loadClearUnread();
  threads.set('roman', { unreadIds: new Map(), unread: 4, node: { querySelectorAll: () => [] } });

  context.clearUnread('roman');

  assert.deepEqual(plain(sent.frames), []);
  assert.deepEqual(plain(sent.envelopes), []);
  assert.equal(threads.get('roman').unread, 4);
});

test('a thread with known unread ids still receipts the newest one, not the bulk watermark', () => {
  const { context, threads, sent, plain } = loadClearUnread();
  threads.set('roman', { unreadIds: new Map([['m1', 1000], ['m2', 2000]]), unread: 2 });

  context.clearUnread('roman');

  assert.deepEqual(plain(sent.frames), [{ peer: 'roman', frame: { t: 'read', id: 'm2' } }]);
  assert.deepEqual(plain(sent.envelopes), [], 'no bulk jump when a receipt says it exactly');
});

test('a thread with no unread at all sends nothing', () => {
  const { context, threads, sent, plain } = loadClearUnread();
  threads.set('roman', { unreadIds: new Map(), unread: 0 });

  context.clearUnread('roman');

  assert.deepEqual(plain(sent.frames), []);
  assert.deepEqual(plain(sent.envelopes), []);
});

// A read receipt the socket will not take used to be dropped on the floor while
// this tab had already emptied its own unread set — the peer's mark stayed on ✓
// forever and nothing would ever say otherwise. The queue is the record of what
// is still owed, so it holds the entry, holds the unread id with it, and the
// next pump is what retries it.
test('a receipt the socket refuses stays queued, and only leaves unreadIds when it goes out', () => {
  const h = loadClearUnread();
  h.threads.set('roman', { peer: 'roman', unreadIds: new Map([['m1', 1000], ['m2', 2000]]), unread: 2 });
  h.setDeliverable(false);

  h.context.queueReadReceipts('roman', ['m2']);

  assert.deepEqual(h.plain(h.sent.frames), [], 'a refused frame is not a receipt that was sent');
  assert.deepEqual(
    h.queued(),
    [{ peer: 'roman', id: 'm2', ts: 2000 }],
    'the queue owns the read, with the message’s own time, until the server takes it',
  );
  assert.deepEqual(
    [...h.threads.get('roman').unreadIds.keys()],
    ['m1', 'm2'],
    'the unread ids wait for the server too, not for the click that queued them',
  );
  assert.equal(h.threads.get('roman').unread, 2, 'and so does the badge');
  assert.equal(h.timers.length, 1, 'the interval stays armed while anything is left');
  assert.deepEqual(h.cleared, [], 'a failed pump does not disarm it');

  // The same read is offered again on the way back to the tab — focus and
  // visibilitychange both fire — and the id is still in `unreadIds`, so the queue
  // is what has to recognise it.
  h.context.queueReadReceipts('roman', ['m2']);
  assert.equal(h.queued().length, 1, 'one read, one receipt, however often it is offered');

  // The socket comes back; the armed interval (or the `subscribed` hook, which
  // calls the same function) is what retries the entry.
  h.setDeliverable(true);
  h.context.pumpReadReceipts();

  assert.deepEqual(h.plain(h.sent.frames), [{ peer: 'roman', frame: { t: 'read', id: 'm2' } }]);
  assert.deepEqual(h.queued(), [], 'taken at last, so the queue lets it go');
  assert.deepEqual(
    [...h.threads.get('roman').unreadIds.keys()],
    [],
    'the receipt is a watermark, so the older message below it is read too',
  );
  assert.equal(h.threads.get('roman').unread, 0);
  assert.equal(h.cleared.length, 1, 'nothing left, so the interval is disarmed');
});

test('an explicit clear whose receipt cannot go out is retried instead of lost', () => {
  const h = loadClearUnread();
  h.threads.set('roman', { peer: 'roman', unreadIds: new Map([['m1', 1000]]), unread: 1 });
  h.setDeliverable(false);

  h.context.clearUnread('roman');

  assert.deepEqual(h.plain(h.sent.frames), []);
  assert.deepEqual(h.queued().map((entry) => entry.id), ['m1'], 'the read is still owed to the other side');
  assert.equal(h.threads.get('roman').unread, 1, 'the badge waits for a successful receipt');

  h.setDeliverable(true);
  h.context.pumpReadReceipts();

  assert.deepEqual(
    h.plain(h.sent.frames),
    [{ peer: 'roman', frame: { t: 'read', id: 'm1' } }],
    'the retry is the receipt the person’s click stood for',
  );
  assert.deepEqual(h.queued(), []);
});

// The live rung, as the frame carries it: an `ack` from the peer's device says
// it holds the message, not that anybody has read it — so it is ✓✓ and no
// colour — and the `read` that may follow is what turns the same mark green.
function loadReceiptApplier() {
  const setMark = extract('setMark', /function setMark\(mark, state, readAt = 0, readVia = ''\) \{[\s\S]*?\n\}/);
  const deliveredWatermark = extract(
    'applyPeerDeliveredWatermark',
    /function applyPeerDeliveredWatermark\(thread, deliveredTs\) \{[\s\S]*?\n\}/,
  );
  const applyReceipt = extract('applyReceipt', /function applyReceipt\(from, frame\) \{[\s\S]*?\n\}/);
  const readWatermark = extract('applyPeerReadWatermark', /function applyPeerReadWatermark\(peer, readTs, readAt = 0, readVia = ''\) \{[\s\S]*?\n\}/);
  const context = { threads: new Map(), scheduleRosterRender: () => {} };
  vm.createContext(context);
  vm.runInContext([
    setMark, committedHelpers(), deliveredWatermark, readWatermark, applyReceipt,
    'globalThis.applyReceipt = applyReceipt;',
  ].join('\n'), context);
  return context;
}
test('a live read watermark covers cached messages even when its named bubble is absent', () => {
  const context = loadReceiptApplier();
  const first = { dataset: { ts: '1000', state: 'sent' }, textContent: '✓' };
  const later = { dataset: { ts: '3000', state: 'sent' }, textContent: '✓' };
  const thread = { peer: 'roman', marks: new Map([['first', first], ['later', later]]), peerReadTs: 0 };
  context.threads.set('roman', thread);
  context.applyReceipt('roman', { t: 'read', id: 'not-loaded', readTs: 2000, readAt: 2100, via: 'web' });
  assert.equal(first.dataset.state, 'read');
  assert.equal(later.dataset.state, 'sent');
  assert.equal(thread.peerReadTs, 2000);
  context.applyReceipt('roman', { t: 'read', id: 'not-loaded', readTs: 1000, readAt: 1100, via: 'cli' });
  assert.equal(first.dataset.readVia, 'web');
  assert.equal(thread.peerReadTs, 2000);
});

// The FAILME case from the 2026-10-26 report: a later message was delivered and
// read while an earlier one never reached the server. A watermark is a time and
// the unsent row sits below it, but the peer cannot hold or have read a message
// the server never took — ⧗ and ⚠ stay what they are.
test('live watermarks never raise a queued or failed mark below them', () => {
  const context = loadReceiptApplier();
  const mark = (ts, state) => ({ dataset: { ts: String(ts), state }, textContent: '' });
  const queued = mark(1000, 'queued');
  const failed = mark(1100, 'failed');
  const sent = mark(2000, 'sent');
  const thread = {
    peer: 'roman',
    marks: new Map([['q', queued], ['f', failed], ['s', sent]]),
    peerReadTs: 0,
    peerReadVia: '',
    peerDeliveredTs: 0,
  };
  context.threads.set('roman', thread);

  context.applyReceipt('roman', { t: 'ack', id: 's', deliveredTs: 2000 });
  assert.equal(sent.dataset.state, 'ack');
  assert.equal(queued.dataset.state, 'queued', 'an ack watermark does not deliver an unsent message');
  assert.equal(failed.dataset.state, 'failed', 'nor one the queue gave up on');

  context.applyReceipt('roman', { t: 'read', id: 's', readTs: 2000, readAt: 2100, via: 'android/184' });
  assert.equal(sent.dataset.state, 'read');
  assert.equal(queued.dataset.state, 'queued', 'a read watermark does not read it either');
  assert.equal(failed.dataset.state, 'failed');

  // A read frame that names the queued message itself is proof the server had
  // it (the acceptance was only lost on the way back).
  context.applyReceipt('roman', { t: 'read', id: 'q' });
  assert.equal(queued.dataset.state, 'read');
});

test('a live ack paints ✓✓ from its delivered watermark, and a later read paints it green', () => {
  const context = loadReceiptApplier();
  const mark = (ts, state) => ({ dataset: { ts: String(ts), state }, textContent: '✓' });
  const first = mark(1000, 'sent');
  const second = mark(2000, 'sent');
  const above = mark(3000, 'sent');
  const thread = {
    peer: 'roman',
    marks: new Map([['m1', first], ['m2', second], ['m3', above]]),
    peerReadTs: 0,
    peerReadVia: '',
    peerDeliveredTs: 0,
  };
  context.threads.set('roman', thread);

  context.applyReceipt('roman', { t: 'ack', id: 'm1', deliveredTs: 2000 });

  assert.equal(first.dataset.state, 'ack', 'their device holds it');
  assert.equal(first.textContent, '✓✓');
  assert.equal(first.dataset.readAt, undefined, 'a delivery is not a read: no time, no accent');
  assert.equal(second.dataset.state, 'ack', 'the frame names one message but carries a watermark');
  assert.equal(second.textContent, '✓✓');
  assert.equal(above.dataset.state, 'sent', 'nothing above the watermark is touched');
  assert.equal(above.textContent, '✓');
  assert.equal(thread.peerDeliveredTs, 2000, 'the thread keeps it for the roster preview');

  context.applyReceipt('roman', { t: 'read', id: 'm2', readAt: 4000, via: 'web' });

  assert.equal(first.dataset.state, 'read', 'the read watermark is the higher rung over the same run');
  assert.equal(first.textContent, '✓✓');
  assert.equal(first.dataset.readAt, '4000');
  assert.equal(second.dataset.readVia, 'web');
  assert.equal(above.dataset.state, 'sent', 'still nothing above it');
  assert.equal(thread.peerReadTs, 2000);
  assert.equal(thread.peerDeliveredTs, 2000, 'reading implies delivery, and it is the same number');
});

// Privacy is about content, and a receipt carries none: a `read`/`ack` sent
// down an open data channel never reaches the server, which is where the
// watermark lives — the peer's *other* devices rebuild their marks from it, so a
// receipt that skips the relay leaves a phone and a laptop showing ✓ forever
// while the device that read the message sits next to them.
test('receipts ride the relay even while a direct channel is open', () => {
  const sendFrame = extract('sendFrame', /function sendFrame\(to, frame\) \{[\s\S]*?\n\}/);
  const relayOnly = extract('RELAY_ONLY_FRAMES', /^const RELAY_ONLY_FRAMES = new Set\(\[[^\]]*\]\);/m);
  const direct = [];
  const envelopes = [];
  const context = {
    directLinks: new Map([['roman', { dc: { readyState: 'open', send: (json) => direct.push(json) } }]]),
    authed: true,
    subscribedPeer: 'roman',
    coreSession: null,
    sendEnvelope: (payload) => { envelopes.push(payload); return true; },
  };
  vm.createContext(context);
  vm.runInContext([
    relayOnly, sendFrame,
    'globalThis.sendFrame = sendFrame;',
  ].join('\n'), context);

  assert.equal(context.sendFrame('roman', { t: 'read', id: 'm1' }), true);
  assert.equal(context.sendFrame('roman', { t: 'ack', id: 'm1' }), true);
  assert.equal(context.sendFrame('roman', { t: 'msg', text: 'привет' }), true);
  assert.equal(context.sendFrame('roman', { t: 'rtc-offer', sdp: 'x' }), true);

  assert.deepEqual(direct, [JSON.stringify({ t: 'msg', text: 'привет' })], 'only content may skip the server');
  assert.deepEqual(
    envelopes.map((payload) => [payload.k, payload.to, payload.d.t]),
    [['frame', 'roman', 'read'], ['frame', 'roman', 'ack'], ['frame', 'roman', 'rtc-offer']],
    'the receipts go through the relay, where the watermark can be recorded',
  );
});

// A mark's client is the conversation's, not the bubble's: whoever reached the
// watermark read everything up to it, so the live frame, the feed and a reloaded
// `/api/history` page have to label the same mark the same way. Without that the
// same bubble reads «телефон» in one path and «браузер» after a refresh.
test('the peer-read watermark labels every read mark below it, and an unknown client clears it', () => {
  const setMark = extract('setMark', /function setMark\(mark, state, readAt = 0, readVia = ''\) \{[\s\S]*?\n\}/);
  const watermark = extract(
    'applyPeerReadWatermark',
    /function applyPeerReadWatermark\(peer, readTs, readAt = 0, readVia = ''\) \{[\s\S]*?\n\}/,
  );
  let repaints = 0;
  const context = { threads: new Map(), scheduleRosterRender: () => { repaints += 1; } };
  vm.createContext(context);
  vm.runInContext([
    setMark, committedHelpers(), watermark,
    'globalThis.applyPeerReadWatermark = applyPeerReadWatermark;',
  ].join('\n'), context);

  const mark = (ts, state = 'ack') => ({
    dataset: { ts: String(ts), state },
    textContent: state === 'read' ? '✓✓' : '✓',
  });
  const older = mark(1000, 'read');
  older.dataset.readVia = 'cli';
  const middle = mark(2000);
  const above = mark(3000);
  const thread = {
    peer: 'roman',
    marks: new Map([['a', older], ['b', middle], ['c', above]]),
    peerReadTs: 0,
    peerReadVia: '',
  };
  context.threads.set('roman', thread);

  context.applyPeerReadWatermark('roman', 2000, 9000, 'web');
  assert.equal(older.dataset.readVia, 'web', 'a mark already read takes the client that reached the watermark');
  assert.equal(older.dataset.readAt, '9000');
  assert.equal(middle.dataset.readVia, 'web', 'and so does the mark this event flips');
  assert.equal(above.dataset.readVia, undefined, 'nothing above the watermark is touched');
  assert.equal(thread.peerReadVia, 'web');

  context.applyPeerReadWatermark('roman', 3000, 9500, '');
  assert.equal(above.dataset.readVia, undefined, 'an event with no client claims none');
  assert.equal(thread.peerReadVia, '');
  assert.ok(repaints >= 1, 'the roster was repainted');
});
