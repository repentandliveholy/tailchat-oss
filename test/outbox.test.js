import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../src/outbox.js';

test('queued messages report their depth', () => {
  const outbox = createOutbox();
  assert.equal(outbox.size(), 0);
  assert.equal(outbox.add('one', 1), 1);
  assert.equal(outbox.add('two', 2), 2);
  assert.equal(outbox.size(), 2);
});

test('flush delivers every message in composition order with its own timestamp', () => {
  const outbox = createOutbox();
  outbox.add('first', 100);
  outbox.add('second', 200);
  outbox.add('third', 300);

  const sent = [];
  const delivered = outbox.flush((text, ts) => {
    sent.push([text, ts]);
    return true;
  });

  assert.equal(delivered, 3);
  assert.deepEqual(sent, [['first', 100], ['second', 200], ['third', 300]]);
  assert.equal(outbox.size(), 0);
});

test('a mid-flush disconnect keeps the undelivered tail queued', () => {
  const outbox = createOutbox();
  outbox.add('a', 1);
  outbox.add('b', 2);
  outbox.add('c', 3);

  const sent = [];
  const delivered = outbox.flush((text) => {
    if (text === 'c') return false; // link dropped again
    sent.push(text);
    return true;
  });

  assert.equal(delivered, 2);
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(outbox.size(), 1);

  // Reconnect: the survivor goes out next, exactly once.
  const resent = [];
  assert.equal(outbox.flush((text) => { resent.push(text); return true; }), 1);
  assert.deepEqual(resent, ['c']);
  assert.equal(outbox.size(), 0);
});

test('flushing an empty outbox is a no-op', () => {
  const outbox = createOutbox();
  let calls = 0;
  assert.equal(outbox.flush(() => { calls++; return true; }), 0);
  assert.equal(calls, 0);
});

test('the queue is bounded and drops the oldest message first', () => {
  const outbox = createOutbox(3);
  for (const n of [1, 2, 3, 4]) outbox.add(`m${n}`, n);

  assert.equal(outbox.size(), 3);
  const sent = [];
  outbox.flush((text) => { sent.push(text); return true; });
  assert.deepEqual(sent, ['m2', 'm3', 'm4'], 'oldest message is discarded');
});

/**
 * Over the cloud a successful write is not the end of a message: the server has
 * to say it committed it (`message-accepted`, the `durable-ack` contract), so
 * the entry has to survive the write and leave only on that receipt — or on the
 * peer's own ack, which proves the same thing. [remove] is that exit, and it
 * names the entry by id because that is what the receipt names.
 */
test('an entry leaves the queue by id, and a duplicate receipt removes nothing twice', () => {
  const outbox = createOutbox();
  outbox.add('first', 100, 'm-1');
  outbox.add('second', 200, 'm-2');

  assert.equal(outbox.remove('m-1'), true);
  assert.deepEqual(outbox.pending(), [{ text: 'second', ts: 200, id: 'm-2' }]);
  assert.equal(outbox.remove('m-1'), false, 'a repeated receipt is not a second removal');
  assert.equal(outbox.remove(''), false);
  assert.equal(outbox.remove(null), false);

  // The survivor is still delivered exactly once by the ordinary path.
  const sent = [];
  assert.equal(outbox.flush((text, ts, id) => { sent.push([text, ts, id]); return true; }), 1);
  assert.deepEqual(sent, [['second', 200, 'm-2']]);
});
