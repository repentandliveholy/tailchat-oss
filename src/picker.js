import readline from 'node:readline';

// `tailchat` with no argument used to be a dead end: "peer address required".
// But the roster already knows who you have talked to, so the client can offer
// that list instead of a usage error.
//
// The dot is deliberately modest. The local daemon knows whether a DEVICE is up
// in the tailnet; it cannot know whether tailchat runs there. Claiming "online"
// would be the same lie as a ✓✓ without proof of focus, so the legend says
// "device", and a person we cannot judge gets `?` rather than a guess.

export const ONLINE = 'online';
export const OFFLINE = 'offline';
export const UNKNOWN = 'unknown';

// Pure: the roster plus an optional tailnet status becomes a ranked, labelled
// list. Online first — that is who you can actually reach this second — and
// alphabetically inside each group so the numbering does not dance between runs.
export function rosterChoices({ selectors = [], status = null } = {}) {
  const liveness = new Map();
  if (status) {
    for (const peer of status.peers ?? []) {
      // A sharee placeholder is not a machine anyone can dial.
      if (!peer.login || peer.sharee) continue;
      liveness.set(peer.login, (liveness.get(peer.login) ?? false) || peer.online === true);
    }
  }
  const rank = { [ONLINE]: 0, [UNKNOWN]: 1, [OFFLINE]: 2 };
  return selectors
    .filter((entry) => entry?.login)
    .map((entry) => {
      // Absent from the status is not the same as offline: a shared-in node or a
      // person outside this tailnet simply cannot be judged from here.
      const known = status ? liveness.get(entry.login) : undefined;
      return {
        login: entry.login,
        state: known === undefined ? UNKNOWN : (known ? ONLINE : OFFLINE),
        devices: Array.isArray(entry.devices) ? entry.devices.slice(0, 3) : [],
      };
    })
    .sort((a, b) => (rank[a.state] - rank[b.state]) || a.login.localeCompare(b.login));
}

const MARK = { [ONLINE]: '●', [OFFLINE]: '○', [UNKNOWN]: '?' };

// Plain text, not blessed: this runs before the TUI takes the terminal, so the
// two never fight over it.
export function renderChoices(choices, t) {
  const width = Math.max(0, ...choices.map((c) => c.login.length));
  const lines = [t('pick.title'), ''];
  choices.forEach((choice, i) => {
    const badge = choice.badge || (choice.type === 'lan' ? '📡 [lan]' : choice.type === 'cloud' ? '🌐 [cloud]' : choice.type === 'tailnet' ? '⚡ [tailnet]' : '');
    const blockedBadge = choice.blocked ? `🚫 ${t ? t('pick.blocked') : 'blocked'} ` : '';
    const label = `${blockedBadge}${badge ? `${badge} ` : ''}${MARK[choice.state] || '●'} ${t ? t(`pick.${choice.state}`) : choice.state}`;
    const devices = choice.devices && choice.devices.length ? `  ${choice.devices.join(', ')}` : '';
    lines.push(`  ${String(i + 1).padStart(2)}  ${choice.login.padEnd(width)}  ${label}${devices}`);
  });
  lines.push('', t('pick.legend'), '');
  return lines;
}

// The same two-column rows the in-app command menu eats: a login and a status.
// Both the startup menu and /peer render these with the app's own list markup,
// so the look cannot drift apart.
export function peerMenuRows(choices, t) {
  return choices.map((choice) => {
    const badge = choice.badge || (choice.type === 'lan' ? '📡 [lan]' : choice.type === 'cloud' ? '🌐 [cloud]' : choice.type === 'tailnet' ? '⚡ [tailnet]' : '');
    const stateLabel = t ? t(`pick.${choice.state}`) : choice.state;
    const mark = MARK[choice.state];
    const statusPart = mark ? `${mark} ${stateLabel}` : stateLabel;
    const blockedPart = choice.blocked ? `🚫 ${t ? t('pick.blocked') : 'blocked'}` : '';
    const parts = [badge, blockedPart, statusPart, ...(choice.devices || [])].filter(Boolean);
    return {
      name: choice.login,
      help: parts.join(' — '),
    };
  });
}


// Returns the chosen login, or null when the person cancelled or the input ended.
// A bad number is worth another try rather than a restart, but an empty line
// always means "no".
export function readChoice(choices, {
  input = process.stdin,
  output = process.stdout,
  t,
} = {}) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    // Resolve BEFORE closing: close() synchronously fires the 'close' handler
    // below, and its resolve(null) would otherwise win — the first settle wins.
    const done = (value) => { resolve(value); rl.close(); };
    const prompt = () => output.write(t('pick.prompt'));
    // Lines are handled as they arrive rather than asked for one at a time:
    // readline emits every buffered line immediately and keeps no queue, so a
    // burst of input — a paste, a script, a here-doc — stranded a
    // question-at-a-time loop on the second answer forever.
    rl.on('line', (raw) => {
      const answer = String(raw).trim();
      if (answer === '') return done(null);
      const index = Number.parseInt(answer, 10);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return done(choices[index - 1].login);
      }
      output.write(`${t('pick.badChoice', { count: choices.length })}\n`);
      return prompt();
    });
    // Input ended without a choice: cancel rather than hang waiting for one.
    rl.once('close', () => resolve(null));
    prompt();
  });
}
