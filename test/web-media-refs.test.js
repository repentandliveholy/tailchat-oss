import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The web client's half of docs/specs/2026-11-03-history-media-refs.md: a
// reference becomes something the renderers can draw, and its bytes are
// fetched once, at most four at a time, from `/api/media`. Extracted verbatim
// from web/cloud/app.js (a bundler-less browser script, no module boundary),
// the same way test/web-forward.test.js checks its helpers.
const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function loadMediaHelpers({ fetch }) {
  const block = source.match(/const MEDIA_REF_CAP = 'media-ref-v1';[\s\S]*?\nasync function attachmentDataUrl\(media\) \{[\s\S]*?\n\}/);
  assert.ok(block, 'the media-ref block exists in app.js');
  const revoked = [];
  let made = 0;
  const context = {
    API: '/tailchat/api',
    token: 'tok-1',
    fetch,
    AbortController,
    URLSearchParams,
    Blob,
    URL: { createObjectURL: () => `blob:test/${(made += 1)}`, revokeObjectURL: (url) => revoked.push(url) },
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Number,
    Boolean,
  };
  vm.createContext(context);
  vm.runInContext(
    `${block[0]}\nObject.assign(globalThis, { MEDIA_REF_CAP, mediaSource, hasPicture, fetchMedia, forgetMedia, isMediaRef });`,
    context,
  );
  return { ctx: context, revoked };
}

function okResponse(bytes = new Uint8Array([1, 2, 3])) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
    body: null,
    arrayBuffer: async () => bytes.buffer,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the client announces media-ref-v1 and asks every history page for references', () => {
  assert.match(source, /caps: \[[^\]]*MEDIA_REF_CAP\]/, 'auth carries the capability');
  const historyCalls = source.match(/request\('GET', `\/history\?[^`]*`\)/g) || [];
  assert.ok(historyCalls.length >= 3);
  for (const call of historyCalls) {
    if (call.includes('${query.toString()}')) continue;
    // …and, on the core, for the envelopes it can open (web/cloud/core).
    assert.match(call, /&media=ref\$\{coreHistoryParam\(\)\}`/, call);
  }
  assert.match(source, /deleted: '1',\n\s*media: 'ref',/, 'the older-page query too');
  assert.match(source, /media: 'ref',\n\s*\}\);\n\s*if \(coreSession\) query\.set\('e2ee', '1'\);/, 'and its envelopes on the core');
});

test('the live voice path only calls functions app.js actually defines', () => {
  // A live voice note computed its notification text with `formatDuration`,
  // which never existed: the ReferenceError fired before the row was drawn
  // and before `ack`/`read`, so the sender's mark stayed on ✓.
  const path = source.match(/const liveVoice = mediaSource\([\s\S]*?\n {4}return;\n {2}\}/);
  assert.ok(path, 'the live voice branch exists');
  for (const [, name] of path[0].matchAll(/\b(format[A-Z]\w*)\(/g)) {
    assert.match(source, new RegExp(`function ${name}\\(`), `${name} is defined`);
  }
});

test('mediaSource: inline stays inline, a reference gets its address, anything else is nothing', () => {
  const { ctx } = loadMediaHelpers({ fetch: async () => okResponse() });
  const inline = { dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1 };
  assert.equal(ctx.mediaSource('bob', 'm-1', inline, 'image'), inline);
  const ref = ctx.mediaSource('bob', 'm-1', { mime: 'audio/webm', size: 900, duration: 3 }, 'voice');
  assert.deepEqual({ ...ref, mediaRef: { ...ref.mediaRef } }, {
    mime: 'audio/webm', size: 900, duration: 3, mediaRef: { peer: 'bob', id: 'm-1', slot: 'voice' },
  });
  assert.equal(ctx.mediaSource('bob', '', { mime: 'image/png', size: 9 }, 'image'), null, 'no id: no address');
  assert.equal(ctx.mediaSource('bob', 'm-1', { mime: 'image/png', size: 0 }, 'image'), null);
  assert.equal(ctx.mediaSource('bob', 'm-1', null, 'image'), null);
  assert.equal(ctx.hasPicture(ref), true);
  assert.equal(ctx.hasPicture(null), false);
});

test('fetchMedia asks once per attachment, with the bearer, outside every cache', async () => {
  const calls = [];
  const { ctx } = loadMediaHelpers({
    fetch: async (url, options) => { calls.push({ url, options }); return okResponse(); },
  });
  const ref = { peer: 'bob', id: 'm 1', slot: 'image' };
  const [a, b] = await Promise.all([ctx.fetchMedia(ref), ctx.fetchMedia({ ...ref })]);
  assert.equal(calls.length, 1, 'two places on screen, one download');
  assert.equal(a.url, b.url);
  assert.equal(calls[0].url, '/tailchat/api/media?peer=bob&id=m+1&slot=image');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok-1');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('no more than four downloads run at once; the rest wait their turn', async () => {
  let running = 0;
  let peak = 0;
  const gates = [];
  const { ctx } = loadMediaHelpers({
    fetch: () => new Promise((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      gates.push(() => { running -= 1; resolve(okResponse()); });
    }),
  });
  const all = Array.from({ length: 10 }, (_, i) => ctx.fetchMedia({ peer: 'bob', id: `m-${i}`, slot: 'image' }));
  await settle();
  assert.equal(gates.length, 4);
  while (gates.length) {
    gates.shift()();
    await settle();
    await settle();
  }
  await Promise.all(all);
  assert.equal(peak, 4);
});

test('a failed download is tried again on the next ask; a 410 is remembered', async () => {
  let answer = { ok: false, status: 503 };
  let calls = 0;
  const { ctx } = loadMediaHelpers({ fetch: async () => { calls += 1; return answer; } });
  const ref = { peer: 'bob', id: 'm-1', slot: 'voice' };
  await assert.rejects(ctx.fetchMedia(ref), { code: 'failed', status: 503 });
  await settle();
  answer = okResponse();
  await ctx.fetchMedia(ref);
  assert.equal(calls, 2, 'a transient failure is not cached');

  const gone = { peer: 'bob', id: 'm-2', slot: 'image' };
  answer = { ok: false, status: 410 };
  await assert.rejects(ctx.fetchMedia(gone), { code: 'gone' });
  await settle();
  answer = okResponse();
  await assert.rejects(ctx.fetchMedia(gone), { code: 'gone' });
  assert.equal(calls, 3, 'deleted or evicted stays so — no retry storm');
});

test('a tombstoned message gives its blob URL back', async () => {
  const { ctx, revoked } = loadMediaHelpers({ fetch: async () => okResponse() });
  const { url } = await ctx.fetchMedia({ peer: 'bob', id: 'm-1', slot: 'image' });
  ctx.forgetMedia('bob', 'm-1');
  await settle();
  assert.deepEqual(revoked, [url]);
});
