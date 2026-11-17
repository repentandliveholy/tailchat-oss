import fs from 'node:fs';
import path from 'node:path';
import { openDeviceStore } from './secure-store.js';

// A crash used to take two things away at once. The obvious casualty is the
// session; the one people actually notice is the terminal, because the TUI
// leaves the alternate screen, raw mode, mouse reporting and bracketed paste
// switched on, and a console in that state answers no further keystroke — on
// Windows the only way out is to close the window. The quieter casualty is the
// listener note: `listener-<port>.pid` outlives the process that wrote it, the
// next client reads it, concludes that someone else holds the port and stands
// down, and the conversation stays dead until a person deletes a file they have
// never heard of.
//
// So an unexpected error is a cleanup problem before it is a reporting problem.
// Everything here exists to run the same orderly teardown the quit path runs,
// and only then to say what happened — on a terminal that can show it, plus a
// file that can be pasted into a bug report.

const CRASH_FILE = 'crash.log';
// Enough to hold the last several failures and no more: a crash loop must not
// be able to fill the disk that the transcript and the outbox also live on.
export const CRASH_LOG_LIMIT = 64 * 1024;

export function crashLogFile(stateDir) {
  return path.join(stateDir, CRASH_FILE);
}

// A rejected promise carries whatever the thrower felt like passing, and often
// that is a string, a number or `undefined` rather than an Error. Reading
// `.stack` off those yields nothing at all, which is how a crash report ends up
// saying only "undefined" — so the value is described rather than trusted.
export function describeFailure(error) {
  if (error instanceof Error) {
    const code = error.code ? ` (${error.code})` : '';
    return `${error.name}: ${error.message}${code}`;
  }
  if (error === undefined) return 'undefined (a promise rejected with no value)';
  if (error === null) return 'null (a promise rejected with no value)';
  if (typeof error === 'object') {
    try {
      return `${typeof error}: ${JSON.stringify(error)}`;
    } catch {
      return `${typeof error}: (unserialisable)`;
    }
  }
  return `${typeof error}: ${String(error)}`;
}

export function crashReport(error, {
  at = new Date(),
  kind = 'uncaughtException',
  version = 'unknown',
  platform = process.platform,
  node = process.version,
  argv = [],
} = {}) {
  const stack = error instanceof Error && error.stack
    ? error.stack
    : describeFailure(error);
  return [
    `── ${at.toISOString()} ─ ${kind}`,
    `tailchat ${version} · node ${node} · ${platform}`,
    argv.length > 0 ? `argv: ${argv.join(' ')}` : null,
    stack,
    '',
  ].filter((line) => line !== null).join('\n');
}

// Never throws, whatever the disk is doing: the caller is already in the middle
// of dying and a second failure here would replace a useful stack with a
// misleading one. A report that cannot be saved is still worth printing, so the
// outcome comes back as a value instead of an exception.
export function recordCrash(stateDir, error, {
  store = null,
  limit = CRASH_LOG_LIMIT,
  ...meta
} = {}) {
  const file = crashLogFile(stateDir);
  const report = crashReport(error, meta);
  try {
    const vault = store ?? openDeviceStore();
    const encrypted = vault.fileFor(file);
    let previous;
    try { previous = vault.read(file).toString('utf8'); }
    catch (failure) {
      if (failure.code !== 'ENOENT' || fs.existsSync(file)) throw failure;
      previous = '';
    }
    const next = previous.length + report.length > limit ? report : `${previous}${report}`;
    vault.write(file, Buffer.from(next));
    return { ok: true, file: encrypted };
  } catch (failure) {
    return { ok: false, file, error: describeFailure(failure) };
  }
}

// Windows generates no terminal SIGTERM: Ctrl+Break arrives as SIGBREAK and
// closing the console window arrives as SIGHUP, and without those two a Windows
// user's every exit was the dirty kind this module exists to prevent. Naming a
// signal the platform does not have is harmless — Node simply never raises it.
export const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

export function installSignalHandlers(onSignal, {
  signals = TERMINATION_SIGNALS,
  on = process.on.bind(process),
} = {}) {
  const installed = [];
  for (const signal of signals) {
    try {
      on(signal, () => onSignal(signal));
      installed.push(signal);
    } catch {
      // An exotic platform that rejects the name: the rest still stand.
    }
  }
  return installed;
}

// The whole point of the safety net: whatever went wrong, put the terminal back,
// leave no note behind that would confuse the next client, and say one true
// sentence about it. `restore` is the caller's orderly teardown and is expected
// to be idempotent — it is the same function the quit path calls.
//
// The process always exits. Node's own advice for an uncaught exception is that
// the state of the program can no longer be reasoned about, and a chat client
// that keeps running on a half-destroyed screen would be worse than one that
// stops and says why.
export function installFatalHandlers({
  stateDir,
  restore = () => {},
  report = (text) => { process.stderr.write(`${text}\n`); },
  exit = (code) => process.exit(code),
  on = process.on.bind(process),
  streams = [process.stdout, process.stderr],
  describe = ({ ok, file }) => (ok ? `details saved to ${file}` : `the details could not be saved to ${file}`),
  headline = (summary) => `tailchat stopped: ${summary}`,
  record = recordCrash,
  meta = {},
} = {}) {
  let dying = false;

  const fatal = (error, kind) => {
    // A failure raised by the teardown or by the reporting below must not start
    // this over: the second trip would overwrite the first diagnosis.
    if (dying) return;
    dying = true;

    try {
      restore();
    } catch { /* the original error is the one worth reporting */ }

    const saved = stateDir ? record(stateDir, error, { kind, ...meta }) : null;
    try {
      report(headline(describeFailure(error)));
      if (saved) report(describe(saved));
    } catch { /* stderr is gone too; there is nowhere left to say it */ }

    exit(1);
  };

  on('uncaughtException', (error) => fatal(error, 'uncaughtException'));
  on('unhandledRejection', (error) => fatal(error, 'unhandledRejection'));

  // A closed pipe is not a fault. `tailchat --help | head` and a piped TUI both
  // end with the reader walking away, and Node's default for an unhandled
  // stream `error` is to turn that ordinary ending into a crash report.
  for (const stream of streams) {
    stream?.on?.('error', (error) => {
      if (error?.code === 'EPIPE') {
        try {
          restore();
        } catch { /* nothing left to restore it with */ }
        exit(0);
        return;
      }
      fatal(error, 'streamError');
    });
  }

  return { fatal };
}
