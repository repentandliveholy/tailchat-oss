import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Issue #19: «в ростере сообщение быстрее появляется чем в чате»
// Tests that:
// 1. selectPeer subscribes immediately without waiting for initial history HTTP fetch.
// 2. selectPeer with an already loaded thread that has unread messages triggers reconcileActiveThread.
// 3. conversation-update for the active on-screen conversation does not increment unread,
//    re-subscribes, and triggers reconcileActiveThread.
// 4. unread envelope for the active on-screen conversation does not increment unread,
//    re-subscribes, and triggers reconcileActiveThread.

function source() {
  return fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
}

function extract(name, pattern) {
  const match = source().match(pattern);
  assert.ok(match, `${name} exists in web/cloud/app.js`);
  return match[0];
}

test('selectPeer subscribes immediately and reconciles unread on already loaded thread', async () => {
  const selectPeerSource = extract('selectPeer', /async function selectPeer\(peer\) \{[\s\S]*?\n\}/);
  const subscribed = [];
  const reconciled = [];
  const cleared = [];
  const loadedHistory = [];

  const thread = {
    peer: 'bob',
    loaded: true,
    unread: 2,
    node: { hidden: true },
  };

  const context = {
    voiceCapture: null,
    activePeer: null,
    selectionSeq: 0,
    wide: { matches: true },
    elements: {
      placeholder: { hidden: false },
      input: { focus() {} },
    },
    threads: new Map([['bob', thread]]),
    threadFor: () => thread,
    ensurePendingRows: () => {},
    subscribeActivePeer: (force) => subscribed.push({ force }),
    clearUnread: (peer) => { cleared.push(peer); thread.unread = 0; },
    reconcileActiveThread: (peer) => reconciled.push(peer),
    loadInitialHistory: async (peer) => { loadedHistory.push(peer); return { msgs: [] }; },
    populateHistory: () => {},
    scrollToLatest: () => {},
    updateScrollButton: () => {},
    flushReadReceipts: () => {},
    renderInfoPanel: () => {},
    revealTalkPane: () => {},
    // `selectPeer` leaves the message selection when the conversation changes
    // (`exitSelectionMode`, AGENTS.md «выделение сообщений»); the mode itself is
    // not what this test is about, so it is stubbed rather than extracted.
    exitSelectionMode: () => {},
    hideTyping: () => {},
    hideQuickReactions: () => {},
    renderRoster: () => {},
    updatePeerHeader: () => {},
    updateComposerState: () => {},
    refreshPeerActions: () => {},
    cancelComposerContext: () => {},
    clearPendingPing: () => {},
    stashDraft: () => {},
    restoreDraft: () => {},
    renderBotActions: () => {},
    cancelVoiceRecording: () => {},
    requestAnimationFrame: (cb) => cb(),
  };

  vm.createContext(context);
  vm.runInContext(`${selectPeerSource}\nglobalThis.selectPeer = selectPeer;`, context);

  await context.selectPeer('bob');

  assert.equal(subscribed.length, 1, 'subscribeActivePeer must be called immediately');
  assert.equal(subscribed[0].force, true);
  assert.equal(reconciled.length, 1, 'reconcileActiveThread must be called for loaded thread with unread');
  assert.equal(reconciled[0], 'bob');
  assert.equal(loadedHistory.length, 0, 'loadInitialHistory is skipped when thread.loaded is true');
});

test('selectPeer subscribes before awaiting initial history', async () => {
  const selectPeerSource = extract('selectPeer', /async function selectPeer\(peer\) \{[\s\S]*?\n\}/);
  const events = [];

  const thread = {
    peer: 'charlie',
    loaded: false,
    unread: 0,
    node: { hidden: true },
  };

  const context = {
    voiceCapture: null,
    activePeer: null,
    selectionSeq: 0,
    wide: { matches: true },
    elements: {
      placeholder: { hidden: false },
      input: { focus() {} },
    },
    threads: new Map([['charlie', thread]]),
    threadFor: () => thread,
    ensurePendingRows: () => {},
    subscribeActivePeer: (force) => events.push(`subscribe:${force}`),
    clearUnread: () => {},
    reconcileActiveThread: () => {},
    loadInitialHistory: async () => {
      events.push('history:start');
      return { msgs: [] };
    },
    populateHistory: () => { events.push('history:populate'); },
    scrollToLatest: () => {},
    updateScrollButton: () => {},
    flushReadReceipts: () => {},
    renderInfoPanel: () => {},
    revealTalkPane: () => {},
    hideTyping: () => {},
    hideQuickReactions: () => {},
    renderRoster: () => {},
    updatePeerHeader: () => {},
    updateComposerState: () => {},
    refreshPeerActions: () => {},
    cancelComposerContext: () => {},
    clearPendingPing: () => {},
    stashDraft: () => {},
    restoreDraft: () => {},
    renderBotActions: () => {},
    cancelVoiceRecording: () => {},
    requestAnimationFrame: (cb) => cb(),
    // `selectPeer` leaves the message selection when the conversation changes
    // (`exitSelectionMode`); the mode is not what this test is about.
    exitSelectionMode: () => {},
  };

  vm.createContext(context);
  vm.runInContext(`${selectPeerSource}\nglobalThis.selectPeer = selectPeer;`, context);

  await context.selectPeer('charlie');

  assert.deepEqual(events, ['subscribe:true', 'history:start', 'history:populate']);
});

test('conversation-update for an active on-screen peer syncs without incrementing unread', () => {
  const envelopeSource = extract('handleEnvelope', /function handleEnvelope\(payload\) \{[\s\S]*?\n\}/);

  const thread = {
    peer: 'alice',
    unread: 0,
  };

  const actions = [];
  const context = {
    activePeer: 'alice',
    messageIsOnScreen: (peer) => peer === 'alice',
    threadFor: () => thread,
    notePreview: () => {},
    subscribeActivePeer: (force) => actions.push(`subscribe:${force}`),
    reconcileActiveThread: (peer) => actions.push(`reconcile:${peer}`),
    renderRoster: () => actions.push('renderRoster'),
    updateAppUnreadBadge: () => actions.push('updateBadge'),
    notifyReceivedSound: () => actions.push('sound'),
    showWebNotification: () => actions.push('notification'),
    OFFICIAL_ACCOUNT_LOGIN: 'tailchat',
    displayName: (p) => p,
    t: (k) => k,
  };

  vm.createContext(context);
  vm.runInContext(`${envelopeSource}\nglobalThis.handleEnvelope = handleEnvelope;`, context);

  context.handleEnvelope({
    k: 'conversation-update',
    from: 'alice',
    self: false,
    last: { id: 'm-1', text: 'Hey' },
  });

  assert.equal(thread.unread, 0, 'unread count must not increment for active on-screen conversation');
  assert.ok(actions.includes('subscribe:true'), 'must resync subscription');
  assert.ok(actions.includes('reconcile:alice'), 'must reconcile active thread');
  assert.ok(!actions.includes('sound'), 'must not play background notification sound for active conversation');
  assert.ok(!actions.includes('notification'), 'must not show a notification for active conversation');
});

// A read receipt the socket would not take stays queued (`pumpReadReceipts`),
// and a subscription is exactly what it was waiting for: the frame has to be
// relayed to a peer this socket is watching, so the ack that the conversation is
// being watched again is the moment to offer the queue once more. Without this
// the receipt would wait for the next focus or interval tick — and a session
// that read the message behind the offline banner would leave the other side on
// ✓ until something else happened to nudge it.
test('the subscription ack retries the read receipts that could not go out', () => {
  const envelopeSource = extract('handleEnvelope', /function handleEnvelope\(payload\) \{[\s\S]*?\n\}/);

  const actions = [];
  const context = {
    activePeer: 'alice',
    subscribedPeer: null,
    subscriptionWaiters: new Map(),
    loadPendingSends: () => {},
    flushPendingSends: (peer) => actions.push(`flushSends:${peer}`),
    greetPeer: () => {},
    pumpReadReceipts: () => actions.push('pumpReceipts'),
    reconcileActiveThread: (peer) => actions.push(`reconcile:${peer}`),
  };

  vm.createContext(context);
  vm.runInContext(`${envelopeSource}\nglobalThis.handleEnvelope = handleEnvelope;`, context);

  context.handleEnvelope({ k: 'subscribed', peer: 'alice' });

  assert.equal(context.subscribedPeer, 'alice', 'the subscription is what `sendFrame` routes on');
  assert.ok(actions.includes('flushSends:alice'), 'the queued messages go out under their own ids');
  assert.ok(actions.includes('pumpReceipts'), 'and the queued receipts are offered again');
});
