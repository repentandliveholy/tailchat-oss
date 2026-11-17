import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// «нет непрочитанных, но он показывает как будто они есть» — the typing bar
// showing or hiding resizes the transcript, and that resize used to run
// through the same `scrollToLatest()` a genuine new message does. A reader
// who had scrolled up to read history got `unreadBelowCount` bumped, and the
// floating arrow lit up with a badge, purely because the peer started or
// stopped typing — no message ever arrived. `pinToTailOnLayoutShift` is the
// fix: a layout shift with no content only pins a reader already at the
// bottom; a reader who scrolled away gets nothing.
//
// Extracted from web/cloud/app.js the same way test/web-tail-follow.test.js
// does: app.js is a bundler-less browser script with no module boundary.
function loadTypingScroll() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const pieces = {
    unreadBelowCount: /let unreadBelowCount = 0;/,
    followTail: /let followTail = true;/,
    transcriptMeasurable: /function transcriptMeasurable\(\) \{[\s\S]*?\n\}/,
    scrollToLatest: /function scrollToLatest\(force = false, instant = false\) \{[\s\S]*?\n\}/,
    pinToTailOnLayoutShift: /function pinToTailOnLayoutShift\(\) \{[\s\S]*?\n\}/,
    peerTypingVoices: /const peerTypingVoices = new Set\(\);/,
    aiTypingVoice: /let aiTypingVoice = null;/,
    sendingFileLabel: /let sendingFileLabel = null;/,
    renderTypingIndicator: /function renderTypingIndicator\(\) \{[\s\S]*?\n\}/,
  };
  const code = [];
  for (const [name, pattern] of Object.entries(pieces)) {
    const match = source.match(pattern);
    assert.ok(match, `${name} exists in web/cloud/app.js`);
    code.push(match[0]);
  }

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
  const typingBar = { hidden: true };
  const typing = { textContent: '' };

  const context = {
    elements: { transcript, typingBar, typing, scrollBottomBtn: {}, scrollBadge: {} },
    updateScrollButton: () => {},
    displayName: (v) => v,
  };
  vm.createContext(context);
  vm.runInContext([
    ...code,
    'globalThis.renderTypingIndicator = renderTypingIndicator;',
    'globalThis.state = () => ({ followTail, unreadBelowCount });',
    'globalThis.startPeerTyping = (v) => { peerTypingVoices.add(v); };',
    'globalThis.stopPeerTyping = (v) => { peerTypingVoices.delete(v); };',
  ].join('\n'), context);

  return {
    transcript,
    show(height = 400, content = 2000) {
      transcript.clientHeight = height;
      transcript.scrollHeight = content;
    },
    run: (expression) => vm.runInContext(expression, context),
    state: () => context.state(),
  };
}

test('a reader scrolled up in history gets no phantom unread from the peer typing', () => {
  const web = loadTypingScroll();
  web.show();
  web.run('followTail = false;'); // reading history, same as noteTranscriptScroll would set

  web.run('startPeerTyping("anna")');
  web.run('renderTypingIndicator()');
  assert.equal(web.state().unreadBelowCount, 0, 'typing starting is not a new message');

  web.run('stopPeerTyping("anna")');
  web.run('renderTypingIndicator()');
  assert.equal(web.state().unreadBelowCount, 0, 'typing stopping is not a new message either');
});

test('a reader already at the bottom stays pinned when the typing bar appears', () => {
  const web = loadTypingScroll();
  web.show();
  web.transcript.scrollTop = web.transcript.scrollHeight; // at the tail
  web.run('followTail = true;');

  web.transcript.scrollHeight += 40; // the typing bar taking its own row
  web.run('startPeerTyping("anna")');
  web.run('renderTypingIndicator()');

  assert.equal(web.transcript.scrollTop, web.transcript.scrollHeight - web.transcript.clientHeight, 'stays pinned to the new bottom');
  assert.equal(web.state().unreadBelowCount, 0);
});
