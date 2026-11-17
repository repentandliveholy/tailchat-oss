import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function extractFunction(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} exists in web/cloud/app.js`);
  return match[0];
}

/**
 * The ladder the roster's right-hand stamp walks, with the three locale
 * formatters stubbed and the clock passed in: *which* rung a timestamp falls on
 * is this client's rule (a conversation last touched weeks ago has no useful
 * time of day), while what a short Russian weekday looks like is `Intl`'s
 * business, not this test's.
 */
function loadRosterTime() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const context = {
    timeFormat: { format: (d) => `clock:${d.getHours()}:${d.getMinutes()}` },
    weekdayFormat: { format: (d) => `weekday:${d.getDay()}` },
    dayShortFormat: { format: (d) => `date:${d.getDate()}.${d.getMonth() + 1}` },
    t: (key) => key,
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(source, 'midnight'),
    extractFunction(source, 'rosterTimeLabel'),
    'globalThis.rosterTimeLabel = rosterTimeLabel;',
  ].join('\n'), context);
  return context.rosterTimeLabel;
}

// September 2026: the 28th is a Monday.
const at = (...parts) => new Date(...parts).getTime();

test('the roster stamp walks one ladder: clock, yesterday, weekday, date, year', () => {
  const label = loadRosterTime();
  const now = new Date(2026, 8, 28, 14, 5);

  assert.equal(label(at(2026, 8, 28, 9, 30), now), 'clock:9:30');
  assert.equal(label(at(2026, 8, 27, 23, 59), now), 'yesterday');
  assert.equal(label(at(2026, 8, 26, 12, 0), now), 'weekday:6');
  assert.equal(label(at(2026, 8, 22, 12, 0), now), 'weekday:2', 'six days back is still a day one remembers');
  assert.equal(label(at(2026, 8, 21, 12, 0), now), 'date:21.9', 'a week back is a date, not a weekday');
  assert.equal(label(at(2025, 11, 30, 12, 0), now), 'date:30.12 \'25', 'another year says which one');
});

test('the ladder counts local days, not elapsed hours', () => {
  const label = loadRosterTime();
  // Half past midnight: a message from three calendar days ago is three days
  // ago even though barely sixty hours have passed.
  const now = new Date(2026, 8, 28, 0, 30);

  assert.equal(label(at(2026, 8, 25, 23, 50), now), 'weekday:5');
  assert.equal(label(at(2026, 8, 27, 0, 10), now), 'yesterday');
});
