import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));

// app.js is a bundler-less browser script. Exercise the selection state machine
// directly; pointer/geometry integration and the composer are smoked in Chromium.
function withRows(ids) {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const block = source.match(/\/\/ --- Message selection[\s\S]*?\n(?=function deleteMessages\()/);
  const rows = ids.map((id, index) => {
    const classes = new Set();
    const row = {
      dataset: { id, side: 'own' },
      isConnected: true,
      listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      querySelector: () => row.bubble,
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        has: name => classes.has(name),
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      },
    };
    row.bubble = {
      dataset: {},
      closest: () => row,
      getBoundingClientRect: () => ({ top: index * 60, bottom: index * 60 + 40, height: 40 }),
    };
    return row;
  });
  const node = {
    contains: row => rows.includes(row),
    querySelectorAll(selector) {
      return selector === '.row-selected' ? rows.filter(row => row.classList.has('row-selected')) : rows;
    },
    querySelector(selector) {
      const id = /\[data-id="(.+)"\]/.exec(selector)?.[1];
      return rows.find(row => row.dataset.id === id) ?? null;
    },
  };
  const menus = [];
  const deleted = [];
  let pointedRow = null;
  const listeners = new Map();
  const context = {
    activePeer: 'pear',
    threads: new Map([['pear', { node }]]),
    t: (key, ...args) => args.length ? `${key}:${args.join(',')}` : key,
    CSS: { escape: value => value },
    preserveFocusOnPointerDown() {},
    closeMessageMenu() {},
    hideQuickReactions() {},
    cancelQuickReactionHover() {},
    isTouchActivation: event => event.pointerType === 'touch',
    showQuickReactions() {},
    openMessageMenu(_anchor, message) { menus.push({ id: message.id }); },
    placeMenu() {},
    appendMenuItem(_menu, label, handler) { menus.push({ label, handler }); },
    document: {
      elementFromPoint: () => ({ closest: () => pointedRow }),
      createElement: () => ({ className: '', setAttribute() {}, append() {}, addEventListener() {} }),
      body: { append() {} },
    },
    openMenuNode: null,
    setTimeout,
    clearTimeout,
    deleteMessages: (selected, scope) => deleted.push({ ids: selected, scope }),
    window: {
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
    },
  };
  vm.createContext(context);
  vm.runInContext(block[0], context);
  vm.runInContext(source.match(/function attachMessageActions\([^]*?\n\}/)[0], context);
  return {
    context, rows, menus, deleted,
    selected: () => plain(context.selectedIdsInOrder()),
    mode: () => vm.runInContext('selectionMode', context),
    dispatch: name => listeners.get(name)?.(),
    attach(index) {
      const row = rows[index];
      context.attachMessageActions(row, {
        id: row.dataset.id, own: true, text: 'hello', author: 'me',
      });
      return (name, target, pointerType = 'mouse', coordinates = {}) => row.listeners.get(name)({
        button: 0, target, pointerType, clientX: 0, clientY: 0, ...coordinates,
        preventDefault() {}, stopImmediatePropagation() {},
      });
    },
    point(index, offset = 20) {
      pointedRow = index === null ? null : rows[index];
      context.onSelectDragMove({ clientX: 20, clientY: index === null ? 0 : index * 60 + offset });
    },
  };
}

test('selection toggles rows and clearing the last row exits', () => {
  const h = withRows(['m1', 'm2']);
  h.context.toggleRowSelection('m1');
  h.context.toggleRowSelection('m2');
  assert.deepEqual(h.selected(), ['m1', 'm2']);
  h.context.toggleRowSelection('m1');
  assert.deepEqual(h.selected(), ['m2']);
  assert.equal(h.rows[0].classList.has('row-selected'), false);
  h.context.toggleRowSelection('m2');
  assert.equal(h.mode(), false);
  assert.equal(h.rows[1].classList.has('row-selected'), false);
});

test('selected ids follow transcript order, not picking order', () => {
  const h = withRows(['m1', 'm2', 'm3']);
  h.context.toggleRowSelection('m3');
  h.context.toggleRowSelection('m1');
  assert.deepEqual(h.selected(), ['m1', 'm3']);
});

test('removed rows are pruned and losing the last selection exits', () => {
  const h = withRows(['m1', 'm2']);
  h.context.toggleRowSelection('m1');
  h.context.toggleRowSelection('m2');
  h.rows.splice(0, 1);
  h.context.renderSelectionState();
  assert.deepEqual(h.selected(), ['m2']);
  h.rows.splice(0, 1);
  h.context.renderSelectionState();
  assert.equal(h.mode(), false);
});

test('bulk deletion for everyone is offered only for an entirely own selection', () => {
  const own = withRows(['m1', 'm2']);
  own.context.enterSelectionMode('m2');
  own.context.enterSelectionMode('m1');
  own.context.openSelectionMenu({});
  const deleteAll = own.menus.find(item => item.label.startsWith('msgDeleteAll'));
  assert.ok(deleteAll);
  deleteAll.handler();
  assert.deepEqual(plain(own.deleted), [{ ids: ['m1', 'm2'], scope: 'all' }]);
  assert.equal(own.mode(), false);

  const mixed = withRows(['m1', 'm2']);
  mixed.rows[1].dataset.side = 'peer';
  mixed.context.enterSelectionMode('m1');
  mixed.context.enterSelectionMode('m2');
  mixed.context.openSelectionMenu({});
  assert.equal(mixed.menus.some(item => item.label.startsWith('msgDeleteAll')), false);
  mixed.menus.find(item => item.label.startsWith('msgDeleteMine')).handler();
  assert.deepEqual(plain(mixed.deleted), [{ ids: ['m1', 'm2'], scope: 'self' }]);
});

test('release and navigation cancel a pending hold; completed hold survives release', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = withRows(['m1', 'm2']);
  h.context.beginSelectDrag('m1');
  h.context.onSelectDragEnd();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.selected(), []);
  h.context.beginSelectDrag('m1');
  h.context.exitSelectionMode();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.selected(), []);
  h.context.beginSelectDrag('m2');
  t.mock.timers.tick(1000);
  h.context.onSelectDragEnd();
  assert.deepEqual(h.selected(), ['m2']);
});

test('a brief click stays inert, a short hold selects, and scrolling cancels a pending hold', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = withRows(['m1', 'm2']);
  h.context.beginSelectDrag('m1');
  t.mock.timers.tick(50);
  h.dispatch('pointerup');
  t.mock.timers.tick(200);
  assert.deepEqual(h.selected(), []);
  h.context.beginSelectDrag('m1');
  t.mock.timers.tick(50);
  h.dispatch('scroll');
  t.mock.timers.tick(200);
  assert.deepEqual(h.selected(), []);
  h.context.beginSelectDrag('m2');
  t.mock.timers.tick(200);
  h.dispatch('pointerup');
  assert.deepEqual(h.selected(), ['m2']);
});

test('row whitespace selects just like the bubble, without stealing controls or touch scrolling', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = withRows(['m1', 'm2']);
  const first = h.attach(0);
  const second = h.attach(1);
  const whitespace = { closest: () => null };
  const button = { closest: selector => selector.includes('button') ? {} : null };
  first('pointerdown', button);
  t.mock.timers.tick(200);
  assert.deepEqual(h.selected(), []);
  first('pointerdown', whitespace, 'touch');
  t.mock.timers.tick(200);
  assert.deepEqual(h.selected(), []);
  first('pointerdown', whitespace);
  t.mock.timers.tick(200);
  h.dispatch('pointerup');
  first('click', whitespace);
  assert.deepEqual(h.selected(), ['m1'], 'the release click must not toggle the held row off');
  second('click', whitespace);
  assert.deepEqual(h.selected(), ['m1', 'm2']);
  first('click', whitespace);
  assert.deepEqual(h.selected(), ['m2']);
});

test('touch holds open the message menu, while taps, movement, scrolling and navigation cancel it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = withRows(['m1']);
  const gesture = h.attach(0);
  const target = { closest: () => null };
  gesture('pointerdown', target, 'touch');
  t.mock.timers.tick(100);
  gesture('pointerup', target, 'touch');
  t.mock.timers.tick(1000);
  assert.deepEqual(h.menus, []);
  gesture('pointerdown', target, 'touch');
  gesture('pointermove', target, 'touch', { clientY: 20 });
  t.mock.timers.tick(1000);
  assert.deepEqual(h.menus, []);
  gesture('pointerdown', target, 'touch');
  h.dispatch('scroll');
  t.mock.timers.tick(1000);
  assert.deepEqual(h.menus, []);
  gesture('pointerdown', target, 'touch');
  h.context.activePeer = 'another';
  t.mock.timers.tick(1000);
  assert.deepEqual(h.menus, []);
  h.context.activePeer = 'pear';
  gesture('pointerdown', target, 'touch');
  t.mock.timers.tick(600);
  assert.deepEqual(h.menus, [{ id: 'm1' }]);
  gesture('pointerup', target, 'touch');
  gesture('click', target, 'touch');
  assert.deepEqual(h.selected(), []);
});

test('held drag follows message midpoints immediately, including fast multi-row movement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = withRows(['m1', 'm2', 'm3', 'm4', 'm5']);
  h.context.beginSelectDrag('m1');
  t.mock.timers.tick(1000);
  h.point(1, 2);
  assert.deepEqual(h.selected(), ['m1']);
  h.point(1);
  assert.deepEqual(h.selected(), ['m1', 'm2']);
  h.point(2, 2);
  assert.deepEqual(h.selected(), ['m1', 'm2']);
  h.point(4);
  assert.deepEqual(h.selected(), ['m1', 'm2', 'm3', 'm4', 'm5']);
});

test('retracing shrinks immediately and returning to the anchor clears even the first row', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const direction of [1, -1]) {
    const h = withRows(['m1', 'm2', 'm3', 'm4']);
    const start = direction === 1 ? 0 : 3;
    h.context.beginSelectDrag(h.rows[start].dataset.id);
    t.mock.timers.tick(1000);
    h.point(start + direction);
    t.mock.timers.tick(200);
    h.point(start + 2 * direction);
    t.mock.timers.tick(200);
    assert.equal(h.selected().length, 3);
    h.point(start + direction);
    assert.equal(h.selected().length, 2);
    h.point(start);
    assert.deepEqual(h.selected(), []);
    assert.equal(h.mode(), false);
    assert.equal(h.rows[start].classList.has('row-selected'), false);
    // The same held gesture can deliberately grow again after clearing.
    h.point(start + direction);
    t.mock.timers.tick(200);
    assert.equal(h.selected().length, 2);
    h.context.onSelectDragEnd();
  }
});

test('movement during the initial hold is applied on activation; releasing early cancels it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = withRows(['m1', 'm2', 'm3']);
  h.context.beginSelectDrag('m1');
  h.point(2);
  h.context.onSelectDragEnd();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.selected(), []);
  h.context.beginSelectDrag('m1');
  h.point(2);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.selected(), ['m1', 'm2', 'm3']);
  h.context.onSelectDragEnd();
  h.point(0);
  assert.deepEqual(h.selected(), ['m1', 'm2', 'm3']);
});
