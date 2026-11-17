import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayRoom, normalizeGatewayName } from '../src/gateway-core.js';

function deterministicRoom() {
  let nextId = 0;
  let now = 1000;
  return new GatewayRoom({
    idFactory: () => `client-${++nextId}`,
    now: () => ++now,
  });
}

function join(room, name) {
  const events = [];
  const connection = room.connect((event) => events.push(event));
  connection.receive({ type: 'hello', name });
  return { connection, events };
}

function lastEvent(client, type) {
  return [...client.events].reverse().find((event) => event.type === type);
}

test('two gateway clients pair and receive the same message with correct ownership', () => {
  const room = deterministicRoom();
  const anna = join(room, 'Анна');
  const boris = join(room, 'Борис');

  anna.connection.receive({ type: 'peer', peer: 'Борис' });
  assert.deepEqual(lastEvent(anna, 'paired').peer, { id: 'client-2', name: 'Борис' });
  assert.deepEqual(lastEvent(boris, 'paired').peer, { id: 'client-1', name: 'Анна' });

  anna.connection.receive({ type: 'message', text: '  Мир вам  ' });
  assert.deepEqual(lastEvent(anna, 'message'), {
    type: 'message',
    from: { id: 'client-1', name: 'Анна' },
    text: 'Мир вам',
    at: 1001,
    own: true,
  });
  assert.equal(lastEvent(boris, 'message').own, false);
  assert.equal(lastEvent(boris, 'message').text, 'Мир вам');
});

test('presence marks paired users busy and releases the peer after disconnect', () => {
  const room = deterministicRoom();
  const anna = join(room, 'Анна');
  const boris = join(room, 'Борис');
  const vera = join(room, 'Вера');

  anna.connection.receive({ type: 'peer', peer: 'client-2' });
  const visibleToVera = lastEvent(vera, 'users').users;
  assert.deepEqual(visibleToVera.map(({ name, busy }) => [name, busy]), [
    ['Анна', true],
    ['Борис', true],
  ]);

  anna.connection.close();
  assert.match(lastEvent(boris, 'unpaired').reason, /отключился/);
  assert.deepEqual(lastEvent(boris, 'users').users, [{ id: 'client-3', name: 'Вера', busy: false }]);
});

test('a busy peer cannot be taken by a third client', () => {
  const room = deterministicRoom();
  const anna = join(room, 'Анна');
  join(room, 'Борис');
  const vera = join(room, 'Вера');

  anna.connection.receive({ type: 'peer', peer: 'Борис' });
  vera.connection.receive({ type: 'peer', peer: 'Борис' });

  assert.equal(lastEvent(vera, 'error').code, 'peer_busy');
  assert.equal(lastEvent(vera, 'paired'), undefined);
});

test('names are cleaned, kept readable and made unique', () => {
  assert.equal(normalizeGatewayName('  Мать   Мария<script>  '), 'Мать Марияscript');

  const room = deterministicRoom();
  const first = join(room, 'Гость');
  const second = join(room, 'гость');
  assert.equal(lastEvent(first, 'welcome').self.name, 'Гость');
  assert.equal(lastEvent(second, 'welcome').self.name, 'гость-2');
});

test('messages require an active peer and have a hard size limit', () => {
  const room = deterministicRoom();
  const anna = join(room, 'Анна');

  anna.connection.receive({ type: 'message', text: 'Одна' });
  assert.equal(lastEvent(anna, 'error').code, 'not_paired');

  const boris = join(room, 'Борис');
  anna.connection.receive({ type: 'peer', peer: 'Борис' });
  anna.connection.receive({ type: 'message', text: 'x'.repeat(4001) });
  assert.equal(lastEvent(anna, 'error').code, 'message_too_long');
  assert.equal(lastEvent(boris, 'message'), undefined);
});
