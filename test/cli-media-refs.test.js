// The terminal's half of docs/specs/2026-11-03-history-media-refs.md: it asks
// history for references, keeps them as attachments, and fetches the bytes
// from `/api/media` under a progress watchdog instead of the 8-second deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import { createCloudApi, CloudApiError } from '../src/cloud/api.js';
import { frameAttachment, isMediaRefShape } from '../src/cloud/media-ref.js';
import { messageMediaKind } from '../src/cli.js';

const PICTURE = randomBytes(5000);
const DATA_URL = `data:image/png;base64,${PICTURE.toString('base64')}`;

async function startService(context) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cli-media-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cli-media-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>\n');
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  const hub = createCloudHub({ store });
  const service = createCloudService({
    host: '127.0.0.1', port: 0, dataDir, webRoot, store, hub, trustProxy: false, ownerLogin: null, mediaLog: () => {},
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { store, server: `http://127.0.0.1:${address.port}` };
}

async function friends(server) {
  const olga = createCloudApi({ server });
  await olga.register({ login: 'olga', password: 'correct horse', name: 'olga' });
  const roman = createCloudApi({ server });
  await roman.register({ login: 'roman', password: 'correct horse', name: 'roman' });
  await roman.acceptInvite(await olga.createInvite());
  return { olga, roman };
}

test('history asks for references only when told to, and reads them as attachments', async (context) => {
  const { store, server } = await startService(context);
  const { roman } = await friends(server);
  store.recordHistory('olga', 'roman', { id: 'p-1', from: 'olga', text: '', ts: 1_756_900_000_000, image: { dataUrl: DATA_URL, width: 4, height: 3 } });

  const inline = await roman.history('olga', 50);
  assert.equal(inline.find((m) => m.id === 'p-1').image.dataUrl, DATA_URL, 'no option: bytes, as before');
  const refs = await roman.history('olga', 50, { media: 'ref' });
  const ref = refs.find((m) => m.id === 'p-1').image;
  assert.deepEqual(ref, { mime: 'image/png', size: PICTURE.length, width: 4, height: 3 });
  assert.equal(isMediaRefShape(ref), true);
  assert.equal(messageMediaKind(ref, undefined), 'image', 'the row is a picture either way');

  const fetched = await roman.media({ peer: 'olga', id: 'p-1', slot: 'image' });
  assert.equal(fetched.mime, 'image/png');
  assert.equal(Buffer.compare(fetched.bytes, PICTURE), 0);
});

test('a refused download carries the server\'s code and status, so 410 can stay quiet', async (context) => {
  const { store, server } = await startService(context);
  const { roman } = await friends(server);
  store.recordHistory('olga', 'roman', { id: 'gone-1', from: 'olga', text: 'x', ts: 1_756_900_000_000, mediaDropped: true });
  await assert.rejects(
    roman.media({ peer: 'olga', id: 'gone-1', slot: 'image' }),
    (error) => error instanceof CloudApiError && error.status === 410 && error.code === 'media_evicted',
  );
  await assert.rejects(
    roman.media({ peer: 'olga', id: 'nope', slot: 'image' }),
    (error) => error.status === 404,
  );
});

test('a download that stops moving fails after the stall window, not after a fixed deadline', async () => {
  let aborted = false;
  const fetchImpl = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'audio/webm' },
    body: {
      async* [Symbol.asyncIterator]() {
        yield new Uint8Array([1, 2, 3]);
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        });
      },
    },
  });
  const api = createCloudApi({ server: 'http://x.test', token: 't', fetchImpl });
  const started = Date.now();
  await assert.rejects(api.media({ peer: 'olga', id: 'v', slot: 'voice' }, { stallMs: 60 }), { code: 'unreachable' });
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 2000);

  // Progress keeps it alive well past the window.
  const slow = createCloudApi({
    server: 'http://x.test',
    token: 't',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/webm' },
      body: {
        async* [Symbol.asyncIterator]() {
          for (let i = 0; i < 6; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            yield new Uint8Array([i]);
          }
        },
      },
    }),
  });
  const out = await slow.media({ peer: 'olga', id: 'v', slot: 'voice' }, { stallMs: 60 });
  assert.deepEqual([...out.bytes], [0, 1, 2, 3, 4, 5], '180 ms in total, never 60 ms without a byte');
});

test('an empty answer to history is an empty page, not a TypeError', async () => {
  const api = createCloudApi({ server: 'http://x.test', token: 't', fetchImpl: async () => ({ status: 204, ok: true }) });
  assert.deepEqual(await api.history('olga', 10, { media: 'ref' }), []);
  let asked = null;
  const spy = createCloudApi({
    server: 'http://x.test',
    token: 't',
    fetchImpl: async (url) => { asked = String(url); return { status: 200, ok: true, json: async () => ({ messages: [] }) }; },
  });
  await spy.history('olga', 10, { includeDeleted: true, media: 'ref' });
  assert.match(asked, /\/history\?peer=olga&limit=10&deleted=1&media=ref$/);
});

test('frameAttachment keeps inline bytes and references, and nothing else', () => {
  const inline = { dataUrl: DATA_URL, width: 1, height: 1 };
  const ref = { mime: 'audio/webm', size: 10, duration: 2 };
  assert.equal(frameAttachment(inline), inline);
  assert.equal(frameAttachment(ref), ref);
  for (const junk of [null, undefined, 'x', {}, { mime: 'image/png' }, { mime: 'image/png', size: 0 }, { size: 9 }]) {
    assert.equal(frameAttachment(junk), undefined, JSON.stringify(junk));
  }
  assert.equal(messageMediaKind(undefined, ref), 'voice');
  assert.equal(messageMediaKind(undefined, undefined), null);
});
