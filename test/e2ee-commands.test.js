import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SAS_EMOJIS, sasCodeText, createE2eeCommands, restoreFailureKey, RECOVERY_KEY_PREFIX, RESTORE_TIMEOUT_MS,
  RESET_FAILURES, SAS_ANSWER_TIMEOUT_MS, browserDeviceName, terminalDeviceName, safetyCodeText,
} from '../src/e2ee-commands.js';
import { createTranslator } from '../src/i18n.js';

const SAS_RS = new URL('../crates/tailchat-crypto/src/sas.rs', import.meta.url);

test('the emoji table is exactly the one in crates/tailchat-crypto/src/sas.rs', () => {
  const source = readFileSync(SAS_RS, 'utf8');
  const block = source.slice(source.indexOf('pub const SAS_EMOJIS'));
  const rust = [...block.slice(0, block.indexOf('];')).matchAll(/\("([^"]+)", "([^"]+)"\)/g)]
    .map((match) => [match[1], match[2]]);
  assert.equal(rust.length, 64);
  // Index by index: the core sends indices, so order is the whole contract.
  assert.deepEqual(SAS_EMOJIS.map((pair) => [...pair]), rust);
});

test('sasCodeText turns the core\'s indices and decimals into what two people read aloud', () => {
  const { emojis, numbers } = sasCodeText({ emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1234, 5678, 9012] });
  assert.equal(emojis, '🐶 dog   🐱 cat   🦁 lion   🐎 horse   🦄 unicorn   🐷 pig   🐘 elephant');
  assert.equal(numbers, '1234  5678  9012');
  // sas.rs shows a lock for an index outside the table; so does this.
  assert.match(sasCodeText({ emojiIndices: [200] }).emojis, /🔒 lock/);
});

function harness({
  users = {}, peer = 'bob', self = 'alice', isCore = true, queryError = null, promptSecret, timers, fanout = false,
  safety = true,
} = {}) {
  const said = [];
  const about = [];
  const calls = [];
  const session = {
    isCore,
    startSas: (...args) => calls.push(['startSas', ...args]),
    confirmSas: (...args) => calls.push(['confirmSas', ...args]),
    cancelSas: (...args) => calls.push(['cancelSas', ...args]),
    acceptPeerKey: (...args) => calls.push(['acceptPeerKey', ...args]),
    createBackup: (...args) => calls.push(['createBackup', ...args]),
    fetchBackup: (...args) => calls.push(['fetchBackup', ...args]),
    restoreBackupWithRecoveryKey: (...args) => calls.push(['restoreKey', ...args]),
    restoreBackupWithPassphrase: (...args) => calls.push(['restorePassphrase', ...args]),
    resetCrossSigning: (...args) => calls.push(['reset', ...args]),
    // The core's `StartSasAny`; a native module built before it has none, and
    // the tests above keep covering that path.
    ...(fanout ? { startSasAny: (...args) => calls.push(['startSasAny', ...args]) } : {}),
    ...(safety ? {
      safetyCode: (...args) => calls.push(['safetyCode', ...args]),
      confirmSafetyCode: (...args) => calls.push(['confirmSafetyCode', ...args]),
    } : {}),
  };
  const api = {
    e2eeKeysQuery: async (logins) => {
      calls.push(['query', logins]);
      if (queryError) throw queryError;
      return users;
    },
  };
  const commands = createE2eeCommands({
    getSession: () => session,
    getApi: () => api,
    getPeer: () => peer,
    getSelf: () => self,
    say: (line, subject = null) => {
      said.push(line);
      about.push(subject?.peer ?? null);
    },
    t: createTranslator('en'),
    ...(promptSecret === undefined ? {} : { promptSecret }),
    ...(timers ? { setTimer: timers.setTimer, clearTimer: timers.clearTimer } : {}),
  });
  return { commands, said, about, calls, session };
}

test('/verify on a contact shows the safety code; on your own account it asks your newest other device', async () => {
  const { commands, said, calls } = harness({
    users: {
      alice: {
        devices: {
          OLD: { name: 'laptop', createdAt: 100 },
          NEW: { name: 'phone', createdAt: 900 },
          MINE: { name: 'this', createdAt: 5000 },
        },
      },
    },
  });
  await commands.verify('');
  assert.deepEqual(calls, [['safetyCode', 'bob']], 'the open conversation: its code, no handshake, no query');

  calls.length = 0;
  commands.events['core-device-registered']({ deviceId: 'MINE' });
  await commands.verify('alice');
  assert.deepEqual(calls, [['query', ['alice']], ['startSas', 'alice', 'NEW']]);
  assert.match(said.join('\n'), /phone/);

  said.length = 0;
  commands.events['core-sas-code-ready']({
    transactionId: 'tx1', peer: 'alice', device: 'NEW', emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1111, 2222, 3333],
  });
  const shown = said.join('\n');
  assert.match(shown, /compare these with alice by voice — on a call or in person, not in this chat/);
  assert.match(shown, /🐶 dog/);
  assert.match(shown, /1111 {2}2222 {2}3333/);
  assert.match(shown, /\/verify yes/);
});

test('/verify yes confirms the waiting verification, /verify no cancels it, and either is spent after one use', async () => {
  const { commands, calls, said } = harness();
  const ready = { transactionId: 'tx7', peer: 'bob', device: 'D', emojiIndices: [0, 0, 0, 0, 0, 0, 0], decimals: [1, 2, 3] };

  commands.events['core-sas-code-ready'](ready);
  await commands.verify('yes');
  assert.deepEqual(calls, [['confirmSas', 'tx7']]);
  await commands.verify('yes'); // already answered: this is now a login, not an answer
  assert.equal(calls.filter((call) => call[0] === 'confirmSas').length, 1);

  calls.length = 0;
  commands.events['core-sas-code-ready']({ ...ready, transactionId: 'tx8' });
  await commands.verify('NO');
  assert.deepEqual(calls, [['cancelSas', 'tx8']]);
  assert.match(said.join('\n'), /cancelled/);
});

test('a handshake the other side ends stops the wait, and a mismatch says not to trust the device', async () => {
  const { commands, calls, said } = harness();
  const ready = { transactionId: 'tx1', peer: 'bob', device: 'D', emojiIndices: [0, 0, 0, 0, 0, 0, 0], decimals: [1, 2, 3] };

  // bob says no while alice is still looking at the emojis.
  commands.events['core-sas-code-ready'](ready);
  commands.events['core-sas-cancelled']({ transactionId: 'tx1', peer: 'bob', device: 'D', reason: 'user_cancelled' });
  assert.equal(said.at(-1), 'verification with bob was cancelled on their device (D)');
  await commands.verify('yes'); // nothing waits any more: a login, not an answer
  assert.equal(calls.some((call) => call[0] === 'confirmSas'), false);

  // alice said yes, then the MAC did not check out: a warning, not a shrug.
  commands.events['core-sas-code-ready']({ ...ready, transactionId: 'tx2' });
  await commands.verify('yes');
  commands.events['core-sas-cancelled']({ transactionId: 'tx2', peer: 'bob', device: 'D', reason: 'mac_mismatch' });
  assert.match(said.at(-1), /^⚠ verification with bob failed: .*Do not trust that device/);

  // A cancel for another handshake leaves the one on screen waiting.
  commands.events['core-sas-code-ready']({ ...ready, transactionId: 'tx3' });
  commands.events['core-sas-cancelled']({ transactionId: 'old', peer: 'bob', device: 'D', reason: 'user_cancelled' });
  calls.length = 0;
  await commands.verify('yes');
  assert.deepEqual(calls, [['confirmSas', 'tx3']]);

  commands.events['core-sas-cancelled']({ transactionId: 'tx4', peer: 'bob', device: 'D', reason: 'unknown_identity' });
  assert.match(said.at(-1), /bob has no account keys published yet/);
});

test('keys the server already holds under this device id end in "sign in again", with the way back', () => {
  const { commands, said, calls } = harness({ self: 'alice' });
  commands.events['core-device-keys-conflict']({});
  assert.match(said.at(-1), /^⚠ this device's encryption keys are not the ones the server has for it/);
  assert.match(said.at(-1), /tailchat --cloud-logout/);
  assert.match(said.at(-1), /\/verify alice$/);
  assert.deepEqual(calls, [], 'nothing is retried behind the person\'s back');
});

test('"yes" and "no" with nothing waiting say so and ask the core for nothing', async () => {
  // Three letters is a valid login, but a late answer is far likelier than a
  // contact called "yes" — and that contact's code is one /safety away.
  const { commands, calls, said } = harness({ users: { yes: { devices: { D: { name: 'x', createdAt: 1 } } } } });
  await commands.verify('yes');
  await commands.verify('no');
  assert.deepEqual(calls, []);
  assert.match(said.at(-1), /no verification is waiting for an answer/);
});

test('answering with nothing waiting says so and sends nothing to the core', async () => {
  const { commands, calls, said } = harness();
  commands.events['core-sas-code-ready']({ transactionId: 'a', peer: 'bob', emojiIndices: [], decimals: [] });
  commands.events['core-device-verified']({ peer: 'bob', device: 'D' }); // verified: nothing waits any more
  await commands.verify('yes'); // now a login, not an answer
  assert.equal(calls.some((call) => call[0] === 'confirmSas'), false);
  assert.match(said.join('\n'), /✓ emojis matched with bob \(D\): nobody is tampering/);
  // Nobody is called "yes" here, so the line is about the late answer — not
  // "yes has no encryption devices", which is what the live run first printed.
  assert.match(said.at(-1), /no verification is waiting for an answer/);
  assert.equal(said.join('\n').includes('yes has no'), false);
});

test('no line the commands print leaves a {placeholder} unfilled', async () => {
  const { commands, said } = harness({ users: { bob: { devices: { D: { name: 'p', createdAt: 1 } } } } });
  const ready = { transactionId: 't', peer: 'bob', device: 'D', emojiIndices: [1, 2, 3, 4, 5, 6, 7], decimals: [1, 2, 3] };
  await commands.verify('');
  commands.events['core-sas-code-ready'](ready);
  await commands.verify('yes'); // live run: "waiting for {peer} to confirm"
  commands.events['core-device-verified']({ peer: 'bob', device: 'D' });
  commands.events['core-sas-code-ready']({ ...ready, transactionId: 'u' });
  await commands.verify('no');
  commands.events['core-key-changed']({ peer: 'bob' });
  commands.trust();
  commands.trust();
  commands.events['core-device-registered']({ deviceId: 'MINE' });
  commands.events['core-unverified-device']({ peer: 'bob', device: 'X' });
  commands.events['core-unverified-device']({ peer: 'alice', device: 'MINE' });
  commands.events['core-unverified-device']({ peer: 'alice', device: 'OTHER' });
  commands.backup('');
  commands.events['core-backup-created']({ version: 1, recoveryKey: 'k' });
  commands.events['core-backup-info']({ version: 1, sessionCount: 2 });
  commands.events['core-backup-info']({ version: 0 });
  commands.events['core-device-keys-conflict']({});
  for (const reason of ['user_cancelled', 'mac_mismatch', 'unknown_identity', 'unknown']) {
    commands.events['core-sas-cancelled']({ transactionId: 'z', peer: 'bob', device: 'D', reason });
  }
  assert.match(said.join('\n'), /waiting for bob's answer/);
  for (const line of said) assert.doesNotMatch(line, /\{\w+\}/, line);
});

test('/trust acts only after the core reported a key change: otherwise it would undo a verification', () => {
  // The core's AcceptPeerKey stores the identity as unverified. The live run
  // showed /trust "trusting bob's new keys" with nothing changed.
  const { commands, calls, said } = harness();
  commands.trust();
  assert.deepEqual(calls, []);
  assert.match(said.at(-1), /bob's keys have not changed/);

  commands.events['core-key-changed']({ peer: 'bob' });
  commands.trust();
  commands.trust(); // spent: the change was accepted
  assert.deepEqual(calls, [['acceptPeerKey', 'bob']]);

  // A completed verification settles a change too, as the core itself does.
  calls.length = 0;
  commands.events['core-key-changed']({ peer: 'bob' });
  commands.events['core-device-verified']({ peer: 'bob', device: 'D' });
  commands.trust();
  assert.deepEqual(calls, []);
});

test('your own account from an unsigned device with no signed one left: the way back is the backup', async () => {
  const { commands, calls, said } = harness({ users: { alice: { devices: { FRESH: { name: 'new', createdAt: 900 } } } } });
  commands.events['core-unverified-device']({ peer: 'alice', device: 'FRESH' });
  await commands.verify('alice');
  assert.equal(calls.some((call) => call[0] === 'startSas'), false);
  assert.match(said.at(-1), /none of your other devices is signed.*\/backup restore.*\/keys reset/);
});

test('a SAS the other side started from an unsigned device ends in ✓ plus the truth about messages', () => {
  const { commands, said } = harness({ self: 'alice' });
  commands.events['core-unverified-device']({ peer: 'bob', device: 'FRESH' });
  commands.events['core-device-verified']({ peer: 'bob', device: 'FRESH' });
  assert.match(said.at(-2), /✓ emojis matched with bob \(FRESH\)/);
  assert.match(said.at(-1), /FRESH is not signed by bob's account keys.*still will not open/);

  said.length = 0;
  commands.events['core-device-verified']({ peer: 'bob', device: 'SIGNED' });
  assert.equal(said.length, 1, 'a signed device needs no footnote');
  commands.events['core-unverified-device']({ peer: 'alice', device: 'NEWPHONE' });
  said.length = 0;
  commands.events['core-device-verified']({ peer: 'alice', device: 'NEWPHONE' });
  assert.equal(said.length, 1, 'your own device gets signed by exactly this verification');
});

test('/verify on your own account still picks your newest unsigned device: that is how it gets signed', async () => {
  const { commands, calls } = harness({
    self: 'alice',
    users: { alice: { devices: { MINE: { createdAt: 1 }, OLDER: { createdAt: 50 }, NEWPHONE: { createdAt: 99 } } } },
  });
  commands.events['core-device-registered']({ deviceId: 'MINE' });
  commands.events['core-unverified-device']({ peer: 'alice', device: 'NEWPHONE' });
  await commands.verify('alice');
  assert.deepEqual(calls.at(-1), ['startSas', 'alice', 'NEWPHONE']);
});

test('an unsigned device of your own gets advice you can follow, not "/verify" against yourself', () => {
  const { commands, said } = harness({ self: 'alice' });
  commands.events['core-device-registered']({ deviceId: 'MINE' });
  commands.events['core-unverified-device']({ peer: 'alice', device: 'MINE' });
  assert.match(said.at(-1), /this device \(MINE\) is not signed by your account keys/);
  assert.match(said.at(-1), /another of your devices runs \/verify alice/);
  commands.events['core-unverified-device']({ peer: 'alice', device: 'TABLET' });
  assert.match(said.at(-1), /your device TABLET is not signed.*\/verify alice/);
  assert.equal(said.join('\n').includes('alice has a device'), false);
});

test('/verify on yourself reports no other device and a failing query; with no conversation it asks for one', async () => {
  const none = harness({ users: { alice: { devices: {} } } });
  await none.commands.verify('alice');
  assert.match(none.said.join('\n'), /no encryption devices/);
  assert.equal(none.calls.some((call) => call[0] === 'startSas'), false);

  const down = harness({ queryError: new Error('unreachable') });
  await down.commands.verify('alice');
  assert.match(down.said.join('\n'), /unreachable/);

  const nobody = harness({ peer: null });
  await nobody.commands.verify('');
  assert.match(nobody.said.join('\n'), /open a conversation first/);
  assert.deepEqual(nobody.calls, []);
});

test('/verify can name a contact other than the open conversation: their code, not a handshake', async () => {
  const { commands, calls } = harness({ peer: 'bob' });
  await commands.verify('Carol');
  assert.deepEqual(calls, [['safetyCode', 'carol']]);
});

test('/verify yes marks the code on screen verified, /verify no marks nothing and says what it may mean', async () => {
  const { commands, calls, said } = harness();
  await commands.verify('bob');
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'BOBKEY', verified: false,
  });
  assert.match(said.at(-1), /\/verify yes — they match.*\/verify no — they differ/);
  await commands.verify('yes');
  assert.deepEqual(calls.at(-1), ['confirmSafetyCode', 'bob', 'BOBKEY']);
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'BOBKEY', verified: true,
  });
  assert.match(said.at(-1), /✓ the safety code with bob matched/);

  calls.length = 0;
  await commands.verify('carol');
  commands.events['core-safety-code']({
    peer: 'carol', status: 'ready', halves: SAFETY_HALVES, masterKey: 'CAROLKEY', verified: false,
  });
  await commands.verify('no');
  assert.deepEqual(calls, [['safetyCode', 'carol']], 'nothing confirmed');
  assert.match(said.at(-1), /^⚠ nothing was marked.*tampering with your conversation with carol/);
  await commands.verify('yes');
  assert.match(said.at(-1), /no verification is waiting/, 'the code was answered once');
});

test('the commands do nothing outside the native core', async () => {
  const { commands, calls, said } = harness({ isCore: false });
  await commands.verify('');
  commands.trust();
  commands.backup('create');
  assert.deepEqual(calls, []);
  assert.deepEqual(said, []);
});

test('/trust accepts the open peer\'s new keys; a changed key warns and names both ways out', () => {
  const { commands, calls, said } = harness();
  commands.events['core-key-changed']({ peer: 'bob' });
  assert.match(said.join('\n'), /bob's encryption keys changed/);
  assert.match(said.join('\n'), /\/verify/);
  assert.match(said.join('\n'), /\/trust/);
  commands.trust();
  assert.deepEqual(calls, [['acceptPeerKey', 'bob']]);
});

test('an unsigned device is mentioned once per device, not on every frame', () => {
  const { commands, said } = harness();
  commands.events['core-unverified-device']({ peer: 'bob', device: 'D1' });
  commands.events['core-unverified-device']({ peer: 'bob', device: 'D1' });
  assert.equal(said.length, 1);
  commands.events['core-unverified-device']({ peer: 'bob', device: 'D2' });
  assert.equal(said.length, 2);
});

test('/backup create passes no passphrase, status asks the server, anything else prints the usage', () => {
  const { commands, calls, said } = harness();
  commands.backup('create');
  commands.backup('status');
  commands.backup('restore abc'); // restore is deliberately not here: no masked prompt for the key yet
  commands.backup('');
  assert.deepEqual(calls, [['createBackup', null], ['fetchBackup']]);
  assert.equal(said.filter((line) => /usage: \/backup create/.test(line)).length, 2);
});

test('the recovery key is shown once, on its own indented line, and the status never prints a key', () => {
  const { commands, said } = harness();
  commands.events['core-backup-created']({ version: 3, recoveryKey: 'tailchat-backup:v1:3:AAAA' });
  assert.match(said[0], /version 3/);
  assert.equal(said[1], '  tailchat-backup:v1:3:AAAA');

  said.length = 0;
  commands.events['core-backup-info']({ version: 3, sessionCount: 12 });
  commands.events['core-backup-info']({ version: 0, sessionCount: 0 });
  assert.match(said[0], /version 3: 12 session/);
  assert.match(said[1], /no key backup yet/);
  assert.equal(said.join('\n').includes('tailchat-backup'), false);
});

// ---- /backup restore -------------------------------------------------------

const RECOVERY_KEY = 'tailchat-backup:v1:2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A prompt that answers with `answer` and remembers what it was asked.
function scriptedPrompt(answer) {
  const asked = [];
  const prompt = async (options) => {
    asked.push(options);
    return answer;
  };
  return { prompt, asked };
}

function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
    pending,
  };
}

test('the prefix /backup restore recognises is the one backup.rs writes', () => {
  const source = readFileSync(new URL('../crates/tailchat-crypto/src/backup.rs', import.meta.url), 'utf8');
  const prefix = source.match(/const RECOVERY_PREFIX: &str = "([^"]+)";/)[1];
  assert.ok(prefix.startsWith(RECOVERY_KEY_PREFIX), `${prefix} must start with ${RECOVERY_KEY_PREFIX}`);
});

test('/backup restore asks for the metadata first, then the key in the masked prompt, and hands it to the core', async () => {
  const { prompt, asked } = scriptedPrompt(`  ${RECOVERY_KEY}\n`);
  const timers = manualTimers();
  const { commands, said, calls } = harness({ promptSecret: prompt, timers });

  commands.backup('restore');
  // Nothing is asked before the backup is known to exist.
  assert.deepEqual(calls, [['fetchBackup']]);
  assert.equal(asked.length, 0);

  commands.events['core-backup-info']({ version: 2, sessionCount: 9, passphraseSalt: null });
  await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0].subtitle, /version 2/);
  // No passphrase slot: the prompt asks for the key only.
  assert.match(asked[0].prompt, /recovery key \(tailchat-backup/);
  // Trimmed — a pasted key often carries a newline — and never echoed.
  assert.deepEqual(calls.at(-1), ['restoreKey', RECOVERY_KEY]);
  assert.ok(!said.join('\n').includes('AAAA'), 'the key must never be said');
  assert.match(said.at(-1), /restoring/);
  // The status line of /backup status is not shown for a restore's own fetch.
  assert.ok(!said.some((line) => /session\(s\) saved/.test(line)));
  assert.equal(timers.pending.size, 1);

  commands.events['core-backup-restored']({ version: 2, sessions: 9 });
  assert.match(said.at(-1), /restored \(version 2\): 9 session/);
  assert.equal(timers.pending.size, 0, 'the no-answer timer is cleared');
});

test('/backup restore takes a passphrase only when the backup has a passphrase slot', async () => {
  const withSlot = harness({ promptSecret: scriptedPrompt('correct horse battery staple').prompt });
  withSlot.commands.backup('restore');
  withSlot.commands.events['core-backup-info']({ version: 1, sessionCount: 1, passphraseSalt: 'c2FsdA' });
  await settle();
  assert.deepEqual(withSlot.calls.at(-1), ['restorePassphrase', 'correct horse battery staple', 'c2FsdA']);

  const withoutSlot = harness({ promptSecret: scriptedPrompt('correct horse battery staple').prompt });
  withoutSlot.commands.backup('restore');
  withoutSlot.commands.events['core-backup-info']({ version: 1, sessionCount: 1, passphraseSalt: null });
  await settle();
  assert.deepEqual(withoutSlot.calls, [['fetchBackup']], 'nothing goes to the core');
  assert.match(withoutSlot.said.at(-1), /not a recovery key/);
});

test('/backup restore with no backup on the server, or cancelled, sends nothing', async () => {
  const none = harness({ promptSecret: scriptedPrompt(RECOVERY_KEY).prompt });
  none.commands.backup('restore');
  none.commands.events['core-backup-info']({ version: 0, sessionCount: 0 });
  await settle();
  assert.deepEqual(none.calls, [['fetchBackup']]);
  assert.match(none.said.at(-1), /no key backup yet/);

  const cancelled = harness({ promptSecret: scriptedPrompt(null).prompt });
  cancelled.commands.backup('restore');
  cancelled.commands.events['core-backup-info']({ version: 3, sessionCount: 0 });
  await settle();
  assert.deepEqual(cancelled.calls, [['fetchBackup']]);
  assert.match(cancelled.said.at(-1), /cancelled/);
  // And the command is free again.
  cancelled.commands.backup('restore');
  assert.deepEqual(cancelled.calls.at(-1), ['fetchBackup']);
});

test('/backup restore without a masked prompt (headless) refuses instead of reading the command line', () => {
  const { commands, said, calls } = harness({ promptSecret: null });
  commands.backup('restore');
  assert.deepEqual(calls, []);
  assert.match(said.at(-1), /masked prompt/);
});

test('a refused restore is said in words, and only while a restore waits', async () => {
  const { commands, said } = harness({ promptSecret: scriptedPrompt(RECOVERY_KEY).prompt });
  // Unrelated bad frames, and backup ones with no restore waiting, say nothing.
  commands.events['core-bad-frame']({ reason: 'backup: cannot decrypt crossSigning' });
  assert.equal(said.length, 0);

  commands.backup('restore');
  commands.events['core-backup-info']({ version: 2, sessionCount: 1 });
  await settle();
  commands.events['core-bad-frame']({ reason: 'frame: unexpected field' });
  assert.match(said.at(-1), /restoring/, 'a frame that is not about the backup is not the answer');
  commands.events['core-bad-frame']({ reason: 'backup: cannot decrypt crossSigning' });
  assert.match(said.at(-1), /does not open the backup/);
  // Settled: a second one is not about this restore any more.
  const before = said.length;
  commands.events['core-bad-frame']({ reason: 'backup: version mismatch' });
  assert.equal(said.length, before);
});

test('a restore the core never answers ends in words, not silence', async () => {
  const timers = manualTimers();
  const { commands, said } = harness({ promptSecret: scriptedPrompt(RECOVERY_KEY).prompt, timers });
  commands.backup('restore');
  commands.events['core-backup-info']({ version: 2, sessionCount: 1 });
  await settle();
  assert.equal([...timers.pending.values()][0].ms, RESTORE_TIMEOUT_MS);
  timers.fire();
  assert.match(said.at(-1), /no answer/);
  commands.backup('restore');
  assert.doesNotMatch(said.at(-1), /already in progress/);
});

test('a second /backup restore while one waits is refused', () => {
  const { commands, said, calls } = harness({ promptSecret: scriptedPrompt(RECOVERY_KEY).prompt });
  commands.backup('restore');
  commands.backup('restore');
  assert.deepEqual(calls, [['fetchBackup']]);
  assert.match(said.at(-1), /already in progress/);
});

test('restoreFailureKey maps every refusal try_complete_restore can give', () => {
  const source = readFileSync(new URL('../crates/tailchat-core/src/engine/keys.rs', import.meta.url), 'utf8');
  const start = source.indexOf('pub(super) fn restore_backup_with_recovery_key');
  const end = source.indexOf('fn request_missing_keys');
  const reasons = [...source.slice(start, end).matchAll(/reason: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(reasons.length >= 6, `found ${reasons.length}`);
  for (const reason of reasons) assert.ok(restoreFailureKey(reason), `${reason} has no words`);
  assert.equal(restoreFailureKey('backup passphrase: wrong'), 'e2ee.restoreWrongKey');
  assert.equal(restoreFailureKey('sync: bad page'), null);
});

test('every core event the commands listen to is one cli.js actually forwards to them', () => {
  // cli.js hands transport events to the bus by an explicit list
  // (`forwardEvents`). An event missing there never reaches a handler here —
  // which is how "key backup restored" went unsaid: core-link emitted it, the
  // list did not carry it, and every unit test of this module still passed.
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const start = cli.indexOf('const forwardedEvents = [');
  const list = cli.slice(start, cli.indexOf('];', start));
  const forwarded = new Set([...list.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]));
  const { commands } = harness();
  for (const name of Object.keys(commands.events)) {
    assert.ok(forwarded.has(name), `${name} is handled here but cli.js does not forward it`);
  }
});

// ---- /keys reset ----------------------------------------------------------

test('/keys reset warns, asks for the password in the masked prompt, and hands it to the core unsaid', async () => {
  const { prompt, asked } = scriptedPrompt('account password');
  const timers = manualTimers();
  const { commands, said, calls } = harness({ promptSecret: prompt, timers });
  commands.keys('reset');
  await settle();
  // The warning comes before the card, and names what changes for others.
  assert.match(said[0], /contacts will see your keys change/);
  assert.equal(asked.length, 1);
  assert.match(asked[0].title, /RESET ENCRYPTION KEYS/);
  assert.match(asked[0].prompt, /password/);
  assert.deepEqual(calls, [['reset', 'account password']]);
  assert.ok(!said.join('\n').includes('account password'), 'the password is never said');
  assert.match(said.at(-1), /resetting/);
  assert.equal(timers.pending.size, 1);

  commands.events['core-cross-signing-reset']({});
  const done = said.at(-1);
  assert.match(done, /new encryption keys/);
  assert.match(done, /\/verify alice/, 'names the way to sign the other devices');
  assert.match(done, /\/backup create/, 'and to make the backup again');
  assert.equal(timers.pending.size, 0);
});

test('/keys reset cancelled at the card, or without a masked prompt, changes nothing', async () => {
  const cancelled = harness({ promptSecret: scriptedPrompt(null).prompt });
  cancelled.commands.keys('reset');
  await settle();
  assert.deepEqual(cancelled.calls, []);
  assert.match(cancelled.said.at(-1), /cancelled — your keys did not change/);

  const headless = harness({ promptSecret: null });
  headless.commands.keys('reset');
  await settle();
  assert.deepEqual(headless.calls, []);
  assert.match(headless.said.at(-1), /masked prompt/);

  const usage = harness({ promptSecret: scriptedPrompt('x').prompt });
  usage.commands.keys('');
  usage.commands.keys('now');
  assert.deepEqual(usage.calls, []);
  assert.match(usage.said.at(-1), /usage: \/keys reset/);
});

test('every reason a reset fails has its own words, and each says the keys did not change', () => {
  const api = readFileSync(new URL('../crates/tailchat-core/src/api.rs', import.meta.url), 'utf8');
  const doc = api.slice(api.indexOf('/// A reset did not happen.'), api.indexOf('CrossSigningResetFailed {'));
  const reasons = [...doc.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).filter((word) => word !== 'reason');
  assert.ok(reasons.length >= 7, `found ${reasons}`);
  const t = createTranslator('en');
  for (const reason of reasons) {
    assert.ok(RESET_FAILURES[reason], `${reason} has no words`);
  }
  for (const [reason, key] of Object.entries(RESET_FAILURES)) {
    const line = t(key, { reason });
    assert.ok(/did not change|retry|try/.test(line), `${reason}: ${line}`);
  }
  const { commands, said } = harness();
  commands.events['core-cross-signing-reset-failed']({ reason: 'bad_password' });
  assert.match(said.at(-1), /wrong password/);
  commands.events['core-cross-signing-reset-failed']({ reason: 'something_new' });
  assert.match(said.at(-1), /refused the new keys \(something_new\)/);
});

test('a reset settled after the no-answer line is still said', async () => {
  const timers = manualTimers();
  const { commands, said } = harness({ promptSecret: scriptedPrompt('pw').prompt, timers });
  commands.keys('reset');
  await settle();
  timers.fire();
  assert.match(said.at(-1), /no answer yet/);
  commands.events['core-cross-signing-reset']({});
  assert.match(said.at(-1), /new encryption keys/);
});

// --- The first live test in production (2026-11-11, godsheep ↔ roman) -----

// Live comparisons are for your own devices only: a contact is verified by
// the safety code. Every handshake below is alice signing a device of hers.
const twoDevices = {
  alice: { devices: { PHONE: { name: 'phone', createdAt: 900 } } },
};

test('a request nobody answers is cancelled in words, not left "waiting for the emojis" forever', async () => {
  const timers = manualTimers();
  const { commands, said, about, calls } = harness({ users: twoDevices, timers });
  await commands.verify('alice');
  assert.deepEqual(calls.at(-1), ['startSas', 'alice', 'PHONE']);
  assert.match(said.at(-1), /asking alice's device “phone”/);
  assert.equal([...timers.pending.values()][0].ms, SAS_ANSWER_TIMEOUT_MS);
  commands.events['core-sas-started']({ transactionId: 'T1', peer: 'alice', device: 'PHONE' });

  timers.fire();
  // Cancelled in the core, so a device that comes back later does not pop a
  // dialog for a request nobody is waiting on any more.
  assert.deepEqual(calls.at(-1), ['cancelSas', 'T1']);
  assert.match(said.at(-1), /no answer from alice's device “phone” — it is probably offline/);
  assert.equal(about.at(-1), 'alice');
});

test('emojis that arrive in time stop the clock; so does the other side cancelling', async () => {
  const timers = manualTimers();
  const answered = harness({ users: twoDevices, timers });
  await answered.commands.verify('alice');
  answered.commands.events['core-sas-started']({ transactionId: 'T1', peer: 'alice', device: 'PHONE' });
  answered.commands.events['core-sas-code-ready']({ transactionId: 'T1', peer: 'alice', emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1, 2, 3] });
  assert.equal(timers.pending.size, 0);

  const refused = harness({ users: twoDevices, timers });
  await refused.commands.verify('alice');
  refused.commands.events['core-sas-started']({ transactionId: 'T2', peer: 'alice', device: 'PHONE' });
  refused.commands.events['core-sas-cancelled']({ transactionId: 'T2', peer: 'alice', device: 'PHONE', reason: 'user_cancelled' });
  assert.equal(timers.pending.size, 0);
});

test('a handshake another account started is not mistaken for the one this side is timing', async () => {
  const timers = manualTimers();
  const { commands, calls } = harness({ users: twoDevices, timers });
  await commands.verify('alice');
  // Some other account's handshake starts meanwhile: its id is not ours.
  commands.events['core-sas-started']({ transactionId: 'OTHER', peer: 'carol', device: 'X' });
  commands.events['core-sas-code-ready']({ transactionId: 'OTHER', peer: 'carol', emojiIndices: [0, 0, 0, 0, 0, 0, 0], decimals: [1, 2, 3] });
  assert.equal(timers.pending.size, 1, 'still waiting for alice\'s phone');
  commands.events['core-sas-started']({ transactionId: 'MINE', peer: 'alice', device: 'PHONE' });
  timers.fire();
  assert.deepEqual(calls.at(-1), ['cancelSas', 'MINE']);
});

test('a second /verify cancels the first on both sides instead of leaving it to be confirmed into nothing', async () => {
  const timers = manualTimers();
  const { commands, calls } = harness({ users: twoDevices, timers });
  await commands.verify('alice');
  commands.events['core-sas-started']({ transactionId: 'FIRST', peer: 'alice', device: 'PHONE' });
  await commands.verify('alice');
  const cancels = calls.filter((call) => call[0] === 'cancelSas');
  assert.deepEqual(cancels, [['cancelSas', 'FIRST']]);
  assert.equal(timers.pending.size, 1, 'one clock, for the new request');

  // And a code waiting for an answer goes the same way.
  commands.events['core-sas-started']({ transactionId: 'SECOND', peer: 'alice', device: 'PHONE' });
  commands.events['core-sas-code-ready']({ transactionId: 'SECOND', peer: 'alice', emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1, 2, 3] });
  await commands.verify('alice');
  assert.deepEqual(calls.filter((call) => call[0] === 'cancelSas').at(-1), ['cancelSas', 'SECOND']);
});

test('a new code replacing one still on screen cancels the old one', () => {
  const { commands, calls } = harness();
  commands.events['core-sas-code-ready']({ transactionId: 'OLD', peer: 'bob', emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1, 2, 3] });
  commands.events['core-sas-code-ready']({ transactionId: 'NEW', peer: 'bob', emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1, 2, 3] });
  assert.deepEqual(calls.filter((call) => call[0] === 'cancelSas'), [['cancelSas', 'OLD']]);
  commands.verify('yes');
  assert.deepEqual(calls.at(-1), ['confirmSas', 'NEW'], 'the answer goes to the code on screen');
});

// roman reset his keys on the device he was on; the reset signed it. The page
// still held "2I_PV… is unsigned" from before and refused every device.
test('a peer\'s key change forgets which of their devices were unsigned under the old keys', () => {
  const { commands, said } = harness();
  commands.events['core-unverified-device']({ peer: 'bob', device: 'FRESH' });
  commands.events['core-key-changed']({ peer: 'bob' });
  // A live comparison bob started from FRESH after his reset signed it.
  commands.events['core-device-verified']({ peer: 'bob', device: 'FRESH' });
  assert.match(said.at(-1), /✓ emojis matched with bob \(FRESH\)/);

  // Another account's entries stay: only bob's keys changed.
  commands.events['core-unverified-device']({ peer: 'carol', device: 'C' });
  commands.events['core-key-changed']({ peer: 'bob' });
  commands.events['core-device-verified']({ peer: 'carol', device: 'C' });
  assert.match(said.at(-1), /C is not signed by carol's account keys/);
});

test('lines about verifying a device say whom they concern, so a client can file your own elsewhere', async () => {
  const { commands, about } = harness({
    users: { alice: { devices: { TERMINAL: { name: 'terminal', createdAt: 100 } } } },
  });
  commands.events['core-device-registered']({ deviceId: 'BROWSER' });
  await commands.verify('alice');
  assert.equal(about.at(-1), 'alice');
});

// --- One request to every device (core StartSasAny) -----------------------

const PUBLISHED = 'SSK';
const signedBy = (login) => ({ signatures: { [login]: { [`ed25519:${PUBLISHED}`]: 's' } } });
// alice at a device whose keys are not known to be signed yet: only her
// signed devices can hand it the keys, so those are the ones asked.
const alicesDevices = {
  alice: {
    crossSigning: { selfSigning: { key: PUBLISHED } },
    devices: {
      TERMINAL: { name: 'terminal', createdAt: 100, deviceKeys: signedBy('alice') },
      BROWSER: { name: 'browser', createdAt: 900, deviceKeys: signedBy('alice') },
      FRESH: { name: 'fresh', createdAt: 5000, deviceKeys: { signatures: {} } },
    },
  },
};

test('every signed device of yours is asked at once, newest first, never an unsigned one', async () => {
  const { commands, calls, said } = harness({ users: alicesDevices, fanout: true });
  await commands.verify('alice');
  assert.deepEqual(calls.at(-1), ['startSasAny', 'alice', ['BROWSER', 'TERMINAL']]);
  assert.match(said.at(-1), /asking all 2 of alice's devices.*where Tailchat is open/);
});

test('one candidate is still one plain request, named by its device', async () => {
  const { commands, calls, said } = harness({
    users: { alice: { devices: { PHONE: { name: 'phone', createdAt: 1 } } } }, fanout: true,
  });
  await commands.verify('alice');
  assert.deepEqual(calls.at(-1), ['startSas', 'alice', 'PHONE']);
  assert.match(said.at(-1), /asking alice's device “phone”/);
});

test('a native module without StartSasAny asks the first candidate alone', async () => {
  const { commands, calls } = harness({ users: alicesDevices });
  await commands.verify('alice');
  assert.deepEqual(calls.at(-1), ['startSas', 'alice', 'BROWSER']);
});

test('when none of the devices asked answers, the words say all of them', async () => {
  const timers = manualTimers();
  const { commands, calls, said } = harness({ users: alicesDevices, fanout: true, timers });
  await commands.verify('alice');
  commands.events['core-sas-started']({ transactionId: 'T', peer: 'alice', device: 'BROWSER' });
  timers.fire();
  assert.deepEqual(calls.at(-1), ['cancelSas', 'T']);
  assert.ok(said.some((line) => /none of alice's devices answered — they are probably offline/.test(line)), said.join('\n'));
});

test('the devices that lost the race stay silent: "accepted elsewhere" is not a refusal', async () => {
  const { commands, said, calls } = harness();
  commands.events['core-sas-code-ready']({ transactionId: 'T', peer: 'alice', emojiIndices: [0, 1, 2, 3, 4, 5, 6], decimals: [1, 2, 3] });
  const before = said.length;
  commands.events['core-sas-cancelled']({ transactionId: 'T', peer: 'alice', device: 'X', reason: 'accepted_elsewhere' });
  assert.equal(said.length, before);
  await commands.verify('yes');
  assert.equal(calls.some((call) => call[0] === 'confirmSas'), false, 'and nothing is left to confirm');
});

test('your own account: from a signed device the unsigned ones are asked; from an unsigned one only signed ones', async () => {
  const mine = (ownSigned) => ({
    alice: {
      crossSigning: { selfSigning: { key: PUBLISHED } },
      devices: {
        HERE: { createdAt: 50, deviceKeys: ownSigned ? signedBy('alice') : { signatures: {} } },
        TERMINAL: { name: 'terminal', createdAt: 100, deviceKeys: signedBy('alice') },
        PHONE: { name: 'phone', createdAt: 300, deviceKeys: signedBy('alice') },
        BROWSER: { name: 'browser', createdAt: 900, deviceKeys: { signatures: {} } },
      },
    },
  });
  const fromSigned = harness({ users: mine(true), fanout: true });
  fromSigned.commands.events['core-device-registered']({ deviceId: 'HERE' });
  await fromSigned.commands.verify('alice');
  assert.deepEqual(fromSigned.calls.at(-1), ['startSas', 'alice', 'BROWSER'], 'signing the new one is the point');

  const fromUnsigned = harness({ users: mine(false), fanout: true });
  fromUnsigned.commands.events['core-device-registered']({ deviceId: 'HERE' });
  await fromUnsigned.commands.verify('alice');
  assert.deepEqual(fromUnsigned.calls.at(-1), ['startSasAny', 'alice', ['PHONE', 'TERMINAL']],
    'only a device that holds the keys can hand them over');
});

test('a device is called by its browser and system, never a host name', () => {
  const cases = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome · macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari · iOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1', 'Chrome · iOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0', 'Edge · Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 YaBrowser/24.1 Mobile Safari/537.36', 'Yandex Browser · Android'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OPR/115.0', 'Opera · Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36', 'Chrome · macOS'],
    ['', 'Browser'],
  ];
  for (const [ua, name] of cases) assert.equal(browserDeviceName(ua), name, ua);
  assert.equal(terminalDeviceName('darwin'), 'Terminal · macOS');
  assert.equal(terminalDeviceName('linux'), 'Terminal · Linux');
  assert.equal(terminalDeviceName('aix'), 'Terminal');
});

test('verification lines name a device by what it calls itself, and by its id when it never said', async () => {
  const { commands, said } = harness();
  commands.events['core-unverified-device']({ peer: 'bob', device: 'jlRU3eZ4x7jUi5kN', name: 'Chrome · macOS' });
  assert.match(said.at(-1), /Chrome · macOS/);
  assert.doesNotMatch(said.at(-1), /jlRU3eZ4x7jUi5kN/);
  // The set of unsigned devices stays keyed by id: verifying the same device
  // under its name still says that messages will not open.
  commands.events['core-device-verified']({ peer: 'bob', device: 'jlRU3eZ4x7jUi5kN', name: 'Chrome · macOS' });
  assert.match(said.at(-2), /Chrome · macOS/);
  assert.match(said.at(-1), /Chrome · macOS/, 'verifiedUnsigned names it too');
  commands.events['core-sas-cancelled']({ transactionId: 't', peer: 'bob', device: 'D', name: 'Terminal · Linux', reason: 'user_cancelled' });
  assert.match(said.at(-1), /Terminal · Linux/);
  // An older core, or a device that never named itself.
  commands.events['core-sas-cancelled']({ transactionId: 't2', peer: 'bob', device: 'NONAME', reason: 'user_cancelled' });
  assert.match(said.at(-1), /NONAME/);
  commands.events['core-device-registered']({ deviceId: 'MINE' });
  commands.events['core-unverified-device']({ peer: 'alice', device: 'MINE', name: 'Firefox · Linux' });
  assert.match(said.at(-1), /this device \(Firefox · Linux\)/);
});

test('the verification words say why, in plain terms, and where to compare — in every language', async () => {
  // Item 7 of the live test: neither person understood "verify". Each
  // language must say what a match means and that the comparing is done by
  // voice, outside this chat (a chat someone tampers with can lie about it).
  const { E2EE_STRINGS } = await import('../web/cloud/core/e2ee-strings.js');
  const why = { en: /nobody is tampering/, ru: /никто не подменяет/, fr: /personne ne falsifie/ };
  const where = { en: /by voice.*not in this chat/, ru: /голосом.*не в этом чате/, fr: /de vive voix.*pas dans ce chat/ };
  for (const lang of ['en', 'ru', 'fr']) {
    const table = E2EE_STRINGS[lang];
    for (const key of ['starting', 'startingAny', 'verified']) assert.match(table[key], why[lang], `${lang}.${key}`);
    assert.match(table.compare, where[lang], `${lang}.compare`);
    assert.doesNotMatch(table.starting + table.startingAny, /сверить ключи|to verify|de vérifier/, `${lang}: no jargon`);
  }
});

// ---- /safety --------------------------------------------------------------

const SAFETY_HALVES = [
  { login: 'alice', emojiIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { login: 'bob', emojiIndices: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
];

test('/safety shows both halves in the core\'s order and /safety yes trusts exactly the key shown', () => {
  const { commands, said, calls } = harness();
  commands.safety('');
  assert.deepEqual(calls, [['safetyCode', 'bob']]);
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'BOBKEY', verified: false,
  });
  assert.match(said[0], /safety code with bob/);
  const [aliceLine, , bobLine] = said.slice(1, 4);
  assert.match(aliceLine, /^ {2}alice {2}🐶 🐱 🦁/);
  assert.match(bobLine, /^ {2}bob {4}/);
  assert.match(said.at(-1), /\/verify yes/);
  commands.safety('yes');
  assert.deepEqual(calls.at(-1), ['confirmSafetyCode', 'bob', 'BOBKEY']);
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'BOBKEY', verified: true,
  });
  assert.match(said.at(-1), /✓ the safety code with bob matched/);
  // Nothing waits any more.
  commands.safety('yes');
  assert.match(said.at(-1), /no safety code is waiting/);
});

test('a code read before a key change confirms nothing, and the answer says so', () => {
  const { commands, said, calls } = harness();
  commands.safety('bob');
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'OLD', verified: false,
  });
  commands.events['core-key-changed']({ peer: 'bob' });
  commands.safety('yes');
  assert.ok(!calls.some(([name]) => name === 'confirmSafetyCode'), 'nothing confirmed after the change');
  assert.match(said.at(-1), /no safety code is waiting/);
  // A confirm that raced the change: the core answers unverified.
  commands.confirmSafetyCode('bob', 'OLD');
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'NEW', verified: false,
  });
  assert.match(said.at(-1), /keys changed since that code was shown/);
});

test('a code a panel asked for quietly is not said; no keys and no core are said plainly', () => {
  const { commands, said } = harness();
  assert.equal(commands.requestSafetyCode('bob'), true);
  commands.events['core-safety-code']({
    peer: 'bob', status: 'ready', halves: SAFETY_HALVES, masterKey: 'K', verified: false,
  });
  assert.deepEqual(said, [], 'a panel draws its own code');
  commands.safety('carol');
  commands.events['core-safety-code']({ peer: 'carol', status: 'no_keys', halves: [], masterKey: '', verified: false });
  assert.match(said.at(-1), /carol has no encryption keys yet/);
  commands.safety('alice');
  assert.match(said.at(-1), /\/verify alice/, 'your own devices are verified live');
  const old = harness({ safety: false });
  old.commands.safety('bob');
  assert.match(old.said.at(-1), /not running on this device/);
  assert.equal(old.commands.requestSafetyCode('bob'), false);
});

test('safetyCodeText names every emoji from the shared table', () => {
  const [alice] = safetyCodeText(SAFETY_HALVES);
  assert.equal(alice.login, 'alice');
  assert.equal(alice.emojis.length, 10);
  assert.deepEqual(alice.emojis.slice(0, 3), [SAS_EMOJIS[0][0], SAS_EMOJIS[1][0], SAS_EMOJIS[2][0]]);
  assert.equal(alice.labels[0], SAS_EMOJIS[0][1]);
  assert.deepEqual(safetyCodeText([{ login: 'x', emojiIndices: [99] }])[0].emojis, ['🔒']);
});
