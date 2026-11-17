import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../src/throttle.js';

test('the first attempt is allowed', () => {
  const throttle = createThrottle(10000, () => 0);
  assert.equal(throttle.tryTake(), true);
});

test('a repeat inside the window is refused', () => {
  let now = 0;
  const throttle = createThrottle(10000, () => now);
  assert.equal(throttle.tryTake(), true);
  now = 9999;
  assert.equal(throttle.tryTake(), false, 'holding the key must not spam the peer');
});

test('the window reopens once it has passed', () => {
  let now = 0;
  const throttle = createThrottle(10000, () => now);
  throttle.tryTake();
  now = 10000;
  assert.equal(throttle.tryTake(), true);
});

test('remaining reports the wait in whole seconds, rounded up', () => {
  let now = 0;
  const throttle = createThrottle(10000, () => now);
  throttle.tryTake();
  now = 1;
  assert.equal(throttle.remainingSeconds(), 10);
  now = 9500;
  assert.equal(throttle.remainingSeconds(), 1);
  now = 10000;
  assert.equal(throttle.remainingSeconds(), 0);
});

test('a refused attempt does not extend the window', () => {
  let now = 0;
  const throttle = createThrottle(10000, () => now);
  throttle.tryTake();
  now = 5000;
  assert.equal(throttle.tryTake(), false);
  now = 10000;
  assert.equal(throttle.tryTake(), true, 'the window is measured from the last success');
});
test('per-key throttling keeps one noisy source from silencing another', () => {
  let now = 0;
  const throttle = createThrottle(60000, () => now);
  const perKey = new Map();
  const allow = (key) => {
    if (!perKey.has(key)) perKey.set(key, createThrottle(60000, () => now));
    return perKey.get(key).tryTake();
  };

  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false, 'the same source stays quiet');
  assert.equal(allow('b'), true, 'a different source is still reported once');

  now = 60000;
  assert.equal(allow('a'), true, 'it speaks up again after the window');
  assert.equal(throttle.tryTake(), true);
});
