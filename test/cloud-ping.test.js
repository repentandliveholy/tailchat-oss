import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadPongMatcher() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const match = source.match(/function matchesPendingPong\(pending, from, frame\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'web ping matcher exists');
  return vm.runInNewContext(`${match[0]}\nmatchesPendingPong;`, { Object });
}

test('legacy web pong completes only its peer’s pending ping', () => {
  const matchesPendingPong = loadPongMatcher();
  const pending = { id: 'ping-123', peer: 'roman' };

  assert.equal(matchesPendingPong(pending, 'roman', { t: 'pong', id: 'ping-123' }), true);
  assert.equal(matchesPendingPong(pending, 'roman', { t: 'pong' }), true, 'pre-0.81d peer omits id');
  assert.equal(matchesPendingPong(pending, 'roman', { t: 'pong', id: 'wrong' }), false);
  assert.equal(matchesPendingPong(pending, 'intruder', { t: 'pong' }), false);
  assert.equal(matchesPendingPong(pending, 'intruder', { t: 'pong', id: 'ping-123' }), false);
});
