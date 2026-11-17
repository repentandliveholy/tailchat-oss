import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

// The profile form, extracted the way the other web suites extract what they
// pin (app.js is a bundler-less browser script with no module boundary).
//
// What is pinned here is the shape of the three-state additional password
// (`syncProfileExtraPasswordRows` in app.js) *and* the rule that the two
// password operations are independent. The form used to derive "the primary
// password is changing" from `currentPassword || newPassword || confirmPassword`
// — and the current password is the proof both operations need. So a person who
// typed their current password in order to set or clear the *additional* one,
// with no new primary password anywhere, was told `invalid_password` locally and
// nothing ever reached the server: the feature could not be used at all.
function functionSource(name) {
  const functionStart = appSource.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} exists in web/cloud/app.js`);
  const start = appSource.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  let parameterDepth = 0;
  let body = -1;
  for (let i = appSource.indexOf('(', functionStart); i < appSource.length; i += 1) {
    if (appSource[i] === '(') parameterDepth += 1;
    else if (appSource[i] === ')' && --parameterDepth === 0) {
      body = appSource.indexOf('{', i);
      break;
    }
  }
  assert.notEqual(body, -1, `${name} has a function body`);
  let depth = 0;
  for (let i = body; i < appSource.length; i += 1) {
    if (appSource[i] === '{') depth += 1;
    else if (appSource[i] === '}' && --depth === 0) return appSource.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// Objects built inside the `vm` context carry that realm's prototypes, and
// `deepStrictEqual` compares those too — so every expected body goes through the
// host realm before it is compared.
const plain = (value) => JSON.parse(JSON.stringify(value));

const PROFILE_MAX = Number(
  /const PASSWORD_MAX_CHARS = (\d+);/.exec(appSource)?.[1] ?? 'NaN',
);

function loadProfileForm({ enabled = false } = {}) {
  const calls = [];
  const elements = {
    profileDialog: { showModal() {}, close() {} },
    profileName: { value: 'Роман', focus() {} },
    profileLogin: { value: 'roman' },
    profileCurrentPassword: { value: '', focus() {} },
    profileNewPassword: { value: '' },
    profileConfirmPassword: { value: '' },
    profileExtraPasswordEnabled: { checked: enabled },
    profileExtraPasswordRow: { hidden: true },
    profileExtraPasswordConfirmRow: { hidden: true },
    profileExtraPassword: { value: '' },
    profileExtraPasswordConfirm: { value: '' },
    profileStatus: { textContent: '', dataset: {} },
    profileSaveButton: { disabled: false, textContent: '' },
  };
  const context = {
    elements,
    self: { login: 'roman', name: 'Роман', extraPasswordEnabled: enabled },
    request: async (method, path, body) => { calls.push({ method, path, body }); return { user: { ...context.self } }; },
    errorText: (code) => code,
    t: (key) => key,
    renderSelfIdentity: () => {},
    PASSWORD_MAX_CHARS: PROFILE_MAX,
    syncProfileExtraPasswordRows: () => {},
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('onProfileSubmit'),
    'globalThis.onProfileSubmit = onProfileSubmit;',
  ].join('\n'), context);
  return { context, elements, calls };
}

// `extraChecked` follows whatever the test actually did with the additional
// password: typing into either field is only ever reachable with the switch on
// (the rows are hidden otherwise), and an account that already has one starts
// with it on.
function submit({
  enabled = false, current = '', next = '', confirm = '',
  extra = '', extraConfirm = '', extraChecked = enabled || extra !== '' || extraConfirm !== '',
} = {}) {
  const form = loadProfileForm({ enabled });
  form.elements.profileCurrentPassword.value = current;
  form.elements.profileNewPassword.value = next;
  form.elements.profileConfirmPassword.value = confirm;
  form.elements.profileExtraPasswordEnabled.checked = extraChecked;
  form.elements.profileExtraPassword.value = extra;
  form.elements.profileExtraPasswordConfirm.value = extraConfirm;
  return form.context.onProfileSubmit({ preventDefault() {} }).then(() => form);
}

test('setting an additional password does not require — or change — the primary one', async () => {
  // The exact reproduction of the reported defect: the current password proves
  // the operator's authority for the additional password, and both new primary
  // fields stay empty.
  const form = await submit({ current: '1234567890', extra: 'abc', extraConfirm: 'abc' });

  assert.equal(form.calls.length, 1, 'the form must reach the server');
  assert.equal(form.calls[0].method, 'PATCH');
  assert.equal(form.calls[0].path, '/profile');
  assert.deepEqual(plain(form.calls[0].body), {
    name: 'Роман',
    currentPassword: '1234567890',
    extraPassword: 'abc',
  });
  assert.equal('newPassword' in form.calls[0].body, false, 'the primary password is not being changed');
  assert.equal(form.elements.profileStatus.dataset.kind, 'success');
});

test('a one-character additional password is accepted, and the ceiling is refused here rather than by the server', async () => {
  const single = await submit({ current: '1234567890', extra: 'x', extraConfirm: 'x' });
  assert.equal(single.calls.length, 1);
  assert.equal(single.calls[0].body.extraPassword, 'x');

  const tooLong = await submit({
    current: '1234567890',
    extra: 'y'.repeat(PROFILE_MAX + 1),
    extraConfirm: 'y'.repeat(PROFILE_MAX + 1),
  });
  assert.equal(tooLong.calls.length, 0, 'the >200 case is answered without a round trip');
  assert.equal(tooLong.elements.profileStatus.textContent, 'invalid_password');

  const atCeiling = await submit({
    current: '1234567890',
    extra: 'y'.repeat(PROFILE_MAX),
    extraConfirm: 'y'.repeat(PROFILE_MAX),
  });
  assert.equal(atCeiling.calls.length, 1, 'the boundary itself is valid');
});

test('a mismatched or empty additional password is refused before the server hears about it', async () => {
  const mismatch = await submit({ current: '1234567890', extra: 'abc', extraConfirm: 'abd' });
  assert.equal(mismatch.calls.length, 0);
  assert.equal(mismatch.elements.profileStatus.textContent, 'password_mismatch');

  const emptyWhenEnabling = await submit({ current: '1234567890', extraChecked: true });
  assert.equal(emptyWhenEnabling.calls.length, 0, 'enabling the switch with nothing typed is not a password');
  assert.equal(emptyWhenEnabling.elements.profileStatus.textContent, 'invalid_password');
});

test('leaving an additional password alone sends nothing about it, and clearing it sends an empty string', async () => {
  // Switch stays on, nothing typed: the account's protection must survive a
  // rename, so the request carries no `extraPassword` key at all.
  const untouched = await submit({ enabled: true, current: '', extraChecked: true });
  assert.equal(untouched.calls.length, 1);
  assert.equal('extraPassword' in untouched.calls[0].body, false);
  assert.equal('currentPassword' in untouched.calls[0].body, false, 'nothing sensitive was asked for');

  // Switch turned off while it was on: an explicit empty string is what the
  // server reads as «remove it» — and that is a security-lowering change, so
  // the current password is required for it.
  const cleared = await submit({ enabled: true, current: '1234567890', extraChecked: false });
  assert.equal(cleared.calls.length, 1);
  assert.equal(cleared.calls[0].body.extraPassword, '');
  assert.equal(cleared.calls[0].body.currentPassword, '1234567890');

  const clearedWithoutProof = await submit({ enabled: true, current: '', extraChecked: false });
  assert.equal(clearedWithoutProof.calls.length, 0, 'clearing without the current password is refused');
  assert.equal(clearedWithoutProof.elements.profileStatus.textContent, 'bad_credentials');
});

test('changing the primary password still needs the current one and both new fields', async () => {
  const complete = await submit({ current: '1234567890', next: 'newsecret', confirm: 'newsecret' });
  assert.equal(complete.calls.length, 1);
  assert.deepEqual(plain(complete.calls[0].body), {
    name: 'Роман',
    currentPassword: '1234567890',
    newPassword: 'newsecret',
  });

  const withoutProof = await submit({ next: 'newsecret', confirm: 'newsecret' });
  assert.equal(withoutProof.calls.length, 0);
  assert.equal(withoutProof.elements.profileStatus.textContent, 'invalid_password');

  const withoutConfirm = await submit({ current: '1234567890', next: 'newsecret' });
  assert.equal(withoutConfirm.calls.length, 0, 'one new field alone is not a password change');
  assert.equal(withoutConfirm.elements.profileStatus.textContent, 'password_mismatch');

  const mismatched = await submit({ current: '1234567890', next: 'newsecret', confirm: 'othersecret' });
  assert.equal(mismatched.calls.length, 0);
  assert.equal(mismatched.elements.profileStatus.textContent, 'password_mismatch');

  // Both at once: one proof, both operations, and the extra password is only
  // sent because it was typed rather than because the field exists.
  const both = await submit({
    enabled: true,
    current: '1234567890',
    next: 'newsecret',
    confirm: 'newsecret',
    extraChecked: true,
    extra: 'extra',
    extraConfirm: 'extra',
  });
  assert.equal(both.calls.length, 1);
  assert.deepEqual(plain(both.calls[0].body), {
    name: 'Роман',
    currentPassword: '1234567890',
    newPassword: 'newsecret',
    extraPassword: 'extra',
  });
});

test('a rename alone stays a rename', async () => {
  const form = await submit({ enabled: false });
  assert.equal(form.calls.length, 1);
  assert.deepEqual(plain(form.calls[0].body), { name: 'Роман' });
});
