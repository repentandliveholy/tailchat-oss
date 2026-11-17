// The peer half of `crates/tailchat-net/examples/live_smoke.rs`: a second
// account on a real (isolated) cloud server that acknowledges what the driver
// sends and, while it is stopped, writes a few messages of its own.
//
// Not a test and not part of `npm test` (everything under `test/` is run by
// `node --test`): a throwaway client for one live check.
//
// Environment:
//   SMOKE_SOCKET  ws://127.0.0.1:PORT/tailchat/ws
//   SMOKE_LOGIN   bob (this account)
//   SMOKE_TOKEN   64 hex characters
//   SMOKE_PEER    alice (the account the driver runs)
//   SMOKE_SEND    how many messages to write while the driver is stopped (3)
//   SMOKE_DELAY   ms between the acknowledgement and the first of them (1500)
//   SMOKE_ON_START 1 to write them without waiting for a message first
//                 (the driver is stopped: nothing to acknowledge)
//
// Usage: node examples/peer.mjs   (then, or alongside, the Rust example)

import WebSocket from 'ws';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

const socketUrl = env('SMOKE_SOCKET');
const login = env('SMOKE_LOGIN');
const token = env('SMOKE_TOKEN');
const peer = env('SMOKE_PEER');
const send = Number.parseInt(env('SMOKE_SEND', '3'), 10);
const delay = Number.parseInt(env('SMOKE_DELAY', '1500'), 10);
const onStart = env('SMOKE_ON_START', '0') === '1';

const ws = new WebSocket(socketUrl);
const at = () => Date.now();
const say = (line) => process.stdout.write(`peer: ${line}\n`);

let acked = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ k: 'auth', token, caps: ['durable-ack', 'addressed-send'] }));
});

ws.on('message', (raw) => {
  let frame;
  try {
    frame = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (frame.k === 'ready') {
    say(`ready as ${frame.self?.login ?? login}`);
    // Receipts and live messages only reach a socket subscribed to the
    // conversation (`hub.js` deliverFrame).
    ws.send(JSON.stringify({ k: 'subscribe', peer }));
    if (onStart) write();
    return;
  }
  if (frame.k === 'error') {
    say(`error ${frame.code}`);
    return;
  }
  if (frame.k !== 'frame' || frame.from !== peer || !frame.d) return;
  const d = frame.d;
  if (d.t === 'msg' && !acked) {
    acked = true;
    say(`got ${d.id}: ${JSON.stringify(d.text)}`);
    // ✓✓ for the driver: this device holds the message.
    ws.send(
      JSON.stringify({ k: 'frame', to: peer, d: { t: 'ack', id: d.id, deliveredTs: d.ts } }),
    );
    say('acked');
    setTimeout(write, delay);
  }
});

function write() {
      for (let n = 1; n <= send; n += 1) {
        const id = `peer-${at()}-${n}`;
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              k: 'frame',
              to: peer,
              d: { t: 'msg', id, ts: at(), text: `while you were out ${n}` },
            }),
          );
          say(`sent ${id}`);
          if (n === send) {
            setTimeout(() => {
              say('done');
              ws.close();
            }, 1500);
          }
        }, (n - 1) * 300);
      }
}

ws.on('close', () => say('closed'));
ws.on('error', (error) => {
  say(`socket error: ${error.message}`);
  process.exitCode = 1;
});
