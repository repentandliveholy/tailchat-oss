#!/usr/bin/env node
// A headless tailchat peer built from the real src/ modules, so the Android
// client is tested against the production protocol rather than a second
// implementation of it. Events go to stdout as JSON lines; commands arrive on
// stdin the same way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startRendezvous } from '../../src/rendezvous.js';
import { createFileReceiver } from '../../src/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(`--${flag}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const peerHost = arg('peer-host', '127.0.0.1');
const peerPort = Number(arg('peer-port', '0'));
const port = Number(arg('port', '0'));
const bindAddr = arg('bind', '127.0.0.1');
const name = arg('name', 'node-peer');
const filesDir = arg('files-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-peer-')));

const rz = startRendezvous({ peerHost, peerPort, bindAddr, port, name });
const receiver = createFileReceiver({ dir: filesDir });

const forward = [
  'offline', 'message', 'ai', 'ack', 'read', 'typing', 'focus', 'wake', 'logo',
  'caps', 'update', 'devices', 'bye', 'inbound', 'reaching', 'status',
  'unresolved', 'port-taken', 'took-over',
];
for (const ev of forward) rz.on(ev, (payload = {}) => out({ ev, ...payload }));
rz.on('online', (payload) => out({ ev: 'online', ...payload, boundPort: rz.boundPort() }));

rz.on('file-offer', (frame) => {
  const result = receiver.offer(frame);
  if (!result.accepted) {
    rz.sendFrame({ t: 'file-deny', id: frame.id, reason: result.reason });
    out({ ev: 'file-refused', reason: result.reason });
    return;
  }
  out({ ev: 'file-offer', id: frame.id, name: result.name, size: frame.size });
});
rz.on('file-chunk', (frame) => {
  const result = receiver.chunk(frame);
  if (!result.ok) out({ ev: 'file-error', reason: result.reason });
});
rz.on('file-done', (frame) => {
  const result = receiver.done(frame);
  if (!result.ok) out({ ev: 'file-error', reason: result.reason });
  else out({ ev: 'file-done', path: result.path, size: result.size });
});
rz.on('file-deny', (frame) => out({ ev: 'file-deny', reason: frame.reason ?? '' }));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let cmd;
  try {
    cmd = JSON.parse(text);
  } catch {
    out({ ev: 'bad-command', line: text });
    return;
  }
  switch (cmd.cmd) {
    case 'send':
      out({ ev: 'sent', id: rz.send(cmd.text, cmd.ts ?? Date.now(), cmd.id) });
      break;
    case 'receipt':
      out({ ev: 'receipt-sent', ok: rz.sendReceipt(cmd.kind, cmd.id) });
      break;
    case 'frame':
      out({ ev: 'frame-sent', ok: rz.sendFrame(cmd.frame) });
      break;
    case 'target':
      out({ ev: 'retargeted', target: rz.setTarget(cmd.host, cmd.port) });
      break;
    case 'quit':
      rz.stop();
      out({ ev: 'stopped' });
      process.exit(0);
      break;
    default:
      out({ ev: 'unknown-command', cmd: cmd.cmd });
  }
});

out({ ev: 'ready', port, peerPort, filesDir, root: here });
