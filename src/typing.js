// Emits at most one `start` per throttle window and exactly one `stop`, so a
// fast typist cannot turn every keypress into a frame on the wire. Timers are
// injected to keep the logic testable without real delays.
export function createTypingSignal({
  send,
  throttleMs = 2000,
  idleMs = 3000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let active = false;
  let lastSentAt = -Infinity;
  let idleTimer = null;

  const armIdle = () => {
    clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (!active) return;
      active = false;
      send('stop');
    }, idleMs);
  };

  return {
    keystroke() {
      const at = now();
      if (!active || at - lastSentAt >= throttleMs) {
        lastSentAt = at;
        active = true;
        send('start');
      }
      armIdle();
    },

    stop() {
      clearTimer(idleTimer);
      idleTimer = null;
      if (!active) return;
      active = false;
      send('stop');
    },

    isActive() {
      return active;
    },

    destroy() {
      clearTimer(idleTimer);
      idleTimer = null;
      active = false;
    },
  };
}
