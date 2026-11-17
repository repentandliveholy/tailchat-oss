#!/usr/bin/env node
// Supervisor for the client. Node cannot replace its own image, so /update
// cannot exec a new version of itself. The client therefore exits 75
// (EX_TEMPFAIL, "start me again") after an upgrade, and this loop starts the
// new version once the old process is gone — no waiting parent is left behind.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART = 75;

// Resolve the checkout from this script, following the symlink `npm link`
// leaves on PATH — the caller's working directory says nothing about where
// tailchat is installed.
const root = path.dirname(path.dirname(realpathSync(fileURLToPath(import.meta.url))));

// The client reads this to know it is supervised: /update then exits 75 instead
// of spawning a child and waiting (which would pile up idle parents per upgrade).
process.env.TAILCHAT_SUPERVISOR = '1';

const cli = path.join(root, 'src', 'cli.js');
const args = process.argv.slice(2);

function runClient() {
  const nodeBin = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [cli, ...args], { stdio: 'inherit' });
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on('error', () => settle(1));
    child.on('exit', (code, signal) => settle(signal ? 1 : (code ?? 1)));
  });
}

for (;;) {
  const code = await runClient();
  if (code !== RESTART) process.exit(code);
}
