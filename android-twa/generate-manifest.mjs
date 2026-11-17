// Builds app/twa-manifest.json from the live web manifest. Run once per
// release (or whenever web/cloud/manifest.webmanifest, the version, or the
// package/signing settings below change), then `npm run scaffold` and
// `npm run build`. See README.md for the full, non-interactive flow.
import { TwaManifest } from '@bubblewrap/core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(HERE, '../package.json'), 'utf8'));

const twaManifest = await TwaManifest.fromWebManifest(
  'https://repentandliveholy.org/tailchat/manifest.webmanifest',
);

twaManifest.packageId = 'org.repentandliveholy.tailchat';
twaManifest.name = 'Tailchat';
twaManifest.launcherName = 'Tailchat';
// Deliberately NOT using Notification Delegation (enableNotifications: true).
// Delegation hands display to this app's own DelegationService, which
// requires *this app* to hold POST_NOTIFICATIONS — a single point of
// failure Chrome's own notification path doesn't have (Chrome already
// holds its own notification permission independent of any TWA host app).
// Left at the default false: Chrome shows the push itself, under its own
// icon. Costs the "shows as Tailchat" branding; buys removing an entire
// failure mode for the one thing this feature exists for.
twaManifest.enableNotifications = false;
// versionCode must strictly increase for Android to accept an install over
// the current one, or it fails with INSTALL_FAILED_VERSION_DOWNGRADE.
// app/twa-manifest.json is regenerated (gitignored) every run, so the
// number can't live there — version-code.txt is the tracked, persistent
// counter instead. Every run consumes one code, whether or not you go on to
// actually ship the build; don't run this speculatively.
const versionCodeFile = path.join(HERE, 'version-code.txt');
let versionCode = 1;
try {
  const prev = parseInt(readFileSync(versionCodeFile, 'utf8').trim(), 10);
  if (Number.isInteger(prev) && prev >= 1) versionCode = prev + 1;
} catch {}
writeFileSync(versionCodeFile, `${versionCode}\n`);
twaManifest.appVersionCode = versionCode;
twaManifest.appVersionName = pkg.version;
twaManifest.signingKey = {
  // Outside the repo on purpose — see README.md "Signing key".
  path: path.join(process.env.HOME, '.tailchat-android/tailchat-release.keystore'),
  alias: 'tailchat',
};

const err = twaManifest.validate();
if (err) {
  console.error('twa-manifest validation failed:', err);
  process.exit(1);
}

mkdirSync(path.join(HERE, 'app'), { recursive: true });
await twaManifest.saveToFile(path.join(HERE, 'app/twa-manifest.json'));
console.log('Wrote app/twa-manifest.json for version', pkg.version);
