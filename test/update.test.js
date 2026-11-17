import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import {
  runUpdate, relaunch, changesSince, headCommit, readLastRun, writeLastRun,
  isGitCheckout, installRoot, relaunchDepth, MAX_RELAUNCH_DEPTH, DEPTH_VAR,
  restartAfterUpdate, isSupervised, RESTART_EXIT_CODE, SUPERVISOR_VAR, runCliUpdate,
  localUpdateBanner, runLocalUpdate, updatedBanner,
  dirtyCount, rollbackTo, updateNotices,
} from '../src/update.js';


import { createTranslator, LANGUAGES } from '../src/i18n.js';

test('the local update banner is complete and framed in every language', () => {
  for (const lang of LANGUAGES) {
    const banner = localUpdateBanner({
      root: '/x/tailchat', version: '0.50.2', t: createTranslator(lang),
    });
    const lines = banner.split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[0], /^(\* ){6,}/);
    assert.equal(lines.at(-1), lines[0]);
    assert.match(banner, /0\.50\.2/);
    assert.match(banner, /\/x\/tailchat/);
  }
});

test('the updated banner is framed and localized for the just-updated side', () => {
  for (const lang of LANGUAGES) {
    const banner = updatedBanner({ version: '0.50.4', t: createTranslator(lang) });
    const lines = banner.split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^(\* ){6,}/);
    assert.equal(lines.at(-1), lines[0]);
    assert.match(banner, new RegExp(createTranslator(lang)('update.doneTitle')));
    assert.match(banner, /0\.50\.4/);
  }
});



test('runLocalUpdate prints the banner once before running the update', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const written = [];
    const run = (command, args, options) => {
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'sha\n' };
      return { status: 0, stdout: '' };
    };
    const result = runLocalUpdate({
      root,
      run,
      out: { write: (chunk) => written.push(String(chunk)) },
      t: (k) => k,
    });
    assert.equal(result.ok, true);
    const out = written.join('');
    assert.match(out, /update\.localTitle/);
    assert.match(out, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-update-'));

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return String(result.stdout ?? '').trim();
};

test('the install root is this checkout, not the shell working directory', () => {
  const root = installRoot();
  assert.ok(fs.existsSync(path.join(root, 'package.json')), `${root} has no package.json`);
  assert.ok(fs.existsSync(path.join(root, 'src', 'update.js')));
});

test('a directory without .git is refused instead of upgrading the wrong thing', () => {
  const root = tempRoot();
  try {
    assert.equal(isGitCheckout(root), false);
    const calls = [];
    const result = runUpdate({ root, run: (...args) => calls.push(args), out: { write() {} } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-a-checkout');
    assert.deepEqual(calls, [], 'nothing may run outside a checkout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a successful update fetches, saves local work, resets, and installs inside the checkout', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const calls = [];
    const output = [];
    const result = runUpdate({
      root,
      out: { write: (chunk) => output.push(String(chunk)) },
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0, stdout: 'sha1\n' };
      },
    });
    assert.equal(result.ok, true);
    // The starting point is read first so the new version can report what
    // changed once it comes up.
    assert.deepEqual(
      calls.map((c) => c.command),
      ['git', 'git', 'git', 'git', 'git', 'git', 'npm'],
    );
    assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
    assert.equal(result.from, 'sha1');
    assert.ok(output.join('').includes(`tailchat checkout: ${root}`));
    assert.deepEqual(calls[1].args, ['fetch', 'origin', 'main']);
    assert.deepEqual(calls[2].args, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
    // The dirty check comes before the stash: `git stash push` says
    // "No local changes to save" and still exits 0, so nothing else can tell
    // the caller whether work was put away.
    assert.deepEqual(calls[3].args, ['status', '--porcelain']);
    assert.deepEqual(calls[4].args, [
      '-c', 'user.name=tailchat updater',
      '-c', 'user.email=tailchat@localhost',
      'stash', 'push', '--include-untracked', '--message', 'tailchat auto-update',
    ]);
    assert.deepEqual(calls[5].args, ['reset', '--hard', 'FETCH_HEAD']);
    assert.deepEqual(calls[6].args, ['ci', '--silent', '--no-audit']);
    for (const call of calls) assert.equal(call.cwd, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// The failure this is about: dependency installation is the last step, and by
// the time it runs the working tree has already been replaced. Left there, the
// checkout has the new code and old dependencies, so the next start can fail.
test('an update that breaks on the install puts the checkout back', () => {
  const workspace = tempRoot();
  const remote = path.join(workspace, 'remote.git');
  const seed = path.join(workspace, 'seed');
  const checkout = path.join(workspace, 'checkout');
  try {
    fs.mkdirSync(seed);
    git(workspace, 'init', '--bare', '--initial-branch=main', remote);
    fs.writeFileSync(path.join(seed, 'release.txt'), 'v1\n');
    git(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'user.name', 'Tailchat Test');
    git(seed, 'config', 'user.email', 'tailchat@example.invalid');
    git(seed, 'add', 'release.txt');
    git(seed, 'commit', '-m', 'v1');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', 'origin', 'main');
    git(workspace, 'clone', remote, checkout);

    const before = git(checkout, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(seed, 'release.txt'), 'v2\n');
    git(seed, 'add', 'release.txt');
    git(seed, 'commit', '-m', 'v2');
    git(seed, 'push', 'origin', 'main');

    const installs = [];
    const result = runUpdate({
      root: checkout,
      out: { write() {} },
      run: (command, args, options) => {
        if (command === 'npm') {
          installs.push(args);
          // Fails on the way up, succeeds on the way back: a rollback whose own
          // install fails is a different case, covered separately.
          return { status: installs.length === 1 ? 1 : 0, stdout: '', error: null };
        }
        return spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' });
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /npm exited 1/);
    assert.equal(result.rollback.ok, true);
    assert.equal(result.rollback.commit, before);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), before, 'the checkout is back where it was');
    assert.equal(
      fs.readFileSync(path.join(checkout, 'release.txt'), 'utf8'), 'v1\n',
      'and holds the code that actually worked',
    );
    assert.equal(installs.length, 2, 'the dependencies of the old commit are reinstalled');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a rollback needs a commit to go back to, and says when it has none', () => {
  const attempted = [];
  const execute = (command, args) => { attempted.push(`${command} ${args.join(' ')}`); return null; };
  const blind = rollbackTo(null, { execute, installStep: ['npm', ['install']] });
  assert.equal(blind.ok, false);
  assert.equal(blind.reason, 'no-recorded-commit');
  assert.deepEqual(attempted, [], 'nothing is reset when there is nowhere to reset to');

  const good = rollbackTo('abc123', { execute, installStep: ['npm', ['install']] });
  assert.equal(good.ok, true);
  assert.deepEqual(attempted, ['git reset --hard abc123', 'npm install']);
});

test('a rollback that cannot reinstall reports how far it got', () => {
  const failing = (command) => (command === 'npm' ? 'npm exited 1' : null);
  const result = rollbackTo('abc123', { execute: failing, installStep: ['npm', ['install']] });
  assert.equal(result.ok, false);
  assert.equal(result.reset, true, 'the code went back even though the dependencies did not');
  assert.match(result.reason, /npm exited 1/);
});

// The incident this comes from: the updater stashed uncommitted work, the
// update succeeded, and nothing anywhere said where the work had gone.
test('work the updater put away is counted, so it can be mentioned', () => {
  const root = tempRoot();
  try {
    assert.equal(
      dirtyCount(root, () => ({ status: 0, stdout: ' M src/cli.js\n?? src/new.js\n' })),
      2,
    );
    assert.equal(dirtyCount(root, () => ({ status: 0, stdout: '' })), 0, 'a clean tree is zero');
    assert.equal(
      dirtyCount(root, () => ({ status: 128, stdout: '' })), null,
      'an unanswerable question claims nothing rather than guessing zero',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every update outcome a person cannot see gets said out loud', () => {
  const t = createTranslator('en');
  assert.deepEqual(updateNotices({ ok: true, stashed: 0 }, t), [], 'a clean update says nothing extra');

  const [saved] = updateNotices({ ok: true, stashed: 3 }, t);
  assert.match(saved, /3 uncommitted/);
  assert.match(saved, /git stash pop/, 'the way back is part of the sentence');

  const back = updateNotices({
    ok: false, stashed: 0, rollback: { ok: true, commit: 'abcdef0123456789' },
  }, t);
  assert.match(back[0], /abcdef012345/);
  assert.ok(!back[0].includes('abcdef0123456789'), 'the sha is shortened for reading');

  const stuck = updateNotices({
    ok: false, stashed: 0, rollback: { ok: false, reason: 'npm exited 1', commit: 'abcdef0123456789' },
  }, t);
  assert.match(stuck[0], /git reset --hard abcdef012345 && npm install/);

  const blind = updateNotices({
    ok: false, stashed: 1, rollback: { ok: false, reason: 'no-recorded-commit' },
  }, t);
  assert.equal(blind.length, 2, 'the stash and the checkout are two separate facts');
  assert.match(blind[1], /ORIG_HEAD/, 'git still left a way back even with no sha recorded');
});

test('the outcome notices exist in every language', () => {
  for (const lang of LANGUAGES) {
    const lines = updateNotices({
      ok: false, stashed: 2, rollback: { ok: false, reason: 'npm exited 1', commit: 'abcdef0123456789' },
    }, createTranslator(lang));
    assert.equal(lines.length, 2, `${lang} says both facts`);
    for (const line of lines) assert.ok(line.length > 0);
  }
});


test('a dirty diverged checkout updates and preserves files and commits', () => {
  const workspace = tempRoot();
  const remote = path.join(workspace, 'remote.git');
  const seed = path.join(workspace, 'seed');
  const checkout = path.join(workspace, 'checkout');
  try {
    fs.mkdirSync(seed);
    git(workspace, 'init', '--bare', '--initial-branch=main', remote);
    git(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'user.name', 'Tailchat Test');
    git(seed, 'config', 'user.email', 'tailchat@example.invalid');
    fs.writeFileSync(path.join(seed, 'package-lock.json'), 'remote lock\n');
    fs.writeFileSync(path.join(seed, 'release.txt'), 'v1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-u', 'origin', 'main');
    git(workspace, 'clone', remote, checkout);
    git(checkout, 'config', 'user.name', 'Tailchat Test');
    git(checkout, 'config', 'user.email', 'tailchat@example.invalid');
    fs.writeFileSync(path.join(checkout, 'local-only.txt'), 'local commit\n');
    git(checkout, 'add', 'local-only.txt');
    git(checkout, 'commit', '-m', 'local work');
    const oldHead = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'config', '--unset', 'user.name');
    git(checkout, 'config', '--unset', 'user.email');
    const isolatedHome = path.join(workspace, 'empty-home');
    fs.mkdirSync(isolatedHome);

    fs.writeFileSync(path.join(checkout, 'package-lock.json'), 'local lock\n');
    fs.writeFileSync(path.join(seed, 'release.txt'), 'v2\n');
    git(seed, 'add', 'release.txt');
    git(seed, 'commit', '-m', 'release');
    git(seed, 'push', 'origin', 'main');

    const result = runUpdate({
      root: checkout,
      out: { write() {} },
      run: (command, args, options) => {
        if (command === 'npm') return { status: 0, stdout: '', error: null };
        return spawnSync(command, args, {
          ...options,
          stdio: 'pipe',
          encoding: 'utf8',
          env: { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome },
        });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.from, oldHead);
    assert.equal(fs.readFileSync(path.join(checkout, 'release.txt'), 'utf8'), 'v2\n');
    assert.equal(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'), 'remote lock\n');
    assert.match(git(checkout, 'stash', 'list'), /tailchat auto-update/);
    assert.match(git(checkout, 'stash', 'show', '-p', 'stash@{0}'), /local lock/);
    assert.equal(
      git(checkout, 'log', '-1', '--format=%an <%ae>', 'refs/stash'),
      'tailchat updater <tailchat@localhost>',
    );
    const backup = `tailchat-update-backup-${oldHead.slice(0, 12)}`;
    assert.equal(git(checkout, 'rev-parse', backup), oldHead);
    assert.equal(git(checkout, 'show', `${backup}:local-only.txt`), 'local commit');
    assert.equal(git(checkout, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a failed fetch stops before local work is stashed', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const calls = [];
    const result = runUpdate({
      root,
      out: { write() {} },
      run: (command, args) => {
        calls.push(`${command} ${args[0]}`);
        return { status: args[0] === 'fetch' ? 1 : 0, stdout: 'sha1\n' };
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /git exited 1/);
    assert.deepEqual(calls, ['git rev-parse', 'git fetch'], 'stash must not run after a failed fetch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('relaunch starts the same script with the same arguments', () => {
  const seen = [];
  const result = relaunch({
    execPath: '/usr/bin/node',
    script: '/opt/tailchat/src/cli.js',
    args: ['lit', '--name', 'Me'],
    run: (execPath, argv, options) => {
      seen.push({ execPath, argv, stdio: options.stdio });
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.deepEqual(seen, [{
    execPath: '/usr/bin/node',
    argv: ['/opt/tailchat/src/cli.js', 'lit', '--name', 'Me'],
    // The new version must own the real terminal, not a pipe.
    stdio: 'inherit',
  }]);
});

test('relaunch reports a spawn failure instead of exiting silently', () => {
  const result = relaunch({
    run: () => ({ error: new Error('ENOENT') }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ENOENT/);
});

const gitLog = (subjects) => ({ status: 0, stdout: subjects.join('\n') });

test('only user-visible changes are reported after an update', () => {
  const changes = changesSince('abc123', {
    root: '/tmp',
    run: () => gitLog([
      'feat: restart tailchat after a successful /update',
      'chore: bump dependencies',
      'fix(ui): complete the highlighted command on Enter',
      'test: cover the relaunch path',
      'refactor: tidy the composer',
      'feat!: drop the legacy frame',
    ]),
  });
  // Chores, tests and refactors changed nothing the user can notice, and
  // listing them buries the lines that matter.
  assert.deepEqual(changes, [
    'restart tailchat after a successful /update',
    'complete the highlighted command on Enter',
    'drop the legacy frame',
  ]);
});

test('a missing starting point or a failed git log reports nothing', () => {
  assert.deepEqual(changesSince(null, { run: () => gitLog(['feat: x']) }), []);
  assert.deepEqual(changesSince('abc', { root: '/tmp', run: () => ({ status: 128 }) }), []);
  assert.deepEqual(changesSince('abc', { root: '/tmp', run: () => ({ error: new Error('no git') }) }), []);
});

test('the change list is capped so it cannot fill the screen', () => {
  const many = Array.from({ length: 40 }, (_, n) => `feat: change ${n}`);
  const changes = changesSince('abc', { root: '/tmp', limit: 10, run: () => gitLog(many) });
  assert.equal(changes.length, 10);
});

test('headCommit reports the sha, and nothing when git cannot answer', () => {
  assert.equal(headCommit('/tmp', () => ({ status: 0, stdout: 'deadbeef\n' })), 'deadbeef');
  assert.equal(headCommit('/tmp', () => ({ status: 128 })), null);
  assert.equal(headCommit('/tmp', () => ({ error: new Error('nope') })), null);
});

test('the last run is remembered on disk, so a manual git pull is reported too', () => {
  const dir = tempRoot();
  try {
    assert.equal(readLastRun(dir), null, 'a first run has nothing to compare against');

    assert.equal(writeLastRun(dir, { version: '0.20.0', commit: 'abc' }), true);
    assert.deepEqual(readLastRun(dir), { version: '0.20.0', commit: 'abc' });

    // Overwriting is how the marker moves forward after each start.
    writeLastRun(dir, { version: '0.21.0', commit: 'def' });
    assert.deepEqual(readLastRun(dir), { version: '0.21.0', commit: 'def' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged marker is ignored rather than crashing the client', () => {
  const dir = tempRoot();
  try {
    fs.writeFileSync(path.join(dir, 'last-run.json'), 'not json');
    assert.equal(readLastRun(dir), null);

    fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify({ commit: 'abc' }));
    assert.equal(readLastRun(dir), null, 'a marker without a version says nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable state directory costs a report, not the session', () => {
  // A directory "inside" a plain file is ENOTDIR on every OS. Not /proc: there
  // Linux answers ENOENT under an existing parent and a recursive mkdirSync
  // retries that step forever — the CI job spun at full CPU on this one line.
  const root = tempRoot();
  try {
    const file = path.join(root, 'plain-file');
    fs.writeFileSync(file, 'x');
    assert.equal(writeLastRun(path.join(file, 'state'), { version: '1', commit: 'a' }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each relaunch counts itself, so the chain of waiting parents is bounded', () => {
  assert.equal(relaunchDepth({}), 0);
  assert.equal(relaunchDepth({ [DEPTH_VAR]: '2' }), 2);
  assert.equal(relaunchDepth({ [DEPTH_VAR]: 'nonsense' }), 0);

  let childEnv;
  const run = (execPath, argv, options) => { childEnv = options.env; return { status: 0 }; };
  const first = relaunch({ script: '/x/cli.js', args: [], env: { PATH: '/bin' }, run });
  assert.equal(first.ok, true);
  assert.equal(childEnv[DEPTH_VAR], '1');
  assert.equal(childEnv.PATH, '/bin', 'the rest of the environment survives');
});

test('past the limit the update happens but the restart is left to the user', () => {
  // Every restart leaves its parent waiting for it — Node cannot replace its own
  // image — so an all-day updater would otherwise pile up idle processes.
  let spawned = false;
  const result = relaunch({
    script: '/x/cli.js',
    args: [],
    env: { [DEPTH_VAR]: String(MAX_RELAUNCH_DEPTH) },
    run: () => { spawned = true; return { status: 0 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-deep');
  assert.equal(spawned, false, 'nothing may be started past the limit');
});

test('on Windows npm runs through cmd.exe without shell:true', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const calls = [];
    runUpdate({
      root,
      platform: 'win32',
      out: { write() {} },
      run: (command, args, options) => {
        if (args[0] !== 'rev-parse') calls.push({ command, args, options });
        return { status: 0, stdout: 'sha1\n' };
      },
    });
    assert.deepEqual(
      calls.map(({ command }) => command),
      ['git', 'git', 'git', 'git', 'git', 'cmd.exe'],
    );
    assert.deepEqual(calls.at(-1).args, ['/d', '/s', '/c', 'npm ci --silent --no-audit']);
    for (const call of calls) assert.equal(Object.hasOwn(call.options, 'shell'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('elsewhere every update step runs without a shell', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const optionsSeen = [];
    runUpdate({
      root,
      platform: 'darwin',
      out: { write() {} },
      run: (command, args, options) => {
        if (args[0] !== 'rev-parse') optionsSeen.push(options);
        return { status: 0, stdout: 'sha1\n' };
      },
    });
    assert.equal(optionsSeen.length, 6);
    for (const options of optionsSeen) assert.equal(Object.hasOwn(options, 'shell'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the restart code is the one the wrapper watches for', () => {
  // bin/tailchat.js compares against a literal 75; changing
  // this number without changing them turns every update into a silent exit.
  assert.equal(RESTART_EXIT_CODE, 75);
  assert.equal(SUPERVISOR_VAR, 'TAILCHAT_SUPERVISOR');
});

test('supervision is read from the environment and assumed absent', () => {
  // Guessing "supervised" when nothing set the marker would exit the client
  // for good instead of restarting it.
  assert.equal(isSupervised({}), false);
  assert.equal(isSupervised({ [SUPERVISOR_VAR]: '' }), false);
  assert.equal(isSupervised({ [SUPERVISOR_VAR]: '0' }), false);
  assert.equal(isSupervised({ [SUPERVISOR_VAR]: '1' }), true);
});

test('under the supervisor the update starts nothing and counts no depth', () => {
  // The whole point of the wrapper: the chain of waiting parents ends here.
  const result = restartAfterUpdate({
    env: { [SUPERVISOR_VAR]: '1', [DEPTH_VAR]: String(MAX_RELAUNCH_DEPTH) },
    script: '/x/cli.js',
    args: [],
    run: () => assert.fail('a supervised update must not spawn a child'),
  });
  assert.deepEqual(result, { ok: true, supervised: true, exitCode: RESTART_EXIT_CODE });
});

test('without the supervisor the update still relaunches, and still stops at the cap', () => {
  const seen = [];
  const run = (execPath, argv) => { seen.push(argv); return { status: 0 }; };
  const started = restartAfterUpdate({
    env: { PATH: '/bin' }, execPath: '/usr/bin/node', script: '/x/cli.js', args: ['lit'], run,
  });
  assert.equal(started.ok, true);
  assert.equal(started.supervised, undefined);
  assert.deepEqual(seen, [['/x/cli.js', 'lit']]);

  const capped = restartAfterUpdate({
    env: { [DEPTH_VAR]: String(MAX_RELAUNCH_DEPTH) },
    script: '/x/cli.js',
    args: [],
    run: () => assert.fail('nothing may be started past the limit'),
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'too-deep');
});

const FAKE_RUN = (calls) => (command, args, options) => {
  calls.push({ command, args, options });
  if (command === 'git') return { status: 0, stdout: 'abc123\n', error: null };
  return { status: 0, stdout: '', error: null };
};

test('runCliUpdate: not a checkout exits 1 and says update.notCheckout', () => {
  const dir = tempRoot();
  try {
    const err = new PassThrough();
    const written = [];
    err.on('data', (chunk) => written.push(String(chunk)));
    const code = runCliUpdate({ root: dir, run: FAKE_RUN([]), t: (k) => k, out: new PassThrough(), err });
    assert.equal(code, 1);
    assert.match(written.join(''), /update\.notCheckout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCliUpdate: fetches, saves local work, resets, installs, and exits 0', () => {
  const dir = tempRoot();
  try {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const calls = [];
    const out = new PassThrough();
    const written = [];
    out.on('data', (chunk) => written.push(String(chunk)));
    const code = runCliUpdate({ root: dir, run: FAKE_RUN(calls), t: (k) => k, out, err: new PassThrough() });
    assert.equal(code, 0);
    assert.match(written.join(''), /update\.ok/);
    assert.ok(written.join('').includes(`tailchat checkout: ${dir}`));
    assert.deepEqual(calls.map((c) => [c.command, c.args, c.options.cwd]), [
      ['git', ['rev-parse', 'HEAD'], dir],
      ['git', ['fetch', 'origin', 'main'], dir],
      ['git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], dir],
      // Asked before the stash, because `git stash push` exits 0 whether it
      // saved anything or not: this is the only way to know there was work.
      ['git', ['status', '--porcelain'], dir],
      ['git', [
        '-c', 'user.name=tailchat updater',
        '-c', 'user.email=tailchat@localhost',
        'stash', 'push', '--include-untracked', '--message', 'tailchat auto-update',
      ], dir],
      ['git', ['reset', '--hard', 'FETCH_HEAD'], dir],
      ['npm', ['ci', '--silent', '--no-audit'], dir],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCliUpdate: a failed fetch exits 1 with update.failed', () => {
  const dir = tempRoot();
  try {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const run = (command) => ({ status: command === 'git' ? 1 : 0, stdout: '', error: null });
    const err = new PassThrough();
    const written = [];
    err.on('data', (chunk) => written.push(String(chunk)));
    const code = runCliUpdate({ root: dir, run, t: (k) => k, out: new PassThrough(), err });
    assert.equal(code, 1);
    assert.match(written.join(''), /update\.failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
