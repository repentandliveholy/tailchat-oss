import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createReminder,
  normalizeActions,
  parseReminder,
  presetDue,
  REMINDER_ACTIONS,
} from '../packages/reminder-core/index.js';

const NOW = Date.parse('2026-09-18T12:00:00+03:00');
const options = { timezone: 'Europe/Moscow', now: NOW };

test('shared NLP understands the original Remindka Russian forms', () => {
  const relative = parseReminder('напомни мне через полчаса выключить чайник', options);
  assert.equal(relative.dueAt, NOW + 30 * 60_000);
  assert.equal(relative.text, 'выключить чайник');

  const split = parseReminder('завтра встреча в 15', options);
  assert.equal(split.dueAt, Date.parse('2026-09-19T15:00:00+03:00'));
  assert.equal(split.text, 'встреча');

  const afterTomorrow = parseReminder('послезавтра оплатить счёт', options);
  assert.equal(afterTomorrow.dueAt, Date.parse('2026-09-20T12:00:00+03:00'));
  assert.equal(afterTomorrow.text, 'оплатить счёт');
});

test('shared NLP understands French reminder phrases', () => {
  const relative = parseReminder('rappelle-moi dans 30 minutes d’éteindre la bouilloire', {
    ...options,
    locale: 'fr',
  });
  assert.equal(relative.dueAt, NOW + 30 * 60_000);
  assert.equal(relative.text, 'éteindre la bouilloire');

  const tomorrow = parseReminder('demain à 15 heures réunion', options);
  assert.equal(tomorrow.dueAt, Date.parse('2026-09-19T15:00:00+03:00'));
  assert.equal(tomorrow.text, 'réunion');
});

test('shared reminder records use transport-neutral ownership', () => {
  assert.deepEqual(createReminder({ id: 'r1', ownerId: 'olga', text: 'чай', dueAt: NOW, now: 1 }), {
    id: 'r1', ownerId: 'olga', text: 'чай', dueAt: NOW, status: 'scheduled', createdAt: 1,
  });
  assert.equal(presetDue('evening', options), Date.parse('2026-09-18T19:00:00+03:00'));
});

test('bot actions are bounded transport-neutral values', () => {
  assert.deepEqual(normalizeActions(REMINDER_ACTIONS.fired), REMINDER_ACTIONS.fired);
  assert.deepEqual(normalizeActions([
    { id: 'ok', label: 'OK', value: 'done' },
    { id: '', label: 'bad', value: 'bad' },
    { id: 'too-long', label: 'x'.repeat(41), value: 'bad' },
  ]), [{ id: 'ok', label: 'OK', value: 'done' }]);
});
