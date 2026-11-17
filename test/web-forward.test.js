import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Reproduces the race `forwardMessage` used to lose: `selectPeer(peer)`
// resolving is not proof the server has acked the `subscribe` request yet,
// and `sendFrame` refuses to relay to a peer it isn't (yet) subscribed to.
// Forwarding to any contact other than the open conversation therefore
// failed silently almost every time. `waitForSubscription`/
// `sendFrameReliably` fix it by waiting for the actual ack (or a bounded
// timeout) before giving up. Extracted verbatim from web/cloud/app.js, the
// same way test/cloud-ping.test.js checks its pong matcher, since app.js is
// a bundler-less browser script with no module boundary to import.
function loadForwardHelpers() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const waiters = source.match(/const subscriptionWaiters = new Map\(\);.*$/m);
  const waitFor = source.match(/function waitForSubscription\(peer, timeoutMs = 4000\) \{[\s\S]*?\n\}/);
  const reliably = source.match(/async function sendFrameReliably\(to, frame\) \{[\s\S]*?\n\}/);
  assert.ok(waiters, 'subscriptionWaiters state exists');
  assert.ok(waitFor, 'waitForSubscription exists');
  assert.ok(reliably, 'sendFrameReliably exists');

  const context = {
    subscribedPeer: null,
    sendFrame: null, // set per-test
    setTimeout,
    Promise,
    Map,
    Set,
  };
  vm.createContext(context);
  vm.runInContext(
    `${waiters[0]}\n${waitFor[0]}\n${reliably[0]}\nglobalThis.waitForSubscription = waitForSubscription;\nglobalThis.sendFrameReliably = sendFrameReliably;\nglobalThis.subscriptionWaiters = subscriptionWaiters;`,
    context,
  );
  return context;
}

test('sendFrameReliably retries once the subscribe ack lands, instead of failing silently', async () => {
  const ctx = loadForwardHelpers();
  let attempts = 0;
  ctx.sendFrame = (to) => {
    attempts += 1;
    // First attempt races the ack and loses, exactly like the live bug.
    return ctx.subscribedPeer === to;
  };

  const sendPromise = ctx.sendFrameReliably('boris', { t: 'msg', text: 'hi' });
  // The ack arrives a tick later — simulates the server's `{k:'subscribed'}`
  // frame landing after `selectPeer` has already resolved.
  await new Promise((resolve) => setTimeout(resolve, 10));
  ctx.subscribedPeer = 'boris';
  const waiters = ctx.subscriptionWaiters.get('boris');
  assert.ok(waiters && waiters.size > 0, 'a waiter was registered for the peer being subscribed to');
  for (const settle of [...waiters]) settle(true);

  assert.equal(await sendPromise, true, 'the forward succeeds once the ack is simulated');
  assert.equal(attempts, 2, 'one failed attempt, one retry after the ack');
});

test('sendFrameReliably gives up without hanging when no ack ever arrives', async () => {
  const ctx = loadForwardHelpers();
  ctx.sendFrame = () => false;
  const ok = await ctx.waitForSubscription('carl', 30);
  assert.equal(ok, false, 'a peer that never acks resolves false, not a hang');
});

test('sendFrameReliably sends immediately when already subscribed (same-conversation forward)', async () => {
  const ctx = loadForwardHelpers();
  ctx.subscribedPeer = 'boris';
  let attempts = 0;
  ctx.sendFrame = (to) => { attempts += 1; return ctx.subscribedPeer === to; };
  assert.equal(await ctx.sendFrameReliably('boris', { t: 'msg', text: 'hi' }), true);
  assert.equal(attempts, 1, 'no wasted wait when the subscription is already live');
});
