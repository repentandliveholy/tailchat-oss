import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceSignal, readPresenceState, IDLE_AFTER_MS, AWAY_AFTER_MS } from '../src/presence.js';

function harness({ idleMs = 30000, awayMs = 300000, noAway = false } = {}) {
  const sent = [];
  let now = 0;
  const timers = [];
  const signal = createPresenceSignal({
    send: (state) => sent.push(state),
    idleMs,
    awayMs,
    noAway,
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

test('losing focus reports idle, not away', () => {
  const { sent, signal } = harness();
  signal.blur();
  assert.deepEqual(sent, ['idle'], 'a glance at another window is not an absence');
});

test('staying unfocused long enough escalates to away', () => {
  const { sent, signal, advance } = harness({ awayMs: 300000 });
  signal.blur();
  advance(299999);
  assert.deepEqual(sent, ['idle'], 'not away one millisecond early');
  advance(1);
  assert.deepEqual(sent, ['idle', 'away']);
});

test('coming back cancels a pending away', () => {
  const { sent, signal, advance } = harness({ idleMs: 600000, awayMs: 300000 });
  signal.blur();
  advance(100000);
  signal.focus();
  advance(500000);
  assert.deepEqual(sent, ['idle', 'active'], 'away must never fire after a return');
});

test('a focused window with no input turns idle, then away', () => {
  // ACTIVE used to mean "the window is in front"; a reading human and a closed
  // laptop are the same to the peer. Idle must come from silence, not from blur.
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 100000 });
  signal.focus();
  advance(29999);
  assert.deepEqual(sent, [], 'active until the idle threshold');
  advance(1);
  assert.deepEqual(sent, ['idle']);
  advance(100000);
  assert.deepEqual(sent, ['idle', 'away']);
});

test('noAway caps presence at idle: a focus-blind terminal never reports away', () => {
  // Termux cannot report focus, so "not typing" is the only signal there is:
  // a person reading a chat must not be shown as having left. Idle is the
  // honest ceiling.
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 100000, noAway: true });
  signal.focus();
  advance(30000);
  assert.deepEqual(sent, ['idle']);
  advance(100000);
  assert.deepEqual(sent, ['idle'], 'away must never fire');
});

test('a key press or mouse move restarts the idle clock', () => {
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 100000 });
  signal.focus();
  advance(20000);
  signal.activity();
  advance(20000);
  assert.deepEqual(sent, [], 'activity pushed the idle threshold out');
  advance(10000);
  assert.deepEqual(sent, ['idle']);
});

test('activity while already idle brings the person back to active', () => {
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 100000 });
  signal.focus();
  advance(30000);
  assert.deepEqual(sent, ['idle']);
  signal.activity();
  assert.deepEqual(sent, ['idle', 'active']);
});

test('activity in a blurred window is ignored', () => {
  // Mouse events can linger after blur; a background window must not claim active.
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 100000 });
  signal.blur();
  signal.activity();
  advance(100000);
  assert.deepEqual(sent, ['idle', 'away'], 'blur already reported idle');
});

test('repeated events of the same state are not resent', () => {
  const { sent, signal } = harness({ idleMs: 600000 });
  signal.focus();
  signal.focus();
  signal.blur();
  signal.blur();
  assert.deepEqual(sent, ['idle'], 'active was already the starting state');
});

test('returning after away reports active again', () => {
  const { sent, signal, advance } = harness({ idleMs: 600000, awayMs: 1000 });
  signal.blur();
  advance(1000);
  signal.focus();
  assert.deepEqual(sent, ['idle', 'away', 'active']);
});

test('current() reflects the reported state', () => {
  const { signal, advance } = harness({ idleMs: 30000, awayMs: 1000 });
  assert.equal(signal.current(), 'active');
  signal.blur();
  assert.equal(signal.current(), 'idle');
  advance(1000);
  assert.equal(signal.current(), 'away');
});

test('destroy cancels every pending escalation', () => {
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 1000 });
  signal.focus();
  signal.destroy();
  advance(5000);
  assert.deepEqual(sent, []);
});

test('setAwayMs reschedules an away timer already counting down', () => {
  const { sent, signal, advance } = harness({ awayMs: 300000 });
  signal.blur(); // idle now, away armed for +300000
  advance(299000); // one second short of the original deadline
  assert.deepEqual(sent, ['idle']);
  signal.setAwayMs(600000); // stretched out before it fired
  advance(1000); // past the original deadline, which no longer applies
  assert.deepEqual(sent, ['idle'], 'the old, shorter deadline was cancelled');
  advance(599000); // up to the new deadline, measured from the change
  assert.deepEqual(sent, ['idle', 'away']);
});

test('setAwayMs with nothing counting toward away only affects the next escalation', () => {
  const { sent, signal, advance } = harness({ idleMs: 30000, awayMs: 300000 });
  signal.focus(); // arms the idle clock; still nothing counting toward away
  signal.setAwayMs(600000); // changed while still active
  assert.deepEqual(sent, [], 'changing the setting alone reports nothing');
  advance(30000); // idle fires on schedule, arming away at the new length
  assert.deepEqual(sent, ['idle']);
  advance(300000); // the old length would have escalated by now
  assert.deepEqual(sent, ['idle'], 'the new, longer length is the one that took effect');
  advance(300000);
  assert.deepEqual(sent, ['idle', 'away']);
});

test('the idle and away thresholds are real constants', () => {
  assert.equal(IDLE_AFTER_MS, 30000);
  assert.equal(AWAY_AFTER_MS, 300000);
});

test('readPresenceState accepts the three states and rejects anything else', () => {
  assert.equal(readPresenceState('active'), 'active');
  assert.equal(readPresenceState('idle'), 'idle');
  assert.equal(readPresenceState('away'), 'away');
  // A 0.10.x peer only knew "inactive"; idle is the honest reading of it.
  assert.equal(readPresenceState('inactive'), 'idle');
  assert.equal(readPresenceState('nonsense'), null);
  assert.equal(readPresenceState(undefined), null);
});
