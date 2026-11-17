import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

const HOUR_WORDS = {
  час: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
  семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
};

const ACTION_LIMIT = 8;
const ACTION_ID_MAX = 40;
const ACTION_LABEL_MAX = 40;
const ACTION_VALUE_MAX = 200;

function applyMeridiem(hour, part) {
  if (!part) return hour;
  const value = part.toLowerCase();
  if (['дня', 'днём', 'днем', 'вечера'].includes(value)) return hour < 12 ? hour + 12 : hour;
  if (value === 'ночи' || value === 'утра') return hour === 12 ? 0 : hour;
  return hour;
}

function normalizeRu(value) {
  let out = value
    .replace(/^(\d+)\s*(м|ч|д)(?=\s|$)/i, (_match, amount, unit) => (
      `через ${amount} ${{ м: 'минут', ч: 'часов', д: 'дней' }[unit.toLowerCase()]}`
    ))
    .replace(/через\s+пол\s?часа/gi, 'через 30 минут')
    .replace(/через\s+полтора\s+часа/gi, 'через 90 минут')
    .replace(/через\s+час(?![а-яё])/gi, 'через 1 час')
    .replace(/через\s+минуту/gi, 'через 1 минуту')
    .replace(/через\s+день/gi, 'через 1 день')
    .replace(/через\s+неделю/gi, 'через 1 неделю')
    .replace(/через\s+месяц/gi, 'через 1 месяц')
    .replace(/послезавтра/gi, 'через 2 дня');

  const numWord = 'два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать';
  out = out.replace(
    new RegExp(`(?<![а-яё])в\\s+(\\d{1,2}|${numWord})\\s+час(?:а|ов)(?![а-яё])(?:\\s+(дня|дн[её]м|ночи|утра|вечера))?`, 'gi'),
    (_match, hour, part) => {
      const base = /^\d/.test(hour) ? Number.parseInt(hour, 10) : HOUR_WORDS[hour.toLowerCase()];
      return `в ${String(applyMeridiem(base, part)).padStart(2, '0')}:00`;
    },
  );
  return out.replace(
    /(?<![а-яё])в\s+час(?![а-яё])(?:\s+(дня|дн[её]м|ночи|утра|вечера))?/gi,
    (_match, part) => `в ${String(part ? applyMeridiem(1, part) : 13).padStart(2, '0')}:00`,
  );
}

const LEAD_PUNCT = /^[\s,.:;!—–-]+/;
const LEAD_WORD = /^(?:напомни(?:ть)?(?:\s+мне)?|напомнишь|remind(?:\s+me)?(?:\s+to)?|rappelle(?:-moi)?|rappeler|me\s+rappeler|heures?|мне|пожалуйста|please|s['’]il\s+te\s+pla[iî]t|про|о|об|обо|что|that|to|de|d['’]|и)(?=[\s,.:;!]|$)/i;
const TAIL = /(?:\s+(?:пожалуйста|please|s['’]il\s+te\s+pla[iî]t|напомни(?:ть)?|rappelle(?:-moi)?))?[\s,.:;!—–-]*$/i;

function cleanText(value) {
  let out = value.replace(/\s+/g, ' ').trim();
  let previous = '';
  while (previous !== out) {
    previous = out;
    out = out
      .replace(LEAD_PUNCT, '')
      .replace(/^(?:d|l)['’](?=\p{L})/iu, '')
      .replace(LEAD_WORD, '')
      .trim();
  }
  return out.replace(TAIL, '').trim();
}

/** Явная часть суток в найденной фразе («вечером», «tonight», «ce soir») — час уже выбран самим пользователем. */
const PART_OF_DAY = /утр|днём|днем|вечер|ноч|полдень|полночь|morning|afternoon|evening|night|noon|midnight|matin|soir|midi|nuit/i;

/**
 * Parse natural-language reminder input without depending on any chat transport.
 * `defaultHour` (0–23, необязательно): час для дат БЕЗ указанного времени («10 октября», «в пятницу»,
 * «послезавтра», «через 2 дня»). Без него поведение прежнее (час подставляет chrono — 12:00 или текущее время).
 */
export function parseReminder(input, { timezone = 'UTC', now = Date.now(), locale, defaultHour } = {}) {
  const dayHour = Number.isInteger(defaultHour) && defaultHour >= 0 && defaultHour <= 23 ? defaultHour : null;
  const reference = DateTime.fromMillis(Number(now), { zone: timezone });
  if (!reference.isValid) return null;
  const raw = String(input ?? '').trim();
  if (raw === '') return null;
  const hasCyrillic = /[а-яё]/i.test(raw);
  const looksFrench = /\b(?:aujourd['’]hui|demain|apr[eè]s-demain|dans|heure|heures|minute|minutes|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|rappelle|rappeler|soir|matin)\b/i.test(raw);
  const selectedLocale = locale ?? (hasCyrillic ? 'ru' : looksFrench ? 'fr' : 'en');
  const text = selectedLocale === 'ru' ? normalizeRu(raw) : raw;
  const ref = { instant: reference.toJSDate(), timezone: reference.offset };
  const parsers = selectedLocale === 'ru'
    ? [chrono.ru, chrono, chrono.fr]
    : selectedLocale === 'fr'
      ? [chrono.fr, chrono, chrono.ru]
      : [chrono, chrono.fr, chrono.ru];
  let results = [];
  for (const parser of parsers) {
    results = parser.parse(text, ref, { forwardDate: true });
    if (results.length > 0) break;
  }
  if (results.length === 0) return null;

  const first = results[0];
  let due = DateTime.fromJSDate(first.date()).setZone(timezone);
  const strips = [{ index: first.index, length: first.text.length }];
  const matched = [first.text];

  if (!first.start.isCertain('hour')) {
    const timePart = results.find((item) => item !== first
      && item.start.isCertain('hour')
      && !item.start.isCertain('day')
      && !item.start.isCertain('weekday'));
    if (timePart) {
      const clock = DateTime.fromJSDate(timePart.date()).setZone(timezone);
      due = due.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
      if (due <= reference && !timePart.start.isCertain('meridiem') && due.hour < 12) due = due.plus({ hours: 12 });
      if (due <= reference) due = due.plus({ days: 1 });
      strips.push({ index: timePart.index, length: timePart.text.length });
      matched.push(timePart.text);
    } else if (/^(?:завтра|tomorrow|demain)$/i.test(first.text.trim())) {
      due = due.set({ hour: dayHour ?? 9, minute: 0, second: 0, millisecond: 0 });
    } else if (dayHour !== null && !PART_OF_DAY.test(first.text)) {
      // Только дата: утро вместо chrono-полудня. Если выбранный час сегодня уже прошёл — оставляем прежнее значение.
      const morning = due.set({ hour: dayHour, minute: 0, second: 0, millisecond: 0 });
      if (morning > reference.plus({ seconds: 5 })) due = morning;
    }
  } else if (!first.start.isCertain('meridiem') && !first.start.isCertain('day') && !first.start.isCertain('weekday')) {
    const hour = due.hour;
    if (hour >= 1 && hour <= 11) {
      const evening = reference.set({ hour: hour + 12, minute: due.minute, second: 0, millisecond: 0 });
      due = reference < evening
        ? evening
        : reference.plus({ days: 1 }).set({ hour, minute: due.minute, second: 0, millisecond: 0 });
    }
  }

  if (!due.isValid || due <= reference.plus({ seconds: 5 })) return null;
  let rest = text;
  for (const strip of strips.sort((left, right) => right.index - left.index)) {
    rest = `${rest.slice(0, strip.index)} ${rest.slice(strip.index + strip.length)}`;
  }
  return { text: cleanText(rest), dueAt: due.toMillis(), matched: matched.join(' … ') };
}

export function presetDue(code, { timezone = 'UTC', now = Date.now() } = {}) {
  const reference = DateTime.fromMillis(Number(now), { zone: timezone });
  if (!reference.isValid) return null;
  if (code === '15m') return reference.plus({ minutes: 15 }).toMillis();
  if (code === '1h') return reference.plus({ hours: 1 }).toMillis();
  if (code === 'evening') {
    let due = reference.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
    if (due <= reference) due = due.plus({ days: 1 });
    return due.toMillis();
  }
  if (code === 'tomorrow' || code === 'tom9') {
    return reference.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toMillis();
  }
  return null;
}

export function formatWhen(timestamp, { locale = 'ru', timezone = 'UTC', now = Date.now() } = {}) {
  const reference = DateTime.fromMillis(Number(now), { zone: timezone });
  const due = DateTime.fromMillis(Number(timestamp), { zone: timezone }).setLocale(locale);
  if (!reference.isValid || !due.isValid) return null;
  const day = due.hasSame(reference, 'day') ? 'today'
    : due.hasSame(reference.plus({ days: 1 }), 'day') ? 'tomorrow' : 'other';
  return {
    day,
    label: due.toFormat('ccc, d MMMM'),
    time: due.toFormat('HH:mm'),
    relative: due.toRelative({ base: reference.setLocale(locale) }) ?? '',
  };
}

/** Stable, transport-neutral reminder record. Adapters own storage and delivery. */
export function createReminder({ id, ownerId, text, dueAt, now = Date.now(), ...metadata }) {
  if (typeof id !== 'string' || id === '') throw new TypeError('reminder id is required');
  if (typeof ownerId !== 'string' || ownerId === '') throw new TypeError('reminder ownerId is required');
  const when = Number(dueAt);
  if (!Number.isFinite(when)) throw new TypeError('reminder dueAt must be finite');
  return {
    id,
    ownerId,
    text: String(text ?? '').trim() || 'Reminder',
    dueAt: when,
    status: 'scheduled',
    createdAt: Number(now),
    ...metadata,
  };
}

/** Validate the small action model before a transport serializes it. */
export function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const candidate of actions) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = String(candidate.id ?? '').trim();
    const label = String(candidate.label ?? '').trim();
    const value = String(candidate.value ?? '').trim();
    if (!id || id.length > ACTION_ID_MAX || !label || label.length > ACTION_LABEL_MAX || !value || value.length > ACTION_VALUE_MAX) continue;
    out.push({ id, label, value });
    if (out.length === ACTION_LIMIT) break;
  }
  return out;
}

export function getReminderActions(locale = 'ru') {
  const lang = locale === 'fr' ? 'fr' : locale === 'en' ? 'en' : 'ru';
  if (lang === 'en') {
    return {
      idle: [
        { id: 'list', label: '📋 List', value: 'list' },
        { id: 'help', label: '❓ Help', value: 'help' },
        { id: 'settings', label: '⚙️ Settings', value: 'settings' },
      ],
      fired: [
        { id: 'done', label: '✅ Done', value: 'done' },
        { id: 'snooze-10m', label: '+10 min', value: '+10m' },
        { id: 'snooze-1h', label: '+1 hour', value: '+1h' },
        { id: 'evening', label: 'Evening', value: 'evening' },
        { id: 'tomorrow', label: 'Tomorrow', value: 'tomorrow' },
      ],
    };
  }
  if (lang === 'fr') {
    return {
      idle: [
        { id: 'list', label: '📋 Liste', value: 'liste' },
        { id: 'help', label: '❓ Aide', value: 'aide' },
        { id: 'settings', label: '⚙️ Paramètres', value: 'paramètres' },
      ],
      fired: [
        { id: 'done', label: '✅ Fait', value: 'fait' },
        { id: 'snooze-10m', label: '+10 min', value: '+10m' },
        { id: 'snooze-1h', label: '+1 h', value: '+1h' },
        { id: 'evening', label: 'Ce soir', value: 'ce soir' },
        { id: 'tomorrow', label: 'Demain', value: 'demain' },
      ],
    };
  }
  return {
    idle: [
      { id: 'list', label: '📋 Список', value: 'список' },
      { id: 'help', label: '❓ Помощь', value: 'помощь' },
      { id: 'settings', label: '⚙️ Настройки', value: 'настройки' },
    ],
    fired: [
      { id: 'done', label: '✅ Готово', value: 'готово' },
      { id: 'snooze-10m', label: '+10 мин', value: '+10' },
      { id: 'snooze-1h', label: '+1 час', value: '+1ч' },
      { id: 'evening', label: 'Вечером', value: 'вечером' },
      { id: 'tomorrow', label: 'Завтра', value: 'завтра' },
    ],
  };
}

export const REMINDER_ACTIONS = Object.freeze(getReminderActions('ru'));
