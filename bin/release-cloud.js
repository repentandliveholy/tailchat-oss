#!/usr/bin/env node
// Local half of a cloud release, in one command:
//
//   node bin/release-cloud.js            build core → push → deploy → ship core → verify
//   node bin/release-cloud.js --check    verify only (writes nothing anywhere)
//   node bin/release-cloud.js --dry-run  print what would happen and stop
//
// The order is the point. `bin/production-deploy.js` resets the box to
// `origin/main`, so pushing after it means the deploy ships the previous commit
// while the version checked afterwards describes the new one; and a deploy that
// is never checked against the public front can be "successful" on a box whose
// `index.html` still pins the previous `?v=` (§7) — the browser keeps serving
// the old bundle and nothing anywhere reports a failure.
//
// The remote half verifies itself (reset, install, restart by changed paths,
// Telegram report, rollback) and this script does not repeat any of that. What
// it adds is what the box cannot know about itself: whether the release stayed
// silent (§9) — and the one thing the box cannot make for itself, the browser
// core (`web/cloud/core/pkg/`, stage 7), which is compiled here and shipped
// after the deploy succeeded, so a rolled-back deploy never pairs the old page
// with a new core.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { installRoot } from '../src/update.js';
import {
  CORE_PKG_DIR,
  RELEASE_BASE_URL,
  RELEASE_BRANCH,
  RELEASE_HOST,
  REMOTE_DEPLOY_COMMAND,
  commitsBehind,
  fetchOriginMain,
  isProductionCheckout,
  localCoreBuild,
  releaseState,
  remoteRevision,
  silenceProbe,
  uploadCore,
  verifyCloudRelease,
} from '../src/release-cloud.js';

const { version } = createRequire(import.meta.url)('../package.json');

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const host = value('--host', RELEASE_HOST);
const baseUrl = value('--base', RELEASE_BASE_URL);
const checkOnly = args.includes('--check');
const dryRun = args.includes('--dry-run');
const root = installRoot();

function fail(reason) {
  process.stderr.write(`Tailchat cloud release failed: ${reason}\n`);
  process.exit(1);
}

function describeState(state) {
  switch (state.reason) {
    case 'dirty-checkout':
      return `${state.tracked} modified tracked file(s) — the box would receive something other than what was reviewed`;
    case 'not-main':
      return `branch ${state.branch} — the deploy resets the box to origin/main while the push would come from here`;
    case 'behind-origin':
      return `${state.behind} commit(s) behind origin/main — the box would ship a commit never verified here (git pull --ff-only)`;
    default:
      return state.reason;
  }
}

function step(command, argv, options) {
  process.stdout.write(`\n$ ${command} ${argv.join(' ')}\n`);
  const result = spawnSync(command, argv, options);
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${argv.join(' ')} exited ${result.status}`);
}

// This is the laptop's half of a release. On the box the checkout *is* the
// deployment, and both `git push` and `ssh <host>` from there are at best
// no-ops and at worst a release of the wrong thing; the server half is the
// command below.
if (isProductionCheckout(root)) {
  fail(`${root} is the production checkout — run 'node bin/production-deploy.js' there, and this script from the laptop`);
}

// `origin/main` first: without it "am I ahead or behind" answers about a stale
// ref, and a release that starts on a stale answer is exactly the failure this
// script is for. In `--check` a network hiccup is not a release failure.
const fetched = fetchOriginMain(root);
if (!fetched.ok) {
  if (checkOnly) process.stderr.write(`Warning: ${fetched.reason}; comparing against the last known origin/main.\n`);
  else fail(`git fetch origin main: ${fetched.reason}`);
}

const state = releaseState(root);
const tolerable = checkOnly && (state.reason === 'dirty-checkout' || state.reason === 'not-main');
if (!state.ok && !tolerable) fail(describeState(state));
if (!state.head) fail(`cannot read HEAD in ${root}`);

// Silence is snapshotted before anything is deployed — afterwards there is
// nothing left to compare against.
const before = silenceProbe({ host });
if (!before) process.stderr.write('Warning: silence snapshot before the deploy was unavailable.\n');
const baseline = before ? `announcedVersion=${before.announcedVersion ?? 'null'}` : 'unavailable';

process.stdout.write(
  `Tailchat ${version} cloud release: ${state.branch ?? 'unknown branch'}, head ${state.head.slice(0, 12)}, `
  + `${state.ahead ?? 0} ahead / ${state.behind ?? 0} behind origin/${RELEASE_BRANCH}, `
  + `${checkOnly ? 'check only' : 'push + deploy + verify'}.\n`,
);

if (dryRun) {
  for (const line of [
    `node bin/build-web-core.js (→ ${CORE_PKG_DIR})`,
    state.ahead > 0 ? `git push origin main (${state.ahead} commit(s) to publish)` : 'git push origin main (already up to date)',
    `ssh ${host} '${REMOTE_DEPLOY_COMMAND}'`,
    `tar ${CORE_PKG_DIR} | ssh ${host} (swap in place, compare digests)`,
    `verify ${baseUrl}: health, deployed revision, four public URLs, the core's bytes, silence (baseline ${baseline})`,
  ]) process.stdout.write(`  · ${line}\n`);
  process.exit(0);
}

let core = null;
if (!checkOnly) {
  // Built before anything is published: a compiler or toolchain failure must
  // stop the release while nothing has changed anywhere. The tree is clean
  // (releaseState), so these bytes are what HEAD's crates/ compile to.
  step(process.execPath, ['bin/build-web-core.js'], { cwd: root, stdio: 'inherit' });
  const build = localCoreBuild(root);
  if (!build.ok) fail(build.reason);

  step('git', ['push', 'origin', 'main'], { cwd: root, stdio: 'inherit' });
  step('ssh', [host, REMOTE_DEPLOY_COMMAND], { stdio: 'inherit' });

  process.stdout.write(`\n$ tar ${CORE_PKG_DIR} | ssh ${host} …\n`);
  const shipped = uploadCore({ root, host, build });
  if (!shipped.ok) fail(`browser core not shipped: ${shipped.reason}`);
  process.stdout.write(`browser core shipped (${Math.round(shipped.bytes / 1024)} KiB archive), digests match on the box.\n`);
  core = { digests: build.digests };
}

// `--check` answers "is production serving what this checkout claims", and
// production is allowed to sit on an older commit when the newest commits are
// docs or tests — but never on one that is not in this history. A full release
// has no such tolerance: the deploy just ran, so the box is either on this
// commit or the release did not happen.
const remoteRev = checkOnly ? remoteRevision({ host }) : null;
const remoteRevBehind = remoteRev && remoteRev !== state.head
  ? commitsBehind(root, remoteRev, state.head)
  : null;

const verified = await verifyCloudRelease({
  version, head: state.head, host, baseUrl, before, remoteRev, remoteRevBehind, core,
});
for (const check of verified.checks) {
  process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
}
process.stdout.write(`\n${verified.ok ? 'Release verified' : 'RELEASE NOT VERIFIED'}: ${verified.summary}\n`);
process.exit(verified.ok ? 0 : 1);
