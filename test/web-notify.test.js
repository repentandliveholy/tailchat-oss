import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Two notification defects that are invisible when they happen, extracted from
// web/cloud/app.js the way the other web tests extract their helpers:
// `navigator.serviceWorker.ready` never settling (no alert, no error, no
// fallback) and a settings row that reads ON while the browser has never been
// asked for permission.
const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function extract(name, pattern) {
  const match = source.match(pattern);
  assert.ok(match, `${name} exists in web/cloud/app.js`);
  return match[0];
}

function loadNotify({ permission = 'granted', ready = null, notifyEnabled = true } = {}) {
  const body = extract('showWebNotification', /async function showWebNotification\(\{[\s\S]*?\n\}/)
    // The race is what is under test, not the number: an actual 1.5 s wait in a
    // unit test only slows the suite down.
    .replace('setTimeout(() => resolve(null), 1500)', 'setTimeout(() => resolve(null), 20)');
  const shown = [];
  const context = {
    mutedContacts: new Set(),
    notifyEnabled,
    activePeer: null,
    APP_VERSION: '1.120',
    document: { hidden: true, hasFocus: () => false },
    navigator: { serviceWorker: { ready } },
    console,
    Notification: function Notification(title, options) {
      shown.push({ title, options, via: 'fallback' });
      return { close() {} };
    },
    selectPeer() {},
    window: { focus() {} },
    Promise,
    setTimeout,
  };
  Object.assign(context.Notification, { permission });
  // The browser has one object under two names (`Notification` and
  // `window.Notification`); the code under test uses both spellings.
  context.window = { Notification: context.Notification, focus() {} };
  vm.createContext(context);
  vm.runInContext(
    `${body}\nglobalThis.showWebNotification = showWebNotification;`,
    context,
  );
  return { context, shown };
}

test('a worker that never becomes ready hands the alert to the fallback', async () => {
  // `ready` is the promise that never settles when no worker is active for the
  // scope — awaiting it is what used to swallow the notification entirely.
  const h = loadNotify({ ready: new Promise(() => {}), permission: 'granted' });
  await h.context.showWebNotification({ title: 'Tailchat', body: 'hi', peer: 'pear' });
  assert.equal(h.shown.length, 1, 'the fallback fired instead of waiting forever');
  assert.equal(h.shown[0].via, 'fallback');
});

test('a ready worker shows the notification through the service worker', async () => {
  const shown = [];
  const ready = Promise.resolve({ showNotification: (title, options) => { shown.push({ title, options }); } });
  const h = loadNotify({ ready, permission: 'granted' });
  await h.context.showWebNotification({ title: 'Tailchat', body: 'hi', peer: 'pear' });
  assert.equal(shown.length, 1, 'the service worker path is still preferred');
  assert.equal(h.shown.length, 0, 'and the fallback is not used at the same time');
});

test('the notification row does not claim ON while the browser has not been asked', () => {
  const body = extract('updateNotifyBtn', /function updateNotifyBtn\(\) \{[\s\S]*?\n\}/);
  const render = (permission, notifyEnabled = true) => {
    const elements = {
      settingsNotify: { checked: null, disabled: null },
      settingsNotifyLabel: { textContent: '' },
    };
    const context = {
      elements,
      notifyEnabled,
      t: (key) => key,
      Notification: function Notification() {},
    };
    Object.assign(context.Notification, { permission });
    context.window = { Notification: context.Notification };
    vm.createContext(context);
    vm.runInContext(`${body}\nglobalThis.updateNotifyBtn = updateNotifyBtn;`, context);
    context.updateNotifyBtn();
    return { checked: elements.settingsNotify.checked, disabled: elements.settingsNotify.disabled, label: elements.settingsNotifyLabel.textContent };
  };

  assert.deepEqual(render('default'), { checked: false, disabled: false, label: 'notifyAllow' },
    'an unasked browser is invited to allow, not shown as on — and the row stays clickable, which is what raises the prompt');
  assert.deepEqual(render('denied'), { checked: false, disabled: true, label: 'notifyBlocked' });
  assert.deepEqual(render('granted', true), { checked: true, disabled: false, label: 'settingsNotify' });
  assert.deepEqual(render('granted', false), { checked: false, disabled: false, label: 'settingsNotify' },
    'the app’s own switch is still what the row says when permission is granted');
});
