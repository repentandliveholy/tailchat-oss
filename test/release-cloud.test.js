import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  CORE_PKG_FILES,
  commitsBehind,
  coreUploadCommand,
  localCoreBuild,
  parseSha256sum,
  uploadCore,
  isProductionCheckout,
  lastJsonObject,
  releaseAssetUrls,
  releaseState,
  silenceProbe,
  silenceProbeScript,
  silenceRegression,
  verifyCloudRelease,
} from '../src/release-cloud.js';
import { readyCipher, writeCloudSidecar } from '../src/cloud/storage-crypto.js';

const HEAD = '0efcf1c1edd3cee70bcc384c804cd65da1f78a12';
const OLD_HEAD = '889965d1111111111111111111111111111111111';
const VERSION = '1.92';

// A checkout whose only interesting parts are the four git answers the state
// check makes; anything else it asks for is a bug, so it throws loudly instead
// of silently returning a status 0.
function fakeGit({ branch = 'main', dirty = '', head = HEAD, ahead = '0', behind = '0' } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command !== 'git') throw new Error(`unexpected command ${command}`);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { status: 0, stdout: `${branch}\n` };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${head}\n` };
    if (args[0] === 'status') return { status: 0, stdout: dirty };
    if (args[0] === 'ls-files') return { status: 0, stdout: '' };
    if (args[0] === 'rev-list' && args[2] === 'origin/main..HEAD') return { status: 0, stdout: `${ahead}\n` };
    if (args[0] === 'rev-list' && args[2] === 'HEAD..origin/main') return { status: 0, stdout: `${behind}\n` };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { run, calls };
}

function fakeSsh({ health = '{"ok":true,"aiBridge":true}', rev = HEAD, silence, failHealth = false } = {}) {
  const commands = [];
  const run = (command, args) => {
    assert.equal(command, 'ssh');
    const remote = args[1];
    commands.push(remote);
    if (remote.startsWith('curl')) {
      return failHealth ? { status: 0, stdout: 'curl: (7) Failed to connect\n' } : { status: 0, stdout: `${health}\n` };
    }
    if (remote.includes('git rev-parse HEAD')) return { status: 0, stdout: `${rev}\n` };
    if (remote.includes('allowPlaintextLegacy')) return { status: 0, stdout: `${JSON.stringify(silence)}\n` };
    throw new Error(`unexpected remote command ${remote}`);
  };
  run.commands = commands;
  return run;
}

// `index.html` and `sw.js` pin the assets with the version, so a served page
// that still points at the previous one is the difference between "the deploy
// ran" and "the browser downloads the new code".
const WASM = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0]), Buffer.from('core')]);
const GLUE = Buffer.from('export default async function init() {}\n');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BUILT = { 'tailchat_web.js': digest(GLUE), 'tailchat_web_bg.wasm': digest(WASM) };

function fakeFetch({
  version = VERSION, indexVersion = VERSION, swVersion = VERSION, missing = [],
  wasm = WASM, wasmType = 'application/wasm',
} = {}) {
  const bodies = {
    'https://host/tailchat/': `<script src="/tailchat/app.js?v=${indexVersion}" defer></script>`
      + `<link rel="stylesheet" href="/tailchat/app.css?v=${indexVersion}">`,
    [`https://host/tailchat/app.js?v=${version}`]: 'const app = 1;',
    [`https://host/tailchat/app.css?v=${version}`]: '.a{}',
    'https://host/tailchat/sw.js': `const SHELL_ASSETS = ["/tailchat/app.css?v=${swVersion}", "/tailchat/app.js?v=${swVersion}"];`,
    'https://host/tailchat/core/pkg/tailchat_web.js': GLUE,
    'https://host/tailchat/core/pkg/tailchat_web_bg.wasm': wasm,
  };
  const types = { 'https://host/tailchat/core/pkg/tailchat_web_bg.wasm': wasmType };
  return async (url) => {
    if (missing.includes(url) || !(url in bodies)) {
      return { ok: false, status: 404, headers: new Headers(), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const body = bodies[url];
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return {
      ok: true,
      status: 200,
      headers: new Headers(types[url] ? { 'content-type': types[url] } : {}),
      text: async () => bytes.toString('utf8'),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

// What the probe answers, including how much plaintext it decrypted: an answer
// without that reads as «nothing was read» and fails the check (`silenceProbe`).
const silent = { announcedVersion: '1.68', releaseIds: ['release-1.68'], releaseTexts: 0, bytes: 4096 };

// The store has been an AEAD envelope since 24.09 — `{"format":"tailchat-cloud-aead",…}`
// with the snapshot inside — so a probe that reads it as JSON «succeeds» on the
// wrapper, finds no `history` and no `announcedVersion`, and reports silence for
// any content whatsoever. This pins the probe against a store it has to decrypt,
// and pins the other half of the contract: a key this deployment cannot use has
// to fail loudly (the check then says `silence-probe-unavailable`), never
// quietly.
test('the silence probe decrypts the store it reads, and fails without its key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'store');
  fs.mkdirSync(dir, { mode: 0o700 });
  const keyFile = path.join(root, 'master.key');
  fs.writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 });
  const cipher = readyCipher(dir, keyFile, { initialize: true });
  writeCloudSidecar(dir, 'accounts.json', JSON.stringify({
    version: 1,
    announcedVersion: '1.68',
    history: {
      'anna|boris': [
        { id: 'release-1.13', text: 'release-1.13 out' },
        { id: 'm1', text: 'привет' },
      ],
    },
  }), cipher);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const run = (script) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });

  const snapshot = run(silenceProbeScript({ dir, keyFile, root: repo }));
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const answer = JSON.parse(snapshot.stdout);
  assert.deepEqual({
    announcedVersion: answer.announcedVersion,
    releaseIds: answer.releaseIds,
    releaseTexts: answer.releaseTexts,
  }, {
    announcedVersion: '1.68',
    releaseIds: ['release-1.13'],
    releaseTexts: 1,
  });
  assert.ok(answer.bytes > 0, 'the answer says how much plaintext it read');

  // The key this deployment cannot use must fail loudly *and* for that reason:
  // a run that died for some other cause would keep passing here while telling
  // the release check nothing.
  const noKey = run(silenceProbeScript({ dir, keyFile: path.join(root, 'absent.key'), root: repo }));
  assert.notEqual(noKey.status, 0, 'a store this deployment cannot open must not read as silent');
  assert.match(noKey.stderr, /master key|ENOENT|EACCES|0600/u);

  // The legacy-plaintext arm is not decoration. Without a marker there is no key
  // to use — `readyCipher` refuses a key for a store that was never migrated —
  // so the script names one only when the marker is there, and an unmigrated
  // store is read as the plaintext it is. (Before that, this case died inside
  // `readyCipher` and the claim to read «the old open file too» was false.)
  const plainDir = path.join(root, 'plaintext');
  fs.mkdirSync(plainDir, { mode: 0o700 });
  fs.writeFileSync(path.join(plainDir, 'accounts.json'), JSON.stringify({
    version: 1,
    announcedVersion: '1.68',
    history: { 'anna|boris': [{ id: 'release-1.50', text: 'release-1.50 out' }] },
  }));
  const plain = spawnSync(process.execPath,
    ['--input-type=module', '-e', silenceProbeScript({ dir: plainDir, keyFile, root: repo })],
    { encoding: 'utf8', env: { ...process.env, TAILCHAT_CLOUD_MASTER_KEY_FILE: '' } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout).releaseIds, ['release-1.50']);

  // The bug this round was about, pinned one layer down: an AEAD *envelope* is
  // valid JSON without a `history`, so a probe that reads it answers with an
  // empty-but-well-formed snapshot. The script now refuses that file outright.
  const envelopeDir = path.join(root, 'envelope');
  fs.mkdirSync(envelopeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(envelopeDir, 'accounts.json'),
    JSON.stringify({ format: 'tailchat-cloud-aead', keyId: 'abc', iv: 'x', tag: 'y', data: 'AAAA' }));
  const envelope = spawnSync(process.execPath,
    ['--input-type=module', '-e', silenceProbeScript({ dir: envelopeDir, keyFile: '', root: repo })],
    { encoding: 'utf8', env: { ...process.env, TAILCHAT_CLOUD_MASTER_KEY_FILE: '' } });
  assert.notEqual(envelope.status, 0, 'an envelope is not a store and must not answer as one');
  assert.match(envelope.stderr, /not a store/u);
});

// …and the same hole one layer up in the *wrapper*: whatever a future probe
// prints, an answer that proves no reading happened has to be «unavailable»
// (which fails the check) rather than silence.
test('a probe answer with no reading behind it is unavailable, not silence', () => {
  const envelopeAnswer = JSON.stringify({ announcedVersion: null, releaseIds: [], releaseTexts: 0 });
  const run = () => ({ status: 0, stdout: `${envelopeAnswer}\n` });
  assert.equal(silenceProbe({ host: 'box', run }), null);

  const readAnswer = JSON.stringify({
    announcedVersion: '1.68', releaseIds: ['release-1.13'], releaseTexts: 0, bytes: 1024,
  });
  const good = silenceProbe({ host: 'box', run: () => ({ status: 0, stdout: `${readAnswer}\n` }) });
  assert.deepEqual(good, { announcedVersion: '1.68', releaseIds: ['release-1.13'], releaseTexts: 0 });
});

test('lastJsonObject picks the object out of SSH noise and ignores non-objects', () => {
  assert.deepEqual(lastJsonObject('Warning: Permanently added the host\n{"ok":true}\n'), { ok: true });
  assert.deepEqual(lastJsonObject('{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.equal(lastJsonObject('curl: (7) Failed to connect\n'), null);
  assert.equal(lastJsonObject('[1,2,3]\n'), null);
  assert.equal(lastJsonObject('{"truncated":\n'), null);
});

test('an announcedVersion that moves or a message for this version is a silence regression', () => {
  // The store already contains a release message for every version ever
  // announced, so the comparison has to be a difference — "is there a release
  // message" is true and useless.
  const history = { announcedVersion: '1.68', releaseIds: ['release-1.67', 'release-1.68'], releaseTexts: 0 };
  assert.equal(silenceRegression(history, { ...history, releaseIds: [...history.releaseIds] }, VERSION), null);
  assert.equal(silenceRegression(silent, silent, VERSION), null);
  assert.deepEqual(
    silenceRegression(history, { ...history, announcedVersion: VERSION }, VERSION),
    { reason: 'announced-version-moved', from: '1.68', to: VERSION },
  );
  assert.deepEqual(
    silenceRegression(history, { ...history, releaseIds: [...history.releaseIds, `release-${VERSION}`] }, VERSION),
    { reason: 'release-message-written', id: `release-${VERSION}` },
  );
  // Strictly newer than this version but still a release message: something
  // wrote to somebody, and the version it names is not the excuse.
  assert.deepEqual(
    silenceRegression(history, { ...history, releaseIds: [...history.releaseIds, 'release-1.91'] }, VERSION),
    { reason: 'unexpected-release-ids', ids: ['release-1.91'] },
  );
  assert.deepEqual(
    silenceRegression(history, { ...history, releaseTexts: 1 }, VERSION),
    { reason: 'release-text-written', from: 0, to: 1 },
  );
  assert.deepEqual(silenceRegression(null, history, VERSION), { reason: 'silence-probe-unavailable' });
  assert.deepEqual(silenceRegression(history, null, VERSION), { reason: 'silence-probe-unavailable' });
});

test('releaseAssetUrls version every cache-busted asset and tolerate a trailing slash', () => {
  const urls = releaseAssetUrls('https://host/', VERSION);
  assert.equal(urls.index, 'https://host/tailchat/');
  assert.equal(urls.app, `https://host/tailchat/app.js?v=${VERSION}`);
  assert.equal(urls.css, `https://host/tailchat/app.css?v=${VERSION}`);
  assert.equal(urls.sw, 'https://host/tailchat/sw.js');
});

test('a box behind local HEAD is tolerated in check mode, a box anywhere else is not', async () => {
  const behind = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ rev: OLD_HEAD, silence: silent }),
    fetchImpl: fakeFetch(),
    remoteRev: OLD_HEAD,
    remoteRevBehind: { ancestor: true, behind: 3 },
  });
  assert.equal(behind.ok, true, behind.summary);
  assert.match(behind.checks.find((check) => check.name === 'remote-rev').detail, /3 commit\(s\) behind local HEAD/);

  // An ancestor is the only thing tolerated: without the ancestry answer the
  // same revision is a failure, which is what a full release requires.
  const strict = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ rev: OLD_HEAD, silence: silent }),
    fetchImpl: fakeFetch(),
    remoteRev: OLD_HEAD,
  });
  assert.equal(strict.ok, false);
});

test('commitsBehind answers behind-and-ancestor, divergent, or unknown', () => {
  const git = (status, stdout = '') => (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'merge-base') return { status };
    if (args[0] === 'rev-list') return { status: 0, stdout };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(commitsBehind('/repo', 'abc1234', HEAD, git(0, '3\n')), { ancestor: true, behind: 3 });
  assert.deepEqual(commitsBehind('/repo', 'abc1234', HEAD, git(1)), { ancestor: false, behind: 0 });
  // 128 is git's "no such object": the box is on a commit this checkout has
  // never seen, which is exactly the case that must not pass as "behind".
  assert.equal(commitsBehind('/repo', 'abc1234', HEAD, git(128)), null);
  assert.equal(commitsBehind('/repo', '', HEAD, git(0)), null);
});

test('the production checkout is not where the local release script runs', () => {
  // On the box the checkout and the deployment are the same directory: `git
  // push` and `ssh ovh` from there are both meaningless, and a script that
  // guesses which half it is would be guessing about production.
  assert.equal(isProductionCheckout('/opt/tailchat'), true);
  assert.equal(isProductionCheckout('/opt/tailchat/'), true);
  assert.equal(isProductionCheckout('/opt/tailchat/web/cloud'), true);
  assert.equal(isProductionCheckout('/opt/tailchat-old'), false);
  assert.equal(isProductionCheckout('/Users/someone/Dev/tailchat'), false);
  assert.equal(isProductionCheckout(''), false);
});

test('the release state refuses a dirty checkout, a foreign branch and a stale ref', () => {
  const clean = releaseState('/repo', fakeGit({ ahead: '2' }).run);
  assert.equal(clean.ok, true);
  assert.equal(clean.ahead, 2);

  assert.equal(releaseState('/repo', fakeGit({ dirty: ' M src/cli.js\n' }).run).reason, 'dirty-checkout');
  assert.equal(releaseState('/repo', fakeGit({ branch: 'fix/roster' }).run).reason, 'not-main');
  assert.equal(releaseState('/repo', fakeGit({ behind: '1' }).run).reason, 'behind-origin');
  assert.equal(releaseState('/repo', fakeGit({ head: '' }).run).reason, 'head-unavailable');
});

test('a healthy box with the right bytes and a silent store verifies', async () => {
  const result = await verifyCloudRelease({
    version: VERSION,
    head: HEAD,
    baseUrl: 'https://host',
    before: silent,
    run: fakeSsh({ silence: silent }),
    fetchImpl: fakeFetch(),
  });
  assert.equal(result.ok, true, result.summary);
  assert.deepEqual(result.checks.map((check) => check.name), [
    'remote-health', 'remote-rev', 'served-index', 'served-app', 'served-css', 'served-sw', 'served-core', 'silence',
  ]);
});

// The deploy restarts the service and this probe runs in the same second, so a
// single `curl` races the bind: the 1.121 release answered `curl: (7) Failed to
// connect` on a box that was healthy a minute later and reported itself
// unverified. The retry flags are what make a FAIL mean "the cloud is not up"
// rather than "the cloud is not up yet" — and nothing else would notice if they
// were dropped again.
test('the health probe waits for the restart it caused instead of racing it', async () => {
  const run = fakeSsh({ silence: silent });
  const result = await verifyCloudRelease({
    version: VERSION,
    head: HEAD,
    baseUrl: 'https://host',
    before: silent,
    run,
    fetchImpl: fakeFetch(),
  });
  assert.equal(result.ok, true, result.summary);

  const health = run.commands.find((command) => command.includes('/health'));
  assert.ok(health, 'the probe asks the box for health');
  assert.match(health, /--retry-connrefused/, 'a refused connection must be retried, not reported');
  assert.match(health, /--retry 5/);
  assert.match(health, /-m 3/, 'and each attempt still has a deadline of its own');
});

test('a box still pinning the previous version, a 404 asset, another revision or a written message all fail', async () => {
  const staleIndex = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ silence: silent }), fetchImpl: fakeFetch({ indexVersion: '1.91' }),
  });
  assert.equal(staleIndex.ok, false);
  assert.match(staleIndex.checks.find((check) => check.name === 'served-index').detail, /missing app\.js\?v=1\.92/);

  const staleSw = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ silence: silent }), fetchImpl: fakeFetch({ swVersion: '1.91' }),
  });
  assert.equal(staleSw.checks.find((check) => check.name === 'served-sw').ok, false);

  const missingCss = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ silence: silent }), fetchImpl: fakeFetch({ missing: [`https://host/tailchat/app.css?v=${VERSION}`] }),
  });
  assert.equal(missingCss.ok, false);
  assert.equal(missingCss.checks.find((check) => check.name === 'served-css').ok, false);

  const otherRevision = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ rev: OLD_HEAD, silence: silent }), fetchImpl: fakeFetch(),
  });
  assert.equal(otherRevision.ok, false);
  assert.equal(otherRevision.checks.find((check) => check.name === 'remote-rev').ok, false);

  const notSilent = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ silence: { ...silent, releaseIds: [...silent.releaseIds, `release-${VERSION}`] } }),
    fetchImpl: fakeFetch(),
  });
  assert.equal(notSilent.ok, false);
  assert.equal(notSilent.checks.find((check) => check.name === 'silence').ok, false);

  const unhealthy = await verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ failHealth: true, silence: silent }), fetchImpl: fakeFetch(),
  });
  assert.equal(unhealthy.checks.find((check) => check.name === 'remote-health').ok, false);
});

// Stage 7: the browser core is built on the laptop and shipped with the
// release (owner, 2026-11-11), so the release is also what proves the box
// serves *those* bytes — not a stale core from the previous release, not an
// HTML 404 page with a 200, not a file served as text that the browser's
// `instantiateStreaming` refuses.
test('the served core must be the build that was shipped, served as WebAssembly', async () => {
  const verify = (fetchImpl, core = { digests: BUILT }) => verifyCloudRelease({
    version: VERSION, head: HEAD, baseUrl: 'https://host', before: silent,
    run: fakeSsh({ silence: silent }), fetchImpl, core,
  });
  const served = (result) => result.checks.find((check) => check.name === 'served-core');

  const shipped = await verify(fakeFetch());
  assert.equal(shipped.ok, true, shipped.summary);
  assert.match(served(shipped).detail, /match the build/);

  const stale = await verify(fakeFetch({ wasm: Buffer.concat([WASM, Buffer.from('old')]) }));
  assert.equal(served(stale).ok, false);
  assert.match(served(stale).detail, /tailchat_web_bg\.wasm differs from the build/);

  const absent = await verify(fakeFetch({ missing: ['https://host/tailchat/core/pkg/tailchat_web_bg.wasm'] }));
  assert.equal(absent.ok, false);
  assert.match(served(absent).detail, /HTTP 404/);

  const asText = await verify(fakeFetch({ wasmType: 'text/plain' }));
  assert.match(served(asText).detail, /served as text\/plain/);

  const notWasm = await verify(fakeFetch({ wasm: Buffer.from('<html>') }), null);
  assert.equal(served(notWasm).ok, false, '--check has no digests, but HTML is still not a core');
  assert.match(served(notWasm).detail, /not WebAssembly/);

  const checkOnly = await verify(fakeFetch(), null);
  assert.equal(served(checkOnly).ok, true);
  assert.match(served(checkOnly).detail, /served$/);
});

test('the local build ships exactly the files the server serves', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-core-pkg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'web/cloud/core/pkg');

  assert.match(localCoreBuild(root).reason, /missing — npm run build:web-core/);

  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'tailchat_web.js'), GLUE);
  assert.match(localCoreBuild(root).reason, /lacks tailchat_web_bg\.wasm/);

  fs.writeFileSync(path.join(pkg, 'tailchat_web_bg.wasm'), WASM);
  assert.deepEqual(localCoreBuild(root), { ok: true, digests: BUILT });

  // The server's table is fixed (`STATIC_ASSETS`); a file outside it would be
  // uploaded and then 404 in production only.
  fs.mkdirSync(path.join(pkg, 'snippets'));
  assert.match(localCoreBuild(root).reason, /has snippets, which the server does not serve/);

  const served = fs.readFileSync(fileURLToPath(new URL('../src/cloud/server.js', import.meta.url)), 'utf8');
  for (const file of CORE_PKG_FILES) assert.ok(served.includes(`'core/pkg/${file}'`), `${file} is in STATIC_ASSETS`);
});

test('the upload swaps the pkg in place on the box and trusts only the digests it reads back', () => {
  const command = coreUploadCommand('/opt/tailchat/web/cloud/core');
  assert.match(command, /^set -e; /, 'any failing step stops the swap');
  assert.ok(command.indexOf('tar -xzf -') < command.indexOf('mv .pkg-next pkg'), 'unpacked before it replaces anything');
  assert.match(command, /sha256sum tailchat_web\.js tailchat_web_bg\.wasm$/);
  const ignored = fs.readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8');
  assert.match(ignored, /^\/web\/cloud\/core\/\.pkg-\*\/$/m, 'a half-done upload is not an untracked file to the next deploy');

  assert.deepEqual(parseSha256sum(`${BUILT['tailchat_web.js']}  tailchat_web.js\n${BUILT['tailchat_web_bg.wasm']} *tailchat_web_bg.wasm\nnoise\n`), BUILT);

  const fakeRun = (sums) => {
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'tar') return { status: 0, stdout: Buffer.from('archive') };
      if (command === 'ssh') return { status: 0, stdout: sums };
      throw new Error(`unexpected ${command}`);
    };
    return { run, calls };
  };
  const build = { ok: true, digests: BUILT };
  const good = fakeRun(`${BUILT['tailchat_web.js']}  tailchat_web.js\n${BUILT['tailchat_web_bg.wasm']}  tailchat_web_bg.wasm\n`);
  const shipped = uploadCore({ root: '/repo', host: 'box', run: good.run, build });
  assert.equal(shipped.ok, true, shipped.reason);
  const [tar, ssh] = good.calls;
  assert.equal(tar.options.env.COPYFILE_DISABLE, '1', 'no AppleDouble ._ files from macOS');
  assert.deepEqual(tar.args.slice(-2), [...CORE_PKG_FILES]);
  // bsdtar's flag only where bsdtar is: GNU tar exits 64 on it.
  const onMac = fakeRun('');
  uploadCore({ root: '/repo', run: onMac.run, build, platform: 'darwin' });
  assert.ok(onMac.calls[0].args.includes('--no-mac-metadata'));
  const onLinux = fakeRun('');
  uploadCore({ root: '/repo', run: onLinux.run, build, platform: 'linux' });
  assert.ok(!onLinux.calls[0].args.includes('--no-mac-metadata'));
  assert.equal(ssh.args[0], 'box');
  assert.equal(ssh.options.input.toString(), 'archive', 'the archive is the ssh stdin');

  const mangled = fakeRun(`${BUILT['tailchat_web.js']}  tailchat_web.js\n${'0'.repeat(64)}  tailchat_web_bg.wasm\n`);
  assert.match(uploadCore({ root: '/repo', run: mangled.run, build }).reason, /different bytes for tailchat_web_bg\.wasm/);

  const unbuilt = uploadCore({ root: '/repo', run: () => { throw new Error('nothing may run'); }, build: { ok: false, reason: 'no pkg' } });
  assert.deepEqual(unbuilt, { ok: false, reason: 'no pkg' });
});

// The real tools, end to end on this machine: macOS bsdtar packs with the
// flags the upload uses and the swap script unpacks it, the way GNU tar on the
// box will. Skipped where there is no `sh`/`sha256sum` (the box has both).
test('the archive the upload builds unpacks through the swap script', (t) => {
  if (spawnSync('sha256sum', ['--version']).error) {
    t.skip('no sha256sum here');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-core-ship-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'web/cloud/core/pkg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'tailchat_web.js'), GLUE);
  fs.writeFileSync(path.join(pkg, 'tailchat_web_bg.wasm'), WASM);
  const remote = path.join(root, 'box/core');
  fs.mkdirSync(path.join(remote, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(remote, 'pkg', 'tailchat_web_bg.wasm'), 'previous');

  const run = (command, args, options) => (command === 'ssh'
    ? spawnSync('sh', ['-c', coreUploadCommand(remote)], options)
    : spawnSync(command, args, options));
  const shipped = uploadCore({ root, run });
  assert.equal(shipped.ok, true, shipped.reason);
  assert.deepEqual(fs.readdirSync(remote).sort(), ['pkg'], 'no staging left behind');
  assert.deepEqual(fs.readdirSync(path.join(remote, 'pkg')).sort(), [...CORE_PKG_FILES]);
  assert.ok(fs.readFileSync(path.join(remote, 'pkg', 'tailchat_web_bg.wasm')).equals(WASM));
});
