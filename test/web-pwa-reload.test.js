import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function functionSource(name) {
  const functionStart = appSource.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} exists in web/cloud/app.js`);
  const start = appSource.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  let parameterDepth = 0;
  let body = -1;
  for (let i = appSource.indexOf('(', functionStart); i < appSource.length; i += 1) {
    if (appSource[i] === '(') parameterDepth += 1;
    else if (appSource[i] === ')' && --parameterDepth === 0) {
      body = appSource.indexOf('{', i);
      break;
    }
  }
  assert.notEqual(body, -1, `${name} has a function body`);
  let depth = 0;
  for (let i = body; i < appSource.length; i += 1) {
    if (appSource[i] === '{') depth += 1;
    else if (appSource[i] === '}' && --depth === 0) return appSource.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadReloadHelper() {
  const src = functionSource('shouldAutoReloadForUpdate');
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  return sandbox.shouldAutoReloadForUpdate;
}

test('first-ever visitor (hadControllerAtLoad = false, unauthed): shouldAutoReloadForUpdate returns false', () => {
  const shouldReload = loadReloadHelper();
  // Brand-new user: no controller at load. The first controllerchange is the
  // initial registration claim, not an update. Reload must NOT happen.
  assert.equal(shouldReload(false, false), false);
});

test('first-ever visitor (hadControllerAtLoad = false, authed): shouldAutoReloadForUpdate returns false', () => {
  const shouldReload = loadReloadHelper();
  assert.equal(shouldReload(false, true), false);
});

test('returning visitor on auth screen (hadControllerAtLoad = true, unauthed): shouldAutoReloadForUpdate returns true', () => {
  const shouldReload = loadReloadHelper();
  // Returning visitor on login screen: had a controller at load, not in a session.
  // Must automatically reload to seamlessly pick up the updated deployment
  // without requiring the user to guess Shift+F5.
  assert.equal(shouldReload(true, false), true);
});

test('authenticated active chat session (hadControllerAtLoad = true, authed): shouldAutoReloadForUpdate returns false', () => {
  const shouldReload = loadReloadHelper();
  // In an active session, never auto-reload over user work; offer the reload button instead.
  assert.equal(shouldReload(true, true), false);
});

test('setupPwa wiring: controllerchange early-returns on initial claim, checks auth status, and reloads before offerWebUpdate', () => {
  const setupPwaSrc = functionSource('setupPwa');

  // Guard 1: hadControllerAtLoad check must prevent action on first-ever install claim
  assert.match(
    setupPwaSrc,
    /if \(!hadControllerAtLoad \|\| updateOffered\) return;/,
    'controllerchange listener must guard against first-ever claims and duplicate events',
  );

  // Guard 2: shouldAutoReloadForUpdate must be called with hadControllerAtLoad and auth state
  assert.match(
    setupPwaSrc,
    /if \(shouldAutoReloadForUpdate\(hadControllerAtLoad,\s*Boolean\(self\)\)\)/,
    'must invoke shouldAutoReloadForUpdate with hadControllerAtLoad and Boolean(self)',
  );

  // Ordering: window.location.reload() and return must precede offerWebUpdate()
  const reloadIdx = setupPwaSrc.indexOf('window.location.reload();');
  const returnIdx = setupPwaSrc.indexOf('return;', reloadIdx);
  const offerIdx = setupPwaSrc.indexOf('offerWebUpdate();', returnIdx);

  assert.notEqual(reloadIdx, -1, 'window.location.reload() must be present in reload branch');
  assert.notEqual(returnIdx, -1, 'return must terminate the reload branch');
  assert.notEqual(offerIdx, -1, 'offerWebUpdate() must follow the early-return reload branch');
  assert.ok(reloadIdx < returnIdx && returnIdx < offerIdx, 'reload branch must return before offerWebUpdate');
});
