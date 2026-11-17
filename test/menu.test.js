import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runListMenu } from '../src/menu.js';

test('runListMenu: 1 down arrow moves exactly 1 item down without skipping', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const rows = [
    { name: 'Alice', value: 'alice' },
    { name: 'Bob', value: 'bob' },
    { name: 'Charlie', value: 'charlie' },
    { name: 'David', value: 'david' },
  ];

  const promise = runListMenu({ rows, input, output });

  // 1 Down arrow must select Bob (index 1), not Charlie (index 2)
  input.write('\x1b[B');
  input.write('\r');

  const result = await promise;
  assert.equal(result, 'bob', '1 down arrow must navigate to the immediately adjacent item');
});

test('runListMenu: 1 up arrow moves exactly 1 item up without skipping', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const rows = [
    { name: 'Alice', value: 'alice' },
    { name: 'Bob', value: 'bob' },
    { name: 'Charlie', value: 'charlie' },
  ];

  const promise = runListMenu({ rows, input, output });

  // Down twice, then up once -> must be Bob
  input.write('\x1b[B');
  input.write('\x1b[B');
  input.write('\x1b[A');
  input.write('\r');

  const result = await promise;
  assert.equal(result, 'bob');
});

test('runListMenu: digit selection directly picks the row', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const rows = [
    { name: 'Alice', value: 'alice' },
    { name: 'Bob', value: 'bob' },
    { name: 'Charlie', value: 'charlie' },
  ];

  const promise = runListMenu({ rows, input, output });
  input.write('3');

  const result = await promise;
  assert.equal(result, 'charlie');
});
