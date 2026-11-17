import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/web-roster-block.test.js
// and test/web-roster-pin.test.js check their pieces of it: app.js is a
// bundler-less browser script with no module boundary to import from.
const SOURCE = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function extract(pattern, label) {
  const m = SOURCE.match(pattern);
  assert.ok(m, `${label} exists in web/cloud/app.js`);
  return m[0];
}

// Fake DOM element: just enough of the surface openRosterMenu, askRemoveContact
// and the transcript touch (className, textContent, children, event listeners,
// and a `<dialog>` that really opens and closes) to run the real functions
// outside a browser.
function makeFakeElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    type: '',
    title: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    open: false,
    removed: false,
    hidden: false,
    _children: [],
    _listeners: {},
    append(...items) { this._children.push(...items); },
    prepend(...items) { this._children.unshift(...items); },
    setAttribute(key, value) { this[`attr_${key}`] = value; },
    addEventListener(type, handler) { (this._listeners[type] ||= []).push(handler); },
    remove() { this.removed = true; },
    showModal() { this.open = true; },
    close() {
      this.open = false;
      for (const handler of this._listeners.close || []) handler({ type: 'close' });
    },
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0, bottom: 0 }; },
  };
}

function fire(el, type) {
  for (const handler of el._listeners[type] || []) handler({ stopPropagation() {}, preventDefault() {} });
}

function descendants(el, out = []) {
  out.push(el);
  for (const child of el._children || []) descendants(child, out);
  return out;
}

function findButton(root, text) {
  return descendants(root).find((el) => el.textContent === text && (el._listeners.click || []).length > 0);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- Group 1: the roster menu offers the removal, never on an official -----

function loadRosterMenuHelpers() {
  const openRosterMenu = extract(/function openRosterMenu\(anchor, user\) \{[\s\S]*?\n\}/, 'openRosterMenu');
  const closeRosterMenu = extract(/function closeRosterMenu\(\) \{[\s\S]*?\n\}/, 'closeRosterMenu');
  const nodeDecl = extract(/let openRosterMenuNode = null;/, 'openRosterMenuNode');

  const asked = [];
  const context = {
    document: { createElement: (tag) => makeFakeElement(tag), body: { append() {} } },
    window: { innerWidth: 800, innerHeight: 600 },
    Math,
    t: (key) => key,
    preserveFocusOnPointerDown: () => {},
    safeAnchorRect: (anchor) => anchor.getBoundingClientRect(),
    closeMessageMenu: () => {},
    // Referenced only inside click handlers that these tests invoke on purpose.
    removeContact: (login) => { asked.push(login); },
    // Referenced only inside click handlers that these tests never invoke.
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
  context.asked = asked;
  return context;
}

function menuLabels(ctx) {
  return ctx.getOpenRosterMenuNode()._children.map((item) => item.textContent);
}

test('roster menu omits the removal for an official contact', () => {
  const ctx = loadRosterMenuHelpers();
  ctx.openRosterMenu(makeFakeElement(), { login: 'tailchat', name: 'Tailchat', online: true, official: true });
  const labels = menuLabels(ctx);
  assert.ok(!labels.includes('rosterRemoveContact'), `the official contact offers no removal, got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('rosterBlock'), 'the rest of the menu is still there');
});

test('roster menu offers the removal, as a danger item, for an ordinary contact', () => {
  const ctx = loadRosterMenuHelpers();
  ctx.openRosterMenu(makeFakeElement(), { login: 'carl', name: 'Carl', online: false });
  const item = ctx.getOpenRosterMenuNode()._children.find((el) => el.textContent === 'rosterRemoveContact');
  assert.ok(item, `menu includes the removal, got ${JSON.stringify(menuLabels(ctx))}`);
  assert.ok(item.className.includes('msg-menu-item--danger'), 'the removal is styled like the other destructive items');

  fire(item, 'click');
  assert.deepEqual(ctx.asked, ['carl'], 'the item acts on the peer the menu was opened for');
});

// --- Group 2: confirmation, the call, and the purge -----------------------

// Everything the real removeContact / purgeRemovedContact / setUsers touch,
// with only the browser edges stubbed. The pinned set, the direct-link
// teardown and the confirmation dialog are the real ones.
function loadRemovalHelpers({ failure } = {}) {
  const removeContact = extract(/async function removeContact\(login\) \{[\s\S]*?\n\}/, 'removeContact');
  const purgeRemovedContact = extract(/function purgeRemovedContact\(login\) \{[\s\S]*?\n\}/, 'purgeRemovedContact');
  const askRemoveContact = extract(/function askRemoveContact\(\) \{[\s\S]*?\n\}/, 'askRemoveContact');
  const setUsers = extract(/function setUsers\(next\) \{[\s\S]*?\n\}/, 'setUsers');
  const composerPlaceholderText = extract(/function composerPlaceholderText\(\) \{[\s\S]*?\n\}/, 'composerPlaceholderText');
  const isBlockedPeer = extract(/function isBlockedPeer\(login\) \{[\s\S]*?\n\}/, 'isBlockedPeer');
  const teardownDirect = extract(/function teardownDirect\(login, finalState = 'idle'\) \{[\s\S]*?\n\}/, 'teardownDirect');
  const pendingIce = extract(/const pendingIceCandidates = new Map\(\);/, 'pendingIceCandidates');
  const pinnedKey = extract(/const PINNED_KEY = 'tailchat-cloud-pinned';/, 'PINNED_KEY');
  const loadPinned = extract(/function loadPinnedPeers\(\) \{[\s\S]*?\n\}/, 'loadPinnedPeers');
  const pinnedInit = extract(/const pinnedPeers = new Set\(loadPinnedPeers\(\)\);/, 'pinnedPeers init');
  const savePinned = extract(/function savePinnedPeers\(\) \{[\s\S]*?\n\}/, 'savePinnedPeers');

  const dialogs = [];
  const calls = { request: [], renderRoster: 0, systemNote: [] };
  const store = new Map([['tailchat-cloud-pinned', JSON.stringify(['carl'])]]);
  const nodes = new Map();
  const threads = new Map();
  const drafts = new Map();
  const directLinks = new Map();

  const threadFor = (login) => {
    if (!nodes.has(login)) nodes.set(login, makeFakeElement('div'));
    return { peer: login, node: nodes.get(login), reactionEvents: new Map(), unread: 0, seen: new Set() };
  };

  const context = {
    document: {
      createElement: (tag) => makeFakeElement(tag),
      body: { append: (el) => { if (el.tagName === 'DIALOG') dialogs.push(el); } },
    },
    t: (key) => key,
    errorText: (code) => `error:${code}`,
    request: async (method, path, body) => {
      calls.request.push({ method, path, body });
      if (failure) throw failure;
      return { ok: true };
    },
    users: [],
    self: { login: 'anna', name: 'Anna' },
    activePeer: null,
    threads,
    drafts,
    directLinks,
    composerContext: null,
    preEditDraft: null,
    elements: { placeholder: { hidden: true }, input: { placeholder: 'composerPlaceholderActive', disabled: false, value: '' } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
    renderRoster: () => { calls.renderRoster += 1; },
    updateAppUnreadBadge: () => {},
    systemNote: (thread, text) => { calls.systemNote.push(text); },
    threadFor,
    updatePeerHeader: () => {},
    updateComposerState: () => {},
    updateComposerContextUI: () => {},
    setComposerValue: () => {},
    refreshPeerActions: () => {},
    renderInfoPanel: () => {},
    updateDirectUi: () => {},
    setDirectState: () => {},
    compareUsers: () => 0,
    paintReactionEvents: () => {},
    requestAnimationFrame: (fn) => fn(),
    flushReactionReads: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    [
      pinnedKey, loadPinned, pinnedInit, savePinned, pendingIce,
      isBlockedPeer, composerPlaceholderText,
      removeContact, purgeRemovedContact, askRemoveContact, setUsers, teardownDirect,
      'globalThis.removeContact = removeContact;',
      'globalThis.purgeRemovedContact = purgeRemovedContact;',
      'globalThis.setUsers = setUsers;',
      'globalThis.pinnedPeers = pinnedPeers;',
    ].join('\n'),
    context,
  );

  // The state a person has when they right-click a contact they have been
  // talking to: the roster entry, an open conversation with a draft in it, a
  // pin, and a live direct link.
  const seed = () => {
    context.users = [{ login: 'anna', name: 'Anna' }, { login: 'carl', name: 'Carl' }];
    context.activePeer = 'carl';
    context.threads.set('carl', threadFor('carl'));
    context.threads.set('anna', threadFor('anna'));
    context.drafts.set('carl', 'half-typed');
    const link = { pc: { closed: false, close() { this.closed = true; } }, dc: { closed: false, close() { this.closed = true; } } };
    context.directLinks.set('carl', link);
    context.elements.placeholder.hidden = true;
    return link;
  };

  return { context, dialogs, calls, seed, store, nodes, directLinks };
}

// Answers the confirmation the way a person would: `text` names the button.
function answer(dialogs, text) {
  const [dialog] = dialogs;
  assert.ok(dialog, 'a confirmation dialog is on screen');
  const button = findButton(dialog, text);
  assert.ok(button, `the dialog offers "${text}"`);
  fire(button, 'click');
}

test('nothing is sent or purged until the confirmation is answered', async () => {
  const world = loadRemovalHelpers();
  world.seed();
  const done = world.context.removeContact('carl');
  await tick();

  assert.deepEqual(world.calls.request, [], 'the API is not called before the question is answered');
  const [dialog] = world.dialogs;
  assert.equal(dialog.open, true, 'the confirmation is shown modally');
  const hint = descendants(dialog).find((el) => el.className === 'modal-hint');
  assert.equal(hint.textContent, 'rosterRemoveConfirm', 'the dialog asks the contract\'s question');
  assert.ok(findButton(dialog, 'rosterRemoveContact').className.includes('primary-button'), 'it reuses the app\'s own modal buttons');
  assert.ok(findButton(dialog, 'rosterRemoveCancel').className.includes('quiet-button'), 'and the styled cancel, not a browser confirm');

  answer(world.dialogs, 'rosterRemoveCancel');
  await done;

  assert.deepEqual(world.calls.request, [], 'cancelling sends nothing');
  assert.deepEqual(world.context.users.map((u) => u.login), ['anna', 'carl'], 'cancelling purges nothing');
  assert.equal(world.context.threads.has('carl'), true);
  assert.deepEqual(JSON.parse(world.store.get('tailchat-cloud-pinned')), ['carl'], 'cancelling keeps the pin');
  assert.equal(world.dialogs[0].removed, true, 'the answered dialog is taken off the page');
});

test('confirming removes the contact and purges the conversation', async () => {
  const world = loadRemovalHelpers();
  const link = world.seed();
  const carlNode = world.nodes.get('carl');
  const annaNode = world.nodes.get('anna');

  const done = world.context.removeContact('carl');
  await tick();
  answer(world.dialogs, 'rosterRemoveContact');
  await done;

  assert.equal(world.calls.request.length, 1, 'exactly one request');
  const [sent] = world.calls.request;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/contact/remove');
  assert.equal(sent.body.login, 'carl', 'the request names the peer the menu was opened for');
  assert.deepEqual(world.context.users.map((u) => u.login), ['anna'], 'the contact leaves the roster');
  assert.equal(world.context.threads.has('carl'), false, 'the thread is dropped');
  assert.equal(carlNode.removed, true, 'its rendered rows are gone with it');
  assert.equal(world.context.drafts.has('carl'), false, 'so is the draft');
  assert.deepEqual(JSON.parse(world.store.get('tailchat-cloud-pinned')), [], 'the pin is dropped from the persisted set');
  assert.equal(world.directLinks.has('carl'), false, 'the direct link is torn down');
  assert.equal(link.pc.closed, true, 'its peer connection was closed');
  assert.equal(world.context.activePeer, null, 'the open conversation is closed');
  assert.equal(world.context.elements.placeholder.hidden, false, 'the pane goes back to "no peer chosen"');
  assert.equal(world.context.elements.input.placeholder, 'composerPlaceholderDisabled', 'and the composer asks for a peer again');
  assert.equal(annaNode.hidden, true, 'no other thread is left on screen');
  assert.equal(world.calls.renderRoster, 1, 'the roster is re-rendered');
  assert.deepEqual(world.calls.systemNote, ['rosterRemoveDone'], 'and the deletion is confirmed to the account');
});

test('a refused removal leaves every local trace in place', async () => {
  const world = loadRemovalHelpers({ failure: { code: 'not_friends', status: 403 } });
  const link = world.seed();
  const carlNode = world.nodes.get('carl');

  const done = world.context.removeContact('carl');
  await tick();
  answer(world.dialogs, 'rosterRemoveContact');
  await done;

  assert.deepEqual(world.context.users.map((u) => u.login), ['anna', 'carl'], 'the contact stays');
  assert.equal(world.context.threads.has('carl'), true, 'the thread stays');
  assert.equal(carlNode.removed, false, 'its rows stay on screen');
  assert.equal(world.context.drafts.get('carl'), 'half-typed', 'the draft stays');
  assert.deepEqual(JSON.parse(world.store.get('tailchat-cloud-pinned')), ['carl'], 'the pin stays');
  assert.equal(world.directLinks.get('carl'), link, 'the direct link stays');
  assert.equal(world.context.activePeer, 'carl', 'the conversation stays open');
  assert.equal(world.calls.renderRoster, 0, 'and nothing is redrawn as if it had worked');
  assert.deepEqual(world.calls.systemNote, ['error:not_friends'], 'the refusal is said out loud');
});

// --- Group 3: another device's deletion arrives as a roster without the peer -

test('a roster that no longer names the open peer closes and purges it', async () => {
  const world = loadRemovalHelpers();
  world.seed();
  const carlNode = world.nodes.get('carl');

  world.context.setUsers([{ login: 'anna', name: 'Anna' }, { login: 'carl', name: 'Carl' }]);
  assert.equal(world.context.activePeer, 'carl', 'a roster that still names the peer changes nothing');

  world.context.setUsers([{ login: 'anna', name: 'Anna' }]);
  assert.equal(world.context.activePeer, null, 'the conversation is closed');
  assert.equal(world.context.threads.has('carl'), false, 'the thread is purged');
  assert.equal(carlNode.removed, true, 'and its rows with it');
  assert.equal(world.context.elements.placeholder.hidden, false, 'the pane goes back to "no peer chosen"');
});

test('a roster never names the account itself, so Saved Messages stays open', () => {
  const world = loadRemovalHelpers();
  world.seed();
  world.context.activePeer = 'anna'; // the account's own Saved Messages thread

  world.context.setUsers([{ login: 'carl', name: 'Carl' }]);
  assert.equal(world.context.activePeer, 'anna', 'Saved Messages is not a contact and is never closed by a roster');
  assert.equal(world.context.threads.has('anna'), true);
});

// --- Group 4: the copy the removal shows, in every language ----------------

function loadErrorTextHelpers() {
  const i18n = extract(/const I18N = \{[\s\S]*?\n\};/, 'I18N');
  const errorText = extract(/function errorText\(code\) \{[\s\S]*?\n\}/, 'errorText');
  const context = { currentLang: 'ru' };
  vm.createContext(context);
  vm.runInContext(`${i18n}\n${errorText}\nglobalThis.I18N = I18N;\nglobalThis.errorText = errorText;`, context);
  return context;
}

test('the removal speaks the contract\'s copy in ru, en and fr', () => {
  const ctx = loadErrorTextHelpers();
  const expected = {
    ru: {
      action: 'Удалить контакт',
      confirm: 'Удалить контакт вместе с перепиской? У вас переписка удалится безвозвратно, у собеседника останется своя копия. Отменить это нельзя.',
      done: 'Контакт и переписка удалены.',
      refused: 'Официальный контакт удалить нельзя.',
    },
    en: {
      action: 'Delete contact',
      confirm: 'Delete the contact together with the conversation? Your copy is gone for good; the other person keeps theirs. This cannot be undone.',
      done: 'Contact and conversation deleted.',
      refused: 'The official contact cannot be deleted.',
    },
    fr: {
      action: 'Supprimer le contact',
      confirm: 'Supprimer le contact et la conversation ? Votre copie disparaît définitivement, l’autre personne garde la sienne. Action irréversible.',
      done: 'Contact et conversation supprimés.',
      refused: 'Le contact officiel ne peut pas être supprimé.',
    },
  };
  for (const [lang, copy] of Object.entries(expected)) {
    ctx.currentLang = lang;
    assert.equal(ctx.I18N[lang].rosterRemoveContact, copy.action, `${lang} menu item`);
    assert.equal(ctx.I18N[lang].rosterRemoveConfirm, copy.confirm, `${lang} confirmation`);
    assert.equal(ctx.I18N[lang].rosterRemoveDone, copy.done, `${lang} success note`);
    assert.equal(ctx.errorText('official_contact'), copy.refused, `${lang} refusal`);
  }
});
