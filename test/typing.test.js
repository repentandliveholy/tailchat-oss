import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTypingSignal } from '../src/typing.js';

function harness({ throttleMs = 2000, idleMs = 3000 } = {}) {
  const sent = [];
  let now = 0;
  const timers = [];
  const signal = createTypingSignal({
    send: (state) => sent.push(state),
    throttleMs,
    idleMs,
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cancelled = true; },
  });
  const advance = (ms) => {
    now += ms;
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  };
  return { sent, signal, advance };
}

test('the first keystroke announces typing', () => {
  const { sent, signal } = harness();
  signal.keystroke();
  assert.deepEqual(sent, ['start']);
});

test('rapid keystrokes are throttled to one announcement', () => {
  const { sent, signal, advance } = harness({ throttleMs: 2000 });
  signal.keystroke();
  advance(100);
  signal.keystroke();
  advance(100);
  signal.keystroke();
  assert.deepEqual(sent, ['start'], 'the wire must not carry every keypress');
});

test('typing is re-announced once the throttle window passes', () => {
  const { sent, signal, advance } = harness({ throttleMs: 2000, idleMs: 10000 });
  signal.keystroke();
  advance(2500);
  signal.keystroke();
  assert.deepEqual(sent, ['start', 'start']);
});

test('going idle stops the indicator without any keystroke', () => {
  const { sent, signal, advance } = harness({ idleMs: 3000 });
  signal.keystroke();
  advance(3000);
  assert.deepEqual(sent, ['start', 'stop']);
});

test('sending a message stops the indicator immediately and only once', () => {
  const { sent, signal } = harness();
  signal.keystroke();
  signal.stop();
  signal.stop();
  assert.deepEqual(sent, ['start', 'stop']);
});

test('an idle timer that already fired does not emit a second stop', () => {
  const { sent, signal, advance } = harness({ idleMs: 3000 });
  signal.keystroke();
  advance(3000);
  signal.stop();
  assert.deepEqual(sent, ['start', 'stop']);
});

test('stop without any typing says nothing', () => {
  const { sent, signal } = harness();
  signal.stop();
  assert.deepEqual(sent, []);
});

test('destroy cancels the pending idle timer', () => {
  const { sent, signal, advance } = harness({ idleMs: 3000 });
  signal.keystroke();
  signal.destroy();
  advance(5000);
  assert.deepEqual(sent, ['start'], 'no stop fires after teardown');
});
