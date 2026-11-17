import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
const key = 'tailchat-cloud-borders';
const legacyKey = 'tailchat-cloud-bubbles';

function load(entries = []) {
  const values = new Map(entries);
  const context = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    document: { documentElement: { dataset: {} } },
    elements: { settingsBorders: { checked: false } },
    values,
  };
  vm.createContext(context);
  const initial = source.match(/function getInitialBorders\(\) \{[\s\S]*?\n\}/)?.[0];
  const setter = source.match(/function setBorders\(on, \{ persist = true \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(initial, 'boot migration exists');
  assert.ok(setter, 'borders toggle setter exists');
  vm.runInContext(`const BORDERS_KEY = ${JSON.stringify(key)}; let bordersOn = false;\n${initial}\n${setter}`, context);
  return context;
}

test('outlines default off and painting boot does not create a saved choice', () => {
  const ctx = load();
  assert.equal(ctx.getInitialBorders(), false);
  ctx.setBorders(false, { persist: false });
  assert.equal(ctx.document.documentElement.dataset.borders, 'off');
  assert.equal(ctx.elements.settingsBorders.checked, false);
  assert.equal(ctx.values.has(key), false);
});

test('legacy message outlines migrate once, then the new choice survives restarts', () => {
  for (const [legacy, expected] of [['outlined', true], ['plain', false]]) {
    const ctx = load([[legacyKey, legacy]]);
    assert.equal(ctx.getInitialBorders(), expected);
    assert.equal(ctx.values.has(legacyKey), false);
    assert.equal(ctx.values.get(key), expected ? 'on' : 'off');
    assert.equal(ctx.getInitialBorders(), expected);
    ctx.setBorders(!expected);
    assert.equal(ctx.document.documentElement.dataset.borders, expected ? 'off' : 'on');
    assert.equal(ctx.elements.settingsBorders.checked, !expected);
    assert.equal(ctx.getInitialBorders(), !expected);
  }
});

test('a new outlines choice wins over an old cached client\'s message setting', () => {
  const ctx = load([[key, 'off'], [legacyKey, 'outlined']]);
  assert.equal(ctx.getInitialBorders(), false);
  assert.equal(ctx.values.has(legacyKey), false);
  assert.equal(ctx.values.get(key), 'off');
});

test('invalid legacy or new values remain off and the legacy key is removed', () => {
  const ctx = load([[key, 'invalid'], [legacyKey, 'invalid']]);
  assert.equal(ctx.getInitialBorders(), false);
  assert.equal(ctx.values.has(legacyKey), false);
});

test('a full store cannot turn a readable outlines choice off during migration', () => {
  const ctx = load([[legacyKey, 'outlined']]);
  ctx.localStorage.setItem = () => {
    const error = new Error('storage full');
    error.name = 'QuotaExceededError';
    throw error;
  };
  const on = ctx.getInitialBorders();
  assert.equal(on, true);
  ctx.setBorders(on, { persist: false });
  assert.equal(ctx.document.documentElement.dataset.borders, 'on');
  assert.equal(ctx.elements.settingsBorders.checked, true);
  assert.equal(ctx.values.has(key), false, 'migration did not save the new key');
  assert.equal(ctx.values.get(legacyKey), 'outlined', 'keep the readable choice until it can be saved');
  assert.equal(ctx.getInitialBorders(), true, 'the following boot still uses that choice');
});

test('a readable new choice survives failed legacy cleanup', () => {
  const ctx = load([[key, 'on'], [legacyKey, 'plain']]);
  ctx.localStorage.removeItem = () => { throw new Error('storage denied'); };
  assert.equal(ctx.getInitialBorders(), true, 'the new key wins before migration writes');
});

test('unavailable local storage does not prevent painting the outlines toggle', () => {
  const ctx = load();
  ctx.localStorage.getItem = () => { throw new Error('storage denied'); };
  ctx.localStorage.setItem = () => { throw new Error('storage denied'); };
  assert.equal(ctx.getInitialBorders(), false);
  assert.doesNotThrow(() => ctx.setBorders(true));
  assert.equal(ctx.document.documentElement.dataset.borders, 'on');
  assert.equal(ctx.elements.settingsBorders.checked, true);
});

// «Объёмный дизайн» is the same kind of switch as «Обводки», with its own key
// and no legacy to migrate from.
const depthKey = 'tailchat-cloud-depth';

function loadDepth(entries = []) {
  const values = new Map(entries);
  const context = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    document: { documentElement: { dataset: {} } },
    elements: { settingsDepth: { checked: false }, settingsBorders: { checked: false } },
    values,
  };
  vm.createContext(context);
  const initial = source.match(/function getInitialDepth\(\) \{[\s\S]*?\n\}/)?.[0];
  const setter = source.match(/function setDepth\(on, \{ persist = true \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  const borders = source.match(/function setBorders\(on, \{ persist = true \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(initial, 'depth boot reader exists');
  assert.ok(setter, 'depth toggle setter exists');
  assert.ok(borders, 'borders toggle setter exists');
  vm.runInContext(
    `const DEPTH_KEY = ${JSON.stringify(depthKey)}; const BORDERS_KEY = ${JSON.stringify(key)};\n`
    + `let depthOn = false; let bordersOn = false;\n${initial}\n${setter}\n${borders}`,
    context,
  );
  return context;
}

test('depth defaults on and painting boot does not create a saved choice', () => {
  const ctx = loadDepth();
  assert.equal(ctx.getInitialDepth(), true);
  ctx.setDepth(true, { persist: false });
  assert.equal(ctx.document.documentElement.dataset.depth, 'on');
  assert.equal(ctx.elements.settingsDepth.checked, true);
  assert.equal(ctx.values.has(depthKey), false);
});

test('only a stored `off` keeps the flat look; anything else is depth', () => {
  assert.equal(loadDepth([[depthKey, 'off']]).getInitialDepth(), false);
  for (const value of ['on', 'invalid', '', 'true', 'OFF']) {
    assert.equal(loadDepth([[depthKey, value]]).getInitialDepth(), true, value);
  }
});

test('a depth click is saved and survives restarts in both directions', () => {
  const ctx = loadDepth();
  ctx.setDepth(true);
  assert.equal(ctx.document.documentElement.dataset.depth, 'on');
  assert.equal(ctx.elements.settingsDepth.checked, true);
  assert.equal(ctx.values.get(depthKey), 'on');
  assert.equal(ctx.getInitialDepth(), true);
  ctx.setDepth(false);
  assert.equal(ctx.document.documentElement.dataset.depth, 'off');
  assert.equal(ctx.elements.settingsDepth.checked, false);
  assert.equal(ctx.values.get(depthKey), 'off');
  assert.equal(ctx.getInitialDepth(), false);
});

test('painting a stored depth choice at boot does not rewrite it', () => {
  const ctx = loadDepth([[depthKey, 'on']]);
  const on = ctx.getInitialDepth();
  ctx.setDepth(on, { persist: false });
  assert.equal(ctx.document.documentElement.dataset.depth, 'on');
  assert.equal(ctx.elements.settingsDepth.checked, true);
  assert.equal(ctx.values.get(depthKey), 'on');
});

test('a full store cannot lose the depth choice for this session', () => {
  const ctx = loadDepth();
  ctx.localStorage.setItem = () => {
    const error = new Error('storage full');
    error.name = 'QuotaExceededError';
    throw error;
  };
  assert.doesNotThrow(() => ctx.setDepth(true));
  assert.equal(ctx.document.documentElement.dataset.depth, 'on');
  assert.equal(ctx.elements.settingsDepth.checked, true);
  assert.equal(vm.runInContext('depthOn', ctx), true);
  assert.equal(ctx.values.has(depthKey), false);
});

test('unavailable local storage falls back to depth and still paints the toggle', () => {
  const ctx = loadDepth();
  ctx.localStorage.getItem = () => { throw new Error('storage denied'); };
  ctx.localStorage.setItem = () => { throw new Error('storage denied'); };
  assert.equal(ctx.getInitialDepth(), true);
  assert.doesNotThrow(() => ctx.setDepth(false));
  assert.equal(ctx.document.documentElement.dataset.depth, 'off');
  assert.equal(ctx.elements.settingsDepth.checked, false);
});

test('depth and outlines are independent switches with their own keys', () => {
  const ctx = loadDepth();
  ctx.setDepth(true);
  assert.equal(ctx.document.documentElement.dataset.borders, undefined);
  assert.equal(ctx.values.has(key), false, 'turning depth on does not save an outlines choice');
  ctx.setBorders(true);
  assert.equal(ctx.document.documentElement.dataset.depth, 'on');
  assert.equal(ctx.document.documentElement.dataset.borders, 'on');
  ctx.setBorders(false);
  assert.equal(ctx.document.documentElement.dataset.depth, 'on', 'outlines off leaves depth on');
  assert.equal(ctx.values.get(depthKey), 'on');
  assert.equal(ctx.values.get(key), 'off');
  ctx.setDepth(false);
  assert.equal(ctx.document.documentElement.dataset.borders, 'off', 'depth off leaves outlines as they were');
});
