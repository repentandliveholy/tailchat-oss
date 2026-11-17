import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDeviceStore } from '../src/secure-store.js';
// Every other test in this suite imports a module and calls into it, which means
// none of them ever runs `main()`. That gap is not theoretical: an import
// accidentally dropped from cli.js leaves the whole unit suite green and fails
// the moment a person starts the client, because a module-scope name that is
// never imported is a ReferenceError at the line that uses it rather than a link
// error at load. So this starts the real client, as a real process, and watches
// the terminal it writes to.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// A chat that has drawn itself has, by definition, got through argument parsing,
// the config, the state directory, the transcript, the focus probe, the whole of
// the interface and the rendezvous. Waiting for the escape sequence is waiting
// for all of that at once.
function waitFor(state, needle, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (state.out.includes(needle)) {
        clearInterval(timer);
        resolve(Date.now() - started);
      } else if (state.exited) {
        clearInterval(timer);
        reject(new Error(`the client exited before it drew anything:\n${state.out}`));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`nothing drawn within ${timeoutMs}ms:\n${state.out}`));
      }
    }, 50);
  });
}

test('the real client starts, holds the port, and gives back a clean terminal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-smoke-'));
  // The first-run wizard would otherwise wait for an answer that never comes.
  fs.writeFileSync(path.join(dir, 'config.json'), '{"lang":"en","log":false}\n');
  const port = await freePort();

  const child = spawn(process.execPath, [
    path.join('src', 'cli.js'), '100.64.0.9',
    '--state-dir', dir,
    '--files-dir', path.join(dir, 'files'),
    '--bind', '127.0.0.1',
    '--port', String(port),
    '--no-notify', '--no-log',
  ], { cwd: root, env: { ...process.env, TERM: 'xterm-256color' } });

  const state = { out: '', exited: false };
  // 'binary' keeps the escape bytes intact: this test is about what the terminal
  // was told, not about what a reader would have seen.
  child.stdout.on('data', (chunk) => { state.out += chunk.toString('binary'); });
  child.stderr.on('data', (chunk) => { state.out += chunk.toString('binary'); });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => { state.exited = true; resolve({ code, signal }); });
  });

  try {
    await waitFor(state, ALT_SCREEN_ON, 15000);

    // The listener note is what stops a second client on this machine from
    // dialling in parallel, and a note outliving its process is what used to
    // leave the next conversation permanently dead.
    const heldNote = () => fs.readdirSync(dir).filter((name) => name.startsWith('listener-'));
    const deadline = Date.now() + 5000;
    while (heldNote().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(
      heldNote().sort(),
      [`listener-${port}.peer`, `listener-${port}.pid`],
      'a listening client records the port it holds and the conversation it holds it for',
    );

    // SIGHUP is how a closing console window reaches us — on Windows it is the
    // only way it does, and it went unhandled until the signal set was completed.
    child.kill('SIGHUP');
    const { code, signal } = await exited;
    assert.equal(signal, null, 'the client shut itself down rather than being killed');
    assert.equal(code, 0);

    assert.deepEqual(heldNote(), [], 'the note is gone, so the next client may take the port');
    assert.ok(state.out.includes(ALT_SCREEN_OFF), 'the alternate screen was handed back');
    assert.ok(state.out.includes('\x1b[?1000l'), 'mouse reporting was turned off');
    assert.ok(state.out.includes('\x1b[?2004l'), 'bracketed paste was turned off');
    assert.ok(state.out.includes('\x1b[?25h'), 'the cursor was made visible again');
  } finally {
    if (!state.exited) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unexpected failure leaves a crash report and a usable terminal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-crash-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"lang":"en","log":false}\n');
  const probe = path.join(dir, 'probe.mjs');
  const cli = path.join(root, 'src', 'cli.js').replaceAll('\\', '/');
  const port = await freePort();
  // Imports the real client and throws from a timer once it is running: the
  // shape of any unexpected failure mid-session, and the one case where the
  // terminal used to be left in raw mode on the alternate screen with the
  // listener note still on disk.
  fs.writeFileSync(probe, [
    `import { main } from 'file://${cli}';`,
    "setTimeout(() => { throw new Error('smoke: forced mid-session failure'); }, 1500);",
    'main();',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [
    probe, '100.64.0.9',
    '--state-dir', dir,
    '--files-dir', path.join(dir, 'files'),
    '--bind', '127.0.0.1',
    '--port', String(port),
    '--no-notify', '--no-log',
  ], { cwd: root, env: { ...process.env, TERM: 'xterm-256color' } });

  const state = { out: '', exited: false };
  child.stdout.on('data', (chunk) => { state.out += chunk.toString('binary'); });
  child.stderr.on('data', (chunk) => { state.out += chunk.toString('binary'); });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => { state.exited = true; resolve({ code, signal }); });
  });

  try {
    await waitFor(state, ALT_SCREEN_ON, 15000);
    const { code, signal } = await exited;
    assert.equal(signal, null, 'the process ended itself instead of dying to a signal');
    assert.equal(code, 1, 'and it said so with a failing exit code');

    assert.ok(state.out.includes(ALT_SCREEN_OFF), 'the screen was handed back before reporting');
    assert.ok(state.out.includes('\x1b[?2004l'), 'bracketed paste was turned off');
    assert.match(state.out, /tailchat stopped: Error: smoke: forced mid-session failure/);
    assert.match(state.out, /crash\.log/, 'and it said where to read the rest');

    const report = openDeviceStore().read(path.join(dir, 'crash.log')).toString('utf8');
    assert.match(report, /uncaughtException/);
    assert.match(report, /smoke: forced mid-session failure/);
    assert.match(report, /at Timeout/, 'the stack, not just the message');

    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.startsWith('listener-')),
      [],
      'a crash leaves no note to turn the next client away from its own port',
    );
  } finally {
    if (!state.exited) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
