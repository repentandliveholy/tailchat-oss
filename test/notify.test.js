import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotifier,
  notificationPreview,
  notifyIfUnfocused,
} from '../src/notify.js';

test('preview is single-line and truncates by Unicode code point', () => {
  assert.equal(notificationPreview('one\ntwo'), 'one two');
  assert.equal(notificationPreview('😀😀😀', 2), '😀…');
});

test('unfocused incoming message sends native notification with sound', () => {
  const calls = [];
  const backend = {
    notify(options, callback) {
      calls.push(options);
      callback(null);
    },
  };
  const notifier = createNotifier({ enabled: true, backend, bell() {} });
  assert.equal(notifyIfUnfocused({
    focused: false,
    notifier,
    name: 'Roman',
    text: 'Привет',
  }), true);
  assert.deepEqual(calls, [{
    title: 'tailchat · Roman',
    message: 'Привет',
    sound: true,
    wait: false,
  }]);
});

test('focused or disabled notifications stay silent', () => {
  let calls = 0;
  const backend = { notify() { calls++; } };
  const enabled = createNotifier({ enabled: true, backend, bell() {} });
  const disabled = createNotifier({ enabled: false, backend, bell() {} });
  assert.equal(notifyIfUnfocused({
    focused: true, notifier: enabled, name: 'R', text: 'x',
  }), false);
  assert.equal(notifyIfUnfocused({
    focused: false, notifier: disabled, name: 'R', text: 'x',
  }), false);
  assert.equal(calls, 0);
});

test('native notification error falls back to one terminal bell', () => {
  let bells = 0;
  const backend = {
    notify(options, callback) {
      callback(new Error('denied'));
    },
  };
  const notifier = createNotifier({
    enabled: true,
    backend,
    bell() { bells++; },
  });
  notifier.notify({ name: 'Roman', text: 'hi' });
  assert.equal(bells, 1);
});

test('thrown native notification failure falls back once', () => {
  let bells = 0;
  const backend = { notify() { throw new Error('missing backend'); } };
  const notifier = createNotifier({
    enabled: true,
    backend,
    bell() { bells++; },
  });
  assert.equal(notifier.notify({ name: 'Roman', text: 'hi' }), true);
  assert.equal(bells, 1);
});

// A fake Termux child: records the spawn and lets a test fire the process
// events by hand, so nothing real is ever executed.
function fakeSpawn(calls) {
  return (cmd, args, options) => {
    const handlers = {};
    calls.push({ cmd, args, options, handlers });
    return {
      on(event, callback) {
        handlers[event] = callback;
        return this;
      },
      unref() {},
    };
  };
}

// Guards the whole point of the branch: on the phone node-notifier does
// nothing, so a regression here means Termux is silently back to no
// notifications, with the sender and the message in the wrong flags.
test('Termux notification passes sender and text to termux-notification', () => {
  const calls = [];
  let backendCalls = 0;
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() { backendCalls++; } },
    bell() {},
    env: { TERMUX_VERSION: '0.118.0' },
    spawn: fakeSpawn(calls),
  });
  assert.equal(notifier.notify({ name: 'Roman', text: 'привет' }), true);
  assert.equal(backendCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'termux-notification');
  assert.deepEqual(calls[0].args, [
    '--id', 'tailchat',
    '--title', 'Roman',
    '--content', 'привет',
  ]);
  assert.deepEqual(calls[0].options, { stdio: 'ignore' });
});

// The PREFIX form is how Termux looks when TERMUX_VERSION is not exported;
// missing it would leave those sessions without notifications.
test('Termux detected through PREFIX also notifies', () => {
  const calls = [];
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell() {},
    env: { PREFIX: '/data/data/com.termux/files/usr' },
    spawn: fakeSpawn(calls),
  });
  notifier.notify({ name: 'Roman', text: 'hi' });
  assert.equal(calls.length, 1);
});

// The Google Play build ships no Termux:API bridge app, so termux-notification
// exists but silently drops everything. Falling back to the bell — and never
// spawning the doomed process — is the honest behaviour there.
test('Google Play Termux has no API bridge and falls back to the bell', () => {
  const calls = [];
  let bells = 0;
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell: () => { bells++; },
    env: { TERMUX_VERSION: 'googleplay.2026.06.21' },
    spawn: fakeSpawn(calls),
  });
  assert.equal(notifier.termuxNoApi, true);
  notifier.notify({ name: 'Roman', text: 'hi' });
  assert.equal(calls.length, 0, 'termux-notification must not be spawned');
  assert.equal(bells, 1);
});

// A stable id is a promise to the user: a burst replaces one notification
// instead of stacking. Losing the id would bury the phone in entries.
test('every Termux notification reuses one notification id', () => {
  const calls = [];
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell() {},
    env: { TERMUX_VERSION: '0.118.0' },
    spawn: fakeSpawn(calls),
  });
  notifier.notify({ name: 'a', text: '1' });
  calls[0].handlers.exit(0);
  notifier.notify({ name: 'b', text: '2' });
  calls[1].handlers.exit(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[1], calls[1].args[1]);
});

// The notification shade is not a chat window: without the same truncation the
// other platforms use, a pasted wall of text becomes the notification.
test('Termux notification truncates like the desktop backends', () => {
  const calls = [];
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell() {},
    env: { TERMUX_VERSION: '0.118.0' },
    spawn: fakeSpawn(calls),
  });
  const long = 'я'.repeat(400);
  notifier.notify({ name: 'n'.repeat(200), text: long });
  const [, , , title, , content] = calls[0].args;
  assert.equal(content, notificationPreview(long));
  assert.equal(Array.from(content).length, 160);
  assert.equal(Array.from(title).length, 80);
  assert.ok(content.endsWith('…'));
});

// termux-api is optional. An ENOENT must degrade to the bell the desktop path
// already uses, never a crash in the middle of the chat, and must not keep
// forking a doomed process for every later message.
test('missing termux-api rings the bell once and stops spawning', () => {
  const calls = [];
  let bells = 0;
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell() { bells++; },
    env: { TERMUX_VERSION: '0.118.0' },
    spawn: fakeSpawn(calls),
  });
  assert.equal(notifier.notify({ name: 'Roman', text: 'hi' }), true);
  calls[0].handlers.error(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(bells, 1);
  assert.equal(notifier.notify({ name: 'Roman', text: 'again' }), true);
  assert.equal(calls.length, 1);
  assert.equal(bells, 2);
});

// A spawn that throws synchronously (bad exec bit, no fork left) must not take
// the chat down either.
test('throwing spawn on Termux falls back to the bell', () => {
  let bells = 0;
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell() { bells++; },
    env: { TERMUX_VERSION: '0.118.0' },
    spawn() { throw new Error('EAGAIN'); },
  });
  assert.equal(notifier.notify({ name: 'Roman', text: 'hi' }), true);
  assert.equal(bells, 1);
});

// termux-notification also exits non-zero when the API service is not running;
// that is a failed notification, so the user still gets the bell and no throw.
test('non-zero termux-notification exit falls back to the bell', () => {
  const calls = [];
  let bells = 0;
  const notifier = createNotifier({
    enabled: true,
    backend: { notify() {} },
    bell() { bells++; },
    env: { TERMUX_VERSION: '0.118.0' },
    spawn: fakeSpawn(calls),
  });
  notifier.notify({ name: 'Roman', text: 'hi' });
  calls[0].handlers.exit(1);
  assert.equal(bells, 1);
});

// The Termux branch must stay behind the environment check: a Linux desktop
// with termux-notification nowhere on PATH still belongs to node-notifier.
test('non-Termux Linux desktop keeps using the node-notifier backend', () => {
  const calls = [];
  const options = [];
  const notifier = createNotifier({
    enabled: true,
    backend: { notify(o, cb) { options.push(o); cb(null); } },
    bell() {},
    env: { TERM: 'xterm-256color', DISPLAY: ':0' },
    spawn: fakeSpawn(calls),
  });
  notifier.notify({ name: 'Roman', text: 'hi' });
  assert.equal(calls.length, 0);
  assert.equal(options.length, 1);
  assert.equal(options[0].title, 'tailchat · Roman');
});

// Termux is not an exception to --no-notify.
test('disabled notifier never spawns on Termux', () => {
  const calls = [];
  const notifier = createNotifier({
    enabled: false,
    backend: { notify() {} },
    bell() {},
    env: { TERMUX_VERSION: '0.118.0' },
    spawn: fakeSpawn(calls),
  });
  assert.equal(notifier.notify({ name: 'Roman', text: 'hi' }), false);
  assert.equal(calls.length, 0);
});


test('a terminal that cannot report focus still gets notified', () => {
  // Termux answers no focus probe, so `focused` stayed at its initial true for
  // the whole session and the phone never notified once. Unknown focus must mean
  // away, or the feature is dead exactly where it matters most.
  const sent = [];
  const notifier = { notify: ({ name }) => { sent.push(name); return true; } };
  const args = { notifier, name: 'Roman', text: 'привет' };

  assert.equal(notifyIfUnfocused({ ...args, focused: true, tracked: true }), false);
  assert.deepEqual(sent, [], 'looking at the window needs no notification');

  assert.equal(notifyIfUnfocused({ ...args, focused: false, tracked: true }), true);
  assert.equal(notifyIfUnfocused({ ...args, focused: true, tracked: false }), true);
  assert.equal(notifyIfUnfocused({ ...args, focused: false, tracked: false }), true);
  assert.deepEqual(sent, ['Roman', 'Roman', 'Roman']);
});
