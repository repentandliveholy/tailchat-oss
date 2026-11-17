import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/web-roster-pin.test.js
// and test/web-forward.test.js check their pieces of it: app.js is a
// bundler-less browser script with no module boundary to import from.
const SOURCE = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function extract(pattern, label) {
  const m = SOURCE.match(pattern);
  assert.ok(m, `${label} exists in web/cloud/app.js`);
  return m[0];
}

// Fake DOM element: just enough of the surface renderRoster/openRosterMenu
// touch (className, dataset, textContent, append/prepend, event listeners,
// getBoundingClientRect) to run the real functions outside a browser.
function makeFakeElement() {
  return {
    className: '',
    type: '',
    title: '',
    textContent: '',
    dataset: {},
    style: {},
    _children: [],
    append(...items) { this._children.push(...items); },
    prepend(...items) { this._children.unshift(...items); },
    setAttribute(key, value) { this[`attr_${key}`] = value; },
    addEventListener() {},
    remove() {},
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0, bottom: 0 }; },
  };
}

// --- Group 1: roster row carries the blocked indicator -------------------

function loadRenderRosterHelpers() {
  const renderRoster = extract(/function renderRoster\(\) \{[\s\S]*?\n\}/, 'renderRoster');
  const bracketName = extract(/function bracketName\(name\) \{[\s\S]*?\n\}/, 'bracketName');
  const peerLabel = extract(/function peerLabel\(user\) \{[\s\S]*?\n\}/, 'peerLabel');
  const buildAvatar = extract(/function buildAvatar\(label, kind\) \{[\s\S]*?\n\}/, 'buildAvatar');
  const paintAvatar = extract(/function paintAvatar\(avatar, label, kind\) \{[\s\S]*?\n\}/, 'paintAvatar');

  const rosterList = { innerHTML: '', _children: [], append(...items) { this._children.push(...items); } };
  const context = {
    elements: { rosterList, rosterEmpty: { hidden: false } },
    self: null, // skips buildSavedMessagesRow / self-filtering entirely
    users: [],
    activePeer: null,
    threads: new Map(),
    document: { createElement: () => makeFakeElement() },
    compareUsers: () => 0, // ordering is irrelevant to this test
    rosterPreviewOf: () => null,
    isPinned: () => false,
    buildRosterPreview: () => null,
    buildRosterMeta: () => null,
    presenceKind: () => 'offline',
    presenceLabel: () => '',
    presenceGlyph: () => '○',
    isServiceAccount: (user) => Boolean(user?.official),
    preserveFocusOnPointerDown: () => {},
    openRosterMenu: () => {},
    closeMessageMenu: () => {},
    selectPeer: () => {},
    // The roster render ends by repainting the bot-actions bar, whose own
    // derivation is covered by test/web-bot-actions.test.js; this harness is
    // about the roster's shape.
    renderBotActions: () => {},
    t: (key) => key,
  };
  vm.createContext(context);
  vm.runInContext(`${peerLabel}\n${bracketName}\n${buildAvatar}\n${paintAvatar}\n${renderRoster}\nglobalThis.renderRoster = renderRoster;`, context);
  return context;
}

test('roster row carries the blocked indicator when user.blocked is true', () => {
  const ctx = loadRenderRosterHelpers();
  ctx.users = [{ login: 'carl', name: 'Carl', blocked: true }];
  ctx.renderRoster();

  const li = ctx.elements.rosterList._children.find((item) => item.className === 'roster-row');
  const [btn] = li._children;
  assert.equal(btn.dataset.blocked, 'true', 'the roster button is flagged data-blocked="true"');
  const name = btn._children.find((child) => child.className === 'roster-name');
  assert.ok(name.textContent.startsWith('🚫 '), `name is prefixed with the block glyph, got "${name.textContent}"`);
});

test('roster row shows no blocked indicator when user.blocked is falsy', () => {
  const ctx = loadRenderRosterHelpers();
  ctx.users = [{ login: 'anna', name: 'Anna' }];
  ctx.renderRoster();

  const li = ctx.elements.rosterList._children.find((item) => item.className === 'roster-row');
  const [btn] = li._children;
  assert.equal(btn.dataset.blocked, undefined, 'an unblocked contact carries no data-blocked attribute');
  const name = btn._children.find((child) => child.className === 'roster-name');
  assert.ok(!name.textContent.includes('🚫'), `name has no block glyph, got "${name.textContent}"`);
});

test('official roster row shows a service label without a presence dot', () => {
  const ctx = loadRenderRosterHelpers();
  ctx.users = [{ login: 'tailchat', name: 'Tailchat', official: true, online: true }];
  ctx.renderRoster();

  const li = ctx.elements.rosterList._children.find((item) => item.className === 'roster-row');
  const [btn] = li._children;
  const status = btn._children.find((child) => child.className === 'roster-status');
  assert.equal(btn.dataset.official, 'true');
  assert.equal(status.dataset.online, 'service');
  assert.equal(status.textContent, 'officialAccount');
  assert.equal(status._children.length, 0, 'a service account has no presence dot');
  // The circle says "official" through its own colour key, not presence.
  const avatar = btn._children.find((child) => child.className === 'roster-avatar');
  assert.equal(avatar.dataset.presence, 'service');
  assert.equal(avatar.textContent, 'T');
});

test('renderRoster creates no section headers (flat roster)', () => {
  const ctx = loadRenderRosterHelpers();
  ctx.users = [
    { login: 'anna', name: 'Anna', online: true },
    { login: 'boris', name: 'Boris', online: false },
  ];
  ctx.renderRoster();

  const sections = ctx.elements.rosterList._children.filter((item) => item.className === 'roster-section');
  assert.equal(sections.length, 0, 'no section headers are rendered');
  const rows = ctx.elements.rosterList._children.filter((item) => item.className === 'roster-row');
  assert.equal(rows.length, 2, 'all contacts rendered as flat rows');
});

// --- Group 2: roster menu offers Block vs Unblock -------------------------

function loadRosterMenuHelpers() {
  const openRosterMenu = extract(/function openRosterMenu\(anchor, user\) \{[\s\S]*?\n\}/, 'openRosterMenu');
  const closeRosterMenu = extract(/function closeRosterMenu\(\) \{[\s\S]*?\n\}/, 'closeRosterMenu');
  const nodeDecl = extract(/let openRosterMenuNode = null;/, 'openRosterMenuNode');

  const context = {
    document: { createElement: () => makeFakeElement(), body: { append() {} } },
    window: { innerWidth: 800, innerHeight: 600 },
    Math,
    t: (key) => key,
    preserveFocusOnPointerDown: () => {},
    safeAnchorRect: (anchor) => anchor.getBoundingClientRect(),
    closeMessageMenu: () => {},
    // Referenced only inside click handlers that this test never invokes.
    selectPeer: () => {}, togglePin: () => {}, markConversationRead: () => {},
    executeCommand: () => {}, exportHistory: () => {}, setPaneVisible: () => {},
    syncPaneButtons: () => {}, deleteMessages: () => {}, blockPeer: () => {}, unblockPeer: () => {},
    isPinned: () => false,
    navigator: { clipboard: null },
    threads: new Map(),
    activePeer: null,
    systemNote: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${nodeDecl}\n${closeRosterMenu}\n${openRosterMenu}\nglobalThis.openRosterMenu = openRosterMenu;\nglobalThis.getOpenRosterMenuNode = () => openRosterMenuNode;`,
    context,
  );
  return context;
}

function menuLabels(ctx) {
  return ctx.getOpenRosterMenuNode()._children.map((item) => item.textContent);
}

test('roster menu offers "rosterBlock" for a peer that is not yet blocked', () => {
  const ctx = loadRosterMenuHelpers();
  ctx.openRosterMenu(makeFakeElement(), { login: 'carl', online: false, blocked: false });
  const labels = menuLabels(ctx);
  assert.ok(labels.includes('rosterBlock'), `menu includes Block, got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('rosterUnblock'), 'menu does not also offer Unblock');
});

test('roster menu offers "rosterUnblock" for a peer that is already blocked', () => {
  const ctx = loadRosterMenuHelpers();
  ctx.openRosterMenu(makeFakeElement(), { login: 'carl', online: false, blocked: true });
  const labels = menuLabels(ctx);
  assert.ok(labels.includes('rosterUnblock'), `menu includes Unblock, got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('rosterBlock'), 'menu does not also offer Block');
});

// --- Group 3: composer disables for a blocked active peer -----------------

function loadComposerStateHelpers() {
  const isBlockedPeer = extract(/function isBlockedPeer\(login\) \{[\s\S]*?\n\}/, 'isBlockedPeer');
  const placeholder = extract(/function composerPlaceholderText\(\) \{[\s\S]*?\n\}/, 'composerPlaceholderText');
  const updateState = extract(/function updateComposerState\(\) \{[\s\S]*?\n\}/, 'updateComposerState');

  const context = {
    users: [],
    activePeer: null,
    elements: {
      input: { disabled: false, placeholder: '' },
      voiceButton: { disabled: false },
      attachButton: { disabled: false },
      emojiButton: { disabled: false },
    },
    t: (key) => key,
    renderBotActions: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${isBlockedPeer}\n${placeholder}\n${updateState}\nglobalThis.updateComposerState = updateComposerState;`,
    context,
  );
  return context;
}

test('composer disables input/voice/attach/emoji for a blocked active peer', () => {
  const ctx = loadComposerStateHelpers();
  ctx.users = [{ login: 'carl', blocked: true }];
  ctx.activePeer = 'carl';
  ctx.updateComposerState();

  assert.equal(ctx.elements.input.disabled, true);
  assert.equal(ctx.elements.voiceButton.disabled, true);
  assert.equal(ctx.elements.attachButton.disabled, true);
  assert.equal(ctx.elements.emojiButton.disabled, true);
  assert.equal(ctx.elements.input.placeholder, 'composerBlockedHint');
});

test('composer stays enabled for an active peer that is not blocked', () => {
  const ctx = loadComposerStateHelpers();
  ctx.users = [{ login: 'anna', blocked: false }];
  ctx.activePeer = 'anna';
  ctx.updateComposerState();

  assert.equal(ctx.elements.input.disabled, false);
  assert.equal(ctx.elements.voiceButton.disabled, false);
  assert.equal(ctx.elements.attachButton.disabled, false);
  assert.equal(ctx.elements.emojiButton.disabled, false);
  assert.equal(ctx.elements.input.placeholder, 'composerPlaceholderActive');
});

// --- Group 4: block state is server-authoritative, never client-local -----

test('applyBlockedFlag mutates the in-memory roster entry, not a local store', () => {
  const applyBlockedFlag = extract(/function applyBlockedFlag\(login, blocked\) \{[\s\S]*?\n\}/, 'applyBlockedFlag');
  const context = {
    users: [{ login: 'carl', blocked: false }],
    activePeer: null,
    renderRoster: () => {},
    updateComposerState: () => {},
  };
  vm.createContext(context);
  vm.runInContext(`${applyBlockedFlag}\nglobalThis.applyBlockedFlag = applyBlockedFlag;`, context);

  context.applyBlockedFlag('carl', true);
  assert.equal(context.users[0].blocked, true, 'the roster entry itself now carries blocked: true');

  context.applyBlockedFlag('carl', false);
  assert.equal(context.users[0].blocked, false, 'unblocking clears the same roster entry field');
});
