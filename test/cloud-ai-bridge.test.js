import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiBridge } from '../src/cloud/ai-bridge.js';

function fakeStore({ users = [], history = [] } = {}) {
  return {
    users: () => users,
    history: () => history,
  };
}

function bridge(overrides = {}) {
  const calls = [];
  const requestReplyImpl = overrides.requestReplyImpl ?? (async (args) => {
    calls.push(args);
    return { ok: true, text: 'Привет!' };
  });
  const bridgeInstance = createAiBridge({
    ownerLogin: 'roman',
    gatewayUrl: 'http://100.64.0.1:4748/v1/chat/completions',
    now: overrides.now ?? (() => 1000),
    store: overrides.store ?? fakeStore({
      users: [{ login: 'roman', name: 'Roman' }, { login: 'ella', name: 'Ella' }],
      history: [],
    }),
    requestReplyImpl,
    ...overrides,
  });
  return { bridgeInstance, calls };
}

// The assistant as a contact: no owner, no mention needed — writing to that
// thread is addressing it directly, and the reply comes *from* it. (Whether
// the bridge defers to an already-answering terminal of the sender's own is
// covered separately below — this test's sender has no such terminal.)
test('a message to the assistant account is answered by the assistant itself', async () => {
  const { bridgeInstance } = bridge({ ownerLogin: '' });
  const reply = await bridgeInstance.maybeRespond({
    from: 'ella',
    to: 'tailik',
    text: 'сколько будет два плюс два',
  });
  assert.deepEqual(reply, {
    from: 'tailik', to: 'ella', text: 'Привет!', name: 'tailik',
  });
});

test('the assistant thread still honours «помолчи» and answers nobody else', async () => {
  const { bridgeInstance } = bridge({ ownerLogin: '' });
  const quiet = await bridgeInstance.maybeRespond({ from: 'ella', to: 'tailik', text: 'помолчи' });
  assert.equal(quiet.from, 'tailik');
  assert.equal(await bridgeInstance.maybeRespond({ from: 'ella', to: 'tailik', text: 'а теперь ответь' }), null);
  // Without an owner configured, an ordinary conversation is not the bridge's
  // business at all.
  assert.equal(await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'tailik привет' }), null);
});

test('with no gateway URL configured the bridge answers nothing and never calls out', async () => {
  const calls = [];
  const bridgeInstance = createAiBridge({
    ownerLogin: 'roman',
    gatewayUrl: null,
    store: fakeStore({ users: [{ login: 'roman', name: 'Roman' }] }),
    requestReplyImpl: async (args) => { calls.push(args); return { ok: true, text: 'nope' }; },
  });
  assert.equal(bridgeInstance.enabled(), false);
  assert.equal(await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, hi' }), null);
  assert.equal(calls.length, 0);
});

test('with no owner login configured the bridge is disabled even with a gateway URL', () => {
  const bridgeInstance = createAiBridge({
    ownerLogin: '',
    gatewayUrl: 'http://100.64.0.1:4748/v1/chat/completions',
    store: fakeStore(),
  });
  assert.equal(bridgeInstance.enabled(), false);
});

test('a message not addressed to the assistant gets no reply', async () => {
  const { bridgeInstance, calls } = bridge();
  const reply = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'hi there' });
  assert.equal(reply, null);
  assert.equal(calls.length, 0);
});

test('a conversation neither side of which is the owner is never answered', async () => {
  const { bridgeInstance, calls } = bridge();
  const reply = await bridgeInstance.maybeRespond({ from: 'ella', to: 'someone-else', text: 'tailik, hi' });
  assert.equal(reply, null);
  assert.equal(calls.length, 0);
});

test('the owner asking their own peer for tailik gets answered, from the owner to the peer', async () => {
  const { bridgeInstance, calls } = bridge();
  const reply = await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, hi' });
  assert.deepEqual(reply, {
    from: 'roman', to: 'ella', text: 'Привет!', name: 'tailik',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resolved.url, 'http://100.64.0.1:4748/v1/chat/completions');
});

test('the request carries a fixed placeholder key, never a real secret pulled from the environment', async () => {
  const { bridgeInstance, calls } = bridge();
  await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, hi' });
  assert.equal(calls.length, 1);
  // `requestReply` requires a truthy `resolved.key` to proceed at all; the
  // gateway itself authorises by Tailscale identity and never reads this
  // header, so the same fixed string is sent on every call — not the
  // account's own token, not an env var, not anything request-specific.
  assert.equal(calls[0].resolved.key, 'tailik-gateway');
});

test('a friend addressing tailik in a conversation with the owner is answered too', async () => {
  const { bridgeInstance, calls } = bridge();
  const reply = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'tailik, hi' });
  assert.deepEqual(reply, {
    from: 'roman', to: 'ella', text: 'Привет!', name: 'tailik',
  });
  assert.equal(calls.length, 1);
});

test('defers when a connected terminal of the owner already claims AI ownership', async () => {
  const { bridgeInstance, calls } = bridge();
  const reply = await bridgeInstance.maybeRespond({
    from: 'roman', to: 'ella', text: 'tailik, hi', isAiCapable: (login) => login === 'roman',
  });
  assert.equal(reply, null, 'the owner\'s own terminal will answer this via sync-outgoing');
  assert.equal(calls.length, 0);
});

test('defers when the other party already claims AI ownership, mirroring peerHasAi', async () => {
  const { bridgeInstance, calls } = bridge();
  const reply = await bridgeInstance.maybeRespond({
    from: 'ella', to: 'roman', text: 'tailik, hi', isAiCapable: (login) => login === 'ella',
  });
  assert.equal(reply, null, 'ella\'s own client already owns answering its own message');
  assert.equal(calls.length, 0);
});

// Bug report: "тайлик" answered the same message twice — once from the
// bridge, once from the sender's own already-connected AI-capable terminal
// (self-synced the human's own outgoing message to `AI_LOGIN`, same as
// `shouldAutoReply` on the client side). The deference above only fired for
// the classic third-party relay (`!direct`); the assistant's own dedicated
// thread — the one place a sender's own terminal is *most* likely to be
// watching — was never checked at all.
test('defers in the assistant\'s own direct thread when the sender\'s own terminal already claims AI ownership', async () => {
  const { bridgeInstance, calls } = bridge({ ownerLogin: '' });
  const reply = await bridgeInstance.maybeRespond({
    from: 'ella', to: 'tailik', text: 'привет', isAiCapable: (login) => login === 'ella',
  });
  assert.equal(reply, null, 'ella\'s own connected terminal will answer this via sync-outgoing');
  assert.equal(calls.length, 0);
});

test('with no isAiCapable supplied at all, the bridge still answers (backward compatible default)', async () => {
  const { bridgeInstance } = bridge();
  assert.notEqual(await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, hi' }), null);
});

test('capability checks do not consume the throttle window', async () => {
  let clock = 1000;
  const { bridgeInstance, calls } = bridge({ now: () => clock });
  const declined = await bridgeInstance.maybeRespond({
    from: 'roman', to: 'ella', text: 'tailik, hi', isAiCapable: () => true,
  });
  assert.equal(declined, null);
  const answered = await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, still there?' });
  assert.notEqual(answered, null, 'a decline must not have started the throttle clock');
  assert.equal(calls.length, 1);
});

test('the Russian aliases (тайлик/тэйлик) address the assistant the same way the terminal accepts', async () => {
  const { bridgeInstance } = bridge();
  assert.notEqual(await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'тайлик, привет' }), null);
});

test('a second mention inside the throttle window is silently skipped, not queued', async () => {
  let clock = 1000;
  const { bridgeInstance, calls } = bridge({ now: () => clock, throttleMs: 4000 });
  const first = await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, one' });
  assert.notEqual(first, null);
  clock += 1000; // still inside the 4s window
  const second = await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, two' });
  assert.equal(second, null);
  assert.equal(calls.length, 1, 'the gateway is called once, not twice');

  clock += 4000; // now past the window
  const third = await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, three' });
  assert.notEqual(third, null);
  assert.equal(calls.length, 2);
});

test('a gateway failure answers nothing rather than throwing', async () => {
  const { bridgeInstance } = bridge({
    requestReplyImpl: async () => ({ ok: false, reason: 'http 403' }),
  });
  const reply = await bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, hi' });
  assert.equal(reply, null);
});

test('a rejected requestReplyImpl promise is absorbed, not thrown', async () => {
  const { bridgeInstance } = bridge({
    requestReplyImpl: async () => { throw new Error('network exploded'); },
  });
  await assert.doesNotReject(bridgeInstance.maybeRespond({ from: 'roman', to: 'ella', text: 'tailik, hi' }));
});

test('recent cloud history is threaded into the request as prior turns', async () => {
  const { bridgeInstance, calls } = bridge({
    store: fakeStore({
      users: [{ login: 'roman', name: 'Roman' }, { login: 'ella', name: 'Ella' }],
      history: [
        { from: 'ella', text: 'earlier question', kind: 'human', ts: 1 },
        { from: 'roman', text: 'earlier answer', kind: 'ai', author: 'tailik', ts: 2 },
      ],
    }),
  });
  await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'tailik, follow up' });
  assert.equal(calls.length, 1);
  const roles = calls[0].messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
  assert.match(calls[0].messages[0].content, /earlier question/);
});

test('«помолчи» silences the assistant for 15 minutes and says so once', async () => {
  let clock = 1000;
  const { bridgeInstance, calls } = bridge({ now: () => clock });

  const ack = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'помолчи' });
  assert.equal(ack.to, 'ella');
  assert.match(ack.text, /15 минут/);
  assert.equal(ack.name, 'tailik');
  // Local answer: no gateway call, no quota spent.
  assert.equal(calls.length, 0);

  clock += 1000;
  assert.equal(await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'тайлик, ты тут?' }), null);
  assert.equal(calls.length, 0);

  // A repeat inside the window is obeyed, not acknowledged again.
  clock += 1000;
  assert.equal(await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'замолчи' }), null);

  clock += 15 * 60 * 1000;
  const reply = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'тайлик, ты тут?' });
  assert.equal(reply.text, 'Привет!');
  assert.equal(calls.length, 1);
});

test('«говори» ends the quiet window early and answers again', async () => {
  let clock = 1000;
  const { bridgeInstance } = bridge({ now: () => clock });
  await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'стоп' });

  clock += 1000;
  const back = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'говори' });
  assert.match(back.text, /Снова/);

  clock += 1000;
  const reply = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'тайлик, привет' });
  assert.equal(reply.text, 'Привет!');
});

test('«говори» when nothing was muted is not answered at all', async () => {
  const { bridgeInstance, calls } = bridge();
  assert.equal(await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'говори' }), null);
  assert.equal(calls.length, 0);
});

test('a quiet window covers one conversation, not every contact', async () => {
  let clock = 1000;
  const { bridgeInstance } = bridge({
    now: () => clock,
    store: fakeStore({
      users: [
        { login: 'roman', name: 'Roman' },
        { login: 'ella', name: 'Ella' },
        { login: 'kirill', name: 'Kirill' },
      ],
    }),
  });
  await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'тайлик, помолчи' });

  clock += 5000;
  assert.equal(await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'тайлик?' }), null);
  const other = await bridgeInstance.maybeRespond({ from: 'kirill', to: 'roman', text: 'тайлик?' });
  assert.equal(other.to, 'kirill');
});

test('«стоп» inside a longer human sentence does not silence the assistant', async () => {
  const { bridgeInstance } = bridge();
  assert.equal(
    await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'мы дошли до стоп-линии и повернули' }),
    null,
  );
  const reply = await bridgeInstance.maybeRespond({ from: 'ella', to: 'roman', text: 'тайлик, привет' });
  assert.equal(reply.text, 'Привет!');
});

test('a reply to an AI message addresses the assistant even without mentioning its name', async () => {
  let clock = 1000;
  const { bridgeInstance } = bridge({
    now: () => clock,
    store: fakeStore({
      users: [{ login: 'roman', name: 'Roman' }, { login: 'ella', name: 'Ella' }],
      history: [{ id: 'm-1', kind: 'ai', author: 'tailik', text: 'Как дела?' }],
    }),
  });
  const replyByAuthor = await bridgeInstance.maybeRespond({
    from: 'ella',
    to: 'roman',
    text: 'Хорошо, а у тебя?',
    replyTo: { id: 'm-1', author: 'tailik', text: 'Как дела?' },
  });
  assert.equal(replyByAuthor.text, 'Привет!');

  clock += 10000;
  const replyByIdLookup = await bridgeInstance.maybeRespond({
    from: 'ella',
    to: 'roman',
    text: 'Что нового?',
    replyTo: { id: 'm-1', text: 'Как дела?' },
  });
  assert.equal(replyByIdLookup.text, 'Привет!');
});
