// Guards an attention-grabbing action so a held key cannot turn into a barrage
// on the peer's side. The window is measured from the last successful take, so a
// refused attempt never pushes it further out.
export function createThrottle(windowMs, now = () => Date.now()) {
  let lastAt = -Infinity;

  return {
    tryTake() {
      const at = now();
      if (at - lastAt < windowMs) return false;
      lastAt = at;
      return true;
    },

    remainingSeconds() {
      const left = windowMs - (now() - lastAt);
      return left <= 0 ? 0 : Math.ceil(left / 1000);
    },
  };
}
