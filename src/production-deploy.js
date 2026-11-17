import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import {
  headCommit,
  installRoot,
  isGitCheckout,
  rollbackTo,
} from './update.js';

export const PRODUCTION_APPS = Object.freeze([
  'tailchat-cloud',
  'tailchat-gateway',
]);

// The installer serves a snapshot of the source tree, and nothing rebuilt it:
// `curl … | bash` handed out 0.63c long after 0.80c was live. It is a build
// artifact, so it is generated here from the commit being deployed instead of
// being carried in git.
export const INSTALLER_ARCHIVE = 'web/cloud/tailchat.tar.gz';

export const PRODUCTION_EXTERNAL_CHECKS = Object.freeze([
  {
    label: 'caddy',
    path: '/etc/caddy/Caddyfile',
    markers: [
      ['/tailchat route', '/tailchat'],
      ['cloud upstream', 'reverse_proxy 127.0.0.1:7683'],
      ['forwarded host', 'header_up X-Forwarded-Host {host}'],
      ['upstream host', 'header_up Host {host}'],
    ],
  },
  {
    label: 'tailik gateway',
    path: '/home/godsheep/.tailik/gateway.mjs',
    markers: [
      ['latin Tailik name', 'tailik'],
      ['Tailik spelling тэйлик', 'тэйлик'],
      ['Tailik spelling тайлик', 'тайлик'],
    ],
  },
]);

export function validateExternalConfiguration({
  checks = PRODUCTION_EXTERNAL_CHECKS,
  readFile = fs.readFileSync,
} = {}) {
  for (const check of checks) {
    let content;
    try {
      content = readFile(check.path, 'utf8');
    } catch (error) {
      return {
        ok: false,
        reason: 'external-config-unreadable',
        label: check.label,
        path: check.path,
        code: error?.code || null,
      };
    }
    const missing = check.markers
      .filter(([, marker]) => !content.includes(marker))
      .map(([label]) => label);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'external-config-drift',
        label: check.label,
        path: check.path,
        missing,
      };
    }
  }
  return { ok: true };
}

export function selectProductionApps(paths) {
  const changed = Array.isArray(paths) ? paths : [];
  const shared = changed.some((file) => (
    file === 'ecosystem.config.cjs'
    || file === 'package.json'
    || file === 'package-lock.json'
  ));
  const cloud = shared || changed.some((file) => (
    file.startsWith('src/cloud/')
    || file.startsWith('web/cloud/')
    || file === 'bin/cloud-server.js'
    || file === 'src/frames.js'
  ));
  const gateway = shared || changed.some((file) => (
    file.startsWith('src/gateway')
    || file.startsWith('bin/gateway-')
    || file === 'src/frames.js'
  ));
  return PRODUCTION_APPS.filter((app) => (
    app === 'tailchat-cloud' ? cloud : gateway
  ));
}

function revisionCommit(root, revision, run) {
  if (revision === 'HEAD') return headCommit(root, run);
  const result = run('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '').trim() || null;
}

function changedPaths(root, from, to, run) {
  const result = run('git', ['diff', '--name-only', `${from}..${to}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function productionCheckoutState(root, run = spawnSync) {
  const trackedResult = run('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (trackedResult.error || trackedResult.status !== 0) return null;
  const tracked = String(trackedResult.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
  if (tracked > 0) return { tracked, untracked: [] };

  const untrackedResult = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (untrackedResult.error || untrackedResult.status !== 0) return null;
  return {
    tracked: 0,
    untracked: String(untrackedResult.stdout ?? '').split('\0').filter(Boolean),
  };
}

function targetPaths(root, target, run) {
  const result = run('git', ['ls-tree', '-r', '--name-only', '-z', target], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return new Set(String(result.stdout ?? '').split('\0').filter(Boolean));
}

const restartArgs = (app) => [
  'startOrReload',
  'ecosystem.config.cjs',
  '--only',
  app,
  '--update-env',
];

export function runProductionDeploy({
  root = installRoot(),
  run = spawnSync,
  out = process.stdout,
  readFile = fs.readFileSync,
  externalChecks = PRODUCTION_EXTERNAL_CHECKS,
} = {}) {
  if (!isGitCheckout(root)) return { ok: false, reason: 'not-a-checkout', root };

  const checkout = productionCheckoutState(root, run);
  if (!checkout) return { ok: false, reason: 'dirty-check-failed', root };
  if (checkout.tracked > 0) {
    return { ok: false, reason: 'dirty-checkout', root, dirty: checkout.tracked };
  }

  const external = validateExternalConfiguration({ checks: externalChecks, readFile });
  if (!external.ok) return { ok: false, reason: external.reason, root, external };

  const from = headCommit(root, run);
  if (!from) return { ok: false, reason: 'head-unavailable', root };

  const execute = (command, args) => {
    out.write(`\n$ ${command} ${args.join(' ')}\n`);
    const result = run(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) return result.error.message;
    if (result.status !== 0) return `${command} exited ${result.status}`;
    return null;
  };

  const fetchFailure = execute('git', ['fetch', 'origin', 'main']);
  if (fetchFailure) return { ok: false, reason: fetchFailure, root, command: 'git' };

  const target = revisionCommit(root, 'FETCH_HEAD', run);
  if (!target) return { ok: false, reason: 'target-unavailable', root };
  const paths = changedPaths(root, from, target, run);
  if (!paths) return { ok: false, reason: 'changed-paths-unavailable', root };
  const targetFileSet = targetPaths(root, target, run);
  if (!targetFileSet) return { ok: false, reason: 'target-paths-unavailable', root };
  const collisions = checkout.untracked.filter((file) => targetFileSet.has(file));
  if (collisions.length > 0) {
    return {
      ok: false,
      reason: 'untracked-target-collision',
      root,
      target,
      collisions,
    };
  }
  const apps = selectProductionApps(paths);
  const installStep = ['npm', ['ci', '--omit=dev', '--silent', '--no-audit']];

  const rollBack = (restoreProcesses) => {
    const rollback = rollbackTo(from, { execute, installStep });
    if (!rollback.ok || !restoreProcesses) return rollback;
    const restartFailures = [];
    for (const app of apps) {
      const failure = execute('pm2', restartArgs(app));
      if (failure) restartFailures.push({ app, reason: failure });
    }
    return { ...rollback, restartFailures };
  };

  for (const [command, args] of [
    ['git', ['reset', '--hard', target]],
    installStep,
    ['git', ['archive', '--format=tar.gz', `--output=${INSTALLER_ARCHIVE}`, target]],
  ]) {
    const failure = execute(command, args);
    if (!failure) continue;
    return {
      ok: false,
      reason: failure,
      root,
      from,
      target,
      command,
      apps,
      rollback: rollBack(false),
    };
  }

  for (const app of apps) {
    const failure = execute('pm2', restartArgs(app));
    if (!failure) continue;
    return {
      ok: false,
      reason: failure,
      root,
      from,
      target,
      command: 'pm2',
      app,
      apps,
      rollback: rollBack(true),
    };
  }

  return { ok: true, root, from, target, paths, apps, untracked: checkout.untracked };
}
