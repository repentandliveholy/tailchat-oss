import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/web-contact-remove.test.js
// checks its pieces of it: app.js is a bundler-less browser script with no module
// boundary to import from.
const SOURCE = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

function extract(pattern, label) {
  const m = SOURCE.match(pattern);
  assert.ok(m, `${label} exists in web/cloud/app.js`);
  return m[0];
}

const CODE = 'a'.repeat(64);

// The real `/invite` branch of executeCommand, the real I18N and the real
// errorText, with only the browser edges (request, the invite dialog, the
// thread's two sinks) stubbed. `cmd`/`arg`/`thread` stay context globals so a
// test can set them and call the extracted branch like executeCommand does.
function loadInviteCommand({ failure } = {}) {
  const i18n = extract(/const I18N = \{[\s\S]*?\n\};/, 'I18N');
  const errorText = extract(/function errorText\(code\) \{[\s\S]*?\n\}/, 'errorText');
  const block = extract(/  if \(cmd === '\/invite' \|\| cmd === '\/inv'\) \{[\s\S]*?\n  \}/, '/invite branch');

  const calls = { request: [], systemNote: [], ascii: [], openDialog: 0 };
  const context = {
    currentLang: 'ru',
    cmd: '',
    arg: '',
    thread: {},
    request: async (...args) => {
      calls.request.push(args);
      if (failure) throw failure;
      return { invite: CODE };
    },
    location: { origin: 'https://cloud.example.test' },
    openInviteDialog: () => { calls.openDialog += 1; },
    elements: {
      myInviteInput: { value: '' },
      copyInviteButton: { disabled: true },
      myInviteStatus: { textContent: '' },
    },
    systemNote: (thread, text) => calls.systemNote.push(text),
    appendAsciiArt: (thread, text) => calls.ascii.push(text),
    parseInviteCode: () => null,
    refreshRoster: async () => {},
    selectPeer: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${i18n}\n${errorText}\n` +
      `globalThis.I18N = I18N;\n` +
      `globalThis.t = (key, ...rest) => (typeof I18N.ru[key] === 'function' ? I18N.ru[key](...rest) : I18N.ru[key]);\n` +
      `globalThis.inviteHandler = async () => {\n${block}\n};`,
    context,
  );
  return { context, calls };
}

test('a login after create reaches the request and names the account in the thread', async () => {
  const { context, calls } = loadInviteCommand();
  context.cmd = '/inv';
  context.arg = 'create carl';

  await context.inviteHandler();

  assert.equal(calls.request.length, 1, 'exactly one request');
  const [method, path, body] = calls.request[0];
  assert.equal(method, 'POST');
  assert.equal(path, '/invite', 'the invite endpoint, not accept');
  assert.equal(body.login, 'carl', 'the named account travels in the body');

  assert.equal(context.elements.myInviteInput.value, `https://cloud.example.test/tailchat/?invite=${CODE}`, 'the link is shown as before');
  assert.ok(context.elements.myInviteStatus.textContent.includes('carl'), 'the dialog says whose link this is, so it cannot be copied as your own');
  assert.equal(calls.ascii.length, 1, 'the thread gets one ascii note');
  assert.ok(calls.ascii[0].includes('carl'), `the note says whose link it is, got ${JSON.stringify(calls.ascii[0])}`);
  assert.ok(calls.ascii[0].includes(CODE), 'and carries the link');
});

test('create without a login keeps today\'s call and note', async () => {
  const { context, calls } = loadInviteCommand();
  context.cmd = '/invite';
  context.arg = 'create';

  await context.inviteHandler();

  assert.deepEqual(calls.request, [['POST', '/invite']], 'the call is exactly the old two-argument one');
  assert.ok(calls.ascii[0].includes(CODE), 'the note carries the link');
  assert.ok(!calls.ascii[0].includes('@'), 'nothing claims an account for the caller\'s own link');
  assert.ok(!context.elements.myInviteStatus.textContent.includes('@'), 'and the dialog does not either');
});

test('a refused cross-account invite is spoken in Russian', async () => {
  const { context, calls } = loadInviteCommand({ failure: { code: 'forbidden', status: 403 } });
  context.cmd = '/invite';
  context.arg = 'create carl';

  await context.inviteHandler();

  assert.deepEqual(calls.ascii, [], 'nothing is shown as if the link had been minted');
  assert.equal(
    calls.systemNote.at(-1),
    context.I18N.ru.errors.forbidden,
    'the refusal reaches the screen as the localised sentence for the code, never as the code',
  );
  assert.ok(!calls.systemNote.at(-1).includes('forbidden'), 'and not as the raw code');
  assert.equal(calls.openDialog, 0, 'the dialog stays shut');
});

test('a 64-hex argument is still an accept, not a login', async () => {
  const { context, calls } = loadInviteCommand();
  context.cmd = '/inv';
  context.arg = CODE;
  context.parseInviteCode = (raw) => raw;

  await context.inviteHandler();

  const [method, path, body] = calls.request[0];
  assert.equal(method, 'POST');
  assert.equal(path, '/invite/accept', 'the code is accepted, not minted');
  assert.equal(body.invite, CODE, 'the code, never a login');
});
