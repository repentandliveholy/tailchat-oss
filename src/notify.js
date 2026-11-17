import nodeNotifier from 'node-notifier';
import { spawn as spawnProcess } from 'node:child_process';
import { isTermux } from './terminal.js';

// Android stacks notifications by id, so ten messages in a row would leave ten
// entries to dismiss by hand. One fixed id means the newest message replaces
// the previous one, the way a chat notification should behave.
const TERMUX_NOTIFICATION_ID = 'tailchat';

export function notificationPreview(text, limit = 160) {
  const normalized = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  if (limit <= 0) return '';
  if (limit === 1) return '…';
  return `${chars.slice(0, limit - 1).join('')}…`;
}

export function createNotifier({
  enabled = true,
  backend = nodeNotifier,
  bell = () => {},
  env = process.env,
  spawn = spawnProcess,
} = {}) {
  // node-notifier has no Android backend: on the phone it fails quietly, which
  // is why Termux ran with --no-notify until now.
  const termux = isTermux(env);
  // Google Play's Termux ships no Termux:API bridge app, so termux-notification
  // exists but silently drops every notification (exit 0, nothing shown). The
  // F-Droid build works. Detect the build and fall back to the bell instead of
  // pretending a notification landed.
  const termuxNoApi = termux && String(env.TERMUX_VERSION ?? '').startsWith('googleplay');
  // termux-api is a separate package the user may never have installed. Once we
  // learn the command is absent, stop forking a process per message.
  let termuxMissing = false;

  return {
    termuxNoApi,
    notify({ name, text }) {
      if (!enabled) return false;

      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        bell();
      };

      if (termux) {
        if (termuxNoApi || termuxMissing) {
          fallback();
          return true;
        }
        try {
          // Async and detached from our stdio: termux-notification talks to the
          // API service over a socket and would stall the TUI if we waited.
          const child = spawn('termux-notification', [
            '--id', TERMUX_NOTIFICATION_ID,
            '--title', notificationPreview(name, 80),
            '--content', notificationPreview(text),
          ], { stdio: 'ignore' });
          child.on('error', () => {
            termuxMissing = true;
            fallback();
          });
          child.on('exit', (code) => {
            if (code !== 0) fallback();
          });
          child.unref();
        } catch {
          termuxMissing = true;
          fallback();
        }
        return true;
      }

      try {
        backend.notify({
          title: `tailchat · ${notificationPreview(name, 80)}`,
          message: notificationPreview(text),
          sound: true,
          wait: false,
        }, (error) => {
          if (error) fallback();
        });
      } catch {
        fallback();
      }
      return true;
    },
  };
}

export function notifyIfUnfocused({
  focused, tracked = true, notifier, name, text,
}) {
  // A terminal that cannot report focus leaves `focused` at whatever it started
  // as — true — for the rest of the session, which silenced every notification on
  // Termux. Unknown focus counts as away: a notification is for exactly the case
  // where nobody is looking at the window.
  if (tracked && focused) return false;
  return notifier.notify({ name, text });
}
