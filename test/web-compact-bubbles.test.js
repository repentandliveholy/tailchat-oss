import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/cloud/app.css', import.meta.url), 'utf8');

// A small DOM for the bundler-less renderer's structure/state, not pixel layout.
// Font metrics, final-line wrapping and touch hit areas remain browser checks.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.className = '';
    const values = new Map();
    this.style = {
      setProperty: (key, value) => values.set(key, value),
      getPropertyValue: key => values.get(key) || '',
      removeProperty: key => values.delete(key),
    };
  }
  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name) };
  }
  get previousElementSibling() {
    const siblings = this.parentElement?.children.filter(node => node.nodeType === 1) || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  get textContent() { return this.children.map(node => node.textContent ?? node.data).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') node = { nodeType: 3, data: node };
      node.remove?.();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  prepend(node) { this.insertBefore(node, this.children[0] || null); }
  insertBefore(node, before) {
    if (!before) { this.append(node); return; }
    node.remove?.();
    const index = this.children.indexOf(before);
    assert.ok(index >= 0, 'insertion target belongs to this container');
    node.parentElement = this;
    this.children.splice(index, 0, node);
  }
  before(node) { this.parentElement.insertBefore(node, this); }
  after(node) {
    const siblings = this.parentElement.children;
    this.parentElement.insertBefore(node, siblings[siblings.indexOf(this) + 1] || null);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  click() {}
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      const id = /^\[data-id="([^"]+)"\]$/.exec(part)?.[1];
      if (id !== undefined) return this.dataset.id === id;
      return this.tagName.toLowerCase() === part;
    });
  }
  querySelectorAll(selector) {
    const result = [];
    const direct = selector.startsWith(':scope > ');
    const wanted = direct ? selector.slice(9) : selector;
    const visit = parent => {
      for (const child of parent.children) {
        if (child.nodeType !== 1) continue;
        if (wanted.includes(' > ')) {
          const [outer, inner] = wanted.split(' > ');
          if (child.matches(inner) && child.parentElement.matches(outer)) result.push(child);
        } else if (child.matches(wanted)) result.push(child);
        if (!direct) visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  cloneNode(deep) {
    const clone = new Element(this.tagName);
    clone.className = this.className;
    clone.dataset = { ...this.dataset };
    clone.attributes = { ...this.attributes };
    if (deep) for (const child of this.children) clone.append(child.nodeType === 1 ? child.cloneNode(true) : child.data);
    return clone;
  }
}

function load() {
  const element = (className, text) => {
    const node = new Element();
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const document = {
    body: new Element(), createElement: tag => new Element(tag),
    createTreeWalker(root, _flags, filter) {
      const nodes = [];
      const visit = parent => {
        for (const child of parent.children) {
          if (filter?.acceptNode(child) === 2) continue;
          nodes.push(child);
          if (child.nodeType === 1) visit(child);
        }
      };
      visit(root);
      return { nextNode: () => nodes.shift() || null };
    },
  };
  const thread = { peer: 'roman', node: new Element(), seen: new Set(), marks: new Map(), reminded: new Set() };
  const blobs = [];
  const frames = [];
  const context = {
    // forwardMessage reads it: the page's classic path is the one under test.
    coreSession: null,
    document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    users: [
      { login: 'roman', name: 'Roman', alias: 'Friend' },
      { login: 'tailchat', name: 'Tailchat', official: true },
      { login: 'tailik', name: 'Tailik', official: true },
      { login: 'another-bot', name: 'Helper', official: true },
    ],
    self: { login: 'me', name: 'My Name' }, currentLang: 'en', activePeer: 'roman',
    peerLabel: user => user.alias || user.name || user.login,
    displayName: login => login === 'me' ? 'Saved Messages' : 'Friend',
    timeFormat: { format: () => '12:40' }, structuredClone,
    messageAttachments: new Map(), threads: new Map([['roman', thread]]), CSS: { escape: value => value },
    IMAGE_PREVIEW_MAX_PX: 480, showDeletedMessages: true,
    isImageCaption: text => Boolean(text && text !== '[Image]'),
    t: key => ({ msgDeleted: 'Deleted', imageTitle: 'Image', msgMenu: 'Menu' })[key] || key,
    formatTextWithLinks: (node, text) => node.append(text),
    appendEmojiText: (node, text) => node.append(text),
    isJumboEmoji: text => text === '😀',
    buildVoicePlayer: () => element('voice-card'),
    notePreview() {}, scrollToLatest() {}, renderInfoPanel() {}, scheduleDateDividers() {}, paintReactionEvents() {},
    markMessageRemindedIfPending() {}, maybeAttachLinkPreview() {},
    buildReplyQuote: () => element('bubble-reply', 'Quoted message'),
    buildForwardLabel: () => element('bubble-forward', 'Forwarded from Original'),
    buildFileCard: () => element('file-card'), buildMessageButtons: () => element('bubble-buttons'),
    attachMessageActions(row, { text }) { row.messageText = text; },
    hoverQuickReactions: null,
    reactToMessage() {}, systemNote() {},
    Blob, URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:export'; } }, setTimeout() {},
    exitSelectionMode() {}, selectPeer: async () => {}, threadFor: () => thread,
    sendFrameReliably: async (_peer, frame) => { frames.push(frame); return true; },
    randomHex: () => 'forwarded', playSound() {},
    mediaDownloads: new Map(),
  };
  const names = [
    'isServiceAccount', 'appendMessageAuthor', 'layoutMessageMeta', 'renderMessageBody',
    'appendMessage', 'appendVoiceMessage', 'layoutImageMessage', 'sizeImagePreview', 'buildImagePreview',
    'markJumboEmoji', 'renderReactionButtons', 'setMark', 'markMessageEdited', 'markMessageReminded',
    'clearMessageReminded', 'tombstoneMessage', 'updateMessageText', 'emojiPlainText', 'exportHistory', 'forwardMessage',
    // The media-ref helpers the renderers and the forward path go through (inline attachments here).
    'isMediaRef', 'mediaSource', 'hasPicture', 'attachmentDataUrl', 'forgetMedia',
  ];
  const definitions = names.map(name => {
    const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}(?=\\n|$)`));
    assert.ok(found, name);
    return found[0];
  });
  vm.createContext(context);
  vm.runInContext(definitions.join('\n'), context);
  const append = options => {
    context.appendMessage(thread, { id: `m-${thread.seen.size}`, own: false, kind: 'human', author: 'Friend', text: 'Hello', ts: 1, ...options });
    return thread.node.children.at(-1);
  };
  return { context, thread, element, append, blobs, frames };
}

test('1:1 labels omit self and the peer, retaining AI/service/distinct authors and forward labels', () => {
  const h = load();
  assert.equal(h.append({ own: true, author: 'My Name' }).querySelector('.bubble-author'), null);
  for (const author of ['roman', 'Roman', 'Friend']) assert.equal(h.append({ author }).querySelector('.bubble-author'), null);
  for (const options of [{ kind: 'ai', author: 'Model' }, { author: 'Helper' }, { author: 'Different Author' }]) {
    assert.equal(h.append(options).querySelector('.bubble-author').textContent, `{${options.author}}`);
  }
  for (const peer of ['tailchat', 'tailik', 'another-bot']) {
    h.thread.peer = peer;
    assert.ok(h.append({ author: peer }).querySelector('.bubble-author'));
  }
  const forwarded = h.append({ own: true, forwardedFrom: { name: 'Original' } });
  assert.equal(forwarded.querySelector('.bubble-author'), null);
  assert.ok(forwarded.querySelector('.bubble-forward'));
  assert.equal(forwarded.dataset.author, 'Friend');
});

test('metadata spacer stays inline, inert and separate from real receipt state through every setter', () => {
  const h = load();
  const row = h.append({ own: true, author: 'My Name', text: 'First\nLast https://example.org/long' });
  const text = row.querySelector('.bubble-text');
  const mark = row.querySelector('.bubble-meta > .bubble-mark');
  const actual = row.querySelector('.bubble-meta');
  assert.equal(text.querySelector('.bubble-meta-spacer').attributes['aria-hidden'], 'true');
  assert.equal(text.querySelector('.bubble-meta-spacer').inert, true);
  assert.equal(row.querySelectorAll('.bubble-meta').length, 1);
  assert.equal(h.context.emojiPlainText(text), 'First\nLast https://example.org/long');
  for (const state of ['queued', 'sent', 'ack', 'read', 'failed']) {
    h.context.setMark(mark, state, 20, 'web');
    const spacer = text.querySelector('.bubble-meta-spacer');
    assert.equal(spacer.textContent, actual.textContent, state);
    assert.equal(spacer.querySelector('.bubble-mark').dataset.state, state);
    assert.equal(row.querySelectorAll('.bubble-meta-spacer').length, 1);
  }
  h.context.markMessageEdited(row, 30);
  h.context.markMessageReminded(row);
  assert.equal(text.querySelector('.bubble-meta-spacer').textContent, actual.textContent);
  h.context.clearMessageReminded(row);
  assert.equal(text.querySelector('.bubble-meta-spacer').textContent, actual.textContent);
  assert.equal(actual.querySelector('.bubble-reminded'), null);
  assert.equal(h.context.emojiPlainText(text), 'First\nLast https://example.org/long');
});

test('cards/buttons use a compact footer; reactions have an independent row and tombstones relayout', () => {
  const h = load();
  for (const options of [{ attachment: { url: 'blob:file' } }, { buttons: [{ label: 'Go' }] }]) {
    const row = h.append({ own: true, ...options, reactions: { '👍': ['roman'] } });
    const content = row.querySelector('.bubble-content');
    assert.ok(content.querySelector(':scope > .bubble-meta-spacer'));
    assert.equal(row.querySelector('.bubble-text').querySelector('.bubble-meta-spacer'), null);
    assert.equal(row.querySelector('.bubble-reactions').parentElement, row.querySelector('.bubble'));
    assert.equal(row.querySelector('.bubble-meta').querySelector('.bubble-reactions'), null);
    h.context.tombstoneMessage(h.thread, row);
    assert.equal(row.querySelector('.bubble-reactions'), null);
    assert.equal(row.querySelector('.bubble-meta > .bubble-mark'), null);
    assert.ok(row.querySelector('.bubble-text').querySelector('.bubble-meta-spacer'));
    assert.equal(h.context.emojiPlainText(row.querySelector('.bubble-text')), 'Deleted');
  }
  const voiceOptions = { id: 'voice', own: false, author: 'Friend', ts: 1, dataUrl: 'data:audio', duration: 1 };
  h.context.appendVoiceMessage(h.thread, voiceOptions);
  const voice = h.thread.node.children.at(-1);
  assert.equal(voice.querySelector('.bubble-author'), null);
  assert.ok(voice.querySelector('.bubble-content > .bubble-meta-spacer'));
  const row = h.append({ text: '😀', replyTo: { id: 'original' }, forwardedFrom: { name: 'Original' } });
  const card = h.element('link-preview');
  row.querySelector('.bubble-meta').before(card);
  h.context.layoutMessageMeta(row);
  assert.ok(row.querySelector('.bubble-content > .bubble-meta-spacer'));
  card.remove();
  h.context.layoutMessageMeta(row);
  assert.ok(row.querySelector('.bubble-text').querySelector('.bubble-meta-spacer'));
  const jumbo = h.append({ own: true, text: '😀' });
  assert.equal(jumbo.dataset.jumbo, 'true');
  assert.ok(jumbo.querySelector('.bubble-text').querySelector('.bubble-meta-spacer'));
  h.context.updateMessageText('roman', jumbo.dataset.id, 'Edited text', 30);
  assert.equal(jumbo.dataset.jumbo, undefined);
  assert.equal(h.context.emojiPlainText(jumbo.querySelector('.bubble-text')), 'Edited text');
  assert.equal(jumbo.querySelectorAll('.bubble-meta-spacer').length, 1);
});

test('images cap at 480 without enlargement and caption edits keep metadata/reactions in place', () => {
  const h = load();
  for (const [width, height, expected] of [[1600, 800, [480, 240]], [800, 1600, [240, 480]], [90, 60, [90, 60]]]) {
    const img = new Element('img');
    h.context.sizeImagePreview(img, width, height);
    assert.deepEqual([img.width, img.height], expected);
  }
  const row = h.append({ own: true, image: { dataUrl: 'data:image', width: 1600, height: 800 }, text: '[Image]', reactions: { '👍': ['roman'] } });
  assert.equal(row.dataset.image, 'bare');
  assert.equal(row.querySelector('.bubble-meta').parentElement, row.querySelector('.msg-image-frame'));
  assert.equal(row.querySelector('.bubble-meta-spacer'), null);
  const img = row.querySelector('.msg-image');
  img.naturalWidth = 90;
  img.naturalHeight = 60;
  img.handlers.load();
  assert.equal(row.querySelector('.bubble').style.getPropertyValue('--image-w'), '90px');
  h.context.layoutImageMessage(row, 'New caption');
  assert.equal(row.dataset.image, 'captioned');
  assert.ok(row.querySelector('.bubble-text').querySelector('.bubble-meta-spacer'));
  assert.equal(row.querySelector('.bubble-meta').parentElement, row.querySelector('.bubble-content'));
  assert.equal(row.querySelector('.bubble-reactions').parentElement, row.querySelector('.bubble'));
  h.context.layoutImageMessage(row, '[Image]');
  assert.equal(row.querySelector('.bubble-meta-spacer'), null);
  assert.equal(row.querySelector('.bubble-text'), null);
});

test('export and forward retain hidden authors and never include invisible metadata', async () => {
  const h = load();
  const row = h.append({ own: true, author: 'My Name', text: 'Actual text' });
  h.context.exportHistory();
  assert.match(await h.blobs[0].text(), /\[12:40\] <\{My Name\}> Actual text\n/);
  h.context.appendMessage = () => {};
  await h.context.forwardMessage([row], 'other', 'roman');
  assert.equal(h.frames[0].text, 'Actual text');
  assert.equal(h.frames[0].forwardedFrom.name, 'My Name');
  assert.equal(h.frames[0].forwardedFrom.login, 'me');
});
