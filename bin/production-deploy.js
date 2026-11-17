#!/usr/bin/env node
import { createRequire } from 'node:module';
import { runProductionDeploy } from '../src/production-deploy.js';
import { loadDeployEnv, notifyDeploy } from '../src/deploy-notify.js';

const { version } = createRequire(import.meta.url)('../package.json');

const result = runProductionDeploy();
if (!result.ok) {
  process.stderr.write(`Tailchat production deploy failed: ${result.reason}\n`);
  if (result.external) {
    process.stderr.write(`External check failed: ${result.external.label} (${result.external.path})\n`);
    if (result.external.missing?.length) {
      process.stderr.write(`Missing markers: ${result.external.missing.join(', ')}\n`);
    }
  }
  if (result.rollback) {
    process.stderr.write(result.rollback.ok
      ? `Rolled back to ${result.rollback.commit.slice(0, 12)}.\n`
      : `ROLLBACK FAILED at ${result.rollback.commit || 'unknown commit'}: ${result.rollback.reason}\n`);
    for (const failure of result.rollback.restartFailures || []) {
      process.stderr.write(`Failed to restore ${failure.app}: ${failure.reason}\n`);
    }
  }
  process.exitCode = 1;
} else {
  const apps = result.apps.length > 0 ? result.apps.join(', ') : 'none';
  process.stdout.write(`Tailchat production deploy complete: ${result.target.slice(0, 12)}; restarted: ${apps}.\n`);
}

// The checkout is the only place both a laptop and the server always have, and
// an `ssh … node bin/production-deploy.js` inherits nobody's shell profile.
loadDeployEnv();

// Best effort, always last: the deploy's own exit code is the truth, and a
// Telegram outage must not rewrite it.
const notified = await notifyDeploy({
  ok: result.ok,
  version,
  commit: result.target || result.rollback?.commit || '',
  apps: result.apps || [],
  reason: result.reason,
  rollback: result.rollback ?? null,
});
if (!notified.sent && notified.reason !== 'not configured') {
  process.stderr.write(`Deploy notification not sent: ${notified.reason}\n`);
}
