import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/web-roster-pin.test.js
// and test/web-forward.test.js check their pieces of it: app.js is a
// bundler-less browser script with no module boundary to import from.
function loadPeerLabel() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const helper = source.match(/function peerLabel\(user\) \{[\s\S]*?\n\}/);
  assert.ok(helper, 'peerLabel exists in web/cloud/app.js');

  const context = {};
  vm.createContext(context);
  vm.runInContext([helper[0], 'globalThis.peerLabel = peerLabel;'].join('\n'), context);
  return context.peerLabel;
}

// The bubble's author label and the roster's sort both read the same name the
// roster paints, so a nickname has to reach those two as well — the defect the
// first pass left behind (issue #28).
function loadAuthorLabel({ users = [], self = null, t = (key) => key } = {}) {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const parts = {
    peerLabel: source.match(/function peerLabel\(user\) \{[\s\S]*?\n\}/),
    displayName: source.match(/function displayName\(login\) \{[\s\S]*?\n\}/),
    authorLabelFor: source.match(/function authorLabelFor\(login, declared\) \{[\s\S]*?\n\}/),
  };
  for (const [name, match] of Object.entries(parts)) {
    assert.ok(match, `${name} exists in web/cloud/app.js`);
  }

  const context = { users, self, t };
  vm.createContext(context);
  vm.runInContext(
    [
      parts.peerLabel[0],
      parts.displayName[0],
      parts.authorLabelFor[0],
      'globalThis.authorLabelFor = authorLabelFor;',
    ].join('\n'),
    context,
  );
  return context.authorLabelFor;
}

test('a bubble names a known peer the way the roster does, nickname included', () => {
  const authorLabelFor = loadAuthorLabel({ users: [{ login: 'anna', name: 'Anna', alias: 'Няша' }] });
  assert.equal(authorLabelFor('anna', 'Anna'), 'Няша');
  // The peer's own frame name cannot win over the roster's nickname, or the
  // thread would show a different name from the roster row above it.
  assert.equal(authorLabelFor('anna', 'Anna From Frame'), 'Няша');
});

test('a nickname that happens to equal the login still names the author', () => {
  const authorLabelFor = loadAuthorLabel({ users: [{ login: 'anna', name: 'Anna', alias: 'anna' }] });
  // The membership question is "is this login on the roster", not "did the
  // label come out different from the login" — the nickname is this account's
  // name for that person even when it reads the same as their handle, and the
  // frame's own name must not take the row back.
  assert.equal(authorLabelFor('anna', 'Frame Name'), 'anna');
  assert.equal(authorLabelFor('anna', ''), 'anna');
});

test('a peer the roster does not know is named by what the frame declared', () => {
  const authorLabelFor = loadAuthorLabel({ users: [] });
  assert.equal(authorLabelFor('carl', 'Carl'), 'Carl');
  assert.equal(authorLabelFor('carl', ''), 'carl');
  assert.equal(authorLabelFor('carl', undefined), 'carl');
});

test('a private nickname wins over the peer-chosen name and the login', () => {
  const peerLabel = loadPeerLabel();
  assert.equal(peerLabel({ login: 'anna', name: 'Anna', alias: 'Няша' }), 'Няша');
});

test('without a nickname the peer-chosen name wins over the login', () => {
  const peerLabel = loadPeerLabel();
  assert.equal(peerLabel({ login: 'anna', name: 'Anna' }), 'Anna');
});

test('an absent or empty nickname falls back to the name, then to the login', () => {
  const peerLabel = loadPeerLabel();
  assert.equal(peerLabel({ login: 'anna', name: 'Anna', alias: '' }), 'Anna');
  assert.equal(peerLabel({ login: 'anna', name: 'Anna', alias: null }), 'Anna');
  assert.equal(peerLabel({ login: 'anna', name: 'Anna', alias: undefined }), 'Anna');
  assert.equal(peerLabel({ login: 'anna', name: '' }), 'anna');
  assert.equal(peerLabel({ login: 'anna' }), 'anna');
});

test('a missing user renders as nothing rather than throwing', () => {
  const peerLabel = loadPeerLabel();
  assert.equal(peerLabel(null), '');
  assert.equal(peerLabel(undefined), '');
});
