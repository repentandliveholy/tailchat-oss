export const IDLE_AFTER_MS = 30 * 1000;
export const AWAY_AFTER_MS = 5 * 60 * 1000;

const STATES = new Set(['active', 'idle', 'away']);

// Accepts what a peer reported. A 0.10.x client only knew "inactive", which says
// the window is not in front but nothing about how long — idle is the honest
// reading rather than claiming the person left.
export function readPresenceState(value) {
  if (value === 'inactive') return 'idle';
  return STATES.has(value) ? value : null;
}

// ACTIVE means the person is at the keyboard this minute, not merely that the
// window is in front. A focused window where the mouse does not move and no key
// is pressed is idle, and eventually away, because a reading human is
// indistinguishable from a closed laptop — the peer deserves to know which.
export function createPresenceSignal({
  send,
  idleMs = IDLE_AFTER_MS,
  awayMs: initialAwayMs = AWAY_AFTER_MS,
  // A terminal that cannot report focus (Termux, and any terminal that says so
  // through DECRQM) cannot tell "reading on the phone" from "phone in a pocket",
  // so it must never drift to AWAY: idle is the honest ceiling there.
  noAway = false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = 'active';
  let focused = true;
  let idleTimer = null;
  let awayTimer = null;
  // Mutable so /saver after can retune how long "away" takes without tearing
  // down and rebuilding the whole signal — see setAwayMs below.
  let awayMs = initialAwayMs;

  const cancel = () => {
    clearTimer(idleTimer);
    clearTimer(awayTimer);
    idleTimer = null;
    awayTimer = null;
  };

  const report = (next) => {
    if (next === state) return;
    state = next;
    send(state);
  };

  // Start counting toward idle. The timer is unref'd so a quiet window never
  // holds the event loop open just to announce an absence.
  const armIdle = () => {
    clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      report('idle');
      if (noAway) return;
      awayTimer = setTimer(() => {
        awayTimer = null;
        report('away');
      }, awayMs);
      awayTimer?.unref?.();
    }, idleMs);
    idleTimer?.unref?.();
  };

  const armAway = () => {
    if (noAway) return;
    clearTimer(awayTimer);
    awayTimer = setTimer(() => {
      awayTimer = null;
      report('away');
    }, awayMs);
    awayTimer?.unref?.();
  };

  return {
    // A key press or a mouse move while the window is in front: the person is
    // here, and the idle clock restarts.
    activity() {
      if (!focused) return;
      cancel();
      report('active');
      armIdle();
    },

    focus() {
      focused = true;
      cancel();
      report('active');
      armIdle();
    },

    blur() {
      focused = false;
      cancel();
      report('idle');
      armAway();
    },

    current() {
      return state;
    },

    // /saver after changes how long AWAY takes without tearing down and
    // rebuilding the whole signal. A timer already counting toward away is
    // restarted at the new length; one that has not started yet (still idle,
    // still active) simply uses the new value whenever it does.
    setAwayMs(ms) {
      awayMs = ms;
      if (awayTimer !== null) armAway();
    },

    destroy() {
      cancel();
    },
  };
}
