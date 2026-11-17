import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The page's side of the sealed actions (E2): on the core a reply, a forward, a
// voice note, a picture and an edit go through `coreSession.sendWith`/`editText`
// — never an open frame, never the peer-to-peer channel — and the carrier an
// edit travels in is never drawn. app.js is a browser script with no module
// boundary, so each function is lifted from the source verbatim, as
// test/web-forward.test.js does, and run against stand-ins for the page.

const SOURCE = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function lift(name) {
  const start = SOURCE.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} exists in app.js`);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 3);
}

function page(names, globals = {}) {
  const context = {
    t: (key, arg) => (typeof arg === 'undefined' ? key : `${key}(${arg})`),
    CSS: { escape: (value) => value },
    Boolean, Number, Math, Date, Array, Set, Map, JSON, Promise, Object, setTimeout, Error, console,
    ...globals,
  };
  vm.createContext(context);
  vm.runInContext(`${names.map(lift).join('\n')}\n${names.map((n) => `globalThis.${n} = ${n};`).join('\n')}`, context);
  return context;
}

// A conversation thread as far as these functions look at it.
function thread(peer = 'bob') {
  const nodes = new Map();
  return {
    peer,
    loaded: true,
    seen: new Set(),
    marks: new Map(),
    nodes,
    node: { querySelector: (selector) => nodes.get(selector.match(/data-id="(.*)"/)?.[1]) ?? null },
  };
}

// The core session as the page holds it, recording the sealed calls.
function makeCore(accepts = true) {
  const session = {
    log: [],
    accepts,
    sendText: () => true,
    sendWith: (...args) => { session.log.push(['sendWith', ...args]); return session.accepts; },
    editText: (...args) => { session.log.push(['editText', ...args]); return session.accepts; },
    conversation: () => [],
  };
  return session;
}

// Values built inside the page's realm differ in prototype only; the shape is
// what is compared.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// --- carriers are not messages ------------------------------------------------

test('a row that carries an edit is never a message the page draws', () => {
  const ctx = page(['coreRowMessage']);
  const row = { source: 'sent', id: 'c', from: 'alice', ts: 5, text: 'new words', editOf: 'm-1' };
  assert.equal(ctx.coreRowMessage(row), null);
  assert.equal(ctx.coreRowMessage({ ...row, source: 'message' }), null);
  assert.equal(ctx.coreRowMessage({ ...row, source: 'pending' }), null);
  const plain = ctx.coreRowMessage({ ...row, editOf: undefined, id: 'm-1' });
  assert.equal(plain.id, 'm-1');
  assert.equal(plain.text, 'new words');
});

test('a history page drops the carriers, on the core and without it', () => {
  const records = [
    { id: 'm-1', text: 'hello', e2ee: { ct: 'x' } },
    { id: 'e-1', text: '🔒 stub', sealedEdit: true, e2ee: { ct: 'y' } },
    { id: 'm-2', text: 'plain' },
  ];
  // A page without the core: the stub plus the server's flag.
  const classic = page(['decryptHistoryPage'], { coreSession: null, coreSealedRows: new Set() });
  assert.deepEqual(plain(classic.decryptHistoryPage('bob', records).map((m) => m.id)), ['m-1', 'm-2']);
  assert.deepEqual(plain(classic.decryptHistoryPage('bob', [{ id: 'm-3' }]).map((m) => m.id)), ['m-3'], 'a page without any is untouched');
  // A core page: the target reads from the store (already edited there), the
  // carrier is gone.
  const withCore = page(['decryptHistoryPage', 'coreRowMessage'], {
    coreSealedRows: new Set(),
    coreSession: { conversation: () => [{ source: 'message', id: 'm-1', from: 'bob', ts: 1, text: 'edited text', editedAt: 9 }] },
  });
  const out = withCore.decryptHistoryPage('bob', records);
  assert.deepEqual(plain(out.map((m) => m.id)), ['m-1', 'm-2']);
  assert.equal(out[0].text, 'edited text');
  assert.equal(out[0].editedAt, 9, 'the target is marked edited');
});

test('an arriving carrier updates its target and draws nothing', async () => {
  const t1 = thread();
  t1.nodes.set('m-1', { messageText: 'old words' });
  const updates = [];
  const frames = [];
  const rows = [
    { source: 'message', id: 'm-1', from: 'bob', ts: 1, text: 'new words', editedAt: 7 },
    { source: 'message', id: 'c-1', from: 'bob', ts: 8, text: 'new words', editOf: 'm-1' },
  ];
  const ctx = page(['paintCoreRow', 'coreRowMessage'], {
    coreSession: { conversation: () => rows },
    coreSealedRows: new Set(),
    threads: new Map([['bob', t1]]),
    updateMessageText: (...args) => updates.push(args),
    handleFrame: (...args) => frames.push(args),
    self: { login: 'alice' },
  });
  ctx.paintCoreRow('bob', 'c-1');
  await settle();
  assert.deepEqual(plain(updates), [['bob', 'm-1', 'new words', 7]], 'the target takes the store\'s text, marked edited');
  assert.deepEqual(frames, [], 'the carrier is not drawn as a new message');

  // An author's own edit is drawn when typed: the store then says the same words.
  t1.nodes.set('m-1', { messageText: 'new words' });
  ctx.paintCoreRow('bob', 'c-1');
  await settle();
  assert.equal(updates.length, 1, 'nothing to repaint');

  // The carrier of a thread that is not loaded is left to the history pass.
  t1.loaded = false;
  t1.nodes.set('m-1', { messageText: 'stale' });
  ctx.paintCoreRow('bob', 'c-1');
  await settle();
  assert.equal(updates.length, 1);
});

test('a row drawn as "the key has not arrived" is drawn again, whole, when the core opens it', async () => {
  // A quote that arrives with a key that came late used to land as its words
  // alone: the reply without its quote, the voice note without its player.
  const old = { dataset: { side: 'peer', author: 'bob', id: 'm-1' }, removed: false, remove() { this.removed = true; } };
  const placed = [];
  const t1 = thread();
  t1.seen.add('m-1');
  const rows = [old];
  t1.node = {
    querySelector: () => old,
    get lastElementChild() { return rows.at(-1); },
    insertBefore: (fresh, before) => placed.push([fresh.name, before === old]),
  };
  const drawn = [];
  const opened = {
    source: 'message', id: 'm-1', from: 'bob', ts: 5, text: 'the answer',
    replyTo: { id: 'm-0', from: 'alice', text: 'the question' },
  };
  const ctx = page(['paintCoreRow', 'coreRowMessage', 'redrawOpenedRow'], {
    coreSession: { conversation: () => [opened] },
    coreSealedRows: new Set(['bob\nm-1']),
    threads: new Map([['bob', t1]]),
    mediaSource: (peer, id, value) => value ?? null,
    appendMessage: (th, message) => { drawn.push(['text', message]); rows.push({ name: 'fresh' }); },
    appendVoiceMessage: (th, message) => { drawn.push(['voice', message]); rows.push({ name: 'fresh' }); },
    normalizeDateDividers: () => {},
    updateMessageText: () => { throw new Error('the words alone are not enough'); },
    self: { login: 'alice' },
  });
  ctx.paintCoreRow('bob', 'm-1');
  await settle();
  assert.equal(drawn.length, 1);
  assert.deepEqual(plain(drawn[0][1].replyTo), { id: 'm-0', from: 'alice', text: 'the question' });
  assert.equal(drawn[0][1].author, 'bob');
  assert.equal(drawn[0][1].own, false);
  assert.deepEqual(plain(placed), [['fresh', true]], 'in the old row\'s place');
  assert.equal(old.removed, true);
  assert.equal(t1.seen.has('m-1'), false, 'the redraw is the one that marks it seen again (appendMessage does)');
});

test('a carrier\'s own `message-added` moves no mark', () => {
  const marks = [];
  const ctx = page(['onCoreEvent'], {
    applyCoreReceipt: (...args) => marks.push(args),
    paintCoreRow: () => {},
    settleCoreEdit: () => false,
  });
  ctx.onCoreEvent({ kind: 'message-added', peer: 'bob', id: 'c-1', ts: 1, editOf: 'm-1' });
  ctx.onCoreEvent({ kind: 'message-added', peer: 'bob', id: 'm-2', ts: 2 });
  assert.deepEqual(plain(marks), [['bob', 'm-2', 2, 'queued']]);
});

test('an unsent edit\'s carrier has no bubble after a reload; a pending reply keeps its quote', () => {
  const t1 = thread();
  const drawn = [];
  const ctx = page(['ensurePendingRows'], {
    coreSession: {
      conversation: () => [
        { source: 'pending', id: 'p-1', text: 'answer', ts: 1, replyTo: { id: 'm-0', from: 'bob', text: 'q' }, receipt: 'queued' },
        { source: 'pending', id: 'p-2', text: 'fixed', ts: 2, editOf: 'm-0', receipt: 'queued' },
      ],
    },
    pendingFor: () => [],
    appendMessage: (th, message) => { drawn.push(message); th.marks.set(message.id, {}); },
    setMark: () => {},
    self: { login: 'alice', name: 'Alice' },
  });
  ctx.ensurePendingRows(t1, 'bob');
  assert.deepEqual(plain(drawn.map((m) => m.id)), ['p-1']);
  assert.deepEqual(plain(drawn[0].replyTo), { id: 'm-0', from: 'bob', text: 'q' });
});

test('a carrier as a classic page receives it is dropped before anything counts it', () => {
  const touched = [];
  const stub = { t: 'msg', id: 'c-1', text: '🔒 stub', ts: 1, sealedEdit: true };
  const ctx = page(['handleFrame'], {
    users: [],
    renderRoster: () => touched.push('roster'),
    threadFor: () => { touched.push('thread'); return {}; },
    appendMessage: () => touched.push('append'),
    notifyReceivedSound: () => touched.push('sound'),
    playSound: () => touched.push('sound'),
    peerClients: new Map(),
  });
  ctx.handleFrame('bob', stub);
  assert.deepEqual(touched, []);
});

test('a history page of carriers still moves the paging cursor', () => {
  const t1 = thread();
  t1.oldestTs = null;
  t1.oldestId = null;
  t1.node = { childNodes: [], querySelector: () => null };
  t1.peerDeliveredTs = 0;
  t1.peerReadTs = 0;
  const ctx = page(['populateHistory'], {
    decryptHistoryPage: (peer, messages) => messages.filter((m) => m.sealedEdit !== true),
    applyPeerDeliveredWatermark: () => {},
    scheduleRosterRender: () => {},
    normalizeDateDividers: () => {},
    paintReactionEvents: () => {},
    ensurePendingRows: () => {},
    activePeer: null,
    requestAnimationFrame: () => {},
    flushReactionReads: () => {},
  });
  ctx.populateHistory(t1, [
    { id: 'e-2', ts: 20, sealedEdit: true },
    { id: 'e-1', ts: 10, sealedEdit: true },
  ]);
  assert.equal(t1.oldestTs, 10);
  assert.equal(t1.oldestId, 'e-1');
});

// --- sending ---------------------------------------------------------------

test('an edit on the core is the core\'s action; without it, the open frame as before', () => {
  const sent = [];
  const updates = [];
  const base = {
    activePeer: 'bob',
    randomHex: () => 'abc',
    sendFrame: (...args) => { sent.push(args); return true; },
    updateMessageText: (...args) => updates.push(args),
    threads: new Map(),
    coreEdits: new Map(),
    rememberCoreEdit: () => {},
    restoreEditedText: () => {},
  };
  const session = makeCore();
  const onCore = page(['editMessage'], { ...base, coreSession: session });
  assert.equal(onCore.editMessage('m-1', 'fixed'), true);
  assert.deepEqual(plain(session.log), [['editText', 'bob', 'm-abc', 'm-1', 'fixed']]);
  assert.deepEqual(sent, [], 'no frame, so no direct channel either');
  assert.deepEqual(plain(updates), [['bob', 'm-1', 'fixed']]);

  const classic = page(['editMessage'], { ...base, coreSession: null });
  assert.equal(classic.editMessage('m-1', 'plain'), true);
  assert.deepEqual(plain(sent), [['bob', { t: 'edit', id: 'm-1', text: 'plain' }]]);
});

// An edit shows on screen at once; if the core cannot send it — at the call or
// later, as a refusal or a give-up naming the carrier — the old words come
// back and a note says the edit did not leave (E-plan §6: an edit of a
// message that was never sent is one such refusal).
function editRow(text, { edited = false } = {}) {
  const meta = { nodes: edited ? [{ remove() { meta.nodes.length = 0; } }] : [] };
  const row = {
    messageText: text,
    dataset: edited ? { editedAt: '500' } : {},
    querySelector: (selector) => (selector === '.bubble-edited' ? (meta.nodes[0] ?? null) : null),
  };
  return { row, meta };
}

function editPage({ text = 'first', edited = false, accepts = true } = {}) {
  const th = thread('bob');
  const { row, meta } = editRow(text, { edited });
  th.nodes.set('m-1', row);
  const notes = [];
  const screen = [];
  const session = makeCore(accepts);
  const ctx = page(
    ['editMessage', 'rememberCoreEdit', 'restoreEditedText', 'settleCoreEdit'],
    {
      activePeer: 'bob',
      randomHex: () => 'abc',
      threads: new Map([['bob', th]]),
      coreSession: session,
      coreEdits: new Map(),
      CORE_EDITS_LIMIT: 100,
      sendFrame: () => true,
      layoutMessageMeta: () => {},
      systemNote: (_thread, line) => notes.push(line),
      updateMessageText: (peer, id, words, at, options) => {
        row.messageText = words;
        screen.push([words, at, options?.edited]);
        if (options?.edited !== false) meta.nodes[0] ??= { remove() { meta.nodes.length = 0; } };
      },
    },
  );
  ctx.coreEdits = vm.runInContext('coreEdits', ctx);
  return { ctx, row, meta, notes, screen };
}

test('a core edit the call refuses leaves the old words on screen and says so', () => {
  const { ctx, row, meta, notes } = editPage({ accepts: false });
  assert.equal(ctx.editMessage('m-1', 'second'), false);
  assert.equal(row.messageText, 'first');
  assert.equal(meta.nodes.length, 0, 'the row is not marked edited');
  assert.deepEqual(notes, ['editFailed']);
  assert.equal(ctx.coreEdits.size, 0);
});

test('a core edit refused later — by carrier id, even without a peer — puts the old words back', () => {
  const { ctx, row, meta, notes } = editPage();
  assert.equal(ctx.editMessage('m-1', 'second'), true);
  assert.equal(row.messageText, 'second');
  assert.equal(meta.nodes.length, 1);

  assert.equal(ctx.settleCoreEdit({ kind: 'refused', peer: null, id: 'm-abc', reason: 'not-found' }), true);
  assert.equal(row.messageText, 'first');
  assert.equal(meta.nodes.length, 0, 'the ✎ the optimistic edit drew is gone');
  assert.equal(row.dataset.editedAt, undefined);
  assert.deepEqual(notes, ['editFailed']);
  assert.equal(ctx.settleCoreEdit({ kind: 'refused', peer: null, id: 'm-abc' }), false, 'settled once');
});

test('a core edit that fails in the queue (⚠ receipt) is undone, one that is sent is settled', () => {
  const failed = editPage({ edited: true });
  failed.ctx.editMessage('m-1', 'second');
  assert.equal(failed.ctx.settleCoreEdit({ kind: 'receipt', peer: 'bob', id: 'm-abc', receipt: 'queued' }), false);
  assert.equal(failed.ctx.settleCoreEdit({ kind: 'receipt', peer: 'bob', id: 'm-abc', receipt: 'failed' }), true);
  assert.equal(failed.row.messageText, 'first');
  assert.equal(failed.meta.nodes.length, 1, 'it was edited before, and still is');
  assert.equal(failed.row.dataset.editedAt, '500');

  const sentOk = editPage();
  sentOk.ctx.editMessage('m-1', 'second');
  assert.equal(sentOk.ctx.settleCoreEdit({ kind: 'receipt', peer: 'bob', id: 'm-abc', receipt: 'sent' }), true);
  assert.equal(sentOk.ctx.coreEdits.size, 0);
  assert.equal(sentOk.row.messageText, 'second');
  assert.deepEqual(sentOk.notes, []);
});

test('a refused edit does not undo a later edit of the same message', () => {
  const { ctx, row, notes } = editPage();
  ctx.editMessage('m-1', 'second');
  row.messageText = 'third'; // edited again from another device meanwhile
  ctx.settleCoreEdit({ kind: 'refused', peer: null, id: 'm-abc' });
  assert.equal(row.messageText, 'third');
  assert.deepEqual(notes, ['editFailed'], 'the person still learns that edit did not leave');
});

test('on the core a message or an edit never takes the peer-to-peer channel', () => {
  const direct = [];
  const relayed = [];
  const link = { dc: { readyState: 'open', send: (raw) => direct.push(raw) } };
  const globals = {
    directLinks: new Map([['bob', link]]),
    RELAY_ONLY_FRAMES: new Set(['read', 'ack']),
    authed: true,
    subscribedPeer: 'bob',
    sendEnvelope: (payload) => { relayed.push(payload); return true; },
  };
  const onCore = page(['sendFrame'], { ...globals, coreSession: {} });
  onCore.sendFrame('bob', { t: 'msg', id: 'a', text: 'x' });
  onCore.sendFrame('bob', { t: 'edit', id: 'a', text: 'y' });
  onCore.sendFrame('bob', { t: 'typing', state: 'start' });
  assert.deepEqual(plain(relayed.map((p) => p.d.t)), ['msg', 'edit'], 'through the server');
  assert.equal(direct.length, 1, 'typing keeps its direct channel');
  assert.match(direct[0], /typing/);

  const classic = page(['sendFrame'], { ...globals, coreSession: null });
  classic.sendFrame('bob', { t: 'msg', id: 'b', text: 'x' });
  assert.equal(direct.length, 2, 'without the core the channel carries it as it always did');
});

test('a reply on the core is sealed with its quote; a refusal is a ⚠, never the page\'s open queue', () => {
  const run = ({ accepts, onCore }) => {
    const t1 = thread();
    const queued = [];
    const failed = [];
    const session = makeCore(accepts);
    const ctx = page(['onComposerSubmit', 'failCoreSend'], {
      activePeer: 'bob',
      token: 'tok',
      elements: { input: { value: 'the answer' } },
      composerContext: { mode: 'reply', id: 'm-0', from: 'bob', authorName: 'Bob', snippet: 'the question', media: undefined },
      coreSession: onCore ? session : null,
      hideCommandPalette: () => {},
      threadFor: () => t1,
      randomHex: () => 'f00',
      self: { name: 'Alice', login: 'alice' },
      appendMessage: (th, message) => { th.marks.set(message.id, { dataset: {} }); },
      scrollToLatest: () => {},
      setMark: (mark, state) => failed.push(state),
      scheduleRosterRender: () => {},
      rememberPendingSend: (...args) => queued.push(args),
      flushPendingSends: () => {},
      playSound: () => {},
      stopTyping: () => {},
      clearComposer: () => {},
      executeCommand: () => {},
    });
    ctx.onComposerSubmit({ preventDefault() {} });
    return { queued, failed, session };
  };

  const ok = run({ accepts: true, onCore: true });
  assert.equal(ok.session.log.length, 1);
  assert.deepEqual(plain(ok.session.log[0].slice(0, 4)), ['sendWith', 'bob', 'm-f00', 'the answer']);
  assert.equal(ok.session.log[0][4].replyTo.id, 'm-0');
  assert.equal(ok.session.log[0][4].replyTo.text, 'the question');
  assert.deepEqual(ok.queued, [], 'the core has it: the page keeps no copy');

  const refused = run({ accepts: false, onCore: true });
  assert.deepEqual(refused.queued, [], 'never the open queue');
  assert.deepEqual(refused.failed, ['failed']);

  const classic = run({ accepts: true, onCore: false });
  assert.equal(classic.queued.length, 1, 'without the core the reply keeps the page queue it always had');
  assert.equal(classic.queued[0][1].replyTo.id, 'm-0');
});

test('a voice note on the core is one sealed message with a caption; offline it is a ⚠', () => {
  const run = (onCore, accepts = true) => {
    const t1 = thread();
    const drawn = [];
    const frames = [];
    const marks = [];
    const session = makeCore(accepts);
    const ctx = page(['sendVoiceMessage', 'failCoreSend'], {
      authed: true,
      threadFor: () => t1,
      randomHex: () => 'v01',
      formatClock: () => '0:05',
      self: { name: 'Alice' },
      coreSession: onCore ? session : null,
      appendVoiceMessage: (th, message) => { drawn.push(message); th.marks.set(message.id, { dataset: {} }); },
      scrollToLatest: () => {},
      playSound: () => {},
      sendFrame: (...args) => { frames.push(args); return true; },
      systemNote: () => {},
      setMark: (mark, state) => marks.push(state),
      scheduleRosterRender: () => {},
    });
    ctx.sendVoiceMessage('data:audio/mp4;base64,AAAA', 5, 'bob');
    return { drawn, frames, marks, session };
  };
  const onCore = run(true);
  assert.deepEqual(plain(onCore.session.log), [['sendWith', 'bob', 'm-v01', 'voiceMessageNotify(0:05)', {
    voice: { dataUrl: 'data:audio/mp4;base64,AAAA', duration: 5 },
  }]]);
  assert.deepEqual(onCore.frames, []);
  assert.equal(onCore.drawn[0].queued, true, 'drawn on the clock, as a text is');
  const refused = run(true, false);
  assert.deepEqual(refused.marks, ['failed']);
  assert.deepEqual(refused.frames, []);
  const classic = run(false);
  assert.equal(classic.frames.length, 1);
  assert.equal(classic.frames[0][1].voice.duration, 5);
  assert.equal(classic.drawn[0].queued, undefined);
});

test('a picture on the core is one sealed message, its caption inside; the placeholder when there is none', async () => {
  const run = async (caption, onCore = true) => {
    const t1 = thread();
    const frames = [];
    const drawn = [];
    const session = makeCore();
    const ctx = page(['handlePastedImage', 'failCoreSend'], {
      authed: true,
      threadFor: () => t1,
      previewImageBeforeSend: async () => ({ file: {}, caption }),
      appendPendingImage: () => ({ remove() {} }),
      compressImage: async () => ({ dataUrl: 'data:image/png;base64,AAAA', width: 3, height: 2 }),
      randomHex: () => 'i01',
      self: { name: 'Alice', login: 'alice' },
      coreSession: onCore ? session : null,
      appendMessage: (th, message) => { drawn.push(message); th.marks.set(message.id, { dataset: {} }); },
      scrollToLatest: () => {},
      playSound: () => {},
      sendFrame: (...args) => { frames.push(args); return true; },
      systemNote: () => {},
      setMark: () => {},
      scheduleRosterRender: () => {},
    });
    await ctx.handlePastedImage({}, 'bob');
    return { frames, drawn, session };
  };
  const captioned = await run('look at this');
  assert.deepEqual(plain(captioned.session.log), [['sendWith', 'bob', 'm-i01', 'look at this', {
    image: { dataUrl: 'data:image/png;base64,AAAA', width: 3, height: 2 },
  }]]);
  assert.deepEqual(captioned.frames, []);
  assert.equal(captioned.drawn[0].queued, true);
  const bare = await run('');
  assert.equal(bare.session.log[0][3], 'pastedImage', 'a picture is never sent with an empty caption');
  const classic = await run('plain', false);
  assert.equal(classic.frames.length, 1);
  assert.equal(classic.frames[0][1].image.width, 3);
});

test('a forward on the core carries its label and bytes sealed; media gets a caption', async () => {
  const run = async (rows, onCore = true, accepts = true) => {
    const t1 = thread();
    const drawn = [];
    const frames = [];
    const marks = [];
    const session = makeCore(accepts);
    let n = 0;
    const ctx = page(['forwardMessage', 'failCoreSend'], {
      self: { name: 'Alice', login: 'alice' },
      displayName: (login) => login,
      messageAttachments: new Map([
        ['img', { image: { width: 4, height: 3 }, voice: null }],
        ['vox', { image: null, voice: { duration: 7 } }],
      ]),
      emojiPlainText: () => null,
      exitSelectionMode: () => {},
      selectPeer: async () => {},
      threadFor: () => t1,
      randomHex: () => `f${n += 1}`,
      attachmentDataUrl: async (attachment) => `data:x/y;base64,${attachment.duration ? 'VOICE' : 'IMAGE'}`,
      appendMessage: (th, message) => { drawn.push(['text', message]); th.marks.set(message.id, { dataset: {} }); },
      appendVoiceMessage: (th, message) => { drawn.push(['voice', message]); th.marks.set(message.id, { dataset: {} }); },
      scrollToLatest: () => {},
      playSound: () => {},
      systemNote: () => {},
      sendFrameReliably: async (...args) => { frames.push(args); return true; },
      coreSession: onCore ? session : null,
      setMark: (mark, state) => marks.push(state),
      scheduleRosterRender: () => {},
      formatClock: (seconds) => `0:0${seconds}`,
    });
    const make = ([id, side, text]) => ({
      dataset: { id, side, author: 'Bob' }, messageText: text, querySelector: () => null,
    });
    await ctx.forwardMessage(rows.map(make), 'carol', 'bob');
    return { drawn, frames, marks, session };
  };

  const onCore = await run([['m-1', 'peer', 'words'], ['img', 'own', ''], ['vox', 'peer', '']]);
  assert.deepEqual(onCore.frames, [], 'no open frame');
  const log = onCore.session.log;
  assert.deepEqual(plain(log.map((c) => c.slice(0, 4))), [
    ['sendWith', 'carol', 'm-f1', 'words'],
    ['sendWith', 'carol', 'm-f2', 'pastedImage'],
    ['sendWith', 'carol', 'm-f3', 'voiceMessageNotify(0:07)'],
  ]);
  assert.deepEqual(plain(log[0][4]), { forwardedFrom: { login: 'bob', name: 'Bob' } });
  assert.deepEqual(plain(log[1][4]), {
    forwardedFrom: { login: 'alice', name: 'Bob' },
    image: { dataUrl: 'data:x/y;base64,IMAGE', width: 4, height: 3 },
  });
  assert.deepEqual(plain(log[2][4].voice), { dataUrl: 'data:x/y;base64,VOICE', duration: 7 });
  assert.deepEqual(plain(onCore.drawn.map(([kind, m]) => [kind, m.queued])), [['text', true], ['text', true], ['voice', true]]);

  const refused = await run([['m-1', 'peer', 'words'], ['m-2', 'peer', 'more']], true, false);
  assert.deepEqual(refused.marks, ['failed'], 'the first refusal stops the batch');
  assert.deepEqual(refused.frames, []);

  const classic = await run([['m-1', 'peer', 'words']], false);
  assert.equal(classic.frames.length, 1);
  assert.equal(classic.frames[0][1].forwardedFrom.login, 'bob');
});
