// Whether the terminal will tell us when its window gains or loses focus.
//
// This cannot be guessed from $TERM: the same name covers emulators that do and
// do not implement it, and a terminal that supports focus reporting only sends
// an event when focus *changes* — so waiting for one would leave us silent for
// as long as the user never switches away.
//
// DECRQM (CSI ? Pd $ p) is the standard way to ask instead of guess. A terminal
// that knows the mode answers CSI ? Pd ; Ps $ y with Ps 1..4, and Ps=0 when it
// does not know it. Silence is a third answer and means something different:
// Windows Terminal and Warp report focus perfectly well while ignoring DECRQM,
// so reading silence as "cannot" told one side their correspondent was invisible
// when in fact they were not.

const FOCUS_QUERY = '\x1b[?1004$p';
const FOCUS_REPLY = /\x1b\[\?1004;(\d+)\$y/;

export const FOCUS_MODE_ON = '\x1b[?1004h';
export const FOCUS_MODE_OFF = '\x1b[?1004l';

// Termux is the one environment measured to never send a focus event at all: the
// Android app is not a window manager and has nothing to report. It says so
// itself through the environment, which is a fact about the platform rather than
// a guess about a terminal name.
export function isTermux(env = process.env) {
  return Boolean(env.TERMUX_VERSION)
    || String(env.PREFIX ?? '').includes('com.termux');
}

// true — the terminal said it knows the mode.
// false — the terminal said it does not.
// null — no answer, which says nothing either way.
export function probeFocusMode({
  input = process.stdin,
  output = process.stdout,
  timeoutMs = process.env.SSH_CONNECTION ? 500 : 100,
} = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY || !output.isTTY) return resolve(false);

    let buffer = '';
    let done = false;
    const wasRaw = input.isRaw;

    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off('data', onData);
      // Leave the terminal exactly as it was found; the TUI sets its own modes.
      if (!wasRaw) input.setRawMode?.(false);
      input.pause();
      resolve(answer);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('binary');
      const match = FOCUS_REPLY.exec(buffer);
      if (!match) return;
      finish(Number(match[1]) !== 0);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
    output.write(FOCUS_QUERY);
  });
}

// Silence is resolved by platform, not by optimism about terminals in general:
// everywhere but Termux a terminal that ignores DECRQM still reports focus, and
// the first real event confirms it either way.
// Termux on Android never sends blur events when minimized or in pocket, so
// focus reporting must always remain disabled on Termux.
export function resolveFocusSupport(answer, env = process.env) {
  if (isTermux(env)) return false;
  if (answer !== null) return answer;
  return true;
}

export async function probeFocusSupport(options = {}) {
  const env = options.env ?? process.env;
  if (isTermux(env)) return false;
  const answer = await probeFocusMode(options);
  return resolveFocusSupport(answer, env);
}
