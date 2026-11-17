// The cloud-web third participant. A terminal answers `/ai`/mentions with its
// own locally-configured model — the cloud web client has no such process and
// cannot hold a key of its own, so this module lets the cloud server answer on
// behalf of exactly one configured account (`ownerLogin`).
//
// It never talks to Gemini directly. `~/.tailik/gateway.mjs` already holds
// the one shared key, already speaks an OpenAI-chat-completions-shaped HTTP
// API on its Tailscale-bound address, and already keeps per-conversation
// context and restart/clear commands — duplicating a second direct-to-Gemini
// integration here would mean two places to keep in sync and a key that no
// longer lives in exactly one file. This module is a client of that gateway
// instead: it reuses `src/ai.js`'s `requestReply` transport (retries,
// timeout, abort) pointed at the gateway's URL. The gateway's own auth is a
// Tailscale-identity check (`tailscale whois` against `config.allowedLogin`),
// not a bearer token — the placeholder key below only satisfies
// `requestReply`'s "a key is configured" guard and is never inspected by the
// gateway. The cloud server process never holds the real Gemini key.
//
// Eligibility rides entirely on the existing friend graph: `hub.js`'s own
// `subscribe()` already refuses a conversation unless the two accounts are
// friends (or it is the owner's own Saved Messages), so "the owner's account
// or a verified friend of it" is just "one side of this conversation is the
// owner" — nothing else can reach this bridge in the first place.
import {
  AI_PROVIDERS, AI_THROTTLE_MS, AI_TURNS, DEFAULT_AI_NAME,
  buildRequest, mentionRegex, requestReply,
} from '../ai.js';
import { AI_LOGIN } from './ai-account.js';

const GATEWAY_PLACEHOLDER_KEY = 'tailik-gateway';

// «помолчи» must work as a plain instruction, so it is matched *before* the
// mention gate: a person telling the assistant to stop rarely repeats its
// name. To keep an ordinary human conversation from silencing it by accident
// («стоп» is a normal word between two people), the word only counts when it
// either carries the assistant's name or is the entire message.
const MUTE_MS = 15 * 60 * 1000;
const MUTE_WORDS = /(помолч|замолч|молчи|стоп|тише|заткн|be\s+quiet|shut\s+up|silence|\bstop\b)/iu;
const UNMUTE_WORDS = /(говори|отвечай|продолжай|speak|talk|resume|unmute)/iu;
const MUTE_ACK = 'Молчу 15 минут. Напишите «говори», чтобы вернуть меня раньше.';
const UNMUTE_ACK = 'Снова здесь.';

function isBareInstruction(text, pattern) {
  const bare = text.trim().replace(/[!.,…?)(»«"'-]/gu, ' ').trim();
  return bare !== '' && bare.split(/\s+/u).length <= 2 && pattern.test(bare);
}

// A single global gate, not one per conversation: the point is bounding how
// often the *shared* gateway gets called across every friend who might
// address the owner at once, to the same ~15/min a lone terminal session
// gets from its own free-tier key — a per-peer gate would let N friends
// multiply that by N.
export function createAiBridge({
  ownerLogin,
  store,
  gatewayUrl = process.env.TAILCHAT_CLOUD_AI_GATEWAY_URL || null,
  provider = 'gemini',
  aiName = DEFAULT_AI_NAME,
  throttleMs = AI_THROTTLE_MS,
  turnLimit = AI_TURNS,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  requestReplyImpl = requestReply,
} = {}) {
  const owner = String(ownerLogin ?? '').trim().toLowerCase();
  const mention = mentionRegex(aiName);
  const preset = AI_PROVIDERS[provider] ?? AI_PROVIDERS.gemini;
  let lastAnsweredAt = -Infinity;
  let inFlight = false;
  // Per-conversation quiet windows, keyed by the other party's login: silencing
  // the assistant in one chat must not silence it in every other one. In
  // memory only, like `lastAnsweredAt` — a 15-minute window is not worth a
  // write to the account store, and a cloud restart returning the assistant
  // to its default (answering) is the safe direction to fail.
  const mutedUntil = new Map();

  function enabled() {
    return Boolean(owner) && Boolean(gatewayUrl) && Boolean(store);
  }

  // The assistant's own conversation needs no owner and no mention: writing
  // to that contact *is* addressing it.
  function directEnabled() {
    return Boolean(gatewayUrl) && Boolean(store);
  }

  // A local, gateway-free answer: it costs no quota, so it neither consumes
  // the shared throttle window nor announces «печатает…» for a round trip
  // that never happens — it is already written. It still flows back through
  // the hub as a normal assistant frame, so both sides keep it in history.
  function ack(otherLogin, text, self = owner) {
    return { from: self, to: otherLogin, text, name: aiName };
  }

  // Called after a human message has already cleared the hub's own relay —
  // this never blocks or affects delivery of the message itself, and any
  // failure here (network, quota, a provider hiccup) is silently absorbed:
  // an unanswered mention degrades to silence, the same as an offline peer.
  async function maybeRespond({
    from, to, text, replyTo = null, isAiCapable = () => false, onAccepted = () => {},
  }) {
    if (typeof text !== 'string' || text === '') return null;

    // A message *to* the assistant's own account. `self` is whose name the
    // reply carries and whose thread the history comes from — the assistant
    // itself here, the owner in the classic third-participant case.
    const direct = to === AI_LOGIN && from !== AI_LOGIN;
    if (direct && !directEnabled()) return null;
    if (!direct) {
      if (!enabled()) return null;
      if (from !== owner && to !== owner) return null;
    }

    const self = direct ? AI_LOGIN : owner;
    const otherLogin = direct ? from : (from === owner ? to : from);
    if (!otherLogin || otherLogin === self) return null;

    // A connected terminal already claims AI ownership here — the owner's
    // own (a message sent from cloud-web self-syncs to it as an outgoing
    // question it answers unconditionally) or the other party's (mirroring
    // `shouldAutoReply`'s existing `peerHasAi` deference). Either way,
    // answering too would duplicate a reply that is already on its way — and
    // a quiet window over *this* bridge would mean nothing while another
    // process is the one answering. `otherLogin` is always "the human on the
    // other end of this exchange" — the friend in the classic third-party
    // mode, the sender itself in the direct thread — so it is checked in
    // both modes; `owner` is only meaningful (and only answering on someone
    // else's behalf) in the non-direct mode.
    if (isAiCapable(otherLogin) || (!direct && isAiCapable(owner))) return null;

    let isReplyToAiMessage = false;
    if (replyTo && typeof replyTo === 'object') {
      if (replyTo.author === aiName || replyTo.author === 'tailik') {
        isReplyToAiMessage = true;
      } else if (replyTo.id && typeof store.history === 'function') {
        const hist = store.history(self, otherLogin, 10);
        const ref = hist.find((m) => m.id === replyTo.id);
        if (ref && (ref.kind === 'ai' || ref.author === aiName || ref.author === 'tailik')) {
          isReplyToAiMessage = true;
        }
      }
    }

    // In the assistant's own thread every message is addressed to it.
    const addressed = direct || mention.test(text) || isReplyToAiMessage;
    const quietNow = (mutedUntil.get(otherLogin) ?? 0) > now();
    const wantsQuiet = MUTE_WORDS.test(text) && (addressed || isBareInstruction(text, MUTE_WORDS));
    const wantsVoice = UNMUTE_WORDS.test(text) && (addressed || isBareInstruction(text, UNMUTE_WORDS));

    // «говори» wins over «стоп» in the same breath: the later instruction in a
    // sentence like «стоп, нет, говори» is the one a person means.
    if (wantsVoice) {
      mutedUntil.delete(otherLogin);
      if (quietNow) return ack(otherLogin, UNMUTE_ACK, self);
    } else if (wantsQuiet) {
      mutedUntil.set(otherLogin, now() + MUTE_MS);
      // Repeating it inside an existing window stays silent — acknowledging a
      // request for silence twice is the opposite of obeying it.
      return quietNow ? null : ack(otherLogin, MUTE_ACK, self);
    }

    if (quietNow) return null;
    if (!addressed) return null;
    if (inFlight || now() - lastAnsweredAt < throttleMs) return null;

    inFlight = true;
    lastAnsweredAt = now();
    // Every reason to decline is now behind us, so this is the first moment it
    // is honest to tell the asker that an answer is being written. Declining
    // quietly, above, must never produce a «печатает…» that resolves to
    // nothing.
    try {
      onAccepted();
    } catch {
      // The caller's bookkeeping is not worth losing an answer over.
    }
    try {
      const people = new Map(store.users().map((u) => [u.login, u.name || u.login]));
      const ownerName = direct ? aiName : (people.get(owner) || owner);
      const otherName = people.get(otherLogin) || otherLogin;

      const recent = store.history(self, otherLogin, turnLimit);
      // In the direct thread the assistant's own past messages are ordinary
      // records from `AI_LOGIN`, not `kind: 'ai'` frames sent by a human.
      const turns = recent.map((item) => ({
        kind: (item.kind === 'ai' || (direct && item.from === AI_LOGIN)) ? 'ai' : 'human',
        author: (item.kind === 'ai' || (direct && item.from === AI_LOGIN))
          ? (item.author || aiName)
          : (item.from === self ? ownerName : otherName),
        text: item.text,
      }));

      const { system, messages } = buildRequest({
        turns, aiName, selfName: ownerName, peerName: otherName,
      });
      const result = await requestReplyImpl({
        resolved: {
          key: GATEWAY_PLACEHOLDER_KEY, url: gatewayUrl, model: preset.model, name: aiName,
        },
        system,
        messages,
        humanNames: [ownerName, otherName],
        fetchImpl,
      }).catch(() => ({ ok: false, reason: 'network' }));

      if (!result?.ok || result.text === '') return null;
      // `from` is the owner because that is whose friendship and whose quota
      // carries the reply, but the *author* is the model. Both sides need the
      // name on the frame: without it, a client that sees `from === owner` has
      // nothing left to tell the two apart.
      return {
        from: self, to: otherLogin, text: result.text, name: aiName,
      };
    } finally {
      inFlight = false;
    }
  }

  // Read by the hub when it announces «печатает…» on the bridge's behalf: the
  // frame has to be signed with the same name the answer will carry.
  return { maybeRespond, enabled, directEnabled, name: aiName };
}
