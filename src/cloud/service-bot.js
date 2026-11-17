// What `{tailchat}` answers.
//
// The service account used to be a one-way pipe: it could announce a release
// and nothing else, and `ensureServiceAccount` says as much — «This account
// only ever sends». Anything a person typed into that thread was recorded and
// read by nobody. This module is the other direction, and it is deliberately
// the *only* thing that decides what the account says.
//
// Two properties are worth keeping while changing it:
//
//   * It never speaks first. Every message below is an answer to a message
//     from the person it is sent to, or to an action that person's contact
//     just took (a friend request). Releases stay silent — see AGENTS.md §9,
//     and note that nothing here knows the deployment's version.
//   * It knows nothing about sockets, queues or the hub. `handle` is a
//     function of «кто написал и что», answering with plain messages; the hub
//     delivers them through `sendServiceMessage`, which is the one door the
//     server itself speaks through.
//
// The buttons are the existing per-message `buttons` rail (`normalizeButtons`
// in hub.js/accounts.js), which both clients already render — the web in
// `buildMessageButtons`, Android in `MessageInlineButtons`. Pressing one sends
// its `value` back as an ordinary message, so every button below is just a
// command a person could also type.
const BUG_WINDOW_MS = 60 * 60 * 1000;
const BUG_LIMIT_PER_WINDOW = 3;
// How long «опишите проблему» waits for the description. Short enough that a
// message typed an hour later is read as a new question rather than swallowed
// as a bug report, long enough to actually write one.
const BUG_PROMPT_TTL_MS = 15 * 60 * 1000;
const BUG_TEXT_MIN = 10;

// One deterministic id for the welcome, so a second delivery of the same
// menu — a retried registration, a caller that forgot it already ran — is the
// same record in the conversation rather than a second one.
const SERVICE_MENU_ID = 'service-menu-v1';

const TEXT = {
  ru: {
    menu: 'Служебный аккаунт Tailchat: помощь, заявки в друзья и сообщения об ошибках.',
    help: [
      'Что здесь можно:',
      '• Добавить друга — по @username, из списка контактов («+» вверху).',
      '• Сообщить об ошибке — нажмите кнопку и опишите, что пошло не так.',
      '• Заявки в друзья приходят сюда: их видно как сообщение с кнопками.',
      'Сам аккаунт не читает ничего, кроме этих команд.',
    ].join('\n'),
    helpButton: 'Помощь',
    bugButton: 'Сообщить об ошибке',
    friendButton: 'Добавить друга',
    friendHow: 'Добавить друга: «+» в списке контактов, затем @username. '
      + 'Ему придёт заявка сюда же, и он ответит кнопкой.',
    bugPrompt: 'Опишите одним сообщением, что пошло не так: что вы делали и что увидели.',
    bugTooShort: 'Слишком коротко — напишите хотя бы пару фраз, иначе по этому нечего искать.',
    bugSent: (url) => `Спасибо. Записал: ${url}`,
    bugSentNoTracker: 'Спасибо. Трекер здесь не настроен — передал владельцу.',
    bugFailed: 'Не получилось записать в трекер. Передал владельцу.',
    bugLimit: 'Слишком много сообщений подряд. Следующее — через час.',
    bugForward: (login, text) => `Сообщение об ошибке от @${login}:\n\n${text}`,
    requestIncoming: (name, login) => `${name} (@${login}) хочет добавить вас в друзья.`,
    accept: 'Принять',
    decline: 'Отклонить',
    accepted: (name, login) => `${name} (@${login}) теперь у вас в контактах.`,
    acceptedByPeer: (name, login) => `${name} (@${login}) принял вашу заявку.`,
    declined: 'Заявка отклонена.',
    requestGone: 'Эта заявка уже отвечена.',
  },
  en: {
    menu: 'Tailchat service account: help, friend requests and bug reports.',
    help: [
      'What lives here:',
      '• Add a friend — by @username, from the contact list ("+" at the top).',
      '• Report a bug — tap the button and describe what went wrong.',
      '• Friend requests arrive here as a message with buttons.',
      'The account itself reads nothing but these commands.',
    ].join('\n'),
    helpButton: 'Help',
    bugButton: 'Report a bug',
    friendButton: 'Add a friend',
    friendHow: 'To add a friend: "+" in the contact list, then @username. '
      + 'The request lands in their own {tailchat} thread, and they answer with a button.',
    bugPrompt: 'Describe in one message what went wrong: what you did and what you saw.',
    bugTooShort: 'Too short — a couple of sentences, or there is nothing to look for.',
    bugSent: (url) => `Thanks. Filed: ${url}`,
    bugSentNoTracker: 'Thanks. No tracker is configured here — passed to the owner.',
    bugFailed: 'Could not reach the tracker. Passed to the owner.',
    bugLimit: 'Too many reports in a row. The next one in an hour.',
    bugForward: (login, text) => `Bug report from @${login}:\n\n${text}`,
    requestIncoming: (name, login) => `${name} (@${login}) wants to add you as a friend.`,
    accept: 'Accept',
    decline: 'Decline',
    accepted: (name, login) => `${name} (@${login}) is in your contacts now.`,
    acceptedByPeer: (name, login) => `${name} (@${login}) accepted your request.`,
    declined: 'Request declined.',
    requestGone: 'That request has already been answered.',
  },
};

function stripAt(value) {
  return String(value ?? '').trim().replace(/^@+/u, '').toLowerCase();
}

export function createServiceBot({
  store,
  // `{ report({ text, login }) }` — see `github-issues.js`. `null` is a
  // deployment with no tracker configured, which is a state the person is
  // told about rather than a crash.
  issues = null,
  // Where a report goes when there is no tracker, or when the tracker refused
  // it. The owner is a real account on this deployment, so «передал владельцу»
  // is a message like any other — and the report is never silently dropped.
  ownerLogin = null,
  now = Date.now,
} = {}) {
  if (!store) throw new TypeError('createServiceBot requires store');
  const owner = stripAt(ownerLogin);
  // Both in memory on purpose: a pending «describe the bug» prompt and a
  // report counter are worth exactly one process lifetime. Losing them on a
  // restart costs a person one extra tap on the button.
  const awaitingBug = new Map();
  const bugTimes = new Map();

  function langOf(login) {
    const lang = typeof store.langOf === 'function' ? store.langOf(login) : null;
    return TEXT[lang] ? lang : 'ru';
  }

  function nameOf(login) {
    const name = typeof store.nameOf === 'function' ? store.nameOf(login) : null;
    return name && name !== '' ? name : login;
  }

  function menuButtons(t) {
    return [
      { id: 'help', label: t.helpButton, value: '/help' },
      { id: 'bug', label: t.bugButton, value: '/bug' },
      { id: 'friend', label: t.friendButton, value: '/friend' },
    ];
  }

  /**
   * The one message the account writes without being asked. Every other text
   * above answers something the person did; this one answers the blank screen
   * a brand-new account used to open `{tailchat}` to — no message, no button,
   * and so no way to discover the menu that `handle` hands out on request.
   *
   * Still not a broadcast: `server.js` calls it once, for one login, at
   * registration, and only while that thread has never been written to.
   * Releases stay silent (AGENTS.md §9) and nothing here knows the version.
   */
  function welcome(login) {
    const target = stripAt(login);
    if (target === '') return [];
    const t = TEXT[langOf(target)];
    return [{ to: target, id: SERVICE_MENU_ID, text: t.menu, buttons: menuButtons(t) }];
  }

  /** The message a fresh request puts in the recipient's `{tailchat}` thread. */
  function friendRequested({ from, to }) {
    const asker = stripAt(from);
    const target = stripAt(to);
    if (asker === '' || target === '' || asker === target) return [];
    const t = TEXT[langOf(target)];
    return [{
      to: target,
      text: t.requestIncoming(nameOf(asker), asker),
      buttons: [
        { id: 'friend-accept', label: t.accept, value: `/friend accept ${asker}` },
        { id: 'friend-decline', label: t.decline, value: `/friend decline ${asker}` },
      ],
    }];
  }

  function answerFriend(from, t, rest) {
    const [verb, rawLogin] = rest;
    const peer = stripAt(rawLogin);
    if ((verb !== 'accept' && verb !== 'decline') || peer === '') {
      return [{ to: from, text: t.friendHow, buttons: menuButtons(t) }];
    }
    const result = store.answerFriendRequest(from, peer, verb === 'accept');
    if (!result.ok) return [{ to: from, text: t.requestGone }];
    if (!result.accepted) return [{ to: from, text: t.declined }];

    const peerText = TEXT[langOf(peer)];
    // `roster: true` is the one thing these messages say that is not text: a
    // friendship just came into being, and every connected client of both
    // accounts is holding a roster that no longer matches the server. The
    // HTTP paths (`/invite/accept`, `/friend/request`) broadcast it
    // themselves; a button pressed in a conversation has no HTTP handler to
    // do it, and without this the new contact only appeared after a
    // reconnect.
    return [
      { to: from, text: t.accepted(result.friend.name, result.friend.login), roster: true },
      // The asker learns the answer the same way they would learn anything
      // else on this deployment: as a message in the thread that asked.
      { to: peer, text: peerText.acceptedByPeer(nameOf(from), from), roster: true },
    ];
  }

  function bugAllowed(login) {
    const at = now();
    const recent = (bugTimes.get(login) ?? []).filter((stamp) => at - stamp < BUG_WINDOW_MS);
    bugTimes.set(login, recent);
    return recent.length < BUG_LIMIT_PER_WINDOW;
  }

  function noteBug(login) {
    const recent = bugTimes.get(login) ?? [];
    recent.push(now());
    bugTimes.set(login, recent);
  }

  async function submitBug(from, t, text) {
    if (!bugAllowed(from)) return [{ to: from, text: t.bugLimit }];
    if (text.trim().length < BUG_TEXT_MIN) return [{ to: from, text: t.bugTooShort }];
    noteBug(from);

    const forward = owner && owner !== from
      ? [{ to: owner, text: TEXT[langOf(owner)].bugForward(from, text.trim()) }]
      : [];

    if (!issues) {
      return [{ to: from, text: t.bugSentNoTracker }, ...forward];
    }
    try {
      const filed = await issues.report({ text: text.trim(), login: from });
      // The URL is the receipt: a report the person cannot follow is
      // indistinguishable from one that went nowhere.
      return [{ to: from, text: t.bugSent(filed.url) }];
    } catch {
      return [{ to: from, text: t.bugFailed }, ...forward];
    }
  }

  return {
    friendRequested,
    welcome,
    /**
     * One inbound message, answered. Never throws: the hub calls this after
     * the person's own message is already committed, and a handler that threw
     * would only be a lost answer — so every refusal below is a sentence, not
     * an exception.
     */
    async handle({ from, text } = {}) {
      const login = stripAt(from);
      const body = String(text ?? '');
      if (login === '' || body.trim() === '') return [];
      const t = TEXT[langOf(login)];

      const parts = body.trim().split(/\s+/u);
      const command = parts[0].toLowerCase();

      // A pending prompt wins over the «unknown text → menu» fallback, and
      // only over that: a person who taps another button mid-report has
      // changed their mind, and the report is dropped with it.
      const promptedAt = awaitingBug.get(login);
      if (promptedAt !== undefined && !command.startsWith('/')) {
        awaitingBug.delete(login);
        if (now() - promptedAt <= BUG_PROMPT_TTL_MS) return submitBug(login, t, body);
      }
      if (command.startsWith('/')) awaitingBug.delete(login);

      switch (command) {
        case '/help':
          return [{ to: login, text: t.help, buttons: menuButtons(t) }];
        case '/friend':
          return answerFriend(login, t, parts.slice(1).map((part) => part.toLowerCase()));
        case '/bug': {
          const rest = body.trim().slice(command.length).trim();
          if (rest !== '') return submitBug(login, t, rest);
          awaitingBug.set(login, now());
          return [{ to: login, text: t.bugPrompt }];
        }
        default:
          // Everything else — «/start», «привет», a tap on nothing in
          // particular — is somebody looking for what this account can do.
          return [{ to: login, text: t.menu, buttons: menuButtons(t) }];
      }
    },
  };
}
