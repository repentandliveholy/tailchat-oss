import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecureStore } from '../src/secure-store.js';
import {
  crashLogFile, crashReport, describeFailure, recordCrash,
  installFatalHandlers, installSignalHandlers, TERMINATION_SIGNALS, CRASH_LOG_LIMIT,
} from '../src/fatal.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-fatal-'));
const store = createSecureStore(crypto.randomBytes(32));

// A fake `process`: the handlers under test must never be installed on the real
// one, or a deliberate failure in one case would take the test runner with it.
function fakeProcess() {
  const handlers = new Map();
  const exits = [];
  return {
    on: (event, handler) => { handlers.set(event, handler); },
    raise: (event, value) => handlers.get(event)?.(value),
    has: (event) => handlers.has(event),
    exits,
    exit: (code) => { exits.push(code); },
  };
}

test('a rejection with no Error still says something usable', () => {
  assert.match(describeFailure(new TypeError('bad shape')), /^TypeError: bad shape$/);
  const coded = Object.assign(new Error('gone'), { code: 'ENOENT' });
  assert.equal(describeFailure(coded), 'Error: gone (ENOENT)');
  assert.match(describeFailure(undefined), /promise rejected with no value/);
  assert.match(describeFailure(null), /promise rejected with no value/);
  assert.equal(describeFailure('just a string'), 'string: just a string');
  assert.equal(describeFailure({ why: 1 }), 'object: {"why":1}');
  const circular = {};
  circular.self = circular;
  assert.equal(describeFailure(circular), 'object: (unserialisable)');
});

test('the report names the version, the platform and the arguments', () => {
  const at = new Date('2026-08-25T10:11:12.000Z');
  const text = crashReport(new Error('boom'), {
    at, kind: 'uncaughtException', version: '0.53.0', platform: 'win32',
    node: 'v22.0.0', argv: ['--peer', 'alice'],
  });
  assert.match(text, /2026-08-25T10:11:12\.000Z ─ uncaughtException/);
  assert.match(text, /tailchat 0\.53\.0 · node v22\.0\.0 · win32/);
  assert.match(text, /argv: --peer alice/);
  assert.match(text, /Error: boom/);
});

test('a value that is not an Error is reported instead of an empty stack', () => {
  const text = crashReport('a bare string', { at: new Date(0) });
  assert.match(text, /string: a bare string/);
});

test('the report lands beside the rest of the state and appends', () => {
  const dir = tempDir();
  const first = recordCrash(dir, new Error('one'), { version: '0.53.0', store });
  const second = recordCrash(dir, new Error('two'), { version: '0.53.0', store });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.file, store.fileFor(crashLogFile(dir)));
  const text = store.read(crashLogFile(dir)).toString('utf8');
  assert.match(text, /Error: one/);
  assert.match(text, /Error: two/);
});

test('a crash loop cannot fill the disk it shares with the transcript', () => {
  const dir = tempDir();
  const file = crashLogFile(dir);
  store.write(file, Buffer.from('x'.repeat(CRASH_LOG_LIMIT)));
  recordCrash(dir, new Error('the newest one'), { store });
  const text = store.read(file).toString('utf8');
  assert.equal(text.includes('x'.repeat(64)), false);
  assert.match(text, /Error: the newest one/);
});

test('a disk that refuses the report says so rather than throwing', () => {
  const result = recordCrash('/nowhere', new Error('boom'), {
    store: { fileFor: (file) => `${file}.enc`, read: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /EROFS/);
});

test('an uncaught exception restores the terminal before it says anything', () => {
  const proc = fakeProcess();
  const dir = tempDir();
  const order = [];
  installFatalHandlers({
    stateDir: dir,
    restore: () => order.push('restore'),
    report: (line) => order.push(`report:${line}`),
    exit: proc.exit,
    on: proc.on,
    streams: [],
    headline: (summary) => summary,
    record: (stateDir, error, options) => recordCrash(stateDir, error, { ...options, store }),
    describe: () => 'saved',
  });
  proc.raise('uncaughtException', new Error('boom'));
  assert.equal(order[0], 'restore', 'the screen is handed back first');
  assert.match(order[1], /Error: boom/);
  assert.deepEqual(proc.exits, [1]);
  assert.match(store.read(crashLogFile(dir)).toString('utf8'), /Error: boom/);
});

test('an unhandled rejection is treated exactly like a throw', () => {
  const proc = fakeProcess();
  const said = [];
  installFatalHandlers({
    stateDir: null,
    restore: () => {},
    report: (line) => said.push(line),
    exit: proc.exit,
    on: proc.on,
    streams: [],
    headline: (summary) => summary,
  });
  proc.raise('unhandledRejection', 'nobody caught me');
  assert.deepEqual(said, ['string: nobody caught me']);
  assert.deepEqual(proc.exits, [1]);
});

test('a teardown that throws does not replace the diagnosis with its own', () => {
  const proc = fakeProcess();
  const said = [];
  installFatalHandlers({
    stateDir: null,
    restore: () => { throw new Error('the screen was already gone'); },
    report: (line) => said.push(line),
    exit: proc.exit,
    on: proc.on,
    streams: [],
    headline: (summary) => summary,
  });
  proc.raise('uncaughtException', new Error('the real cause'));
  assert.deepEqual(said, ['Error: the real cause']);
  assert.deepEqual(proc.exits, [1]);
});

test('a second failure during the first is not reported twice', () => {
  const proc = fakeProcess();
  let restores = 0;
  const { fatal } = installFatalHandlers({
    stateDir: null,
    restore: () => { restores++; },
    report: () => {},
    exit: proc.exit,
    on: proc.on,
    streams: [],
  });
  proc.raise('uncaughtException', new Error('first'));
  fatal(new Error('second'), 'uncaughtException');
  assert.equal(restores, 1);
  assert.deepEqual(proc.exits, [1]);
});

test('a closed pipe is an ending, not a crash', () => {
  const proc = fakeProcess();
  const stream = { handler: null, on(event, fn) { if (event === 'error') this.handler = fn; } };
  const said = [];
  installFatalHandlers({
    stateDir: null,
    restore: () => {},
    report: (line) => said.push(line),
    exit: proc.exit,
    on: proc.on,
    streams: [stream],
  });
  stream.handler(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(proc.exits, [0], 'walking away from a pipe is a success');
  assert.deepEqual(said, [], 'and nothing is written to the pipe that just closed');
});

test('a stream failure that is not a closed pipe is still a crash', () => {
  const proc = fakeProcess();
  const stream = { handler: null, on(event, fn) { if (event === 'error') this.handler = fn; } };
  installFatalHandlers({
    stateDir: null,
    restore: () => {},
    report: () => {},
    exit: proc.exit,
    on: proc.on,
    streams: [stream],
  });
  stream.handler(Object.assign(new Error('device full'), { code: 'ENOSPC' }));
  assert.deepEqual(proc.exits, [1]);
});

test('every way a terminal can ask us to stop is answered', () => {
  const proc = fakeProcess();
  const seen = [];
  const installed = installSignalHandlers((signal) => seen.push(signal), { on: proc.on });
  assert.deepEqual(installed, TERMINATION_SIGNALS);
  // Windows sends no terminal SIGTERM: Ctrl+Break is SIGBREAK and closing the
  // console window is SIGHUP, so both have to be here or a Windows exit is the
  // dirty kind.
  assert.ok(installed.includes('SIGBREAK'));
  assert.ok(installed.includes('SIGHUP'));
  proc.raise('SIGBREAK');
  proc.raise('SIGHUP');
  assert.deepEqual(seen, ['SIGBREAK', 'SIGHUP']);
});

test('a platform that refuses a signal name keeps the rest', () => {
  const seen = [];
  const installed = installSignalHandlers(() => {}, {
    signals: ['SIGINT', 'SIGNOPE', 'SIGTERM'],
    on: (signal) => {
      if (signal === 'SIGNOPE') throw new Error('unknown signal');
      seen.push(signal);
    },
  });
  assert.deepEqual(installed, ['SIGINT', 'SIGTERM']);
  assert.deepEqual(seen, ['SIGINT', 'SIGTERM']);
});
