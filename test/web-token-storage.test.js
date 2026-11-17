import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function extract(pattern, label) {
  const m = SOURCE.match(pattern);
  assert.ok(m, `${label} exists in web/cloud/app.js`);
  return m[0];
}

function loadTokenHelpers({ localStorageMap = new Map(), sessionStorageMap = new Map() } = {}) {
  const tokenKeyDecl = extract(/const TOKEN_KEY = '[^']+';/, 'TOKEN_KEY');
  const readTokenFn = extract(/function readToken\(\) \{[\s\S]*?\n\}/, 'readToken');
  const writeTokenFn = extract(/function writeToken\(val\) \{[\s\S]*?\n\}/, 'writeToken');
  const clearTokenFn = extract(/function clearToken\(\) \{[\s\S]*?\n\}/, 'clearToken');

  function makeStorage(map) {
    return {
      getItem(key) { return map.has(key) ? map.get(key) : null; },
      setItem(key, val) { map.set(key, String(val)); },
      removeItem(key) { map.delete(key); },
      clear() { map.clear(); },
    };
  }

  const localStorage = makeStorage(localStorageMap);
  const sessionStorage = makeStorage(sessionStorageMap);

  const sandbox = {
    localStorage,
    sessionStorage,
  };

  vm.runInNewContext([tokenKeyDecl, readTokenFn, writeTokenFn, clearTokenFn].join('\n\n'), sandbox);
  return {
    readToken: sandbox.readToken,
    writeToken: sandbox.writeToken,
    clearToken: sandbox.clearToken,
    localStorageMap,
    sessionStorageMap,
  };
}

test('writeToken stores token in sessionStorage and leaves localStorage clean', () => {
  const { writeToken, localStorageMap, sessionStorageMap } = loadTokenHelpers();
  writeToken('token-abc-123');

  assert.equal(sessionStorageMap.get('tailchat-cloud-token'), 'token-abc-123');
  assert.equal(localStorageMap.has('tailchat-cloud-token'), false, 'localStorage must hold no credentials at rest');
});

test('readToken migrates legacy localStorage token into sessionStorage and purges localStorage', () => {
  const localStorageMap = new Map([['tailchat-cloud-token', 'legacy-secret-token']]);
  const sessionStorageMap = new Map();
  const { readToken } = loadTokenHelpers({ localStorageMap, sessionStorageMap });

  const token = readToken();
  assert.equal(token, 'legacy-secret-token');
  assert.equal(sessionStorageMap.get('tailchat-cloud-token'), 'legacy-secret-token', 'migrated into session');
  assert.equal(localStorageMap.has('tailchat-cloud-token'), false, 'purged from disk profile');
});

test('clearToken wipes token from both sessionStorage and localStorage', () => {
  const localStorageMap = new Map([['tailchat-cloud-token', 'old-token']]);
  const sessionStorageMap = new Map([['tailchat-cloud-token', 'active-token']]);
  const { clearToken } = loadTokenHelpers({ localStorageMap, sessionStorageMap });

  clearToken();
  assert.equal(sessionStorageMap.has('tailchat-cloud-token'), false);
  assert.equal(localStorageMap.has('tailchat-cloud-token'), false);
});
