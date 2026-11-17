import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { headCommit } from './update.js';
import { productionCheckoutState } from './production-deploy.js';

// The local half of a cloud release: what has to happen *before* the box is
// touched (the commit has to be on `origin/main`, because the deploy resets to
// it), and what has to be confirmed *after* (the public front really serves the
// version that was just shipped, and nobody got a message about it).
//
// The server half is `bin/production-deploy.js` and it verifies itself: reset,
// install, restart only the apps whose paths changed, Telegram report, rollback.
// This module deliberately does not repeat any of that. It answers two
// questions the box cannot answer about itself — "did the thing the world
// downloads actually change?" and "did the release stay silent?" — and it
// refuses to call the release done when either answer is no.

export const RELEASE_HOST = 'ovh';
export const RELEASE_BASE_URL = 'https://repentandliveholy.org';
export const REMOTE_ROOT = '/opt/tailchat';
export const REMOTE_STORE_DIR = '/var/lib/tailchat-cloud';
export const REMOTE_STORE = `${REMOTE_STORE_DIR}/accounts.json`;
/** The deployment's master key, as `ecosystem.config.cjs` names it. */
export const REMOTE_KEY_FILE = '/etc/tailchat-cloud/master.key';
export const REMOTE_DEPLOY_COMMAND = `cd ${REMOTE_ROOT} && node bin/production-deploy.js`;

/**
 * Whether `root` is the deployment this script deploys *to*. On the box the two
 * halves of a release are the same directory, and running the local half there
 * would try to `git push` from production and then SSH back into itself — two
 * plausible-looking commands with no useful effect and a real chance of one.
 * The server half is `bin/production-deploy.js`; this is the one place that
 * says so before anything runs.
 */
export function isProductionCheckout(root, productionRoot = REMOTE_ROOT) {
  const normalized = String(root ?? '').replace(/\/+$/u, '');
  return normalized === productionRoot || normalized.startsWith(`${productionRoot}/`);
}

// One JSON line off the box, describing everything §9 cares about.
//
// The store has been an AEAD *envelope* since 24.09 — `{"format":"tailchat-cloud-aead",…}`
// with the snapshot inside `data` — so reading it as JSON "succeeded" on the
// wrapper, found no `history` and no `announcedVersion`, and reported silence
// for any content at all. A check that cannot fail is worse than no check: the
// probe now goes through the store's own reader with the deployment's key.
//
// The script refuses to answer at all when the plaintext does not look like a
// store (`"history"` is the one key every snapshot has), and reports how many
// bytes it decrypted; both are what keep a probe that read nothing from reading
// as a silent release.
//
// The three answers are then pulled out of the plaintext *by pattern*, not by
// `JSON.parse`: the snapshot is ~186 MB of ciphertext on a box that is serving
// from that same store, and an object graph of it is a gigabyte of heap for
// three scalars. `nice` keeps the probe out of the way of the service it is
// describing.
//
// The script is passed as one shell-quoted argument, so it must contain no
// single quote — every string in it is double-quoted for that reason.
export function silenceProbeScript({
  dir = REMOTE_STORE_DIR, keyFile = REMOTE_KEY_FILE, root = REMOTE_ROOT,
} = {}) {
  return [
    'import fs from "node:fs";',
    `import {readyCipher,readCloudSidecar,READY_FILE} from "${root}/src/cloud/storage-crypto.js";`,
    `const dir="${dir}";`,
    // A key only means something together with the marker: `readyCipher`
    // refuses a key for a store that was never migrated («requires completed
    // offline migration»), and that refusal is what made the legacy-plaintext
    // arm unreachable. The key is therefore named only when the marker is there,
    // and an unmigrated store is read as the plaintext it is.
    'const key=fs.existsSync(dir+"/"+READY_FILE) ? (process.env.TAILCHAT_CLOUD_MASTER_KEY_FILE || "' + keyFile + '") : null;',
    'const cipher=readyCipher(dir, key, {allowPlaintextLegacy:true});',
    'const raw=readCloudSidecar(dir, "accounts.json", cipher, true);',
    'const looksLikeStore=/"history"/.test(raw);',
    'if(!looksLikeStore){process.stderr.write("not a store: the snapshot has no history, so nothing was read");process.exit(1);}',
    'const ids=[...new Set([...raw.matchAll(/"id"\\s*:\\s*"(release-[^"]*)"/g)].map((m)=>m[1]))];',
    'const texts=(raw.match(/"text"\\s*:\\s*"[^"]*release-/g) || []).length;',
    'const found=/"announcedVersion"\\s*:\\s*(?:"([^"]*)"|(\\d+))/.exec(raw);',
    'process.stdout.write(JSON.stringify({announcedVersion:found ? (found[1] ?? found[2]) : null, releaseIds:ids, releaseTexts:texts, bytes:raw.length}));',
  ].join('');
}

export const SILENCE_PROBE = `nice -n 10 node --input-type=module -e '${silenceProbeScript()}'`;

/**
 * The last line of `text` that is a JSON object. Output that comes back over
 * SSH is not only the output of the command: a banner or a warning about a
 * changed host key arrives on the same stream, and a probe that says "no
 * silence problems" because it failed to parse is worse than no probe.
 */
export function lastJsonObject(text) {
  const lines = String(text ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Not JSON after all — keep looking upwards.
    }
  }
  return null;
}

/**
 * Whether a release wrote into somebody's conversation. `null` means "no".
 *
 * Compared as a difference, not as a property: the store legitimately contains
 * `release-1.13` … `release-1.68` from the years when announcements were on,
 * so "is there a release message in the store" is always true and useless.
 * What matters is whether *this* release added one.
 */
export function silenceRegression(before, after, version) {
  if (!before || !after) return { reason: 'silence-probe-unavailable' };

  const from = before.announcedVersion ?? null;
  const to = after.announcedVersion ?? null;
  if (from !== to) return { reason: 'announced-version-moved', from, to };

  const id = `release-${version}`;
  const writtenIds = (after.releaseIds ?? []).filter((entry) => !(before.releaseIds ?? []).includes(entry));
  if (writtenIds.includes(id)) return { reason: 'release-message-written', id };
  if (writtenIds.length > 0) return { reason: 'unexpected-release-ids', ids: writtenIds };

  if ((after.releaseTexts ?? 0) > (before.releaseTexts ?? 0)) {
    return { reason: 'release-text-written', from: before.releaseTexts ?? 0, to: after.releaseTexts ?? 0 };
  }
  return null;
}

/**
 * What a client of version `version` must be able to fetch. `index.html` and
 * `sw.js` pin `app.css`/`app.js` with `?v=<package.json version>` (§7), so the
 * version is also the proof that the *new* bytes are what the browser is being
 * pointed at: a deploy that reset to the wrong commit, or a bump that forgot
 * one of the four `?v=` edits, both show up here as a served page that still
 * points at the previous version.
 */
export function releaseAssetUrls(baseUrl, version) {
  const base = String(baseUrl ?? '').replace(/\/+$/u, '');
  const pin = `?v=${encodeURIComponent(version)}`;
  return {
    index: `${base}/tailchat/`,
    app: `${base}/tailchat/app.js${pin}`,
    css: `${base}/tailchat/app.css${pin}`,
    sw: `${base}/tailchat/sw.js`,
  };
}

// The core in the browser (stage 7). Built on the laptop by
// `bin/build-web-core.js` and shipped with the release, never compiled on the
// box (owner, 2026-11-11): the box has no Rust and should not need one. It is
// a build artifact, so git does not carry it (`/web/cloud/core/pkg/` is
// ignored) and `git reset --hard` on the box leaves the shipped copy alone.
export const CORE_PKG_DIR = 'web/cloud/core/pkg';
/** Exactly what `STATIC_ASSETS` in src/cloud/server.js serves from the pkg. */
export const CORE_PKG_FILES = Object.freeze(['tailchat_web.js', 'tailchat_web_bg.wasm']);
export const REMOTE_CORE_DIR = `${REMOTE_ROOT}/web/cloud/core`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The digests of the pkg the release is about to ship. A file the server
 * would not serve is refused rather than shipped: wasm-bindgen emits
 * `snippets/` the day a crate grows an inline JS import, and a release that
 * uploads it while `STATIC_ASSETS` 404s it is a core that fails to load only
 * in production.
 */
export function localCoreBuild(root, { readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const dir = path.join(root, CORE_PKG_DIR);
  let present;
  try {
    present = readdir(dir);
  } catch {
    return { ok: false, reason: `${CORE_PKG_DIR} is missing — npm run build:web-core` };
  }
  const missing = CORE_PKG_FILES.filter((file) => !present.includes(file));
  if (missing.length > 0) return { ok: false, reason: `${CORE_PKG_DIR} lacks ${missing.join(', ')}` };
  const unserved = present.filter((file) => !CORE_PKG_FILES.includes(file));
  if (unserved.length > 0) {
    return { ok: false, reason: `${CORE_PKG_DIR} has ${unserved.join(', ')}, which the server does not serve (STATIC_ASSETS)` };
  }
  const digests = {};
  for (const file of CORE_PKG_FILES) digests[file] = sha256(readFile(path.join(dir, file)));
  return { ok: true, digests };
}

/**
 * The remote half of the upload: unpack beside the live pkg, swap, report the
 * digests of what is now in place. Staged under a dot-name that `.gitignore`
 * also covers, so an upload that died half way never reads as an untracked
 * file to the next `production-deploy.js`. The asset reader re-stats on every
 * request and the core is served `no-store`, so no restart follows.
 */
export function coreUploadCommand(dir = REMOTE_CORE_DIR) {
  return [
    'set -e',
    `mkdir -p ${dir}`,
    `cd ${dir}`,
    'rm -rf .pkg-next .pkg-prev',
    'mkdir .pkg-next',
    'tar -xzf - --no-same-owner -C .pkg-next',
    'if [ -d pkg ]; then mv pkg .pkg-prev; fi',
    'mv .pkg-next pkg',
    'rm -rf .pkg-prev',
    `cd pkg && sha256sum ${CORE_PKG_FILES.join(' ')}`,
  ].join('; ');
}

/** `sha256sum` output as `{ file: digest }`. */
export function parseSha256sum(text) {
  const digests = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/u.exec(line.trim());
    if (match) digests[match[2]] = match[1];
  }
  return digests;
}

/**
 * Ships the local pkg to the box. The archive is built in memory and handed to
 * `ssh` as its stdin, so nothing temporary is left on either side, and the
 * box's own digests are compared with the local ones before this says "ok".
 */
export function uploadCore({
  root, host = RELEASE_HOST, run = spawnSync, build = localCoreBuild(root), platform = process.platform,
} = {}) {
  if (!build.ok) return { ok: false, reason: build.reason };
  // COPYFILE_DISABLE and the two `--no-*` keep macOS from adding `._*`
  // AppleDouble files and xattr headers that GNU tar on the box would unpack
  // or warn about; ustar keeps the archive free of pax extensions.
  // `--no-mac-metadata` is bsdtar's own flag: GNU tar (Linux) refuses it with
  // exit 64, and has no AppleDouble files to leave out in the first place.
  const archive = run('tar', [
    '--no-xattrs', ...(platform === 'darwin' ? ['--no-mac-metadata'] : []), '--format', 'ustar',
    '-C', path.join(root, CORE_PKG_DIR), '-czf', '-', ...CORE_PKG_FILES,
  ], { env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 256 * 1024 * 1024 });
  if (archive.error) return { ok: false, reason: `tar: ${archive.error.message}` };
  if (archive.status !== 0 || !archive.stdout?.length) return { ok: false, reason: `tar exited ${archive.status}` };

  const shipped = run('ssh', [host, coreUploadCommand()], {
    input: archive.stdout, encoding: 'utf8', timeout: 180000,
  });
  if (shipped.error) return { ok: false, reason: `ssh: ${shipped.error.message}` };
  if (shipped.status !== 0) return { ok: false, reason: `ssh exited ${shipped.status}: ${String(shipped.stderr ?? '').trim()}` };
  const remote = parseSha256sum(shipped.stdout);
  const wrong = CORE_PKG_FILES.filter((file) => remote[file] !== build.digests[file]);
  if (wrong.length > 0) return { ok: false, reason: `the box holds different bytes for ${wrong.join(', ')}` };
  return { ok: true, digests: build.digests, bytes: archive.stdout.length };
}

export const RELEASE_BRANCH = 'main';

/**
 * Everything local that decides whether a deploy may start. `--check` does not
 * need this (it writes nothing), but a deploy does: a dirty tracked file means
 * the box would receive something other than what was reviewed, and any branch
 * but `main` means `git push origin main` and the deploy would ship different
 * commits from each other.
 */
export function releaseState(root, run = spawnSync) {
  const branchResult = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (branchResult.error || branchResult.status !== 0) return { ok: false, reason: 'branch-unavailable' };
  const branch = String(branchResult.stdout ?? '').trim();

  const head = headCommit(root, run);
  if (!head) return { ok: false, reason: 'head-unavailable', branch };

  const checkout = productionCheckoutState(root, run);
  if (!checkout) return { ok: false, reason: 'dirty-check-failed', branch, head };
  if (checkout.tracked > 0) return { ok: false, reason: 'dirty-checkout', branch, head, tracked: checkout.tracked };

  const ahead = countRange(root, 'origin/main..HEAD', run);
  const behind = countRange(root, 'HEAD..origin/main', run);
  if (ahead === null || behind === null) return { ok: false, reason: 'origin-main-unavailable', branch, head };

  if (branch !== RELEASE_BRANCH) return { ok: false, reason: 'not-main', branch, head, ahead, behind };
  // Being behind is not "nothing to push": the box would reset to a commit that
  // was never verified here, and the version checked afterwards would be a
  // version nobody looked at. Diverged is the same refusal with one more step.
  if (behind > 0) return { ok: false, reason: 'behind-origin', branch, head, ahead, behind };

  return { ok: true, branch, head, ahead, behind, untracked: checkout.untracked };
}

function countRange(root, range, run) {
  const result = run('git', ['rev-list', '--count', range], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const count = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  return Number.isSafeInteger(count) ? count : null;
}

/** `git fetch origin main`, without failing a `--check` on a network hiccup. */
export function fetchOriginMain(root, run = spawnSync) {
  const result = run('git', ['fetch', 'origin', 'main'], { cwd: root, encoding: 'utf8' });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) return { ok: false, reason: `git fetch exited ${result.status}` };
  return { ok: true };
}

function sshText(run, host, command) {
  const result = run('ssh', [host, command], { encoding: 'utf8', timeout: 60000 });
  if (result.error) return { ok: false, detail: result.error.message, text: '' };
  const text = String(result.stdout ?? '');
  if (result.status !== 0) return { ok: false, detail: `ssh exited ${result.status}`, text };
  return { ok: true, detail: 'ok', text };
}

export function silenceProbe({ host = RELEASE_HOST, run = spawnSync } = {}) {
  const result = sshText(run, host, SILENCE_PROBE);
  if (!result.ok) return null;
  const snapshot = lastJsonObject(result.text);
  if (!snapshot || !Array.isArray(snapshot.releaseIds)) return null;
  // A well-formed answer that proves nothing is exactly the shape the envelope
  // bug produced — `{announcedVersion:null,releaseIds:[],releaseTexts:0}` out of
  // a store nobody read — so the probe has to report how much plaintext it got.
  // Zero bytes (or no such field) is «unavailable», and `silenceRegression`
  // turns that into a failed check: without this, the next broken probe reads
  // exactly like a silent release.
  if (!Number.isFinite(snapshot.bytes) || snapshot.bytes <= 0) return null;
  return {
    announcedVersion: snapshot.announcedVersion ?? null,
    releaseIds: snapshot.releaseIds,
    releaseTexts: Number(snapshot.releaseTexts ?? 0),
  };
}

/** The revision the box is on, or `null` when the box cannot be asked. */
export function remoteRevision({ host = RELEASE_HOST, run = spawnSync } = {}) {
  const result = sshText(run, host, `cd ${REMOTE_ROOT} && git rev-parse HEAD`);
  if (!result.ok) return null;
  const rev = String(result.text).trim().split('\n').pop() ?? '';
  return /^[0-9a-f]{7,40}$/u.test(rev) ? rev : null;
}

/**
 * How far `rev` is behind `head`, when it is behind at all.
 *
 * A check that only accepts "the box is exactly on local HEAD" is right for a
 * release and wrong for a verification: production legitimately sits on an older
 * commit whenever the newest commits are docs or tests, and a verification that
 * shouts about that is one people learn to ignore. What must never pass is the
 * opposite case — the box running a commit that is not in this history, or one
 * newer than what is here — so the answer is "behind, and an ancestor" or "no".
 */
export function commitsBehind(root, rev, head, run = spawnSync) {
  if (!rev || !head) return null;
  const ancestor = run('git', ['merge-base', '--is-ancestor', rev, head], { cwd: root, encoding: 'utf8' });
  if (ancestor.error) return null;
  if (ancestor.status === 0) {
    const count = countRange(root, `${rev}..${head}`, run);
    return count === null ? null : { ancestor: true, behind: count };
  }
  if (ancestor.status === 1) return { ancestor: false, behind: 0 };
  return null;
}

async function fetchText(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}`, text: '' };
    return { ok: true, detail: `HTTP ${response.status}`, text: await response.text() };
  } catch (error) {
    return { ok: false, detail: error.message, text: '' };
  }
}

async function fetchBytes(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    return {
      ok: true,
      detail: `HTTP ${response.status}`,
      type: response.headers?.get?.('content-type') ?? '',
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * The post-deploy verdict. Every check answers "what does somebody else see",
 * never "what did the script intend": the remote health endpoint, the commit on
 * the box, the bytes behind the four public URLs and the browser core, and the
 * store's silence.
 * `before` is the silence snapshot taken *before* the deploy — the comparison
 * is the whole point of taking it early.
 */
export async function verifyCloudRelease({
  version,
  head,
  host = RELEASE_HOST,
  baseUrl = RELEASE_BASE_URL,
  before = null,
  run = spawnSync,
  fetchImpl = fetch,
  remoteRev = null,
  remoteRevBehind = null,
  core = null,
} = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // The deploy restarts the service and this probe runs immediately after it, so
  // a single `curl` races the bind: a release that succeeded perfectly answered
  // `curl: (7) Failed to connect` once and reported itself unverified. Retrying a
  // refused connection for a few seconds is what makes this check mean "the cloud
  // is not up" instead of "the cloud had not finished coming up".
  const health = sshText(run, host, 'curl -s --retry 5 --retry-connrefused --retry-delay 1 -m 3 localhost:7683/health');
  const healthBody = lastJsonObject(health.text);
  add('remote-health', health.ok && healthBody?.ok === true,
    health.ok ? `ok=${healthBody?.ok === true}, aiBridge=${healthBody?.aiBridge === true}` : health.detail);

  const revision = remoteRev ?? remoteRevision({ host, run });
  const matches = revision !== null && revision === head;
  const behindTolerated = !matches && remoteRevBehind?.ancestor === true && revision !== null;
  add('remote-rev', matches || behindTolerated,
    revision === null ? 'could not read HEAD on the box'
      : matches ? revision.slice(0, 12)
        : behindTolerated
          ? `${revision.slice(0, 12)} — ${remoteRevBehind.behind} commit(s) behind local HEAD, not deployed yet`
          : `${revision.slice(0, 12)} (expected ${String(head).slice(0, 12)})`);

  const urls = releaseAssetUrls(baseUrl, version);
  const index = await fetchText(fetchImpl, urls.index);
  const pins = [`app.js?v=${version}`, `app.css?v=${version}`];
  const missingPins = index.ok ? pins.filter((pin) => !index.text.includes(pin)) : pins;
  add('served-index', index.ok && missingPins.length === 0,
    index.ok ? (missingPins.length === 0 ? `pins ${pins.join(', ')}` : `missing ${missingPins.join(', ')}`) : index.detail);

  for (const [name, url] of [['served-app', urls.app], ['served-css', urls.css]]) {
    const asset = await fetchText(fetchImpl, url);
    add(name, asset.ok, `${url} → ${asset.detail}`);
  }

  const sw = await fetchText(fetchImpl, urls.sw);
  const swMissing = sw.ok ? pins.filter((pin) => !sw.text.includes(pin)) : pins;
  add('served-sw', sw.ok && swMissing.length === 0,
    sw.ok ? (swMissing.length === 0 ? `shell pins ${pins.join(', ')}` : `missing ${swMissing.join(', ')}`) : sw.detail);

  // The core is what `?core=1` loads; a release that shipped it is checked
  // byte for byte against what it built. `--check` has no build of its own to
  // compare with — the local pkg may be a dev build — so there it is "served,
  // as wasm, and really wasm", which still fails on a box that never got one.
  const coreProblems = [];
  for (const file of CORE_PKG_FILES) {
    const url = `${String(baseUrl).replace(/\/+$/u, '')}/tailchat/core/pkg/${file}`;
    const served = await fetchBytes(fetchImpl, url);
    if (!served.ok) {
      coreProblems.push(`${file} → ${served.detail}`);
      continue;
    }
    if (file.endsWith('.wasm')) {
      if (!served.type.startsWith('application/wasm')) coreProblems.push(`${file} served as ${served.type || 'no type'}`);
      if (!served.bytes.subarray(0, 4).equals(WASM_MAGIC)) coreProblems.push(`${file} is not WebAssembly`);
    }
    if (core?.digests && sha256(served.bytes) !== core.digests[file]) coreProblems.push(`${file} differs from the build`);
  }
  add('served-core', coreProblems.length === 0,
    coreProblems.length > 0 ? coreProblems.join('; ')
      : core?.digests ? `${CORE_PKG_FILES.join(', ')} match the build` : `${CORE_PKG_FILES.join(', ')} served`);

  const after = silenceProbe({ host, run });
  const regression = silenceRegression(before, after, version);
  add('silence', regression === null,
    regression === null
      ? `announcedVersion=${after?.announcedVersion ?? 'null'} unchanged, no message for ${version}`
      : `§9: ${regression.reason}${regression.id ? ` (${regression.id})` : ''}`);

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    checks,
    after,
    remoteRev: revision,
    summary: `${checks.length - failed.length}/${checks.length} checks passed${failed.length > 0 ? `: ${failed.map((check) => check.name).join(', ')}` : ''}`,
  };
}
