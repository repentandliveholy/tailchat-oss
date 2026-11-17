import './wide-chars.js';
import readline from 'node:readline';
import { runListMenu, interactive } from './menu.js';
import { createTranslator, normaliseLanguage } from './i18n.js';
import { normaliseSelfName } from './config.js';
import { isTermux } from './terminal.js';

// Asked once, before anything else owns the terminal: the interface language,
// the name this person is known by, and whether the transcript is kept. The
// answers land in ~/.tailchat/config.json and the wizard never appears again;
// --lang / --name / --no-log / TAILCHAT_LANG keep overriding what it saved.
const LANGS = ['ru', 'en', 'fr'];
const NATIVE = { ru: 'Русский', en: 'English', fr: 'Français' };

// The current language first, so the highlighted answer is the one that already
// applies — Enter means "yes, this one" without any arrow presses.
export function languageRows(current) {
  const order = [current, ...LANGS.filter((lang) => lang !== current)];
  return order.map((lang) => ({ name: NATIVE[lang], help: '', value: lang }));
}

// "Yes" first: the transcript is on by default, and Enter alone accepts that.
export function logRows(t) {
  return [
    { name: t('setup.logYes'), help: '', value: true },
    { name: t('setup.logNo'), help: '', value: false },
  ];
}
// The name is typed, not chosen from a list, so this is a plain prompt rather
// than the menu the other two questions use — a text field inside a bordered
// blessed frame renders blank on this blessed version, which is the same reason
// runListMenu avoids `keys: true`. The shape follows readChoice in picker.js:
// settle once, handle lines as they arrive, and treat the end of input as an
// answer rather than hanging on a question nobody will type into.
//
// Enter alone accepts the suggestion, which keeps the old behaviour — the
// hostname — available in one keystroke for anyone who wants it.
export function askName(suggestion, {
  input = process.stdin,
  output = process.stdout,
  t,
} = {}) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    const done = (value) => { resolve(value); rl.close(); };
    const prompt = () => output.write(t('setup.namePrompt', { suggestion }));
    output.write(`${t('setup.nameTitle')}\n${t('setup.nameWhy')}\n`);
    rl.on('line', (raw) => {
      if (String(raw).trim() === '') return done(suggestion);
      const name = normaliseSelfName(raw);
      if (name) return done(name);
      output.write(`${t('setup.nameBad')}\n`);
      return prompt();
    });
    rl.once('close', () => resolve(suggestion));
    prompt();
  });
}

// Returns { lang, name, log } when something was asked, null when nothing was —
// either because flags already answered everything or because there is no
// terminal to ask (a script gets defaults, never a hang). Cancelling a question
// keeps the default: the detected language, the hostname, and a kept transcript.
export async function runSetup({
  args, env = process.env, t, themed = true, config = {},
  input = process.stdin, output = process.stdout,
}) {
  if (args?.headless || !interactive(input, output)) return null;
  // run answer for good — the wizard must not ask twice.
  const askLang = !args.langExplicit && !env.TAILCHAT_LANG && !config.lang;
  const wantName = !args.nameExplicit && !normaliseSelfName(config.name);
  const askLog = !args.log && !args.noLog && config.log === undefined;

  let lang = args.lang;
  let tt = t;
  const termux = isTermux(env);
  if (askLang) {
    const picked = await runListMenu({
      title: tt('setup.langTitle'),
      rows: languageRows(lang),
      keysHint: tt('pick.keysHint'),
      themed, termux, input, output,
    });
    if (picked !== null) lang = picked;
    // The next question must already speak the chosen language.
    tt = createTranslator(lang);
  }

  // Asked after the language so the question is in the language just chosen,
  // and before the transcript question because it is the one answer the peer
  // will actually see.
  let name = args.name;
  if (wantName) name = await askName(name, { input, output, t: tt });

  let log = args.log ? true : !args.noLog;
  if (askLog) {
    const picked = await runListMenu({
      title: tt('setup.logTitle'),
      rows: logRows(tt),
      keysHint: tt('pick.keysHint'),
      themed, termux, input, output,
    });
    if (picked !== null) log = picked;
  }

  return { lang: normaliseLanguage(lang), name, log };
}
