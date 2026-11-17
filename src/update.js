import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const { existsSync } = fs;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranslator } from './i18n.js';
import { VERSION } from './version.js';

// The checkout this file is running from, so /update never upgrades some other
// copy that happens to be the shell's working directory.
export function installRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function isGitCheckout(root = installRoot()) {
  return existsSync(path.join(root, '.git'));
}

// Build a compact star-bordered banner box. Each content line is padded
// so all lines are the same width, then wrapped with `* … *` on both ends.
// The border is n stars joined by spaces (length 2n-1); n is chosen so
// border.length >= innerWidth+4. Content lines pad to border.length-4,
// keeping all rows exactly the same width.
// maxInner caps the content width so the box stays narrow-window-friendly.
export function makeUpdateBox(lines, maxInner = 32) {
  const clamp = (s) => (s.length > maxInner ? `${s.slice(0, maxInner - 1)}…` : s);
  const clamped = lines.map(clamp);
  const innerWidth = Math.max(...clamped.map((l) => l.length), 0);
  const n = Math.ceil((innerWidth + 5) / 2);
  const border = Array(n).fill('*').join(' ');
  const padWidth = border.length - 4;
  const boxLines = clamped.map((l) => `* ${l.padEnd(padWidth)} *`);
  return [border, ...boxLines, border].join('\n');
}


export const UPDATE_BORDER = '*'.repeat(20);

export function localUpdateBanner({
  root = installRoot(),
  version = VERSION,
  t = createTranslator('en'),
} = {}) {
  return makeUpdateBox([
    t('update.localTitle'),
    t('update.localVersion', { version }),
    t('update.localRoot', { root }),
    t('update.localEffect'),
  ]);
}

// The just-updated side sees this in the transcript once, at startup, when the
// version that last ran differs from the current one.
export function updatedBanner({
  version = VERSION,
  t = createTranslator('en'),
} = {}) {
  return makeUpdateBox([
    t('update.doneTitle'),
    t('update.doneVersion', { version }),
  ]);
}

// Whether this checkout holds work that a hard reset would take away. Asked
// before the stash rather than read back from it, because `git stash push`
// prints "No local changes to save" and still exits 0 — from a caller's side
// that is indistinguishable from having saved something. The count is worth
// knowing because the stash is otherwise silent: work goes in, the update
// succeeds, and nothing on screen ever says where it went.
export function dirtyCount(root = installRoot(), run = spawnSync) {
  const result = run('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null; // unknown, so claim nothing
  return String(result.stdout ?? '').split('\n').filter((line) => line.trim() !== '').length;
}

// Undoes a half-finished update. `commit` is where this checkout stood before
// the reset; reinstalling is not optional, because the dependencies belong to
// that commit and coming back without them recreates exactly the broken pairing
// being undone.
export function rollbackTo(commit, { execute, installStep }) {
  if (!commit) return { ok: false, reason: 'no-recorded-commit' };
  const resetFailure = execute('git', ['reset', '--hard', commit]);
  if (resetFailure) return { ok: false, reason: resetFailure, commit };
  const installFailure = execute(...installStep);
  if (installFailure) return { ok: false, reason: installFailure, commit, reset: true };
  return { ok: true, commit };
}

// Fetch first: a network failure must leave local work exactly where it was.
// Once the target exists locally, preserve dirty files in a stash, preserve
// divergent commits on a backup branch, and replace this checkout with main.
// /update always operates on installRoot(), so this also repairs an old global
// link even when the person ran git commands in a different clone.
export function runUpdate({
  root = installRoot(),
  run = spawnSync,
  out = process.stdout,
  platform = process.platform,
} = {}) {
  if (!isGitCheckout(root)) {
    return { ok: false, reason: 'not-a-checkout', root };
  }
  const from = headCommit(root, run);
  out.write(`\ntailchat checkout: ${root}\n`);
  const execute = (command, args) => {
    out.write(`\n$ ${command} ${args.join(' ')}\n`);
    const result = run(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) return result.error.message;
    if (result.status !== 0) return `${command} exited ${result.status}`;
    return null;
  };

  const fetchFailure = execute('git', ['fetch', 'origin', 'main']);
  if (fetchFailure) return { ok: false, reason: fetchFailure, root, command: 'git' };

  // A hard reset must not make local commits dependent on an expiring reflog.
  // Exit 1 means HEAD is not an ancestor, not that merge-base itself failed.
  const ancestry = run('git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], {
    cwd: root,
    stdio: 'ignore',
  });
  if (ancestry.error) return { ok: false, reason: ancestry.error.message, root, command: 'git' };
  if (ancestry.status !== 0 && ancestry.status !== 1) {
    return { ok: false, reason: `git exited ${ancestry.status}`, root, command: 'git' };
  }
  if (ancestry.status === 1) {
    const suffix = from ? from.slice(0, 12) : String(Date.now());
    const backupFailure = execute('git', ['branch', '--force', `tailchat-update-backup-${suffix}`, 'HEAD']);
    if (backupFailure) return { ok: false, reason: backupFailure, root, command: 'git' };
  }

  // Node cannot execute a Windows .cmd shim directly. Invoke cmd.exe with a
  // fixed command instead of shell:true, which is deprecated when args are
  // also supplied and produced DEP0190 on every update.
  const installStep = platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --silent --no-audit']]
    : ['npm', ['ci', '--silent', '--no-audit']];

  const stashed = dirtyCount(root, run);
  const stashFailure = execute('git', [
    '-c', 'user.name=tailchat updater',
    '-c', 'user.email=tailchat@localhost',
    'stash', 'push', '--include-untracked', '--message', 'tailchat auto-update',
  ]);
  if (stashFailure) return { ok: false, reason: stashFailure, root, command: 'git', stashed };

  // Past this line the working tree has already been replaced, so a failure is
  // the dangerous kind: the checkout sits on the new code with the old
  // dependencies, the next start can fail outright, and the person is left with
  // no working client and no obvious way back. So a failure here goes back to
  // the commit we came from instead of being reported from the wreckage.
  //
  // The considered alternative was staging the whole update in a separate
  // worktree and switching only once `npm install` had proved itself there. It
  // was rejected: the switch is not atomic for a process that is running out of
  // this very directory, so it relocates the risk rather than removing it, and
  // it doubles the install cost of every ordinary update to insure against a
  // rare one. Going back to a commit that already worked is smaller and always
  // available.
  for (const [command, args] of [['git', ['reset', '--hard', 'FETCH_HEAD']], installStep]) {
    const failure = execute(command, args);
    if (!failure) continue;
    const rollback = rollbackTo(from, { execute, installStep });
    return {
      ok: false, reason: failure, root, command, stashed, rollback,
    };
  }
  return { ok: true, root, from, stashed };
}

// One place decides what an update outcome is worth saying out loud, so
// `tailchat --update` on a terminal and `/update` inside the chat can never
// disagree about it. Everything here is about the two things a failed update
// leaves behind that a person cannot see: work in the stash, and whether the
// checkout is still the one that worked.
export function updateNotices(result, t = createTranslator('en')) {
  const lines = [];
  if (result.stashed > 0) lines.push(t('update.stashed', { count: result.stashed }));
  const { rollback } = result;
  if (!rollback) return lines;
  if (rollback.ok) {
    lines.push(t('update.rolledBack', { commit: rollback.commit.slice(0, 12) }));
  } else if (rollback.commit) {
    lines.push(t('update.rollbackFailed', {
      reason: rollback.reason, commit: rollback.commit.slice(0, 12),
    }));
  } else {
    // Without a recorded commit there is nothing to name, but `git reset` wrote
    // ORIG_HEAD on its way through, so the way back still exists.
    lines.push(t('update.rollbackUnknown'));
  }
  return lines;
}

// Both `/update` inside the TUI and `tailchat --update` use this exact wrapper:
// one visible banner, then the update. Keeping the write here prevents either
// caller from accidentally printing it twice.
export function runLocalUpdate({
  root = installRoot(),
  run = spawnSync,
  out = process.stdout,
  t = createTranslator('en'),
  platform = process.platform,
} = {}) {
  out.write(`${localUpdateBanner({ root, t })}\n`);
  return runUpdate({ root, run, out, platform });
}

// `tailchat --update`: upgrade this checkout and leave, without a chat
// session. Returns the process exit code; the caller owns process.exit.
export function runCliUpdate({
  root = installRoot(),
  run = spawnSync,
  t = createTranslator('en'),
  out = process.stdout,
  err = process.stderr,
} = {}) {
  if (!isGitCheckout(root)) {
    err.write(`${t('update.notCheckout', { root })}\n`);
    return 1;
  }
  const result = runLocalUpdate({ root, run, out, t });
  const notices = updateNotices(result, t);
  if (!result.ok) {
    err.write(`${t('update.failed', { reason: result.reason })}\n`);
    for (const line of notices) err.write(`${line}\n`);
    return 1;
  }
  for (const line of notices) out.write(`${line}\n`);
  out.write(`${t('update.ok')}\n`);
  return 0;
}

// What actually changed, so the person who just updated learns it from the
// chat instead of reading a git log they did not ask for.
export function headCommit(root = installRoot(), run = spawnSync) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '').trim() || null;
}

export function changesSince(from, {
  root = installRoot(),
  run = spawnSync,
  limit = 10,
} = {}) {
  if (!from) return [];
  const result = run('git', ['log', '--pretty=format:%s', `${from}..HEAD`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:v?\d+\.\d+\.\d+[:\s-]*|\[[^\]]+\]\s*)/, ''))
    // Only what a user can notice. Chores, tests and refactors changed nothing
    // they can see, and listing them buries the two lines that matter.
    .filter((line) => /^(feat|fix)(\(|!|:)/i.test(line))
    .map((line) => line.replace(/^(feat|fix)(\([^)]*\))?!?:\s*/i, ''))
    .slice(0, limit);
}

// Node cannot replace its own image the way execve does, so the new version
// runs as a child on the same terminal and this process waits for it. The
// alternative — telling the user to start tailchat again — loses the session
// they were in the middle of.
export const DEPTH_VAR = 'TAILCHAT_RELAUNCH_DEPTH';

// Node cannot replace its own image the way execve does, so the new version
// runs as a child on the same terminal while this process waits for it. Handing
// the terminal to a detached child is not an option: the shell would take it
// back the moment we exit and then both would read the same keyboard.
//
// The price is one idle parent per upgrade, and a person who updates all day
// ends up with a chain of them. So the chain is bounded: past this depth the
// upgrade still happens, but the last word is left to the user.
export const MAX_RELAUNCH_DEPTH = 3;

export function relaunchDepth(env = process.env) {
  const depth = Number.parseInt(String(env[DEPTH_VAR] ?? '0'), 10);
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

export function relaunch({
  execPath = process.execPath,
  script = process.argv[1],
  args = process.argv.slice(2),
  env = process.env,
  run = spawnSync,
} = {}) {
  const depth = relaunchDepth(env);
  if (depth >= MAX_RELAUNCH_DEPTH) return { ok: false, reason: 'too-deep', depth };
  const result = run(execPath, [script, ...args], {
    stdio: 'inherit',
    env: { ...env, [DEPTH_VAR]: String(depth + 1) },
  });
  if (result.error) return { ok: false, reason: result.error.message, depth };
  return { ok: true, status: result.status ?? 0, depth };
}

// bin/tailchat.js runs the client in a loop and starts it
// again when it leaves with this code, so an upgrade costs no waiting parent.
export const SUPERVISOR_VAR = 'TAILCHAT_SUPERVISOR';

// 75 is EX_TEMPFAIL from sysexits(3): "try again later". It is the closest
// conventional meaning to "I am done, start me again", it is outside the range
// Node uses for its own fatal exits (1-13) and outside 128+signal, so no crash
// or kill can be mistaken for a restart request.
export const RESTART_EXIT_CODE = 75;

export function isSupervised(env = process.env) {
  const flag = env[SUPERVISOR_VAR];
  return flag !== undefined && flag !== '' && flag !== '0';
}

// The single place that decides how the new version gets started. Supervised,
// nothing is spawned and no depth is counted: the wrapper is already waiting in
// its loop and will start the new version once this process is gone.
export function restartAfterUpdate({ env = process.env, ...rest } = {}) {
  if (isSupervised(env)) return { ok: true, supervised: true, exitCode: RESTART_EXIT_CODE };
  return relaunch({ env, ...rest });
}

// What version last ran from this checkout. Kept on disk rather than handed to
// the child process, so a plain `git pull && npm install` reports its changes
// too — not only an upgrade started from inside the app.
const STATE_FILE = 'last-run.json';

export function readLastRun(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
    const state = JSON.parse(raw);
    const version = typeof state?.version === 'string' ? state.version : null;
    const commit = typeof state?.commit === 'string' ? state.commit : null;
    return version ? { version, commit } : null;
  } catch {
    return null;
  }
}

export function writeLastRun(dir, { version, commit }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `${STATE_FILE}.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ version, commit }), { mode: 0o600 });
    fs.renameSync(temp, path.join(dir, STATE_FILE));
    return true;
  } catch {
    // Losing the marker only costs one missed report; it must never stop the app.
    return false;
  }
}
