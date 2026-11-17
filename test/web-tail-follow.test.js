import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// «в web когда новые сообщения нужно чтобы экран опускал вниз сам».
//
// On a phone the transcript is `display: none` while the roster pane is up
// (`app.css`'s narrow-pane media query), so every geometry read on it returns
// 0 — `scrollHeight - clientHeight - scrollTop < 90` therefore read as "at the
// bottom" whatever the reader was actually looking at, and `scrollTop =
// scrollHeight` was a silent no-op. Coming back to the conversation showed its
// *oldest* loaded message, with the new one below the fold and nothing on
// screen to say so. A second way the tail was lost: a row that grows after it
// was inserted — a picture finishing its decode, the link-preview card that
// replaces a bare URL once `/api/link-preview` answers — moves the bottom of
// the transcript down under a reader who was sitting on it.
//
// `followTail` carries the intent across the first gap and `revealTalkPane`
// re-asserts it; `followTailGrowth` does the same for the second.
//
// Extracted from web/cloud/app.js the same way test/web-unread-watermark.test.js
// does: app.js is a bundler-less browser script with no module boundary.
function loadTailFollower() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const pieces = {
    unreadBelowCount: /let unreadBelowCount = 0;/,
    followTail: /let followTail = true;/,
    slack: /const AT_BOTTOM_SLACK_PX = \d+;/,
    transcriptMeasurable: /function transcriptMeasurable\(\) \{[\s\S]*?\n\}/,
    transcriptAtBottom: /function transcriptAtBottom\(\) \{[\s\S]*?\n\}/,
    noteTranscriptScroll: /function noteTranscriptScroll\(\) \{[\s\S]*?\n\}/,
    scrollToLatest: /function scrollToLatest\(force = false, instant = false\) \{[\s\S]*?\n\}/,
    revealTalkPane: /function revealTalkPane\(\) \{[\s\S]*?\n\}/,
    followTailGrowth: /function followTailGrowth\(peer\) \{[\s\S]*?\n\}/,
  };
  const code = [];
  for (const [name, pattern] of Object.entries(pieces)) {
    const match = source.match(pattern);
    assert.ok(match, `${name} exists in web/cloud/app.js`);
    code.push(match[0]);
  }

  // The container scrolls like a browser's: `scrollTop` clamps to the scrollable
  // range, so "set it past the end" lands exactly on the bottom, and a
  // `display: none` transcript measures nothing at all.
  const transcript = {
    style: {},
    scrollHeight: 0,
    clientHeight: 0,
    _top: 0,
    get scrollTop() { return this._top; },
    set scrollTop(value) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      this._top = Math.max(0, Math.min(value, max));
    },
  };

  const context = {
    elements: { transcript, app: { dataset: {} }, scrollBottomBtn: {}, scrollBadge: {} },
    requestAnimationFrame: (fn) => fn(),
    fitLogoBand: () => {},
    updateScrollButton: () => {},
  };
  vm.createContext(context);
  vm.runInContext([
    ...code,
    'let activePeer = "anna";',
    'globalThis.scrollToLatest = scrollToLatest;',
    'globalThis.revealTalkPane = revealTalkPane;',
    'globalThis.followTailGrowth = followTailGrowth;',
    'globalThis.noteTranscriptScroll = noteTranscriptScroll;',
    'globalThis.setActivePeer = (peer) => { activePeer = peer; };',
    'globalThis.state = () => ({ followTail, unreadBelowCount, scrollTop: elements.transcript.scrollTop });',
  ].join('\n'), context);

  return {
    transcript,
    /** The pane a phone shows a conversation in. */
    show(height = 400, content = 2000) {
      transcript.clientHeight = height;
      transcript.scrollHeight = content;
    },
    /** ...and hides behind the roster. */
    hide() {
      transcript.clientHeight = 0;
      transcript.scrollHeight = 0;
      transcript.scrollTop = 0;
    },
    run: (expression) => vm.runInContext(expression, context),
    state: () => context.state(),
    atBottom: () => transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 1,
  };
}

test('a message arriving while the roster pane hides the transcript still lands the reader on it', () => {
  const web = loadTailFollower();
  web.show();
  web.run('scrollToLatest(true, true)');
  assert.ok(web.atBottom(), 'the conversation opens on its newest message');

  // The reader goes back to the roster; on a phone that is `display: none`.
  web.hide();
  // A message arrives while the transcript has no box: the soft path cannot
  // measure anything, and the intent to follow is what survives.
  web.run('scrollToLatest(false)');
  assert.equal(web.state().followTail, true, 'following survives a transcript with no box');

  // Coming back to the conversation.
  web.show();
  web.run('revealTalkPane()');
  assert.ok(web.atBottom(), 'the newest message is on screen, not the oldest');
});

test('a row that grows after it was inserted keeps a following reader at the bottom', () => {
  const web = loadTailFollower();
  web.show();
  web.run('scrollToLatest(true, true)');

  // A picture finishes decoding / the preview card lands under the reader.
  web.transcript.scrollHeight += 300;
  assert.ok(!web.atBottom(), 'without the follow the newest row is below the fold');

  web.run('followTailGrowth("anna")');
  assert.ok(web.atBottom(), 'the reader is put back on the tail');

  // Somebody else's thread growing is not this reader's business.
  web.transcript.scrollHeight += 300;
  web.run('followTailGrowth("boris")');
  assert.ok(!web.atBottom(), 'only the conversation on screen is followed');
});

test('a reader scrolled up in history is not yanked, and the badge counts the message instead', () => {
  const web = loadTailFollower();
  web.show();
  web.run('scrollToLatest(true, true)');
  // Scrolling up to read: a real scroll, which is what clears the intent.
  web.transcript.scrollTop = 0;
  web.run('noteTranscriptScroll()');
  assert.equal(web.state().followTail, false, 'reading history is not following the tail');

  web.transcript.scrollHeight += 100;
  web.run('scrollToLatest(false)');
  assert.equal(web.state().scrollTop, 0, 'the reader stays where they were reading');
  assert.equal(web.state().unreadBelowCount, 1, 'the floating button carries the news instead');

  // And a row growing under them must not move them either.
  web.transcript.scrollHeight += 300;
  web.run('followTailGrowth("anna")');
  assert.equal(web.state().scrollTop, 0, 'growth alone never scrolls a reader who is reading');
});
