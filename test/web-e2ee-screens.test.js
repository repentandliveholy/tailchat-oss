// Stage 7, the web's encryption screens: the page runs the terminal's command
// module (`web/cloud/core/e2ee-commands.js`) against the core bridge, with the
// words from one shared table (`web/cloud/core/e2ee-strings.js`). These tests
// pin the seams the browser smoke cannot see one by one: the table is whole in
// every language and is what the terminal prints, the page's overrides name
// real keys, the bridge carries every action the module calls, and the
// conversation menu's "accept new keys" follows the module's own state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { E2EE_STRINGS, prefixedE2eeStrings } from '../web/cloud/core/e2ee-strings.js';
import { createE2eeCommands } from '../web/cloud/core/e2ee-commands.js';
import { createCoreBridge } from '../web/cloud/core/web-session.js';
import { createTranslator } from '../src/i18n.js';

const COMMANDS_SRC = readFileSync(new URL('../web/cloud/core/e2ee-commands.js', import.meta.url), 'utf8');
const APP_SRC = readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

test('every key the commands say exists in all three languages of the shared table', () => {
  const used = new Set([...COMMANDS_SRC.matchAll(/'e2ee\.(\w+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 40, `found ${used.size} keys`);
  const en = Object.keys(E2EE_STRINGS.en).sort();
  for (const lang of ['ru', 'fr']) assert.deepEqual(Object.keys(E2EE_STRINGS[lang]).sort(), en, lang);
  for (const key of used) assert.ok(en.includes(key), `e2ee.${key} missing from the table`);
});

test('the terminal prints the shared table, word for word', () => {
  for (const lang of ['en', 'ru', 'fr']) {
    const t = createTranslator(lang);
    const table = prefixedE2eeStrings(lang);
    assert.equal(table['e2ee.verified'], E2EE_STRINGS[lang].verified);
    assert.equal(
      t('e2ee.verified', { peer: 'bob', device: 'PHONE' }),
      E2EE_STRINGS[lang].verified.replace('{peer}', 'bob').replace('{device}', 'PHONE'),
    );
  }
});

// The page's `e2ee: { … }` group, per language, as written in app.js.
function webGroups() {
  const groups = [...APP_SRC.matchAll(/\n {4}e2ee: \{\n([\s\S]*?)\n {4}\},/g)].map((m) => (
    [...m[1].matchAll(/^ {6}(\w+):/gm)].map((k) => k[1])
  ));
  assert.equal(groups.length, 3, 'one group per language (ru, en, fr)');
  return groups;
}

test('the page overrides the same keys in every language, and each one is real', () => {
  const [ru, en, fr] = webGroups();
  assert.deepEqual([...en].sort(), [...ru].sort());
  assert.deepEqual([...fr].sort(), [...ru].sort());
  const shared = new Set(Object.keys(E2EE_STRINGS.en));
  for (const key of ru) {
    // An override of a shared word, or one of the page's own, used by name.
    assert.ok(shared.has(key) || APP_SRC.includes(`'e2ee.${key}'`), `e2ee.${key} is neither shared nor used`);
  }
  // Nothing the page shows may still name the terminal's surface.
  for (const key of ['signInAgain', 'restoreHint', 'resetHint', 'resetNoAnswer', 'resetNotReady', 'answer']) {
    assert.ok(ru.includes(key), `the page overrides e2ee.${key}`);
  }
});

test('the bridge carries every action the commands call, and refuses once stopped', () => {
  const calls = [];
  const names = [
    'startSas', 'startSasAny', 'confirmSas', 'cancelSas', 'acceptPeerKey', 'createBackup', 'fetchBackup',
    'restoreBackupWithRecoveryKey', 'restoreBackupWithPassphrase', 'resetCrossSigning',
    'safetyCode', 'confirmSafetyCode',
  ];
  const client = { stop() {} };
  for (const name of names) client[name] = (...args) => calls.push([name, ...args]);
  const bridge = createCoreBridge();
  bridge.attach(client);
  assert.equal(bridge.isCore, true);
  for (const name of names) assert.equal(typeof bridge[name], 'function', name);
  // Every action the module reaches for is one the bridge has.
  for (const [, name] of COMMANDS_SRC.matchAll(/session\.(\w+)\(/g)) {
    assert.ok(names.includes(name), `the bridge lacks ${name}`);
  }
  bridge.startSas('bob', 'DEV');
  bridge.startSasAny('bob', ['DEV', 'OLD']);
  bridge.createBackup();
  bridge.restoreBackupWithPassphrase('words', 'salt');
  assert.deepEqual(calls, [
    ['startSas', 'bob', 'DEV'],
    ['startSasAny', 'bob', ['DEV', 'OLD']],
    ['createBackup', null],
    ['restoreBackupWithPassphrase', 'words', 'salt'],
  ]);
  bridge.stop();
  assert.throws(() => bridge.fetchBackup(), /stopped/);
});

test('"accept new keys" is offered exactly while the module would act on /trust', () => {
  const said = [];
  const accepted = [];
  const commands = createE2eeCommands({
    getSession: () => ({ isCore: true, acceptPeerKey: (peer) => accepted.push(peer) }),
    getApi: () => null,
    getPeer: () => 'bob',
    say: (line) => said.push(line),
    t: createTranslator('en'),
  });
  assert.equal(commands.hasChangedKeys('bob'), false);
  commands.events['core-key-changed']({ peer: 'Bob' });
  assert.equal(commands.hasChangedKeys('bob'), true);
  commands.trust();
  assert.deepEqual(accepted, ['bob']);
  assert.equal(commands.hasChangedKeys('bob'), false);
  commands.events['core-key-changed']({ peer: 'bob' });
  commands.events['core-device-verified']({ peer: 'bob', device: 'DEV' });
  assert.equal(commands.hasChangedKeys('bob'), false, 'a verification settles it too');
});

test('the page offers the encryption commands only where the core runs', () => {
  for (const name of ['/verify', '/trust', '/backup', '/keys']) {
    assert.match(APP_SRC, new RegExp(`name: '${name}', alias: '', (args: '[^']*', )?core: true`), name);
  }
  // Palette, /help and the dispatcher all read the filtered list.
  assert.equal([...APP_SRC.matchAll(/\bCOMMANDS\.(filter|find|map)\(/g)].length, 1, 'only availableCommands reads COMMANDS');
  assert.match(APP_SRC, /return COMMANDS\.filter\(\(cmd\) => !cmd\.core \|\| coreE2ee\)/);
});
