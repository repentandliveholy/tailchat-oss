import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  rosterChoices, renderChoices, readChoice, peerMenuRows, ONLINE, OFFLINE, UNKNOWN,
} from '../src/picker.js';

const t = (key, params = {}) => {
  const table = {
    'pick.title': 'who do you want to talk to?',
    'pick.legend': 'the dot is the device, not tailchat itself',
    'pick.prompt': 'number: ',
    'pick.online': 'device online',
    'pick.offline': 'no device online',
    'pick.unknown': 'cannot tell',
    'pick.blocked': 'blocked',
    'pick.badChoice': `pick 1..${params.count}`,
  };
  return table[key] ?? key;
};

test('a roster entry with a live device is offered as online', () => {
  const choices = rosterChoices({
    selectors: [{ login: 'roman@example.com', names: [], devices: ['lit'] }],
    status: { peers: [{ login: 'roman@example.com', online: true, sharee: false }] },
  });
  assert.deepEqual(choices, [
    { login: 'roman@example.com', state: ONLINE, devices: ['lit'] },
  ]);
});

test('one live device among several makes the person reachable', () => {
  // Reaching the person is what matters; which laptop answers is the client's
  // problem, not something to make the reader work out from a list.
  const choices = rosterChoices({
    selectors: [{ login: 'a@x', devices: ['one', 'two'] }],
    status: {
      peers: [
        { login: 'a@x', online: false, sharee: false },
        { login: 'a@x', online: true, sharee: false },
      ],
    },
  });
  assert.equal(choices[0].state, ONLINE);
});

test('absent from the status is unknown, never offline', () => {
  // A shared-in node or a person outside this tailnet cannot be judged from
  // here, and printing them as offline would be a guess dressed as a fact.
  const choices = rosterChoices({
    selectors: [{ login: 'ghost@x', devices: [] }],
    status: { peers: [{ login: 'someone@else', online: true, sharee: false }] },
  });
  assert.equal(choices[0].state, UNKNOWN);
});

test('without the tailscale CLI nothing is claimed about anyone', () => {
  const choices = rosterChoices({
    selectors: [{ login: 'a@x', devices: [] }, { login: 'b@x', devices: [] }],
    status: null,
  });
  assert.deepEqual(choices.map((c) => c.state), [UNKNOWN, UNKNOWN]);
});

test('a sharee placeholder never counts as a live device', () => {
  const choices = rosterChoices({
    selectors: [{ login: 'a@x', devices: [] }],
    status: { peers: [{ login: 'a@x', online: true, sharee: true }] },
  });
  assert.equal(choices[0].state, UNKNOWN, 'a placeholder is not a machine to dial');
});

test('reachable people come first, and the order is stable within a group', () => {
  // The numbering must not dance between runs, or muscle memory dials the wrong
  // person.
  const choices = rosterChoices({
    selectors: [
      { login: 'zoe@x', devices: [] },
      { login: 'adam@x', devices: [] },
      { login: 'live@x', devices: [] },
      { login: 'off@x', devices: [] },
    ],
    status: {
      peers: [
        { login: 'live@x', online: true, sharee: false },
        { login: 'off@x', online: false, sharee: false },
        { login: 'zoe@x', online: false, sharee: false },
      ],
    },
  });
  assert.deepEqual(choices.map((c) => c.login), ['live@x', 'adam@x', 'off@x', 'zoe@x']);
});

test('the rendered list numbers every choice and states what the dot means', () => {
  const choices = rosterChoices({
    selectors: [{ login: 'a@x', devices: ['lit'] }],
    status: { peers: [{ login: 'a@x', online: true, sharee: false }] },
  });
  const text = renderChoices(choices, t).join('\n');
  assert.match(text, /1 {2}a@x {2}● device online {2}lit/);
  assert.match(text, /the dot is the device, not tailchat itself/);
});

const choiceIO = (typed) => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const written = [];
  output.on('data', (chunk) => written.push(String(chunk)));
  for (const line of typed) input.write(`${line}\n`);
  return { input, output, written };
};

test('a number picks the login on that row', async () => {
  const choices = [{ login: 'first@x' }, { login: 'second@x' }];
  const { input, output } = choiceIO(['2']);
  assert.equal(await readChoice(choices, { input, output, t }), 'second@x');
});

test('an empty line cancels instead of dialling someone at random', async () => {
  const choices = [{ login: 'first@x' }];
  const { input, output } = choiceIO(['']);
  assert.equal(await readChoice(choices, { input, output, t }), null);
});

test('a number nobody offered asks again rather than giving up', async () => {
  const choices = [{ login: 'first@x' }, { login: 'second@x' }];
  const { input, output, written } = choiceIO(['9', 'x', '1']);
  assert.equal(await readChoice(choices, { input, output, t }), 'first@x');
  assert.equal(written.join('').match(/pick 1\.\.2/g)?.length, 2, 'both bad answers were refused');
});

test('input that ends without an answer cancels instead of hanging', async () => {
  // `tailchat < /dev/null` and a closed pipe must not leave the process waiting
  // on a prompt nobody will ever answer.
  const choices = [{ login: 'first@x' }];
  const { input, output } = choiceIO([]);
  input.end();
  assert.equal(await readChoice(choices, { input, output, t }), null);
});
test('peerMenuRows feeds the app menu a login and a status tail', () => {
  const rows = peerMenuRows([
    { login: 'a@x', state: ONLINE, devices: ['lit'] },
    { login: 'b@x', state: OFFLINE, devices: [] },
    { login: 'c@x', state: UNKNOWN, devices: ['ghost'] },
  ], t);
  assert.deepEqual(rows, [
    { name: 'a@x', help: '● device online — lit' },
    { name: 'b@x', help: '○ no device online' },
    { name: 'c@x', help: '? cannot tell — ghost' },
  ]);
});

test('peerMenuRows marks a blocked contact without hiding it from the list', () => {
  const rows = peerMenuRows([
    { login: 'a@x', state: ONLINE, devices: ['lit'], blocked: true },
    { login: 'b@x', state: OFFLINE, devices: [] },
  ], t);
  assert.deepEqual(rows, [
    { name: 'a@x', help: '🚫 blocked — ● device online — lit' },
    { name: 'b@x', help: '○ no device online' },
  ]);
});
