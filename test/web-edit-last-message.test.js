import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extracted verbatim from web/cloud/app.js, the same way test/web-forward.test.js
// and test/web-roster-pin.test.js check their pieces of it: app.js is a
// bundler-less browser script with no module boundary to import from.
//
// findLastOwnEditableMessage backs the ArrowUp-in-an-empty-composer shortcut
// (mirrors the msgEdit context-menu action, minus the mouse): it must walk
// back from the newest row and skip anything that isn't a live, text-bearing
// message of your own, the same rules `openMessageMenu` uses to decide
// whether to offer "Edit" at all.
function loadEditHelpers() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const findFn = source.match(/function findLastOwnEditableMessage\(\) \{[\s\S]*?\n\}/);
  const editFn = source.match(/function editLastOwnMessage\(\) \{[\s\S]*?\n\}/);
  assert.ok(findFn, 'findLastOwnEditableMessage exists in web/cloud/app.js');
  assert.ok(editFn, 'editLastOwnMessage exists in web/cloud/app.js');

  // A fake thread.node backing only the one selector these functions issue.
  function fakeNode(rows) {
    return {
      querySelectorAll(selector) {
        assert.equal(selector, '.row[data-side="own"][data-id]');
        return rows.filter((r) => r.dataset.side === 'own' && r.dataset.id);
      },
    };
  }

  const context = {
    activePeer: null,
    threads: new Map(),
    startEditMessage: null, // set per-test
    fakeNode,
  };
  vm.createContext(context);
  vm.runInContext(
    `${findFn[0]}\n${editFn[0]}\nglobalThis.findLastOwnEditableMessage = findLastOwnEditableMessage;\nglobalThis.editLastOwnMessage = editLastOwnMessage;`,
    context,
  );
  return context;
}

function row({ id, side = 'own', text = '', deleted = false }) {
  return { dataset: { id, side, deleted: deleted ? 'true' : undefined }, messageText: text };
}

test('picks the newest own message with text, ignoring peer rows after it', () => {
  const ctx = loadEditHelpers();
  ctx.activePeer = 'boris';
  ctx.threads.set('boris', { node: ctx.fakeNode([
    row({ id: 'm1', text: 'hi' }),
    row({ id: 'm2', side: 'peer', text: 'yo' }),
    row({ id: 'm3', text: 'second own' }),
  ]) });
  const found = ctx.findLastOwnEditableMessage();
  assert.equal(found.id, 'm3');
  assert.equal(found.text, 'second own');
});

test('skips a tombstoned own message and falls back to the previous one', () => {
  const ctx = loadEditHelpers();
  ctx.activePeer = 'boris';
  ctx.threads.set('boris', { node: ctx.fakeNode([
    row({ id: 'm1', text: 'still here' }),
    row({ id: 'm2', text: 'deleted after the fact', deleted: true }),
  ]) });
  const found = ctx.findLastOwnEditableMessage();
  assert.equal(found.id, 'm1');
  assert.equal(found.text, 'still here');
});

test('skips a media-only own message with no text to edit', () => {
  const ctx = loadEditHelpers();
  ctx.activePeer = 'boris';
  ctx.threads.set('boris', { node: ctx.fakeNode([
    row({ id: 'm1', text: '' }),
    row({ id: 'm2', text: '' }),
  ]) });
  assert.equal(ctx.findLastOwnEditableMessage(), null);
});

test('returns null with no active peer or no own messages at all', () => {
  const ctx = loadEditHelpers();
  assert.equal(ctx.findLastOwnEditableMessage(), null, 'no active peer');

  ctx.activePeer = 'boris';
  ctx.threads.set('boris', { node: ctx.fakeNode([row({ id: 'm1', side: 'peer', text: 'hi' })]) });
  assert.equal(ctx.findLastOwnEditableMessage(), null, 'only peer rows');
});

test('editLastOwnMessage hands the found id/text to startEditMessage and reports success', () => {
  const ctx = loadEditHelpers();
  ctx.activePeer = 'boris';
  ctx.threads.set('boris', { node: ctx.fakeNode([row({ id: 'm1', text: 'fix typo' })]) });
  const calls = [];
  ctx.startEditMessage = (id, text) => calls.push([id, text]);
  assert.equal(ctx.editLastOwnMessage(), true);
  assert.deepEqual(calls, [['m1', 'fix typo']]);
});

test('editLastOwnMessage returns false and does not call startEditMessage when there is nothing to edit', () => {
  const ctx = loadEditHelpers();
  ctx.activePeer = 'boris';
  ctx.threads.set('boris', { node: ctx.fakeNode([]) });
  let called = false;
  ctx.startEditMessage = () => { called = true; };
  assert.equal(ctx.editLastOwnMessage(), false);
  assert.equal(called, false);
});
