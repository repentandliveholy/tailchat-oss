import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The conversation header's own line, extracted from web/cloud/app.js the way
// test/web-roster-preview-mark.test.js takes its pieces: app.js is a
// bundler-less browser script with no module boundary to import from.
const SOURCE = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function extract(pattern, label) {
  const m = SOURCE.match(pattern);
  assert.ok(m, `${label} exists in web/cloud/app.js`);
  return m[0];
}

// The English presence words, verbatim from the dictionary in the same file.
// Every one that describes a person carries a lamp, which is the whole point of
// the separator rule: the lamp does the dividing, so nothing spells out `·`.
const WORDS = {
  peerOnline: '● online',
  peerIdle: '◐ idle',
  peerAway: '◔ away',
  peerOffline: (time) => `○ seen ${time}`,
  officialAccount: 'service account',
};

function load({ user = null, activePeer = 'pear', self = { login: 'me' } } = {}) {
  const context = {
    updateDirectUi: () => {},
    elements: {
      conversationMenuButton: { disabled: false },
      peerName: { textContent: '' },
      peerStatus: { textContent: '', dataset: {} },
    },
    activePeer,
    self,
    users: user ? [user] : [],
    t: (key, arg) => (typeof WORDS[key] === 'function' ? WORDS[key](arg) : WORDS[key]),
    humanLastSeen: () => '5m',
    peerLabel: (u) => `{${u.name}}`,
  };
  vm.createContext(context);
  vm.runInContext([
    extract(/function formatLogin\(login\) \{[\s\S]*?\n\}/, 'formatLogin'),
    extract(/function presenceKind\(user\) \{[\s\S]*?\n\}/, 'presenceKind'),
    extract(/function isServiceAccount\(user\) \{[\s\S]*?\n\}/, 'isServiceAccount'),
    extract(/function updatePeerHeader\(\) \{[\s\S]*?\n\}/, 'updatePeerHeader'),
    'globalThis.updatePeerHeader = updatePeerHeader;',
  ].join('\n'), context);
  return context;
}

function line(options) {
  const ctx = load(options);
  ctx.updatePeerHeader();
  return ctx.elements.peerStatus.textContent;
}

test('the lamp separates the login from the word, as it does on Android', () => {
  assert.equal(
    line({ user: { login: 'pear', name: 'Pear', online: true, state: 'active' } }),
    '@pear ● online',
  );
});

test('no dot is left in front of a lamp, whatever the presence', () => {
  const cases = [
    [{ online: true, state: 'idle' }, '@pear ◐ idle'],
    [{ online: true, state: 'away' }, '@pear ◔ away'],
    [{ online: false, state: 'active', lastSeen: 1 }, '@pear ○ seen 5m'],
  ];
  for (const [presence, expected] of cases) {
    assert.equal(line({ user: { login: 'pear', name: 'Pear', ...presence } }), expected);
  }
});

test('the service account keeps the dot: there is no lamp to separate with', () => {
  assert.equal(
    line({
      user: { login: 'tailchat', name: 'Tailchat', online: true, official: true },
      activePeer: 'tailchat',
    }),
    '@tailchat · service account',
  );
});

test('a peer with no roster entry is just the login', () => {
  assert.equal(line({ activePeer: '@pear' }), '@pear');
});
