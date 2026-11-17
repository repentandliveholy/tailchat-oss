import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runProductionDeploy,
  selectProductionApps,
  validateExternalConfiguration,
  INSTALLER_ARCHIVE,
} from '../src/production-deploy.js';

function checkout(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-production-deploy-'));
  fs.mkdirSync(path.join(root, '.git'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeRunner({
  dirty = '',
  paths = 'web/cloud/app.js\n',
  untracked = '',
  targetPaths = 'web/cloud/app.js\0',
  failInstallOnce = false,
} = {}) {
  const calls = [];
  let installCalls = 0;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: dirty };
    if (command === 'git' && args[0] === 'ls-files') return { status: 0, stdout: untracked };
    if (command === 'git' && args[0] === 'ls-tree') return { status: 0, stdout: targetPaths };
    if (command === 'git' && args[0] === 'rev-parse') {
      return { status: 0, stdout: args[1] === 'HEAD' ? 'old-commit\n' : 'new-commit\n' };
    }
    if (command === 'git' && args[0] === 'diff') return { status: 0, stdout: paths };
    if (command === 'npm') {
      installCalls += 1;
      if (failInstallOnce && installCalls === 1) return { status: 1 };
    }
    return { status: 0, stdout: '' };
  };
  return { run, calls };
}

const externalChecks = [{
  label: 'external',
  path: '/external.conf',
  markers: [['required route', 'expected-marker']],
}];
const readExternal = () => 'expected-marker';
const silent = { write() {} };

test('external production checks fail closed without exposing file contents', () => {
  const result = validateExternalConfiguration({
    checks: externalChecks,
    readFile: () => 'secret-value-without-marker',
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'external-config-drift',
    label: 'external',
    path: '/external.conf',
    missing: ['required route'],
  });
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('changed paths select only repository PM2 applications they can affect', () => {
  assert.deepEqual(selectProductionApps(['web/cloud/app.js']), ['tailchat-cloud']);
  assert.deepEqual(selectProductionApps(['src/gateway-server.js']), ['tailchat-gateway']);
  assert.deepEqual(selectProductionApps(['package-lock.json']), ['tailchat-cloud', 'tailchat-gateway']);
  assert.deepEqual(selectProductionApps(['src/cli.js', 'docs/worklog.md']), []);
  assert.equal(selectProductionApps(['package.json']).includes('tailik'), false);
});

test('a dirty production checkout stops before fetch, reset, install, or restart', (context) => {
  const root = checkout(context);
  const fake = fakeRunner({ dirty: ' M src/cloud/hub.js\n' });
  const result = runProductionDeploy({
    root,
    run: fake.run,
    out: silent,
    readFile: readExternal,
    externalChecks,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dirty-checkout');
  assert.equal(result.dirty, 1);
  assert.deepEqual(fake.calls, [['git', 'status', '--porcelain', '--untracked-files=no']]);
});

test('a production deploy restarts only the exact affected PM2 application', (context) => {
  const root = checkout(context);
  const fake = fakeRunner({ paths: 'web/cloud/app.js\ndocs/worklog.md\n' });
  const result = runProductionDeploy({
    root,
    run: fake.run,
    out: silent,
    readFile: readExternal,
    externalChecks,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.apps, ['tailchat-cloud']);
  assert.deepEqual(fake.calls.filter(([command]) => command === 'pm2'), [[
    'pm2', 'startOrReload', 'ecosystem.config.cjs', '--only', 'tailchat-cloud', '--update-env',
  ]]);
  assert.equal(fake.calls.flat().includes('all'), false);
  assert.equal(fake.calls.flat().includes('tailik'), false);
});

test('a production deploy rebuilds the installer archive from the deployed commit', (context) => {
  const root = checkout(context);
  const fake = fakeRunner();
  const result = runProductionDeploy({
    root,
    run: fake.run,
    out: silent,
    readFile: readExternal,
    externalChecks,
  });

  assert.equal(result.ok, true);
  // The installer handed out a hand-built snapshot that nobody regenerated, so
  // `curl … | bash` kept shipping 0.63c. The archive must be rebuilt from the
  // commit being deployed, and before anything is restarted.
  const archiveAt = fake.calls.findIndex(([command, sub]) => command === 'git' && sub === 'archive');
  const firstRestart = fake.calls.findIndex(([command]) => command === 'pm2');
  assert.notEqual(archiveAt, -1, 'the deploy must rebuild the installer archive');
  assert.deepEqual(fake.calls[archiveAt], [
    'git', 'archive', '--format=tar.gz', `--output=${INSTALLER_ARCHIVE}`, result.target,
  ]);
  assert.ok(archiveAt < firstRestart, 'the archive must exist before the services come back');
});

test('untracked production files survive when the target does not claim their paths', (context) => {
  const root = checkout(context);
  const fake = fakeRunner({
    untracked: 'host.key\0web/cloud/server.js\0',
    targetPaths: 'src/cloud/server.js\0web/cloud/app.js\0',
  });
  const result = runProductionDeploy({
    root,
    run: fake.run,
    out: silent,
    readFile: readExternal,
    externalChecks,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.untracked, ['host.key', 'web/cloud/server.js']);
});

test('an untracked path claimed by the target stops before reset or install', (context) => {
  const root = checkout(context);
  const fake = fakeRunner({
    untracked: 'host.key\0web/cloud/server.js\0',
    targetPaths: 'web/cloud/server.js\0web/cloud/app.js\0',
  });
  const result = runProductionDeploy({
    root,
    run: fake.run,
    out: silent,
    readFile: readExternal,
    externalChecks,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'untracked-target-collision');
  assert.deepEqual(result.collisions, ['web/cloud/server.js']);
  assert.deepEqual(fake.calls.filter(([command]) => ['npm', 'pm2'].includes(command)), []);
  assert.equal(fake.calls.some((call) => call[0] === 'git' && call[1] === 'reset'), false);
});

test('an install failure restores the previous commit and its dependencies before PM2 changes', (context) => {
  const root = checkout(context);
  const fake = fakeRunner({ paths: 'package-lock.json\n', failInstallOnce: true });
  const result = runProductionDeploy({
    root,
    run: fake.run,
    out: silent,
    readFile: readExternal,
    externalChecks,
  });

  assert.equal(result.ok, false);
  assert.equal(result.command, 'npm');
  assert.deepEqual(result.rollback, { ok: true, commit: 'old-commit' });
  assert.deepEqual(fake.calls.filter(([command]) => command === 'npm'), [
    ['npm', 'ci', '--omit=dev', '--silent', '--no-audit'],
    ['npm', 'ci', '--omit=dev', '--silent', '--no-audit'],
  ]);
  assert.ok(fake.calls.some((call) => (
    call[0] === 'git' && call[1] === 'reset' && call[3] === 'old-commit'
  )));
  assert.deepEqual(fake.calls.filter(([command]) => command === 'pm2'), []);
});
