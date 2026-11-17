// Generates (or regenerates) the Android project under app/ from
// app/twa-manifest.json, and writes the manifest checksum file bubblewrap
// build expects so it doesn't ask interactively whether to re-scaffold.
// Safe to re-run: it overwrites the generated project, never the manifest.
import { TwaGenerator, TwaManifest, ConsoleLog } from '@bubblewrap/core';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifestFile = path.join(HERE, 'app/twa-manifest.json');

const twaManifest = await TwaManifest.fromFile(manifestFile);
const generator = new TwaGenerator();
await generator.createTwaProject(path.join(HERE, 'app'), twaManifest, new ConsoleLog('scaffold'));

// Bubblewrap's own template never requests any runtime permission at launch (see
// LauncherActivity.patch.java for why that matters) — overwrite its generated stub with the
// patched version on every scaffold.
const packagePath = twaManifest.packageId.replace(/\./g, '/');
const launcherActivityFile = path.join(
  HERE, 'app/app/src/main/java', packagePath, 'LauncherActivity.java',
);
const patchTemplate = readFileSync(path.join(HERE, 'LauncherActivity.patch.java'), 'utf8');
writeFileSync(launcherActivityFile, patchTemplate.replace('{{PACKAGE}}', twaManifest.packageId));
console.log('Patched LauncherActivity.java for proactive permission requests');

// Nothing in the generated project declares RECORD_AUDIO, which web/cloud/'s voice messages
// need (getUserMedia audio) — TWA content runs in Chrome's process, but Chrome can only grant
// hardware access this host app itself already holds. Anchored on <application>, which is
// always present, unlike POST_NOTIFICATIONS (only generated when enableNotifications is true,
// which this project deliberately leaves off — see generate-manifest.mjs).
const manifestFile2 = path.join(HERE, 'app/app/src/main/AndroidManifest.xml');
const manifestXml = readFileSync(manifestFile2, 'utf8');
const recordAudioPermission = '<uses-permission android:name="android.permission.RECORD_AUDIO"/>';
if (!manifestXml.includes(recordAudioPermission)) {
  const applicationTag = '<application';
  if (!manifestXml.includes(applicationTag)) {
    throw new Error('Expected <application> tag not found in generated AndroidManifest.xml');
  }
  writeFileSync(
    manifestFile2,
    manifestXml.replace(applicationTag, `${recordAudioPermission}\n\n    ${applicationTag}`),
  );
  console.log('Patched AndroidManifest.xml with RECORD_AUDIO permission');
}

const checksum = createHash('sha1').update(readFileSync(manifestFile)).digest('hex');
writeFileSync(path.join(HERE, 'app/manifest-checksum.txt'), checksum);
console.log('Scaffolded app/ and wrote manifest-checksum.txt');
