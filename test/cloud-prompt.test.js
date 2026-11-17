import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import {
  askLine, askSecret, describeLastSeen, peerRows, describeApiError,
} from '../src/cloud/prompt.js';
import { menuListRoom } from '../src/menu.js';
import { createTranslator } from '../src/i18n.js';
import { CloudApiError } from '../src/cloud/api.js';

function terminalInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (next) => {
    input.isRaw = next;
    return input;
  };
  return input;
}

function terminalOutput() {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  output.isTTY = true;
  output.columns = 80;
  return { output, text: () => text };
}

test('askSecret captures each terminal character once without echoing it', async () => {
  const input = terminalInput();
  const shown = terminalOutput();
  const answer = askSecret('Пароль: ', { input, output: shown.output });

  input.write('secret\r');

  assert.equal(await answer, 'secret');
  assert.equal(shown.text(), 'Пароль: \n');
  assert.equal(input.isRaw, false, 'restores terminal raw mode');
});

test('askSecret handles backspaces cleanly in raw mode', async () => {
  const input = terminalInput();
  const shown = terminalOutput();
  const answer = askSecret('Пароль: ', { input, output: shown.output });

  input.write('secrxx\u0008\u0008et\n');

  assert.equal(await answer, 'secret');
  assert.equal(shown.text(), 'Пароль: \n');
});

test('askLine reads line and echoes visible characters with backspace support', async () => {
  const input = terminalInput();
  const shown = terminalOutput();
  const answer = askLine('Логин: ', { input, output: shown.output });

  input.write('romax\u0008n\r');

  assert.equal(await answer, 'roman');
  assert.ok(shown.text().startsWith('Логин: '));
  assert.equal(input.isRaw, false);
});

test('describeLastSeen formats human readable relative timestamps', () => {
  const t = createTranslator('ru');
  const now = 1_756_500_000_000;
  assert.equal(describeLastSeen(0, t, now), 'ни разу не заходил(а)');
  assert.equal(describeLastSeen(now - 10_000, t, now), 'был(а) только что');
  assert.equal(describeLastSeen(now - 5 * 60_000, t, now), 'был(а) 5 мин назад');
  assert.equal(describeLastSeen(now - 2 * 3600_000, t, now), 'был(а) 2 ч назад');
  assert.equal(describeLastSeen(now - 3 * 86400_000, t, now), 'был(а) 3 дн назад');
});

test('peerRows prepares rows for interactive menu', () => {
  const t = createTranslator('ru');
  const now = 1_756_500_000_000;
  const rows = peerRows([
    { login: 'anna', name: 'Анна', online: true, lastSeen: now },
    { login: 'boris', name: 'Борис', online: false, lastSeen: now - 300_000 },
  ], t, now);

  assert.deepEqual(rows, [
    { name: 'Анна', help: 'в сети', value: 'anna' },
    { name: 'Борис', help: 'был(а) 5 мин назад', value: 'boris' },
  ]);
});

test('describeApiError maps new friend invite error codes across languages', () => {
  for (const lang of ['en', 'ru', 'fr']) {
    const t = createTranslator(lang);
    for (const code of ['invalid_invite', 'invite_not_found', 'self_invite', 'not_friends', 'bad_credentials', 'extra_password_required']) {
      const err = new CloudApiError({ code, message: 'err' });
      const text = describeApiError(err, t);
      assert.ok(text.length > 0);
      assert.notEqual(text, `the cloud server refused this: ${code}`);
    }
  }
});

// The roster used to be capped at a fixed row count whatever the terminal, so a
// short window drew the surplus through the hint line and the frame border and
// the reader saw four or five friends out of a dozen.
test('the roster list is sized from the terminal, not a fixed row count', () => {
  // A tall terminal shows the whole list rather than stopping at a few rows.
  assert.equal(menuListRoom(40), 34);
  // A short one asks for fewer rows than a fixed cap, which is exactly the case
  // that used to clip.
  assert.equal(menuListRoom(12), 6);
  assert.ok(menuListRoom(12) < 10);
});

test('an unusable terminal height never yields a negative or zero row count', () => {
  assert.equal(menuListRoom(1), 3);
  assert.equal(menuListRoom(0), 3);
  // blessed reports null height before the screen is laid out; falling back to
  // the old constant is better than rendering an empty list.
  assert.equal(menuListRoom(undefined), 10);
  assert.equal(menuListRoom(NaN), 10);
});
