import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/web-roster-pin.test.js
// pulls the roster helpers out: app.js is a bundler-less browser script with no
// module boundary to import from.
function loadRosterBuilders() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const parts = {
    buildRosterPreview: source.match(/function buildRosterPreview\(user\) \{[\s\S]*?\n\}/),
    buildRosterMeta: source.match(/function buildRosterMeta\(user, withTime\) \{[\s\S]*?\n\}/),
    rosterPreviewOf: source.match(/function rosterPreviewOf\(user\) \{[\s\S]*?\n\}/),
    previewMediaLabel: source.match(/function previewMediaLabel\(media\) \{[\s\S]*?\n\}/),
    collapseForPreview: source.match(/function collapseForPreview\(text\) \{[\s\S]*?\n\}/),
    // The roster's mark is drawn by the transcript's own ladder (`setMark`), so
    // this harness needs it too: the two must not be able to disagree about what
    // ✓✓ means.
    setMark: source.match(/function setMark\(mark, state, readAt = 0, readVia = ''\) \{[\s\S]*?\n\}/),
    markCommitted: source.match(/function markCommitted\(mark\) \{[\s\S]*?\n\}/),
    pendingFor: source.match(/function pendingFor\(peer\) \{[\s\S]*?\n\}/),
  };
  for (const [name, match] of Object.entries(parts)) {
    assert.ok(match, `${name} exists in web/cloud/app.js`);
  }

  // The smallest DOM the functions touch: elements that remember their
  // children in order, so the assertion can be about order rather than about
  // which class name was painted where.
  const createElement = (tag) => ({
    tag,
    className: '',
    dataset: {},
    textContent: '',
    children: [],
    append(...nodes) { for (const node of nodes) this.children.push(node); },
  });

  const context = {
    document: {
      createElement,
      createTextNode: (text) => ({ tag: '#text', text: String(text) }),
    },
    threads: new Map(),
    pendingSends: new Map(),
    self: { login: 'me', name: 'Me' },
    // The clock label has its own test (test/web-roster-time.test.js).
    rosterTimeLabel: () => '12:40',
    // Emoji drawing has its own tests; these receipt-layout fixtures are text.
    appendEmojiText: (element, text) => { element.textContent = text; },
    t: (key) => (key === 'previewYou' ? 'You' : key),
  };
  vm.createContext(context);
  vm.runInContext(
    [
      parts.setMark[0],
      parts.markCommitted[0],
      parts.pendingFor[0],
      parts.rosterPreviewOf[0],
      parts.previewMediaLabel[0],
      parts.collapseForPreview[0],
      parts.buildRosterPreview[0],
      parts.buildRosterMeta[0],
      'globalThis.buildRosterPreview = buildRosterPreview;',
      'globalThis.buildRosterMeta = buildRosterMeta;',
    ].join('\n'),
    context,
  );
  return context;
}

function ownMessage({ read = false, delivered = false, markState = null, pending = false, withTime = true } = {}) {
  const ctx = loadRosterBuilders();
  const ts = 1_700_000_000_000;
  const user = { login: 'pear', name: 'Pear', last: { id: 'm1', ts, text: 'a short reply', from: 'me', kind: 'msg' } };
  const marks = new Map();
  if (markState) marks.set('m1', { dataset: { state: markState, ts: String(ts) } });
  if (pending) ctx.pendingSends.set('pear', [{ id: 'm1', ts, text: 'a short reply' }]);
  ctx.threads.set('pear', {
    lastMessage: null,
    marks,
    peerReadTs: read ? ts : 0,
    peerDeliveredTs: delivered ? ts : 0,
  });
  return { line: ctx.buildRosterPreview(user), meta: ctx.buildRosterMeta(user, withTime) };
}

test('the delivery mark sits in the top-right corner, left of the time (issue #25)', () => {
  const { line, meta } = ownMessage();
  // The preview line is only «You:» and the text: a mark at its tail moved
  // with the length of the text (owner, 2026-10-27).
  assert.deepEqual(line.children.map((child) => child.className), ['roster-preview-author', 'roster-preview-text']);
  assert.equal(line.children.at(-1).textContent, 'a short reply');
  // `✓ 12:40`: the mark first, then the time, in one fixed column.
  assert.equal(meta.className, 'roster-meta');
  assert.deepEqual(meta.children.map((child) => child.className), ['roster-mark', 'roster-time']);
  const [mark, time] = meta.children;
  assert.equal(mark.textContent, '✓');
  assert.equal(mark.dataset.state, 'sent');
  assert.equal(time.tag, 'time');
  assert.equal(time.textContent, '12:40');
});

test('a row without a time keeps the mark in the same corner', () => {
  const { meta } = ownMessage({ read: true, withTime: false });
  assert.deepEqual(meta.children.map((child) => child.className), ['roster-mark']);
  assert.equal(meta.children[0].dataset.state, 'read');
  assert.equal(meta.children[0].textContent, '✓✓');
});

test('a peer\'s last message has a time and no mark', () => {
  const ctx = loadRosterBuilders();
  const user = { login: 'pear', name: 'Pear', last: { id: 'm2', ts: 1_700_000_000_000, text: 'hi', from: 'pear', kind: 'msg' } };
  assert.deepEqual(ctx.buildRosterMeta(user, true).children.map((child) => child.className), ['roster-time']);
  assert.equal(ctx.buildRosterMeta(user, false), null, 'nothing to draw: no corner element at all');
});

test('an AI answer attributed to the own account still has no delivery mark', () => {
  const ctx = loadRosterBuilders();
  const user = { login: 'pear', last: { ts: 1_700_000_000_000, from: 'me', kind: 'ai', author: 'tailik', text: 'answer' } };
  assert.deepEqual(ctx.buildRosterMeta(user, true).children.map((child) => child.className), ['roster-time']);
  assert.equal(ctx.buildRosterMeta(user, false), null);
  assert.equal(ctx.buildRosterPreview(user).children[0].textContent, 'tailik:');
});

test('an own message without a timestamp still has a corner mark', () => {
  const ctx = loadRosterBuilders();
  const user = { login: 'pear', last: { ts: 0, from: 'me', kind: 'msg', text: 'reply' } };
  const meta = ctx.buildRosterMeta(user, true);
  assert.deepEqual(meta.children.map((child) => child.className), ['roster-mark']);
  assert.equal(meta.children[0].dataset.state, 'sent');
});

// The roster draws the same two ✓ rungs the conversation does, from the same two
// watermarks: a message the peer's device holds is ✓✓ in the line's neutral
// grey, and the read watermark — the rung above it — keeps the accent when both
// cover the message.
test('a delivered watermark paints the doubled mark without the read accent', () => {
  const mark = ownMessage({ delivered: true }).meta.children[0];
  assert.equal(mark.dataset.state, 'ack', 'a delivery is not a read');
  assert.equal(mark.textContent, '✓✓');
  assert.equal(mark.dataset.readAt, undefined, 'and there is no read time to name');

  const readMark = ownMessage({ read: true, delivered: true }).meta.children[0];
  assert.equal(readMark.dataset.state, 'read', 'the read watermark wins when both cover the message');
  assert.equal(readMark.textContent, '✓✓');
});

// A preview the server never committed keeps the bubble's own state: the
// watermarks are times, and an unsent message can sit below them — the FAILME
// case, where a later message was read while an earlier one never left.
test('an uncommitted message keeps ⧗ or ⚠ however far the watermarks reach', () => {
  const queued = ownMessage({ read: true, delivered: true, markState: 'queued' }).meta.children[0];
  assert.equal(queued.dataset.state, 'queued');
  assert.equal(queued.textContent, '⧗');

  const failed = ownMessage({ read: true, delivered: true, markState: 'failed' }).meta.children[0];
  assert.equal(failed.dataset.state, 'failed');
  assert.equal(failed.textContent, '⚠');

  // No bubble on screen (a thread never opened): the durable queue says it.
  const pendingOnly = ownMessage({ delivered: true, pending: true }).meta.children[0];
  assert.equal(pendingOnly.dataset.state, 'queued');

  // Once committed, the watermarks apply again.
  const committed = ownMessage({ delivered: true, markState: 'sent' }).meta.children[0];
  assert.equal(committed.dataset.state, 'ack');
});
