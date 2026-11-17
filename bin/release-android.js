#!/usr/bin/env node
// Publishing an Android release by hand is three steps that all have to happen
// and one that silently does not: the APK gets built, copied next to the web
// client, scp'd to the server — and then nobody checks that the URL actually
// hands out the new bytes. It did not, for several releases: the download link
// kept serving the old TWA wrapper while the worklog said otherwise. So the
// verification is the point of this script, not the copying: it re-downloads
// what the world sees and compares hashes, and refuses to call the release done
// if they differ.
//
// Usage: node bin/release-android.js [--no-telegram] [--host ovh]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CHAT_ENV, TOKEN_ENV, loadDeployEnv } from '../src/deploy-notify.js';
import { ANDROID_NOTES_FILE, androidNotes } from '../src/cloud/service-account.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APK = path.join(ROOT, 'android/app/build/outputs/apk/release/app-release.apk');
const LOCAL_COPY = path.join(ROOT, 'web/cloud/tailchat.apk');
const PUBLIC_URL = 'https://repentandliveholy.org/tailchat/tailchat.apk';
// The self-update manifest the Android client polls (`AppUpdateApi.fetchLatest`)
// to learn a newer build exists — same publish discipline as the APK itself:
// written locally, uploaded atomically, then re-read back from the public URL.
const VERSION_JSON_LOCAL = path.join(ROOT, 'web/cloud/android-version.json');
const PUBLIC_VERSION_URL = 'https://repentandliveholy.org/tailchat/android-version.json';

const args = process.argv.slice(2);
const sshHost = args.includes('--host') ? args[args.indexOf('--host') + 1] : 'ovh';
const withTelegram = !args.includes('--no-telegram');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} exited ${result.status}`);
}

function fail(reason) {
  process.stderr.write(`Android release failed: ${reason}\n`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// versionName/versionCode are read out of the gradle file rather than passed in:
// a release announced as one version and built as another is exactly the kind of
// drift this script exists to make impossible.
function version() {
  const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle.kts'), 'utf8');
  const name = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1];
  const code = /versionCode\s*=\s*(\d+)/.exec(gradle)?.[1];
  if (!name || !code) fail('could not read versionName/versionCode from android/app/build.gradle.kts');
  return { name, code };
}

const { name, code } = version();

// What the people who install this build will be told about it
// (`docs/android-notes.md` → `announceAppBuild`, once per build, only to
// whoever is running it). Not fatal — a build nobody is meant to hear about is
// legitimate — but loud: without a section the update silently says nothing.
const notes = androidNotes(Number(code));
process.stdout.write(notes
  ? `Notes for build ${code} are written; whoever installs it will be told.\n`
  : `No section for build ${code} in ${path.relative(ROOT, ANDROID_NOTES_FILE)} — whoever installs it will be told nothing.\n`);

process.stdout.write(`Building Tailchat Android ${name} (${code})…\n`);
run('./gradlew', ['assembleRelease'], { cwd: path.join(ROOT, 'android') });

const built = fs.readFileSync(APK);
const digest = sha256(built);
process.stdout.write(`APK ${built.length} bytes, sha256 ${digest.slice(0, 16)}…\n`);

// The local copy is what `bin/cloud-server.js` serves during a smoke test; the
// remote one is what everybody else gets. Uploaded to a temp name and moved into
// place, so a download that starts mid-transfer never gets half an APK.
fs.writeFileSync(LOCAL_COPY, built);
run('scp', ['-q', APK, `${sshHost}:/opt/tailchat/web/cloud/tailchat.apk.new`]);
run('ssh', [sshHost, 'cd /opt/tailchat/web/cloud && mv tailchat.apk.new tailchat.apk']);

const response = await fetch(PUBLIC_URL, { cache: 'no-store' });
if (!response.ok) fail(`${PUBLIC_URL} answered ${response.status}`);
const served = Buffer.from(await response.arrayBuffer());
if (sha256(served) !== digest) {
  fail(`${PUBLIC_URL} serves ${served.length} bytes with a different hash — the download link is stale`);
}
process.stdout.write(`${PUBLIC_URL} serves this exact build.\n`);

// Published right after the APK it describes, under the same temp-name-then-
// rename discipline: a client polling mid-publish must never see a manifest
// pointing at a versionCode whose bytes have not landed yet. `sha256` is the
// same digest just verified against the served APK above — AppUpdateApi.kt's
// `download()` recomputes it over the downloaded bytes before ever handing
// the file to the installer.
const versionJson = `${JSON.stringify(
  { versionCode: Number(code), versionName: name, url: PUBLIC_URL, sha256: digest },
  null,
  2,
)}\n`;
fs.writeFileSync(VERSION_JSON_LOCAL, versionJson);
run('scp', ['-q', VERSION_JSON_LOCAL, `${sshHost}:/opt/tailchat/web/cloud/android-version.json.new`]);
run('ssh', [sshHost, 'cd /opt/tailchat/web/cloud && mv android-version.json.new android-version.json']);

const versionResponse = await fetch(PUBLIC_VERSION_URL, { cache: 'no-store' });
if (!versionResponse.ok) fail(`${PUBLIC_VERSION_URL} answered ${versionResponse.status}`);
const versionServed = await versionResponse.text();
if (versionServed !== versionJson) {
  fail(`${PUBLIC_VERSION_URL} does not match what was just published — the update manifest is stale`);
}
process.stdout.write(`${PUBLIC_VERSION_URL} serves this exact version.\n`);

if (!withTelegram) process.exit(0);

loadDeployEnv();
const token = process.env[TOKEN_ENV];
const chat = process.env[CHAT_ENV];
if (!token || !chat) {
  process.stdout.write('Telegram not configured (see .env.example); the APK is published all the same.\n');
  process.exit(0);
}

const form = new FormData();
form.append('chat_id', chat);
form.append('caption', `Tailchat Android ${name} (versionCode ${code})\n${PUBLIC_URL}`);
form.append('document', new File([built], `tailchat-${name}.apk`, {
  type: 'application/vnd.android.package-archive',
}));
const sent = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form })
  .then((res) => res.json())
  .catch((error) => ({ ok: false, description: error.message }));
// A Telegram outage does not un-publish an APK that is already being served.
process.stdout.write(sent.ok
  ? `Sent to Telegram (message ${sent.result?.message_id}).\n`
  : `APK published, but Telegram refused it: ${sent.description || 'unknown'}\n`);
