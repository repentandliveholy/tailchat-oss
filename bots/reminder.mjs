#!/usr/bin/env node
// A reminder bot that lives in Tailchat as an ordinary contact.
//
// It is the smallest thing that exercises all three parts of remindka's value:
// reading a time out of a phrase, holding it durably across a restart, and
// pushing the reminder at that moment — including when the phone's app is
// closed, which is exactly what Tailchat's offline queue and push are for.
//
// It is deliberately standalone: no Tailchat server change, no Telegram, no
// dependencies. Point it at a server, give it an account, and it is a contact.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotClient, normalizeServer, randomId } from './client.mjs';
import { createRemindkaSync, DEFAULT_SYNC_URL, SYNC_KEY_RE, SyncError } from './remindka-sync.mjs';
import {
  createReminder as createReminderRecord,
  formatWhen as formatCoreWhen,
  normalizeActions,
  parseReminder,
  presetDue,
  getReminderActions,
  REMINDER_ACTIONS,
} from '@tailchat/reminder-core';

// ---------------------------------------------------------------------------
// State: one JSON file, written atomically, because a reminder that a restart
// loses is worse than no reminder at all.
// ---------------------------------------------------------------------------

function createStore(file) {
  let state = { reminders: [], pending: {}, users: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.reminders)) {
      state = { reminders: parsed.reminders, pending: parsed.pending ?? {}, users: parsed.users ?? {} };
    }
  } catch {
    // No file yet, or an unreadable one: start empty rather than refuse to run.
  }
  let timer = null;
  let listener = null;
  const flush = () => {
    timer = null;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      // Reminders are private — what somebody asked to be reminded of is
      // exactly the kind of thing this repo keeps at 0600 (see `writeConfig`
      // in src/config.js). The mode is set on the temporary file as well, so
      // there is never a window where it is world-readable.
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      log(`could not save state: ${error.message}`);
    }
  };
  return {
    get reminders() { return state.reminders; },
    get pending() { return state.pending; },
    get users() { return state.users ?? (state.users = {}); },
    saveNow: flush,
    // Called on every `save()`, before the write is debounced: the sync layer
    // learns about each mutation without any mutation site knowing about it.
    set onSave(fn) { listener = fn; },
    save() {
      listener?.();
      if (timer) return;
      timer = setTimeout(flush, 200);
      timer.unref?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a time out of a phrase. This is the corner remindka has spent its
// effort on (chrono-node plus its own normalisations); what is here covers the
// shapes a first trial actually needs, and every shape it does not cover falls
// back to remindka's own zero-friction default: no time understood still means
// "remind me about this in fifteen minutes".
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = [
  [/^(?:м|мин|минута|минуту|минуты|минут|m|min|mins|minute|minutes)$/i, MINUTE],
  [/^(?:ч|час|часа|часов|h|hr|hrs|hour|hours)$/i, HOUR],
  [/^(?:д|день|дня|дней|d|day|days)$/i, DAY],
];

function unitOf(word) {
  for (const [pattern, ms] of UNITS) if (pattern.test(word)) return ms;
  return null;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function resolveTimezone(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (isValidTimezone(raw)) return raw;
  const match = raw.match(/^(?:UTC|GMT)?([+-]\d{1,2})(?::?(\d{2}))?$/i);
  if (match) {
    const hours = parseInt(match[1], 10);
    const mins = match[2] ? parseInt(match[2], 10) : 0;
    const sign = hours >= 0 ? '+' : '-';
    const absH = Math.abs(hours).toString().padStart(2, '0');
    const absM = mins.toString().padStart(2, '0');
    const custom = `UTC${sign}${absH}:${absM}`;
    if (isValidTimezone(custom)) return custom;
  }
  return null;
}

function formatTimeInZone(tz, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function getUser(peer) {
  const users = store.users;
  if (!users[peer]) {
    users[peer] = {
      tz: TIMEZONE,
      lang: 'ru',
    };
  }
  return users[peer];
}

function timezoneOf(peer) {
  return getUser(peer).tz || TIMEZONE;
}

function langOf(peer) {
  return getUser(peer).lang || 'ru';
}

function parseWhen(input, peerOrNow = null, maybeNow = null) {
  const peer = typeof peerOrNow === 'string' ? peerOrNow : null;
  const now = typeof peerOrNow === 'number' ? peerOrNow : (typeof maybeNow === 'number' ? maybeNow : Date.now());
  const tz = peer ? timezoneOf(peer) : TIMEZONE;
  const locale = peer ? langOf(peer) : undefined;
  const parsed = parseReminder(input, { timezone: tz, locale, now });
  return parsed ? { dueAt: parsed.dueAt, rest: parsed.text } : null;
}

// ---------------------------------------------------------------------------
// Presentation.
// ---------------------------------------------------------------------------

const BOT_I18N = {
  ru: {
    help: [
      'Я напоминаю о делах. Напишите, что и когда — остальное сам.',
      '',
      'Команды пишутся без слэша (список, помощь, настройки, пояс).',
      '',
      'Примеры:',
      '• через 10 минут разгрузка',
      '• через 2 часа позвонить маме',
      '• завтра в 9:00 встреча',
      '• в 18:30 созвон',
      '',
      'Без времени — напомню через 15 минут.',
      'Перешлите мне сообщение — сделаю напоминание.',
      '',
      'Команды:',
      '• список — мои напоминания',
      '• 1, 2, 3… — карточка напоминания',
      '• удали 2 — удалить',
      '• готово 2 — выполнено',
      '• настройки — язык и пояс',
      '• пояс Europe/Moscow — сменить пояс',
      '• sync rmk_… — синхронизация с основной базой Remindka',
      '• помощь — эта справка',
      '',
      'При срабатывании:',
      '• готово — закрыть',
      '• +10 / +1ч — отложить',
      '• вечером / завтра — перенести',
    ].join('\n'),
    reminderHead: '⏰ Напоминание',
    reminderHeadNag: '🔔 Напоминание (ещё раз)',
    forwardedFrom: (name) => `\n— переслано от ${name}`,
    reminderFooter: '\n\n«готово» — закрыть · «+10», «вечером», «завтра» — отложить',
    saved: (when, text, from = '') => `Запомнил${from}: ${text} — ${when}`,
    addedTo: (when, text) => `Добавил к напоминанию (${when}):\n${text}`,
    whatToRemind: (when) => `О чём напомнить в ${when}?`,
    noTimeDefault: (text) => `Времени не увидел — напомню через 15 минут: ${text}\nЕсли это была команда, напишите «помощь».`,
    closed: (text) => `Закрыл: ${text}`,
    deleted: (text) => `Удалил: ${text}`,
    markedDone: (text) => `Отметил: ${text}`,
    notFound: (index) => `Нет напоминания №${index}. Посмотрите «список».`,
    nothingToClose: 'Нечего закрывать — открытых напоминаний нет. «список» покажет, что есть.',
    severalOpenToClose: (count) => `Открытых напоминаний ${count} — закройте номером: «готово 1». «список» покажет, что есть.`,
    snoozed: (how, when, text) => `Отложил ${how} (${when}): ${text}`,
    snoozedIndex: (index, when, text) => `Отложил №${index} (${when}): ${text}`,
    savedFrom: (name) => ` (переслано от ${name})`,
    forwardedPlaceholder: 'Пересланное сообщение',
    attachmentGone: 'Вложение к этому напоминанию уже вне истории — текст остался, картинка нет.',
    attachmentDropped: 'Вложение удалено сервером (освобождал место) — напомню текстом.',
    syncHowTo: [
      '☁️ Синхронизация с основной базой Remindka — той же, что у Telegram-бота и приложения.',
      '',
      '1. Отправьте /sync Telegram-боту Remindka — он выдаст ключ rmk_…',
      '2. Пришлите сюда: sync rmk_…',
      '',
      'Отключить: sync off',
    ].join('\n'),
    syncOn: (imported, pushed) => `☁️ Синхронизация включена.\nПолучено из основной базы: ${imported}. Отправлено в неё: ${pushed}.\nТеперь напоминания общие с Telegram-ботом и приложением.\n\nКлюч остался в этой переписке — удалите сообщение с ним.\nОтключить: sync off`,
    syncStatus: (when, error) => `☁️ Синхронизация включена. ${error === '' ? `Последний обмен: ${when}.` : `Последний обмен не удался: ${error}.`}\nОтключить: sync off`,
    syncNever: 'ещё не было',
    syncOff: 'Синхронизация отключена. Напоминания остались здесь, но с основной базой больше не обмениваются.',
    syncOffAlready: 'Синхронизация и так не включена.',
    syncBadKey: 'Ключ выглядит неверно: он начинается с rmk_ (латиница, цифры, «-» и «_»). Скопируйте его из Telegram-бота командой /sync или из приложения.',
    syncOtherKey: 'Уже подключён другой ключ. Сначала отправьте «sync off».',
    syncNotSaved: 'Ключ не сохранён.',
    syncError: (code) => ({
      unlinked: 'ключ не привязан к Telegram — отправьте /sync rmk_… Telegram-боту Remindka и повторите',
      unauthorized: 'сервер не принял ключ',
      network: 'нет связи с сервером синхронизации',
      http: 'сервер синхронизации ответил ошибкой',
      bad_response: 'сервер синхронизации ответил непонятно',
    })[code] ?? `ошибка (${code})`,
    // `preset` is the canonical key ('вечер' | 'завтра'), not a phrase: the
    // buttons carry canonical values in every language, only the wording of the
    // answer changes.
    snoozePreset: (preset) => `на ${preset === 'вечер' ? 'вечер' : 'завтра утром'}`,
    snoozeRelative: (amount, unit) => `на ${amount} ${unit === 'h' ? 'ч' : 'мин'}`,
    labels: {
      done: '✅ Готово',
      delete: '🗑️ Удалить',
      list: '📋 Список',
      settings: '⚙️ Настройки',
      help: '❓ Помощь',
      evening: 'Вечером',
      tomorrow: 'Завтра',
      snooze10: '+10 мин',
      snooze1h: '+1 час',
    },
  },
  en: {
    help: [
      'I remind you about things. Send what and when — I handle the rest.',
      '',
      'Commands (no slash needed):',
      '• list — view reminders',
      '• 1, 2, 3… — reminder card',
      '• delete 2 — delete #2',
      '• done 2 — mark #2 done',
      '• settings — language & timezone',
      '• tz Europe/London — change timezone',
      '• sync rmk_… — sync with the main Remindka database',
      '• help — this help',
      '',
      'When a reminder fires:',
      '• done — finish',
      '• +10 / +1h — snooze',
      '• evening / tomorrow — reschedule',
    ].join('\n'),
    reminderHead: '⏰ Reminder',
    reminderHeadNag: '🔔 Reminder (follow-up)',
    forwardedFrom: (name) => `\n— forwarded from ${name}`,
    reminderFooter: '\n\n"done" to finish · "+10", "evening", "tomorrow" to snooze',
    saved: (when, text, from = '') => `Saved${from}: ${text} — ${when}`,
    addedTo: (when, text) => `Added to reminder (${when}):\n${text}`,
    whatToRemind: (when) => `What should I remind you about at ${when}?`,
    noTimeDefault: (text) => `No time specified — reminding in 15 minutes: ${text}\nIf this was a command, send "help".`,
    closed: (text) => `Closed: ${text}`,
    deleted: (text) => `Deleted: ${text}`,
    markedDone: (text) => `Marked done: ${text}`,
    notFound: (index) => `No reminder #${index}. Check "list".`,
    nothingToClose: 'Nothing to close — no open reminders. "list" shows what you have.',
    severalOpenToClose: (count) => `${count} open reminders — close by number: "done 1". "list" shows what you have.`,
    snoozed: (how, when, text) => `Snoozed ${how} (${when}): ${text}`,
    snoozedIndex: (index, when, text) => `Snoozed #${index} (${when}): ${text}`,
    savedFrom: (name) => ` (forwarded from ${name})`,
    forwardedPlaceholder: 'Forwarded message',
    attachmentGone: 'The attachment to this reminder has left the history — the words stayed, the picture did not.',
    attachmentDropped: 'The server dropped the attachment (it was freeing space) — reminding you in words.',
    syncHowTo: [
      '☁️ Sync with the main Remindka database — the one the Telegram bot and the app use.',
      '',
      '1. Send /sync to the Remindka Telegram bot — it gives you a key rmk_…',
      '2. Send it here: sync rmk_…',
      '',
      'Turn off: sync off',
    ].join('\n'),
    syncOn: (imported, pushed) => `☁️ Sync is on.\nReceived from the main database: ${imported}. Sent to it: ${pushed}.\nReminders are now shared with the Telegram bot and the app.\n\nThe key stays in this conversation — delete the message that has it.\nTurn off: sync off`,
    syncStatus: (when, error) => `☁️ Sync is on. ${error === '' ? `Last exchange: ${when}.` : `Last exchange failed: ${error}.`}\nTurn off: sync off`,
    syncNever: 'none yet',
    syncOff: 'Sync is off. The reminders stay here, but no longer exchange with the main database.',
    syncOffAlready: 'Sync is not on.',
    syncBadKey: 'That key does not look right: it starts with rmk_ (letters, digits, "-" and "_"). Copy it from the Telegram bot with /sync, or from the app.',
    syncOtherKey: 'Another key is already connected. Send "sync off" first.',
    syncNotSaved: 'The key was not saved.',
    syncError: (code) => ({
      unlinked: 'the key is not linked to Telegram — send /sync rmk_… to the Remindka Telegram bot, then retry',
      unauthorized: 'the server did not accept the key',
      network: 'cannot reach the sync server',
      http: 'the sync server answered with an error',
      bad_response: 'the sync server answered something unintelligible',
    })[code] ?? `error (${code})`,
    snoozePreset: (preset) => (preset === 'вечер' ? 'until this evening' : 'until tomorrow morning'),
    snoozeRelative: (amount, unit) => `by ${amount} ${unit}`,
    labels: {
      done: '✅ Done',
      delete: '🗑️ Delete',
      list: '📋 List',
      settings: '⚙️ Settings',
      help: '❓ Help',
      evening: 'Evening',
      tomorrow: 'Tomorrow',
      snooze10: '+10 min',
      snooze1h: '+1 hour',
    },
  },
  fr: {
    help: [
      'Je vous rappelle vos tâches. Écrivez quoi et quand — je m’occupe du reste.',
      '',
      'Commandes (sans slash) :',
      '• liste — voir les rappels',
      '• 1, 2, 3… — fiche d’un rappel',
      '• supprime 2 — supprimer le n°2',
      '• fait 2 — marquer le n°2 fait',
      '• paramètres — langue et fuseau',
      '• tz Europe/Paris — changer de fuseau',
      '• sync rmk_… — synchroniser avec la base principale Remindka',
      '• aide — cette aide',
      '',
      'Lors d’un rappel :',
      '• fait — terminer',
      '• +10 / +1h — reporter',
      '• ce soir / demain — reprogrammer',
    ].join('\n'),
    reminderHead: '⏰ Rappel',
    reminderHeadNag: '🔔 Rappel de suivi',
    forwardedFrom: (name) => `\n— transféré de ${name}`,
    reminderFooter: '\n\n« fait » pour terminer · « +10 », « ce soir », « demain » pour reporter',
    saved: (when, text, from = '') => `Rappel enregistré${from} : ${text} — ${when}`,
    addedTo: (when, text) => `Ajouté au rappel (${when}) :\n${text}`,
    whatToRemind: (when) => `Que dois-je vous rappeler à ${when} ?`,
    noTimeDefault: (text) => `Aucune heure indiquée — rappel programmé dans 15 minutes : ${text}\nS'il s'agissait d'une commande, écrivez « aide ».`,
    closed: (text) => `Terminé : ${text}`,
    deleted: (text) => `Supprimé : ${text}`,
    markedDone: (text) => `Marqué fait : ${text}`,
    notFound: (index) => `Aucun rappel n°${index}. Consultez la « liste ».`,
    nothingToClose: 'Rien à fermer — aucun rappel en cours. La « liste » affiche vos rappels.',
    severalOpenToClose: (count) => `${count} rappels en cours — fermez par numéro : « fait 1 ». La « liste » affiche vos rappels.`,
    snoozed: (how, when, text) => `Reporté ${how} (${when}) : ${text}`,
    snoozedIndex: (index, when, text) => `Rappel n°${index} reporté (${when}) : ${text}`,
    savedFrom: (name) => ` (transféré de ${name})`,
    forwardedPlaceholder: 'Message transféré',
    attachmentGone: 'La pièce jointe de ce rappel a quitté l’historique — le texte reste, l’image non.',
    attachmentDropped: 'Le serveur a supprimé la pièce jointe (libération d’espace) — je vous rappelle en texte.',
    syncHowTo: [
      '☁️ Synchronisation avec la base principale Remindka — celle du bot Telegram et de l’application.',
      '',
      '1. Envoyez /sync au bot Telegram Remindka — il vous donne une clé rmk_…',
      '2. Envoyez-la ici : sync rmk_…',
      '',
      'Désactiver : sync off',
    ].join('\n'),
    syncOn: (imported, pushed) => `☁️ Synchronisation activée.\nReçus de la base principale : ${imported}. Envoyés vers elle : ${pushed}.\nLes rappels sont désormais partagés avec le bot Telegram et l’application.\n\nLa clé reste dans cette conversation — supprimez le message qui la contient.\nDésactiver : sync off`,
    syncStatus: (when, error) => `☁️ Synchronisation activée. ${error === '' ? `Dernier échange : ${when}.` : `Le dernier échange a échoué : ${error}.`}\nDésactiver : sync off`,
    syncNever: 'aucun pour l’instant',
    syncOff: 'Synchronisation désactivée. Les rappels restent ici, mais ne sont plus échangés avec la base principale.',
    syncOffAlready: 'La synchronisation n’est pas activée.',
    syncBadKey: 'Cette clé semble incorrecte : elle commence par rmk_ (lettres, chiffres, « - » et « _ »). Copiez-la depuis le bot Telegram avec /sync, ou depuis l’application.',
    syncOtherKey: 'Une autre clé est déjà connectée. Envoyez d’abord « sync off ».',
    syncNotSaved: 'La clé n’a pas été enregistrée.',
    syncError: (code) => ({
      unlinked: 'la clé n’est pas associée à Telegram — envoyez /sync rmk_… au bot Telegram Remindka, puis réessayez',
      unauthorized: 'le serveur n’a pas accepté la clé',
      network: 'impossible de joindre le serveur de synchronisation',
      http: 'le serveur de synchronisation a répondu par une erreur',
      bad_response: 'le serveur de synchronisation a répondu de façon incompréhensible',
    })[code] ?? `erreur (${code})`,
    snoozePreset: (preset) => (preset === 'вечер' ? 'à ce soir' : 'à demain matin'),
    snoozeRelative: (amount, unit) => `de ${amount} ${unit}`,
    labels: {
      done: '✅ Fait',
      delete: '🗑️ Supprimer',
      list: '📋 Liste',
      settings: '⚙️ Paramètres',
      help: '❓ Aide',
      evening: 'Ce soir',
      tomorrow: 'Demain',
      snooze10: '+10 min',
      snooze1h: '+1 h',
    },
  },
};

function i18nOf(peer) {
  const lang = typeof peer === 'string' ? langOf(peer) : 'ru';
  return BOT_I18N[lang] || BOT_I18N.ru;
}

// Every word a locale's help text teaches has to reach the branch that handles
// it. A taught word the dispatcher does not know is not an error anybody sees:
// it becomes the *text of a new reminder* — which is how a French user sending
// the « supprime 2 » its own help taught got a reminder called « supprime 2 ».
// The vocabulary lives in one place so `--self-test` can prove it agrees with
// the help text, in a language the tests are not written in.
const COMMANDS = {
  list: /^(?:список|лист|list|liste|мои|мои напоминания|напоминания)$/,
  help: /^(?:помощь|помоги|хелп|help|aide|справка|команды|\?|начать|start)$/,
  settings: /^(?:настройки|settings|paramètres|parametres|параметры|setup)$/,
  language: /^(?:язык|lang|language|langue)(?:\s+([a-z]{2}))?$/,
  timezone: /^(?:пояс|таймзона|tz|timezone|fuseau)(?:\s+(.+))?$/,
  delete: /^(?:удали|удалить|убери|отмени|supprime|supprimer|efface|annule|del|delete)\s+(\d+)$/,
  done: /^(?:готово|сделано|выполнено|закрыть|fait|termine|done)\s+(\d+)$/,
  snooze: /^(?:отложи|перенеси|отложить|перенести|reporte|reporter|repousse|snooze)\s+(\d+)(?:\s+(.+))?$/,
  open: /^(?:открой|напоминание|номер|#)?\s*(\d+)$/,
  // Answers to a reminder that has already fired.
  ack: /^(?:готово|сделано|ок|окей|done|fait|✓|✅)$/,
  close: /^(?:готово|сделано|выполнено|done|fait|ок|окей)$/,
  evening: /^(?:вечером|на вечер|вечер|evening|tonight|ce soir|soir)$/,
  tomorrow: /^(?:завтра|утром|tomorrow|morning|demain)$/,
  plus: /^\+\s*(\d{1,3})?\s*([a-zа-яё]+)?$/,
  // A word that is also ordinary reminder text («синхронизация завтра») is a
  // command only bare, with a key, or with an off-word; anything else stays a reminder.
  sync: /^(?:sync|синк|синхронизация|synchro|synchronisation)(?:\s+(rmk_\S*|off|disable|выкл|откл|отключить|désactiver))?$/i,
};

function formatWhen(ts, peerOrNow = null, maybeNow = null) {
  const peer = typeof peerOrNow === 'string' ? peerOrNow : null;
  const now = typeof peerOrNow === 'number' ? peerOrNow : (typeof maybeNow === 'number' ? maybeNow : Date.now());
  const tz = peer ? timezoneOf(peer) : TIMEZONE;
  const locale = peer ? langOf(peer) : 'ru';
  const formatted = formatCoreWhen(ts, { locale, timezone: tz, now });
  if (!formatted) return new Date(ts).toISOString();
  if (formatted.day === 'today') return formatted.time;
  if (formatted.day === 'tomorrow') {
    return locale === 'en' ? `tomorrow ${formatted.time}` : locale === 'fr' ? `demain ${formatted.time}` : `завтра ${formatted.time}`;
  }
  return `${formatted.label} ${formatted.time}`;
}

// ---------------------------------------------------------------------------

const BOT_NAME = 'reminder';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    'Tailchat reminder bot',
    '',
    '  TAILCHAT_SERVER    server address (default https://repentandliveholy.org)',
    '  TAILCHAT_LOGIN     account login (required unless TAILCHAT_TOKEN is set)',
    '  TAILCHAT_PASSWORD  account password (used once to obtain a token)',
    '  TAILCHAT_TOKEN     a token instead of login/password',
    '  TAILCHAT_INVITE    an invitation code to accept before starting',
    '  TAILCHAT_STATE     state file (default ./reminder-state.json)',
    '  TAILCHAT_NAME      display name used for typing indicators',
    '  TZ                 the timezone times are read and shown in',
    '  NAG_MINUTES        repeat an unacknowledged reminder after N minutes (default 15)',
    '  NAG_MAX            how many times (default 2)',
    '  REMINDKA_SYNC_URL  main-database sync server (default https://remindka.repentandliveholy.org/sync)',
    '',
    '  --register         create the account if missing, then exit',
    '  --invite           create the account if missing, print an invitation link, and keep running',
    '  --self-test        check the phrase parser without touching the network',
    '',
    `Всё, что бот хранит, лежит в ${path.join(os.homedir(), '.tailchat', 'bots', BOT_NAME)}:`,
    'state.json, credentials.env (0600) и ключ восстановления. Ничего из этого не',
    'внутри репозитория — деплой переписывает чекаут на origin/main.',
    '',
    'Первый запуск — одна команда:',
    '  TAILCHAT_LOGIN=nagreminder TAILCHAT_PASSWORD=… node bots/reminder.mjs --invite',
    '',
    'Она создаёт аккаунт, сохраняет credentials.env и печатает ссылку-приглашение.',
    'Вставьте её в приложении («Добавить контакт») — бот увидит нового друга сам,',
    'секунд через десять, и перезапускать его не нужно.',
    '',
    'Дальше — просто:',
    '  node bots/reminder.mjs',
    '  pm2 start bots/reminder.mjs --name nagreminder',
    '',
  ].join('\n'));
  process.exit(0);
}

// Where this bot's own files live. Not inside the checkout: a checkout is
// reset to origin/main by the deploy, and a password or a pending reminder has
// no business being reset, ignored or committed by accident. This is the same
// per-user state directory the terminal client already uses (`defaultStateDir`
// in src/files.js), one folder per bot.
const STATE_DIR = process.env.TAILCHAT_STATE_DIR ?? path.join(os.homedir(), '.tailchat', 'bots', BOT_NAME);
const CREDENTIALS_FILE = process.env.TAILCHAT_CREDENTIALS ?? path.join(STATE_DIR, 'credentials.env');

// A file of NAME=value lines, written 0600 by `--register`. Read before the
// environment is consulted so that a stray shell variable cannot quietly point
// a bot at another account; what is in the environment still wins for a
// deliberate override.
function readCredentials(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq < 1) continue;
    const name = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

const fromFile = readCredentials(CREDENTIALS_FILE);
const setting = (name) => process.env[name] ?? fromFile[name];
const SERVER = setting('TAILCHAT_SERVER') ?? 'https://repentandliveholy.org';
const LOGIN = setting('TAILCHAT_LOGIN') ?? '';
const PASSWORD = setting('TAILCHAT_PASSWORD') ?? '';
const TOKEN = setting('TAILCHAT_TOKEN') ?? '';
const INVITE = setting('TAILCHAT_INVITE') ?? '';
const NAME = setting('TAILCHAT_NAME') ?? 'Напоминалка';
const TIMEZONE = setting('TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const STATE_FILE = setting('TAILCHAT_STATE') ?? path.join(STATE_DIR, 'state.json');
const WANT_REGISTER = args.includes('--register');
const WANT_INVITE = args.includes('--invite');
const NAG_MS = Math.max(0, Number(process.env.NAG_MINUTES ?? 15)) * MINUTE;
const NAG_MAX = Math.max(0, Number(process.env.NAG_MAX ?? 2));
const TICK_MS = 15_000;

function log(message) {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
}

// A wall-clock phrase («завтра в 9:00») is resolved in the bot's configured
// zone, never the host's, so the instant the cases below are measured from has
// to be noon *there*. On a UTC server whose credentials say TZ=Europe/Moscow
// the two differ by three hours and a correct parse reads as a failure — which
// is exactly what it printed there: 1080 instead of 1260 minutes.
function noonIn(timeZone) {
  const wallClock = (ts) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ts));
    const get = (kind) => Number(parts.find((part) => part.type === kind).value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };
  // The offset depends on the instant, so the instant is solved for twice
  // rather than offset once: the answer is `target - offset(answer)`, and one
  // pass is enough for every zone whose rules do not move between the guess and
  // the answer.
  const target = Date.UTC(2026, 8, 18, 12, 0, 0);
  let at = target;
  for (let pass = 0; pass < 2; pass += 1) at = target - (wallClock(at) - at);
  return at;
}

if (args.includes('--self-test')) {
  const now = noonIn(TIMEZONE);
  const cases = [
    ['через 5 минут забрать посылку', 5 * MINUTE, 'забрать посылку'],
    ['через 2 часа позвонить маме', 2 * HOUR, 'позвонить маме'],
    ['через полчаса чай', 30 * MINUTE, 'чай'],
    ['10м разгрузка', 10 * MINUTE, 'разгрузка'],
    ['завтра в 9:00 встреча', DAY + 9 * HOUR - 12 * HOUR, 'встреча'],
    ['в 18:30 созвон', 6 * HOUR + 30 * MINUTE, 'созвон'],
    ['напомни мне через 3 минуты выключить чайник', 3 * MINUTE, 'выключить чайник'],
  ];
  let failed = 0;
  for (const [phrase, delta, expectRest] of cases) {
    const parsed = parseWhen(phrase, now);
    const ok = parsed && parsed.dueAt - now === delta && parsed.rest === expectRest;
    if (!ok) failed += 1;
    process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${phrase} -> ${parsed ? `${(parsed.dueAt - now) / MINUTE} мин, «${parsed.rest}»` : 'null'}\n`);
  }
  const notTime = ['привет', 'напомни про молоко', '2 яблока'].map((phrase) => parseWhen(phrase, now));
  const noise = notTime.filter(Boolean).length;
  if (noise > 0) failed += 1;
  process.stdout.write(`  ${noise === 0 ? 'ok  ' : 'FAIL'} a phrase without a time stays a phrase without a time\n`);

  // A locale is only as good as its worst missing sentence. A key one table has
  // and another does not reaches the person as the literal word "undefined" in
  // their chat; a word the help teaches and the dispatcher does not know turns
  // the command into a reminder. Neither is visible from the language these
  // tests are written in, so both are checked here for every locale.
  const locales = Object.keys(BOT_I18N);
  const keys = Object.keys(BOT_I18N.ru);
  const labelKeys = Object.keys(BOT_I18N.ru.labels);
  for (const locale of locales) {
    const table = BOT_I18N[locale];
    const missing = keys.filter((key) => table[key] === undefined)
      .concat(Object.keys(table).filter((key) => !keys.includes(key)))
      .concat(keys.filter((key) => typeof table[key] === 'string' && table[key].trim() === '').map((key) => `${key} (empty)`))
      .concat(labelKeys.filter((key) => !table.labels || typeof table.labels[key] !== 'string' || table.labels[key].trim() === '').map((key) => `labels.${key}`));
    if (missing.length > 0) failed += 1;
    process.stdout.write(`  ${missing.length === 0 ? 'ok  ' : 'FAIL'} ${locale} says everything ru says (${keys.length} strings, ${labelKeys.length} labels)${missing.length ? ` — ${missing.join(', ')}` : ''}\n`);
  }

  // The words each help text teaches, in its own words. If one of these is not
  // understood the person gets a reminder named after the command they sent.
  const taught = {
    ru: [['list', 'список'], ['open', '2'], ['delete', 'удали 2'], ['done', 'готово 2'], ['settings', 'настройки'], ['timezone', 'пояс Europe/Moscow'], ['sync', 'sync rmk_abcdefghijklmnopqrstuvwx'], ['help', 'помощь'], ['ack', 'готово'], ['plus', '+10'], ['plus', '+1ч'], ['evening', 'вечером'], ['tomorrow', 'завтра']],
    en: [['list', 'list'], ['open', '2'], ['delete', 'delete 2'], ['done', 'done 2'], ['settings', 'settings'], ['timezone', 'tz Europe/London'], ['sync', 'sync rmk_abcdefghijklmnopqrstuvwx'], ['help', 'help'], ['ack', 'done'], ['plus', '+10'], ['plus', '+1h'], ['evening', 'evening'], ['tomorrow', 'tomorrow']],
    fr: [['list', 'liste'], ['open', '2'], ['delete', 'supprime 2'], ['done', 'fait 2'], ['settings', 'paramètres'], ['timezone', 'tz Europe/Paris'], ['sync', 'sync rmk_abcdefghijklmnopqrstuvwx'], ['help', 'aide'], ['ack', 'fait'], ['plus', '+10'], ['plus', '+1h'], ['evening', 'ce soir'], ['tomorrow', 'demain']],
  };
  for (const [locale, words] of Object.entries(taught)) {
    const unknown = words.filter(([name, phrase]) => !COMMANDS[name].test(phrase)).map(([name, phrase]) => `${name}: «${phrase}»`);
    if (unknown.length > 0) failed += 1;
    process.stdout.write(`  ${unknown.length === 0 ? 'ok  ' : 'FAIL'} ${locale}: everything its help teaches is understood${unknown.length ? ` — ${unknown.join(', ')}` : ''}\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (LOGIN === '' && TOKEN === '') {
  process.stderr.write('TAILCHAT_LOGIN (or TAILCHAT_TOKEN) is required. Try --help.\n');
  process.exit(2);
}

const store = createStore(path.resolve(STATE_FILE));
let sequence = 0;

function ownerOf(reminder) {
  return reminder.ownerId ?? reminder.peer;
}

// The main Remindka database (see ./remindka-sync.mjs). A peer opts in with
// «sync rmk_…»; until then nothing in this file behaves differently.
const sync = createRemindkaSync({
  store,
  ownerOf,
  cadence: { nagMs: NAG_MS, nagMax: NAG_MAX, dayMs: DAY },
  baseUrl: setting('REMINDKA_SYNC_URL') ?? DEFAULT_SYNC_URL,
  log,
});
store.onSave = () => sync.schedule();

function byPeer(peer) {
  return store.reminders.filter((reminder) => ownerOf(reminder) === peer);
}

function isOpen(reminder) {
  return reminder.status !== 'done' && reminder.status !== 'cancelled' && reminder.ackedAt === undefined;
}

function openReminders(peer) {
  return byPeer(peer).filter(isOpen);
}

function createReminder(peer, text, dueAt, extra = {}) {
  sequence += 1;
  const reminder = createReminderRecord({
    id: `${Date.now().toString(36)}-${sequence}`,
    ownerId: peer,
    text,
    dueAt,
    now: Date.now(),
    ...extra,
  });
  store.reminders.push(reminder);
  store.save();
  return reminder;
}

// «на вечер» и «завтра» — the two presets remindka offers next to +10 and +1ч.
// Evening is 19:00 and tomorrow is the next morning at 09:00, and 19:00 that
// has already passed means tomorrow's, because sending somebody back in time is
// not a snooze.
function eveningOf(peer, now = Date.now()) {
  const tz = typeof peer === 'string' ? timezoneOf(peer) : TIMEZONE;
  return presetDue('evening', { timezone: tz, now });
}

function tomorrowMorning(peer, now = Date.now()) {
  const tz = typeof peer === 'string' ? timezoneOf(peer) : TIMEZONE;
  return presetDue('tomorrow', { timezone: tz, now });
}

const client = createBotClient({
  server: SERVER,
  login: LOGIN.toLowerCase(),
  password: PASSWORD,
  token: TOKEN === '' ? null : TOKEN,
  displayName: NAME,
  log,
  onMessage: (peer, frame) => {
    try {
      handleMessage(peer, frame);
    } catch (error) {
      log(`failed to answer ${peer}: ${error.message}`);
    }
  },
  onHello: (peer, frame) => {
    if (frame && typeof frame === 'object') {
      const u = getUser(peer);
      if (!u.manualTz && typeof frame.tz === 'string' && isValidTimezone(frame.tz)) {
        u.tz = frame.tz.trim();
        store.save();
      }
      if (!u.manualLang && typeof frame.lang === 'string') {
        const l = frame.lang.trim().toLowerCase().slice(0, 2);
        if (l === 'ru' || l === 'en' || l === 'fr') {
          u.lang = l;
          store.save();
        }
      }
    }
    showActions(peer);
  },
  onReady: (peer) => showActions(peer),
  onPeers: (peers) => log(`friends: ${peers.join(', ') || 'none yet'}`),
});

// Setup, and deliberately before `client.start()` below: creating the account
// and handing over an invitation are what a first run is, but they are also
// harmless on every later run — which is what makes trying this one command.
// The recovery key is the *only* way to change this account's password later —
// `/register` hands one out and there is no change-password endpoint, `/recover`
// with that key is the whole story. Losing it means the password is whatever it
// was created with, forever, which is a trap worth not walking into silently.
function keepRecoveryKey(key) {
  if (typeof key !== 'string' || key === '') return;
  const file = `${path.resolve(STATE_FILE)}.recovery`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${LOGIN}\n${key}\n`, { mode: 0o600 });
  } catch (error) {
    log(`could not save the recovery key: ${error.message}`);
  }
  process.stdout.write([
    '',
    '  Ключ восстановления — единственный способ сменить пароль позже:',
    `    ${key}`,
    `  Он сохранён в ${file} (только для владельца).`,
    '',
  ].join('\n'));
}

// Writes the credentials this bot will use from now on, so that a first run is
// the only run that needs anything in the environment. 0600 and outside the
// checkout, exactly like the terminal client's own secrets file.
function keepCredentials() {
  if (PASSWORD === '') return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CREDENTIALS_FILE, [
      `# ${NAME} — written by --register. Read-only for its owner; do not commit.`,
      `TAILCHAT_SERVER=${normalizeServer(SERVER)}`,
      `TAILCHAT_LOGIN=${LOGIN}`,
      `TAILCHAT_PASSWORD=${PASSWORD}`,
      `TAILCHAT_NAME=${NAME}`,
      `TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
    log(`credentials written to ${CREDENTIALS_FILE} — later runs need no environment at all`);
  } catch (error) {
    log(`could not write the credentials file: ${error.message}`);
  }
}

async function createAccount() {
  const created = await client.register(NAME);
  log(`account ${LOGIN} created on ${normalizeServer(SERVER)}`);
  keepRecoveryKey(created?.recoveryKey);
  keepCredentials();
  return created;
}

async function setUp() {
  if (WANT_REGISTER || WANT_INVITE) {
    try {
      await createAccount();
    } catch (error) {
      // Running it twice is what an operator does when unsure whether the first
      // attempt worked; the second one must not be the thing that breaks.
      if (error.code === 'login_taken') log(`account ${LOGIN} already exists — nothing to create`);
      else if (error.code === 'bad_credentials') throw new Error(`${LOGIN} exists but the password was refused — check TAILCHAT_PASSWORD`);
      else throw error;
    }
  }

  if (WANT_INVITE) {
    const code = await client.createInvite();
    process.stdout.write([
      '',
      `  Ссылка-приглашение для ${NAME}: ${client.inviteUrl(code)}`,
      '',
      '  Откройте приложение → «Добавить контакт» → вставьте эту ссылку.',
      '  Бот подхватит вас сам, в течение ~10 секунд — перезапускать его не нужно.',
      '',
    ].join('\n'));
  }

  if (WANT_REGISTER) return 'done';

  // On a normal start the account may not exist yet; creating it here is what
  // saves the operator from having to know about `--register` at all.
  if (!WANT_INVITE) {
    try {
      await client.friends();
    } catch (error) {
      if (error.code !== 'bad_credentials') throw error;
      try {
        await createAccount();
      } catch (registerError) {
        if (registerError.code === 'login_taken') {
          throw new Error(`${LOGIN} already exists but the password was refused — check TAILCHAT_PASSWORD`);
        }
        throw registerError;
      }
    }
  }

  if (INVITE !== '') {
    try {
      const friend = await client.acceptInvite(INVITE);
      if (friend) log(`now friends with ${friend.name ?? ''} (${friend.login})`);
    } catch (error) {
      // A code is spent the moment it is accepted; a later run with the same one
      // still in the environment is a restart, not a failure.
      log(`invitation not accepted: ${error.message}`);
    }
  }
  return 'run';
}

try {
  if (await setUp() === 'done') process.exit(0);
} catch (error) {
  // One sentence an operator can act on, instead of a stack trace through
  // three layers of transport: the reason is in the message, and the command
  // is safe to run again.
  process.stderr.write(
    `\nНе удалось подготовить «${LOGIN}» на ${normalizeServer(SERVER)}:\n`
    + `  ${error.message}\n\n`
    + 'Проверьте адрес и сеть, затем запустите ту же команду снова —\n'
    + 'она не создаёт ничего дважды.\n',
  );
  process.exit(1);
}

function actionsFor(peer) {
  const fired = newestOpen(peer);
  const lang = typeof peer === 'string' ? langOf(peer) : 'ru';
  const actions = getReminderActions(lang);
  return fired?.firedAt !== undefined ? actions.fired : actions.idle;
}

function showSettings(peer) {
  const u = getUser(peer);
  const nowTime = formatTimeInZone(u.tz);
  const langNames = { ru: 'Русский 🇷🇺', en: 'English 🇬🇧', fr: 'Français 🇫🇷' };
  const text = u.lang === 'en'
    ? `⚙️ Settings\nLanguage: ${langNames[u.lang] || u.lang}\nTimezone: ${u.tz} (now ${nowTime})\n\nChange timezone: tz Europe/London or tz +3`
    : u.lang === 'fr'
    ? `⚙️ Paramètres\nLangue : ${langNames[u.lang] || u.lang}\nFuseau horaire : ${u.tz} (maintenant ${nowTime})\n\nChanger de fuseau : tz Europe/Paris ou tz +3`
    : `⚙️ Настройки\nЯзык: ${langNames[u.lang] || u.lang}\nЧасовой пояс: ${u.tz} (сейчас ${nowTime})\n\nСменить пояс: пояс Europe/Moscow или пояс +3`;
  const buttons = [
    { id: 'lang:ru', label: '🇷🇺 Русский', value: 'язык ru' },
    { id: 'lang:en', label: '🇬🇧 English', value: 'lang en' },
    { id: 'lang:fr', label: '🇫🇷 Français', value: 'lang fr' },
    { id: 'btn:tz', label: u.lang === 'en' ? '🌍 Timezone' : u.lang === 'fr' ? '🌍 Fuseau' : '🌍 Часовой пояс', value: 'пояс' },
  ];
  reply(peer, text, { buttons });
}

function showActions(peer) {
  client.sendActions(peer, normalizeActions(actionsFor(peer)));
}

function reply(peer, text, extra = {}) {
  const actions = actionsFor(peer);
  const buttons = normalizeActions(actions);
  client.sendText(peer, text, { buttons: buttons.length > 0 ? buttons : undefined, ...extra });
  showActions(peer);
}

// What a forwarded reminder does *not* keep is the picture itself. It keeps
// the id of the message it was forwarded from and asks the conversation for it
// again at the moment it is needed — the same division of labour Telegram's
// `file_id` gives remindka, with one honest difference: Tailchat has no file
// store, so an attachment lives only as long as the conversation's own media
// budget keeps it. When it is gone the receipt says so, instead of a photo
// that never arrives.
async function attachmentsOf(reminder) {
  const ids = Array.isArray(reminder.attachments) ? reminder.attachments : [];
  if (ids.length === 0) return;
  let rows;
  try {
    rows = await client.history(ownerOf(reminder), 500);
  } catch (error) {
    log(`could not read back attachments for ${reminder.id}: ${error.message}`);
    return;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const t = i18nOf(ownerOf(reminder));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      reply(ownerOf(reminder), t.attachmentGone);
      continue;
    }
    if (row.mediaDropped === true) {
      reply(ownerOf(reminder), t.attachmentDropped);
      continue;
    }
    const media = row.image ? { image: row.image } : row.voice ? { voice: row.voice } : null;
    if (media === null) continue;
    client.send(ownerOf(reminder), { t: 'msg', id: `bot-${randomId()}`, text: '', ts: Date.now(), ...media });
  }
}

function deliverReminder(reminder, { nag = false } = {}) {
  // Delivered here, so repeating it is this bot's job again, not another surface's.
  delete reminder.remoteFired;
  delete reminder.remoteNextNagAt;
  reminder.firedAt = Date.now();
  reminder.status = 'fired';
  reminder.lastNagAt = Date.now();
  if (!nag) reminder.nagCount = 0;
  const owner = ownerOf(reminder);
  const t = i18nOf(owner);
  const head = nag ? t.reminderHeadNag : t.reminderHead;
  const source = reminder.source?.name ? t.forwardedFrom(reminder.source.name) : '';
  const buttons = [
    { id: 'done', label: t.labels.done, value: 'готово' },
    { id: 'snooze-10m', label: t.labels.snooze10, value: '+10' },
    { id: 'snooze-1h', label: t.labels.snooze1h, value: '+1ч' },
    { id: 'evening', label: t.labels.evening, value: 'вечером' },
    { id: 'tomorrow', label: t.labels.tomorrow, value: 'завтра' },
  ];
  reply(owner, `${head}\n${reminder.text}${source}${t.reminderFooter}`, { buttons });
  store.save();
  log(`delivered to ${owner}: ${reminder.text}${nag ? ' (repeat)' : ''}`);
  void attachmentsOf(reminder).catch((error) => log(`attachment delivery failed: ${error.message}`));
}

function listOf(peer) {
  const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
  const lang = langOf(peer);
  const t = i18nOf(peer);
  if (open.length === 0) {
    return {
      text: lang === 'en' ? 'No reminders.' : lang === 'fr' ? 'Aucun rappel.' : 'Напоминаний нет.',
      buttons: [
        { id: 'help', label: t.labels.help, value: 'помощь' },
        { id: 'settings', label: t.labels.settings, value: 'настройки' },
      ],
    };
  }
  const lines = open.map((reminder, index) => `${index + 1}. ${reminder.text} — ${formatWhen(reminder.dueAt, peer)}`);
  const header = lang === 'en'
    ? ['Your reminders:', ...lines, '', 'Select a number to manage:'].join('\n')
    : lang === 'fr'
    ? ['Vos rappels :', ...lines, '', 'Sélectionnez un numéro pour gérer :'].join('\n')
    : ['Ваши напоминания:', ...lines, '', 'Выберите номер для управления:'].join('\n');

  const buttons = open.slice(0, 6).map((_, index) => ({
    id: `open:${index + 1}`,
    label: `${index + 1}`,
    value: `${index + 1}`,
  }));
  buttons.push({ id: 'settings', label: t.labels.settings, value: 'настройки' });
  return { text: header, buttons };
}

function showReminderCard(peer, reminder, index) {
  const lang = langOf(peer);
  const t = i18nOf(peer);
  const dueStr = formatWhen(reminder.dueAt, peer);
  const title = lang === 'en'
    ? `⏰ Reminder #${index}:\n${reminder.text}\nDue: ${dueStr}`
    : lang === 'fr'
    ? `⏰ Rappel n°${index} :\n${reminder.text}\nÉchéance : ${dueStr}`
    : `⏰ Напоминание №${index}:\n${reminder.text}\nСрок: ${dueStr}`;

  const buttons = [
    { id: `done:${index}`, label: t.labels.done, value: `готово ${index}` },
    { id: `del:${index}`, label: t.labels.delete, value: `удали ${index}` },
    { id: `snooze-10m:${index}`, label: t.labels.snooze10, value: `отложи ${index} 10м` },
    { id: `snooze-1h:${index}`, label: t.labels.snooze1h, value: `отложи ${index} 1ч` },
    { id: `evening:${index}`, label: t.labels.evening, value: `отложи ${index} вечером` },
    { id: `tomorrow:${index}`, label: t.labels.tomorrow, value: `отложи ${index} завтра` },
    { id: 'btn:list', label: t.labels.list, value: 'список' },
  ];
  reply(peer, title, { buttons });
}

function newestOpen(peer) {
  const open = openReminders(peer).sort((left, right) => (left.firedAt ?? 0) - (right.firedAt ?? 0));
  return open[open.length - 1] ?? null;
}

// A forward is the one message shape that has no other meaning in a chat with
// a bot: «перешлите боту что угодно» is remindka's whole front door, and the
// client's own forward carries the words and the attachment together with who
// wrote them (web/cloud/app.js `forwardMessage`).
const MERGE_WINDOW_MS = 90_000;

function forwardSource(frame) {
  const from = frame.forwardedFrom;
  if (!from || typeof from !== 'object') return null;
  const login = typeof from.login === 'string' ? from.login : '';
  const name = typeof from.name === 'string' ? from.name : '';
  if (login === '' && name === '') return null;
  return { login, name: name || login };
}

function handleForward(peer, frame, source) {
  const t = i18nOf(peer);
  const forwarded = String(frame.text ?? '').trim();
  const parsed = forwarded === '' ? null : parseWhen(forwarded);
  const body = parsed === null ? forwarded : parsed.rest;
  const dueAt = parsed?.dueAt ?? Date.now() + 15 * MINUTE;
  const id = typeof frame.id === 'string' && frame.id !== '' ? frame.id : null;

  // A person forwarding a busted-up conversation forwards it in pieces; those
  // pieces are one reminder, not six (remindka folds them over 90 seconds).
  const recent = [...store.reminders].reverse().find((reminder) => (
    ownerOf(reminder) === peer
    && isOpen(reminder)
    && reminder.firedAt === undefined
    && reminder.source !== undefined
    && Date.now() - reminder.createdAt <= MERGE_WINDOW_MS
  ));
  if (recent) {
    // The pieces are folded onto the first one: the words the later forwards
    // carry would otherwise be dropped on the floor while the person watches
    // them arrive, and an attachment sent with the words would be lost with
    // them.
    if (body !== '') recent.text = recent.text === '' ? body : `${recent.text}\n${body}`;
    if (id !== null) recent.attachments = [...(recent.attachments ?? []), id];
    store.save();
    reply(peer, t.addedTo(formatWhen(recent.dueAt, peer), recent.text));
    return;
  }

  const reminder = createReminder(peer, body === '' ? t.forwardedPlaceholder : body, dueAt, {
    source,
    ...(id === null ? {} : { attachments: [id] }),
  });
  reply(peer, t.saved(formatWhen(reminder.dueAt, peer), reminder.text, source.name ? t.savedFrom(source.name) : ''));
}

const SYNC_OFF = /^(?:off|disable|выкл|откл|отключить|désactiver)$/i;

function syncStatusText(peer) {
  const t = i18nOf(peer);
  const state = sync.stateOf(peer);
  const when = state.lastSyncedAt
    ? formatTimeInZone(timezoneOf(peer), new Date(state.lastSyncedAt))
    : t.syncNever;
  return t.syncStatus(when, state.lastError ? t.syncError(state.lastError) : '');
}

// «sync», «sync rmk_…», «sync off». Asynchronous, because linking is a round
// trip to the server; every path answers, and none of them can throw out of it.
async function handleSync(peer, argument) {
  const t = i18nOf(peer);
  const word = (argument ?? '').trim();
  let linking = false;
  try {
    if (SYNC_OFF.test(word)) {
      reply(peer, sync.unlink(peer) ? t.syncOff : t.syncOffAlready);
      return;
    }
    if (sync.isLinked(peer)) {
      if (word !== '' && sync.stateOf(peer).key !== word) {
        reply(peer, t.syncOtherKey);
        return;
      }
      await sync.syncPeer(peer);
      // «sync off» may have been answered while the round trip was out.
      if (!sync.isLinked(peer)) return;
      reply(peer, syncStatusText(peer));
      return;
    }
    if (word === '') {
      reply(peer, t.syncHowTo);
      return;
    }
    if (!SYNC_KEY_RE.test(word)) {
      reply(peer, t.syncBadKey);
      return;
    }
    linking = true;
    const result = await sync.link(peer, word);
    reply(peer, t.syncOn(result.imported, result.pushed));
  } catch (error) {
    const code = error instanceof SyncError ? error.code : 'http';
    if (!(error instanceof SyncError)) log(`sync command failed for ${peer}: ${error.message}`);
    reply(peer, `⚠️ ${t.syncError(code)}.${linking ? `\n${t.syncNotSaved}` : ''}`);
  }
}

function handleMessage(peer, frame) {
  const text = String(frame.text ?? '').trim();
  if (text === '' && !forwardSource(frame)) return;

  // A forward is never a command, whatever its own words happen to be.
  const source = forwardSource(frame);
  if (source !== null) {
    handleForward(peer, frame, source);
    return;
  }

  const t = i18nOf(peer);
  // An answer to a reminder that has already fired. Checked before anything
  // else: «готово» must never be read as the text of a new reminder.
  const fired = newestOpen(peer);
  const lower = text.toLowerCase();
  if (fired && fired.firedAt !== undefined) {
    if (COMMANDS.ack.test(lower)) {
      fired.ackedAt = Date.now();
      fired.status = 'done';
      store.save();
      reply(peer, t.closed(fired.text));
      return;
    }
    // Evening and tomorrow are remindka's two other snooze choices; the
    // numeric form covers everything else.
    const preset = COMMANDS.evening.test(lower)
      ? 'вечер'
      : (COMMANDS.tomorrow.test(lower) ? 'завтра' : null);
    const snooze = preset === null ? COMMANDS.plus.exec(lower) : null;
    const shift = preset === 'вечер' ? eveningOf(peer) - Date.now()
      : preset === 'завтра' ? tomorrowMorning(peer) - Date.now()
        : null;
    // `snooze` is null for every answer that is not a «+10»-shaped one, and
    // that is most of them: «готово 2», «список», «помощь», or simply the next
    // thing to be reminded of. Reading it unguarded threw before any of those
    // could be handled, so an unanswered fired reminder left the bot mute to
    // everything except «готово», «вечером», «завтра» and «+N» — including the
    // numbered commands its own help text teaches.
    const unitMs = preset !== null ? null
      : (snooze?.[2] === undefined ? MINUTE : unitOf(snooze[2]));
    if (shift !== null || (snooze && (snooze[1] !== undefined || snooze[2] === undefined) && unitMs !== null)) {
      const amount = shift !== null ? null
        : (snooze[1] !== undefined ? Number(snooze[1]) : (unitMs === HOUR ? 1 : 10));
      fired.dueAt = shift !== null ? Date.now() + shift : Date.now() + amount * unitMs;
      fired.firedAt = undefined;
      fired.status = 'scheduled';
      fired.lastNagAt = undefined;
      fired.nagCount = 0;
      const how = preset !== null
        ? t.snoozePreset(preset)
        : t.snoozeRelative(amount, unitMs === HOUR ? 'h' : 'min');
      reply(peer, t.snoozed(how, formatWhen(fired.dueAt, peer), fired.text));
      return;
    }
  }

  // Commands are plain words on purpose. In this client anything beginning
  // with `/` is the *client's* own command and never reaches the peer — `/del`
  // deletes your own messages, `/help` opens the app's help, and an unknown one
  // like `/list` is answered locally with "Unknown command" and dropped. A
  // leading slash is therefore accepted if some client does send one, but it
  // can never be the form the help text teaches.
  const bare = lower.replace(/^\/+/, '').trim();

  const del = COMMANDS.delete.exec(bare);
  const done = COMMANDS.done.exec(bare);
  if (del || done) {
    const index = Number((del ?? done)[1]);
    const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
    const reminder = Number.isInteger(index) && index >= 1 ? open[index - 1] : null;
    if (!reminder) {
      reply(peer, t.notFound(index), {
        buttons: [{ id: 'list', label: t.labels.list, value: 'список' }],
      });
      return;
    }
    if (del) {
      // A linked peer's deletion has to reach the main database as well, so it
      // stays as a tombstone (`cancelled`) until pushed; `tick` then drops it.
      if (sync.isLinked(peer)) reminder.status = 'cancelled';
      else store.reminders.splice(store.reminders.indexOf(reminder), 1);
      store.save();
      reply(peer, t.deleted(reminder.text), {
        buttons: [
          { id: 'list', label: t.labels.list, value: 'список' },
          { id: 'settings', label: t.labels.settings, value: 'настройки' },
        ],
      });
    } else {
      reminder.ackedAt = Date.now();
      reminder.status = 'done';
      store.save();
      reply(peer, t.markedDone(reminder.text), {
        buttons: [
          { id: 'list', label: t.labels.list, value: 'список' },
          { id: 'settings', label: t.labels.settings, value: 'настройки' },
        ],
      });
    }
    return;
  }

  const snoozeIndex = COMMANDS.snooze.exec(bare);
  if (snoozeIndex) {
    const index = Number(snoozeIndex[1]);
    const shiftArg = (snoozeIndex[2] ?? '').trim();
    const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
    const reminder = Number.isInteger(index) && index >= 1 ? open[index - 1] : null;
    if (!reminder) {
      reply(peer, t.notFound(index), {
        buttons: [{ id: 'list', label: t.labels.list, value: 'список' }],
      });
      return;
    }
    const lowerShift = shiftArg.toLowerCase();
    let newDue = null;
    if (/^(?:10м|10мин|\+10|\+?10\s*min|10\s*минут|10\s*мин)$/.test(lowerShift)) {
      newDue = Date.now() + 10 * MINUTE;
    } else if (/^(?:1ч|1час|\+1ч|\+?1\s*h|1\s*час|час)$/.test(lowerShift)) {
      newDue = Date.now() + 1 * HOUR;
    } else if (COMMANDS.evening.test(lowerShift)) {
      newDue = eveningOf(peer);
    } else if (COMMANDS.tomorrow.test(lowerShift)) {
      newDue = tomorrowMorning(peer);
    } else if (shiftArg) {
      const parsedShift = parseWhen(shiftArg, peer);
      if (parsedShift) newDue = parsedShift.dueAt;
    }
    if (newDue) {
      reminder.dueAt = newDue;
      reminder.firedAt = undefined;
      reminder.status = 'scheduled';
      reminder.lastNagAt = undefined;
      reminder.nagCount = 0;
      store.save();
      reply(peer, t.snoozedIndex(index, formatWhen(reminder.dueAt, peer), reminder.text), {
        buttons: [
          { id: `done:${index}`, label: t.labels.done, value: `готово ${index}` },
          { id: `del:${index}`, label: t.labels.delete, value: `удали ${index}` },
          { id: 'btn:list', label: t.labels.list, value: 'список' },
        ],
      });
      return;
    }
  }

  const openItem = COMMANDS.open.exec(bare);
  if (openItem) {
    const index = Number(openItem[1]);
    const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
    const reminder = Number.isInteger(index) && index >= 1 ? open[index - 1] : null;
    if (reminder) {
      showReminderCard(peer, reminder, index);
      return;
    }
    reply(peer, t.notFound(index), {
      buttons: [{ id: 'list', label: t.labels.list, value: 'список' }],
    });
    return;
  }

  if (COMMANDS.list.test(bare)) {
    const list = listOf(peer);
    reply(peer, list.text, { buttons: list.buttons });
    return;
  }

  if (COMMANDS.help.test(bare)) {
    reply(peer, t.help);
    return;
  }

  if (COMMANDS.settings.test(bare)) {
    showSettings(peer);
    return;
  }

  // Not `bare`: that is lower-cased, and a key is case-sensitive.
  const syncMatch = COMMANDS.sync.exec(text.replace(/^\/+/, '').trim());
  if (syncMatch) {
    handleSync(peer, syncMatch[1]).catch((error) => log(`sync command failed for ${peer}: ${error.message}`));
    return;
  }

  const langMatch = COMMANDS.language.exec(bare);
  if (langMatch) {
    const code = langMatch[1]?.toLowerCase();
    if (code === 'ru' || code === 'en' || code === 'fr') {
      const u = getUser(peer);
      u.lang = code;
      u.manualLang = true;
      store.save();
      const langNames = { ru: 'Русский 🇷🇺', en: 'English 🇬🇧', fr: 'Français 🇫🇷' };
      const nowTime = formatTimeInZone(u.tz);
      const msg = code === 'en'
        ? `Language set to: ${langNames[code]}\nTimezone: ${u.tz} (now ${nowTime})`
        : code === 'fr'
        ? `Langue définie sur : ${langNames[code]}\nFuseau horaire : ${u.tz} (maintenant ${nowTime})`
        : `Язык установлен: ${langNames[code]}\nЧасовой пояс: ${u.tz} (сейчас ${nowTime})`;
      reply(peer, msg);
      return;
    }
    showSettings(peer);
    return;
  }

  const tzMatch = COMMANDS.timezone.exec(bare);
  if (tzMatch) {
    const query = tzMatch[1]?.trim();
    if (query) {
      const resolved = resolveTimezone(query);
      if (resolved) {
        const u = getUser(peer);
        u.tz = resolved;
        u.manualTz = true;
        store.save();
        const nowTime = formatTimeInZone(resolved);
        const msg = u.lang === 'en'
          ? `🌍 Timezone set to: ${resolved} (now ${nowTime})`
          : u.lang === 'fr'
          ? `🌍 Fuseau horaire défini sur : ${resolved} (maintenant ${nowTime})`
          : `🌍 Часовой пояс установлен: ${resolved} (сейчас ${nowTime})`;
        reply(peer, msg);
        return;
      }
      const u = getUser(peer);
      const errMsg = u.lang === 'en'
        ? `Unknown timezone "${query}". Example: /tz Europe/London or /tz +3`
        : u.lang === 'fr'
        ? `Fuseau horaire inconnu "${query}". Exemple : /tz Europe/Paris ou /tz +3`
        : `Неизвестный часовой пояс «${query}». Пример: /tz Europe/Moscow или /tz +3`;
      reply(peer, errMsg);
      return;
    }
    const u = getUser(peer);
    const nowTime = formatTimeInZone(u.tz);
    const infoMsg = u.lang === 'en'
      ? `🌍 Current timezone: ${u.tz} (now ${nowTime})\nTo change it, send:\ntz Europe/London\ntz America/New_York\ntz +3`
      : u.lang === 'fr'
      ? `🌍 Fuseau horaire actuel : ${u.tz} (maintenant ${nowTime})\nPour le modifier, envoyez :\ntz Europe/Paris\ntz America/Montreal\ntz +3`
      : `🌍 Текущий часовой пояс: ${u.tz} (сейчас ${nowTime})\nЧтобы сменить пояс, отправьте:\nпояс Europe/Moscow\nпояс Asia/Almaty\nпояс +3`;
    reply(peer, infoMsg);
    return;
  }


  // «готово» with nothing to close is not a new reminder called «готово» — and
  // with something to close it has to close it: after «+10» the reminder is
  // open again but no longer fired, so the branch above cannot have taken it,
  // and answering «открытых напоминаний нет» while one is coming back at 19:00
  // is a lie the person pays for by being reminded anyway.
  if (COMMANDS.close.test(bare)) {
    const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
    if (open.length === 1) {
      open[0].ackedAt = Date.now();
      open[0].status = 'done';
      store.save();
      reply(peer, t.closed(open[0].text));
      return;
    }
    // Several open and none fired: which one was meant is a guess, and a wrong
    // guess throws away a reminder somebody still wants. Numbers, not guesses.
    reply(peer, open.length === 0 ? t.nothingToClose : t.severalOpenToClose(open.length));
    return;
  }

  // Waiting for the text of a reminder whose time was already given.
  const pendingAt = store.pending[peer];
  if (pendingAt !== undefined) {
    delete store.pending[peer];
    const reminder = createReminder(peer, text, pendingAt);
    reply(peer, t.saved(formatWhen(reminder.dueAt, peer), reminder.text));
    return;
  }

  const parsed = parseWhen(text, peer);
  if (parsed && parsed.rest !== '') {
    const reminder = createReminder(peer, parsed.rest, parsed.dueAt);
    const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
    const index = open.indexOf(reminder) + 1 || open.length;
    const buttons = [
      { id: `snooze-1h:${index}`, label: t.labels.snooze1h, value: `отложи ${index} 1ч` },
      { id: `evening:${index}`, label: t.labels.evening, value: `отложи ${index} вечером` },
      { id: `tomorrow:${index}`, label: t.labels.tomorrow, value: `отложи ${index} завтра` },
      { id: `del:${index}`, label: t.labels.delete, value: `удали ${index}` },
      { id: 'btn:list', label: t.labels.list, value: 'список' },
    ];
    reply(peer, t.saved(formatWhen(reminder.dueAt, peer), reminder.text), { buttons });
    return;
  }
  if (parsed && parsed.rest === '') {
    store.pending[peer] = parsed.dueAt;
    store.save();
    reply(peer, t.whatToRemind(formatWhen(parsed.dueAt, peer)));
    return;
  }

  const reminder = createReminder(peer, text, Date.now() + 15 * MINUTE);
  const open = openReminders(peer).sort((left, right) => left.dueAt - right.dueAt);
  const index = open.indexOf(reminder) + 1 || open.length;
  const buttons = [
    { id: `snooze-1h:${index}`, label: t.labels.snooze1h, value: `отложи ${index} 1ч` },
    { id: `evening:${index}`, label: t.labels.evening, value: `отложи ${index} вечером` },
    { id: `tomorrow:${index}`, label: t.labels.tomorrow, value: `отложи ${index} завтра` },
    { id: `del:${index}`, label: t.labels.delete, value: `удали ${index}` },
    { id: 'btn:list', label: t.labels.list, value: 'список' },
  ];
  reply(peer, t.noTimeDefault(reminder.text), { buttons });
}

// What the clock now asks of a reminder: deliver it, repeat it, or nothing.
function dueAction(reminder, now) {
  if (!isOpen(reminder)) return null;
  if (reminder.firedAt === undefined) return reminder.dueAt <= now ? 'due' : null;
  // Another surface delivered it and repeats it; see `reminderFromRemote`.
  if (reminder.remoteFired) return null;
  // Quick repeats first, then once a day until somebody answers: remindka's
  // cadence, and the reason a reminder that fired into a sleeping phone is
  // still there in the morning rather than having been said once to nobody.
  if (NAG_MAX > 0 && reminder.nagCount < NAG_MAX && now - reminder.lastNagAt >= NAG_MS) return 'nag';
  if (reminder.nagCount >= NAG_MAX && now - reminder.lastNagAt >= DAY) return 'daily';
  return null;
}

function tickNow() {
  const now = Date.now();
  for (const reminder of [...store.reminders]) {
    const action = dueAction(reminder, now);
    if (action === 'due') {
      deliverReminder(reminder);
    } else if (action === 'nag') {
      reminder.nagCount += 1;
      deliverReminder(reminder, { nag: true });
    } else if (action === 'daily') {
      deliverReminder(reminder, { nag: true });
    }
  }
  // Acknowledged reminders are kept briefly so «что я закрыл?» has an answer,
  // then dropped: this file is the bot's whole memory and it should not grow
  // without bound. One the main database has not heard about yet is kept
  // however old it is, or a deletion could vanish before it was pushed.
  const cutoff = now - DAY;
  const kept = store.reminders.filter((reminder) => isOpen(reminder) || reminder.ackedAt > cutoff || sync.isPending(reminder));
  if (kept.length !== store.reminders.length) {
    store.reminders.splice(0, store.reminders.length, ...kept);
    store.save();
  }
}

// Another surface (the Telegram bot, the app) may have delivered a reminder
// since the last sync; asking first is what keeps one reminder from arriving
// twice. Bounded, so an unreachable server delays a delivery by seconds, not
// until it comes back.
const SYNC_BEFORE_DELIVERY_MS = 5000;
let ticking = false;
async function runTick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const stale = sync.linkedPeers().filter((peer) => byPeer(peer).some((reminder) => dueAction(reminder, now) !== null));
    if (stale.length > 0) {
      await Promise.race([
        Promise.all(stale.map((peer) => sync.syncPeer(peer))),
        new Promise((resolve) => setTimeout(resolve, SYNC_BEFORE_DELIVERY_MS).unref?.()),
      ]);
    }
    tickNow();
  } finally {
    ticking = false;
  }
}
const tick = setInterval(() => { void runTick(); }, TICK_MS);
// Not unref'd: this interval is the bot's reason to be running at all.

log(`reminder bot starting — server ${normalizeServer(SERVER)}, tz ${Intl.DateTimeFormat().resolvedOptions().timeZone}, state ${path.resolve(STATE_FILE)}`);
// Two different leftovers, and conflating them made the log lie: a reminder
// whose time passed while the bot was down is about to be sent (catch-up),
// while one that already went out and was never answered is about to be
// repeated. Only the first is "overdue".
const openAtBoot = store.reminders.filter(isOpen);
const overdueAtBoot = openAtBoot.filter((reminder) => reminder.firedAt === undefined && reminder.dueAt <= Date.now());
const awaitingAnswer = openAtBoot.filter((reminder) => reminder.firedAt !== undefined && !reminder.remoteFired);
if (overdueAtBoot.length > 0) log(`${overdueAtBoot.length} reminder(s) came due while the bot was down — sending on the first tick`);
if (awaitingAnswer.length > 0) log(`${awaitingAnswer.length} reminder(s) went out and were never answered — they will be repeated until «готово»`);
sync.start();
await client.start();

const shutdown = () => {
  log('shutting down');
  clearInterval(tick);
  sync.stop();
  client.stop();
  store.saveNow();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
