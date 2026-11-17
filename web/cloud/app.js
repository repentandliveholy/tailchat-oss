/*
 * Веб-клиент облачного Tailchat.
 * Полный набор терминальных команд (/help, /clear, /theme, /ping, /logo, /holiday,
 * /saver, /wake, /sound, /typing, /happy, /sad, /neutral, /asc, /code, /nick, /time,
 * /history, /version, /status, /del, /voice, /send, /lang, /reconnect, /quit),
 * палитра автодополнения слэш-команд, Web Audio звуковые эффекты, Matrix screensaver,
 * переключатель тем (Green, Amber, Blue, Matrix, Mono, Paper) и голосовые сообщения.
 */

const TOKEN_KEY = 'tailchat-cloud-token';
const LANG_KEY = 'tailchat-cloud-lang';
const THEME_KEY = 'tailchat-cloud-theme';
const THEME_CHOSEN_KEY = 'tailchat-cloud-theme-chosen';
const MODE_KEY = 'tailchat-cloud-mode';
const FONT_KEY = 'tailchat-cloud-font';
const FONT_CHOSEN_KEY = 'tailchat-cloud-font-chosen';
const ROUND_KEY = 'tailchat-cloud-round';
const BORDERS_KEY = 'tailchat-cloud-borders';
const DEPTH_KEY = 'tailchat-cloud-depth';
const WALLPAPER_KEY = 'tailchat-cloud-wallpaper';
const WALLPAPER_CHOSEN_KEY = 'tailchat-cloud-wallpaper-chosen';
const SOUND_KEY = 'tailchat-cloud-sound';
const SEND_SOUND_KEY = 'tailchat-cloud-sound-send';
const VOLUME_KEY = 'tailchat-cloud-volume';
// Only the file *name* of a custom cue: the audio itself lives in IndexedDB
// (see SOUND_DB_NAME), so the settings row can show what is loaded without
// waiting for a database to open — or reading a megabyte to print a label.
const SOUND_FILE_KEY = 'tailchat-cloud-sound-file';
const NOTIFY_KEY = 'tailchat-cloud-notify';
const MUTED_CONTACTS_KEY = 'tailchat-cloud-muted-contacts';
// This browser's stable push identity (see `pushDeviceId`): kept in
// localStorage, so it survives reloads and outlives any single push endpoint
// the browser's push service hands out.
const DEVICE_ID_KEY = 'tailchat-device-id';
const TYPING_KEY = 'tailchat-cloud-typing';
const HOLIDAY_KEY = 'tailchat-cloud-holiday';
const LINK_PREVIEW_KEY = 'tailchat-cloud-link-preview';
const SHOW_DELETED_KEY = 'tailchat-cloud-show-deleted';
const QUICK_REACTIONS_KEY = 'tailchat-cloud-quick-reactions';
const EMOJI_RECENT_KEY = 'tailchat-cloud-emoji-recent';
const ROSTER_ON_KEY = 'tailchat-cloud-roster-on';
const ROSTER_W_KEY = 'tailchat-cloud-roster-w';
const INFO_ON_KEY = 'tailchat-cloud-info-on';

const API = '/tailchat/api';
const OFFICIAL_ACCOUNT_LOGIN = 'tailchat';
// A phone that was backgrounded for a second comes back to a dead socket, and
// every second spent waiting is a second the other side is shown «был(а) …»
// for someone who is sitting right there. Reconnect fast, back off slowly.
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
// How often the tab checks that the socket is still carrying anything, and how
// long a silence has to last before the socket is presumed dead. The probe is
// `who`, which the hub answers with a `users` payload and deliberately does not
// rate-limit — so a quiet conversation still produces the traffic this check
// needs, without inventing a protocol frame for it. The timeout is comfortably
// past the server's own 30s heartbeat, so a merely idle link is never dropped.
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_SILENCE_MS = 45_000;
const TYPING_REPEAT_MS = 3000;
const TYPING_IDLE_MS = 2500;
const TYPING_EXPIRE_MS = 8000;
const PING_TIMEOUT_MS = 10_000;
const WIDE_QUERY = '(min-width: 720px)';
const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// Версия веб-клиента. `index.html` подставляет её в `?v=` к app.css/app.js
// (AGENTS.md rule 7), поэтому она читается оттуда, а не хранится здесь второй
// копией, которая рано или поздно разойдётся с package.json.
const APP_VERSION = (() => {
  try {
    const sheet = document.querySelector('link[rel="stylesheet"]');
    return sheet ? (new URL(sheet.href, location.href).searchParams.get('v') || '') : '';
  } catch {
    return '';
  }
})();

const ROSTER_W_MIN = 220;
const ROSTER_W_MAX = 460;
const ROSTER_W_DEFAULT = 288;
const ROSTER_W_STEP = 16;
const INFO_AUTO_OPEN_WIDTH = 1100;

const INFO_W_KEY = 'tailchat-cloud-info-w';
const INFO_W_MIN = 236;
const INFO_W_MAX = 480;
const INFO_W_DEFAULT = 236;
const INFO_W_STEP = 16;

// Cloud media is inline base64 in a single frame and is kept in account
// history, so the ceiling here is the same 10 MiB as `src/cloud/limits.js`.
// At the bitrate below that is well over three hours of speech; the
// ten-minute cap below is a courtesy to the person listening, not a
// transport limit — it is also the server's own clamp
// (`src/cloud/accounts.js` normalizeMedia), so a client cannot promise a
// longer note than the server will actually keep.
const VOICE_MAX_SEC = 600;
// 12 kbit/s Opus is intelligible but thin, and it left no headroom at all for a
// quiet room. 24 is still tiny — ten minutes, the cap above, is under two
// megabytes — and it is the difference between a voice note that sounds recorded
// and one that sounds broken.
const VOICE_AUDIO_BITS_PER_SEC = 24_000;
// Below this, every sample of a recording is indistinguishable from digital
// silence. Deliberately not a "too quiet" threshold: this is about a
// microphone that captured nothing at all, not one that captured a whisper.
const VOICE_SILENCE_FLOOR = 0.005;
// How long the recording bar holds a failure before closing itself. Long
// enough to read a sentence, short enough not to be in the way.
const VOICE_PROBLEM_MS = 4000;
const CLOUD_MEDIA_MAX_CHARS = 10 * 1024 * 1024;
const CLOUD_VOICE_MAX_DATA_URL_CHARS = CLOUD_MEDIA_MAX_CHARS - 1024;
// Leaves room for the frame's own JSON around the data URL.
const CLOUD_INLINE_MEDIA_SAFE_CHARS = CLOUD_MEDIA_MAX_CHARS - 8 * 1024;
const VOICE_METER_BARS = 24;
const VOICE_WAVE_BARS = 36;
// Cycled by the speed button on every voice-message player. Persisted across
// reloads (see VOICE_SPEED_KEY) so the choice sticks for the whole session,
// the way it does in every other chat app people already know.
const VOICE_SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const VOICE_SPEED_KEY = 'tailchat-cloud-voice-speed';
// Pasted and attached images are re-encoded rather than sent verbatim: a phone
// camera JPEG is mostly EXIF and sensor noise at display size. 2560 px on the
// long side is a retina-sharp full-screen view on any device the web client
// runs on, and quality 0.92 is the point where WebP stops showing ringing on
// screenshots of text — the previous 800 px / 0.75 was visibly mushy.
const IMAGE_MAX_DIM = 2560;
const IMAGE_QUALITY = 0.92;
const FILE_CHUNK_BYTES = 48 * 1024;
const FILE_MAX_BYTES = 100 * 1024 * 1024;
const FILE_MAX_TRANSFERS = 8;
const FILE_MAX_BUFFERED_BYTES = 256 * 1024 * 1024;
// The server truncates a deletion frame to this many ids (`DEL_MAX_IDS` in
// `src/cloud/hub.js`), so `/del n` refuses anything the hub would silently
// cut in half.
const DEL_MAX_IDS = 200;
// Mirrors `src/presence.js`: the terminal client reports itself idle after
// half a minute without a keystroke and away after five, and the roster is
// only honest if every client agrees on those two numbers.
const IDLE_AFTER_MS = 30 * 1000;
const AWAY_AFTER_MS = 5 * 60 * 1000;


const RENDERED_FRAMES = new Set(['msg', 'ai']);

// --- Команды терминала ---------------------------------------------------

const COMMANDS = [
  { name: '/help', alias: '/h', help: { ru: 'Показать список команд и горячих клавиш', en: 'Show commands list and shortcuts', fr: 'Afficher la liste des commandes' } },
  { name: '/clear', alias: '/c', help: { ru: 'Очистить переписку на экране', en: 'Clear chat view', fr: 'Effacer l’affichage' } },
  { name: '/theme', alias: '/t', args: '[green|amber|blue|matrix|mono|paper]', help: { ru: 'Сменить тему оформления', en: 'Change color theme', fr: 'Changer le thème' } },
  { name: '/mode', alias: '/m', args: '[auto|light|dark]', help: { ru: 'Светлая или тёмная тема', en: 'Light or dark appearance', fr: 'Apparence claire ou sombre' } },
  { name: '/settings', alias: '/s', help: { ru: 'Открыть настройки приложения', en: 'Open app settings', fr: 'Ouvrir les réglages' } },
  { name: '/ping', alias: '/p', help: { ru: 'Проверить пинг и задержку связи', en: 'Measure latency', fr: 'Mesurer la latence' } },
  { name: '/logo', alias: '', help: { ru: 'Показать анимированный ASCII-логотип Tailchat', en: 'Show Tailchat ASCII logo', fr: 'Afficher le logo ASCII' } },
  { name: '/holiday', alias: '', args: '[on|off]', help: { ru: 'Переключить праздничный режим', en: 'Toggle holiday mode', fr: 'Basculer le mode vacances' } },
  { name: '/saver', alias: '', help: { ru: 'Запустить скринсейвер Matrix', en: 'Run Matrix screensaver', fr: 'Lancer l’économiseur Matrix' } },
  { name: '/wake', alias: '/w', help: { ru: 'Отправить сигнал внимания собеседнику (звонок+вспышка)', en: 'Send wake signal to peer', fr: 'Envoyer un signal d’attention' } },
  { name: '/ai', alias: '/ask', args: '<question>', help: { ru: 'Задать вопрос AI-ассистенту (Tailik)', en: 'Ask AI assistant (Tailik)', fr: 'Poser une question à l’assistant IA' } },
  { name: '/paste', alias: '', help: { ru: 'Вставить скриншот или текст из буфера обмена (Ctrl+V)', en: 'Paste screenshot or text from clipboard (Ctrl+V)', fr: 'Coller une capture d’écran ou du texte (Ctrl+V)' } },
  { name: '/notify', alias: '', args: '[on|off]', help: { ru: 'Включить/выключить системные уведомления', en: 'Toggle system notifications', fr: 'Activer/désactiver les notifications' } },
  { name: '/sound', alias: '', args: '[on|off]', help: { ru: 'Включить/выключить звуки [on|off]', en: 'Toggle sound effects', fr: 'Activer/désactiver les sons' } },
  { name: '/typing', alias: '', args: '[on|off]', help: { ru: 'Включить/выключить отправку статуса набора', en: 'Toggle typing indicator', fr: 'Activer/désactiver la frappe' } },
  { name: '/happy', alias: '/a', help: { ru: 'Отправить смайлик (^_^)', en: 'Send happy emoticon', fr: 'Envoyer (^_^)' } },
  { name: '/sad', alias: '/d', help: { ru: 'Отправить смайлик (;_;)', en: 'Send sad emoticon', fr: 'Envoyer (;_;)' } },
  { name: '/neutral', alias: '/n', help: { ru: 'Отправить смайлик (._.)', en: 'Send neutral emoticon', fr: 'Envoyer (._.)' } },
  { name: '/asc', alias: '', args: '[cat|heart|shrug|happy|sad]', help: { ru: 'Отправить ASCII-арт карточку', en: 'Send ASCII art card', fr: 'Envoyer un dessin ASCII' } },
  { name: '/code', alias: '', args: '<code>', help: { ru: 'Отправить текст блоком кода: /code cd /x && ssh lit', en: 'Send text as a code block: /code cd /x && ssh lit', fr: 'Envoyer du texte en bloc de code : /code cd /x && ssh lit' } },
  { name: '/nick', alias: '/k', args: '<name>', help: { ru: 'Сменить отображаемое имя', en: 'Change display name', fr: 'Changer de pseudo' } },
  { name: '/peer', alias: '', args: '[username]', help: { ru: 'Переключиться на друга или показать список', en: 'Switch to peer or show list', fr: 'Changer de contact' } },
  { name: '/invite', alias: '/inv', args: '[create [login]|accept <code>]', help: { ru: 'Создать или принять инвайт-код друга', en: 'Create or accept friend invite', fr: 'Créer ou accepter une invitation' } },
  { name: '/time', alias: '', help: { ru: 'Показать текущее локальное и UTC время', en: 'Show current time', fr: 'Afficher l’heure' } },
  { name: '/history', alias: '/i', help: { ru: 'Экспортировать переписку в текстовый файл', en: 'Export chat transcript', fr: 'Exporter la transcription' } },
  { name: '/version', alias: '/v', help: { ru: 'Показать версию веб-клиента', en: 'Show web client version', fr: 'Afficher la version du client web' } },
  { name: '/status', alias: '', help: { ru: 'Показать состояние связи, собеседника и задержку', en: 'Show link state, peer state and latency', fr: 'Afficher l’état du lien, du contact et la latence' } },
  { name: '/del', alias: '', args: '[n]', help: { ru: 'Удалить свои последние сообщения: /del ~ /del 3', en: 'Delete your own last messages: /del ~ /del 3', fr: 'Supprimer vos derniers messages : /del ~ /del 3' } },
  { name: '/edit', alias: '', args: '<text>', help: { ru: 'Изменить последнее своё сообщение', en: 'Edit your latest message', fr: 'Modifier votre dernier message' } },
  { name: '/react', alias: '', args: '<emoji>', help: { ru: 'Реакция на последнее сообщение', en: 'React to the latest message', fr: 'Réagir au dernier message' } },
  { name: '/route', alias: '', help: { ru: 'Показать маршрут текущего чата', en: 'Show current chat route', fr: 'Afficher la route du chat' } },
  { name: '/voice', alias: '', help: { ru: 'Записать и отправить голосовое сообщение', en: 'Record and send a voice message', fr: 'Enregistrer et envoyer un message vocal' } },
  { name: '/send', alias: '', help: { ru: 'Выбрать файл или картинку для отправки', en: 'Pick a file or image to send', fr: 'Choisir un fichier ou une image à envoyer' } },
  { name: '/lang', alias: '/l', args: '[ru|en|fr]', help: { ru: 'Сменить язык интерфейса', en: 'Switch interface language', fr: 'Changer la langue de l’interface' } },
  { name: '/reconnect', alias: '', help: { ru: 'Переподключить соединение с сервером', en: 'Reopen the server connection', fr: 'Rouvrir la connexion au serveur' } },
  // Encryption: only where the core runs (`core: true`), the same five the
  // terminal has, run by the same module (web/cloud/core/e2ee-commands.js).
  { name: '/verify', alias: '', args: '[login|yes|no]', core: true, help: { ru: 'Сверить собеседника кодом безопасности — сравнить эмодзи голосом один раз; со своим логином — подписать своё новое устройство вживую', en: 'Verify a contact by the safety code — compare the emojis by voice once; with your own login, sign a new device of yours live', fr: 'Vérifier un contact par le code de sécurité — comparer les émojis de vive voix une fois ; avec votre login, signer en direct un nouvel appareil à vous' } },
  { name: '/safety', alias: '', args: '[login|yes]', core: true, help: { ru: 'Код безопасности с собеседником — тот же, что показывает /verify', en: 'Safety code with a contact — the one /verify shows', fr: 'Code de sécurité avec un contact — celui que montre /verify' } },
  { name: '/trust', alias: '', core: true, help: { ru: 'Принять изменившиеся ключи собеседника', en: 'Accept a contact’s changed keys', fr: 'Accepter les clés modifiées d’un contact' } },
  { name: '/backup', alias: '', args: '[create|status|restore]', core: true, help: { ru: 'Бэкап ключей шифрования: сделать, показать, восстановить', en: 'Encryption key backup: create, show, restore', fr: 'Sauvegarde des clés : créer, afficher, restaurer' } },
  { name: '/keys', alias: '', args: 'reset', core: true, help: { ru: 'Новые ключи шифрования, если старых нигде не осталось', en: 'New encryption keys, when no device has the old ones', fr: 'De nouvelles clés, quand aucun appareil n’a les anciennes' } },
  { name: '/quit', alias: '/q', help: { ru: 'Выйти из аккаунта', en: 'Sign out', fr: 'Se déconnecter' } },
];

const ASCII_ART = {
  cat: [
    ' /\\_/\\ ',
    '( o.o )',
    ' > ^ < ',
  ].join('\n'),
  heart: [
    ' .-\'\'-.  .-\'\'-. ',
    '/   _  \\/  _   \\',
    '|  (_)     (_) |',
    ' \\            / ',
    '  \'-..____..\'-  ',
  ].join('\n'),
  shrug: '¯\\_(ツ)_/¯',
  happy: [
    "   .-'''-.   ",
    '  /       \\  ',
    ' |  o   o  | ',
    ' |    ^    | ',
    '  \\  \\_/  /  ',
    "   '-.....-' ",
  ].join('\n'),
  sad: [
    "   .-'''-.   ",
    '  /       \\  ',
    ' |  o   o  | ',
    ' |    ^    | ',
    '  \\  /~\\  /  ',
    "   '-.....-' ",
  ].join('\n'),
};

const LOGO_PLAIN_RAW = [
  '   /\\_/\\    ▀█▀ ▄▀█ █ █   █▀▀ █ █ ▄▀█ ▀█▀',
  '  ( o.o )    █  █▀█ █ █▄▄ █▄▄ █▀█ █▀█  █ ',
  '   > ^ <    p2p over cloud & tailnet',
];

const LOGO_HOLIDAY_RAW = [
  '   /\\_/\\    ▀█▀ ▄▀█ █ █   █▀▀ █ █ ▄▀█ ▀█▀  ✚',
  '  ( o.o )    █  █▀█ █ █▄▄ █▄▄ █▀█ █▀█  █    ',
  '   > ^ <    p2p over cloud & tailnet        ',
];

function normalizeLogoRows(rows) {
  const width = Math.max(...rows.map((r) => [...r].length));
  return rows.map((r) => {
    const chars = [...r];
    return chars.length < width ? chars.concat(Array(width - chars.length).fill(' ')).join('') : r;
  });
}

const LOGO_PLAIN_ROWS = normalizeLogoRows(LOGO_PLAIN_RAW);
const LOGO_HOLIDAY_ROWS = normalizeLogoRows(LOGO_HOLIDAY_RAW);

const LOGO_PLAIN = LOGO_PLAIN_ROWS.join('\n');
const LOGO_HOLIDAY = LOGO_HOLIDAY_ROWS.join('\n');

function buildLogoFrames(rows) {
  const width = Math.max(...rows.map((r) => [...r].length));
  const pad = (r) => {
    const chars = [...r];
    return chars.length >= width ? chars : [...chars, ...Array(width - chars.length).fill(' ')];
  };
  const padded = rows.map(pad);
  const frames = [];
  for (let col = 1; col <= width; col += 1) {
    frames.push(padded.map((chars) => {
      const seen = chars.slice(0, col - 1);
      return [...seen, '▌'].join('');
    }).join('\n'));
  }
  const settled = rows.join('\n');
  const closed = rows.map((r) => r.replace('( o.o )', '( -.- )')).join('\n');
  for (let i = 0; i < 4; i++) frames.push(settled);
  for (let i = 0; i < 4; i++) frames.push(closed);
  for (let i = 0; i < 4; i++) frames.push(settled);
  return frames;
}

let logoAnimTimer = null;

// The wordmark is built from half-block glyphs (▀ █ ▄), and those only tile
// into solid letters when consecutive rows sit exactly one glyph height
// apart. That height is a property of whatever monospace font the device
// actually resolved — JetBrains Mono draws blocks over 1.32 em, Noto Sans
// Mono over about 1.17 — so `line-height: 1` leaves the halves overlapping
// (Android) or floating apart. Canvas is the only place a browser will admit
// the real ink extents, so the pitch is measured rather than guessed.
function tuneLogoLineHeight(artEl) {
  if (!artEl) return;
  try {
    const style = getComputedStyle(artEl);
    const size = parseFloat(style.fontSize);
    if (!Number.isFinite(size) || size <= 0) return;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    const metrics = ctx.measureText('█');
    const ink = (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) / size;
    if (Number.isFinite(ink) && ink > 0.8 && ink < 2) artEl.style.lineHeight = ink.toFixed(4);
  } catch {}
}

// The wordmark is 43 monospace columns wide and the band it sits in is
// whatever is left of the window after the roster and the info panel have
// taken theirs. `.logo-band` clips overflow, so on any narrow talk column the
// logo simply lost its right-hand end — «логотип при открытии web обрезан».
// A uniform scale is the one fix that cannot break the wordmark: the
// half-block glyphs keep their exact relative geometry, unlike a smaller
// font-size (which re-rounds every glyph to the pixel grid and tears the
// blocks apart). The factor rides on a custom property so the tap animation
// can pulse *around* it instead of overwriting it.
function fitLogoBand() {
  const artEl = elements.logoArt;
  const band = elements.logoBand;
  if (!artEl || !band) return;
  // Measure unscaled, or every call would compound the previous factor.
  artEl.style.setProperty('--logo-fit', '1');
  const available = band.clientWidth - 16;
  const natural = artEl.scrollWidth;
  if (!(available > 0) || !(natural > 0)) return;
  const fit = Math.min(1, available / natural);
  artEl.style.setProperty('--logo-fit', fit.toFixed(4));
}

function animateLogo() {
  const artEl = elements.logoArt;
  if (!artEl) return;
  tuneLogoLineHeight(artEl);
  fitLogoBand();
  // On the very first paint the mono webfont has often not resolved yet, so
  // this first measurement reads the fallback font's glyph metrics — wrong
  // for the half-block wordmark, which only tiles into solid letters at the
  // real font's pitch. `.logo-band` clips overflow, so the wrong line-height
  // reads as the logo arriving cropped. Re-measure once fonts are settled.
  document.fonts?.ready?.then(() => {
    tuneLogoLineHeight(artEl);
    fitLogoBand();
  }).catch(() => {});
  if (logoAnimTimer) clearInterval(logoAnimTimer);

  const rows = holidayMode ? LOGO_HOLIDAY_ROWS : LOGO_PLAIN_ROWS;
  const frames = buildLogoFrames(rows);
  let frameIdx = 0;

  logoAnimTimer = setInterval(() => {
    if (frameIdx < frames.length) {
      artEl.textContent = frames[frameIdx];
      frameIdx += 1;
    } else {
      clearInterval(logoAnimTimer);
      logoAnimTimer = null;
      artEl.textContent = rows.join('\n');
      // Only the finished wordmark is the full width — measuring a partial
      // frame would scale to a line that is about to get longer.
      fitLogoBand();
    }
  }, 35);
}

// Colour schemes only. Light/dark is a separate axis (`data-mode`), because it
// is the choice that actually matters in a dark room or in daylight — a person
// should never have to give up their palette to get a light background.
const THEMES = ['paper', 'green', 'amber', 'blue', 'matrix', 'mono'];
const MODES = ['auto', 'light', 'dark'];
// Typeface and corner softness. Both are pure presentation: the value is a
// class of stack rather than a font name, so the stylesheet stays the one place
// that knows which faces to try (see `--serif` in app.css).
const FONTS = ['serif', 'mono', 'sans'];
const ROUNDS = ['sharp', 'soft', 'round'];
// The pattern behind the transcript. The first four are the vocabulary shared
// with Android's `ChatWallpaper` (see `Settings.kt`); the last four are web-only
// since 1.128 — the APK reads an unknown value as `None`, so a stored `aurora`
// never puts a wrong pattern on a phone. `aurora` is the default (see
// `getInitialWallpaper`), and every value has its own selector in app.css.
const WALLPAPERS = ['none', 'dots', 'ruled', 'diamond', 'aurora', 'waves', 'topo', 'doodle'];
const DEFAULT_WALLPAPER = 'aurora';

const I18N = {
  ru: {
    bootNote: 'Загрузка…',
    authTitleLogin: 'Вход',
    authTitleRegister: 'Регистрация',
    authTitleRecover: 'Восстановление пароля',
    authLeadLogin: 'Логин и пароль — те же, что в терминальном Tailchat с ключом --cloud.',
    authLeadRegister: 'Логин виден только на этом сервере. Пароль нигде не хранится в открытом виде.',
    authLeadRecover: 'Введите ваш логин, аварийный ключ (Recovery Key) и задайте новый пароль.',
    labelLogin: 'Логин',
    hintLogin: 'Латиница и цифры, можно точку, дефис и подчёркивание. От 3 до 32 знаков.',
    labelName: 'Имя',
    hintName: 'Его увидят собеседники. Оставьте пустым — возьмём логин.',
    labelPassword: 'Пароль',
    labelPasswordConfirm: 'Повторите пароль',
    hintPasswordConfirm: 'Введите пароль ещё раз для проверки.',
    labelExtraPassword: 'Дополнительный пароль',
    hintExtraPassword: 'У этого аккаунта включён дополнительный пароль. Введите его, чтобы завершить вход.',
    hintPasswordRegister: 'Принимается любой пароль. Рекомендуется надёжный (например: Tr0ngP@ssw0rd!2026).',
    hintPasswordRecover: 'Задайте новый пароль для вашего аккаунта.',
    authSubmitLogin: 'Войти',
    authSubmitRegister: 'Создать аккаунт',
    authSubmitRecover: 'Сбросить пароль',
    authSwitchNoteLogin: 'Ещё нет аккаунта?',
    authSwitchNoteRegister: 'Аккаунт уже есть?',
    authSwitchNoteRecover: 'Вспомнили пароль?',
    authSwitchLogin: 'Регистрация',
    authSwitchRegister: 'Войти',
    authSwitchRecover: 'Войти',
    authForgotBtn: 'Забыли пароль?',
    labelRecovery: 'Ключ восстановления',
    hintRecovery: 'Аварийный ключ (Recovery Key), выданный при регистрации.',
    recModalTitle: 'Ключ восстановления',
    recModalHint: 'Сохраните этот аварийный ключ в надёжном месте. Он потребуется для сброса пароля без email или телефона.',
    recCopy: 'Копировать',
    recContinue: 'Продолжить в чат',
    recCopied: 'Ключ скопирован в буфер обмена!',
    recClose: 'Закрыть',
    passToggleShow: 'Показать пароль',
    passToggleHide: 'Скрыть пароль',
    authApkTitle: 'Скачать Android APK',
    closeDialog: 'Закрыть',
    rosterTitle: 'Собеседники',
    rosterEmpty: 'У вас пока нет друзей в списке. Нажмите «+» вверху, чтобы добавить.',
    previewYou: 'Вы',
    previewImage: '📷 Фото',
    previewVoice: '🎙 Голосовое',
    previewFile: '📎 Файл',
    addFriend: '+ Добавить друга',
    logout: 'Выйти',
    settings: 'Настройки',
    settingsMode: 'Тема',
    settingsScheme: 'Цветовая схема',
    settingsFont: 'Шрифт',
    settingsWallpaper: 'Обои переписки',
    wallpaperNone: 'Без узора',
    wallpaperDots: 'Точки',
    wallpaperRuled: 'Линованная бумага',
    wallpaperDiamond: 'Ромб',
    wallpaperAurora: 'Сияние',
    wallpaperWaves: 'Волны',
    wallpaperTopo: 'Рельеф',
    wallpaperDoodle: 'Зарисовки',
    settingsRound: 'Скругление',
    settingsBorders: 'Обводки',
    settingsDepth: 'Объёмный дизайн',
    fontMono: 'Терминал',
    fontSans: 'Гротеск',
    fontSerif: 'Гарамон',
    roundSharp: 'Острые',
    roundSoft: 'Мягкие',
    roundRound: 'Круглые',
    settingsBehaviour: 'Поведение',
    settingsLang: 'Язык',
    settingsApps: 'Приложения',
    settingsAccount: 'Аккаунт',
    settingsSound: 'Звуки',
    settingsSoundSend: 'Звук отправки',
    settingsVolume: 'Громкость звуков',
    settingsSoundPick: 'Свой звук входящего',
    settingsSoundReset: 'Вернуть встроенный',
    settingsSoundDefault: 'Встроенный звук',
    settingsSoundTooBig: 'Файл больше 2 МБ — выберите короче',
    settingsSoundNotAudio: 'Это не аудиофайл',
    settingsSoundUndecodable: 'Браузер не смог проиграть этот файл',
    soundEnable: 'Включить звуки',
    soundDisable: 'Отключить звуки',
    soundOnShort: 'Звук: вкл',
    soundOffShort: 'Звук: выкл',
    settingsNotify: 'Уведомления',
    settingsTyping: 'Показывать «печатает…»',
    settingsHoliday: 'Праздничный логотип',
    settingsLinkPreview: 'Предпросмотр ссылок',
    settingsShowDeleted: 'Показывать удалённые сообщения',
    settingsQuickReactions: 'Быстрые реакции',
    settingsQuickReactionSlot: (slot, emoji) => `Реакция ${slot}: ${emoji}`,
    updateAvailable: 'Обновить',
    updateAvailableTitle: 'Доступно обновление — нажмите, чтобы обновить',
    settingsInstall: 'Установить как приложение',
    settingsApk: 'Android APK',
    settingsProfile: 'Профиль',
    modeAuto: 'Авто',
    modeLight: 'Светлая',
    modeDark: 'Тёмная',
    modeSet: (name) => `Тема: ${name}`,
    presenceIdle: 'не за компьютером',
    presenceAway: 'отошёл(ла)',
    peerIdle: '◐ не за компьютером',
    peerAway: '◔ отошёл(ла)',
    msgMenu: 'Действия с сообщением',
    msgCopy: 'Копировать текст',
    msgCopied: 'Текст скопирован',
    msgDeleteMine: 'Удалить у меня',
    msgReadAt: (value) => `Прочитано: ${value}`,
    msgEditedAt: (value) => `Изменено: ${value}`,
    // Which client read it, as the menu's short grey line names it («Прочитано:
    // 14:44 · браузер»). Kinds follow `normalizeClientKind` server-side.
    viaWeb: 'браузер',
    viaCli: 'терминал',
    viaAndroid: 'телефон',
    msgDeleteAll: 'Удалить у всех',
    msgEdit: 'Изменить',
    msgReply: 'Ответить',
    msgReact: 'Реакция',
    msgForward: 'Переслать',
    msgForwardTo: 'Переслать кому',
    msgSelect: 'Выбрать',
    msgSelectedCount: (count) => `Выбрано: ${count}`,
    msgSelectCancel: 'Снять выделение',
    msgForwardedFrom: (who) => `Переслано от ${who}`,
    editingMessage: 'Редактирование сообщения',
    replyingTo: (name) => `Ответ: ${name}`,
    msgDeleted: 'Сообщение удалено',
    newMessages: 'Новые сообщения',
    rosterMenu: 'Действия с собеседником',
    // The one button the client offers on its own behalf, in the empty
    // `{tailchat}` thread: pressing it sends `/help`, and the account answers
    // with the menu it already hands out on request.
    botMenu: 'Меню',
    rosterOpenChat: 'Открыть чат',
    rosterPin: 'Закрепить чат',
    rosterUnpin: 'Открепить чат',
    rosterBlock: 'Заблокировать',
    rosterUnblock: 'Разблокировать',
    composerBlockedHint: 'Собеседник заблокирован',
    rosterMarkRead: 'Отметить прочитанным',
    rosterMarkUnread: 'Отметить непрочитанным',
    msgRemind: 'Напомнить',
    msgRemind15m: '15 минут',
    msgRemind1h: '1 час',
    msgRemindEvening: 'вечером',
    msgRemindTomorrow: 'завтра',
    replyReminderDue: (name) => `Пора ответить ${name}`,
    rosterCopyLogin: 'Скопировать логин',
    rosterLoginCopied: (login) => `Логин скопирован: ${login}`,
    rosterInfo: 'Информация',
    rosterClearHistory: 'Очистить историю у себя',
    rosterRemoveContact: 'Удалить контакт',
    rosterRemoveConfirm: 'Удалить контакт вместе с перепиской? У вас переписка удалится безвозвратно, у собеседника останется своя копия. Отменить это нельзя.',
    rosterRemoveDone: 'Контакт и переписка удалены.',
    rosterRemoveCancel: 'Отмена',
    rosterRename: 'Переименовать',
    rosterRenameHint: 'Личное имя для этого контакта — его видите только вы. Очистите поле и нажмите «Сохранить», чтобы убрать имя.',
    rosterRenameConfirm: 'Сохранить',
    rosterRenameCancel: 'Отмена',
    rosterRenameDone: (name) => `Контакт переименован: ${name}`,
    rosterRenameCleared: 'Имя контакта убрано.',
    mediaExpired: '(вложение вытеснено из истории)',
    mediaLoading: 'Загрузка вложения…',
    mediaFailed: 'Вложение не загрузилось — нажмите, чтобы повторить',
    imagePasting: 'Готовим изображение…',
    imageTooBig: 'Изображение слишком большое даже после сжатия',
    back: 'Список',
    peerChoose: 'Выберите собеседника',
    peerChooseLead: 'Слева — все друзья, добавленные на этом сервере',
    peerOnline: '● в сети',
    peerOffline: (time) => `○ был(а) ${time}`,
    officialAccount: 'служебный аккаунт',
    placeholderTitle: 'Разговор пока не выбран',
    placeholderText: 'Сообщения, присланные пока вы были офлайн, придут сразу после выбора собеседника.',
    composerPlaceholderDisabled: 'Сначала выберите собеседника',
    composerPlaceholderActive: 'Сообщение…',
    send: 'Отправить',
    modalTitle: 'Добавить друга',
    myInviteTitle: 'Моя ссылка-приглашение',
    myInviteHint: 'Одноразовая ссылка для передачи другу. Создание новой ссылки аннулирует предыдущую.',
    myInvitePlaceholder: 'Нажмите «Создать»',
    create: 'Создать',
    creating: 'Генерируем ссылку…',
    copy: 'Копировать',
    copied: 'Ссылка скопирована в буфер обмена!',
    copyManual: 'Выделите и скопируйте ссылку вручную.',
    createdNotice: 'Ссылка создана. Скопируйте и отправьте другу.',
    createdNoticeFor: (login) => `Ссылка создана для @${login}. Отправьте её этому аккаунту.`,
    acceptInviteTitle: 'Ввести инвайт друга',
    acceptInviteHint: 'Вставьте ссылку-приглашение или 64-значный hex-код, полученный от друга.',
    acceptInvitePlaceholder: 'Код или ссылка приглашения',
    add: 'Добавить',
    checking: 'Проверяем код…',
    friendAdded: (name) => `Друг добавлен: ${name}!`,
    friendRequestTitle: 'Добавить по @username',
    friendRequestHint: 'Укажите логин друга — он получит заявку от служебного аккаунта и сможет её принять.',
    friendRequestPlaceholder: '@username друга',
    friendRequestSending: 'Отправляем заявку…',
    friendRequested: (official) => `Заявка отправлена — @${official} сообщит, когда её примут.`,
    friendInContacts: (name) => `${name} у вас в контактах.`,
    online: 'в сети',
    lastSeenJustNow: 'только что',
    lastSeenMinutes: (m) => `${m} мин назад`,
    lastSeenHours: (h) => `${h} ч назад`,
    lastSeenDays: (d) => `${d} дн назад`,
    lastSeenLongAgo: 'давно',
    today: 'сегодня',
    yesterday: 'вчера',
    connConnecting: 'Подключение…',
    connOnline: 'В сети',
    connOffline: 'Нет связи',
    editFailed: 'Правка не ушла — текст возвращён прежним',
    peerOutdatedMedia: 'У собеседника старая версия Tailchat — это фото или голосовое не дошло бы. Попросите обновить приложение, затем повторите отправку',
    connReconnecting: 'Переподключение…',
    msgEncryptedWaiting: 'Зашифрованное сообщение — ключ к нему ещё не пришёл на это устройство',
    // Encryption screens (stage 7, under the core flag). The commands' own
    // words come from web/cloud/core/e2ee-strings.js, shared with the
    // terminal; the keys here override the ones that name the terminal's
    // surface, and add the page's dialogs.
    e2ee: {
      answer: 'совпали? Ответьте в окне — или командой /verify yes · /verify no',
      signInAgain: 'Ключи шифрования этого устройства не совпадают с теми, что сервер хранит для него: хранилище браузера потеряно или скопировано, поэтому шифрование здесь выключено. Войдите заново, а потом сверьте это устройство с другим своим: /verify {self}',
      restoreTitle: 'Восстановление ключей',
      restoreHint: 'Enter — восстановить · Esc — отмена. Введённое не показывается и не сохраняется.',
      resetTitle: 'Сброс ключей шифрования',
      resetHint: 'Enter — сбросить · Esc — отмена',
      resetNoAnswer: 'на сброс пока нет ответа — если сервер его принял, эта вкладка скажет об этом, как только увидит новые ключи',
      resetNotReady: 'шифрование на этом устройстве ещё не готово — дождитесь подключения (или войдите заново, если вам это предлагали) и повторите /keys reset',
      sasTitle: 'Сверка с {peer}',
      sasHint: 'Сравните с {peer} голосом — по телефону или вживую, не в этом чате. На обоих экранах те же эмодзи в том же порядке? Значит, переписку между вами никто не подменяет. Закрыть окно — отменить сверку.',
      sasMatch: 'Совпадают',
      sasDiffer: 'Не совпадают',
      secretConfirm: 'Подтвердить',
      secretCancel: 'Отмена',
      backupKeyTitle: 'Ключ восстановления',
      backupKeyHint: 'Бэкап ключей включён (версия {version}). Ключ восстановления показан один раз — сохраните его в надёжном месте: с ним переписка откроется на новом устройстве.',
      copy: 'Копировать',
      copied: 'Скопировано',
      copyFailed: 'Не удалось скопировать — выделите ключ вручную',
      done: 'Готово',
      signInAgainTitle: 'Войдите заново',
      signInAgainNow: 'Войти заново',
      later: 'Позже',
      menuVerify: 'Сверить',
      menuTrust: 'Принять новые ключи',
      safetyTitle: 'Код безопасности',
      safetyLoading: 'Получаю ключи…',
      safetyNotVerified: 'Необязательно. Если хотите убедиться, что ключи никто не подменил, прочитайте эмодзи друг другу голосом — по телефону или вживую, не в этом чате. Достаточно одного раза: у {peer} те же эмодзи в том же порядке, и они не меняются, пока кто-то из вас не сбросит ключи.',
      safetyKeyChanged: '⚠ Ключи {peer} сменились. Обычно это новое устройство или сброс ключей, но так же выглядит и подмена. Пока вы не сверите новый код голосом или не примете ключи без сверки, {peer} ничего не отправляется.',
      safetyIsVerifiedShort: '✓ Сверено: ключи {peer} подтверждены, переписку никто не подменяет.',
      safetyConfirm: 'Совпадает — отметить сверенным',
      settingsHeading: 'Шифрование',
      settingsBackupCreate: 'Сделать бэкап ключей',
      settingsBackupStatus: 'Состояние бэкапа',
      settingsBackupRestore: 'Восстановить из бэкапа',
      settingsKeysReset: 'Сбросить ключи',
    },
    typing: (name) => `${name} печатает…`,
    unreadTooltip: 'Непрочитанные сообщения',
    notifyNewMessage: 'Новое сообщение',
    wakeSent: '🔔 Сигнал внимания отправлен собеседнику',
    wakeReceived: (name) => `🔔 ${name} привлекает ваше внимание!`,
    helpHeader: '═ ДОСТУПНЫЕ КОМАНДЫ TAILCHAT ═══════════════════════════',
    helpFooter: '════════════════════════════════════════════════════════',
    pingResult: (ms) => `● Пинг до сервера и пира: ${ms} мс`,
    pingTimeout: (name) => `● Пинг до ${name}: таймаут`,
    themeSet: (t) => `Тема оформления изменена на: ${t}`,
    holidaySet: (on) => `Праздничный режим: ${on ? 'ВКЛ' : 'ВЫКЛ'}`,
    soundSet: (on) => `Звуковые эффекты: ${on ? 'ВКЛ' : 'ВЫКЛ'}`,
    notifyOn: 'Уведомления: ВКЛ',
    notifyOff: 'Уведомления: ВЫКЛ',
    notifyBlocked: 'Уведомления заблокированы в настройках браузера.',
    notifyAllow: 'Уведомления — разрешить в браузере',
    notifySet: (on) => `Системные уведомления: ${on ? 'ВКЛ' : 'ВЫКЛ'}`,
    voiceMessageNotify: (dur) => `🎙 Голосовое сообщение (${dur})`,
    typingSet: (on) => `Индикатор набора: ${on ? 'ВКЛ' : 'ВЫКЛ'}`,
    nickSet: (n) => `Отображаемое имя изменено на: ${n}`,
    historyExported: 'История переписки успешно экспортирована в файл',
    wakePeerTitle: 'Привлечь внимание собеседника (/wake)',
    exportHistoryTitle: 'Экспортировать историю (/history)',
    themeBtnTitle: 'Тема оформления',
    logoBandTitle: 'Нажмите для перерисовки логотипа (/logo)',
    chatCleared: 'Экран переписки очищен',
    pingSent: 'Отправлен пинг…',
    codeUsage: 'Использование: /code <код> — текст уйдёт блоком кода',
    versionInfo: (v) => `● Веб-клиент Tailchat ${v}`,
    statusHeader: '═ СТАТУС СЕАНСА ════════════════════════════════════════',
    statusSocket: (state) => `  канал: ${state}`,
    statusPeerLine: (name, state) => `  собеседник: ${name} — ${state}`,
    statusNoPeer: '  собеседник: не выбран',
    statusLatency: (value) => `  задержка: ${value}`,
    statusRoute: (route) => `  маршрут: ${route}`,
    delUsage: (max) => `Использование: /del [n], где n от 1 до ${max}`,
    delNothing: 'Нечего удалять — вы ещё ничего не отправляли в этом разговоре',
    delDone: (n) => `Удалено сообщений: ${n}`,
    langSet: (lang) => `Язык интерфейса: ${lang}`,
    langUsage: 'Использование: /lang [ru|en|fr]',
    reconnectRequested: 'Переподключаюсь к серверу…',
    pastedImage: '🖼 [Изображение]',
    pasteHint: 'Нажмите Ctrl+V (Cmd+V) для вставки скриншота из буфера обмена',
    installApp: '📱 Установить',
    installTitle: 'Установить веб-приложение на телефон или ПК',
    pwaIosTitle: 'Установка на iPhone / iPad',
    pwaIosDesc: 'Чтобы установить Tailchat как полноэкранное веб-приложение на iOS:',
    pwaIosStep1: 'Нажмите кнопку «Поделиться» (⎋ или 📤) в панели Safari.',
    pwaIosStep2: 'Прокрутите список действий и выберите «На экран «Домой»» (➕ Add to Home Screen).',
    pwaIosStep3: 'Нажмите «Добавить» в правом верхнем углу.',
    pwaIosAck: 'Понятно',
    togglePanePeers: 'Собеседники',
    togglePaneInfo: 'Инфо',
    togglePeersTitle: 'Панель собеседников (Ctrl+B)',
    togglePaneInfoTitle: 'Панель информации (Ctrl+I)',
    resizeRoster: 'Изменить ширину панели собеседников',
    resizeInfo: 'Изменить ширину панели информации',
    savedMessages: '📝 Сохранённые сообщения',
    savedMessagesHint: 'Заметки для себя',
    convMenuTitle: 'Опции диалога',
    directFailedTitle: 'Прямое соединение не удалось (P2P), сообщения идут через сервер',
    directOffTitle: 'Подключиться напрямую (e2e encryption p2p, минуя сервер)',
    directConnectingTitle: 'Устанавливается прямое соединение (e2e encryption p2p)…',
    directOnTitle: 'Прямое соединение активно (e2e encryption p2p, минуя сервер)',
    infoTitle: 'СОБЕСЕДНИК',
    infoClose: 'Закрыть панель',
    infoNoPeer: 'Собеседник не выбран',
    infoStats: 'Статистика',
    infoStatMessages: 'Сообщений',
    infoStatImages: 'Изображений',
    infoStatVoice: 'Голосовых',
    infoStatUnread: 'Непрочитано',
    infoActions: 'Действия',
    infoWake: 'Позвать собеседника',
    infoExport: 'Экспорт истории',
    infoClearView: 'Очистить экран',
    infoSession: 'Соединение',
    infoServer: 'Сервер',
    cloudName: 'облако',
    infoTransport: 'Транспорт',
    infoLatency: 'Задержка',
    infoRoute: 'Маршрут',
    infoClient: 'Клиент',
    routeYou: 'вы',
    routeDirect: '(напрямую)',
    routeClientWeb: 'веб',
    routeClientCli: (v) => `терминал ${v}`,
    routeClientUnknown: 'пока не представился',
    infoMeasure: 'Измерить задержку',
    infoLatencyValue: (ms) => `${ms} мс`,
    voiceButtonTitle: 'Записать голосовое сообщение',
    voiceRecording: '● ЗАПИСЬ',
    voiceCapped: '■ ПРЕДЕЛ',
    voiceCancel: 'Отмена',
    voiceSendLabel: 'Отправить',
    voiceMicDenied: 'Микрофон недоступен. Разрешите доступ к нему в настройках браузера.',
    voiceAsking: '… доступ к микрофону',
    voiceNoDevice: 'Микрофон не найден. Подключите его и попробуйте снова.',
    voiceInsecure: 'Запись недоступна: страница открыта не по HTTPS.',
    voiceNoRecorder: 'Браузер не умеет записывать звук.',
    voiceEmpty: 'Запись пустая — ничего не отправлено.',
    voiceSilent: 'В записи нет звука — проверьте, что микрофон включён и выбран верный вход.',
    voiceTooLarge: 'Голосовое сообщение слишком большое. Запишите более короткое.',
    voiceCappedNote: (max) => `Запись остановлена: предел ${max}.`,
    voicePlay: 'Воспроизвести',
    voicePause: 'Пауза',
    voiceSpeedTitle: 'Скорость воспроизведения',
    profileOpen: 'Профиль',
    profileTitle: 'Профиль',
    profileLoginLabel: 'Логин',
    profileLoginHint: 'Постоянный идентификатор аккаунта.',
    profileNameLabel: 'Отображаемое имя',
    profilePasswordTitle: 'Сменить пароль',
    profilePasswordHint: 'Оставьте поля пустыми, если пароль менять не нужно.',
    profileCurrentPassword: 'Текущий пароль',
    profileNewPassword: 'Новый пароль',
    profileConfirmPassword: 'Повторите новый пароль',
    profileExtraPasswordTitle: 'Дополнительный пароль',
    profileExtraPasswordHint: 'По желанию. Если включён, вход в аккаунт потребует его вместе с обычным паролем.',
    profileExtraPasswordEnabledLabel: 'Использовать дополнительный пароль',
    profileExtraPasswordLabel: 'Дополнительный пароль',
    profileExtraPasswordConfirmLabel: 'Повторите дополнительный пароль',
    profileExtraPasswordNote: 'Чтобы включить, отключить или сменить дополнительный пароль, укажите текущий (обычный) пароль выше.',
    profileCancel: 'Отмена',
    profileSave: 'Сохранить изменения',
    profileSaving: 'Сохраняем…',
    profileSaved: 'Профиль сохранён.',
    attachFile: 'Отправить файл',
    emojiButton: 'Эмодзи',
    emojiSearch: 'Поиск эмодзи',
    emojiNothingFound: 'Ничего не найдено',
    emojiMore: 'Все эмодзи',
    emojiCatRecent: 'Недавние',
    emojiCatSmileys: 'Смайлы',
    emojiCatPeople: 'Люди и жесты',
    emojiCatAnimals: 'Животные и природа',
    emojiCatFood: 'Еда',
    emojiCatActivities: 'Активности',
    emojiCatTravel: 'Путешествия',
    emojiCatObjects: 'Предметы',
    emojiCatSymbols: 'Символы',
    emojiCatFlags: 'Флаги',
    imageOpen: 'Открыть изображение',
    imageTitle: 'Изображение',
    imageSave: 'Сохранить изображение',
    imageSheetTitle: 'Отправка изображения',
    imageCancel: 'Отмена',
    imageCrop: 'Обрезать',
    imageCropRatio: 'Пропорции',
    imageCropFree: 'Свободно',
    imageCropReset: 'Сбросить',
    imageRotate: 'Повернуть 90°',
    imageCaption: 'Подпись',
    fileOpen: 'Открыть файл',
    fileReceiving: (name, percent) => `Получение ${name}: ${percent}%`,
    fileFailed: (name) => `Не удалось получить файл ${name}.`,
    fileTooLarge: 'Файл больше 25 МБ.',
    fileNeedsOnline: 'Файлы можно отправлять, когда собеседник в сети.',
    fileSent: (name) => `Файл отправлен: ${name}`,
    errors: {
      bad_credentials: 'Неверный логин или пароль.',
      extra_password_required: 'Введите дополнительный пароль.',
      bad_recovery_key: 'Неверный ключ восстановления или логин.',
      login_taken: 'Этот логин уже занят.',
      invalid_login: 'Логин: от 3 до 32 знаков, латиница, цифры, точка, дефис, подчёркивание.',
      invalid_password: 'Пароль: от 1 до 200 знаков.',
      password_mismatch: 'Пароли не совпадают.',
      invalid_name: 'Недопустимое имя.',
      too_many_attempts: 'Слишком много попыток. Подождите несколько минут.',
      unknown_token: 'Сессия истекла. Войдите снова.',
      auth_required: 'Сессия истекла. Войдите снова.',
      auth_failed: 'Сессия истекла. Войдите снова.',
      peer_not_found: 'Собеседник не найден на сервере.',
      not_subscribed: 'Собеседник не выбран.',
      frame_too_large: 'Сообщение слишком большое.',
      rate_limited: 'Слишком частые сообщения. Пожалуйста, притормозите.',
      invalid_invite: 'Некорректный инвайт-код.',
      invite_not_found: 'Инвайт-код не найден или уже использован.',
      self_invite: 'Нельзя активировать свой собственный инвайт-код.',
      invalid_login: 'Некорректный логин.',
      self_request: 'Это ваш собственный аккаунт.',
      official_request: 'Служебному аккаунту заявку не отправить.',
      request_limit: 'Слишком много заявок. Попробуйте позже.',
      not_friends: 'Пользователя нет в вашем списке друзей.',
      self_block: 'Нельзя заблокировать самого себя.',
      self_remove: 'Нельзя удалить самого себя из списка контактов.',
      official_contact: 'Официальный контакт удалить нельзя.',
      unknown_user: 'Пользователь не найден.',
      invalid_alias: 'Такое имя не подойдёт: пустое или только служебные символы (до 32 знаков).',
      forbidden: 'Приглашение для другого аккаунта может выдать только владелец деплоя.',
      official_invite: 'Для официального контакта приглашение не выдаётся.',
      blocked: 'Собеседник заблокирован.',
      invalid_json: 'Некорректный запрос.',
      unknown_action: 'Неизвестное действие.',
      network: 'Сервер недоступен. Проверьте связь.',
    },
  },
  en: {
    bootNote: 'Loading…',
    authTitleLogin: 'Sign in',
    authTitleRegister: 'Create account',
    authTitleRecover: 'Password Recovery',
    authLeadLogin: 'Login and password are the same as in Tailchat CLI with --cloud.',
    authLeadRegister: 'Your login is only visible on this server. Passwords are never stored in plain text.',
    authLeadRecover: 'Enter your login, recovery key, and set a new password.',
    labelLogin: 'Login',
    hintLogin: 'Letters, digits, dot, dash, underscore. 3 to 32 characters.',
    labelName: 'Display name',
    hintName: 'Visible to peers. Leave empty to use login.',
    labelRecovery: 'Recovery Key',
    hintRecovery: 'Emergency key (Recovery Key) issued during registration.',
    labelPassword: 'Password',
    labelPasswordConfirm: 'Confirm password',
    hintPasswordConfirm: 'Re-enter password to verify.',
    labelExtraPassword: 'Extra password',
    hintExtraPassword: 'This account has an additional password enabled. Enter it to finish signing in.',
    hintPasswordRegister: 'Any password is accepted. A strong one is recommended (e.g. Tr0ngP@ssw0rd!2026).',
    hintPasswordRecover: 'Set a new password for your account.',
    authSubmitLogin: 'Sign in',
    authSubmitRegister: 'Create account',
    authSubmitRecover: 'Reset password',
    authSwitchNoteLogin: 'Don’t have an account?',
    authSwitchNoteRegister: 'Already have an account?',
    authSwitchNoteRecover: 'Remember your password?',
    authSwitchLogin: 'Create account',
    authSwitchRegister: 'Sign in',
    authSwitchRecover: 'Sign in',
    authForgotBtn: 'Forgot password?',
    recModalTitle: 'Recovery Key',
    recModalHint: 'Save this emergency key in a safe place. It is needed to reset your password without email or phone.',
    recCopy: 'Copy',
    recContinue: 'Continue to chat',
    recCopied: 'Recovery key copied to clipboard!',
    recClose: 'Close',
    passToggleShow: 'Show password',
    passToggleHide: 'Hide password',
    authApkTitle: 'Download Android APK',
    closeDialog: 'Close',
    rosterTitle: 'Peers',
    rosterEmpty: 'No friends in your list yet. Click "+" above to add one.',
    previewYou: 'You',
    previewImage: '📷 Photo',
    previewVoice: '🎙 Voice',
    previewFile: '📎 File',
    addFriend: '+ Add friend',
    logout: 'Sign out',
    settings: 'Settings',
    settingsMode: 'Appearance',
    settingsScheme: 'Colour scheme',
    settingsFont: 'Typeface',
    settingsWallpaper: 'Chat wallpaper',
    wallpaperNone: 'No pattern',
    wallpaperDots: 'Dots',
    wallpaperRuled: 'Ruled paper',
    wallpaperDiamond: 'Diamond',
    wallpaperAurora: 'Aurora',
    wallpaperWaves: 'Waves',
    wallpaperTopo: 'Contours',
    wallpaperDoodle: 'Doodles',
    settingsRound: 'Corners',
    settingsBorders: 'Outlines',
    settingsDepth: 'Depth',
    fontMono: 'Terminal',
    fontSans: 'Sans',
    fontSerif: 'Garamond',
    roundSharp: 'Sharp',
    roundSoft: 'Soft',
    roundRound: 'Round',
    settingsBehaviour: 'Behaviour',
    settingsLang: 'Language',
    settingsApps: 'Apps',
    settingsAccount: 'Account',
    settingsSound: 'Sounds',
    settingsSoundSend: 'Send sound',
    settingsVolume: 'Sound volume',
    settingsSoundPick: 'Custom incoming sound',
    settingsSoundReset: 'Back to built-in',
    settingsSoundDefault: 'Built-in cue',
    settingsSoundTooBig: 'Over 2 MB — pick a shorter clip',
    settingsSoundNotAudio: 'That is not an audio file',
    settingsSoundUndecodable: 'This browser cannot play that file',
    soundEnable: 'Enable sounds',
    soundDisable: 'Mute sounds',
    soundOnShort: 'Sound: on',
    soundOffShort: 'Sound: off',
    settingsNotify: 'Notifications',
    settingsTyping: 'Show "typing…"',
    settingsHoliday: 'Holiday logo',
    settingsLinkPreview: 'Link previews',
    settingsShowDeleted: 'Show deleted messages',
    settingsQuickReactions: 'Quick reactions',
    settingsQuickReactionSlot: (slot, emoji) => `Reaction ${slot}: ${emoji}`,
    settingsInstall: 'Install as app',
    updateAvailable: 'Update',
    updateAvailableTitle: 'Update available — click to reload',
    settingsApk: 'Android APK',
    settingsProfile: 'Profile',
    modeAuto: 'Auto',
    modeLight: 'Light',
    modeDark: 'Dark',
    modeSet: (name) => `Appearance: ${name}`,
    presenceIdle: 'idle',
    presenceAway: 'away',
    peerIdle: '◐ idle',
    peerAway: '◔ away',
    msgMenu: 'Message actions',
    msgCopy: 'Copy text',
    msgCopied: 'Text copied',
    msgDeleteMine: 'Delete for me',
    msgReadAt: (value) => `Read: ${value}`,
    msgEditedAt: (value) => `Edited: ${value}`,
    viaWeb: 'browser',
    viaCli: 'terminal',
    viaAndroid: 'phone',
    msgDeleteAll: 'Delete for everyone',
    msgEdit: 'Edit',
    msgReply: 'Reply',
    msgReact: 'React',
    msgForward: 'Forward',
    msgForwardTo: 'Forward to',
    msgSelect: 'Select',
    msgSelectedCount: (count) => `Selected: ${count}`,
    msgSelectCancel: 'Clear selection',
    msgForwardedFrom: (who) => `Forwarded from ${who}`,
    editingMessage: 'Editing message',
    replyingTo: (name) => `Reply to ${name}`,
    msgDeleted: 'Message deleted',
    newMessages: 'New messages',
    rosterMenu: 'Peer actions',
    // See `botMenu` in the Russian dictionary: the client's own button in an
    // empty `{tailchat}` thread.
    botMenu: 'Menu',
    rosterOpenChat: 'Open chat',
    rosterPin: 'Pin chat',
    rosterUnpin: 'Unpin chat',
    rosterBlock: 'Block',
    rosterUnblock: 'Unblock',
    composerBlockedHint: 'This contact is blocked',
    rosterMarkRead: 'Mark as read',
    rosterMarkUnread: 'Mark as unread',
    msgRemind: 'Remind',
    msgRemind15m: '15 minutes',
    msgRemind1h: '1 hour',
    msgRemindEvening: 'this evening',
    msgRemindTomorrow: 'tomorrow',
    replyReminderDue: (name) => `Time to reply to ${name}`,
    rosterCopyLogin: 'Copy login',
    rosterLoginCopied: (login) => `Login copied: ${login}`,
    rosterInfo: 'Details',
    rosterClearHistory: 'Clear history for me',
    rosterRemoveContact: 'Delete contact',
    rosterRemoveConfirm: 'Delete the contact together with the conversation? Your copy is gone for good; the other person keeps theirs. This cannot be undone.',
    rosterRemoveDone: 'Contact and conversation deleted.',
    rosterRemoveCancel: 'Cancel',
    rosterRename: 'Rename',
    rosterRenameHint: 'A private name for this contact, visible only to you. Clear the field and press Save to remove it.',
    rosterRenameConfirm: 'Save',
    rosterRenameCancel: 'Cancel',
    rosterRenameDone: (name) => `Contact renamed: ${name}`,
    rosterRenameCleared: 'Contact name cleared.',
    mediaExpired: '(attachment evicted from history)',
    mediaLoading: 'Loading attachment…',
    mediaFailed: 'Attachment did not load — tap to retry',
    imagePasting: 'Preparing image…',
    imageTooBig: 'Image is too large even after compression',
    back: 'Peers',
    peerChoose: 'Choose a peer',
    peerChooseLead: 'On the left are all friends added on this server',
    peerOnline: '● online',
    peerOffline: (time) => `○ seen ${time}`,
    officialAccount: 'service account',
    placeholderTitle: 'No peer chosen',
    placeholderText: 'Messages sent while you were offline will arrive as soon as you select a peer.',
    composerPlaceholderDisabled: 'Choose a peer first',
    composerPlaceholderActive: 'Message…',
    send: 'Send',
    modalTitle: 'Add friend',
    myInviteTitle: 'My invite link',
    myInviteHint: 'Single-use invite link to share with a friend. Generating a new link revokes the previous one.',
    myInvitePlaceholder: 'Click "Create"',
    create: 'Create',
    creating: 'Generating link…',
    copy: 'Copy',
    copied: 'Link copied to clipboard!',
    copyManual: 'Select and copy the link manually.',
    createdNotice: 'Link generated. Copy and share it with your friend.',
    createdNoticeFor: (login) => `Link generated for @${login}. Share it with that account.`,
    acceptInviteTitle: 'Enter friend invite',
    acceptInviteHint: 'Paste the invite link or 64-character hex code from your friend.',
    acceptInvitePlaceholder: 'Invite code or link',
    add: 'Add',
    checking: 'Verifying code…',
    friendAdded: (name) => `Friend added: ${name}!`,
    friendRequestTitle: 'Add by @username',
    friendRequestHint: 'Enter a friend login — they receive a request from the service account and can accept it.',
    friendRequestPlaceholder: 'Friend @username',
    friendRequestSending: 'Sending request…',
    friendRequested: (official) => `Request sent — @${official} will let you know once it is accepted.`,
    friendInContacts: (name) => `${name} is in your contacts.`,
    online: 'online',
    lastSeenJustNow: 'just now',
    lastSeenMinutes: (m) => `${m}m ago`,
    lastSeenHours: (h) => `${h}h ago`,
    lastSeenDays: (d) => `${d}d ago`,
    lastSeenLongAgo: 'long ago',
    today: 'today',
    yesterday: 'yesterday',
    connConnecting: 'Connecting…',
    connOnline: 'Online',
    connOffline: 'Offline',
    editFailed: 'The edit was not sent — the text is back as it was',
    peerOutdatedMedia: 'The other side runs an old version of Tailchat — this picture or voice message would not reach them. Ask them to update, then send it again',
    connReconnecting: 'Reconnecting…',
    msgEncryptedWaiting: 'Encrypted message — its key has not reached this device yet',
    e2ee: {
      answer: 'do they match? Answer in the window — or with /verify yes · /verify no',
      signInAgain: 'This device\'s encryption keys are not the ones the server has for it: the browser\'s store was lost or copied, so encryption is off here. Sign in again, then verify this device from another of yours: /verify {self}',
      restoreTitle: 'Restore key backup',
      restoreHint: 'Enter — restore · Esc — cancel. Nothing typed here is shown or kept.',
      resetTitle: 'Reset encryption keys',
      resetHint: 'Enter — reset · Esc — cancel',
      resetNoAnswer: 'the reset has no answer yet — if the server took it, this tab says so as soon as it sees your new keys',
      resetNotReady: 'encryption on this device is not ready — wait until it is connected (or sign in again if you were told to), then retry /keys reset',
      sasTitle: 'Verify {peer}',
      sasHint: 'Compare with {peer} by voice — on a call or in person, not in this chat. The same emojis in the same order on both screens? Then nobody is tampering with your conversation. Closing this window cancels the check.',
      sasMatch: 'They match',
      sasDiffer: 'They differ',
      secretConfirm: 'Confirm',
      secretCancel: 'Cancel',
      backupKeyTitle: 'Recovery key',
      backupKeyHint: 'Key backup is on (version {version}). The recovery key is shown once — keep it somewhere safe: it opens your conversations on a new device.',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy — select the key by hand',
      done: 'Done',
      signInAgainTitle: 'Sign in again',
      signInAgainNow: 'Sign in again',
      later: 'Later',
      menuVerify: 'Verify',
      menuTrust: 'Accept new keys',
      safetyTitle: 'Safety code',
      safetyLoading: 'Fetching keys…',
      safetyNotVerified: 'Optional. To make sure nobody swapped the keys, read the emojis to each other by voice — on a call or in person, not in this chat. Once is enough: {peer} sees the same emojis in the same order, and they stay the same until one of you resets keys.',
      safetyKeyChanged: '⚠ {peer}\'s keys changed. Usually that is a new device or a key reset, but tampering looks the same. Until you compare the new code by voice or accept the keys without comparing, nothing is sent to {peer}.',
      safetyIsVerifiedShort: '✓ Verified: {peer}\'s keys are confirmed, nobody is tampering with your conversation.',
      safetyConfirm: 'They match — mark as verified',
      settingsHeading: 'Encryption',
      settingsBackupCreate: 'Back up keys',
      settingsBackupStatus: 'Backup status',
      settingsBackupRestore: 'Restore from backup',
      settingsKeysReset: 'Reset keys',
    },
    typing: (name) => `${name} is typing…`,
    unreadTooltip: 'Unread messages',
    notifyNewMessage: 'New message',
    wakeSent: '🔔 Wake signal sent to peer',
    wakeReceived: (name) => `🔔 ${name} sent a wake signal!`,
    helpHeader: '═ TAILCHAT COMMANDS LIST ═══════════════════════════════',
    helpFooter: '════════════════════════════════════════════════════════',
    pingResult: (ms) => `● Latency to server & peer: ${ms} ms`,
    pingTimeout: (name) => `● Ping to ${name}: timed out`,
    themeSet: (t) => `Theme changed to: ${t}`,
    holidaySet: (on) => `Holiday mode: ${on ? 'ON' : 'OFF'}`,
    soundSet: (on) => `Sound effects: ${on ? 'ON' : 'OFF'}`,
    notifyOn: 'Notifications: ON',
    notifyOff: 'Notifications: OFF',
    notifyBlocked: 'Notifications are blocked in browser settings.',
    notifyAllow: 'Notifications — allow in the browser',
    notifySet: (on) => `System notifications: ${on ? 'ON' : 'OFF'}`,
    voiceMessageNotify: (dur) => `🎙 Voice message (${dur})`,
    typingSet: (on) => `Typing indicator: ${on ? 'ON' : 'OFF'}`,
    nickSet: (n) => `Display name changed to: ${n}`,
    historyExported: 'Chat transcript exported to file',
    wakePeerTitle: 'Wake peer (/wake)',
    exportHistoryTitle: 'Export history (/history)',
    themeBtnTitle: 'Color Theme',
    logoBandTitle: 'Click to redraw logo (/logo)',
    chatCleared: 'Chat view cleared',
    pingSent: 'Ping sent…',
    codeUsage: 'Usage: /code <code> — the text is sent as a code block',
    versionInfo: (v) => `● Tailchat web client ${v}`,
    statusHeader: '═ SESSION STATUS ═══════════════════════════════════════',
    statusSocket: (state) => `  link: ${state}`,
    statusPeerLine: (name, state) => `  peer: ${name} — ${state}`,
    statusNoPeer: '  peer: none selected',
    statusLatency: (value) => `  latency: ${value}`,
    statusRoute: (route) => `  route: ${route}`,
    delUsage: (max) => `Usage: /del [n], where n is between 1 and ${max}`,
    delNothing: 'Nothing to delete — you have not sent anything in this conversation',
    delDone: (n) => `Deleted ${n} message(s)`,
    langSet: (lang) => `Interface language: ${lang}`,
    langUsage: 'Usage: /lang [ru|en|fr]',
    reconnectRequested: 'Reconnecting to the server…',
    pastedImage: '🖼 [Image]',
    pasteHint: 'Press Ctrl+V (Cmd+V) to paste an image screenshot from your clipboard',
    installApp: '📱 Install',
    installTitle: 'Install web app on mobile or desktop',
    pwaIosTitle: 'Install on iPhone / iPad',
    pwaIosDesc: 'To install Tailchat as a standalone web app on iOS:',
    pwaIosStep1: 'Tap the "Share" button (⎋ or 📤) in Safari.',
    pwaIosStep2: 'Scroll down and select "Add to Home Screen" (➕).',
    pwaIosStep3: 'Tap "Add" in the top right corner.',
    pwaIosAck: 'Got it',
    togglePanePeers: 'Peers',
    togglePaneInfo: 'Info',
    togglePeersTitle: 'Peers panel (Ctrl+B)',
    togglePaneInfoTitle: 'Info panel (Ctrl+I)',
    resizeRoster: 'Resize peers panel',
    resizeInfo: 'Resize info panel',
    savedMessages: '📝 Saved Messages',
    savedMessagesHint: 'Notes to yourself',
    infoTitle: 'PEER',
    convMenuTitle: 'Conversation options',
    directFailedTitle: 'Direct link failed (P2P), messages go through the server',
    directOffTitle: 'Connect directly (e2e encryption p2p, bypassing the server)',
    directConnectingTitle: 'Connecting directly (e2e encryption p2p)…',
    directOnTitle: 'Direct link active (e2e encryption p2p, bypassing the server)',
    infoClose: 'Close panel',
    infoNoPeer: 'No peer chosen',
    infoStats: 'Stats',
    infoStatMessages: 'Messages',
    infoStatImages: 'Images',
    infoStatVoice: 'Voice notes',
    infoStatUnread: 'Unread',
    infoActions: 'Actions',
    infoWake: 'Wake peer',
    infoExport: 'Export transcript',
    infoClearView: 'Clear view',
    infoSession: 'Session',
    infoServer: 'Server',
    cloudName: 'cloud',
    infoTransport: 'Transport',
    infoLatency: 'Latency',
    infoRoute: 'Route',
    infoClient: 'Client',
    routeYou: 'you',
    routeDirect: '(direct)',
    routeClientWeb: 'web',
    routeClientCli: (v) => `terminal ${v}`,
    routeClientUnknown: 'has not said yet',
    infoMeasure: 'Measure latency',
    infoLatencyValue: (ms) => `${ms} ms`,
    voiceButtonTitle: 'Record a voice message',
    voiceRecording: '● REC',
    voiceCapped: '■ LIMIT',
    voiceCancel: 'Cancel',
    voiceSendLabel: 'Send',
    voiceMicDenied: 'Microphone unavailable. Allow access to it in your browser settings.',
    voiceAsking: '… asking for the microphone',
    voiceNoDevice: 'No microphone found. Connect one and try again.',
    voiceInsecure: 'Recording needs HTTPS — this page is not on a secure origin.',
    voiceNoRecorder: 'This browser cannot record audio.',
    voiceEmpty: 'Recording was empty — nothing sent.',
    voiceSilent: 'The recording has no sound in it — check the microphone is unmuted and the right input is selected.',
    voiceTooLarge: 'Voice message is too large. Record a shorter message.',
    voiceCappedNote: (max) => `Recording stopped: ${max} limit reached.`,
    voicePlay: 'Play',
    voicePause: 'Pause',
    voiceSpeedTitle: 'Playback speed',
    profileOpen: 'Profile',
    profileTitle: 'Profile',
    profileLoginLabel: 'Login',
    profileLoginHint: 'Permanent account identifier.',
    profileNameLabel: 'Display name',
    profilePasswordTitle: 'Change password',
    profilePasswordHint: 'Leave these fields empty to keep your password.',
    profileCurrentPassword: 'Current password',
    profileNewPassword: 'New password',
    profileConfirmPassword: 'Confirm new password',
    profileExtraPasswordTitle: 'Additional password',
    profileExtraPasswordHint: 'Optional. When enabled, signing in requires it together with the regular password.',
    profileExtraPasswordEnabledLabel: 'Use an additional password',
    profileExtraPasswordLabel: 'Additional password',
    profileExtraPasswordConfirmLabel: 'Confirm additional password',
    profileExtraPasswordNote: 'To turn the additional password on, off, or change it, enter your current (regular) password above.',
    profileCancel: 'Cancel',
    profileSave: 'Save changes',
    profileSaving: 'Saving…',
    profileSaved: 'Profile saved.',
    attachFile: 'Send file',
    emojiButton: 'Emoji',
    emojiSearch: 'Search emoji',
    emojiNothingFound: 'Nothing found',
    emojiMore: 'All emoji',
    emojiCatRecent: 'Recent',
    emojiCatSmileys: 'Smileys',
    emojiCatPeople: 'People and gestures',
    emojiCatAnimals: 'Animals and nature',
    emojiCatFood: 'Food',
    emojiCatActivities: 'Activities',
    emojiCatTravel: 'Travel',
    emojiCatObjects: 'Objects',
    emojiCatSymbols: 'Symbols',
    emojiCatFlags: 'Flags',
    imageOpen: 'Open image',
    imageTitle: 'Image',
    imageSave: 'Save image',
    imageSheetTitle: 'Send an image',
    imageCancel: 'Cancel',
    imageCrop: 'Crop',
    imageCropRatio: 'Aspect ratio',
    imageCropFree: 'Free',
    imageCropReset: 'Reset',
    imageRotate: 'Rotate 90°',
    imageCaption: 'Caption',
    fileOpen: 'Open file',
    fileReceiving: (name, percent) => `Receiving ${name}: ${percent}%`,
    fileFailed: (name) => `Could not receive ${name}.`,
    fileTooLarge: 'File is larger than 25 MB.',
    fileNeedsOnline: 'Files can be sent while the peer is online.',
    fileSent: (name) => `File sent: ${name}`,
    errors: {
      bad_credentials: 'Wrong login or password.',
      extra_password_required: 'Enter the additional password.',
      bad_recovery_key: 'Invalid recovery key or login.',
      login_taken: 'This login is already taken.',
      invalid_login: 'Login: 3 to 32 characters, latin letters, numbers, dot, dash, underscore.',
      invalid_password: 'Password: 1 to 200 characters.',
      password_mismatch: 'Passwords do not match.',
      invalid_name: 'Invalid display name.',
      too_many_attempts: 'Too many attempts. Please wait a few minutes.',
      unknown_token: 'Session expired. Please sign in again.',
      auth_required: 'Session expired. Please sign in again.',
      auth_failed: 'Session expired. Please sign in again.',
      peer_not_found: 'Peer not found on server.',
      not_subscribed: 'No peer chosen.',
      frame_too_large: 'Message is too large.',
      rate_limited: 'Too fast. Please slow down.',
      invalid_invite: 'Invalid invite code.',
      invite_not_found: 'Invite code not found or already consumed.',
      self_invite: 'You cannot accept your own invite code.',
      invalid_login: 'Invalid login.',
      self_request: 'That is your own account.',
      official_request: 'A friend request is not sent to a service account.',
      request_limit: 'Too many friend requests. Try again later.',
      not_friends: 'This user is not in your friends list.',
      self_block: 'You cannot block yourself.',
      self_remove: 'You cannot remove yourself from your contacts.',
      official_contact: 'The official contact cannot be deleted.',
      unknown_user: 'User not found.',
      invalid_alias: 'That name will not do: empty, or nothing but control characters (up to 32 characters).',
      forbidden: 'Only the deployment owner can mint an invite for another account.',
      official_invite: 'An invite is not issued for an official contact.',
      blocked: 'This contact is blocked.',
      invalid_json: 'Malformed request.',
      unknown_action: 'Unknown request.',
      network: 'Server unreachable. Check your connection.',
    },
  },
  fr: {
    bootNote: 'Chargement…',
    authTitleLogin: 'Connexion',
    authTitleRegister: 'Créer un compte',
    authTitleRecover: 'Récupération de mot de passe',
    authLeadLogin: 'L’identifiant et le mot de passe sont les mêmes que dans Tailchat CLI avec --cloud.',
    authLeadRegister: 'Votre identifiant est visible sur ce serveur. Les mots de passe ne sont jamais stockés en clair.',
    authLeadRecover: 'Entrez votre identifiant, votre clé de secours (Recovery Key) et un nouveau mot de passe.',
    labelLogin: 'Identifiant',
    hintLogin: 'Lettres, chiffres, point, tiret, souligné. 3 à 32 caractères.',
    labelName: 'Nom affiché',
    hintName: 'Visible par les contacts. Laissez vide pour utiliser l’identifiant.',
    labelRecovery: 'Clé de secours',
    hintRecovery: 'Clé d’urgence (Recovery Key) générée lors de l’inscription.',
    labelPassword: 'Mot de passe',
    labelPasswordConfirm: 'Confirmez le mot de passe',
    hintPasswordConfirm: 'Entrez à nouveau le mot de passe pour vérification.',
    labelExtraPassword: 'Mot de passe supplémentaire',
    hintExtraPassword: 'Ce compte a un mot de passe supplémentaire activé. Saisissez-le pour terminer la connexion.',
    hintPasswordRegister: 'Tout mot de passe est accepté. Un mot de passe fort est recommandé (ex: Tr0ngP@ssw0rd!2026).',
    hintPasswordRecover: 'Définissez un nouveau mot de passe pour votre compte.',
    authSubmitLogin: 'Se connecter',
    authSubmitRegister: 'Créer un compte',
    authSubmitRecover: 'Réinitialiser le mot de passe',
    authSwitchNoteLogin: 'Pas encore de compte ?',
    authSwitchNoteRegister: 'Vous avez déjà un compte ?',
    authSwitchNoteRecover: 'Mot de passe retrouvé ?',
    authSwitchLogin: 'Créer un compte',
    authSwitchRegister: 'Se connecter',
    authSwitchRecover: 'Se connecter',
    authForgotBtn: 'Mot de passe oublié ?',
    recModalTitle: 'Clé de secours',
    recModalHint: 'Conservez cette clé de secours en lieu sûr. Elle permet de réinitialiser votre mot de passe.',
    recCopy: 'Copier',
    recContinue: 'Continuer vers le chat',
    recCopied: 'Clé copiée dans le presse-papiers !',
    recClose: 'Fermer',
    passToggleShow: 'Afficher le mot de passe',
    passToggleHide: 'Masquer le mot de passe',
    authApkTitle: 'Télécharger l’APK Android',
    closeDialog: 'Fermer',
    rosterTitle: 'Contacts',
    rosterEmpty: 'Aucun ami pour le moment. Cliquez sur « + » ci-dessus pour en ajouter.',
    previewYou: 'Vous',
    previewImage: '📷 Photo',
    previewVoice: '🎙 Vocal',
    previewFile: '📎 Fichier',
    addFriend: '+ Ajouter un ami',
    logout: 'Déconnexion',
    settings: 'Réglages',
    settingsMode: 'Apparence',
    settingsScheme: 'Palette de couleurs',
    settingsFont: 'Police',
    settingsWallpaper: 'Fond de discussion',
    wallpaperNone: 'Sans motif',
    wallpaperDots: 'Points',
    wallpaperRuled: 'Papier ligné',
    wallpaperDiamond: 'Losange',
    wallpaperAurora: 'Aurore',
    wallpaperWaves: 'Vagues',
    wallpaperTopo: 'Relief',
    wallpaperDoodle: 'Croquis',
    settingsRound: 'Angles',
    settingsBorders: 'Contours',
    settingsDepth: 'Relief',
    fontMono: 'Terminal',
    fontSans: 'Linéale',
    fontSerif: 'Garamond',
    roundSharp: 'Vifs',
    roundSoft: 'Doux',
    roundRound: 'Ronds',
    settingsBehaviour: 'Comportement',
    settingsLang: 'Langue',
    settingsApps: 'Applications',
    settingsAccount: 'Compte',
    settingsSound: 'Sons',
    settingsSoundSend: 'Son d’envoi',
    settingsVolume: 'Volume des sons',
    settingsSoundPick: 'Son de réception personnalisé',
    settingsSoundReset: 'Revenir au son intégré',
    settingsSoundDefault: 'Son intégré',
    settingsSoundTooBig: 'Plus de 2 Mo — choisissez plus court',
    settingsSoundNotAudio: 'Ce fichier n’est pas audio',
    settingsSoundUndecodable: 'Ce navigateur ne sait pas lire ce fichier',
    soundEnable: 'Activer les sons',
    soundDisable: 'Couper les sons',
    soundOnShort: 'Son : actif',
    soundOffShort: 'Son : coupé',
    settingsNotify: 'Notifications',
    settingsTyping: 'Afficher « écrit… »',
    settingsHoliday: 'Logo de fête',
    settingsLinkPreview: 'Aperçus de liens',
    settingsShowDeleted: 'Afficher les messages supprimés',
    settingsQuickReactions: 'Réactions rapides',
    settingsQuickReactionSlot: (slot, emoji) => `Réaction ${slot} : ${emoji}`,
    settingsInstall: 'Installer comme application',
    settingsApk: 'APK Android',
    updateAvailable: 'Mettre à jour',
    updateAvailableTitle: 'Mise à jour disponible — cliquez pour recharger',
    settingsProfile: 'Profil',
    modeAuto: 'Auto',
    modeLight: 'Clair',
    modeDark: 'Sombre',
    modeSet: (name) => `Apparence : ${name}`,
    presenceIdle: 'inactif',
    presenceAway: 'absent',
    peerIdle: '◐ inactif',
    peerAway: '◔ absent',
    msgMenu: 'Actions du message',
    msgCopy: 'Copier le texte',
    msgCopied: 'Texte copié',
    msgDeleteMine: 'Supprimer pour moi',
    msgReadAt: (value) => `Lu : ${value}`,
    msgEditedAt: (value) => `Modifié : ${value}`,
    viaWeb: 'navigateur',
    viaCli: 'terminal',
    viaAndroid: 'téléphone',
    msgDeleteAll: 'Supprimer pour tout le monde',
    msgEdit: 'Modifier',
    msgReply: 'Répondre',
    msgReact: 'Réagir',
    msgForward: 'Transférer',
    msgForwardTo: 'Transférer à',
    msgSelect: 'Sélectionner',
    msgSelectedCount: (count) => `Sélectionnés : ${count}`,
    msgSelectCancel: 'Désélectionner',
    msgForwardedFrom: (who) => `Transféré de ${who}`,
    editingMessage: 'Modification du message',
    replyingTo: (name) => `Réponse à ${name}`,
    msgDeleted: 'Message supprimé',
    rosterMenu: 'Actions du contact',
    // See `botMenu` in the Russian dictionary: the client's own button in an
    // empty `{tailchat}` thread.
    botMenu: 'Menu',
    rosterOpenChat: 'Ouvrir la discussion',
    rosterPin: 'Épingler la discussion',
    rosterUnpin: 'Désépingler la discussion',
    rosterBlock: 'Bloquer',
    rosterUnblock: 'Débloquer',
    composerBlockedHint: 'Ce contact est bloqué',
    rosterMarkRead: 'Marquer comme lu',
    rosterMarkUnread: 'Marquer comme non lu',
    msgRemind: 'Rappeler',
    msgRemind15m: '15 minutes',
    msgRemind1h: '1 heure',
    msgRemindEvening: 'ce soir',
    msgRemindTomorrow: 'demain',
    replyReminderDue: (name) => `Il est temps de répondre à ${name}`,
    rosterCopyLogin: 'Copier l’identifiant',
    rosterLoginCopied: (login) => `Identifiant copié : ${login}`,
    rosterInfo: 'Détails',
    rosterClearHistory: 'Effacer l’historique pour moi',
    rosterRemoveContact: 'Supprimer le contact',
    rosterRemoveConfirm: 'Supprimer le contact et la conversation ? Votre copie disparaît définitivement, l’autre personne garde la sienne. Action irréversible.',
    rosterRemoveDone: 'Contact et conversation supprimés.',
    rosterRemoveCancel: 'Annuler',
    rosterRename: 'Renommer',
    rosterRenameHint: 'Un nom privé pour ce contact, visible par vous seul. Videz le champ et appuyez sur Enregistrer pour le retirer.',
    rosterRenameConfirm: 'Enregistrer',
    rosterRenameCancel: 'Annuler',
    rosterRenameDone: (name) => `Contact renommé : ${name}`,
    rosterRenameCleared: 'Nom du contact effacé.',
    newMessages: 'Nouveaux messages',
    mediaExpired: '(pièce jointe évincée de l’historique)',
    mediaLoading: 'Chargement de la pièce jointe…',
    mediaFailed: 'La pièce jointe ne s’est pas chargée — touchez pour réessayer',
    imagePasting: 'Préparation de l’image…',
    imageTooBig: 'Image trop volumineuse même après compression',
    back: 'Contacts',
    peerChoose: 'Choisir un contact',
    peerChooseLead: 'À gauche se trouvent tous les amis ajoutés sur ce serveur',
    peerOnline: '● en ligne',
    peerOffline: (time) => `○ vu ${time}`,
    officialAccount: 'compte de service',
    placeholderTitle: 'Aucun contact choisi',
    placeholderText: 'Les messages reçus pendant votre absence arriveront dès que vous aurez choisi un contact.',
    composerPlaceholderDisabled: 'Choisissez d’abord un contact',
    composerPlaceholderActive: 'Message…',
    send: 'Envoyer',
    modalTitle: 'Ajouter un ami',
    myInviteTitle: 'Mon lien d’invitation',
    myInviteHint: 'Lien d’invitation à usage unique pour un ami. Générer un nouveau lien annule le précédent.',
    myInvitePlaceholder: 'Cliquez sur « Créer »',
    create: 'Créer',
    creating: 'Génération du lien…',
    copy: 'Copier',
    copied: 'Lien copié dans le presse-papiers !',
    copyManual: 'Sélectionnez et copiez le lien manuellement.',
    createdNotice: 'Lien créé. Copiez-le et donnez-le à votre ami.',
    createdNoticeFor: (login) => `Lien créé pour @${login}. Transmettez-le à ce compte.`,
    acceptInviteTitle: 'Entrer une invitation',
    acceptInviteHint: 'Collez le lien d’invitation ou le code hexadécimal de 64 caractères reçu d’un ami.',
    acceptInvitePlaceholder: 'Code ou lien d’invitation',
    add: 'Ajouter',
    checking: 'Vérification…',
    friendAdded: (name) => `Ami ajouté : ${name} !`,
    friendRequestTitle: 'Ajouter par @username',
    friendRequestHint: 'Indiquez l’identifiant d’un ami : il recevra une demande du compte de service et pourra l’accepter.',
    friendRequestPlaceholder: '@username de l’ami',
    friendRequestSending: 'Envoi de la demande…',
    friendRequested: (official) => `Demande envoyée — @${official} vous préviendra dès qu’elle sera acceptée.`,
    friendInContacts: (name) => `${name} est dans vos contacts.`,
    online: 'en ligne',
    lastSeenJustNow: 'à l’instant',
    lastSeenMinutes: (m) => `il y a ${m} min`,
    lastSeenHours: (h) => `il y a ${h} h`,
    lastSeenDays: (d) => `il y a ${d} j`,
    lastSeenLongAgo: 'il y a longtemps',
    today: 'aujourd’hui',
    yesterday: 'hier',
    connConnecting: 'Connexion…',
    connOnline: 'En ligne',
    connOffline: 'Hors ligne',
    editFailed: 'La modification n’a pas été envoyée — le texte est revenu comme avant',
    peerOutdatedMedia: 'Votre correspondant utilise une ancienne version de Tailchat — cette photo ou ce message vocal ne lui parviendrait pas. Demandez-lui de mettre à jour, puis renvoyez-le',
    connReconnecting: 'Reconnexion…',
    msgEncryptedWaiting: 'Message chiffré — sa clé n’est pas encore arrivée sur cet appareil',
    e2ee: {
      answer: 'ils correspondent ? Répondez dans la fenêtre — ou avec /verify yes · /verify no',
      signInAgain: 'Les clés de chiffrement de cet appareil ne sont pas celles que le serveur a pour lui : le stockage du navigateur a été perdu ou copié, le chiffrement est donc coupé ici. Reconnectez-vous, puis vérifiez cet appareil depuis un autre des vôtres : /verify {self}',
      restoreTitle: 'Restaurer la sauvegarde des clés',
      restoreHint: 'Entrée — restaurer · Échap — annuler. Rien de ce qui est saisi n’est affiché ni conservé.',
      resetTitle: 'Réinitialiser les clés de chiffrement',
      resetHint: 'Entrée — réinitialiser · Échap — annuler',
      resetNoAnswer: 'pas encore de réponse à la réinitialisation — si le serveur l’a acceptée, cet onglet le dira dès qu’il verra vos nouvelles clés',
      resetNotReady: 'le chiffrement de cet appareil n’est pas prêt — attendez qu’il soit connecté (ou reconnectez-vous si on vous l’a demandé), puis relancez /keys reset',
      sasTitle: 'Vérification avec {peer}',
      sasHint: 'Comparez avec {peer} de vive voix — au téléphone ou en personne, pas dans ce chat. Les mêmes émojis dans le même ordre sur les deux écrans ? Alors personne ne falsifie votre conversation. Fermer cette fenêtre annule la vérification.',
      sasMatch: 'Ils correspondent',
      sasDiffer: 'Ils diffèrent',
      secretConfirm: 'Confirmer',
      secretCancel: 'Annuler',
      backupKeyTitle: 'Clé de récupération',
      backupKeyHint: 'La sauvegarde des clés est active (version {version}). La clé de récupération n’est affichée qu’une fois — gardez-la en lieu sûr : elle ouvre vos conversations sur un nouvel appareil.',
      copy: 'Copier',
      copied: 'Copié',
      copyFailed: 'Copie impossible — sélectionnez la clé à la main',
      done: 'Terminé',
      signInAgainTitle: 'Reconnectez-vous',
      signInAgainNow: 'Se reconnecter',
      later: 'Plus tard',
      menuVerify: 'Vérifier',
      menuTrust: 'Accepter les nouvelles clés',
      safetyTitle: 'Code de sécurité',
      safetyLoading: 'Récupération des clés…',
      safetyNotVerified: 'Facultatif. Pour vous assurer que personne n’a substitué les clés, lisez-vous les émojis de vive voix — au téléphone ou en personne, pas dans ce chat. Une fois suffit : {peer} voit les mêmes émojis dans le même ordre, et ils ne changent pas tant qu’aucun de vous ne réinitialise ses clés.',
      safetyKeyChanged: '⚠ Les clés de {peer} ont changé. C’est souvent un nouvel appareil ou une réinitialisation, mais une falsification y ressemble. Tant que vous n’avez pas comparé le nouveau code de vive voix ou accepté les clés sans comparer, rien n’est envoyé à {peer}.',
      safetyIsVerifiedShort: '✓ Vérifié : les clés de {peer} sont confirmées, personne ne falsifie votre conversation.',
      safetyConfirm: 'Ils correspondent — marquer comme vérifié',
      settingsHeading: 'Chiffrement',
      settingsBackupCreate: 'Sauvegarder les clés',
      settingsBackupStatus: 'État de la sauvegarde',
      settingsBackupRestore: 'Restaurer la sauvegarde',
      settingsKeysReset: 'Réinitialiser les clés',
    },
    typing: (name) => `${name} écrit…`,
    unreadTooltip: 'Messages non lus',
    notifyNewMessage: 'Nouveau message',
    wakeSent: '🔔 Signal d’attention envoyé',
    wakeReceived: (name) => `🔔 ${name} vous interpelle !`,
    helpHeader: '═ COMMANDES TAILCHAT ═══════════════════════════════════',
    helpFooter: '════════════════════════════════════════════════════════',
    pingResult: (ms) => `● Latence serveur & contact : ${ms} ms`,
    pingTimeout: (name) => `● Ping vers ${name} : délai dépassé`,
    themeSet: (t) => `Thème modifié pour : ${t}`,
    holidaySet: (on) => `Mode vacances : ${on ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`,
    soundSet: (on) => `Effets sonores : ${on ? 'ACTIVÉS' : 'DÉSACTIVÉS'}`,
    notifyOn: 'Notifications : ACTIVÉES',
    notifyOff: 'Notifications : DÉSACTIVÉES',
    notifyBlocked: 'Les notifications sont bloquées dans les paramètres du navigateur.',
    notifyAllow: 'Notifications — autoriser dans le navigateur',
    notifySet: (on) => `Notifications système : ${on ? 'ACTIVÉES' : 'DÉSACTIVÉES'}`,
    voiceMessageNotify: (dur) => `🎙 Message vocal (${dur})`,
    typingSet: (on) => `Indicateur de frappe : ${on ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`,
    nickSet: (n) => `Nom affiché changé pour : ${n}`,
    historyExported: 'Transcription exportée avec succès',
    wakePeerTitle: 'Interpeller le contact (/wake)',
    exportHistoryTitle: 'Exporter l’historique (/history)',
    themeBtnTitle: 'Thème de couleur',
    logoBandTitle: 'Cliquer pour redessiner le logo (/logo)',
    chatCleared: 'Affichage effacé',
    pingSent: 'Ping envoyé…',
    codeUsage: 'Utilisation : /code <code> — le texte part en bloc de code',
    versionInfo: (v) => `● Client web Tailchat ${v}`,
    statusHeader: '═ ÉTAT DE LA SESSION ═══════════════════════════════════',
    statusSocket: (state) => `  lien : ${state}`,
    statusPeerLine: (name, state) => `  contact : ${name} — ${state}`,
    statusNoPeer: '  contact : aucun',
    statusLatency: (value) => `  latence : ${value}`,
    statusRoute: (route) => `  route : ${route}`,
    delUsage: (max) => `Utilisation : /del [n], où n est compris entre 1 et ${max}`,
    delNothing: 'Rien à supprimer — vous n’avez encore rien envoyé dans cette conversation',
    delDone: (n) => `${n} message(s) supprimé(s)`,
    langSet: (lang) => `Langue de l’interface : ${lang}`,
    langUsage: 'Utilisation : /lang [ru|en|fr]',
    reconnectRequested: 'Reconnexion au serveur…',
    pastedImage: '🖼 [Image]',
    pasteHint: 'Appuyez sur Ctrl+V (Cmd+V) pour coller une capture d’écran',
    installApp: '📱 Installer',
    installTitle: 'Installer l’application web',
    pwaIosTitle: 'Installation sur iPhone / iPad',
    pwaIosDesc: 'Pour installer Tailchat en tant qu’application web sur iOS :',
    pwaIosStep1: 'Appuyez sur le bouton « Partager » (⎋ ou 📤) dans Safari.',
    pwaIosStep2: 'Faites défiler et sélectionnez « Sur l’écran d’accueil » (➕).',
    pwaIosStep3: 'Appuyez sur « Ajouter » en haut à droite.',
    pwaIosAck: 'Compris',
    togglePanePeers: 'Contacts',
    togglePaneInfo: 'Infos',
    togglePeersTitle: 'Panneau des contacts (Ctrl+B)',
    togglePaneInfoTitle: 'Panneau d’informations (Ctrl+I)',
    resizeRoster: 'Redimensionner le panneau des contacts',
    resizeInfo: 'Redimensionner le panneau d’informations',
    savedMessages: '📝 Messages enregistrés',
    savedMessagesHint: 'Notes personnelles',
    infoTitle: 'CONTACT',
    infoClose: 'Fermer le panneau',
    convMenuTitle: 'Options de la conversation',
    directFailedTitle: 'Échec de la liaison directe (P2P), les messages passent par le serveur',
    directOffTitle: 'Connexion directe (e2e encryption p2p, sans passer par le serveur)',
    directConnectingTitle: 'Connexion directe (e2e encryption p2p) en cours…',
    directOnTitle: 'Liaison directe active (e2e encryption p2p, sans le serveur)',
    infoNoPeer: 'Aucun contact choisi',
    infoStats: 'Statistiques',
    infoStatMessages: 'Messages',
    infoStatImages: 'Images',
    infoStatVoice: 'Messages vocaux',
    infoStatUnread: 'Non lus',
    infoActions: 'Actions',
    infoWake: 'Appeler le contact',
    infoExport: 'Exporter la transcription',
    infoClearView: 'Effacer l’affichage',
    infoSession: 'Session',
    infoServer: 'Serveur',
    cloudName: 'cloud',
    infoTransport: 'Transport',
    infoLatency: 'Latence',
    infoRoute: 'Route',
    infoClient: 'Client',
    routeYou: 'vous',
    routeDirect: '(direct)',
    routeClientWeb: 'web',
    routeClientCli: (v) => `terminal ${v}`,
    routeClientUnknown: 'ne s’est pas encore présenté',
    infoMeasure: 'Mesurer la latence',
    infoLatencyValue: (ms) => `${ms} ms`,
    voiceButtonTitle: 'Enregistrer un message vocal',
    voiceRecording: '● ENR',
    voiceCapped: '■ LIMITE',
    voiceCancel: 'Annuler',
    voiceSendLabel: 'Envoyer',
    voiceMicDenied: 'Micro indisponible. Autorisez son accès dans les réglages du navigateur.',
    voiceAsking: '… demande du micro',
    voiceNoDevice: 'Aucun micro trouvé. Branchez-en un et réessayez.',
    voiceInsecure: 'L’enregistrement exige HTTPS — cette page n’est pas sur une origine sécurisée.',
    voiceNoRecorder: 'Ce navigateur ne sait pas enregistrer de son.',
    voiceEmpty: 'Enregistrement vide — rien n’a été envoyé.',
    voiceSilent: 'L’enregistrement ne contient aucun son — vérifiez que le micro est activé et que la bonne entrée est sélectionnée.',
    voiceTooLarge: 'Le message vocal est trop volumineux. Enregistrez un message plus court.',
    voiceCappedNote: (max) => `Enregistrement arrêté : limite de ${max}.`,
    voicePlay: 'Lire',
    voicePause: 'Pause',
    voiceSpeedTitle: 'Vitesse de lecture',
    profileOpen: 'Profil',
    profileTitle: 'Profil',
    profileLoginLabel: 'Identifiant',
    profileLoginHint: 'Identifiant permanent du compte.',
    profileNameLabel: 'Nom affiché',
    profilePasswordTitle: 'Changer le mot de passe',
    profilePasswordHint: 'Laissez ces champs vides pour conserver le mot de passe.',
    profileCurrentPassword: 'Mot de passe actuel',
    profileNewPassword: 'Nouveau mot de passe',
    profileConfirmPassword: 'Confirmez le nouveau mot de passe',
    profileExtraPasswordTitle: 'Mot de passe supplémentaire',
    profileExtraPasswordHint: 'Facultatif. S’il est activé, la connexion le demandera en plus du mot de passe habituel.',
    profileExtraPasswordEnabledLabel: 'Utiliser un mot de passe supplémentaire',
    profileExtraPasswordLabel: 'Mot de passe supplémentaire',
    profileExtraPasswordConfirmLabel: 'Confirmez le mot de passe supplémentaire',
    profileExtraPasswordNote: 'Pour activer, désactiver ou changer le mot de passe supplémentaire, indiquez votre mot de passe actuel (habituel) ci-dessus.',
    profileCancel: 'Annuler',
    profileSave: 'Enregistrer',
    profileSaving: 'Enregistrement…',
    profileSaved: 'Profil enregistré.',
    attachFile: 'Envoyer un fichier',
    emojiButton: 'Émoji',
    emojiSearch: 'Rechercher un émoji',
    emojiNothingFound: 'Aucun résultat',
    emojiMore: 'Tous les émojis',
    emojiCatRecent: 'Récents',
    emojiCatSmileys: 'Émoticônes',
    emojiCatPeople: 'Personnes et gestes',
    emojiCatAnimals: 'Animaux et nature',
    emojiCatFood: 'Alimentation',
    emojiCatActivities: 'Activités',
    emojiCatTravel: 'Voyages',
    emojiCatObjects: 'Objets',
    emojiCatSymbols: 'Symboles',
    emojiCatFlags: 'Drapeaux',
    imageOpen: 'Ouvrir l’image',
    imageTitle: 'Image',
    imageSave: 'Enregistrer l’image',
    imageSheetTitle: 'Envoi d’une image',
    imageCancel: 'Annuler',
    imageCrop: 'Recadrer',
    imageCropRatio: 'Proportions',
    imageCropFree: 'Libre',
    imageCropReset: 'Réinitialiser',
    imageRotate: 'Pivoter de 90°',
    imageCaption: 'Légende',
    fileOpen: 'Ouvrir le fichier',
    fileReceiving: (name, percent) => `Réception de ${name} : ${percent} %`,
    fileFailed: (name) => `Impossible de recevoir ${name}.`,
    fileTooLarge: 'Le fichier dépasse 25 Mo.',
    fileNeedsOnline: 'Les fichiers peuvent être envoyés quand le contact est en ligne.',
    fileSent: (name) => `Fichier envoyé : ${name}`,
    errors: {
      bad_credentials: 'Identifiant ou mot de passe incorrect.',
      extra_password_required: 'Saisissez le mot de passe supplémentaire.',
      bad_recovery_key: 'Clé de secours ou identifiant invalide.',
      login_taken: 'Cet identifiant est déjà pris.',
      invalid_login: 'Identifiant : 3 à 32 caractères.',
      invalid_password: 'Mot de passe : 1 à 200 caractères.',
      password_mismatch: 'Les mots de passe ne correspondent pas.',
      invalid_name: 'Nom invalide.',
      too_many_attempts: 'Trop de tentatives. Veuillez patienter.',
      unknown_token: 'Session expirée. Veuillez vous reconnecter.',
      auth_required: 'Session expirée. Veuillez vous reconnecter.',
      auth_failed: 'Session expirée. Veuillez vous reconnecter.',
      peer_not_found: 'Contact introuvable sur le serveur.',
      not_subscribed: 'Aucun contact choisi.',
      frame_too_large: 'Message trop volumineux.',
      rate_limited: 'Trop rapide. Veuillez ralentir.',
      invalid_invite: 'Code d’invitation invalide.',
      invite_not_found: 'Code d’invitation introuvable ou déjà utilisé.',
      self_invite: 'Vous ne pouvez pas accepter votre propre invitation.',
      invalid_login: 'Identifiant invalide.',
      self_request: 'C’est votre propre compte.',
      official_request: 'Aucune demande n’est envoyée à un compte de service.',
      request_limit: 'Trop de demandes. Réessayez plus tard.',
      not_friends: 'Ce contact ne fait pas partie de vos amis.',
      self_block: 'Vous ne pouvez pas vous bloquer vous-même.',
      self_remove: 'Vous ne pouvez pas vous retirer de vos contacts.',
      official_contact: 'Le contact officiel ne peut pas être supprimé.',
      unknown_user: 'Utilisateur introuvable.',
      invalid_alias: 'Ce nom ne convient pas : vide, ou uniquement des caractères de contrôle (32 caractères max).',
      forbidden: 'Seul le propriétaire du déploiement peut créer une invitation pour un autre compte.',
      official_invite: 'Aucune invitation n’est créée pour un contact officiel.',
      blocked: 'Ce contact est bloqué.',
      invalid_json: 'Requête incorrecte.',
      unknown_action: 'Requête inconnue.',
      network: 'Serveur inaccessible. Vérifiez votre connexion.',
    },
  },
};

function getInitialLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && (saved === 'en' || saved === 'ru' || saved === 'fr')) return saved;
  } catch {}
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('ru')) return 'ru';
  if (nav.startsWith('fr')) return 'fr';
  return 'en';
}

// A stored palette is a *choice* only when the marker beside it says so. Until
// 1.76 the client wrote the theme on every boot, so every browser that ever
// opened the app holds a value — including the ones whose owner never touched
// the picker. Without the marker that value is indistinguishable from a choice,
// and the default could never reach anyone who had used an older build: they
// would keep whatever palette happened to be current the first time the page
// loaded. `fontWasCustomized` had the same problem from the other side (the old
// boot called `setFont`, which persisted), which is why it is a marker too
// rather than "the key exists".
function appearanceWasChosen(markerKey) {
  try {
    return localStorage.getItem(markerKey) != null;
  } catch {
    // Private browsing, or storage the user has denied: nothing was chosen.
    return false;
  }
}

// The book theme is set in an antiqua; the terminal palettes keep the
// monospace face unless the person says otherwise.
function defaultFontFor(theme) {
  return theme === 'paper' ? 'serif' : 'mono';
}

function getInitialTheme() {
  if (appearanceWasChosen(THEME_CHOSEN_KEY)) {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved && THEMES.includes(saved)) return saved;
    } catch {}
  }
  // Since 1.128 the default is the terminal palette the app was born in, now
  // on its glass-and-aurora skin; the book theme stays one click away.
  return 'green';
}

// Both read the same way: a stored choice if it is still one of the offered
// ones, otherwise the default the stylesheet already assumes.
function storedChoice(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    if (saved && allowed.includes(saved)) return saved;
  } catch {
    // Private browsing, or storage the user has denied: the default is fine.
  }
  return fallback;
}

function getInitialMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved && MODES.includes(saved)) return saved;
    if (localStorage.getItem(THEME_KEY) === 'light') return 'light';
  } catch {}
  return 'auto';
}

let currentLang = getInitialLang();
let currentTheme = getInitialTheme();
let currentMode = getInitialMode();
let fontWasCustomized = appearanceWasChosen(FONT_CHOSEN_KEY);
let currentFont = fontWasCustomized
  ? storedChoice(FONT_KEY, FONTS, defaultFontFor(currentTheme))
  : defaultFontFor(currentTheme);
let currentRound = storedChoice(ROUND_KEY, ROUNDS, 'soft');
// «Обводки» replaced the «Рамки сообщений» segment in 1.130. The old choice
// carries over once (`outlined` → on, `plain` → off) and its key is dropped on
// the same boot, so every later start reads only the new one. Default off: the
// layout separates things by tone and spacing, a line around everything is the
// opt-in.
function getInitialBorders() {
  let saved = null;
  let legacy = null;
  try {
    saved = localStorage.getItem(BORDERS_KEY);
    legacy = localStorage.getItem('tailchat-cloud-bubbles');
  } catch {}
  const on = saved !== null ? saved === 'on' : legacy === 'outlined';
  // Reading a choice can succeed while migrating it fails (full storage).
  // Paint what was read anyway; leave the legacy value for the next boot if
  // the new key could not be saved.
  if (legacy !== null) {
    try {
      if (saved === null && (legacy === 'outlined' || legacy === 'plain')) {
        localStorage.setItem(BORDERS_KEY, on ? 'on' : 'off');
      }
      localStorage.removeItem('tailchat-cloud-bubbles');
    } catch {}
  }
  return on;
}
let bordersOn = getInitialBorders();
// «Объёмный дизайн» (1.128's depth): on by default since 1.133 (owner,
// 2026-10-28: «depth поставь по-умолчанию»). Only an explicit `off` — written
// by a click on the toggle, never by boot — keeps the flat look, so somebody
// who switched it off in 1.132 keeps their choice. Reading never writes.
function getInitialDepth() {
  try {
    return localStorage.getItem(DEPTH_KEY) !== 'off';
  } catch {
    return true;
  }
}
let depthOn = getInitialDepth();
// Same problem `appearanceWasChosen` solves for the theme: until 1.128 every
// boot wrote `none` into WALLPAPER_KEY, so a stored `none` cannot be told apart
// from a browser that simply opened an older build. Only a pattern somebody
// clicked counts — the marker, or a stored pattern other than `none` (the old
// boot never wrote one of those by itself). Everything else gets the default.
function getInitialWallpaper() {
  const stored = storedChoice(WALLPAPER_KEY, WALLPAPERS, null);
  if (stored && (stored !== 'none' || appearanceWasChosen(WALLPAPER_CHOSEN_KEY))) return stored;
  return DEFAULT_WALLPAPER;
}
let currentWallpaper = getInitialWallpaper();
let soundEnabled = localStorage.getItem(SOUND_KEY) !== 'false';
let mutedContacts = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(MUTED_CONTACTS_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter((login) => typeof login === 'string' && login) : []);
  } catch {
    return new Set();
  }
})();
// Own outgoing messages are the one sound a person hears dozens of times an
// hour, so it gets its own switch — and defaults off, because the message
// appearing on screen already confirms it.
let sendSoundEnabled = localStorage.getItem(SEND_SOUND_KEY) === 'true';
// A pure attenuator on top of the already-lowered cue levels (see SOUND_CUES):
// 100% is the current tuned peaks, never louder, so the slider can only ever
// make a guessed level quieter, not accidentally re-introduce a loud one.
let soundVolume = (() => {
  const stored = localStorage.getItem(VOLUME_KEY);
  const raw = stored == null || stored === '' ? NaN : Number(stored);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
})();
let typingEnabled = localStorage.getItem(TYPING_KEY) !== 'false';
let showDeletedMessages = localStorage.getItem(SHOW_DELETED_KEY) === 'true';
let holidayMode = localStorage.getItem(HOLIDAY_KEY) === 'true';
let notifyEnabled = localStorage.getItem(NOTIFY_KEY) !== 'false';
let linkPreviewEnabled = localStorage.getItem(LINK_PREVIEW_KEY) !== 'false';
// Read once at load, mutated by the speed button on any voice player, and
// used as the starting rate for every voice player built afterwards — a
// speed picked on one message applies to the next one opened, same session.
let voicePlaybackRate = (() => {
  const stored = Number.parseFloat(localStorage.getItem(VOICE_SPEED_KEY) || '');
  return VOICE_SPEEDS.includes(stored) ? stored : 1;
})();

// Most keys are flat, but `errors.*` lives in a nested object that several
// call sites address with a dotted key. A flat lookup missed those and fell
// through to returning the key itself, which is how «errors.auth_required»
// came to be shown to people as if it were a sentence.
function lookup(dict, key) {
  if (!dict) return undefined;
  if (Object.hasOwn(dict, key)) return dict[key];
  const dot = key.indexOf('.');
  if (dot === -1) return undefined;
  const group = dict[key.slice(0, dot)];
  return group && typeof group === 'object' ? group[key.slice(dot + 1)] : undefined;
}

function t(key, ...args) {
  const dict = I18N[currentLang] || I18N.ru;
  const val = lookup(dict, key) ?? lookup(I18N.ru, key);
  if (typeof val === 'function') return val(...args);
  return val ?? key;
}

const elements = {
  boot: document.querySelector('#boot'),
  bootNote: document.querySelector('#boot-note'),
  auth: document.querySelector('#auth'),
  authTitle: document.querySelector('#auth-title'),
  authLead: document.querySelector('#auth-lead'),
  authForm: document.querySelector('#auth-form'),
  authSubmit: document.querySelector('#auth-submit'),
  authError: document.querySelector('#auth-error'),
  authSwitch: document.querySelector('#auth-switch'),
  authSwitchNote: document.querySelector('#auth-switch-note'),
  authForgotBtn: document.querySelector('#auth-forgot-btn'),
  fieldLogin: document.querySelector('#field-login'),
  labelLogin: document.querySelector('#label-login'),
  fieldName: document.querySelector('#field-name'),
  labelName: document.querySelector('#label-name'),
  fieldNameRow: document.querySelector('#field-name-row'),
  fieldRecoveryRow: document.querySelector('#field-recovery-row'),
  fieldRecovery: document.querySelector('#field-recovery'),
  labelRecovery: document.querySelector('#label-recovery'),
  hintRecovery: document.querySelector('#hint-recovery'),
  fieldPassword: document.querySelector('#field-password'),
  labelPassword: document.querySelector('#label-password'),
  fieldPasswordConfirm: document.querySelector('#field-password-confirm'),
  labelPasswordConfirm: document.querySelector('#label-password-confirm'),
  fieldPasswordConfirmRow: document.querySelector('#field-password-confirm-row'),
  hintPasswordConfirm: document.querySelector('#hint-password-confirm'),
  passToggleBtn: document.querySelector('#pass-toggle-btn'),
  passConfirmToggleBtn: document.querySelector('#pass-confirm-toggle-btn'),
  fieldExtraPasswordRow: document.querySelector('#field-extra-password-row'),
  fieldExtraPassword: document.querySelector('#field-extra-password'),
  labelExtraPassword: document.querySelector('#label-extra-password'),
  hintExtraPassword: document.querySelector('#hint-extra-password'),
  extraPassToggleBtn: document.querySelector('#extra-pass-toggle-btn'),
  hintLogin: document.querySelector('#hint-login'),
  hintName: document.querySelector('#hint-name'),
  hintPassword: document.querySelector('#hint-password'),
  recoveryDialog: document.querySelector('#recovery-dialog'),
  recModalTitle: document.querySelector('#rec-modal-title'),
  recModalHint: document.querySelector('#rec-modal-hint'),
  recCloseBtn: document.querySelector('#rec-close-btn'),
  recKeyInput: document.querySelector('#rec-key-input'),
  recCopyBtn: document.querySelector('#rec-copy-btn'),
  recCopyStatus: document.querySelector('#rec-copy-status'),
  recContinueBtn: document.querySelector('#rec-continue-btn'),
  app: document.querySelector('#app'),
  roster: document.querySelector('#roster'),
  selfName: document.querySelector('#self-name'),
  selfLogin: document.querySelector('#self-login'),
  rosterTitle: document.querySelector('#roster-title'),
  rosterList: document.querySelector('#roster-list'),
  rosterEmpty: document.querySelector('#roster-empty'),
  inviteOpenButton: document.querySelector('#invite-open-button'),
  logoutButton: document.querySelector('#logout-button'),
  backButton: document.querySelector('#back-button'),
  backButtonLabel: document.querySelector('#back-button-label'),
  peerName: document.querySelector('#peer-name'),
  peerStatus: document.querySelector('#peer-status'),
  selfConnectionDot: document.querySelector('#self-connection-dot'),
  railSelfButton: document.querySelector('#rail-self-btn'),
  railSelfInitial: document.querySelector('#rail-self-initial'),
  railSelfDot: document.querySelector('#rail-self-dot'),
  transcript: document.querySelector('#transcript'),
  placeholder: document.querySelector('#placeholder'),
  placeholderTitle: document.querySelector('#placeholder-title'),
  placeholderText: document.querySelector('#placeholder-text'),
  typing: document.querySelector('#typing'),
  typingBar: document.querySelector('#typing-bar'),
  composer: document.querySelector('#composer'),
  composerGrow: document.querySelector('#composer-grow'),
  input: document.querySelector('#composer-input'),
  sendButton: document.querySelector('#send-button'),
  sendLabel: document.querySelector('#send-label'),
  voiceButton: document.querySelector('#voice-button'),
  composerContainer: document.querySelector('#composer-container'),
  botActions: document.querySelector('#bot-actions'),
  voiceBar: document.querySelector('#voice-recording-bar'),
  voiceRecState: document.querySelector('#voice-rec-state'),
  voiceRecTimer: document.querySelector('#voice-rec-timer'),
  voiceMeter: document.querySelector('#voice-meter'),
  voiceCancelBtn: document.querySelector('#voice-cancel-btn'),
  voiceCancelLabel: document.querySelector('#voice-cancel-label'),
  voiceSendBtn: document.querySelector('#voice-send-btn'),
  voiceSendLabel: document.querySelector('#voice-send-label'),
  commandPalette: document.querySelector('#command-palette'),
  commandList: document.querySelector('#command-list'),
  screensaverCanvas: document.querySelector('#screensaver-canvas'),
  authThemeBtn: document.querySelector('#auth-theme-btn'),
  settingsBtn: document.querySelector('#settings-btn'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsTitle: document.querySelector('#settings-title'),
  settingsCloseBtn: document.querySelector('#settings-close-btn'),
  settingsModeHeading: document.querySelector('#settings-mode-heading'),
  settingsSchemeHeading: document.querySelector('#settings-scheme-heading'),
  settingsFontHeading: document.querySelector('#settings-font-heading'),
  settingsRoundHeading: document.querySelector('#settings-round-heading'),
  settingsBehaviourHeading: document.querySelector('#settings-behaviour-heading'),
  settingsLangHeading: document.querySelector('#settings-lang-heading'),
  settingsAppsHeading: document.querySelector('#settings-apps-heading'),
  settingsAccountHeading: document.querySelector('#settings-account-heading'),
  settingsBtnLabel: document.querySelector('#settings-btn-label'),
  modeGroup: document.querySelector('#mode-group'),
  schemeGroup: document.querySelector('#scheme-group'),
  fontGroup: document.querySelector('#font-group'),
  wallpaperGroup: document.querySelector('#wallpaper-group'),
  settingsWallpaperHeading: document.querySelector('#settings-wallpaper-heading'),
  roundGroup: document.querySelector('#round-group'),
  settingsBorders: document.querySelector('#settings-borders'),
  settingsBordersLabel: document.querySelector('#settings-borders-label'),
  settingsDepth: document.querySelector('#settings-depth'),
  settingsDepthLabel: document.querySelector('#settings-depth-label'),
  modeBtn: document.querySelector('#mode-btn'),
  authModeBtn: document.querySelector('#auth-mode-btn'),
  soundToggleBtn: document.querySelector('#sound-toggle-btn'),
  soundToggleIcon: document.querySelector('#sound-toggle-icon'),
  soundToggleLabel: document.querySelector('#sound-toggle-label'),
  settingsSound: document.querySelector('#settings-sound'),
  settingsSoundLabel: document.querySelector('#settings-sound-label'),
  settingsSoundSend: document.querySelector('#settings-sound-send'),
  settingsSoundSendLabel: document.querySelector('#settings-sound-send-label'),
  settingsVolume: document.querySelector('#settings-volume'),
  settingsVolumeLabel: document.querySelector('#settings-volume-label'),
  settingsSoundFile: document.querySelector('#settings-sound-file'),
  settingsSoundPickBtn: document.querySelector('#settings-sound-pick-btn'),
  settingsSoundResetBtn: document.querySelector('#settings-sound-reset-btn'),
  settingsSoundCustomName: document.querySelector('#settings-sound-custom-name'),
  settingsSoundError: document.querySelector('#settings-sound-error'),
  settingsNotify: document.querySelector('#settings-notify'),
  settingsNotifyLabel: document.querySelector('#settings-notify-label'),
  settingsTyping: document.querySelector('#settings-typing'),
  settingsTypingLabel: document.querySelector('#settings-typing-label'),
  settingsHoliday: document.querySelector('#settings-holiday'),
  settingsHolidayLabel: document.querySelector('#settings-holiday-label'),
  settingsLinkPreview: document.querySelector('#settings-link-preview'),
  settingsLinkPreviewLabel: document.querySelector('#settings-link-preview-label'),
  settingsShowDeleted: document.querySelector('#settings-show-deleted'),
  settingsShowDeletedLabel: document.querySelector('#settings-show-deleted-label'),
  settingsQuickReactions: document.querySelector('#settings-quick-reactions'),
  settingsQuickReactionsLabel: document.querySelector('#settings-quick-reactions-label'),
  settingsInstallBtn: document.querySelector('#settings-install-btn'),
  settingsApkLink: document.querySelector('#settings-apk-link'),
  settingsProfileBtn: document.querySelector('#settings-profile-btn'),
  settingsE2eeSection: document.querySelector('#settings-e2ee-section'),
  settingsE2eeHeading: document.querySelector('#settings-e2ee-heading'),
  settingsBackupCreateBtn: document.querySelector('#settings-backup-create-btn'),
  settingsBackupStatusBtn: document.querySelector('#settings-backup-status-btn'),
  settingsBackupRestoreBtn: document.querySelector('#settings-backup-restore-btn'),
  settingsKeysResetBtn: document.querySelector('#settings-keys-reset-btn'),
  settingsVersion: document.querySelector('#settings-version'),
  authApkLink: document.querySelector('#auth-apk-link'),
  paneGrip: document.querySelector('#pane-grip'),
  infoGrip: document.querySelector('#info-grip'),
  talkPeerBtn: document.querySelector('#talk-peer-btn'),
  directBtn: document.querySelector('#direct-btn'),
  conversationMenuButton: document.querySelector('#conversation-menu-button'),
  toggleRosterBtn: document.querySelector('#toggle-roster-btn'),
  toggleRosterLabel: document.querySelector('#toggle-roster-label'),
  toggleInfoBtn: document.querySelector('#toggle-info-btn'),
  toggleInfoLabel: document.querySelector('#toggle-info-label'),
  infoPanel: document.querySelector('#info-panel'),
  infoTitle: document.querySelector('#info-title'),
  infoCloseBtn: document.querySelector('#info-close-btn'),
  infoName: document.querySelector('#info-name'),
  infoLogin: document.querySelector('#info-login'),
  infoPresence: document.querySelector('#info-presence'),
  infoAvatar: document.querySelector('#info-avatar'),
  infoStatsHeading: document.querySelector('#info-stats-heading'),
  infoStatMsgsLabel: document.querySelector('#info-stat-msgs-label'),
  infoStatMsgs: document.querySelector('#info-stat-msgs'),
  infoStatImagesLabel: document.querySelector('#info-stat-images-label'),
  infoStatImages: document.querySelector('#info-stat-images'),
  infoStatVoiceLabel: document.querySelector('#info-stat-voice-label'),
  infoStatVoice: document.querySelector('#info-stat-voice'),
  infoStatUnreadLabel: document.querySelector('#info-stat-unread-label'),
  infoStatUnread: document.querySelector('#info-stat-unread'),
  infoActionsHeading: document.querySelector('#info-actions-heading'),
  infoSafety: document.querySelector('#info-safety'),
  infoSafetyHeading: document.querySelector('#info-safety-heading'),
  infoSafetyCode: document.querySelector('#info-safety-code'),
  infoSafetyStatus: document.querySelector('#info-safety-status'),
  infoSafetyConfirm: document.querySelector('#info-safety-confirm'),
  infoSafetyTrust: document.querySelector('#info-safety-trust'),
  infoWakeBtn: document.querySelector('#info-wake-btn'),
  infoExportBtn: document.querySelector('#info-export-btn'),
  infoClearBtn: document.querySelector('#info-clear-btn'),
  infoSessionHeading: document.querySelector('#info-session-heading'),
  infoServerLabel: document.querySelector('#info-server-label'),
  infoServer: document.querySelector('#info-server'),
  infoRoute: document.querySelector('#info-route'),
  infoRouteLabel: document.querySelector('#info-route-label'),
  infoClient: document.querySelector('#info-client'),
  infoClientLabel: document.querySelector('#info-client-label'),
  infoTransportLabel: document.querySelector('#info-transport-label'),
  infoTransport: document.querySelector('#info-transport'),
  infoLatencyLabel: document.querySelector('#info-latency-label'),
  infoLatency: document.querySelector('#info-latency'),
  infoPingBtn: document.querySelector('#info-ping-btn'),
  updateAvailableBtn: document.querySelector('#update-available-btn'),
  updateAvailableLabel: document.querySelector('#update-available-label'),
  authPwaInstallBtn: document.querySelector('#auth-pwa-install-btn'),
  pwaIosDialog: document.querySelector('#pwa-ios-dialog'),
  pwaIosTitle: document.querySelector('#pwa-ios-title'),
  pwaIosDesc: document.querySelector('#pwa-ios-desc'),
  pwaIosCloseBtn: document.querySelector('#pwa-ios-close-btn'),
  pwaIosAckBtn: document.querySelector('#pwa-ios-ack-btn'),
  inviteDialog: document.querySelector('#invite-dialog'),
  modalTitle: document.querySelector('#modal-title'),
  inviteCloseButton: document.querySelector('#invite-close-button'),
  myInviteTitle: document.querySelector('#my-invite-title'),
  myInviteHint: document.querySelector('#my-invite-hint'),
  myInviteInput: document.querySelector('#my-invite-input'),
  generateInviteButton: document.querySelector('#generate-invite-button'),
  copyInviteButton: document.querySelector('#copy-invite-button'),
  myInviteStatus: document.querySelector('#my-invite-status'),
  acceptInviteTitle: document.querySelector('#accept-invite-title'),
  acceptInviteHint: document.querySelector('#accept-invite-hint'),
  acceptInviteForm: document.querySelector('#accept-invite-form'),
  acceptInviteInput: document.querySelector('#accept-invite-input'),
  acceptInviteButton: document.querySelector('#accept-invite-button'),
  acceptInviteStatus: document.querySelector('#accept-invite-status'),
  friendRequestTitle: document.querySelector('#friend-request-title'),
  friendRequestHint: document.querySelector('#friend-request-hint'),
  friendRequestForm: document.querySelector('#friend-request-form'),
  friendRequestInput: document.querySelector('#friend-request-input'),
  friendRequestButton: document.querySelector('#friend-request-button'),
  friendRequestStatus: document.querySelector('#friend-request-status'),
  logoBand: document.querySelector('#logo-band'),
  logoArt: document.querySelector('#logo-art'),
  scrollBottomBtn: document.querySelector('#scroll-bottom-btn'),
  scrollBadge: document.querySelector('#scroll-badge'),
  profileEyebrow: document.querySelector('#profile-eyebrow'),
  pwaIosSteps: document.querySelector('#pwa-ios-steps'),
  composerLabel: document.querySelector('#composer-label'),
  profileOpenButton: document.querySelector('#profile-open-button'),
  profileDialog: document.querySelector('#profile-dialog'),
  profileForm: document.querySelector('#profile-form'),
  profileTitle: document.querySelector('#profile-title'),
  profileCloseButton: document.querySelector('#profile-close-button'),
  profileLogin: document.querySelector('#profile-login'),
  profileLoginLabel: document.querySelector('#profile-login-label'),
  profileLoginHint: document.querySelector('#profile-login-hint'),
  profileName: document.querySelector('#profile-name'),
  profileNameLabel: document.querySelector('#profile-name-label'),
  profilePasswordTitle: document.querySelector('#profile-password-title'),
  profilePasswordHint: document.querySelector('#profile-password-hint'),
  profileCurrentPassword: document.querySelector('#profile-current-password'),
  profileCurrentPasswordLabel: document.querySelector('#profile-current-password-label'),
  profileNewPassword: document.querySelector('#profile-new-password'),
  profileNewPasswordLabel: document.querySelector('#profile-new-password-label'),
  profileConfirmPassword: document.querySelector('#profile-confirm-password'),
  profileConfirmPasswordLabel: document.querySelector('#profile-confirm-password-label'),
  profileCancelButton: document.querySelector('#profile-cancel-button'),
  profileSaveButton: document.querySelector('#profile-save-button'),
  profileStatus: document.querySelector('#profile-status'),
  profileExtraPasswordTitle: document.querySelector('#profile-extra-password-title'),
  profileExtraPasswordHint: document.querySelector('#profile-extra-password-hint'),
  profileExtraPasswordEnabled: document.querySelector('#profile-extra-password-enabled'),
  profileExtraPasswordEnabledLabel: document.querySelector('#profile-extra-password-enabled-label'),
  profileExtraPasswordRow: document.querySelector('#profile-extra-password-row'),
  profileExtraPassword: document.querySelector('#profile-extra-password'),
  profileExtraPasswordLabel: document.querySelector('#profile-extra-password-label'),
  profileExtraPasswordConfirmRow: document.querySelector('#profile-extra-password-confirm-row'),
  profileExtraPasswordConfirm: document.querySelector('#profile-extra-password-confirm'),
  profileExtraPasswordConfirmLabel: document.querySelector('#profile-extra-password-confirm-label'),
  profileExtraPasswordNote: document.querySelector('#profile-extra-password-note'),
  attachButton: document.querySelector('#attach-button'),
  emojiButton: document.querySelector('#emoji-toggle'),
  fileInput: document.querySelector('#file-input'),
  lightbox: document.querySelector('#lightbox'),
  lightboxStage: document.querySelector('#lightbox-stage'),
  lightboxImage: document.querySelector('#lightbox-image'),
  lightboxCounter: document.querySelector('#lightbox-counter'),
  lightboxSave: document.querySelector('#lightbox-save'),
  lightboxClose: document.querySelector('#lightbox-close'),
  imageSheet: document.querySelector('#image-sheet'),
  imageSheetStage: document.querySelector('#image-sheet-stage'),
  imageSheetFrame: document.querySelector('#image-sheet-frame'),
  imageSheetCanvas: document.querySelector('#image-sheet-canvas'),
  imageSheetCrop: document.querySelector('#image-sheet-crop'),
  imageSheetRatios: document.querySelector('#image-sheet-ratios'),
  imageSheetFree: document.querySelector('#image-sheet-free'),
  imageSheetReset: document.querySelector('#image-sheet-reset'),
  imageSheetCancel: document.querySelector('#image-sheet-cancel'),
  imageSheetCropToggle: document.querySelector('#image-sheet-crop-toggle'),
  imageSheetRotate: document.querySelector('#image-sheet-rotate'),
  imageSheetCaption: document.querySelector('#image-sheet-caption'),
  imageSheetSend: document.querySelector('#image-sheet-send'),
  composerContextBar: document.querySelector('#composer-context'),
  composerContextIcon: document.querySelector('#composer-context-icon'),
  composerContextLabel: document.querySelector('#composer-context-label'),
  composerContextSnippet: document.querySelector('#composer-context-snippet'),
  composerContextCancel: document.querySelector('#composer-context-cancel'),
};

let timeFormat = new Intl.DateTimeFormat(localeFor(currentLang), { hour: '2-digit', minute: '2-digit' });
let dayFormat = new Intl.DateTimeFormat(localeFor(currentLang), { day: 'numeric', month: 'long' });
// The roster's own two, for the days that are not today and not yesterday:
// a weekday inside the last week, then a short date (`28 февр.`) with the
// year appended only when it is not this one. Both shorter than [dayFormat],
// which the transcript's day dividers spend a whole line on.
let weekdayFormat = new Intl.DateTimeFormat(localeFor(currentLang), { weekday: 'short' });
let dayShortFormat = new Intl.DateTimeFormat(localeFor(currentLang), { day: 'numeric', month: 'short' });
const wide = window.matchMedia(WIDE_QUERY);

function localeFor(lang) {
  if (lang === 'en') return 'en-US';
  if (lang === 'fr') return 'fr-FR';
  return 'ru-RU';
}

let mode = 'login';
let authBusy = false;
// Set once `/login` answers `extra_password_required` for the credentials
// currently in the form: the login field grows a third input and resubmits
// with it, same shape as the CLI's prompt.js flow.
let needExtraPassword = false;
let token = readToken();
let self = null;
let swRegistration = null;
let users = [];
let activePeer = null;
let selectionSeq = 0;

// What each peer's last hello said it was running: a version string for a
// terminal, `web` for another browser tab, null for a peer that has not
// greeted us yet. Read by the route panel to name the far end of the link.
const peerClients = new Map();
const botActionsByPeer = new Map();

let socket = null;
let authed = false;
let subscribedPeer = null;
// `sendFrame` refuses to relay to a peer we are not yet subscribed to (see
// its comment), and `subscribeActivePeer` only fires the request — the ack
// (`{k:'subscribed'}`) lands on a later websocket message. Anything that
// needs to send to a peer right after switching to it (forwarding a
// message to someone who isn't the open conversation) has to wait for that
// ack instead of racing it, or the send silently no-ops.
const subscriptionWaiters = new Map(); // peer -> Set<resolve>
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
// First load says «Подключение…»; losing a connection that was already up
// says «Переподключение…» instead — the same offline state, a more honest
// label about what is actually happening.
let everConnected = false;
// A socket can go half-open — the phone sleeps, a proxy drops the tunnel — and
// the browser is never told: `readyState` stays OPEN, no `close` event ever
// fires, and the app sits there believing it is connected while nothing
// arrives. That is «приходится перезапускать клиент, чтобы увидеть новые
// сообщения». The server's own ws-level ping cannot save us here, because a
// browser answers it inside the network stack without waking any JavaScript,
// so the tab has no evidence either way. These two track the last byte the
// server actually delivered, which is the only evidence there is.
let lastServerMessageAt = 0;
let heartbeatTimer = null;

let typingSentAt = 0;
let typingIdleTimer = null;
let typingExpireTimer = null;

let paletteMatches = [];
let paletteIndex = 0;

let pendingPing = null;
let lastLatencyMs = 0;

const threads = new Map();
// A voice card never puts a queryable `<audio src="data:...">` element in
// the DOM — `buildVoicePlayer` drives playback off an in-memory `Audio`
// object instead, appended nowhere — so `forwardMessage` cannot recover a
// voice note's bytes by scraping the row the way it can an image's
// `<img src>`. id -> { image: {dataUrl|mediaRef,width,height} | null, voice:
// {dataUrl|mediaRef,duration} | null }, set by every render path that has the
// payload or its server reference (`appendMessage`, `appendVoiceMessage`),
// read by `forwardMessage` through `attachmentDataUrl`.
const messageAttachments = new Map();
const incomingTransfers = new Map();
const attachmentUrls = new Set();
let incomingBufferedBytes = 0;
let outgoingTransfers = Promise.resolve();


// --- Web Audio Retro Synthesizer -----------------------------------------

let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// One synthesised note: a single sine through a soft attack/decay envelope.
// The previous design ran two detuned oscillators through a sweeping lowpass
// filter for "body" — in practice that beating plus the filter sweep read as
// a synthetic wobble, not a chime, and «звуки все еще неудачные» (still bad)
// confirms it. A messaging pop is just one clean tone, quiet, gone fast: no
// chorus, no filter, nothing left to sound harsh.
// [INFERENCE] Tuned by ear-less reasoning about the synthesis parameters, not
// by listening — this environment cannot play or capture audio. If it still
// sounds wrong, say what's off (harsh? too loud? too long? wrong pitch?) —
// that narrows the next change far more than another blind pass at the numbers.
function playNote({ freq, at, duration, peak, wave = 'sine' }) {
  const start = audioCtx.currentTime + at;
  const stop = start + duration;

  const gain = audioCtx.createGain();
  const scaledPeak = peak * soundVolume;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(scaledPeak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, stop);
  gain.connect(audioCtx.destination);

  const osc = audioCtx.createOscillator();
  osc.type = wave;
  osc.frequency.setValueAtTime(freq, start);
  osc.connect(gain);
  osc.start(start);
  osc.stop(stop);
}

// Peaks roughly halved from the previous pass, per the explicit "ниже звук"
// (lower the sound) ask. `received` is two notes in a consonant, gentle rise
// (a fourth, not a wide fifth); `wake` stays the one deliberately noticeable
// cue — it exists to be heard across a room — but is quieter than before too.
const SOUND_CUES = {
  sent: [
    { freq: 660, at: 0, duration: 0.05, peak: 0.012 },
  ],
  received: [
    { freq: 523.25, at: 0, duration: 0.13, peak: 0.022 },
    { freq: 698.46, at: 0.09, duration: 0.16, peak: 0.02 },
  ],
  wake: [
    { freq: 523.25, at: 0, duration: 0.16, peak: 0.028 },
    { freq: 659.25, at: 0.09, duration: 0.16, peak: 0.028 },
    { freq: 783.99, at: 0.18, duration: 0.18, peak: 0.026 },
    { freq: 1046.5, at: 0.27, duration: 0.32, peak: 0.024 },
  ],
};

// Real recordings instead of synthesised beeps: three cues from Mixkit's
// free sound library (web/cloud/sounds/CREDITS.txt) — a soft bubble-pop for
// incoming, a typewriter tick for outgoing, a marimba phrase for wake —
// chosen by ear and loudness-matched to the mix below. The oscillator cues
// above stay as the fallback for the moment a sample has not loaded yet, or
// cannot be decoded at all — a missing file must never mean a silent
// messenger.
const SOUND_FILES = {
  sent: `sounds/sent.mp3?v=${APP_VERSION}`,
  received: `sounds/received.mp3?v=${APP_VERSION}`,
  wake: `sounds/wake.mp3?v=${APP_VERSION}`,
};

// Playback multipliers for the sample files, chosen so the mix keeps its
// character whatever the source mastered: a send is barely there, a wake is
// the one meant to carry across a room. `sent` looks high next to the others
// only because the typewriter tick is a sharp transient — loud peak, quiet
// average — so it needs the headroom to be heard at all; the received pop and
// the marimba phrase carry their level in their body, not their attack.
const SAMPLE_GAIN = { sent: 0.9, received: 0.6, wake: 0.9 };

// --- Свой звук уведомления (IndexedDB) -----------------------------------

// A picked audio file is a blob of up to two megabytes, which localStorage
// cannot hold (strings only, ~5 MB quota shared with everything else), so it
// goes into IndexedDB — the only client-side store that takes binary as-is.
// One database, one store, one record per cue, keyed by cue name.
const SOUND_DB_NAME = 'tailchat-cloud';
const SOUND_DB_VERSION = 1;
const SOUND_STORE = 'sounds';
// Only the incoming cue is customisable: it is the notification, the one the
// request is about — a personal "send" tick heard dozens of times an hour is
// noise, not personalisation.
const CUSTOM_SOUND_CUE = 'received';
// Two megabytes is already a ~2-minute mp3; anything larger is a music track
// somebody dropped in by mistake, and it would sit in the browser's quota for
// a cue that plays for a second.
const CUSTOM_SOUND_MAX_BYTES = 2 * 1024 * 1024;
// A file that fires neither `canplay` nor `error` (a container the browser
// half-recognises) must not leave the import hanging with no feedback.
const CUSTOM_SOUND_PROBE_MS = 5000;
const SOUND_DB_OPEN_MS = 1500;

let soundDb = null;
let customSoundUrl = '';
// Read from localStorage, not from the store: the label has to be right on
// the first paint, and loadCustomSound() corrects it if the blob turns out to
// be gone.
let customSoundName = readStoredCustomSoundName();
let customSoundErrorKey = '';

function openSoundDb() {
  if (soundDb) return soundDb;
  soundDb = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let settled = false;
    let timer = 0;
    const req = window.indexedDB.open(SOUND_DB_NAME, SOUND_DB_VERSION);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    timer = setTimeout(() => fail(new Error('IndexedDB open timed out')), SOUND_DB_OPEN_MS);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SOUND_STORE)) req.result.createObjectStore(SOUND_STORE);
    };
    req.onsuccess = () => {
      if (settled) {
        req.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      req.result.onversionchange = () => {
        req.result.close();
        soundDb = null;
      };
      resolve(req.result);
    };
    req.onerror = () => fail(req.error || new Error('IndexedDB open failed'));
    // Another tab holding an older version open: treat as unavailable rather
    // than waiting for it to close.
    req.onblocked = () => fail(new Error('IndexedDB blocked'));
  });
  // A private-browsing profile refuses to open at all. Forget the rejection
  // so a later attempt (a different window, permission granted) can retry
  // instead of inheriting a permanently failed promise.
  soundDb.catch(() => { soundDb = null; });
  return soundDb;
}

function soundStoreOp(mode, run) {
  return openSoundDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(SOUND_STORE, mode);
    const req = run(tx.objectStore(SOUND_STORE));
    let result;
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  }));
}

function idbGet(key) {
  return soundStoreOp('readonly', (store) => store.get(key));
}

function idbPut(key, value) {
  return soundStoreOp('readwrite', (store) => store.put(value, key));
}

function idbDelete(key) {
  return soundStoreOp('readwrite', (store) => store.delete(key));
}

const soundSamples = new Map();

function usingCustomSound(type) {
  return type === CUSTOM_SOUND_CUE && Boolean(customSoundUrl);
}

function sampleFor(type) {
  // The object URL of the imported blob wins over the shipped recording; both
  // memoise under the same key, and dropCustomSoundSample() clears it so a
  // freshly picked file is heard on the very next cue.
  const src = usingCustomSound(type) ? customSoundUrl : SOUND_FILES[type];
  if (!src) return null;
  let audio = soundSamples.get(type);
  if (!audio) {
    audio = new Audio(src);
    audio.preload = 'auto';
    soundSamples.set(type, audio);
  }
  return audio;
}

// Every cue is short and can overlap itself (two messages landing together),
// so each play gets its own element cloned off the preloaded one instead of
// restarting a single shared player.
function playSample(type) {
  const base = sampleFor(type);
  if (!base) return false;
  // A file the person picked has unknown mastering, so the per-cue trim that
  // balances our own three recordings would only make it arbitrarily quiet:
  // their volume slider is the entire gain chain for it.
  const gain = usingCustomSound(type) ? soundVolume : (SAMPLE_GAIN[type] ?? 0.6) * soundVolume;
  if (gain <= 0) return true;
  const node = base.cloneNode(true);
  node.volume = Math.min(1, gain);
  try {
    const played = node.play();
    if (played && typeof played.catch === 'function') {
      // Autoplay refused, or the file is missing: fall back to the tone so the
      // event is still audible.
      played.catch(() => playCue(type));
    }
  } catch {
    playCue(type);
  }
  return true;
}

function playCue(type) {
  const cue = SOUND_CUES[type];
  if (!cue) return;
  try {
    initAudio();
    if (!audioCtx) return;
    for (const note of cue) playNote(note);
  } catch {}
}

function playSound(type, { peer = activePeer } = {}) {
  if (!soundEnabled) return;
  if (type === 'sent' && !sendSoundEnabled) return;
  if (self && peer === self.login) return;
  // Not just an optimisation: a scaled peak of exactly 0 would make playNote's
  // exponentialRampToValueAtTime ramp from 0, which the Web Audio API throws
  // on (it cannot approach any target exponentially from a starting value of
  // zero).
  if (soundVolume <= 0) return;
  // Sample first, tone only if there is no sample for this cue at all.
  if (playSample(type)) return;
  playCue(type);
}

// The received cue is a *notification*, gated the same way an OS notification
// is. When the person is looking at the very conversation the message landed
// in, the bubble itself is the cue — playing a sound on top of every new line
// is how opening a chat with a waiting backlog rattled through the whole
// stack, «когда прочитываю новых много сообщений — не повторять на каждый
// звук». And while away, a burst is one pop per peer per window: twenty
// queued messages read as «something arrived», not a hail of twenty dings.
const RECEIVED_SOUND_GAP_MS = 3000;
const lastReceivedSoundAt = new Map();
function notifyReceivedSound(peer, { force = false } = {}) {
  if (mutedContacts.has(peer)) return;
  if (!soundEnabled) return;
  if (self && (peer === self.login || peer === self.name)) return;
  const foregroundView = !document.hidden
    && (typeof document.hasFocus === 'function' ? document.hasFocus() : true)
    && peer === activePeer;
  if (foregroundView && !force) return;
  const at = Date.now();
  if (at - (lastReceivedSoundAt.get(peer) ?? 0) < RECEIVED_SOUND_GAP_MS) return;
  lastReceivedSoundAt.set(peer, at);
  playSound('received', { peer });
}

function setPeerMuted(peer, muted) {
  if (!peer) return;
  if (muted) mutedContacts.add(peer);
  else mutedContacts.delete(peer);
  try { localStorage.setItem(MUTED_CONTACTS_KEY, JSON.stringify([...mutedContacts])); } catch {}
}

function setSoundState(enabled) {
  soundEnabled = Boolean(enabled);
  try {
    localStorage.setItem(SOUND_KEY, String(soundEnabled));
  } catch {}
  if (elements.settingsSound) elements.settingsSound.checked = soundEnabled;
  if (elements.settingsSoundSend) elements.settingsSoundSend.checked = sendSoundEnabled;
  updateSoundToggle();
}

function updateSoundToggle() {
  if (!elements.soundToggleBtn) return;
  elements.soundToggleBtn.setAttribute('aria-pressed', String(soundEnabled));
  elements.soundToggleBtn.title = t(soundEnabled ? 'soundDisable' : 'soundEnable');
  elements.soundToggleBtn.setAttribute('aria-label', elements.soundToggleBtn.title);
  if (elements.soundToggleIcon) {
    elements.soundToggleIcon.setAttribute('href', soundEnabled ? '#icon-volume-2' : '#icon-volume-x');
  }
  if (elements.soundToggleLabel) {
    elements.soundToggleLabel.textContent = t(soundEnabled ? 'soundOnShort' : 'soundOffShort');
  }
}

function setSoundVolume(value) {
  soundVolume = Math.min(1, Math.max(0, Number(value) || 0));
  try {
    localStorage.setItem(VOLUME_KEY, String(soundVolume));
  } catch {}
  if (elements.settingsVolume) elements.settingsVolume.value = String(Math.round(soundVolume * 100));
}

function readStoredCustomSoundName() {
  try {
    return localStorage.getItem(SOUND_FILE_KEY) || '';
  } catch {
    return '';
  }
}

// The memoised <audio> still points at the previous object URL, so it has to
// go or the next message plays the file that was just replaced.
function dropCustomSoundSample() {
  soundSamples.delete(CUSTOM_SOUND_CUE);
}

function setCustomSoundError(key) {
  customSoundErrorKey = key;
  syncCustomSoundRow();
}

// Single place where the row reflects state *and* language: both the settings
// dialog and the language pass call it, so neither has to know the other's
// half of the row.
function syncCustomSoundRow() {
  if (elements.settingsSoundPickBtn) elements.settingsSoundPickBtn.textContent = t('settingsSoundPick');
  if (elements.settingsSoundResetBtn) {
    elements.settingsSoundResetBtn.textContent = t('settingsSoundReset');
    // Nothing to revert to while the built-in recording is what plays.
    elements.settingsSoundResetBtn.hidden = !(customSoundUrl || customSoundName);
  }
  if (elements.settingsSoundCustomName) {
    elements.settingsSoundCustomName.textContent = customSoundName || t('settingsSoundDefault');
  }
  if (elements.settingsSoundError) {
    elements.settingsSoundError.textContent = customSoundErrorKey ? t(customSoundErrorKey) : '';
    elements.settingsSoundError.hidden = !customSoundErrorKey;
  }
}

function releaseCustomSoundUrl() {
  if (!customSoundUrl) return;
  URL.revokeObjectURL(customSoundUrl);
  customSoundUrl = '';
}

function applyCustomSound(blob, name) {
  // The old URL is revoked here rather than handed to rememberAttachmentUrl():
  // that set is released wholesale on logout (releaseAttachmentUrls), which
  // would leave a live custom cue pointing at a dead URL in the same tab.
  releaseCustomSoundUrl();
  customSoundUrl = blob ? URL.createObjectURL(blob) : '';
  customSoundName = blob ? String(name || '') : '';
  dropCustomSoundSample();
  syncCustomSoundRow();
}

// Called before boot() so the blob is in hand well before the first frame can
// arrive (that needs a session request, a roster fetch and a socket); if the
// store is unreachable the cue simply stays the built-in one.
async function loadCustomSound() {
  const storedName = readStoredCustomSoundName();
  try {
    const record = await idbGet(CUSTOM_SOUND_CUE);
    if (record && record.blob) {
      applyCustomSound(record.blob, record.name || storedName);
      return;
    }
  } catch (err) {
    console.warn('[Tailchat] Custom sound store unavailable:', err);
  }
  // No blob, or no database at all: a remembered name would promise a sound
  // that cannot play, so the row goes back to the built-in label.
  if (storedName) {
    try {
      localStorage.removeItem(SOUND_FILE_KEY);
    } catch {}
  }
  applyCustomSound(null, '');
}

// `accept="audio/*"` is a filter in the picker, not a guarantee — a renamed
// file, a drag-and-drop, or a codec this browser lacks all reach here.
function canDecodeAudio(url) {
  return new Promise((resolve) => {
    const probe = new Audio();
    let timer = 0;
    const settle = (ok) => {
      clearTimeout(timer);
      probe.oncanplay = null;
      probe.onerror = null;
      try {
        probe.removeAttribute('src');
        probe.load();
      } catch {}
      resolve(ok);
    };
    probe.preload = 'auto';
    probe.oncanplay = () => settle(true);
    probe.onerror = () => settle(false);
    timer = setTimeout(() => settle(false), CUSTOM_SOUND_PROBE_MS);
    probe.src = url;
    probe.load();
  });
}

async function importCustomSound(file) {
  if (!file) return;
  setCustomSoundError('');
  if (!String(file.type || '').toLowerCase().startsWith('audio/')) {
    setCustomSoundError('settingsSoundNotAudio');
    return;
  }
  if (file.size > CUSTOM_SOUND_MAX_BYTES) {
    setCustomSoundError('settingsSoundTooBig');
    return;
  }
  // Decode *before* persisting: an unplayable file stored as the cue would
  // mean every incoming message quietly falls back to the synthesised tone,
  // with a settings row claiming the import worked.
  let probeUrl = '';
  let playable = false;
  try {
    probeUrl = URL.createObjectURL(file);
    playable = await canDecodeAudio(probeUrl);
  } catch {
    playable = false;
  } finally {
    if (probeUrl) URL.revokeObjectURL(probeUrl);
  }
  if (!playable) {
    setCustomSoundError('settingsSoundUndecodable');
    return;
  }
  try {
    await idbPut(CUSTOM_SOUND_CUE, { blob: file, name: file.name, ts: Date.now() });
    try {
      localStorage.setItem(SOUND_FILE_KEY, file.name);
    } catch {}
  } catch (err) {
    // Storage refused the write (private browsing, quota): the cue still
    // works for this session, it just will not survive a reload.
    console.warn('[Tailchat] Custom sound not persisted:', err);
  }
  applyCustomSound(file, file.name);
  // Picking a file is the one moment the person is listening for it, so the
  // preview plays even with the sound switch off — silence here reads as a
  // failed import.
  playSample(CUSTOM_SOUND_CUE);
}

async function resetCustomSound() {
  setCustomSoundError('');
  try {
    await idbDelete(CUSTOM_SOUND_CUE);
  } catch (err) {
    console.warn('[Tailchat] Custom sound not removed:', err);
  }
  try {
    localStorage.removeItem(SOUND_FILE_KEY);
  } catch {}
  applyCustomSound(null, '');
}

// --- Системные уведомления (Web Notifications API) -----------------------

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const res = await Notification.requestPermission();
    updateNotifyBtn();
    return res === 'granted';
  } catch {
    return false;
  }
}

async function setNotifyState(enabled, requestIfDefault = false) {
  if (enabled && 'Notification' in window) {
    if (Notification.permission === 'default' && requestIfDefault) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        notifyEnabled = false;
        try { localStorage.setItem(NOTIFY_KEY, 'false'); } catch {}
        updateNotifyBtn();
        return;
      }
    }
  }
  notifyEnabled = Boolean(enabled);
  try {
    localStorage.setItem(NOTIFY_KEY, String(notifyEnabled));
  } catch {}
  updateNotifyBtn();
  if (notifyEnabled && Notification.permission === 'granted') {
    void subscribeWebPush();
  } else if (!notifyEnabled) {
    void unsubscribeWebPush();
  }
}

// The rail button this used to paint is gone: notifications are a setting,
// and the setting is the checkbox in the settings dialog.
function updateNotifyBtn() {
  if (!elements.settingsNotify) return;
  const blocked = !('Notification' in window) || Notification.permission === 'denied';
  // `default` is not "on": nothing can be shown until the browser is asked, and
  // the ask only happens from the checkbox's own change handler. Painting the
  // row as ON there is what made missing notifications look like a bug in the
  // app rather than a prompt that was never raised — the row has to invite the
  // person to allow them, unchecked.
  const needsPermission = !blocked && Notification.permission === 'default';
  elements.settingsNotify.disabled = blocked;
  elements.settingsNotify.checked = notifyEnabled && !blocked && !needsPermission;
  const label = elements.settingsNotifyLabel;
  if (label) {
    label.textContent = blocked
      ? t('notifyBlocked')
      : (needsPermission ? t('notifyAllow') : t('settingsNotify'));
  }
}

async function showWebNotification({ title, body, icon, tag, peer, messageId = null }) {
  if (peer && mutedContacts.has(peer)) return;
  if (!notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  // Не показываем уведомление, если пользователь прямо сейчас смотрит на эту вкладку и этот диалог
  const isForeground = !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : true);
  if (isForeground && peer && peer === activePeer) {
    return;
  }

  const notifTitle = title || 'Tailchat';
  const notifOptions = {
    body: body || '',
    icon: icon || (APP_VERSION ? `/tailchat/icons/icon-192.png?v=${APP_VERSION}` : '/tailchat/icons/icon-192.png'),
    badge: '/tailchat/icons/badge-96.png',
    tag: tag || (peer ? `tailchat-${peer}` : 'tailchat-msg'),
    renotify: true,
    vibrate: [150, 80, 150],
    data: { peer, messageId, url: '/tailchat/' },
  };

  if ('serviceWorker' in navigator) {
    try {
      // `navigator.serviceWorker.ready` never settles while there is no active
      // worker for this scope, and a promise that never settles is not an
      // exception: both the notification and the `new Notification` fallback
      // below used to wait on it forever, which is the one fully silent way an
      // alert disappears (no console line, no server trace). A short race hands
      // the job to the fallback instead.
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => { setTimeout(() => resolve(null), 1500); }),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(notifTitle, notifOptions);
        return;
      }
    } catch (err) {
      console.warn('[Notifications] ServiceWorker showNotification failed:', err);
    }
  }

  try {
    const n = new Notification(notifTitle, notifOptions);
    n.onclick = () => {
      window.focus?.();
      if (peer) selectPeer(peer);
      n.close();
    };
  } catch (err) {
    console.warn('[Notifications] Desktop Notification fallback failed:', err);
  }
}

// --- Web Push (уведомления при закрытом приложении) ----------------------

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// The server treats a push subscription as this device's *lease*: it has to
// carry an id the browser keeps across reloads, or a re-subscribe (endpoint
// rotation, reinstalled PWA) leaves the previous endpoint in place and one
// message starts notifying twice from what the person believes is one app.
function pushDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // No storage, no stable identity: a subscription that cannot be renewed
    // or replaced is exactly the kind that haunts a phone forever, so none is
    // registered at all.
    return null;
  }
}

// What the *service worker* needs to repair a rotated endpoint with nobody
// looking at the app lives in IndexedDB, the one storage a worker can read: the
// login and device id the subscription belongs to (not secrets — the server
// asks for them by name) and the repair key `/api/push/subscribe` returned for
// this device. That key can do exactly one thing — replace this device's own
// subscription — which is why it is the one credential a worker is trusted with.
// The session token, which opens the whole account, is deliberately not stored
// anywhere a worker could reach it.
const PUSH_REPAIR_DB = 'tailchat-push-repair';
const PUSH_REPAIR_STORE = 'repair';
const PUSH_REPAIR_ID = 'current';

function pushRepairDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(PUSH_REPAIR_DB, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(PUSH_REPAIR_STORE)) db.createObjectStore(PUSH_REPAIR_STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function pushRepairWrite(mode, run) {
  return pushRepairDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(PUSH_REPAIR_STORE, mode);
    run(tx.objectStore(PUSH_REPAIR_STORE));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

// A repair key that could not be stored costs one endpoint rotation (the worker
// then has nothing to send and falls back to telling open clients), which is not
// worth failing a subscription over.
async function writePushRepair(record) {
  try {
    await pushRepairWrite('readwrite', (store) => store.put(record, PUSH_REPAIR_ID));
  } catch (err) {
    console.warn('[Push] repair record not stored:', err);
  }
}

async function clearPushRepair() {
  try {
    await pushRepairWrite('readwrite', (store) => store.delete(PUSH_REPAIR_ID));
  } catch {}
}

// A live socket only reaches a page that is running; a phone with the app
// swiped away has none. Web Push is the one channel that still gets there,
// delivered by the OS through the browser's own push service — this just
// wires the subscription up and hands it to the server that will use it.
async function subscribeWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  const deviceId = pushDeviceId();
  if (!deviceId) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await request('GET', '/push/key');
      if (!key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    const answer = await request('POST', '/push/subscribe', { subscription: sub.toJSON(), deviceId });
    // The key the worker will use if the push service rotates this endpoint
    // while the app is closed; the server rotates it on every use.
    if (answer?.repairKey && self?.login) {
      await writePushRepair({ login: self.login, deviceId, repairKey: answer.repairKey });
    }
  } catch (err) {
    console.warn('[Push] subscribe failed:', err);
  }
}

async function unsubscribeWebPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await request('POST', '/push/unsubscribe', { endpoint }).catch(() => {});
    // The key belonged to the subscription that is gone; left behind, it would
    // let a later rotation re-register a device that just asked not to be woken.
    await clearPushRepair();
  } catch (err) {
    console.warn('[Push] unsubscribe failed:', err);
  }
}

function updateAppUnreadBadge() {
  let count = 0;
  for (const th of threads.values()) {
    count += (th.unread || 0) + (th.reactionEvents?.size || 0);
  }
  if (count > 0) {
    document.title = `(${count}) ${activePeer ? `${displayName(activePeer)} — ` : ''}Tailchat`;
    navigator.setAppBadge?.(count).catch(() => {});
  } else {
    document.title = activePeer ? `${displayName(activePeer)} — Tailchat` : 'Tailchat';
    navigator.clearAppBadge?.().catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    updateAppUnreadBadge();
  }
});
window.addEventListener('focus', () => {
  updateAppUnreadBadge();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SELECT_PEER' && event.data.peer) {
      void selectPeer(event.data.peer).then(() => {
        const id = event.data.messageId;
        if (!id) return;
        threads.get(event.data.peer)?.node
          .querySelector(`[data-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    } else if (event.data?.type === 'PUSH_RESUBSCRIBE_NEEDED') {
      void subscribeWebPush();
    } else if (event.data?.type === 'QUERY_ACTIVE_PEER') {
      const isForeground = !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : true);
      event.ports[0]?.postMessage({ activePeer: isForeground ? activePeer : null });
    }
  });
}

// --- Тема: режим (светлая/тёмная) и цветовая схема -----------------------
//
// Two independent axes. `data-mode` decides whether the page is light or
// dark and is the one a person changes several times a day; `data-theme`
// decides which accent palette that background carries. `auto` is resolved
// here rather than in CSS so every rule has a single concrete mode to match
// against — otherwise each light block would have to be written twice, once
// for `[data-mode="light"]` and once inside a `prefers-color-scheme` query.

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedMode() {
  if (currentMode === 'light' || currentMode === 'dark') return currentMode;
  return darkQuery.matches ? 'dark' : 'light';
}

function applyMode() {
  const resolved = resolvedMode();
  document.documentElement.dataset.mode = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      'content',
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#090c10',
    );
  }
  const label = t(`mode${currentMode.charAt(0).toUpperCase()}${currentMode.slice(1)}`);
  document.querySelectorAll('.mode-name').forEach((el) => { el.textContent = label; });
  // The glyph names the CHOICE (auto/light/dark), not the resolved light/dark
  // background — `currentMode`, not `resolved`, the same distinction the
  // label above already draws. `#mode-btn` and `#auth-mode-btn` both carry
  // one `<use>` each; a stored preference from before this existed left
  // both hard-coded on the sun, so the mode never actually looked different.
  const iconId = currentMode === 'light' ? '#icon-sun' : currentMode === 'dark' ? '#icon-moon' : '#icon-auto';
  for (const btn of [elements.modeBtn, elements.authModeBtn]) {
    const use = btn?.querySelector('use');
    if (!use) continue;
    use.setAttribute('href', iconId);
    use.setAttribute('xlink:href', iconId);
  }
  if (elements.modeGroup) {
    elements.modeGroup.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });
  }
}

// Named `setColorMode`, not `setMode`: `setMode` already belongs to the auth
// screen's login/register/recover switch.
function setColorMode(nextMode, { note = false } = {}) {
  if (!MODES.includes(nextMode)) return;
  currentMode = nextMode;
  try {
    localStorage.setItem(MODE_KEY, nextMode);
  } catch {}
  applyMode();
  if (note && activePeer) {
    const thread = threads.get(activePeer);
    if (thread) systemNote(thread, t('modeSet', t(`mode${nextMode.charAt(0).toUpperCase()}${nextMode.slice(1)}`)));
  }
}

function cycleColorMode() {
  setColorMode(MODES[(MODES.indexOf(currentMode) + 1) % MODES.length], { note: true });
}

function setTheme(theme, { persist = false } = {}) {
  if (!THEMES.includes(theme)) theme = 'green';
  currentTheme = theme;
  // Written only when someone picked it: the boot call must leave storage
  // alone, or the *next* default would never reach a browser that has simply
  // loaded the page once (see `appearanceWasChosen`).
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
      localStorage.setItem(THEME_CHOSEN_KEY, '1');
    } catch {}
  }
  document.documentElement.dataset.theme = theme;
  if (theme === 'paper' && !fontWasCustomized) setFont('serif', { persist: false });
  const label = theme === 'paper' && currentLang === 'ru'
    ? 'Книжная'
    : theme.charAt(0).toUpperCase() + theme.slice(1);
  document.querySelectorAll('.theme-name').forEach((el) => {
    el.textContent = label;
  });
  if (elements.schemeGroup) {
    elements.schemeGroup.querySelectorAll('[data-scheme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scheme === theme);
    });
  }
  applyMode();
}

function setFont(font, { persist = true } = {}) {
  currentFont = FONTS.includes(font) ? font : defaultFontFor(currentTheme);
  if (persist) {
    fontWasCustomized = true;
    try {
      localStorage.setItem(FONT_KEY, currentFont);
      localStorage.setItem(FONT_CHOSEN_KEY, '1');
    } catch {}
  }
  // The stylesheet does the rest: `:root[data-font=...]` repoints `--ui-font`.
  document.documentElement.dataset.font = currentFont;
  markSegmented(elements.fontGroup, 'font', currentFont);
}

function setRound(round) {
  currentRound = ROUNDS.includes(round) ? round : 'soft';
  try {
    localStorage.setItem(ROUND_KEY, currentRound);
  } catch {}
  document.documentElement.dataset.round = currentRound;
  markSegmented(elements.roundGroup, 'round', currentRound);
}

// Retranslates a segmented group in place, given the message key each value
// maps to.
function labelSegmented(group, attribute, keys) {
  if (!group) return;
  group.querySelectorAll(`[data-${attribute}]`).forEach((btn) => {
    const key = keys[btn.dataset[attribute]];
    if (key) btn.textContent = t(key);
  });
}

// Decorative edges only: the stylesheet points `--edge`/`--edge-soft` at the
// palette's lines when this is on and at `transparent` when off, and every
// border keeps its width either way, so flipping it never moves the layout.
function setBorders(on, { persist = true } = {}) {
  bordersOn = Boolean(on);
  if (persist) {
    try {
      localStorage.setItem(BORDERS_KEY, bordersOn ? 'on' : 'off');
    } catch {}
  }
  document.documentElement.dataset.borders = bordersOn ? 'on' : 'off';
  if (elements.settingsBorders) elements.settingsBorders.checked = bordersOn;
}

// «Объёмный дизайн»: the same kind of switch, and like «Обводки» it only moves
// an attribute. The stylesheet draws every shadow, sheen and glow under
// `html[data-depth="on"]`; with it off the flat 1.130 look is the whole page.
function setDepth(on, { persist = true } = {}) {
  depthOn = Boolean(on);
  if (persist) {
    try {
      localStorage.setItem(DEPTH_KEY, depthOn ? 'on' : 'off');
    } catch {}
  }
  document.documentElement.dataset.depth = depthOn ? 'on' : 'off';
  if (elements.settingsDepth) elements.settingsDepth.checked = depthOn;
}

// The pattern behind the transcript. Nothing but an attribute moves: the
// stylesheet owns the gradients, tiles and steps, so this function never learns
// what a dot looks like. Only a click persists (`persist`), together with the
// marker `getInitialWallpaper` reads; the boot call just paints the attribute,
// or the next default could never reach a browser that has merely opened the
// page once.
function setWallpaper(wallpaper, { persist = true } = {}) {
  currentWallpaper = WALLPAPERS.includes(wallpaper) ? wallpaper : DEFAULT_WALLPAPER;
  if (persist) {
    try {
      localStorage.setItem(WALLPAPER_KEY, currentWallpaper);
      localStorage.setItem(WALLPAPER_CHOSEN_KEY, '1');
    } catch {}
  }
  document.documentElement.dataset.wallpaper = currentWallpaper;
  markSegmented(elements.wallpaperGroup, 'wallpaper', currentWallpaper);
}

// The active-button bookkeeping every segmented group in settings repeats.
function markSegmented(group, attribute, value) {
  if (!group) return;
  group.querySelectorAll(`[data-${attribute}]`).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset[attribute] === value);
  });
}

function cycleTheme() {
  const nextIdx = (THEMES.indexOf(currentTheme) + 1) % THEMES.length;
  setTheme(THEMES[nextIdx], { persist: true });
  if (activePeer) {
    const thread = threads.get(activePeer);
    if (thread) systemNote(thread, t('themeSet', THEMES[nextIdx]));
  }
}

// --- Настройки приложения ------------------------------------------------

function syncSettingsDialog() {
  if (elements.settingsSound) elements.settingsSound.checked = soundEnabled;
  if (elements.settingsSoundSend) elements.settingsSoundSend.checked = sendSoundEnabled;
  if (elements.settingsTyping) elements.settingsTyping.checked = typingEnabled;
  if (elements.settingsHoliday) elements.settingsHoliday.checked = holidayMode;
  if (elements.settingsLinkPreview) elements.settingsLinkPreview.checked = linkPreviewEnabled;
  if (elements.settingsShowDeleted) elements.settingsShowDeleted.checked = showDeletedMessages;
  renderQuickReactionSettings();
  if (elements.settingsBorders) elements.settingsBorders.checked = bordersOn;
  if (elements.settingsDepth) elements.settingsDepth.checked = depthOn;
  // One implementation of «what does the notifications row say», not two: this
  // block used to repeat `updateNotifyBtn`'s arithmetic and had already drifted
  // from it — the label said the browser had not been asked while the checkbox
  // was painted on (owner: «web пропали оповещения … надо проверить»).
  updateNotifyBtn();
  applyMode();

  markSegmented(elements.schemeGroup, 'scheme', currentTheme);
  markSegmented(elements.fontGroup, 'font', currentFont);
  markSegmented(elements.roundGroup, 'round', currentRound);
  markSegmented(elements.wallpaperGroup, 'wallpaper', currentWallpaper);
  if (elements.settingsInstallBtn) {
    elements.settingsInstallBtn.hidden = !(deferredInstallPrompt || (isIos && !isStandalone));
  }
  syncCustomSoundRow();
}

function setShowDeletedMessages(next) {
  showDeletedMessages = Boolean(next);
  try { localStorage.setItem(SHOW_DELETED_KEY, String(showDeletedMessages)); } catch {}
  for (const thread of threads.values()) {
    for (const row of thread.node.querySelectorAll('.row[data-deleted="true"]')) {
      row.hidden = !showDeletedMessages;
    }
    scheduleDateDividers(thread);
  }
  renderRoster();
}

function openSettingsDialog() {
  syncSettingsDialog();
  elements.settingsDialog?.showModal();
}

function closeSettingsDialog() {
  elements.settingsDialog?.close();
}

function setLanguage(lang) {
  if (lang !== 'en' && lang !== 'ru' && lang !== 'fr') return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {}
  document.documentElement.lang = lang;
  timeFormat = new Intl.DateTimeFormat(localeFor(currentLang), { hour: '2-digit', minute: '2-digit' });
  dayFormat = new Intl.DateTimeFormat(localeFor(currentLang), { day: 'numeric', month: 'long' });
  weekdayFormat = new Intl.DateTimeFormat(localeFor(currentLang), { weekday: 'short' });
  dayShortFormat = new Intl.DateTimeFormat(localeFor(currentLang), { day: 'numeric', month: 'short' });

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  updateStaticI18n();
  setMode(mode);
  renderRoster();
  updatePeerHeader();
  renderInfoPanel();

  if (token && self) {
    request('PATCH', '/profile', { lang }).catch(() => {});
  }
}

function updateStaticI18n() {
  if (elements.bootNote) elements.bootNote.textContent = t('bootNote');
  if (elements.labelLogin) elements.labelLogin.textContent = t('labelLogin');
  if (elements.hintLogin) elements.hintLogin.textContent = t('hintLogin');
  if (elements.labelName) elements.labelName.textContent = t('labelName');
  if (elements.hintName) elements.hintName.textContent = t('hintName');
  if (elements.labelRecovery) elements.labelRecovery.textContent = t('labelRecovery');
  if (elements.hintRecovery) elements.hintRecovery.textContent = t('hintRecovery');
  if (elements.labelPassword) elements.labelPassword.textContent = t('labelPassword');
  if (elements.labelPasswordConfirm) elements.labelPasswordConfirm.textContent = t('labelPasswordConfirm');
  if (elements.hintPasswordConfirm) elements.hintPasswordConfirm.textContent = t('hintPasswordConfirm');
  if (elements.labelExtraPassword) elements.labelExtraPassword.textContent = t('labelExtraPassword');
  if (elements.hintExtraPassword) elements.hintExtraPassword.textContent = t('hintExtraPassword');
  if (elements.extraPassToggleBtn) {
    const isPass = elements.fieldExtraPassword?.type === 'password';
    elements.extraPassToggleBtn.title = isPass ? t('passToggleShow') : t('passToggleHide');
    elements.extraPassToggleBtn.setAttribute('aria-label', isPass ? t('passToggleShow') : t('passToggleHide'));
  }
  if (elements.authForgotBtn) elements.authForgotBtn.textContent = t('authForgotBtn');
  if (elements.recModalTitle) elements.recModalTitle.textContent = t('recModalTitle');
  if (elements.recModalHint) elements.recModalHint.textContent = t('recModalHint');
  if (elements.recContinueBtn) elements.recContinueBtn.textContent = t('recContinue');
  if (elements.rosterTitle) elements.rosterTitle.textContent = t('rosterTitle');
  if (elements.rosterEmpty) elements.rosterEmpty.textContent = t('rosterEmpty');
  if (elements.inviteOpenButton) {
    // The button is icon-only now (a compact "+" next to the roster title,
    // not the full-width dashed one it used to be), so this sets the
    // tooltip/accessible name instead of overwriting the icon as text.
    const label = t('addFriend').replace(/^\+\s*/, '');
    elements.inviteOpenButton.title = label;
    elements.inviteOpenButton.setAttribute('aria-label', label);
  }
  if (elements.logoutButton) elements.logoutButton.textContent = t('logout');
  if (elements.backButtonLabel) elements.backButtonLabel.textContent = t('back');
  if (elements.recCopyBtn) elements.recCopyBtn.textContent = t('recCopy');
  if (elements.recCloseBtn) elements.recCloseBtn.setAttribute('aria-label', t('recClose'));
  if (elements.passToggleBtn) {
    const isPass = elements.fieldPassword?.type === 'password';
    elements.passToggleBtn.title = isPass ? t('passToggleShow') : t('passToggleHide');
    elements.passToggleBtn.setAttribute('aria-label', isPass ? t('passToggleShow') : t('passToggleHide'));
  }
  if (elements.passConfirmToggleBtn) {
    const isPass = elements.fieldPasswordConfirm?.type === 'password';
    elements.passConfirmToggleBtn.title = isPass ? t('passToggleShow') : t('passToggleHide');
    elements.passConfirmToggleBtn.setAttribute('aria-label', isPass ? t('passToggleShow') : t('passToggleHide'));
  }
  if (elements.authApkLink) {
    elements.authApkLink.title = t('authApkTitle');
    elements.authApkLink.textContent = t('settingsApk');
  }
  if (elements.updateAvailableBtn) {
    if (elements.updateAvailableLabel) elements.updateAvailableLabel.textContent = t('updateAvailable');
    elements.updateAvailableBtn.title = t('updateAvailableTitle');
  }
  updateSoundToggle();
  if (elements.authPwaInstallBtn) {
    const lbl = elements.authPwaInstallBtn.querySelector('.pwa-install-label');
    if (lbl) lbl.textContent = t('installApp').replace(/^📱\s*/, '');
    elements.authPwaInstallBtn.title = t('installTitle');
  }
  if (elements.pwaIosTitle) elements.pwaIosTitle.textContent = t('pwaIosTitle');
  if (elements.pwaIosDesc) elements.pwaIosDesc.textContent = t('pwaIosDesc');
  if (elements.pwaIosAckBtn) elements.pwaIosAckBtn.textContent = t('pwaIosAck');
  if (elements.profileEyebrow) elements.profileEyebrow.textContent = t('settingsAccount').toUpperCase();
  if (elements.composerLabel) elements.composerLabel.textContent = t('send');
  if (elements.pwaIosSteps) {
    // Hardcoded Russian markup with inline <strong>/<em>: replaced wholesale
    // by the three translated steps, which carry their own punctuation.
    elements.pwaIosSteps.replaceChildren(...['pwaIosStep1', 'pwaIosStep2', 'pwaIosStep3'].map((key) => {
      const li = document.createElement('li');
      li.textContent = t(key);
      return li;
    }));
  }
  if (elements.placeholderTitle) elements.placeholderTitle.textContent = t('placeholderTitle');
  if (elements.placeholderText) elements.placeholderText.textContent = t('placeholderText');
  if (elements.sendLabel) elements.sendLabel.textContent = t('send');
  if (elements.sendButton) elements.sendButton.setAttribute('aria-label', t('send'));
  if (elements.modalTitle) elements.modalTitle.textContent = t('modalTitle');
  if (elements.myInviteTitle) elements.myInviteTitle.textContent = t('myInviteTitle');
  if (elements.myInviteHint) elements.myInviteHint.textContent = t('myInviteHint');
  if (elements.myInviteInput) elements.myInviteInput.placeholder = t('myInvitePlaceholder');
  if (elements.generateInviteButton) elements.generateInviteButton.textContent = t('create');
  if (elements.copyInviteButton) elements.copyInviteButton.textContent = t('copy');
  if (elements.acceptInviteTitle) elements.acceptInviteTitle.textContent = t('acceptInviteTitle');
  if (elements.acceptInviteHint) elements.acceptInviteHint.textContent = t('acceptInviteHint');
  if (elements.acceptInviteButton) elements.acceptInviteButton.textContent = t('add');
  if (elements.acceptInviteInput) elements.acceptInviteInput.placeholder = t('acceptInvitePlaceholder');
  if (elements.friendRequestTitle) elements.friendRequestTitle.textContent = t('friendRequestTitle');
  if (elements.friendRequestHint) elements.friendRequestHint.textContent = t('friendRequestHint');
  if (elements.friendRequestButton) elements.friendRequestButton.textContent = t('add');
  if (elements.friendRequestInput) elements.friendRequestInput.placeholder = t('friendRequestPlaceholder');
  if (elements.toggleRosterLabel) elements.toggleRosterLabel.textContent = t('togglePanePeers');
  if (elements.toggleInfoLabel) elements.toggleInfoLabel.textContent = t('togglePaneInfo');
  if (elements.toggleRosterBtn) elements.toggleRosterBtn.title = t('togglePeersTitle');
  if (elements.toggleInfoBtn) elements.toggleInfoBtn.title = t('togglePaneInfoTitle');
  if (elements.talkPeerBtn) elements.talkPeerBtn.title = t('togglePaneInfoTitle');
  if (elements.conversationMenuButton) {
    elements.conversationMenuButton.title = t('convMenuTitle');
    elements.conversationMenuButton.setAttribute('aria-label', t('convMenuTitle'));
  }
  if (elements.paneGrip) elements.paneGrip.setAttribute('aria-label', t('resizeRoster'));
  if (elements.infoGrip) elements.infoGrip.setAttribute('aria-label', t('resizeInfo'));
  if (elements.infoTitle) elements.infoTitle.textContent = t('infoTitle');
  if (elements.infoCloseBtn) elements.infoCloseBtn.setAttribute('aria-label', t('infoClose'));
  if (elements.infoStatsHeading) elements.infoStatsHeading.textContent = t('infoStats');
  if (elements.infoStatMsgsLabel) elements.infoStatMsgsLabel.textContent = t('infoStatMessages');
  if (elements.infoStatImagesLabel) elements.infoStatImagesLabel.textContent = t('infoStatImages');
  if (elements.infoStatVoiceLabel) elements.infoStatVoiceLabel.textContent = t('infoStatVoice');
  if (elements.infoStatUnreadLabel) elements.infoStatUnreadLabel.textContent = t('infoStatUnread');
  if (elements.infoActionsHeading) elements.infoActionsHeading.textContent = t('infoActions');
  if (elements.infoWakeBtn) elements.infoWakeBtn.textContent = t('infoWake');
  if (elements.infoExportBtn) elements.infoExportBtn.textContent = t('infoExport');
  if (elements.infoClearBtn) elements.infoClearBtn.textContent = t('infoClearView');
  if (elements.infoSessionHeading) elements.infoSessionHeading.textContent = t('infoSession');
  if (elements.infoServerLabel) elements.infoServerLabel.textContent = t('infoServer');
  if (elements.infoTransportLabel) elements.infoTransportLabel.textContent = t('infoTransport');
  if (elements.infoLatencyLabel) elements.infoLatencyLabel.textContent = t('infoLatency');
  if (elements.infoPingBtn) elements.infoPingBtn.textContent = t('infoMeasure');
  if (elements.voiceButton) elements.voiceButton.title = t('voiceButtonTitle');
  if (elements.voiceCancelLabel) elements.voiceCancelLabel.textContent = t('voiceCancel');
  if (elements.voiceSendLabel) elements.voiceSendLabel.textContent = t('voiceSendLabel');
  renderSelectionState();
  if (elements.settingsBtn) elements.settingsBtn.title = t('settings');
  if (elements.settingsBtnLabel) elements.settingsBtnLabel.textContent = t('settings');
  if (elements.settingsTitle) elements.settingsTitle.textContent = t('settings');
  if (elements.settingsModeHeading) elements.settingsModeHeading.textContent = t('settingsMode');
  if (elements.settingsSchemeHeading) elements.settingsSchemeHeading.textContent = t('settingsScheme');
  if (elements.settingsFontHeading) elements.settingsFontHeading.textContent = t('settingsFont');
  if (elements.settingsWallpaperHeading) elements.settingsWallpaperHeading.textContent = t('settingsWallpaper');
  if (elements.settingsRoundHeading) elements.settingsRoundHeading.textContent = t('settingsRound');
  if (elements.settingsBordersLabel) elements.settingsBordersLabel.textContent = t('settingsBorders');
  if (elements.settingsDepthLabel) elements.settingsDepthLabel.textContent = t('settingsDepth');
  if (elements.infoRouteLabel) elements.infoRouteLabel.textContent = t('infoRoute');
  if (elements.infoClientLabel) elements.infoClientLabel.textContent = t('infoClient');
  // The buttons carry their own labels, keyed off the value they set, so a
  // language switch does not leave three Russian words under an English heading.
  labelSegmented(elements.fontGroup, 'font', { mono: 'fontMono', sans: 'fontSans', serif: 'fontSerif' });
  labelSegmented(elements.roundGroup, 'round', { sharp: 'roundSharp', soft: 'roundSoft', round: 'roundRound' });
  // The wallpaper cards hold a preview inside the button, so `labelSegmented`
  // (which replaces `textContent` wholesale) would delete it: the name lives in
  // its own span and is the only thing retranslated.
  if (elements.wallpaperGroup) {
    elements.wallpaperGroup.querySelectorAll('[data-wallpaper]').forEach((btn) => {
      const name = btn.querySelector('.wallpaper-label');
      const key = {
        none: 'wallpaperNone', dots: 'wallpaperDots', ruled: 'wallpaperRuled', diamond: 'wallpaperDiamond',
        aurora: 'wallpaperAurora', waves: 'wallpaperWaves', topo: 'wallpaperTopo', doodle: 'wallpaperDoodle',
      }[btn.dataset.wallpaper];
      if (name && key) name.textContent = t(key);
    });
  }
  if (elements.settingsBehaviourHeading) elements.settingsBehaviourHeading.textContent = t('settingsBehaviour');
  if (elements.settingsLangHeading) elements.settingsLangHeading.textContent = t('settingsLang');
  if (elements.settingsAppsHeading) elements.settingsAppsHeading.textContent = t('settingsApps');
  if (elements.settingsAccountHeading) elements.settingsAccountHeading.textContent = t('settingsAccount');
  if (elements.settingsSoundLabel) elements.settingsSoundLabel.textContent = t('settingsSound');
  if (elements.settingsSoundSendLabel) elements.settingsSoundSendLabel.textContent = t('settingsSoundSend');
  if (elements.settingsVolumeLabel) elements.settingsVolumeLabel.textContent = t('settingsVolume');
  syncCustomSoundRow();
  if (elements.settingsTypingLabel) elements.settingsTypingLabel.textContent = t('settingsTyping');
  if (elements.settingsHolidayLabel) elements.settingsHolidayLabel.textContent = t('settingsHoliday');
  if (elements.settingsLinkPreviewLabel) elements.settingsLinkPreviewLabel.textContent = t('settingsLinkPreview');
  if (elements.settingsShowDeletedLabel) elements.settingsShowDeletedLabel.textContent = t('settingsShowDeleted');
  if (elements.settingsQuickReactionsLabel) elements.settingsQuickReactionsLabel.textContent = t('settingsQuickReactions');
  renderQuickReactionSettings();
  if (elements.settingsInstallBtn) elements.settingsInstallBtn.textContent = t('settingsInstall');
  if (elements.settingsApkLink) elements.settingsApkLink.textContent = t('settingsApk');
  if (elements.authApkLink) elements.authApkLink.textContent = t('settingsApk');
  if (elements.settingsProfileBtn) elements.settingsProfileBtn.textContent = t('settingsProfile');
  if (elements.settingsE2eeHeading) elements.settingsE2eeHeading.textContent = t('e2ee.settingsHeading');
  if (elements.settingsBackupCreateBtn) elements.settingsBackupCreateBtn.textContent = t('e2ee.settingsBackupCreate');
  if (elements.settingsBackupStatusBtn) elements.settingsBackupStatusBtn.textContent = t('e2ee.settingsBackupStatus');
  if (elements.settingsBackupRestoreBtn) elements.settingsBackupRestoreBtn.textContent = t('e2ee.settingsBackupRestore');
  if (elements.settingsKeysResetBtn) elements.settingsKeysResetBtn.textContent = t('e2ee.settingsKeysReset');
  if (elements.authThemeBtn) elements.authThemeBtn.title = t('themeBtnTitle');
  if (elements.modeGroup) {
    elements.modeGroup.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.textContent = t(`mode${btn.dataset.mode.charAt(0).toUpperCase()}${btn.dataset.mode.slice(1)}`);
    });
  }
  updateNotifyBtn();
  applyMode();
  if (elements.logoBand) elements.logoBand.title = t('logoBandTitle');
  if (elements.profileOpenButton) elements.profileOpenButton.textContent = t('profileOpen');
  if (elements.railSelfButton) {
    const railSelfLabel = t('profileOpen');
    elements.railSelfButton.title = railSelfLabel;
    elements.railSelfButton.setAttribute('aria-label', railSelfLabel);
  }
  if (elements.profileTitle) elements.profileTitle.textContent = t('profileTitle');
  if (elements.profileLoginLabel) elements.profileLoginLabel.textContent = t('profileLoginLabel');
  if (elements.profileLoginHint) elements.profileLoginHint.textContent = t('profileLoginHint');
  if (elements.profileNameLabel) elements.profileNameLabel.textContent = t('profileNameLabel');
  if (elements.profilePasswordTitle) elements.profilePasswordTitle.textContent = t('profilePasswordTitle');
  if (elements.profilePasswordHint) elements.profilePasswordHint.textContent = t('profilePasswordHint');
  if (elements.profileCurrentPasswordLabel) elements.profileCurrentPasswordLabel.textContent = t('profileCurrentPassword');
  if (elements.profileNewPasswordLabel) elements.profileNewPasswordLabel.textContent = t('profileNewPassword');
  if (elements.profileConfirmPasswordLabel) elements.profileConfirmPasswordLabel.textContent = t('profileConfirmPassword');
  if (elements.profileExtraPasswordTitle) elements.profileExtraPasswordTitle.textContent = t('profileExtraPasswordTitle');
  if (elements.profileExtraPasswordHint) elements.profileExtraPasswordHint.textContent = t('profileExtraPasswordHint');
  if (elements.profileExtraPasswordEnabledLabel) elements.profileExtraPasswordEnabledLabel.textContent = t('profileExtraPasswordEnabledLabel');
  if (elements.profileExtraPasswordLabel) elements.profileExtraPasswordLabel.textContent = t('profileExtraPasswordLabel');
  if (elements.profileExtraPasswordConfirmLabel) elements.profileExtraPasswordConfirmLabel.textContent = t('profileExtraPasswordConfirmLabel');
  if (elements.profileExtraPasswordNote) elements.profileExtraPasswordNote.textContent = t('profileExtraPasswordNote');
  if (elements.profileCancelButton) elements.profileCancelButton.textContent = t('profileCancel');
  if (elements.profileSaveButton) elements.profileSaveButton.textContent = t('profileSave');
  if (elements.attachButton) {
    elements.attachButton.title = t('attachFile');
    elements.attachButton.setAttribute('aria-label', t('attachFile'));
  }
  if (elements.emojiButton) {
    elements.emojiButton.title = t('emojiButton');
    elements.emojiButton.setAttribute('aria-label', t('emojiButton'));
  }
  if (elements.lightbox) elements.lightbox.setAttribute('aria-label', t('imageTitle'));
  if (elements.lightboxSave) elements.lightboxSave.setAttribute('aria-label', t('imageSave'));
  if (elements.lightboxClose) elements.lightboxClose.setAttribute('aria-label', t('closeDialog'));
  if (elements.imageSheet) elements.imageSheet.setAttribute('aria-label', t('imageSheetTitle'));
  if (elements.imageSheetRatios) elements.imageSheetRatios.setAttribute('aria-label', t('imageCropRatio'));
  if (elements.imageSheetFree) elements.imageSheetFree.textContent = t('imageCropFree');
  if (elements.imageSheetReset) elements.imageSheetReset.textContent = t('imageCropReset');
  if (elements.imageSheetCancel) elements.imageSheetCancel.textContent = t('imageCancel');
  if (elements.imageSheetCropToggle) elements.imageSheetCropToggle.textContent = t('imageCrop');
  if (elements.imageSheetRotate) elements.imageSheetRotate.textContent = t('imageRotate');
  if (elements.imageSheetCaption) {
    elements.imageSheetCaption.placeholder = t('imageCaption');
    elements.imageSheetCaption.setAttribute('aria-label', t('imageCaption'));
  }
  if (elements.imageSheetSend) elements.imageSheetSend.textContent = t('send');
  if (elements.input) {
    elements.input.placeholder = composerPlaceholderText();
  }
}

// --- Палитра слэш-команд (Autocomplete) -----------------------------------

// The encryption commands exist only on a page whose core is running.
function availableCommands() {
  return COMMANDS.filter((cmd) => !cmd.core || coreE2ee);
}

function updateCommandPalette(text) {
  if (!text.startsWith('/')) {
    hideCommandPalette();
    return;
  }
  const clean = text.toLowerCase().trim();
  paletteMatches = availableCommands().filter((cmd) => {
    return cmd.name.startsWith(clean) || (cmd.alias && cmd.alias.startsWith(clean));
  });

  if (paletteMatches.length === 0) {
    hideCommandPalette();
    return;
  }

  paletteIndex = Math.min(paletteIndex, paletteMatches.length - 1);
  if (paletteIndex < 0) paletteIndex = 0;

  renderCommandPalette();
  elements.commandPalette.hidden = false;
}

function hideCommandPalette() {
  if (elements.commandPalette) elements.commandPalette.hidden = true;
  paletteMatches = [];
  paletteIndex = 0;
}

function renderCommandPalette() {
  elements.commandList.innerHTML = '';
  paletteMatches.forEach((cmd, idx) => {
    const li = document.createElement('li');
    li.className = 'command-item' + (idx === paletteIndex ? ' selected' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'command-name';
    nameSpan.textContent = cmd.name + (cmd.args ? ` ${cmd.args}` : '');

    const aliasSpan = document.createElement('span');
    aliasSpan.className = 'command-alias';
    aliasSpan.textContent = cmd.alias ? `(${cmd.alias})` : '';

    const helpSpan = document.createElement('span');
    helpSpan.className = 'command-help';
    helpSpan.textContent = cmd.help[currentLang] || cmd.help.en;

    li.append(nameSpan, aliasSpan, helpSpan);
    li.addEventListener('mouseenter', () => {
      if (paletteIndex !== idx) {
        paletteIndex = idx;
        const items = elements.commandList.querySelectorAll('.command-item');
        items.forEach((item, i) => {
          item.classList.toggle('selected', i === paletteIndex);
        });
      }
    });
    li.addEventListener('click', (e) => {
      e.preventDefault();
      applyCommandMatch(cmd);
    });
    elements.commandList.append(li);
  });

  const selectedItem = elements.commandList.children[paletteIndex];
  if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });
}

function applyCommandMatch(cmd) {
  const suffix = cmd.args ? ' ' : '';
  elements.input.value = cmd.name + suffix;
  elements.composerGrow.dataset.value = elements.input.value;
  elements.sendButton.disabled = false;
  elements.input.focus();
  hideCommandPalette();
  if (!cmd.args) {
    elements.composer.requestSubmit();
  }
}

// --- Обработка команд ----------------------------------------------------

async function executeCommand(line) {
  const parts = line.trim().split(/\s+/);
  const rawCmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  const found = availableCommands().find((c) => c.name === rawCmd || c.alias === rawCmd);
  const cmd = found ? found.name : rawCmd;
  const thread = activePeer ? threadFor(activePeer) : null;

  if (cmd === '/help') {
    if (!thread) return;
    const lines = [
      t('helpHeader'),
      ...availableCommands().map((c) => {
        const left = `${c.name} ${c.args || ''}`.padEnd(26);
        const desc = c.help[currentLang] || c.help.en;
        return `  ${left} ${desc}`;
      }),
      t('helpFooter'),
    ];
    appendAsciiArt(thread, lines.join('\n'));
    return;
  }

  if (cmd === '/clear') {
    if (thread) {
      thread.node.innerHTML = '';
      thread.seen.clear();
      thread.marks.clear();
      thread.lastDay = null;
      systemNote(thread, 'Chat cleared');
      // `/clear` leaves the thread empty on screen, which is the same state
      // the service account's own menu is offered in.
      renderBotActions();
    }
    return;
  }

  if (cmd === '/theme') {
    if (arg && THEMES.includes(arg.toLowerCase())) {
      setTheme(arg.toLowerCase(), { persist: true });
      if (thread) systemNote(thread, t('themeSet', arg.toLowerCase()));
    } else {
      cycleTheme();
    }
    return;
  }

  if (cmd === '/mode') {
    if (arg && MODES.includes(arg.toLowerCase())) setColorMode(arg.toLowerCase(), { note: true });
    else cycleColorMode();
    return;
  }

  if (cmd === '/settings') {
    openSettingsDialog();
    return;
  }

  if (cmd === '/ping') {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (thread) systemNote(thread, t('errors.network'));
      return;
    }
    clearPendingPing();
    const peer = activePeer;
    const id = randomHex(12);
    const start = performance.now();
    const timer = setTimeout(() => {
      if (!pendingPing || pendingPing.id !== id) return;
      clearPendingPing();
      showToast(t('pingTimeout', displayName(peer)));
    }, PING_TIMEOUT_MS);
    pendingPing = { id, peer, start, timer };
    if (!sendFrame(peer, { t: 'ping', id, ts: Date.now() })) {
      clearPendingPing();
      if (thread) systemNote(thread, t('errors.network'));
      return;
    }
    showToast(t('pingSent'));
    return;
  }

  if (cmd === '/logo') {
    animateLogo();
    playSound('sent');
    if (thread) {
      const art = holidayMode ? LOGO_HOLIDAY : LOGO_PLAIN;
      appendAsciiArt(thread, art);
    }
    return;
  }

  if (cmd === '/holiday') {
    if (arg === 'on') holidayMode = true;
    else if (arg === 'off') holidayMode = false;
    else holidayMode = !holidayMode;
    try {
      localStorage.setItem(HOLIDAY_KEY, String(holidayMode));
    } catch {}
    animateLogo();
    if (thread) systemNote(thread, t('holidaySet', holidayMode));
    sendFrame(activePeer, { t: 'holiday', on: holidayMode });
    return;
  }

  if (cmd === '/saver') {
    startScreensaver();
    return;
  }

  if (cmd === '/wake') {
    if (!activePeer || !authed) return;
    sendFrame(activePeer, { t: 'wake' });
    playSound('wake');
    triggerWakeAnimation();
    if (thread) systemNote(thread, t('wakeSent'));
    return;
  }

  if (cmd === '/ai' || cmd === '/ask') {
    if (!arg) {
      if (thread) systemNote(thread, 'Использование: /ai <вопрос>');
      return;
    }
    const text = `tailik, ${arg}`;
    sendPlainMessage(text);
    return;
  }

  if (cmd === '/paste') {
    if (!activePeer || !authed) return;
    const peer = activePeer;
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        let found = false;
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            found = true;
            await handlePastedImage(blob, peer);
          }
        }
        if (found) return;
      }
    } catch {}
    if (thread) systemNote(thread, t('pasteHint'));
    return;
  }

  if (cmd === '/notify') {
    if (arg === 'on') await setNotifyState(true, true);
    else if (arg === 'off') await setNotifyState(false, false);
    else await setNotifyState(!notifyEnabled, true);
    playSound('sent');
    if (thread) systemNote(thread, t('notifySet', notifyEnabled));
    return;
  }

  if (cmd === '/sound') {
    if (arg === 'on') setSoundState(true);
    else if (arg === 'off') setSoundState(false);
    else setSoundState(!soundEnabled);
    playSound('sent');
    if (thread) systemNote(thread, t('soundSet', soundEnabled));
    return;
  }

  if (cmd === '/typing') {
    if (arg === 'on') typingEnabled = true;
    else if (arg === 'off') typingEnabled = false;
    else typingEnabled = !typingEnabled;
    try {
      localStorage.setItem(TYPING_KEY, String(typingEnabled));
    } catch {}
    if (thread) systemNote(thread, t('typingSet', typingEnabled));
    return;
  }

  if (cmd === '/happy') {
    sendPlainMessage('(^_^)');
    return;
  }

  if (cmd === '/sad') {
    sendPlainMessage('(;_;)');
    return;
  }

  if (cmd === '/neutral') {
    sendPlainMessage('(._.)');
    return;
  }

  if (cmd === '/asc') {
    const key = (arg || 'cat').toLowerCase();
    const art = ASCII_ART[key] || ASCII_ART.cat;
    sendPlainMessage(art);
    return;
  }

  if (cmd === '/code') {
    // Taken off the raw line rather than `arg`: splitting on whitespace would
    // squash the indentation that makes a code block worth sending.
    const code = line.trim().slice(rawCmd.length).trim();
    if (code === '') {
      if (thread) systemNote(thread, t('codeUsage'));
      return;
    }
    sendPlainMessage('```\n' + code + '\n```');
    return;
  }

  if (cmd === '/time') {
    if (!thread) return;
    const now = new Date();
    const local = now.toLocaleString(localeFor(currentLang));
    const utc = now.toUTCString();
    systemNote(thread, `🕒 Local: ${local} | UTC: ${utc}`);
    return;
  }

  if (cmd === '/nick') {
    if (!arg) {
      if (thread) systemNote(thread, 'Usage: /nick <new_name>');
      return;
    }
    const newName = arg.slice(0, 24).trim();
    if (self) {
      self.name = newName;
      renderSelfIdentity();
      greetPeer();
      if (thread) systemNote(thread, t('nickSet', newName));
    }
    return;
  }

  if (cmd === '/peer') {
    if (arg) {
      const match = users.find((u) => u.login.toLowerCase() === arg.toLowerCase() || (u.name && u.name.toLowerCase() === arg.toLowerCase()));
      if (match) {
        selectPeer(match.login);
      } else {
        if (thread) systemNote(thread, `User "${arg}" not found in friends list`);
      }
    } else {
      if (thread) {
        const rows = users.map((u) => `  ${u.login === activePeer ? '●' : '○'} @${u.login} (${peerLabel(u)}) — ${u.online ? 'online' : humanLastSeen(u.lastSeen)}`);
        const header = `═ FRIENDS ROSTER (${users.length}) ═════════════════════════`;
        appendAsciiArt(thread, `${header}\n${rows.join('\n')}\nType /peer <login> to switch`);
      }
    }
    return;
  }

  if (cmd === '/invite' || cmd === '/inv') {
    const clean = arg.trim();
    const parts = clean.split(/\s+/);
    const action = parts[0]?.toLowerCase();
    const token = parts[1] || (parts[0]?.length === 64 ? parts[0] : null);
    // Only `create`/`new` read a login: `/invite <url>` and `/invite <64hex>`
    // stay accepts, where parts[1] is a token, not an account.
    const inviteLogin = action === 'create' || action === 'new' ? (parts[1] || '').trim() : '';

    if (action === 'create' || action === 'new' || clean === '') {
      if (thread) systemNote(thread, t('creating'));
      try {
        const data = inviteLogin
          ? await request('POST', '/invite', { login: inviteLogin })
          : await request('POST', '/invite');
        const inviteUrl = `${location.origin}/tailchat/?invite=${data.invite}`;
        openInviteDialog();
        elements.myInviteInput.value = inviteUrl;
        elements.copyInviteButton.disabled = false;
        // A link minted for somebody else must not read like your own in the
        // dialog either: this is the one place the code is about to be copied
        // out of, and «отправьте другу» is the wrong instruction for it.
        elements.myInviteStatus.textContent = inviteLogin ? t('createdNoticeFor', inviteLogin) : t('createdNotice');
        if (thread) {
          const lines = [
            inviteLogin ? t('createdNoticeFor', inviteLogin) : t('createdNotice'),
            `  ${inviteUrl}`,
            t('myInviteHint'),
          ];
          appendAsciiArt(thread, lines.join('\n'));
        }
      } catch (err) {
        if (thread) systemNote(thread, errorText(err.code));
      }
      return;
    }

    const rawToAccept = token || parts.slice(1).join(' ') || parts[0];
    const codeToAccept = parseInviteCode(rawToAccept);
    if (codeToAccept) {
      if (thread) systemNote(thread, t('checking'));
      try {
        const data = await request('POST', '/invite/accept', { invite: codeToAccept });
        if (thread) systemNote(thread, t('friendAdded', peerLabel(data.friend) || data.friend.login));
        await refreshRoster();
        if (data.friend.login) {
          await selectPeer(data.friend.login);
        }
      } catch (err) {
        if (thread) systemNote(thread, errorText(err.code));
      }
      return;
    }
    if (thread) systemNote(thread, 'Usage: /invite create [login]   or   /invite accept <invite-link-or-code>');
    return;
  }

  if (cmd === '/history') {
    exportHistory();
    return;
  }

  if (cmd === '/version') {
    if (thread) systemNote(thread, t('versionInfo', APP_VERSION || '—'));
    return;
  }

  if (cmd === '/status') {
    if (!thread) return;
    const linkState = !socket
      ? t('connOffline')
      : (socket.readyState === WebSocket.OPEN && authed ? t('connOnline') : t('connConnecting'));
    const transport = activePeer && directState(activePeer) === 'connected'
      ? 'p2p'
      : (location.protocol === 'https:' ? 'wss' : 'ws');
    // The «Saved messages» thread has no far end to be online, so it says what
    // it is instead of reporting a peer that was never there.
    const isSelfChat = Boolean(self) && activePeer === self.login;
    const user = activePeer && !isSelfChat ? users.find((u) => u.login === activePeer) : null;
    const lines = [t('statusHeader'), t('statusSocket', `${linkState} (${transport})`)];
    if (activePeer) {
      const peerState = isSelfChat
        ? t('savedMessagesHint')
        : (user ? (isServiceAccount(user) ? t('officialAccount') : (user.online ? presenceLabel(user) : t('peerOffline', humanLastSeen(user.lastSeen)))) : '—');
      lines.push(t('statusPeerLine', displayName(activePeer), peerState));
    } else {
      lines.push(t('statusNoPeer'));
    }
    lines.push(t('statusLatency', lastLatencyMs > 0 ? t('infoLatencyValue', lastLatencyMs) : '—'));
    lines.push(t('statusRoute', describeRoute()));
    appendAsciiArt(thread, lines.join('\n'));
    return;
  }

  if (cmd === '/del') {
    if (!thread || !activePeer) return;
    const own = [...thread.node.querySelectorAll('.row[data-side="own"][data-id]')];
    if (own.length === 0) {
      systemNote(thread, t('delNothing'));
      return;
    }
    const max = Math.min(own.length, DEL_MAX_IDS);
    const count = arg === '' ? 1 : Number.parseInt(arg, 10);
    if (!Number.isInteger(count) || count < 1 || count > max) {
      systemNote(thread, t('delUsage', max));
      return;
    }
    const peer = activePeer;
    const ids = own.slice(-count).map((row) => row.dataset.id);
    sendFrame(peer, { t: 'del', ids });
    systemNote(thread, t('delDone', removeLocalMessages(peer, ids)));
    return;
  }

  if (cmd === '/edit') {
    if (!thread || !arg) return;
    const own = [...thread.node.querySelectorAll('.row[data-side="own"][data-id]')];
    const last = own.at(-1);
    if (last) editMessage(last.dataset.id, arg);
    return;
  }

  if (cmd === '/react') {
    if (!thread || !arg) return;
    const last = [...thread.node.querySelectorAll('.row[data-id]')].at(-1);
    if (last) reactToMessage(last.dataset.id, arg);
    return;
  }

  if (cmd === '/route') {
    if (thread) appendAsciiArt(thread, describeRoute());
    return;
  }

  if (cmd === '/voice') {
    void startVoiceRecording();
    return;
  }

  if (cmd === '/send') {
    if (!activePeer || !authed) return;
    elements.fileInput?.click();
    return;
  }

  if (cmd === '/lang') {
    const lang = arg.toLowerCase();
    if (lang !== 'ru' && lang !== 'en' && lang !== 'fr') {
      if (thread) systemNote(thread, t('langUsage'));
      return;
    }
    setLanguage(lang);
    if (thread) systemNote(thread, t('langSet', lang));
    return;
  }

  if (cmd === '/reconnect') {
    if (thread) systemNote(thread, t('reconnectRequested'));
    dropSocket();
    handleSocketGone();
    reconnectNow();
    return;
  }

  if (cmd === '/quit') {
    logout();
    return;
  }

  if (found?.core && coreE2ee) {
    runCoreE2eeCommand(cmd, arg);
    return;
  }

  // If unknown command, show note
  if (thread) systemNote(thread, `Unknown command: ${rawCmd}. Type /help for available commands.`);
}

function sendPlainMessage(text) {
  if (!activePeer || !authed) return;
  const thread = threadFor(activePeer);
  const id = `m-${randomHex(12)}`;
  const ts = Date.now();

  appendMessage(thread, { id, own: true, kind: 'human', author: self.name, text, ts });
  scrollToLatest(true);
  sendFrame(activePeer, { t: 'msg', id, ts, text });
  playSound('sent');
}

function appendAsciiArt(thread, text) {
  const pre = document.createElement('pre');
  pre.className = 'msg-art';
  pre.textContent = text;
  thread.node.append(pre);
  // Half-block glyphs only tile into solid letters at the font's real ink
  // pitch, which can only be measured once the block is in the document.
  // Box-drawing art has no such requirement and is left at the CSS value.
  if (/[▀▄█]/.test(text)) tuneLogoLineHeight(pre);
  scrollToLatest();
}

function triggerWakeAnimation() {
  document.body.classList.add('wake-active');
  setTimeout(() => document.body.classList.remove('wake-active'), 2500);
}

function formatLogin(login) {
  if (!login) return '';
  const clean = String(login).replace(/^@+/, '');
  return `@${clean}`;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = event.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function drawScaled(img, maxDim) {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Downscaling in one step aliases hard edges; the browser's own smoothing
  // at the highest setting is what keeps screenshots of text readable.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, width, height };
}

// `toDataURL` with a format the browser cannot write answers with PNG rather
// than failing, so the prefix is the only honest way to tell whether WebP was
// actually produced.
function encodeCanvas(canvas, mime, quality) {
  const url = canvas.toDataURL(mime, quality);
  return url.startsWith(`data:${mime}`) ? url : null;
}

// Fit the picture under the frame ceiling instead of pre-emptively ruining it:
// full resolution at high quality is tried first and only backed off when the
// encoded result genuinely does not fit.
async function compressImage(file, maxDim = IMAGE_MAX_DIM, quality = IMAGE_QUALITY) {
  const img = await loadImageElement(file);
  let dim = maxDim;
  let q = quality;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { canvas, width, height } = drawScaled(img, dim);
    const dataUrl = encodeCanvas(canvas, 'image/webp', q) ?? encodeCanvas(canvas, 'image/jpeg', q);
    if (dataUrl && dataUrl.length <= CLOUD_INLINE_MEDIA_SAFE_CHARS) return { dataUrl, width, height };
    q = Math.max(0.6, q - 0.1);
    dim = Math.round(dim * 0.7);
  }
  throw new Error('image_too_large');
}

// A 12-megapixel paste takes a visible moment to decode and re-encode, and
// until it lands there is nothing on screen to say anything is happening. The
// placeholder carries the real thumbnail, so it also confirms *which* picture
// is on its way.
function appendPendingImage(thread, file) {
  const row = document.createElement('article');
  row.className = 'row';
  row.dataset.side = 'own';
  row.dataset.kind = 'human';
  row.dataset.author = self?.name || self?.login || '';

  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble--pending';

  const shell = document.createElement('div');
  shell.className = 'pending-image';
  const url = rememberAttachmentUrl(file);
  const preview = document.createElement('img');
  preview.className = 'pending-image-thumb';
  preview.src = url;
  preview.alt = '';
  const label = document.createElement('span');
  label.className = 'pending-image-label';
  label.textContent = t('imagePasting');
  shell.append(preview, label);

  bubble.append(shell);
  row.append(bubble);
  thread.node.append(row);
  scrollToLatest(true);
  return {
    remove() {
      row.remove();
      URL.revokeObjectURL(url);
      attachmentUrls.delete(url);
    },
  };
}

// --- Превью картинки перед отправкой -----------------------------------------
//
// Every image input — paste, drop, the paperclip, `/paste` — stops at this
// sheet first: a screenshot usually holds more than the person meant to send,
// and a picture that already left cannot be cropped. Several images queue and
// are shown one at a time, each with its own crop. Cancelling hands back
// nothing, so neither the conversation nor the draft is touched.
const IMAGE_CROP_RATIOS = { free: 0, '1:1': 1, '4:3': 4 / 3, '16:9': 16 / 9 };
// Below this the eight handles of the frame start sitting on top of each other.
const IMAGE_CROP_MIN_PX = 40;
const imageSheet = {
  file: null,
  source: null,
  rotation: 0,
  // Fractions of the rotated picture, so a resize of the window or a turn of
  // the picture never has to translate pixels.
  crop: { x: 0, y: 0, w: 1, h: 1 },
  ratio: 'free',
  // Width / height the frame keeps while resized; 0 is a free frame.
  aspect: 0,
  cropping: false,
  drag: null,
  finish: null,
  result: null,
};
let imageSheetQueue = Promise.resolve();

function previewImageBeforeSend(file) {
  const owner = self?.login;
  const turn = imageSheetQueue.then(() => openImageSheet(file, owner));
  imageSheetQueue = turn.catch(() => {});
  return turn;
}

async function openImageSheet(file, owner) {
  if (!authed || self?.login !== owner) return null;
  const source = await loadImageElement(file);
  if (!authed || self?.login !== owner) return null;
  if (!source.naturalWidth || !source.naturalHeight) throw new Error('image_empty');
  Object.assign(imageSheet, {
    file, source, rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: 'free', aspect: 0, cropping: false, drag: null, result: null,
  });
  elements.imageSheetCaption.value = '';
  elements.imageSheetCaption.style.height = '';
  return new Promise((resolve) => {
    imageSheet.finish = (result) => {
      imageSheet.finish = null;
      resolve(result);
    };
    elements.imageSheet.showModal();
    renderImageSheet();
    // The caption takes the focus only where that cannot raise an on-screen
    // keyboard over the picture the person is about to crop.
    if (window.matchMedia('(pointer: fine)').matches) elements.imageSheetCaption.focus();
    else elements.imageSheet.focus();
  });
}

function imageSheetWhole() {
  const { x, y, w, h } = imageSheet.crop;
  return x <= 0 && y <= 0 && w >= 1 && h >= 1;
}

function imageSheetSize() {
  const { source, rotation } = imageSheet;
  return rotation % 180 === 0
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.naturalHeight, height: source.naturalWidth };
}

// Draws the rotated picture with its (offsetX, offsetY) — in rotated-picture
// pixels — at the canvas origin, scaled by `scale`.
function drawImageSheetSource(ctx, scale, offsetX = 0, offsetY = 0) {
  const { source, rotation } = imageSheet;
  const { width, height } = imageSheetSize();
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(scale, scale);
  ctx.translate(width / 2 - offsetX, height / 2 - offsetY);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
  ctx.restore();
}

function renderImageSheet() {
  if (!imageSheet.source || !elements.imageSheet.open) return;
  const stage = elements.imageSheetStage.getBoundingClientRect();
  const { width, height } = imageSheetSize();
  const scale = Math.min(stage.width / width, stage.height / height);
  const displayWidth = Math.max(1, Math.floor(width * scale));
  const displayHeight = Math.max(1, Math.floor(height * scale));
  const density = window.devicePixelRatio || 1;
  const canvas = elements.imageSheetCanvas;
  canvas.width = Math.round(displayWidth * density);
  canvas.height = Math.round(displayHeight * density);
  elements.imageSheetFrame.style.width = `${displayWidth}px`;
  elements.imageSheetFrame.style.height = `${displayHeight}px`;
  drawImageSheetSource(canvas.getContext('2d'), canvas.width / width);
  renderImageSheetCrop();
}

function renderImageSheetCrop() {
  const { crop, cropping } = imageSheet;
  const box = elements.imageSheetCrop;
  // Outside crop mode a frame that was set stays drawn — dimmed outside — so
  // what is about to be sent is never a surprise.
  box.hidden = !cropping && imageSheetWhole();
  box.style.left = `${crop.x * 100}%`;
  box.style.top = `${crop.y * 100}%`;
  box.style.width = `${crop.w * 100}%`;
  box.style.height = `${crop.h * 100}%`;
  elements.imageSheet.classList.toggle('image-sheet--cropping', cropping);
  elements.imageSheetRatios.hidden = !cropping;
  elements.imageSheetCropToggle.setAttribute('aria-pressed', String(cropping));
  for (const chip of elements.imageSheetRatios.querySelectorAll('[data-ratio]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.ratio === imageSheet.ratio));
  }
}

function setImageCropRatio(name) {
  const base = IMAGE_CROP_RATIOS[name] ?? 0;
  const { width, height } = imageSheetSize();
  imageSheet.ratio = name;
  // 4:3 and 16:9 follow the picture: a portrait screenshot gets 3:4 and 9:16.
  imageSheet.aspect = base && height > width ? 1 / base : base;
  if (imageSheet.aspect) {
    // The largest frame of that shape, centred on the picture.
    const picture = width / height;
    const w = imageSheet.aspect < picture ? imageSheet.aspect / picture : 1;
    const h = imageSheet.aspect < picture ? 1 : picture / imageSheet.aspect;
    imageSheet.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  renderImageSheetCrop();
}

function rotateImageSheet() {
  const { x, y, w, h } = imageSheet.crop;
  // The frame turns with the picture (clockwise), so what was selected stays
  // selected, and a kept shape turns with it — the same "follows the picture".
  imageSheet.crop = { x: 1 - (y + h), y: x, w: h, h: w };
  imageSheet.rotation = (imageSheet.rotation + 90) % 360;
  if (imageSheet.aspect) imageSheet.aspect = 1 / imageSheet.aspect;
  renderImageSheet();
}

function resetImageSheet() {
  Object.assign(imageSheet, {
    rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: 'free', aspect: 0,
  });
  renderImageSheet();
}

// `rect` and the result are in frame pixels. The edge or corner being dragged
// follows the pointer; the opposite side stays put. With a kept shape the
// frame grows to cover the pointer and then shrinks back to fit the picture.
function resizeCropRect(rect, handle, dx, dy, aspect, bounds) {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  const minWidth = Math.min(IMAGE_CROP_MIN_PX, bounds.width, rect.w);
  const minHeight = Math.min(IMAGE_CROP_MIN_PX, bounds.height, rect.h);
  let left = rect.x + (west ? dx : 0);
  let right = rect.x + rect.w + (east ? dx : 0);
  let top = rect.y + (north ? dy : 0);
  let bottom = rect.y + rect.h + (south ? dy : 0);
  if (!aspect) {
    if (west) left = Math.min(Math.max(0, left), right - minWidth);
    if (east) right = Math.max(Math.min(bounds.width, right), left + minWidth);
    if (north) top = Math.min(Math.max(0, top), bottom - minHeight);
    if (south) bottom = Math.max(Math.min(bounds.height, bottom), top + minHeight);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }
  let w = Math.max(minWidth, right - left);
  let h = Math.max(minHeight, bottom - top);
  const horizontal = west || east;
  const vertical = north || south;
  if (horizontal && vertical) {
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
  } else if (horizontal) {
    h = w / aspect;
  } else {
    w = h * aspect;
  }
  const anchorX = west ? rect.x + rect.w : (east ? rect.x : rect.x + rect.w / 2);
  const anchorY = north ? rect.y + rect.h : (south ? rect.y : rect.y + rect.h / 2);
  const roomX = west ? anchorX : (east ? bounds.width - anchorX : 2 * Math.min(anchorX, bounds.width - anchorX));
  const roomY = north ? anchorY : (south ? bounds.height - anchorY : 2 * Math.min(anchorY, bounds.height - anchorY));
  const fit = Math.min(1, roomX / w, roomY / h);
  w *= fit;
  h *= fit;
  return {
    x: west ? anchorX - w : (east ? anchorX : anchorX - w / 2),
    y: north ? anchorY - h : (south ? anchorY : anchorY - h / 2),
    w,
    h,
  };
}

function moveCropRect(rect, dx, dy, bounds) {
  return {
    x: Math.min(Math.max(0, rect.x + dx), bounds.width - rect.w),
    y: Math.min(Math.max(0, rect.y + dy), bounds.height - rect.h),
    w: rect.w,
    h: rect.h,
  };
}

// The picture that leaves: the untouched original when nothing was changed
// (an unedited photo is not re-encoded twice), otherwise the crop drawn on a
// canvas. Either way it then goes through `compressImage`, so the frame limit
// and the `imageTooBig` refusal are exactly what they were before the sheet.
async function imageSheetResult() {
  const caption = elements.imageSheetCaption.value.trim();
  if (imageSheet.rotation === 0 && imageSheetWhole()) return { file: imageSheet.file, caption };
  const { width, height } = imageSheetSize();
  const { crop } = imageSheet;
  const cropX = Math.round(crop.x * width);
  const cropY = Math.round(crop.y * height);
  const cropWidth = Math.max(1, Math.round(crop.w * width));
  const cropHeight = Math.max(1, Math.round(crop.h * height));
  // `compressImage` scales to this ceiling anyway; doing it here keeps a crop
  // of a 12-megapixel photo from being written out as a full-size PNG first.
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(cropWidth, cropHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cropWidth * scale));
  canvas.height = Math.max(1, Math.round(cropHeight * scale));
  drawImageSheetSource(canvas.getContext('2d'), scale, cropX, cropY);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('image_encode_failed');
  return { file: blob, caption };
}

function sendImageSheet() {
  if (!imageSheet.finish) return;
  // Drawing finishes before the first await; the decoded source can be
  // released when the native close event settles the result below.
  imageSheet.result = imageSheetResult();
  imageSheet.result.catch(() => {});
  elements.imageSheet.close();
}

function bindImageSheet() {
  const dialog = elements.imageSheet;
  if (!dialog) return;
  dialog.addEventListener('close', () => {
    const finish = imageSheet.finish;
    const result = imageSheet.result;
    imageSheet.file = null;
    imageSheet.source = null;
    imageSheet.drag = null;
    elements.imageSheetCanvas.width = 0;
    elements.imageSheetCanvas.height = 0;
    imageSheet.result = null;
    // Native `close` is queued. Resolve only after cleanup, otherwise the
    // next sheet could open before this close event and lose its source.
    finish?.(result);
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendImageSheet();
  });
  elements.imageSheetCaption.addEventListener('input', () => {
    const caption = elements.imageSheetCaption;
    caption.style.height = 'auto';
    caption.style.height = `${caption.scrollHeight + caption.offsetHeight - caption.clientHeight}px`;
  });
  elements.imageSheetSend.addEventListener('click', sendImageSheet);
  elements.imageSheetCancel.addEventListener('click', () => dialog.close());
  elements.imageSheetRotate.addEventListener('click', rotateImageSheet);
  elements.imageSheetReset.addEventListener('click', resetImageSheet);
  elements.imageSheetCropToggle.addEventListener('click', () => {
    imageSheet.cropping = !imageSheet.cropping;
    renderImageSheetCrop();
  });
  for (const chip of elements.imageSheetRatios.querySelectorAll('[data-ratio]')) {
    chip.addEventListener('click', () => setImageCropRatio(chip.dataset.ratio));
  }
  // Opening or closing the ratio row changes the room the picture has.
  new ResizeObserver(() => renderImageSheet()).observe(elements.imageSheetStage);

  const crop = elements.imageSheetCrop;
  crop.addEventListener('pointerdown', (event) => {
    if (!imageSheet.cropping || imageSheet.drag) return;
    event.preventDefault();
    crop.setPointerCapture(event.pointerId);
    const frame = elements.imageSheetFrame.getBoundingClientRect();
    const { x, y, w, h } = imageSheet.crop;
    imageSheet.drag = {
      pointerId: event.pointerId,
      handle: event.target.closest('[data-handle]')?.dataset.handle || '',
      startX: event.clientX,
      startY: event.clientY,
      bounds: { width: frame.width, height: frame.height },
      rect: { x: x * frame.width, y: y * frame.height, w: w * frame.width, h: h * frame.height },
    };
  });
  crop.addEventListener('pointermove', (event) => {
    const drag = imageSheet.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const rect = drag.handle
      ? resizeCropRect(drag.rect, drag.handle, dx, dy, imageSheet.aspect, drag.bounds)
      : moveCropRect(drag.rect, dx, dy, drag.bounds);
    const { width, height } = drag.bounds;
    imageSheet.crop = {
      x: rect.x / width, y: rect.y / height, w: rect.w / width, h: rect.h / height,
    };
    renderImageSheetCrop();
  });
  for (const type of ['pointerup', 'pointercancel']) {
    crop.addEventListener(type, (event) => {
      if (imageSheet.drag?.pointerId === event.pointerId) imageSheet.drag = null;
    });
  }
}

async function handlePastedImage(file, peer = activePeer) {
  if (!peer || !authed) return;
  const thread = threadFor(peer);
  let edited = null;
  try {
    edited = await previewImageBeforeSend(file);
  } catch (err) {
    console.warn('[Tailchat] Failed to open image:', err);
    systemNote(thread, t('imageTooBig'));
    return;
  }
  if (!edited || !authed) return;
  const pending = appendPendingImage(thread, edited.file);
  try {
    const { dataUrl, width, height } = await compressImage(edited.file);
    pending.remove();
    const id = `m-${randomHex(12)}`;
    const ts = Date.now();
    // An empty caption still sends the placeholder: the APK and the terminal
    // show a message's `text`, and the wire format does not change.
    const text = edited.caption || t('pastedImage');
    appendMessage(thread, {
      id,
      own: true,
      kind: 'human',
      author: self.name || self.login,
      text,
      image: { dataUrl, width, height },
      ts,
      queued: Boolean(coreSession),
    });
    scrollToLatest(true);
    // On the core the picture and its caption are one sealed message.
    if (coreSession) {
      if (coreSession.sendWith(peer, id, text, { image: { dataUrl, width, height } })) playSound('sent');
      else failCoreSend(thread, id);
      return;
    }
    playSound('sent');
    sendFrame(peer, { t: 'msg', id, ts, text, image: { dataUrl, width, height } });
  } catch (err) {
    pending.remove();
    console.warn('[Tailchat] Failed to process image:', err);
    systemNote(thread, t('imageTooBig'));
  }
}

function safeAttachmentName(value) {
  const base = String(value || 'file').replace(/\\/g, '/').split('/').pop();
  return (base || 'file').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'file';
}

function attachmentMime(name, hinted = '') {
  if (typeof hinted === 'string' && /^(?:image|audio|video|text|application)\//.test(hinted)) return hinted;
  const ext = safeAttachmentName(name).split('.').pop()?.toLowerCase();
  const known = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
    pdf: 'application/pdf', txt: 'text/plain', json: 'application/json',
  };
  return known[ext] || 'application/octet-stream';
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function rememberAttachmentUrl(blob) {
  const url = URL.createObjectURL(blob);
  attachmentUrls.add(url);
  return url;
}

function releaseAttachmentUrls() {
  closeImageViewer();
  for (const url of attachmentUrls) URL.revokeObjectURL(url);
  attachmentUrls.clear();
}
function resetIncomingTransfers() {
  for (const key of [...incomingTransfers.keys()]) dropIncomingTransfer(key);
  incomingBufferedBytes = 0;
}

// --- Lightbox ----------------------------------------------------------------
//
// Full screen, nothing but the picture: it opens fitted (never blown up past
// 1:1), zooms 1×–8× of that by wheel, pinch or a double click/tap, pans
// within the picture's edges, and pages through the pictures of the open
// conversation in transcript order. The <img> shown is positioned at its
// natural size and moved by one transform, so every gesture is the same three
// numbers: scale and the picture's top-left corner in stage pixels.
const LIGHTBOX_MAX_ZOOM = 8;
const LIGHTBOX_IDLE_MS = 2000;
const LIGHTBOX_TAP_PX = 8;
const LIGHTBOX_DOUBLE_TAP_MS = 300;
const LIGHTBOX_SWIPE_PX = 64;
const lightbox = {
  source: null,
  width: 0,
  height: 0,
  fit: 1,
  scale: 1,
  x: 0,
  y: 0,
  // Follow-the-finger offset of a swipe at fit, before it pages or closes.
  swipeX: 0,
  swipeY: 0,
  pointers: new Map(),
  gesture: null,
  lastTap: null,
  idleTimer: null,
};

// Only rows still on the page: a tombstoned message has already lost its
// picture, and the order is the transcript's own.
function lightboxImages() {
  const thread = activePeer ? threads.get(activePeer) : null;
  // A referenced picture still downloading has no `src` yet: nothing to show.
  return thread ? [...thread.node.querySelectorAll('.row img.msg-image')].filter((img) => img.getAttribute('src')) : [];
}

function openImageViewer(source, name = t('imageTitle')) {
  const dialog = elements.lightbox;
  if (!dialog || !source) return;
  // Keep the src/name entry point for attachment callers as well as the
  // element entry point, which identifies duplicate pictures unambiguously.
  if (typeof source === 'string') {
    const src = source;
    source = lightboxImages().find((img) => img.src === src);
    if (!source) {
      source = new Image();
      source.alt = name;
      source.src = src;
    }
  }
  if (!dialog.open) dialog.showModal();
  // The dialog itself, not ✕, takes the focus: a focused control would keep
  // the controls from ever fading out.
  dialog.focus();
  showLightboxImage(source);
  wakeLightboxControls();
}

function closeImageViewer() {
  if (elements.lightbox?.open) elements.lightbox.close();
}

function lightboxFileName(source) {
  const ts = Number(source.closest('.row')?.dataset.ts) || Date.now();
  const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const subtype = /^data:image\/([a-z0-9.+-]+)/i.exec(source.src)?.[1].toLowerCase() || 'jpeg';
  const ext = subtype === 'jpeg' ? 'jpg' : subtype.replace(/\+.*$/, '');
  return safeAttachmentName(`tailchat-${stamp}.${ext}`);
}

function showLightboxImage(source, list = lightboxImages()) {
  const view = elements.lightboxImage;
  lightbox.source = source;
  lightbox.swipeX = 0;
  lightbox.swipeY = 0;
  const index = list.indexOf(source);
  elements.lightboxCounter.hidden = list.length < 2 || index < 0;
  elements.lightboxCounter.textContent = `${index + 1} / ${list.length}`;
  elements.lightboxSave.href = source.src;
  elements.lightboxSave.download = lightboxFileName(source);
  view.alt = source.alt;
  view.classList.remove('lightbox-image--enter');
  view.classList.add('lightbox-image--loading');
  if (view.src !== source.src) view.src = source.src;
  if (view.complete && view.naturalWidth) fitLightboxImage();
}

function stepImageViewer(delta) {
  const list = lightboxImages();
  const index = list.indexOf(lightbox.source);
  const next = index < 0 ? null : list[index + delta];
  if (!next) return false;
  showLightboxImage(next, list);
  return true;
}

function lightboxStageSize() {
  return {
    width: elements.lightboxStage.clientWidth,
    height: elements.lightboxStage.clientHeight,
  };
}

function lightboxAtFit() {
  return lightbox.scale <= lightbox.fit * 1.001;
}

function lightboxMaxScale() {
  return Math.max(lightbox.fit * LIGHTBOX_MAX_ZOOM, 1);
}

// Smaller than the stage: centred. Larger: no gap may open at either edge.
function clampLightbox() {
  const { width, height } = lightboxStageSize();
  const shownWidth = lightbox.width * lightbox.scale;
  const shownHeight = lightbox.height * lightbox.scale;
  lightbox.x = shownWidth <= width ? (width - shownWidth) / 2 : Math.min(0, Math.max(width - shownWidth, lightbox.x));
  lightbox.y = shownHeight <= height ? (height - shownHeight) / 2 : Math.min(0, Math.max(height - shownHeight, lightbox.y));
}

function paintLightbox() {
  const view = elements.lightboxImage;
  view.style.width = `${lightbox.width}px`;
  view.style.height = `${lightbox.height}px`;
  view.style.transform = `translate(${lightbox.x + lightbox.swipeX}px, ${lightbox.y + lightbox.swipeY}px) scale(${lightbox.scale})`;
  // A swipe down fades the backdrop with the distance, the way it will leave.
  const fade = Math.max(0.3, 1 - Math.max(0, lightbox.swipeY) / 400);
  elements.lightbox.style.setProperty('--lightbox-fade', String(fade));
}

function fitLightboxImage() {
  const view = elements.lightboxImage;
  if (!view.naturalWidth || !view.naturalHeight) return;
  const { width, height } = lightboxStageSize();
  lightbox.width = view.naturalWidth;
  lightbox.height = view.naturalHeight;
  lightbox.fit = Math.min(1, width / lightbox.width, height / lightbox.height);
  lightbox.scale = lightbox.fit;
  clampLightbox();
  paintLightbox();
  if (view.classList.contains('lightbox-image--loading')) {
    view.classList.remove('lightbox-image--loading');
    view.classList.add('lightbox-image--enter');
  }
}

// Zoom about a stage point: the picture pixel under it stays under it.
function zoomLightboxAt(scale, pointX, pointY) {
  const next = Math.min(lightboxMaxScale(), Math.max(lightbox.fit, scale));
  const ratio = next / lightbox.scale;
  lightbox.x = pointX - (pointX - lightbox.x) * ratio;
  lightbox.y = pointY - (pointY - lightbox.y) * ratio;
  lightbox.scale = next;
  clampLightbox();
  paintLightbox();
}

// Gestures paint every frame without a transition; only the discrete jumps
// (double tap, a swipe springing back) animate.
function setLightboxAnimated(animated) {
  elements.lightbox.classList.toggle('lightbox--animate', animated);
}

function toggleLightboxZoom(pointX, pointY) {
  setLightboxAnimated(true);
  if (!lightboxAtFit()) {
    lightbox.scale = lightbox.fit;
    clampLightbox();
    paintLightbox();
    return;
  }
  // fit ↔ 1:1, or fit ↔ 2× when the picture already fits at 1:1.
  zoomLightboxAt(lightbox.fit < 1 ? 1 : lightbox.fit * 2, pointX, pointY);
}

function lightboxHitsImage(pointX, pointY) {
  return pointX >= lightbox.x && pointX <= lightbox.x + lightbox.width * lightbox.scale
    && pointY >= lightbox.y && pointY <= lightbox.y + lightbox.height * lightbox.scale;
}

function wakeLightboxControls() {
  const dialog = elements.lightbox;
  dialog.classList.remove('lightbox--idle');
  clearTimeout(lightbox.idleTimer);
  lightbox.idleTimer = setTimeout(() => dialog.classList.add('lightbox--idle'), LIGHTBOX_IDLE_MS);
}

function lightboxTap(pointX, pointY) {
  const now = performance.now();
  const last = lightbox.lastTap;
  if (last && now - last.time < LIGHTBOX_DOUBLE_TAP_MS
      && Math.hypot(pointX - last.x, pointY - last.y) < LIGHTBOX_TAP_PX * 4) {
    lightbox.lastTap = null;
    if (lightboxHitsImage(pointX, pointY)) toggleLightboxZoom(pointX, pointY);
    return;
  }
  lightbox.lastTap = { time: now, x: pointX, y: pointY };
  if (lightboxAtFit() && !lightboxHitsImage(pointX, pointY)) {
    closeImageViewer();
    return;
  }
  wakeLightboxControls();
}

function lightboxPoint(event) {
  const box = elements.lightboxStage.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
}

function startLightboxPinch() {
  const [a, b] = [...lightbox.pointers.values()];
  lightbox.swipeX = 0;
  lightbox.swipeY = 0;
  lightbox.gesture = {
    kind: 'pinch',
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    scale: lightbox.scale,
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    originX: lightbox.x,
    originY: lightbox.y,
  };
}

function startLightboxPress(point, pointerType) {
  lightbox.gesture = {
    kind: 'press',
    pointerType,
    startX: point.x,
    startY: point.y,
    originX: lightbox.x,
    originY: lightbox.y,
  };
}

function finishLightboxSwipe(gesture) {
  const { swipeX, swipeY } = lightbox;
  if (gesture.axis === 'x' && Math.abs(swipeX) > LIGHTBOX_SWIPE_PX && stepImageViewer(swipeX < 0 ? 1 : -1)) return;
  if (gesture.axis === 'y' && swipeY > LIGHTBOX_SWIPE_PX) {
    closeImageViewer();
    return;
  }
  setLightboxAnimated(true);
  lightbox.swipeX = 0;
  lightbox.swipeY = 0;
  paintLightbox();
}

// The pill overlays arbitrary photo pixels. Choose the opposite-luminance
// contour from the resolved --signal, rather than changing the receipt colour
// or assuming that a light theme necessarily has a dark accent.
function refreshImageReceiptContour() {
  const root = document.documentElement;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(root).getPropertyValue('--signal').trim();
  ctx.fillRect(0, 0, 1, 1);
  const channels = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  root.style.setProperty('--image-read-outline', blackContrast >= whiteContrast ? '#000' : '#fff');
}

function bindImageLightbox() {
  const dialog = elements.lightbox;
  const stage = elements.lightboxStage;
  if (!dialog || !stage) return;
  refreshImageReceiptContour();
  new MutationObserver(refreshImageReceiptContour).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme', 'data-mode'],
  });
  dialog.addEventListener('focusin', wakeLightboxControls);
  elements.lightboxImage.addEventListener('load', fitLightboxImage);
  elements.lightboxClose.addEventListener('click', closeImageViewer);
  // Nothing outlives the dialog: the last picture's (possibly `blob:`) URL is
  // let go, so `releaseAttachmentUrls` on logout leaves no live reference.
  dialog.addEventListener('close', () => {
    clearTimeout(lightbox.idleTimer);
    lightbox.source = null;
    lightbox.gesture = null;
    lightbox.lastTap = null;
    lightbox.pointers.clear();
    elements.lightboxImage.removeAttribute('src');
    elements.lightboxSave.removeAttribute('href');
    dialog.classList.remove('lightbox--idle', 'lightbox--animate');
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setLightboxAnimated(false);
      stepImageViewer(event.key === 'ArrowRight' ? 1 : -1);
    }
    wakeLightboxControls();
  });
  window.addEventListener('resize', () => {
    if (!dialog.open || !lightbox.width) return;
    const wasFit = lightboxAtFit();
    const { width, height } = lightboxStageSize();
    lightbox.fit = Math.min(1, width / lightbox.width, height / lightbox.height);
    if (wasFit) lightbox.scale = lightbox.fit;
    lightbox.scale = Math.min(lightboxMaxScale(), Math.max(lightbox.fit, lightbox.scale));
    clampLightbox();
    paintLightbox();
  });
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!lightbox.width) return;
    setLightboxAnimated(false);
    const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? lightboxStageSize().height : 1);
    // A trackpad pinch arrives as a ctrl-wheel of small deltas, and needs the
    // steeper curve to keep up with the fingers.
    const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.002));
    const point = lightboxPoint(event);
    zoomLightboxAt(lightbox.scale * factor, point.x, point.y);
    wakeLightboxControls();
  }, { passive: false });
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    const point = lightboxPoint(event);
    lightbox.pointers.set(event.pointerId, point);
    setLightboxAnimated(false);
    if (lightbox.pointers.size === 1) startLightboxPress(point, event.pointerType);
    else if (lightbox.pointers.size === 2) startLightboxPinch();
  });
  stage.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') wakeLightboxControls();
    if (!lightbox.pointers.has(event.pointerId)) return;
    const point = lightboxPoint(event);
    lightbox.pointers.set(event.pointerId, point);
    const gesture = lightbox.gesture;
    if (!gesture || !lightbox.width) return;
    if (gesture.kind === 'pinch') {
      if (lightbox.pointers.size < 2) return;
      const [a, b] = [...lightbox.pointers.values()];
      const next = Math.min(lightboxMaxScale(), Math.max(lightbox.fit,
        gesture.scale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance)));
      const ratio = next / gesture.scale;
      // The picture point that was under the fingers' midpoint follows it.
      lightbox.x = (a.x + b.x) / 2 - (gesture.midX - gesture.originX) * ratio;
      lightbox.y = (a.y + b.y) / 2 - (gesture.midY - gesture.originY) * ratio;
      lightbox.scale = next;
      clampLightbox();
      paintLightbox();
      return;
    }
    const dx = point.x - gesture.startX;
    const dy = point.y - gesture.startY;
    if (gesture.kind === 'press') {
      if (Math.hypot(dx, dy) < LIGHTBOX_TAP_PX) return;
      // At fit a finger swipes (pages or closes); a mouse has the keys and ✕.
      if (!lightboxAtFit()) gesture.kind = 'pan';
      else if (gesture.pointerType !== 'mouse') {
        gesture.kind = 'swipe';
        gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      } else gesture.kind = 'idle';
    }
    if (gesture.kind === 'pan') {
      lightbox.x = gesture.originX + dx;
      lightbox.y = gesture.originY + dy;
      clampLightbox();
      paintLightbox();
    } else if (gesture.kind === 'swipe') {
      lightbox.swipeX = gesture.axis === 'x' ? dx : 0;
      lightbox.swipeY = gesture.axis === 'y' ? Math.max(0, dy) : 0;
      paintLightbox();
    }
  });
  const release = (event) => {
    if (!lightbox.pointers.has(event.pointerId)) return;
    const point = lightbox.pointers.get(event.pointerId);
    lightbox.pointers.delete(event.pointerId);
    const gesture = lightbox.gesture;
    lightbox.gesture = null;
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      // One finger lifted: the other one carries on as a pan.
      const [rest] = [...lightbox.pointers.values()];
      if (rest) {
        startLightboxPress(rest, 'touch');
        lightbox.gesture.kind = lightboxAtFit() ? 'idle' : 'pan';
      }
      return;
    }
    if (gesture.kind === 'press' && event.type === 'pointerup') lightboxTap(point.x, point.y);
    else if (gesture.kind === 'swipe') finishLightboxSwipe(gesture);
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
}

// A desktop-sized preview, constrained further by the transcript's gutters.
const IMAGE_PREVIEW_MAX_PX = 480;

function sizeImagePreview(img, width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const scale = Math.min(1, IMAGE_PREVIEW_MAX_PX / Math.max(width, height));
  // Computed here, never read back from `img.width`: on an attached image that
  // getter is the used layout width, and a narrow column at load time would
  // pin the bubble to it after the column widens again.
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  img.width = w;
  img.height = h;
  img.dataset.previewWidth = String(w);
  img.closest('.bubble')?.style.setProperty('--image-w', `${w}px`);
}

// --- Вложения по ссылке ---------------------------------------------------
//
// A server that understands `media=ref` / `media-ref-v1` hands a picture or a
// voice note as `{mime, size, width, height}` / `{mime, size, duration}` and
// serves the bytes from `/api/media` (docs/specs/2026-11-03-history-media-refs.md).
// The renderers keep taking a `dataUrl`-or-`url` object; a reference becomes
// such an object with `mediaRef` beside it, and the bytes arrive as a `blob:`
// URL. An older server still sends inline bytes, and those keep working.
const MEDIA_REF_CAP = 'media-ref-v1';
const MEDIA_FETCH_LIMIT = 4;
// A watchdog on progress, not a deadline on the whole: a 7 MiB voice note on a
// slow phone link may take a minute, and that is fine as long as bytes move.
const MEDIA_STALL_MS = 30_000;
const mediaDownloads = new Map();
const mediaQueue = [];
let mediaRunning = 0;

function isMediaRef(media) {
  return Boolean(media) && typeof media === 'object' && !media.dataUrl && Number.isFinite(media.size) && media.size > 0;
}

/** `media` ready for the renderers: inline as it is, a reference with its address, or null. */
function mediaSource(peer, id, media, slot) {
  if (!media || typeof media !== 'object') return null;
  if (typeof media.dataUrl === 'string' && media.dataUrl !== '') return media;
  if (isMediaRef(media) && typeof id === 'string' && id !== '' && peer) {
    return { ...media, mediaRef: { peer, id, slot } };
  }
  return null;
}

function hasPicture(image) {
  return Boolean(image?.dataUrl || image?.url || image?.mediaRef);
}

function pumpMediaQueue() {
  while (mediaRunning < MEDIA_FETCH_LIMIT && mediaQueue.length > 0) {
    const job = mediaQueue.shift();
    mediaRunning += 1;
    job().finally(() => {
      mediaRunning -= 1;
      pumpMediaQueue();
    });
  }
}

async function downloadMedia({ peer, id, slot }) {
  const controller = new AbortController();
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), MEDIA_STALL_MS);
  };
  arm();
  try {
    const query = new URLSearchParams({ peer, id, slot });
    let response;
    try {
      response = await fetch(`${API}/media?${query.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
        // The server already says `no-store`; this keeps the browser's own
        // cache out of it too, so decrypted bytes never settle on disk.
        cache: 'no-store',
      });
    } catch {
      throw { code: 'network' };
    }
    if (!response.ok) throw { code: response.status === 410 ? 'gone' : 'failed', status: response.status };
    const type = response.headers.get('content-type') || '';
    const chunks = [];
    const reader = response.body?.getReader?.();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        arm();
      }
    } else {
      chunks.push(await response.arrayBuffer());
    }
    const blob = new Blob(chunks, { type });
    return { blob, url: URL.createObjectURL(blob) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bytes behind a reference, as `{blob, url}`. One download per attachment
 * however many places ask, at most four at a time; a failure is forgotten so
 * the next ask tries again, a 410 (deleted, evicted) is remembered.
 */
function fetchMedia(ref) {
  const key = `${ref.peer}\n${ref.id}\n${ref.slot}`;
  let pending = mediaDownloads.get(key);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      mediaQueue.push(() => downloadMedia(ref).then(resolve, reject));
      pumpMediaQueue();
    });
    mediaDownloads.set(key, pending);
    pending.catch((error) => {
      if (error?.code !== 'gone') mediaDownloads.delete(key);
    });
  }
  return pending;
}

// A tombstoned message gives its bytes back.
function forgetMedia(peer, id) {
  for (const slot of ['image', 'voice']) {
    const key = `${peer}\n${id}\n${slot}`;
    const pending = mediaDownloads.get(key);
    if (!pending) continue;
    mediaDownloads.delete(key);
    pending.then(({ url }) => URL.revokeObjectURL(url), () => {});
  }
}

/** A `data:` URL for an attachment, inline or referenced — what a forwarded frame carries. */
async function attachmentDataUrl(media) {
  if (media?.dataUrl) return media.dataUrl;
  if (!media?.mediaRef) return null;
  const { blob } = await fetchMedia(media.mediaRef);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function buildImagePreview(image, name = t('imageTitle')) {
  const frame = document.createElement('div');
  frame.className = 'msg-image-frame';
  const button = document.createElement('button');
  button.className = 'msg-image-wrap';
  button.type = 'button';
  button.title = t('imageOpen');
  button.setAttribute('aria-label', t('imageOpen'));
  const img = document.createElement('img');
  img.className = 'msg-image';
  img.alt = name;
  // A held mouse press on the picture selects the message like on any bubble;
  // the browser's own image drag would steal that gesture.
  img.draggable = false;
  sizeImagePreview(img, image.width, image.height);
  // Wire dimensions reserve space before decoding; the real dimensions win
  // after load, so even a small original with stale metadata is never enlarged.
  img.addEventListener('load', () => sizeImagePreview(img, img.naturalWidth, img.naturalHeight));
  // A reference draws the reserved box first and fills it when the bytes are
  // here; a failure says so on the box, and the next click tries again.
  const state = (name, label) => {
    frame.dataset.media = name;
    frame.dataset.label = label;
    button.title = label;
  };
  const load = () => {
    state('loading', t('mediaLoading'));
    fetchMedia(image.mediaRef).then(({ url }) => {
      image.url = url;
      img.src = url;
      delete frame.dataset.media;
      delete frame.dataset.label;
      button.title = t('imageOpen');
    }, (error) => {
      if (error?.code === 'gone') state('gone', t('mediaExpired'));
      else state('failed', t('mediaFailed'));
    });
  };
  if (image.dataUrl || image.url) img.src = image.dataUrl || image.url;
  else if (image.mediaRef) load();
  button.append(img);
  button.addEventListener('click', () => {
    // The click that ends a held selection gesture, and clicks during
    // selection, belong to the selection — the row handler skips buttons.
    if (dragJustEnded) return;
    const row = button.closest('.row');
    if (selectionMode) {
      if (row?.dataset.id && row.dataset.deleted !== 'true') toggleRowSelection(row.dataset.id);
      return;
    }
    if (frame.dataset.media === 'failed') {
      load();
      return;
    }
    if (frame.dataset.media) return;
    openImageViewer(img);
  });
  frame.append(button);
  return frame;
}

// Every locale's placeholder: a picture sent without a caption carries
// whichever one the sender's client was set to, and none of them is a caption.
const PASTED_IMAGE_TEXTS = new Set(Object.values(I18N).map((dict) => dict.pastedImage));

function isImageCaption(text) {
  const trimmed = String(text || '').trim();
  return trimmed !== '' && !PASTED_IMAGE_TEXTS.has(trimmed);
}

// A picture without a caption is drawn without a bubble: the picture is the
// message, its time and mark sit on a pill over its corner. A captioned one
// is the picture on top of a bubble exactly as wide, with the caption and the
// time inside. Run on render and again on every edit of the text, since an
// edit can add or drop the caption.
function layoutImageMessage(row, text) {
  const bubble = row.querySelector('.bubble');
  const content = bubble.querySelector('.bubble-content');
  const frame = content.querySelector(':scope > .msg-image-frame');
  const meta = row.querySelector('.bubble-meta');
  if (!frame || !meta) return;
  const img = frame.querySelector('.msg-image');
  const presetWidth = Number(img.dataset.previewWidth);
  if (presetWidth > 0) bubble.style.setProperty('--image-w', `${presetWidth}px`);
  let textEl = content.querySelector(':scope > .bubble-text');
  if (!isImageCaption(text)) {
    row.dataset.image = 'bare';
    textEl?.remove();
    frame.append(meta);
    layoutMessageMeta(row);
    return;
  }
  row.dataset.image = 'captioned';
  if (!textEl) {
    textEl = document.createElement('p');
    textEl.className = 'bubble-text';
  }
  textEl.replaceChildren();
  renderMessageBody(textEl, text);
  frame.after(textEl);
  // Last in the content, after a link preview card if the caption has one.
  content.append(meta);
  layoutMessageMeta(row);
}

function buildFileCard(attachment) {
  const card = document.createElement('div');
  card.className = 'file-card';
  const mime = attachmentMime(attachment.name, attachment.mime);

  if (mime.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.className = 'file-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = attachment.url;
    card.append(audio);
  }

  const link = document.createElement('a');
  link.className = 'file-open-link';
  link.href = attachment.url;
  link.target = '_blank';
  link.rel = 'noopener';

  const type = document.createElement('span');
  type.className = 'file-type';
  type.textContent = mime.startsWith('audio/') ? 'AUDIO' : 'FILE';
  const copy = document.createElement('span');
  copy.className = 'file-copy';
  const name = document.createElement('strong');
  name.textContent = attachment.name;
  const size = document.createElement('small');
  size.textContent = `${formatFileSize(attachment.size)} · ${t('fileOpen')}`;
  copy.append(name, size);
  link.append(type, copy);
  card.append(link);
  return card;
}

function transferKey(from, id) {
  return `${from}\u0000${id}`;
}

function dropIncomingTransfer(key) {
  const transfer = incomingTransfers.get(key);
  if (!transfer) return null;
  incomingTransfers.delete(key);
  incomingBufferedBytes = Math.max(0, incomingBufferedBytes - transfer.size);
  transfer.note?.remove();
  return transfer;
}

function refuseIncomingTransfer(from, frame, name) {
  if (typeof frame.id === 'string') {
    sendFrame(from, { t: 'file-deny', id: frame.id, reason: 'refused' });
  }
  const thread = threadFor(from);
  systemNote(thread, t('fileFailed', name));
}

function receiveFileOffer(from, frame) {
  const id = typeof frame.id === 'string' ? frame.id : '';
  const name = safeAttachmentName(frame.name);
  const size = Number(frame.size);
  if (!id || !Number.isInteger(size) || size < 0 || size > FILE_MAX_BYTES
    || incomingTransfers.size >= FILE_MAX_TRANSFERS
    || incomingBufferedBytes + size > FILE_MAX_BUFFERED_BYTES) {
    refuseIncomingTransfer(from, frame, name);
    return;
  }

  const key = transferKey(from, id);
  dropIncomingTransfer(key);
  const thread = threadFor(from);
  const note = document.createElement('p');
  note.className = 'system-note transfer-note';
  note.textContent = t('fileReceiving', name, 0);
  thread.node.append(note);
  incomingTransfers.set(key, {
    from,
    id,
    name,
    size,
    sha256: typeof frame.sha256 === 'string' ? frame.sha256.toLowerCase() : '',
    mime: attachmentMime(name),
    chunks: [],
    nextSeq: 0,
    received: 0,
    note,
  });
  incomingBufferedBytes += size;
  if (from === activePeer) scrollToLatest();
}

function receiveFileChunk(from, frame) {
  const key = transferKey(from, frame.id);
  const transfer = incomingTransfers.get(key);
  if (!transfer || frame.seq !== transfer.nextSeq || typeof frame.data !== 'string') {
    if (transfer) refuseIncomingTransfer(from, frame, transfer.name);
    dropIncomingTransfer(key);
    return;
  }
  let bytes;
  try {
    const binary = atob(frame.data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    refuseIncomingTransfer(from, frame, transfer.name);
    dropIncomingTransfer(key);
    return;
  }
  if (transfer.received + bytes.length > transfer.size) {
    refuseIncomingTransfer(from, frame, transfer.name);
    dropIncomingTransfer(key);
    return;
  }
  transfer.chunks.push(bytes);
  transfer.received += bytes.length;
  transfer.nextSeq += 1;
  const percent = transfer.size === 0 ? 100 : Math.min(100, Math.round((transfer.received / transfer.size) * 100));
  transfer.note.textContent = t('fileReceiving', transfer.name, percent);
}

async function receiveFileDone(from, frame) {
  const key = transferKey(from, frame.id);
  const transfer = dropIncomingTransfer(key);
  if (!transfer || transfer.received !== transfer.size) {
    if (transfer) refuseIncomingTransfer(from, frame, transfer.name);
    return;
  }
  const blob = new Blob(transfer.chunks, { type: transfer.mime });
  if (/^[0-9a-f]{64}$/.test(transfer.sha256) && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== transfer.sha256) {
      refuseIncomingTransfer(from, frame, transfer.name);
      return;
    }
  }
  const url = rememberAttachmentUrl(blob);
  const thread = threadFor(from);
  appendMessage(thread, {
    id: `file-${from}-${transfer.id}`,
    own: false,
    kind: 'human',
    author: displayName(from),
    text: '',
    attachment: { url, name: transfer.name, mime: transfer.mime, size: transfer.size },
    ts: Date.now(),
  });
  notifyReceivedSound(from);
  if (from === activePeer) scrollToLatest();
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function waitForSocketDrain() {
  while (socket && socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 512 * 1024) {
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

async function sendBrowserFile(file, peer) {
  const thread = threadFor(peer);
  if (file.type.startsWith('image/')) {
    await handlePastedImage(file, peer);
    return;
  }
  if (file.size > FILE_MAX_BYTES) {
    systemNote(thread, t('fileTooLarge'));
    return;
  }
  // An audio file rides the same inline `voice` payload a recording does, so
  // it arrives as a real player in every client, survives a reload (the
  // chunked file protocol is never written to history) and reaches a peer who
  // is offline right now. Anything too big for one frame falls back to chunks.
  if (file.type.startsWith('audio/') && file.size <= (CLOUD_INLINE_MEDIA_SAFE_CHARS / 4) * 3) {
    const sent = await sendAudioFileInline(file, peer);
    if (sent) return;
  }
  // Only the chunked transfer below needs a live peer: chunks are not queued
  // for someone who is not there to reassemble them.
  const user = users.find((item) => item.login === peer);
  if (!user?.online) {
    systemNote(thread, t('fileNeedsOnline'));
    return;
  }

  const name = safeAttachmentName(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const id = `f-${randomHex(12)}`;
  if (!sendFrame(peer, { t: 'file-offer', id, name, size: bytes.length, sha256 })) return;

  sendingFileLabel = name;
  renderTypingIndicator();
  for (let offset = 0, seq = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES, seq += 1) {
    if (!await waitForSocketDrain()) return;
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + FILE_CHUNK_BYTES));
    if (!sendFrame(peer, { t: 'file-chunk', id, seq, data: bytesToBase64(chunk) })) return;
  }
  if (!sendFrame(peer, { t: 'file-done', id })) return;
  sendingFileLabel = null;
  renderTypingIndicator();

  const url = rememberAttachmentUrl(file);
  appendMessage(thread, {
    id: `file-self-${id}`,
    own: true,
    kind: 'human',
    author: self.name,
    text: '',
    attachment: { url, name, mime: attachmentMime(name, file.type), size: bytes.length },
    ts: Date.now(),
    // The frames left this tab, which is ✓ and no more: whether the peer's
    // device has the file is theirs to say (an `ack`), not this echo's.
  });
  systemNote(thread, t('fileSent', name));
  scrollToLatest(true);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(String(event.target.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Duration is asked of the browser rather than parsed: every container the
// `<audio>` element will later play, it can also measure.
function probeAudioDuration(dataUrl) {
  return new Promise((resolve) => {
    const probe = new Audio();
    probe.preload = 'metadata';
    const done = (value) => resolve(Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
    probe.addEventListener('loadedmetadata', () => done(probe.duration));
    probe.addEventListener('error', () => done(0));
    probe.src = dataUrl;
  });
}

async function sendAudioFileInline(file, peer) {
  const dataUrl = await readAsDataUrl(file);
  if (!dataUrl.startsWith('data:audio/') || dataUrl.length > CLOUD_INLINE_MEDIA_SAFE_CHARS) return false;
  const duration = await probeAudioDuration(dataUrl);
  sendVoiceMessage(dataUrl, duration, peer);
  return true;
}

function queueBrowserFiles(files) {
  const peer = activePeer;
  for (const file of files) {
    outgoingTransfers = outgoingTransfers
      .then(() => sendBrowserFile(file, peer))
      .catch(() => {
        const thread = threads.get(peer);
        if (thread) systemNote(thread, t('fileFailed', safeAttachmentName(file.name)));
      })
      .finally(() => {
        sendingFileLabel = null;
        renderTypingIndicator();
      });
  }
}

function exportHistory() {
  if (!activePeer) return;
  const thread = threads.get(activePeer);
  if (!thread) return;

  const rows = thread.node.querySelectorAll('.row');
  let output = `Tailchat Transcript — @${activePeer}\nExported: ${new Date().toISOString()}\n${'═'.repeat(60)}\n\n`;

  rows.forEach((row) => {
    const author = `{${row.dataset.author || ''}}`;
    const time = row.querySelector('.bubble-meta > .bubble-time')?.textContent || '';
    // An image-only row draws no `.bubble-text`; its placeholder text is still
    // what the frame said, so the export keeps writing it.
    const text = emojiPlainText(row.querySelector('.bubble-text')) ?? row.messageText ?? '';
    output += `[${time}] <${author}> ${text}\n`;
  });

  const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tailchat-${activePeer}-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
  systemNote(thread, t('historyExported'));
}

// --- Matrix Screensaver ---------------------------------------------------

let screensaverActive = false;
let screensaverAnimId = null;

function startScreensaver() {
  const canvas = elements.screensaverCanvas;
  if (!canvas) return;
  canvas.hidden = false;
  screensaverActive = true;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const chars = '0123456789ABCDEFТАЙЛЧАТTAILCHATアイウエオカキクケコサシスセソ';
  const fontSize = 14;
  const columns = Math.floor(canvas.width / fontSize);
  const drops = Array.from({ length: columns }, () => Math.floor(Math.random() * -50));

  const themeColor = currentTheme === 'amber' ? '#ffaa00'
                   : currentTheme === 'blue' ? '#38a5ff'
                   : currentTheme === 'mono' ? '#ffffff'
                   : '#00ff66';

  function draw() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = themeColor;
    ctx.font = `${fontSize}px monospace`;

    for (let i = 0; i < drops.length; i++) {
      const text = chars[Math.floor(Math.random() * chars.length)];
      ctx.fillText(text, i * fontSize, drops[i] * fontSize);
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
    screensaverAnimId = requestAnimationFrame(draw);
  }
  draw();

  const stop = () => {
    if (!screensaverActive) return;
    screensaverActive = false;
    cancelAnimationFrame(screensaverAnimId);
    canvas.hidden = true;
    window.removeEventListener('keydown', stop);
    window.removeEventListener('click', stop);
    window.removeEventListener('touchstart', stop);
  };
  setTimeout(() => {
    window.addEventListener('keydown', stop, { once: true });
    window.addEventListener('click', stop, { once: true });
    window.addEventListener('touchstart', stop, { once: true });
  }, 100);
}

// --- Голосовые сообщения --------------------------------------------------
//
// Захват держится в одном месте: `voiceCapture` — либо null, либо активная
// запись. Блоб отдаётся промисом из onstop, поэтому «Отмена» не может
// проскочить в отправку — раньше stop() досылал последний чанк и сообщение
// уходило вопреки отмене.

const VOICE_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

let voiceCapture = null;
// Identifies the current microphone request, so a permission prompt that
// resolves after the reader gave up does not start a recording nobody wanted.
let voiceRequestSeq = 0;

function pickVoiceMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return VOICE_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function formatClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function buildVoiceMeter() {
  const meter = elements.voiceMeter;
  if (!meter || meter.childElementCount === VOICE_METER_BARS) return;
  meter.replaceChildren(...Array.from({ length: VOICE_METER_BARS }, () => document.createElement('span')));
}

function paintVoiceMeter(level) {
  const meter = elements.voiceMeter;
  if (!meter) return;
  const bars = meter.children;
  const lit = Math.round(level * bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    // Полосы читаются как индикатор уровня: залитые — до текущего RMS.
    bar.style.height = `${i < lit ? 4 + Math.round((i / bars.length) * 14) : 2}px`;
    bar.dataset.hot = i < lit && i >= bars.length - 3 ? 'yes' : 'no';
  }
}

// A recording that never started needs saying where the eye already is: the
// person pressed record and is looking at the bar, not at the transcript. So
// the bar stays up for a moment carrying the reason, then closes itself. The
// transcript note is written too — that is the durable record — but it is not
// what makes the failure noticed.
let voiceProblemTimer = null;

function voiceProblem(peer, message) {
  const thread = threads.get(peer);
  if (thread) systemNote(thread, message);
  if (!elements.voiceBar || voiceCapture) return;
  elements.voiceBar.hidden = false;
  setVoiceBarState('error');
  if (elements.voiceRecState) elements.voiceRecState.textContent = message;
  clearTimeout(voiceProblemTimer);
  voiceProblemTimer = setTimeout(() => {
    voiceProblemTimer = null;
    // Unless a new recording has since started in the meantime.
    if (!voiceCapture) closeVoiceBar();
  }, VOICE_PROBLEM_MS);
}

function setVoiceBarState(state) {
  if (!elements.voiceBar) return;
  elements.voiceBar.dataset.state = state;
  if (!elements.voiceRecState) return;
  // `error` carries its own sentence, written by whoever set the state.
  if (state === 'error') return;
  if (state === 'asking') {
    elements.voiceRecState.textContent = t('voiceAsking');
    return;
  }
  elements.voiceRecState.textContent = state === 'capped' ? t('voiceCapped') : t('voiceRecording');
}

function updateVoiceTimer() {
  if (!elements.voiceRecTimer || !voiceCapture) return;
  elements.voiceRecTimer.textContent = `${formatClock(voiceCapture.seconds)} / ${formatClock(VOICE_MAX_SEC)}`;
}

function openVoiceBar() {
  buildVoiceMeter();
  paintVoiceMeter(0);
  setVoiceBarState('recording');
  if (elements.voiceBar) elements.voiceBar.hidden = false;
  if (elements.composerContainer) elements.composerContainer.dataset.recording = 'yes';
  if (elements.composer) elements.composer.hidden = true;
  closeEmojiPicker();
  if (elements.voiceButton) elements.voiceButton.disabled = true;
}

function closeVoiceBar() {
  if (elements.voiceBar) elements.voiceBar.hidden = true;
  if (elements.composerContainer) delete elements.composerContainer.dataset.recording;
  if (elements.composer) elements.composer.hidden = false;
  if (elements.voiceButton) elements.voiceButton.disabled = !activePeer || isBlockedPeer(activePeer);
  setVoiceBarState('idle');
  if (wide.matches && activePeer) elements.input.focus();
}

async function startVoiceRecording() {
  if (voiceCapture || !activePeer) return;

  // The bar opens *before* the microphone is asked for, not after. Acquiring a
  // device takes anything from a moment to however long somebody stares at a
  // permission prompt, and the button used to sit there doing nothing for all
  // of it — pressing record and seeing no response at all is indistinguishable
  // from a broken app, and the second press is what people try next.
  const peer = activePeer;
  // A permission prompt can sit there for as long as somebody ignores it, and
  // Cancel has to mean cancelled even though the promise underneath cannot be
  // withdrawn. Every request carries a number; the continuation below drops the
  // stream on the floor if that number has moved on.
  const request = ++voiceRequestSeq;
  openVoiceBar();
  setVoiceBarState('asking');

  let stream;
  try {
    // Present only in a secure context. On plain http over a LAN address the
    // whole API is missing, which is worth saying out loud: it is a different
    // problem from a refused permission and has a different fix.
    if (!navigator.mediaDevices?.getUserMedia) {
      voiceProblem(peer, window.isSecureContext ? t('voiceNoDevice') : t('voiceInsecure'));
      return;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      // Automatic gain is what makes a laptop's far-off built-in microphone
      // audible at all. Without it, noise suppression happily takes a quiet
      // voice down to nothing and the note arrives technically recorded and
      // practically silent.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    // `NotFoundError` is no microphone at all; everything else that lands here
    // in practice is a refusal. Naming the two apart is the difference between
    // "plug something in" and "change a browser setting".
    voiceProblem(peer, error?.name === 'NotFoundError' ? t('voiceNoDevice') : t('voiceMicDenied'));
    return;
  }

  // Cancelled, switched away, or superseded while the prompt was up: the stream
  // is not wanted and must not be left holding the microphone open.
  if (request !== voiceRequestSeq || activePeer !== peer || voiceCapture) {
    stream.getTracks().forEach((track) => track.stop());
    closeVoiceBar();
    return;
  }

  const mimeType = pickVoiceMime();
  let recorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SEC })
      : new MediaRecorder(stream, { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SEC });
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    voiceProblem(peer, t('voiceNoRecorder'));
    return;
  }

  const chunks = [];
  let settle = () => {};
  const capture = {
    stream,
    recorder,
    chunks,
    seconds: 0,
    canceled: false,
    blob: null,
    peer: activePeer,
    tick: null,
    meterFrame: null,
    analyser: null,
    source: null,
    settled: new Promise((resolve) => { settle = resolve; }),
  };
  voiceCapture = capture;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    stopVoiceMeter(capture);
    stream.getTracks().forEach((track) => track.stop());
    capture.blob = chunks.length > 0
      ? new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
      : null;
    settle(capture.canceled ? null : capture.blob);
  };

  recorder.start(250);
  startVoiceMeter(capture);
  setVoiceBarState('recording');
  updateVoiceTimer();

  capture.tick = setInterval(() => {
    capture.seconds += 1;
    updateVoiceTimer();
    if (capture.seconds >= VOICE_MAX_SEC) capVoiceRecording();
  }, 1000);
}

function startVoiceMeter(capture) {
  try {
    initAudio();
    if (!audioCtx) return;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    const source = audioCtx.createMediaStreamSource(capture.stream);
    source.connect(analyser);
    capture.analyser = analyser;
    capture.source = source;

    const samples = new Uint8Array(analyser.fftSize);
    const draw = () => {
      if (voiceCapture !== capture) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const deviation = (samples[i] - 128) / 128;
        sum += deviation * deviation;
      }
      const rms = Math.sqrt(sum / samples.length);
      // Линейный RMS почти не двигает шкалу: речь живёт в 0.02–0.2,
      // поэтому уровень раскрывается корневой кривой.
      paintVoiceMeter(Math.min(1, Math.sqrt(rms) * 2.2));
      capture.meterFrame = requestAnimationFrame(draw);
    };
    capture.meterFrame = requestAnimationFrame(draw);
  } catch {
    // Метр — украшение поверх записи: без него запись всё равно идёт.
  }
}

function stopVoiceMeter(capture) {
  if (capture.meterFrame !== null) cancelAnimationFrame(capture.meterFrame);
  capture.meterFrame = null;
  try {
    capture.source?.disconnect();
    capture.analyser?.disconnect();
  } catch {}
  capture.source = null;
  capture.analyser = null;
}

// Предел длительности: захват останавливается, но запись остаётся на месте —
// пользователь сам решает, отправить её или выбросить.
function capVoiceRecording() {
  const capture = voiceCapture;
  if (!capture) return;
  clearInterval(capture.tick);
  capture.tick = null;
  if (capture.recorder.state !== 'inactive') capture.recorder.stop();
  setVoiceBarState('capped');
  paintVoiceMeter(0);
  const thread = threads.get(capture.peer);
  if (thread) systemNote(thread, t('voiceCappedNote', formatClock(VOICE_MAX_SEC)));
}

function cancelVoiceRecording() {
  const capture = voiceCapture;
  // The bar is up before the capture exists — while the microphone is being
  // asked for — and Cancel is the only control offered there. Without this it
  // was a button that did nothing, on the one screen somebody presses it
  // because nothing is happening.
  if (!capture) {
    voiceRequestSeq += 1;
    clearTimeout(voiceProblemTimer);
    voiceProblemTimer = null;
    closeVoiceBar();
    return;
  }
  capture.canceled = true;
  clearInterval(capture.tick);
  capture.tick = null;
  if (capture.recorder.state !== 'inactive') capture.recorder.stop();
  voiceCapture = null;
  closeVoiceBar();
}

// Decodes the recording and looks for any sample above the noise floor.
// Failure to decode is not silence — some containers this browser can record
// it cannot decode — so anything that goes wrong answers "not silent" and
// leaves the sender alone.
async function recordingIsSilent(blob) {
  // Reuses the app's own context when there is one; decoding needs no running
  // context, so a suspended one does just as well. A context opened only for
  // this is closed again — one per recording would otherwise accumulate for
  // the life of the tab.
  const borrowed = audioCtx;
  let ctx = borrowed;
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const samples = decoded.getChannelData(channel);
      for (let i = 0; i < samples.length; i += 1) {
        if (Math.abs(samples[i]) > VOICE_SILENCE_FLOOR) return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (ctx && ctx !== borrowed) ctx.close().catch(() => {});
  }
}

async function stopVoiceRecordingAndSend() {
  const capture = voiceCapture;
  if (!capture) return;
  clearInterval(capture.tick);
  capture.tick = null;
  if (elements.voiceSendBtn) elements.voiceSendBtn.disabled = true;
  if (capture.recorder.state !== 'inactive') capture.recorder.stop();

  const blob = await capture.settled;
  voiceCapture = null;
  if (elements.voiceSendBtn) elements.voiceSendBtn.disabled = false;
  closeVoiceBar();

  if (!blob || blob.size === 0) {
    const thread = threads.get(capture.peer);
    if (thread) systemNote(thread, t('voiceEmpty'));
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }).catch(() => null);
  if (typeof dataUrl !== 'string') return;

  if (dataUrl.length > CLOUD_VOICE_MAX_DATA_URL_CHARS) {
    const thread = threads.get(capture.peer);
    if (thread) systemNote(thread, t('voiceTooLarge'));
    return;
  }

  // A muted input, a microphone the OS handed to another app, a headset that
  // never connected: all of these record happily and produce silence. The
  // terminal client has always said so about its own recordings; saying it here
  // too is the difference between learning now and the other side asking why
  // the note is empty. Said, not enforced — a genuinely quiet recording is
  // still the sender's to send.
  if (await recordingIsSilent(blob)) {
    const thread = threads.get(capture.peer);
    if (thread) systemNote(thread, t('voiceSilent'));
  }

  sendVoiceMessage(dataUrl, capture.seconds, capture.peer);
}

// peer передаётся явно: собеседника можно переключить во время записи, и
// голосовое обязано уйти тому, кому его записывали.
function sendVoiceMessage(dataUrl, duration, peer) {
  if (!peer || !authed) return;
  const thread = threadFor(peer);
  const id = `m-${randomHex(12)}`;
  const ts = Date.now();
  const durLabel = formatClock(duration);
  // Текст — то, что останется в истории: голос сам по себе не хранится,
  // поэтому подпись должна читаться и без плеера.
  const text = t('voiceMessageNotify', durLabel);

  // On the core the note is a sealed action, queued durably like a text: the
  // caption above is never empty, which is what a core without voice support
  // shows in its place.
  if (coreSession) {
    appendVoiceMessage(thread, { id, own: true, author: self.name, dataUrl, duration, ts, text, queued: true });
    scrollToLatest(true);
    if (coreSession.sendWith(peer, id, text, { voice: { dataUrl, duration } })) playSound('sent');
    else failCoreSend(thread, id);
    return;
  }
  if (!sendFrame(peer, { t: 'msg', id, ts, text, voice: { dataUrl, duration } })) {
    systemNote(thread, t('connOffline'));
    return;
  }
  appendVoiceMessage(thread, { id, own: true, author: self.name, dataUrl, duration, ts, text });
  scrollToLatest(true);
  playSound('sent');
}

function appendVoiceMessage(thread, {
  id, own, author, dataUrl = null, mediaRef = null, duration, ts, text = '', delivered = false, read = false, readAt = 0, readVia = '',
  reactions = null,
  forwardedFrom = null, editedAt = null, queued = false,
}) {
  if (id && thread.seen.has(id)) return;
  if (id) thread.seen.add(id);
  if (!dataUrl && !mediaRef) return;

  notePreview(thread.peer, {
    id,
    from: own ? self?.login : thread.peer,
    ts,
    kind: 'human',
    author,
    // Empty on purpose: the roster labels a voice note rather than repeating
    // the «🎙 Голосовое сообщение (0:07)» caption the transcript already shows.
    text: '',
    media: 'voice',
  });


  const row = document.createElement('article');
  row.className = 'row';
  row.dataset.ts = String(ts);
  row.dataset.side = own ? 'own' : 'peer';
  row.dataset.kind = 'human';
  row.dataset.author = author;
  row.reactions = structuredClone(reactions || {});
  if (id) row.dataset.id = id;
  if (editedAt) row.dataset.editedAt = String(editedAt);
  if (id) messageAttachments.set(id, { image: null, voice: dataUrl ? { dataUrl, duration } : { mediaRef, duration } });

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const content = document.createElement('div');
  content.className = 'bubble-content';


  const forwardEl = forwardedFrom && typeof forwardedFrom === 'object'
    ? buildForwardLabel(forwardedFrom) : null;
  const voiceCard = buildVoicePlayer(dataUrl, duration, mediaRef);

  const meta = document.createElement('span');
  meta.className = 'bubble-meta';

  const timeEl = document.createElement('time');
  timeEl.className = 'bubble-time';
  timeEl.dateTime = new Date(ts).toISOString();
  timeEl.textContent = timeFormat.format(ts);
  meta.append(timeEl);

  if (own) {
    const mark = document.createElement('span');
    mark.className = 'bubble-mark';
    // Receipts are a watermark, so every mark has to know its own place in
    // time: a `read` for the newest message means everything above it too.
    mark.dataset.ts = String(ts);
    setMark(mark, queued ? 'queued' : (read ? 'read' : (delivered ? 'ack' : 'sent')), readAt, readVia);
    meta.append(mark);
    if (id) thread.marks.set(id, mark);
  }
  attachMessageActions(row, { id, own, author, text, media: 'voice' });

  appendMessageAuthor(content, thread, { own, kind: 'human', author });
  if (forwardEl) content.append(forwardEl);
  content.append(voiceCard, meta);
  bubble.append(content);
  row.append(bubble);
  layoutMessageMeta(row);
  renderReactionButtons(row);
  if (editedAt) markMessageEdited(row, editedAt);
  markMessageRemindedIfPending(thread, row, id);
  thread.node.append(row);
  paintReactionEvents(thread);
  scheduleDateDividers(thread);
  renderInfoPanel();
}

// Плеер голосового: столбики — реальные пики декодированного звука, поэтому
// по ним видно паузы и громкость, а клик по дорожке перематывает запись.
let activeVoiceAudio = null;

function buildVoicePlayer(dataUrl, duration, mediaRef = null) {
  const card = document.createElement('div');
  card.className = 'voice-card';

  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn';
  playBtn.type = 'button';
  playBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>';
  playBtn.title = t('voicePlay');

  const track = document.createElement('button');
  track.className = 'voice-waveform';
  track.type = 'button';
  track.tabIndex = -1;
  track.setAttribute('aria-hidden', 'true');
  const bars = Array.from({ length: VOICE_WAVE_BARS }, () => {
    const bar = document.createElement('span');
    bar.className = 'voice-waveform-bar';
    return bar;
  });
  track.append(...bars);

  const readout = document.createElement('span');
  readout.className = 'voice-duration';
  readout.textContent = formatClock(duration);

  // A referenced voice note has no source until its bytes arrive.
  const audio = dataUrl ? new Audio(dataUrl) : new Audio();
  audio.preload = 'metadata';
  audio.playbackRate = voicePlaybackRate;

  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration || 0);

  const paintProgress = () => {
    const span = total();
    const ratio = span > 0 ? audio.currentTime / span : 0;
    const played = Math.round(ratio * bars.length);
    bars.forEach((bar, index) => bar.classList.toggle('played', index < played));
  };

  const setIdle = () => {
    playBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>';
    playBtn.title = t('voicePlay');
    readout.textContent = formatClock(total());
  };

  playBtn.addEventListener('click', () => {
    if (card.dataset.media === 'failed') {
      loadReferenced();
      return;
    }
    if (card.dataset.media) return;
    if (audio.paused) {
      if (activeVoiceAudio && activeVoiceAudio !== audio) activeVoiceAudio.pause();
      activeVoiceAudio = audio;
      audio.play().catch(() => setIdle());
      playBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-pause"></use></svg>';
      playBtn.title = t('voicePause');
    } else {
      audio.pause();
      setIdle();
    }
  });

  audio.addEventListener('timeupdate', () => {
    paintProgress();
    readout.textContent = `${formatClock(audio.currentTime)} / ${formatClock(total())}`;
  });
  audio.addEventListener('pause', () => {
    playBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>';
    playBtn.title = t('voicePlay');
  });
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    paintProgress();
    setIdle();
  });
  audio.addEventListener('loadedmetadata', setIdle);

  track.addEventListener('click', (event) => {
    const box = track.getBoundingClientRect();
    if (box.width === 0) return;
    const span = total();
    if (span <= 0) return;
    audio.currentTime = Math.min(span, Math.max(0, ((event.clientX - box.left) / box.width) * span));
    paintProgress();
  });

  const speedBtn = document.createElement('button');
  speedBtn.className = 'voice-speed-btn';
  speedBtn.type = 'button';
  speedBtn.textContent = `${voicePlaybackRate}×`;
  speedBtn.title = t('voiceSpeedTitle');
  speedBtn.addEventListener('click', () => {
    const at = VOICE_SPEEDS.indexOf(audio.playbackRate);
    const next = VOICE_SPEEDS[(at + 1) % VOICE_SPEEDS.length];
    audio.playbackRate = next;
    speedBtn.textContent = `${next}×`;
    // The next player built (any message, any thread) starts at this rate —
    // matches every other chat app's «pick it once» expectation — but never
    // touches a player already on screen, so a note already mid-playback
    // keeps the speed it was opened with.
    voicePlaybackRate = next;
    try { localStorage.setItem(VOICE_SPEED_KEY, String(next)); } catch {}
  });

  const paintPeaks = (peaks) => {
    if (!peaks) return;
    bars.forEach((bar, index) => {
      bar.style.height = `${3 + Math.round(peaks[index] * 17)}px`;
    });
  };

  // The card is drawn at once — length known, bars flat — and becomes playable
  // when the bytes are here. `blob.arrayBuffer()` rather than `fetch(blob:)`:
  // the CSP's connect-src is 'self' only.
  function loadReferenced() {
    card.dataset.media = 'loading';
    playBtn.title = t('mediaLoading');
    fetchMedia(mediaRef).then(async ({ blob, url }) => {
      audio.src = url;
      delete card.dataset.media;
      playBtn.title = t('voicePlay');
      readout.textContent = formatClock(total());
      paintPeaks(await decodeVoicePeaksFromBytes(await blob.arrayBuffer(), bars.length));
    }).catch((error) => {
      const gone = error?.code === 'gone';
      card.dataset.media = gone ? 'gone' : 'failed';
      playBtn.title = gone ? t('mediaExpired') : t('mediaFailed');
      readout.textContent = gone ? t('mediaExpired') : t('mediaFailed');
    });
  }

  if (dataUrl) decodeVoicePeaks(dataUrl, bars.length).then(paintPeaks).catch(() => {});
  else if (mediaRef) loadReferenced();

  card.append(playBtn, track, readout, speedBtn);
  return card;
}

// CSP держит connect-src на 'self', поэтому fetch('data:…') недоступен —
// base64 разбирается вручную.
function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  if (comma < 0) return null;
  if (!dataUrl.slice(0, comma).includes(';base64')) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function decodeVoicePeaks(dataUrl, buckets) {
  const bytes = dataUrlToBytes(dataUrl);
  return bytes ? decodeVoicePeaksFromBytes(bytes, buckets) : null;
}

async function decodeVoicePeaksFromBytes(bytes, buckets) {
  initAudio();
  if (!audioCtx || typeof audioCtx.decodeAudioData !== 'function') return null;
  const decoded = await audioCtx.decodeAudioData(bytes);
  const samples = decoded.getChannelData(0);
  const step = Math.max(1, Math.floor(samples.length / buckets));
  const peaks = new Array(buckets).fill(0);
  let loudest = 0;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * step;
    let peak = 0;
    for (let i = start; i < start + step && i < samples.length; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    peaks[bucket] = peak;
    if (peak > loudest) loudest = peak;
  }
  if (loudest === 0) return null;
  return peaks.map((peak) => peak / loudest);
}

// --- Набор текста и отправка ---------------------------------------------

// --- Черновики -----------------------------------------------------------
//
// One composer, many conversations: the text belongs to the peer it was
// being written to, so switching away has to park it and switching back has
// to hand it over. Kept in memory only — a draft is a half-finished thought,
// not a document, and a reload is a fair place to lose it.
const drafts = new Map();

// The composer is a field, not a document: it grows to this and no further.
// app.css carries the same number twice (`.composer-grow` and its textarea),
// which is the last line of defence if this ever fails to run before paint.
const COMPOSER_MAX_HEIGHT_PX = 160;

// `.composer-grow::after` mirrors the draft (`content: attr(data-value)`) to
// size the field. The mirror only ever has to be tall enough to hit the clamp
// above, and it is re-laid out on every keystroke — so handing it a whole
// 250KB body meant laying out a quarter of a million characters per input
// event. That is what «редактирование большого сообщения ломает всё» was:
// starting an edit of a huge message froze the tab and sized the composer
// from a mirror nobody could see. A couple of thousand characters is already
// far more than 160px of text at any font size this app offers.
const COMPOSER_MIRROR_MAX_CHARS = 2000;

// One line of a message, for the bar above the composer. The bar is a single
// ellipsised row (`.composer-context-snippet`), and `white-space: nowrap` on
// a 250KB string is an enormous intrinsic-width measurement for something
// that shows forty characters.
const CONTEXT_SNIPPET_MAX_CHARS = 120;

function contextSnippet(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > CONTEXT_SNIPPET_MAX_CHARS
    ? `${flat.slice(0, CONTEXT_SNIPPET_MAX_CHARS - 1)}…`
    : flat;
}

function syncComposerMirror(value) {
  elements.composerGrow.dataset.value = value.length > COMPOSER_MIRROR_MAX_CHARS
    ? value.slice(0, COMPOSER_MIRROR_MAX_CHARS)
    : value;
}

const BOT_ACTION_LIMIT = 8;
const BOT_ACTION_ID_MAX = 40;
const BOT_ACTION_LABEL_MAX = 40;
const BOT_ACTION_VALUE_MAX = 200;

function normalizeBotActions(value) {
  if (!Array.isArray(value)) return [];
  const actions = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const actionValue = typeof item.value === 'string' ? item.value.trim() : '';
    if (!id || id.length > BOT_ACTION_ID_MAX || !label || label.length > BOT_ACTION_LABEL_MAX
      || !actionValue || actionValue.length > BOT_ACTION_VALUE_MAX) continue;
    actions.push({ id, label, value: actionValue });
    if (actions.length === BOT_ACTION_LIMIT) break;
  }
  return actions;
}

// What the actions bar offers for one conversation: whatever the server last
// said this peer's bot offers, and — for the service account alone, while its
// thread holds no message at all — the menu.
//
// `{tailchat}` is the one conversation in this client that opens with nothing
// in it: the account never speaks first into a thread somebody has already
// used (AGENTS.md §9), and a history cleared for oneself is empty again. A
// brand-new account gets the same menu as a message at registration; this is
// the other half of that rule, for the thread that is empty for any other
// reason — without it the screen is blank, with nothing to press and no way to
// learn that the menu behind `/help` exists.
function botActionsFor(peer) {
  const live = botActionsByPeer.get(peer) ?? [];
  if (live.length > 0) return live;
  if (peer !== OFFICIAL_ACCOUNT_LOGIN) return [];
  const thread = threads.get(peer);
  // `loaded` rather than "no rows yet": until the server has answered, an
  // empty node means "history is still on its way", and a button that appears
  // and then vanishes under the reader is worse than one that comes late.
  if (!thread?.loaded || thread.node.querySelector('.row')) return [];
  return [{ id: 'service-menu', label: t('botMenu'), value: '/help' }];
}

function renderBotActions() {
  const bar = elements.botActions;
  if (!bar) return;
  bar.replaceChildren();
  const actions = activePeer ? botActionsFor(activePeer) : [];
  const disabled = !activePeer || isBlockedPeer(activePeer);
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bot-action';
    button.dataset.actionId = action.id;
    button.textContent = action.label;
    button.disabled = disabled;
    button.addEventListener('click', () => {
      if (!activePeer || button.disabled) return;
      const peer = activePeer;
      botActionsByPeer.delete(peer);
      // The message first, then the bar: the seeded menu is derived from
      // «this thread has no messages», so its own button has to leave the
      // moment pressing it put one on screen — which `sendPlainMessage` does
      // synchronously, a row and all.
      sendPlainMessage(action.value);
      renderBotActions();
    });
    bar.append(button);
  }
  bar.hidden = actions.length === 0;
}

function applyBotActions(peer, value) {
  if (typeof peer !== 'string' || peer === '') return;
  const actions = normalizeBotActions(value);
  if (actions.length === 0) botActionsByPeer.delete(peer);
  else botActionsByPeer.set(peer, actions);
  if (peer === activePeer) renderBotActions();
}

function resizeComposer() {
  const input = elements.input;
  input.style.height = 'auto';
  const height = input.scrollHeight;
  input.style.height = `${Math.min(height, COMPOSER_MAX_HEIGHT_PX)}px`;
  input.style.overflowY = height > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
}

function setComposerValue(value) {
  elements.input.value = value;
  syncComposerMirror(value);
  elements.sendButton.disabled = !value.trim();
  resizeComposer();
}

// --- Эмодзи --------------------------------------------------------------

// Apple's pictures in place of the system glyph wherever a message is shown
// (spec 2026-10-27, A2): bubbles, reaction chips, the reaction rows, the
// picker, the roster preview and reply quotes. Only the drawing changes — the
// frame still carries Unicode, so the terminal and the APK see what they saw
// before, and the composer's textarea keeps the system glyph because a picture
// cannot live inside it (A4).
const EMOJI_IMAGE_BASE = '/tailchat/emoji/apple/64/';
// One emoji as a person sees it: a flag pair, a keycap, or a pictograph in
// emoji presentation, optionally toned, optionally ZWJ-joined into one
// sequence, optionally closed by a subdivision-flag tag run. Built from Unicode
// properties rather than from `emoji-data.js`, so a bubble never waits for the
// picker's table; every file in `emoji/apple/64` matches it exactly once
// (checked by test/web-emoji.test.js).
const EMOJI_RE = /\p{Regional_Indicator}{2}|[#*0-9]\uFE0F\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\uFE0F?\p{Emoji_Modifier}?)*[\u{E0020}-\u{E007F}]*/gu;
// Skin tones are out of scope (A2) and the set has no toned pictures: a toned
// glyph keeps the system rendering instead of costing a request that 404s.
const EMOJI_TONE_RE = /\p{Emoji_Modifier}/u;
// Segment first, then decide whether the entire grapheme has a picture.
// Searching the message with EMOJI_RE directly can match just the last member
// of an unqualified ZWJ sequence (🏳‍🌈 / ❤‍🔥) and split one visible glyph.
const EMOJI_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });
const JUMBO_EMOJI_MAX = 3;

// The picture's file name: the glyph's code points, lower-case hex joined by
// `-` — exactly how bin/make-emoji-data.js names what it copies.
function emojiImageName(glyph) {
  return Array.from(glyph, (char) => char.codePointAt(0).toString(16).padStart(4, '0')).join('-');
}

// Exact qualification first; for ZWJ sequences also try the fully-qualified
// spelling by restoring missing emoji-presentation selectors. The original
// grapheme remains the alt/copy text. A toned or unsupported grapheme must
// remain whole, never a base PNG with an unattached modifier or joined tail.
function emojiRenderGlyph(glyph) {
  if (EMOJI_TONE_RE.test(glyph)) return null;
  const exact = [...glyph.matchAll(EMOJI_RE)];
  if (exact.length === 1 && exact[0][0] === glyph) return glyph;
  if (!glyph.includes('\u200D')) return null;
  const qualified = glyph.replace(/\p{Extended_Pictographic}\uFE0F?/gu, (part) =>
    part.endsWith('\uFE0F') || /\p{Emoji_Presentation}/u.test(part) ? part : `${part}\uFE0F`);
  const match = [...qualified.matchAll(EMOJI_RE)];
  return match.length === 1 && match[0][0] === qualified ? qualified : null;
}

// `alt` is the glyph itself: selection, copy (`copyEmojiAsText`) and every
// reader of the rendered text (`emojiPlainText`) get the Unicode back. A glyph
// newer than the set has no file; it turns back into its text, which is the
// system rendering it had before.
function emojiImage(glyph) {
  const img = document.createElement('img');
  img.className = 'emoji';
  img.alt = glyph;
  img.draggable = false;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.addEventListener('error', () => img.replaceWith(glyph), { once: true });
  img.src = `${EMOJI_IMAGE_BASE}${emojiImageName(emojiRenderGlyph(glyph) ?? glyph)}.png`;
  return img;
}

// Appends `text` as text nodes with every emoji in it drawn as `emojiImage` —
// never markup, so no message can become HTML on the way.
function appendEmojiText(container, text) {
  let plain = '';
  for (const { segment } of EMOJI_SEGMENTER.segment(text)) {
    if (!emojiRenderGlyph(segment)) {
      plain += segment;
      continue;
    }
    if (plain) container.append(plain);
    plain = '';
    container.append(emojiImage(segment));
  }
  if (plain) container.append(plain);
}

// `textContent` of rendered text with each picture read back as its glyph —
// what history search, export and forward used to get from `textContent`
// alone before emoji became `<img>`. `null` for a missing element, so callers
// keep their own fallback.
function emojiPlainText(el) {
  if (!el) return null;
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: node => node.nodeType === Node.ELEMENT_NODE && node.matches('.bubble-meta-spacer')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) text += node.data;
    else if (node.matches('img.emoji')) text += node.alt;
  }
  return text;
}

// One to three emoji and nothing else: drawn large and without a bubble (A2),
// the way a phone shows it.
function isJumboEmoji(text) {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > 64) return false;
  let count = 0;
  for (const { segment } of EMOJI_SEGMENTER.segment(trimmed)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emojiRenderGlyph(segment)) return false;
    count += 1;
  }
  return count > 0 && count <= JUMBO_EMOJI_MAX;
}

// Copy selections explicitly as Unicode when they contain emoji images, rather
// than relying on a browser's treatment of image alt text. Selections without
// emoji keep their native copy behaviour.
function copyEmojiAsText(event) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return;
  const holder = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i += 1) holder.append(selection.getRangeAt(i).cloneContents());
  holder.querySelectorAll('.bubble-meta-spacer').forEach(node => node.remove());
  const pictures = holder.querySelectorAll('img.emoji');
  if (pictures.length === 0) return;
  for (const img of pictures) img.replaceWith(img.alt);
  // `innerText` needs a rendered element to turn rows and paragraphs into
  // line breaks the way a native copy does; off-screen, for one frame.
  holder.className = 'transcript';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;white-space:pre-wrap;';
  document.body.append(holder);
  const text = holder.innerText;
  holder.remove();
  event.clipboardData.setData('text/plain', text);
  event.clipboardData.setData('text/html', holder.innerHTML);
  event.preventDefault();
}

// --- Быстрые реакции (A1) ------------------------------------------------

const DEFAULT_QUICK_REACTIONS = ['👍', '👎', '👌', '❤️', '🙏', '🔥', '🤝', '👋', '🆗', '✅', '👏', '💪', '😂', '😍', '😢', '🤔', '😊', '😇', '🥰', '😘', '😎', '🎉', '💯', '🙌', '🤗', '🤷', '👀', '☕', '✌️', '🤞', '🫡', '🙋'];

// The bound `reactToMessage` already puts on a reaction: anything longer is not
// something a picker could have produced.
function isReactionEmoji(value) {
  if (typeof value !== 'string' || Array.from(value).length > 16 || EMOJI_TONE_RE.test(value)) return false;
  const matches = [...value.matchAll(EMOJI_RE)];
  return matches.length === 1 && matches[0][0] === value;
}

// Owner's selection policy only: message text, history and rendering stay intact.
const EMOJI_SELECTION_EXCLUDED_POINTS = new Set('🎃🖕🤬💩😈👿👹👺💀☠👻🧙🧛🧟🧞🧚🧝🧜🧌🔮🪄🧿🪬🧹🥠🔯⚰⚱🪦⚧⛎♈♉♊♋♌♍♎♏♐♑♒♓');

function isEmojiChoiceAllowed(emoji) {
  const bare = emoji.replaceAll('\uFE0F', '');
  if (bare === '🏳‍🌈') return false;
  for (const point of bare) {
    if (EMOJI_SELECTION_EXCLUDED_POINTS.has(point)) return false;
  }
  return true;
}

// Hover and settings share one device-local set. Preserve the original six
// customized slots when extending an existing installation's quick list.
function quickReactions() {
  try {
    const stored = JSON.parse(localStorage.getItem(QUICK_REACTIONS_KEY) ?? 'null');
    if (Array.isArray(stored) && stored.length > 0 && stored.length <= DEFAULT_QUICK_REACTIONS.length && stored.every(isReactionEmoji)) {
      const list = stored.map(emoji => isEmojiChoiceAllowed(emoji) ? emoji : null);
      for (let slot = 0; slot < DEFAULT_QUICK_REACTIONS.length; slot += 1) {
        if (!list[slot]) list[slot] = DEFAULT_QUICK_REACTIONS.find(emoji => !list.includes(emoji));
      }
      return list;
    }
  } catch {}
  return [...DEFAULT_QUICK_REACTIONS];
}

// A glyph already in another slot swaps places with the one it replaces, so
// the row never offers the same reaction twice.
function setQuickReaction(slot, emoji) {
  if (!isReactionEmoji(emoji) || !isEmojiChoiceAllowed(emoji)) return;
  const list = quickReactions();
  const existing = list.indexOf(emoji);
  if (existing !== -1) list[existing] = list[slot];
  list[slot] = emoji;
  try { localStorage.setItem(QUICK_REACTIONS_KEY, JSON.stringify(list)); } catch {}
  renderQuickReactionSettings();
}

// Puts the reaction on, or takes it off when it is already yours — the same
// toggle a reaction chip under the bubble does.
function toggleReaction(id, emoji) {
  rememberEmoji(emoji);
  const row = threads.get(activePeer)?.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  reactToMessage(id, emoji, !row?.reactions?.[emoji]?.includes(self?.login));
}

// Quick reactions plus «+». `anchor` is what the full picker opens next to; `onDone`
// closes whatever surface the row sits in before the reaction lands.
function buildQuickReactions(id, { anchor, onDone }) {
  const quick = document.createElement('div');
  quick.className = 'quick-reactions';
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', t('msgReact'));
  for (const emoji of quickReactions()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-reactions-item';
    button.append(emojiImage(emoji));
    button.setAttribute('aria-label', `${t('msgReact')}: ${emoji}`);
    preserveFocusOnPointerDown(button);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onDone();
      toggleReaction(id, emoji);
    });
    quick.append(button);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'quick-reactions-item quick-reactions-more';
  more.textContent = '+';
  more.title = t('emojiMore');
  more.setAttribute('aria-label', t('emojiMore'));
  preserveFocusOnPointerDown(more);
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    onDone();
    openEmojiPicker(anchor, (emoji) => toggleReaction(id, emoji), { touch: isTouchActivation(event) });
  });
  quick.append(more);
  return quick;
}

// Settings → «Поведение»: each slot opens the full picker to replace itself.
function renderQuickReactionSettings() {
  const group = elements.settingsQuickReactions;
  if (!group) return;
  group.replaceChildren(...quickReactions().map((emoji, slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-reactions-item';
    button.append(emojiImage(emoji));
    button.setAttribute('aria-label', t('settingsQuickReactionSlot', slot + 1, emoji));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openEmojiPicker(button, (picked) => setQuickReaction(slot, picked), { touch: isTouchActivation(event) });
    });
    return button;
  }));
}

const finePointer = window.matchMedia('(pointer: fine)');

// A click from a finger: the picker then leaves its search box unfocused, so
// the on-screen keyboard does not jump up over the grid (A3). A keyboard's
// click has no pointer type and counts as whatever the device's pointer is.
function isTouchActivation(event) {
  return event?.pointerType ? event.pointerType === 'touch' : !finePointer.matches;
}

// --- Пикер эмодзи (A3) ---------------------------------------------------

// The tabs, in phone-keyboard order; the icon is the tab's only label on
// screen, the i18n key its accessible name and section heading.
const EMOJI_CATEGORIES = [
  ['recent', '🕘', 'emojiCatRecent'],
  ['smileys', '😀', 'emojiCatSmileys'],
  ['people', '👋', 'emojiCatPeople'],
  ['animals', '🐻', 'emojiCatAnimals'],
  ['food', '🍔', 'emojiCatFood'],
  ['activities', '⚽', 'emojiCatActivities'],
  ['travel', '🚗', 'emojiCatTravel'],
  ['objects', '💡', 'emojiCatObjects'],
  ['symbols', '🔣', 'emojiCatSymbols'],
  ['flags', '🏁', 'emojiCatFlags'],
];
const EMOJI_RECENT_MAX = 24;
const EMOJI_CELL_MIN_PX = 32;
let emojiDataPromise = null;
let emojiPicker = null;

// ~350 KB of glyphs and ru/en keywords, fetched the first time a picker opens
// rather than with the page: most sessions never open one. Cache-busted with
// the app version like the rest of the shell; a failed load is retried on the
// next open.
function loadEmojiData() {
  emojiDataPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `/tailchat/emoji-data.js${APP_VERSION ? `?v=${APP_VERSION}` : ''}`;
    script.addEventListener('load', () => {
      const table = globalThis.TAILCHAT_EMOJI;
      if (Array.isArray(table)) resolve(table.map(([id, list]) => ({
        id,
        list: list.filter(([glyph]) => isEmojiChoiceAllowed(glyph)).map(([glyph, words]) => ({ glyph, words: ` ${words}` })),
      })));
      else reject(new Error('emoji-data.js defined no table'));
    });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('emoji-data.js failed to load'));
    });
    document.head.append(script);
  }).catch((error) => {
    emojiDataPromise = null;
    throw error;
  });
  return emojiDataPromise;
}

// Shared by the composer and reactions (A3): the last 24 chosen in any picker.
function recentEmoji() {
  try {
    const stored = JSON.parse(localStorage.getItem(EMOJI_RECENT_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter(emoji => isReactionEmoji(emoji) && isEmojiChoiceAllowed(emoji)).slice(0, EMOJI_RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(emoji) {
  if (!isReactionEmoji(emoji) || !isEmojiChoiceAllowed(emoji)) return;
  const list = [emoji, ...recentEmoji().filter((item) => item !== emoji)].slice(0, EMOJI_RECENT_MAX);
  try { localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(list)); } catch {}
}

function emojiSearchTerms(value) {
  return value.toLocaleLowerCase().replaceAll('ё', 'е').split(/\s+/u).filter(Boolean);
}

function emojiPickerCell(glyph) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'emoji-picker-item';
  item.tabIndex = -1;
  item.dataset.emoji = glyph;
  item.append(emojiImage(glyph));
  return item;
}

function closeEmojiPicker() {
  if (!emojiPicker) return;
  emojiPicker.observer?.disconnect();
  emojiPicker.picker.remove();
  emojiPicker = null;
}

function insertIntoComposer(text) {
  const input = elements.input;
  if (!input || input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  setComposerValue(input.value.slice(0, start) + text + input.value.slice(end));
  const caret = start + text.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  if (activePeer) stashDraft(activePeer);
}

// A tap on a button other than the focused composer blurs it, and on a phone
// that dismisses the virtual keyboard — then whatever the tap led to (an
// emoji landing, a menu opening and an edit starting) refocuses the composer
// and brings the keyboard back, so the keyboard visibly disappears and
// reappears for one tap. Blur happens on the pointer-down, before `click`
// ever fires, so preventing the default there is what keeps focus (and the
// keyboard) exactly where it was.
//
// `mousedown` only, never `touchstart`: per the touch events spec, a
// cancelled `touchstart` also cancels the synthetic mouse events a browser
// would otherwise fire after it — including `click`. Adding a `touchstart`
// guard here once made every one of these buttons untappable on a real
// phone, not just quieter about the keyboard.
function preserveFocusOnPointerDown(el) {
  el.addEventListener('mousedown', (event) => event.preventDefault());
}

// Popover next to its anchor on a wide screen (≤ 360×380), a full-width
// bottom sheet on a narrow one (A3). Inside an open modal <dialog> — the
// settings slots — it has to live in that dialog: anything outside the top
// layer sits under the backdrop and takes no clicks.
function placeEmojiPicker() {
  if (!emojiPicker) return;
  const { picker, anchor } = emojiPicker;
  const sheet = !wide.matches;
  picker.classList.toggle('emoji-picker--sheet', sheet);
  if (sheet) {
    picker.style.left = '';
    picker.style.top = '';
    return;
  }
  const box = safeAnchorRect(anchor);
  const pickerBox = picker.getBoundingClientRect();
  const left = Math.min(box.right - pickerBox.width, window.innerWidth - pickerBox.width - 8);
  const above = box.top - pickerBox.height - 8;
  const top = above >= 8 ? above : Math.min(box.bottom + 8, window.innerHeight - pickerBox.height - 8);
  picker.style.left = `${Math.max(8, left)}px`;
  picker.style.top = `${Math.max(8, top)}px`;
}

// One picker for the composer, the reaction «+» and the settings slots (A3).
// `onPick` gets the chosen glyph after the picker has closed.
function openEmojiPicker(anchor, onPick, { touch = false } = {}) {
  closeEmojiPicker();
  const returnFocus = document.activeElement;
  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', t('emojiButton'));
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'emoji-picker-search';
  search.placeholder = t('emojiSearch');
  search.setAttribute('aria-label', t('emojiSearch'));
  search.autocomplete = 'off';
  search.spellcheck = false;
  const tabs = document.createElement('div');
  tabs.className = 'emoji-picker-tabs';
  tabs.setAttribute('role', 'tablist');
  const body = document.createElement('div');
  body.className = 'emoji-picker-body';
  const results = document.createElement('div');
  results.className = 'emoji-picker-grid emoji-picker-results';
  results.hidden = true;
  const empty = document.createElement('p');
  empty.className = 'emoji-picker-empty';
  empty.textContent = t('emojiNothingFound');
  empty.hidden = true;
  body.append(results, empty);
  picker.append(search, tabs, body);

  const state = {
    picker, anchor, body, active: null, observer: null, index: null, sections: new Map(), tabs: new Map(),
  };
  emojiPicker = state;
  const host = [...document.querySelectorAll('dialog[open]')].pop() ?? document.body;
  host.append(picker);
  placeEmojiPicker();

  const columns = Math.max(6, Math.floor(body.clientWidth / EMOJI_CELL_MIN_PX));
  picker.style.setProperty('--emoji-columns', String(columns));
  const cellPx = body.clientWidth / columns;

  const pick = (glyph) => {
    rememberEmoji(glyph);
    closeEmojiPicker();
    onPick(glyph);
  };

  const fill = (section) => {
    if (!section || section.filled) return;
    section.filled = true;
    section.grid.style.minHeight = '';
    section.grid.append(...section.list.map(emojiPickerCell));
  };

  const setActive = (cell) => {
    state.active?.classList.remove('is-active');
    state.active = cell;
    if (!cell) return;
    cell.classList.add('is-active');
    cell.scrollIntoView({ block: 'nearest' });
    // Arrow keys walk the grid row by row; the section after (or before) the
    // one they are in may not be drawn yet, and an undrawn section would be
    // skipped rather than entered.
    const section = state.sections.get(cell.closest('.emoji-picker-section')?.dataset.category);
    if (section) {
      fill(section.next);
      fill(section.prev);
    }
  };

  const markTab = (id) => {
    for (const [tabId, tab] of state.tabs) tab.setAttribute('aria-selected', String(tabId === id));
  };

  const addSection = (id, list) => {
    const meta = EMOJI_CATEGORIES.find(([category]) => category === id);
    if (!meta || list.length === 0) return;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-picker-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-label', t(meta[2]));
    tab.title = t(meta[2]);
    tab.append(emojiImage(meta[1]));
    const sectionNode = document.createElement('section');
    sectionNode.className = 'emoji-picker-section';
    sectionNode.dataset.category = id;
    const heading = document.createElement('p');
    heading.className = 'emoji-picker-heading';
    heading.textContent = t(meta[2]);
    const grid = document.createElement('div');
    grid.className = 'emoji-picker-grid';
    // Space for the rows not drawn yet, so the scrollbar and the tab jumps
    // land where the drawn section will be.
    grid.style.minHeight = `${Math.ceil(list.length / columns) * cellPx}px`;
    sectionNode.append(heading, grid);
    const section = {
      id, list: list.map((item) => item.glyph ?? item), grid, node: sectionNode, filled: false, prev: null, next: null,
    };
    const previous = [...state.sections.values()].pop();
    if (previous) {
      previous.next = section;
      section.prev = previous;
    }
    state.sections.set(id, section);
    state.tabs.set(id, tab);
    tab.addEventListener('click', () => {
      if (search.value) {
        search.value = '';
        runSearch();
      }
      fill(section);
      body.scrollTop = sectionNode.offsetTop;
      markTab(id);
    });
    tabs.append(tab);
    body.insertBefore(sectionNode, results);
    if (state.observer) state.observer.observe(sectionNode);
    else fill(section);
  };

  const runSearch = () => {
    const terms = emojiSearchTerms(search.value);
    const searching = terms.length > 0;
    setActive(null);
    for (const section of state.sections.values()) section.node.hidden = searching;
    results.hidden = !searching;
    results.replaceChildren();
    if (!searching) {
      empty.hidden = true;
      return;
    }
    const typed = search.value.trim();
    const found = (state.index ?? []).filter((item) => item.glyph === typed
      || terms.every((term) => item.words.includes(` ${term}`)));
    results.append(...found.map((item) => emojiPickerCell(item.glyph)));
    empty.hidden = found.length > 0;
    body.scrollTop = 0;
  };

  // Draw a category only once it scrolls near view, so opening the picker
  // does not create ~1 900 images at once (A3).
  if ('IntersectionObserver' in window) {
    state.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        fill(state.sections.get(entry.target.dataset.category));
        state.observer.unobserve(entry.target);
      }
    }, { root: body, rootMargin: '200px 0px' });
  }

  addSection('recent', recentEmoji());
  const firstSection = state.sections.values().next().value;
  if (firstSection) fill(firstSection);
  markTab(firstSection?.id);
  placeEmojiPicker();

  void loadEmojiData().then((table) => {
    if (emojiPicker !== state) return;
    state.index = table.flatMap((category) => category.list);
    for (const category of table) addSection(category.id, category.list);
    if (!firstSection) markTab(table[0]?.id);
    if (search.value) runSearch();
  }).catch(() => {});

  let scrollFrame = 0;
  body.addEventListener('scroll', () => {
    if (scrollFrame || search.value) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      let current = null;
      for (const section of state.sections.values()) {
        if (section.node.offsetTop - body.scrollTop <= 8) current = section.id;
      }
      markTab(current ?? firstSection?.id ?? state.sections.keys().next().value);
    });
  }, { passive: true });
  // A wheel or touch drag inside the grid scrolls the grid; without this the
  // page behind it moves instead once the list hits its end.
  body.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  search.addEventListener('input', runSearch);
  // Clicks stay inside: the window listener that closes the picker on an
  // outside click must not see them.
  picker.addEventListener('click', (event) => {
    event.stopPropagation();
    const item = event.target.closest('.emoji-picker-item');
    if (item) pick(item.dataset.emoji);
  });
  // Pressing a glyph or a tab keeps focus where it is — the composer, or the
  // search box — instead of moving it to a button that is about to vanish.
  picker.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeEmojiPicker();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Enter') {
      // Category tabs keep native Enter activation; an old grid selection must
      // not turn a tab change into an emoji insertion.
      if (event.target !== search && !event.target.closest('.emoji-picker-grid')) return;
      const chosen = state.active ?? (search.value ? results.querySelector('.emoji-picker-item') : null);
      if (!chosen) return;
      event.preventDefault();
      pick(chosen.dataset.emoji);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    // While there is text and nothing is selected yet, ←/→ still move the
    // caret in the search box.
    if (!state.active && search.value && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
    event.preventDefault();
    moveEmojiSelection(state, event.key, setActive);
  });

  // From a mouse or keyboard the search box takes focus at once; from a finger
  // it does not, or the on-screen keyboard would cover the grid (A3).
  if (!touch) search.focus({ preventScroll: true });
}

// ←/→ step through the cells in order; ↑/↓ go to the nearest cell (by
// horizontal centre) in the next drawn row, which also crosses from one
// category into the next. Geometry rather than index arithmetic, because
// sections end on part-filled rows.
function moveEmojiSelection(state, key, setActive) {
  const cells = [...state.body.querySelectorAll('.emoji-picker-item')].filter((cell) => cell.offsetParent !== null);
  if (cells.length === 0) return;
  const index = cells.indexOf(state.active);
  if (index === -1) {
    setActive(cells[0]);
    return;
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    setActive(cells[Math.max(0, Math.min(cells.length - 1, index + (key === 'ArrowRight' ? 1 : -1)))]);
    return;
  }
  const step = key === 'ArrowDown' ? 1 : -1;
  const from = cells[index].getBoundingClientRect();
  const centre = from.left + from.width / 2;
  let rowTop = null;
  let best = null;
  let bestDistance = Infinity;
  for (let i = index + step; i >= 0 && i < cells.length; i += step) {
    const box = cells[i].getBoundingClientRect();
    if (rowTop === null) {
      if (Math.abs(box.top - from.top) < from.height / 2) continue;
      rowTop = box.top;
    } else if (Math.abs(box.top - rowTop) >= from.height / 2) {
      break;
    }
    const distance = Math.abs(box.left + box.width / 2 - centre);
    if (distance < bestDistance) {
      best = cells[i];
      bestDistance = distance;
    }
  }
  if (best) setActive(best);
}

// The composer's 😊 button: opens the picker into the draft, or closes the
// one it opened.
function toggleEmojiPicker(event) {
  if (emojiPicker?.anchor === elements.emojiButton) {
    closeEmojiPicker();
    return;
  }
  if (!elements.emojiButton || elements.emojiButton.disabled) return;
  openEmojiPicker(elements.emojiButton, insertIntoComposer, { touch: isTouchActivation(event) });
}

function stashDraft(peer) {
  if (!peer) return;
  const value = elements.input.value;
  if (value.trim() === '') drafts.delete(peer);
  else drafts.set(peer, value);
}

function restoreDraft(peer) {
  setComposerValue(peer ? (drafts.get(peer) ?? '') : '');
  hideCommandPalette();
}

// Editing an existing message and replying to one both stay in the same
// place a person is already looking: the draft. Neither ever opens a second
// surface — this bar above the composer names which of the two is active and
// lets it be cancelled; the field itself stays the one place text is typed
// and committed. `preEditDraft` is what was being written before Edit was
// clicked, so Cancel hands it back instead of just going blank.
let composerContext = null;
let preEditDraft = null;

function updateComposerContextUI() {
  const bar = elements.composerContextBar;
  if (!bar) return;
  if (!composerContext) {
    bar.hidden = true;
    delete bar.dataset.mode;
    return;
  }
  bar.hidden = false;
  bar.dataset.mode = composerContext.mode;
  if (elements.composerContextIcon) {
    elements.composerContextIcon.textContent = composerContext.mode === 'edit' ? '✎' : '↩';
  }
  if (elements.composerContextLabel) {
    elements.composerContextLabel.textContent = composerContext.mode === 'edit'
      ? t('editingMessage')
      : t('replyingTo', composerContext.authorName);
  }
  if (elements.composerContextSnippet) elements.composerContextSnippet.textContent = composerContext.snippet;
}

function startEditMessage(id, text) {
  if (!id || !activePeer) return;
  preEditDraft = elements.input.value;
  composerContext = { mode: 'edit', id, snippet: contextSnippet(text) };
  updateComposerContextUI();
  setComposerValue(text);
  elements.input.focus();
  const len = text.length;
  elements.input.setSelectionRange(len, len);
  // A long body opens scrolled to the top with the caret out of sight;
  // `setSelectionRange` alone does not bring it into view in every browser.
  elements.input.scrollTop = elements.input.scrollHeight;
}

// Up-arrow-to-edit: pressing ArrowUp in an otherwise empty composer picks
// up your most recent own text message in this thread for editing, same
// as the «⋯» → msgEdit menu action but without leaving the keyboard.
// Media-only and already-deleted rows are skipped since there is no text
// to edit.
function findLastOwnEditableMessage() {
  if (!activePeer) return null;
  const thread = threads.get(activePeer);
  if (!thread) return null;
  const rows = [...thread.node.querySelectorAll('.row[data-side="own"][data-id]')];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.dataset.deleted === 'true') continue;
    const text = row.messageText;
    if (text) return { id: row.dataset.id, text };
  }
  return null;
}

function editLastOwnMessage() {
  const target = findLastOwnEditableMessage();
  if (!target) return false;
  startEditMessage(target.id, target.text);
  return true;
}

function startReplyToMessage({ id, own, authorName, text, media }) {
  if (!id || !activePeer) return;
  const from = own ? (self?.login || '') : activePeer;
  const snippet = contextSnippet(text) || previewMediaLabel(media);
  composerContext = { mode: 'reply', id, from, authorName, snippet, media: media || undefined };
  updateComposerContextUI();
  elements.input.focus();
}

function cancelComposerContext() {
  if (!composerContext) return;
  const wasEdit = composerContext.mode === 'edit';
  composerContext = null;
  updateComposerContextUI();
  if (wasEdit) setComposerValue(preEditDraft ?? '');
  preEditDraft = null;
  if (activePeer) stashDraft(activePeer);
}

function clearComposer() {
  if (activePeer) drafts.delete(activePeer);
  setComposerValue('');
  composerContext = null;
  preEditDraft = null;
  updateComposerContextUI();
  elements.input.focus();
}

// --- Лента аккаунта (sync-v1) --------------------------------------------
//
// This socket holds exactly one subscription — the conversation on screen — so
// everything that happens in the other conversations reaches the tab as a
// roster line (`conversation-update`, `unread`) and nothing else. That is
// enough for a badge and not enough for a transcript: a message read on the
// phone, an old message edited, a gap left by a tab that was away — none of
// those produce an event this tab can apply to a thread it already has cached,
// so a ✓ stayed single and an edit stayed invisible until the conversation was
// reopened (or the page reloaded).
//
// `sync-v1` is the durable account feed that closes that: one cursor per
// account, one pass at a time, applied to whatever this tab holds. The feed
// names ids and carries no content on purpose (`accounts.js`'s `eventsSince`),
// so an id this tab has never seen becomes a *fetch*, not a merged row — and
// the nudge (`sync-nudge-v1`) is what makes a pass start while the socket is
// up rather than at the next reconnect.
const SYNC_CURSOR_KEY = 'tailchat-sync-cursor';
const SYNC_PAGE_LIMIT = 200;
// One pass walks at most this many pages before handing the rest to the next
// nudge: a client that fell a long way behind must not hold the socket's
// attention indefinitely.
const SYNC_MAX_PAGES = 20;
// How many conversations one flush re-fetches. The rest stay owed and are taken
// by the next flush, so a busy account converges without a burst.
const SYNC_REFRESH_LIMIT = 3;
// How far back a gap-filling walk goes before leaving the rest to the scroll
// (or to the next pass). Bounded for the same reason the server paginates.
const SYNC_BACKFILL_MAX_PAGES = 10;
let serverCaps = new Set();
let syncCursor = 0;
let syncCursorLoaded = false;
let syncInFlight = false;
let syncAgain = false;
let syncPages = 0;
const syncOwed = new Map(); // peer -> Set(message ids); an empty set means "refresh only"
let syncFlushBusy = false;
let syncFlushTimer = null;

function syncCursorStoreKey() {
  return `${SYNC_CURSOR_KEY}:${self?.login || ''}`;
}

function loadSyncCursor() {
  if (syncCursorLoaded) return;
  syncCursorLoaded = true;
  try {
    const stored = Number.parseInt(localStorage.getItem(syncCursorStoreKey()) || '', 10);
    syncCursor = Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    syncCursor = 0;
  }
}

function saveSyncCursor(value) {
  try {
    localStorage.setItem(syncCursorStoreKey(), String(value));
  } catch {
    // No storage (private browsing): the cursor lives for this page only, and
    // the pass after a reload starts from zero — which the server answers with
    // a `reset`, exactly the case it exists for.
  }
}

function resetSyncCursor() {
  syncCursor = 0;
  try {
    localStorage.removeItem(syncCursorStoreKey());
  } catch {}
}

/**
 * Forgets the position in this account's feed without erasing it: the cursor on
 * disk belongs to the login that wrote it, and the next sign-in reads it back.
 * What must not survive is the *loaded* one — a tab that signs into a second
 * account would otherwise page that account's feed from the first one's
 * position.
 */
function forgetSyncCursor() {
  syncCursor = 0;
  syncCursorLoaded = false;
  syncInFlight = false;
  syncAgain = false;
  syncPages = 0;
  syncOwed.clear();
  clearTimeout(syncFlushTimer);
  syncFlushTimer = null;
}

// Asks for the next pass. One at a time: a nudge that arrives while a page is
// being applied is folded into a single owed re-run rather than starting a
// second walk that would race the first one over the same cursor.
function startSyncPump() {
  // The core reads the account feed itself and says what it learned
  // (`onCoreEvent`); a second reader would page the same log twice.
  if (coreSession) return;
  if (!authed || !self?.login) return;
  if (!serverCaps.has('sync-v1')) return;
  loadSyncCursor();
  if (syncInFlight) {
    syncAgain = true;
    return;
  }
  syncInFlight = true;
  syncPages = 0;
  syncAgain = false;
  sendEnvelope({ k: 'sync', since: syncCursor, limit: SYNC_PAGE_LIMIT });
}

function finishSyncPass() {
  syncInFlight = false;
  // The feed's own work must never be the reason a tab dies: `flushSyncOwed`
  // walks HTTP and the store, and a rejection escaping here would be an
  // unhandled one at the top level of a timer.
  void flushSyncOwed().catch(() => {});
  if (syncAgain && authed && socket?.readyState === WebSocket.OPEN) {
    syncAgain = false;
    startSyncPump();
  }
}

function applySyncPage(payload) {
  if (!Array.isArray(payload?.events)) {
    finishSyncPass();
    return;
  }
  syncPages += 1;
  if (payload.reset) {
    // The cursor fell out of the window the server keeps. There is no durable
    // transcript on this side to re-seed from a cursor, so the page that starts
    // from the beginning of the server's log is taken as it comes and the open
    // thread is re-fetched once the pass ends — the same answer the roster
    // already gets from a page that was never loaded.
    resetSyncCursor();
    if (activePeer) queueSyncWork(activePeer);
  }
  for (const event of payload.events) applySyncEvent(event);
  if (Number.isFinite(payload.cursor)) {
    syncCursor = payload.cursor;
    saveSyncCursor(syncCursor);
  }
  if (payload.more && syncPages < SYNC_MAX_PAGES) {
    sendEnvelope({ k: 'sync', since: syncCursor, limit: SYNC_PAGE_LIMIT });
    return;
  }
  // Truncated rather than finished: another pass, from the cursor just stored,
  // picks up where this one stopped.
  if (payload.more) syncAgain = true;
  finishSyncPass();
}

function applySyncEvent(event) {
  if (!event || typeof event.peer !== 'string' || event.peer === '') return;
  const peer = event.peer;
  if (event.kind === 'read') {
    if (event.self) {
      // This account's own reading, on this device or another one: the same
      // thing `read-sync` says, and the badge is what it clears.
      applySyncedRead(peer, event.readTs);
      return;
    }
    // The peer read this account's messages up to `readTs` — a watermark, so
    // every own message at or before it is read, not only the named one.
    applyPeerReadWatermark(
      peer,
      Number.isFinite(event.readTs) ? event.readTs : (Number.isFinite(event.ts) ? event.ts : 0),
      Number.isFinite(event.readAt) ? event.readAt : 0,
      typeof event.via === 'string' ? event.via : '',
    );
    return;
  }
  const thread = threads.get(peer);
  if (event.kind === 'message') {
    const id = typeof event.id === 'string' ? event.id : '';
    if (!id) return;
    if (thread?.seen.has(id)) {
      // Already here: the only thing the feed can add is the fact that the
      // server has committed it, which is exactly what a queued row is waiting
      // to hear (`message-accepted` says the same thing; either arriving first
      // is fine, and both are monotonic). Committed is ✓ — the ✓✓ rung is the
      // peer's device holding it, which this event says nothing about.
      const mark = thread.marks.get(id);
      if (Number.isFinite(event.ts) && event.ts > 0 && mark) mark.dataset.ts = String(event.ts);
      if (mark && mark.dataset.state === 'queued') {
        setMark(mark, 'sent');
        settleCommittedMark(thread, mark);
      }
      return;
    }
    if (thread) queueSyncWork(peer, id);
    return;
  }
  // edit / delete / react: content-bearing changes to a thread this tab has
  // cached. Re-fetching the conversation's newest page is the honest minimal
  // answer — it merges whatever it finds (a tombstone, an edited text, a
  // reaction tally) through the same path an open conversation uses, instead of
  // a second reducer that could disagree with it.
  if (thread) queueSyncWork(peer);
}

function applyPeerReadWatermark(peer, readTs, readAt = 0, readVia = '') {
  if (!Number.isFinite(readTs) || readTs <= 0) return;
  const thread = threads.get(peer);
  if (!thread || readTs < (thread.peerReadTs || 0)) return;
  // Every read mark at or below the watermark, not only the ones this event
  // flips: the client that reached `readTs` read everything up to it — that is
  // what the claim means — so the whole run names the same reader, exactly as
  // the live `read` frame (`applyReceipt`) and a reloaded `/api/history` page
  // (`populateHistory`) do. One rule for one line of text, or the same bubble
  // says «телефон» in one path and «браузер» after a refresh.
  for (const mark of thread.marks.values()) {
    const ts = Number(mark.dataset.ts) || 0;
    if (ts > 0 && ts <= readTs && markCommitted(mark)) setMark(mark, 'read', readAt, readVia);
  }
  if (readTs > thread.peerReadTs) {
    thread.peerReadTs = readTs;
    thread.peerReadAt = readAt;
    thread.peerReadVia = readVia;
    scheduleRosterRender();
  }
}

// The delivered watermark's twin of the function above, and deliberately just
// as blunt: the peer's device holding the newest message it received means it
// holds everything below it too. Every mark in that run becomes ✓✓ (`ack`) —
// *except* one that already says `read`, because a read is the higher rung and
// a mark here must never walk backwards. The accent colour stays the read
// watermark's alone, so these ✓✓ are drawn in the line's own neutral grey.
// `deliveredTs` is `peerDeliveredTs` from `/api/history` and `frame.deliveredTs`
// on a live `ack`; an older server simply sends neither, and then this is a
// no-op.
function applyPeerDeliveredWatermark(thread, deliveredTs) {
  if (!thread || !Number.isFinite(deliveredTs) || deliveredTs <= 0) return;
  for (const mark of thread.marks.values()) {
    const ts = Number(mark.dataset.ts) || 0;
    if (ts > 0 && ts <= deliveredTs && mark.dataset.state !== 'read' && markCommitted(mark)) setMark(mark, 'ack');
  }
  if (deliveredTs > (thread.peerDeliveredTs || 0)) {
    thread.peerDeliveredTs = deliveredTs;
    scheduleRosterRender();
  }
}

function queueSyncWork(peer, id = '') {
  if (typeof peer !== 'string' || peer === '') return;
  const owed = syncOwed.get(peer) || new Set();
  if (id) owed.add(id);
  syncOwed.set(peer, owed);
  if (syncFlushTimer !== null) return;
  syncFlushTimer = setTimeout(() => {
    syncFlushTimer = null;
    void flushSyncOwed();
  }, 0);
}

async function flushSyncOwed() {
  if (syncFlushBusy) return;
  syncFlushBusy = true;
  try {
    while (syncOwed.size > 0) {
      const batch = [...syncOwed.entries()].slice(0, SYNC_REFRESH_LIMIT);
      for (const [peer, ids] of batch) syncOwed.delete(peer);
      for (const [peer, ids] of batch) {
        if (peer === activePeer) {
          // The open conversation has its own live path and its own reconcile;
          // a second writer here would only duplicate it.
          void reconcileActiveThread(peer);
          continue;
        }
        await fillSyncGap(peer, ids);
      }
    }
  } finally {
    syncFlushBusy = false;
  }
}

// The one body that closes a gap for a conversation this tab already holds:
// newest page first (the ordinary case is a message missed while the tab was
// closed, which is at the end of the thread), then a bounded walk backwards for
// anything older. `beforeId` rather than a bare timestamp on every step, for the
// same reason the scroll uses it: a burst of messages can share one `ts`, and a
// timestamp-only boundary either repeats or skips across them.
async function fillSyncGap(peer, ids) {
  const thread = threads.get(peer);
  if (!thread) return;
  let missing = [...ids].filter((id) => !thread.seen.has(id));
  if (ids.size === 0 || missing.length > 0) {
    if (!(await refreshNewestPage(peer))) return;
    missing = missing.filter((id) => !thread.seen.has(id));
  }
  let pages = 0;
  while (missing.length > 0 && pages < SYNC_BACKFILL_MAX_PAGES && thread.loaded && !thread.reachedBeginning) {
    if (!thread.oldestId && !thread.oldestTs) break;
    const known = thread.seen.size;
    await loadOlderMessages(thread);
    pages += 1;
    missing = missing.filter((id) => !thread.seen.has(id));
    if (thread.seen.size === known) break;
  }
  // Still missing after walking to the beginning of what the server has means
  // the message is not there to fetch (a tombstone past the retention window, or
  // one this account hid from its own side). The ids are dropped rather than
  // retried forever — opening the conversation renders exactly what the server
  // returns, which is the whole truth available.
}

// --- Надёжная отправка ---------------------------------------------------
//
// A message is not sent because the socket took the frame. `sendFrame` returns
// false whenever this session is subscribed to another conversation — the
// ordinary state of a tab whose peer was switched a moment ago — and it returns
// true whenever the write merely reached the socket, which says nothing about
// whether the server committed it: the socket can die before the answer comes,
// and the hub can drop the frame over its own frame budget. The submit path
// used to render the message, ignore that return value and clear the composer,
// so the message existed on one screen only — the sender saw «отправлено», the
// peer never got it, and the text was gone from the draft with nothing left to
// retry from.
//
// What replaces it: the entry is written to storage *before* the first attempt
// and removed only by proof — `message-accepted` for that id, or the message
// turning up in a history page (which is proof of the same thing). A lost ack,
// a reload, a closed tab, a dead socket all leave it where it is and the same id
// goes out again. Reusing the id is what makes the retry idempotent at the
// server (`findHistoryMessage` answers a repeat with the receipt the first
// attempt missed), so the peer sees one message however many attempts it takes.
const PENDING_SENDS_KEY = 'tailchat-pending-sends';
// How often an unanswered entry is offered to the socket again. Short enough
// that a blip is invisible, long enough not to be a loop.
const PENDING_RETRY_MS = 3000;
// A bound on what one conversation may hold: the list is stored whole, and a
// queue nobody can see the end of is worse than a lost message. The oldest
// unanswered entries are dropped past this, each keeping its ⚠ row.
const PENDING_LIMIT = 50;
let pendingSends = new Map(); // peer -> [{ id, ts, text, replyTo }]
let pendingLoaded = false;
let pendingTimer = null;

function pendingStoreKey() {
  return `${PENDING_SENDS_KEY}:${self?.login || ''}`;
}

// Read once per page load, after `ready` has said which account this is: the
// queue is per account, and a tab that has not authenticated yet does not know
// which key to read.
function loadPendingSends() {
  if (pendingLoaded || !self?.login) return;
  pendingLoaded = true;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(pendingStoreKey()) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return;
  for (const [peer, entries] of Object.entries(stored)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const kept = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || entry.id === '') continue;
      if (typeof entry.text !== 'string') continue;
      kept.push({
        id: entry.id,
        ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
        text: entry.text,
        replyTo: entry.replyTo && typeof entry.replyTo === 'object' ? entry.replyTo : null,
      });
    }
    if (kept.length > 0) pendingSends.set(peer, kept.slice(-PENDING_LIMIT));
  }
}

function savePendingSends() {
  const payload = {};
  for (const [peer, entries] of pendingSends) if (entries.length > 0) payload[peer] = entries;
  try {
    if (Object.keys(payload).length === 0) localStorage.removeItem(pendingStoreKey());
    else localStorage.setItem(pendingStoreKey(), JSON.stringify(payload));
  } catch {
    // Storage refused the write (private browsing, quota). The queue still
    // exists in memory and still retries; what it loses is surviving a reload.
  }
}

function pendingFor(peer) {
  return pendingSends.get(peer) || [];
}

/**
 * Drops the in-memory queue without touching storage.
 *
 * Called when the session ends. The entries themselves stay on disk under the
 * login they were written for — a sign-out is not the user throwing away what
 * they wrote, and signing back in has to find it again — but nothing of this
 * account may be left loaded for whoever signs in next in the same tab.
 */
function forgetPendingSends() {
  pendingSends = new Map();
  pendingLoaded = false;
  clearInterval(pendingTimer);
  pendingTimer = null;
}

function rememberPendingSend(peer, entry) {
  const entries = pendingFor(peer).filter((item) => item.id !== entry.id);
  entries.push(entry);
  pendingSends.set(peer, entries.slice(-PENDING_LIMIT));
  savePendingSends();
  schedulePendingRetry();
}

/** The message is the server's now: it leaves the queue for good. */
function forgetPendingSend(peer, id) {
  const entries = pendingFor(peer).filter((item) => item.id !== id);
  if (entries.length === 0) pendingSends.delete(peer);
  else pendingSends.set(peer, entries);
  savePendingSends();
}

// A send the server answered with a refusal. It leaves the queue — retrying an
// id the server has rejected as a conflict would never be accepted — and the
// row says so instead of showing a clock forever.
function failPendingSend(peer, id, reason) {
  const entry = pendingFor(peer).find((item) => item.id === id);
  forgetPendingSend(peer, id);
  const thread = threads.get(peer);
  const mark = thread?.marks.get(id);
  if (mark) {
    setMark(mark, 'failed');
    scheduleRosterRender();
    mark.title = errorText(reason);
  }
}

// Offers every unanswered entry to the socket, oldest first per conversation so
// a queue cannot be reordered by its own retries. A frame that could not be
// routed leaves the entry where it is and stops that conversation's queue: the
// ones behind it were written after it and have no business overtaking it.
function flushPendingSends(onlyPeer = null) {
  let waiting = false;
  for (const [peer, entries] of [...pendingSends]) {
    if (onlyPeer !== null && peer !== onlyPeer) {
      waiting = waiting || entries.length > 0;
      continue;
    }
    for (const entry of [...entries]) {
      const frame = { t: 'msg', id: entry.id, ts: entry.ts, text: entry.text };
      if (entry.replyTo) frame.replyTo = entry.replyTo;
      if (!sendMessageFrame(peer, frame)) {
        waiting = true;
        break;
      }
    }
  }
  schedulePendingRetry(waiting);
}

function schedulePendingRetry(waiting) {
  const anyPending = waiting === undefined
    ? [...pendingSends.values()].some((entries) => entries.length > 0)
    : waiting;
  if (!anyPending) {
    clearInterval(pendingTimer);
    pendingTimer = null;
    return;
  }
  if (pendingTimer !== null) return;
  pendingTimer = setInterval(() => {
    if (pendingSends.size === 0) {
      clearInterval(pendingTimer);
      pendingTimer = null;
      return;
    }
    flushPendingSends();
  }, PENDING_RETRY_MS);
}

// The rows themselves, for a page that was just loaded from history: a pending
// message is not in the server's answer (that is the whole point of it being
// pending), so nothing else would draw it. Called from `populateHistory`, which
// every path that fills a thread goes through.
function ensurePendingRows(thread, peer) {
  // The core's own queue, under its flag: the texts it holds unsent are drawn on
  // the clock (or ⚠) here too, which is how they survive a reload.
  for (const row of coreSession ? coreSession.conversation(peer, 200) : []) {
    // An unsent edit's carrier is not a message of its own (it has no bubble).
    if (row.source !== 'pending' || row.editOf || thread.marks.has(row.id)) continue;
    appendMessage(thread, {
      id: row.id,
      own: true,
      kind: 'human',
      author: self?.name || self?.login,
      text: row.text,
      ts: row.ts,
      queued: true,
      replyTo: row.replyTo || null,
      forwardedFrom: row.forwardedFrom || null,
    });
    const mark = thread.marks.get(row.id);
    if (mark && row.receipt === 'failed') setMark(mark, 'failed');
  }
  for (const entry of pendingFor(peer)) {
    if (thread.marks.has(entry.id)) continue;
    appendMessage(thread, {
      id: entry.id,
      own: true,
      kind: 'human',
      author: self?.name || self?.login,
      text: entry.text,
      ts: entry.ts,
      queued: true,
      replyTo: entry.replyTo || null,
    });
  }
}

// `message-accepted` is the only proof that ends the queue for one message.
// The row's own timestamp follows the server's for the reason Android's does
// (`MessageDao.confirm`): the peer's read watermark is measured against the
// stored time, so a row that kept a skewed local clock could never be turned
// into ✓✓ no matter how many times it was read.
function acceptPendingSend(peer, id, ts) {
  const entry = pendingFor(peer).find((item) => item.id === id);
  if (entry) forgetPendingSend(peer, id);
  const thread = threads.get(peer);
  const mark = thread?.marks.get(id);
  if (!mark) return;
  if (Number.isFinite(ts) && ts > 0) mark.dataset.ts = String(ts);
  // Committed is ✓, never the ✓✓ that only the peer's own device can claim —
  // unless the thread's watermarks already passed it, which they skipped while
  // it was queued (`settleCommittedMark`) — and never backwards: a receipt that
  // already arrived (their `ack`, or a `read`) stands, since a late acceptance
  // cannot unsee the message.
  if (mark.dataset.state !== 'read' && mark.dataset.state !== 'ack') {
    setMark(mark, 'sent');
    settleCommittedMark(thread, mark);
  }
}

// A sealed action the core would not take (it has stopped, or the call is not
// in this core): the row it was drawn for turns ⚠ and says why. It is never
// offered to the socket as an open frame instead.
function failCoreSend(thread, id) {
  const mark = thread.marks.get(id);
  if (mark) {
    setMark(mark, 'failed');
    mark.title = t('connOffline');
  }
  scheduleRosterRender();
}

function onComposerSubmit(event) {
  event.preventDefault();
  hideCommandPalette();
  // `token` rather than `authed`: a session is what a message needs, not a live
  // socket. `authed` is false for the whole duration of a reconnect — every
  // Wi-Fi↔LTE handoff, every server restart, every tab woken from a suspend —
  // and refusing there meant the typed message was neither sent nor queued: the
  // composer kept it, so a person who then switched conversations or reloaded
  // the tab lost what they wrote. With a durable queue there is nothing to
  // refuse: the row is drawn on the clock immediately and goes out when the
  // socket comes back, under the id already written down.
  if (!activePeer || !token) return;
  const raw = elements.input.value;
  const text = raw.trim();
  if (text === '') return;

  if (composerContext?.mode === 'edit') {
    editMessage(composerContext.id, text);
    clearComposer();
    return;
  }

  if (text.startsWith('/')) {
    executeCommand(text);
    clearComposer();
    return;
  }

  const thread = threadFor(activePeer);
  const id = `m-${randomHex(12)}`;
  const ts = Date.now();
  const replyTo = composerContext?.mode === 'reply' ? {
    id: composerContext.id,
    from: composerContext.from,
    author: composerContext.authorName || undefined,
    text: composerContext.snippet,
    media: composerContext.media,
  } : null;

  appendMessage(thread, {
    id, own: true, kind: 'human', author: self.name, text, ts, replyTo, queued: true,
  });
  scrollToLatest(true);

  // On the core a text — a reply too, its quote sealed with it — goes into its
  // durable queue (IndexedDB, before the socket) and its mark follows the
  // core's notices. A text the core refuses is a ⚠, never the page's own open
  // queue: in an encrypted conversation that would write it in the clear.
  if (coreSession) {
    const handed = replyTo
      ? coreSession.sendWith(activePeer, id, text, { replyTo })
      : coreSession.sendText(activePeer, id, text);
    if (handed) {
      playSound('sent');
      stopTyping();
      clearComposer();
      return;
    }
    // `false` is a core that has stopped or has no client — not "this
    // conversation is open", so a plain text is no safer than a reply to hand
    // to the page's own queue: that one writes it in the clear.
    failCoreSend(thread, id);
    clearComposer();
    return;
  }

  // Queued before the first attempt, not after a failure: the tab can be closed
  // between the two lines below, and a queue that only remembers what it failed
  // to send is a queue that forgets the send that killed the tab.
  rememberPendingSend(activePeer, {
    id, ts, text, replyTo: replyTo ? {
      id: replyTo.id,
      from: replyTo.from,
      author: replyTo.author,
      text: replyTo.text,
      media: replyTo.media,
    } : null,
  });
  flushPendingSends(activePeer);
  playSound('sent');
  stopTyping();

  clearComposer();
}

// Cmd/Ctrl+B, +I and +U wrap the selection — or the word the caret sits in —
// in the markers the transcript renders as bold, italic and underline (see
// `appendEmphasis`). Pressing the same shortcut again takes them off, so the
// keys behave like the toggles every other editor has taught people to expect.
const DRAFT_FORMATS = { b: '**', i: '*', u: '__' };

// A run of the marker character longer than the marker itself is not a match:
// the single `*` inside `**bold**` is not italics.
function markerStartsAt(value, at, marker) {
  if (value.slice(at, at + marker.length) !== marker) return false;
  return value[at + marker.length] !== marker[0];
}

function markerEndsAt(value, at, marker) {
  if (at < marker.length) return false;
  if (value.slice(at - marker.length, at) !== marker) return false;
  return value[at - marker.length - 1] !== marker[0];
}

function wordRangeAt(value, pos) {
  let start = pos;
  let end = pos;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return [start, end];
}

function applyDraftFormat(marker) {
  const input = elements.input;
  const value = input.value;
  let start = input.selectionStart ?? value.length;
  let end = input.selectionEnd ?? start;
  if (start === end) [start, end] = wordRangeAt(value, start);
  // Nothing under the caret and nothing selected: there is no word to wrap,
  // and inserting empty markers would only be in the way.
  if (start === end) return;
  const inner = value.slice(start, end);
  const len = marker.length;
  let next;
  let from;
  let to;
  if (inner.length > len * 2 && markerStartsAt(inner, 0, marker) && markerEndsAt(inner, inner.length, marker)) {
    const bare = inner.slice(len, -len);
    next = value.slice(0, start) + bare + value.slice(end);
    from = start;
    to = start + bare.length;
  } else if (markerEndsAt(value, start, marker) && markerStartsAt(value, end, marker)) {
    next = value.slice(0, start - len) + inner + value.slice(end + len);
    from = start - len;
    to = from + inner.length;
  } else {
    next = value.slice(0, start) + marker + inner + marker + value.slice(end);
    from = start + len;
    to = from + inner.length;
  }
  setComposerValue(next);
  input.setSelectionRange(from, to);
  if (activePeer) stashDraft(activePeer);
}

// CLI overloads its bold key for this because it has no inline bold at all;
// web keeps inline bold (useful on a word or a one-line selection) and only
// takes over the same key when the draft already spans multiple lines —
// bolding a pasted block across lines was never really the point of «select
// a word, press the format key», and this is what pasted code is for.
function wrapDraftAsCode() {
  const value = elements.input.value;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('```')) return;
  setComposerValue(`\`\`\`\n${value}\n\`\`\``);
  if (activePeer) stashDraft(activePeer);
}

function onComposerKeydown(event) {
  if (!elements.commandPalette.hidden && paletteMatches.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      paletteIndex = (paletteIndex + 1) % paletteMatches.length;
      renderCommandPalette();
      const chosen = paletteMatches[paletteIndex];
      if (chosen) {
        elements.input.value = chosen.name + (chosen.args ? ' ' : '');
        elements.composerGrow.dataset.value = elements.input.value;
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      paletteIndex = (paletteIndex - 1 + paletteMatches.length) % paletteMatches.length;
      renderCommandPalette();
      const chosen = paletteMatches[paletteIndex];
      if (chosen) {
        elements.input.value = chosen.name + (chosen.args ? ' ' : '');
        elements.composerGrow.dataset.value = elements.input.value;
      }
      return;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      const chosen = paletteMatches[paletteIndex];
      if (chosen) applyCommandMatch(chosen);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideCommandPalette();
      return;
    }
  }

  // The palette owns the keyboard while it is up, so a shortcut typed into a
  // half-written command is left to it.
  const paletteCapturing = !elements.commandPalette.hidden && paletteMatches.length > 0;
  if (
    !paletteCapturing && event.key === 'ArrowUp' && !event.shiftKey && !event.altKey
    && !event.ctrlKey && !event.metaKey && elements.input.value === ''
  ) {
    if (editLastOwnMessage()) {
      event.preventDefault();
      return;
    }
  }
  if (!paletteCapturing && (event.metaKey || event.ctrlKey) && !event.altKey) {
    const marker = DRAFT_FORMATS[event.key.toLowerCase()];
    // Ctrl+B and Ctrl+I also toggle the side panes from a `window` listener;
    // typed into the composer they are formatting keys and nothing else, so
    // the event is stopped here rather than allowed to do both.
    if (marker) {
      event.preventDefault();
      event.stopPropagation();
      if (marker === '**' && elements.input.value.includes('\n')) wrapDraftAsCode();
      else applyDraftFormat(marker);
      return;
    }
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
}

function onComposerInput() {
  const val = elements.input.value;
  syncComposerMirror(val);
  elements.sendButton.disabled = !val.trim();
  resizeComposer();
  if (activePeer) stashDraft(activePeer);
  updateCommandPalette(val);
  if (typingEnabled) reportTyping();
}

// --- Привязка событий ---------------------------------------------------

function bindEvents() {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
  });

  if (elements.authThemeBtn) elements.authThemeBtn.addEventListener('click', cycleTheme);
  if (elements.modeBtn) elements.modeBtn.addEventListener('click', cycleColorMode);
  if (elements.authModeBtn) elements.authModeBtn.addEventListener('click', cycleColorMode);
  if (elements.settingsBtn) elements.settingsBtn.addEventListener('click', openSettingsDialog);
  if (elements.soundToggleBtn) {
    elements.soundToggleBtn.addEventListener('click', () => {
      setSoundState(!soundEnabled);
      if (soundEnabled) playSound('received');
    });
  }
  if (elements.settingsCloseBtn) elements.settingsCloseBtn.addEventListener('click', closeSettingsDialog);
  if (elements.settingsDialog) {
    elements.settingsDialog.addEventListener('click', (event) => {
      if (event.target === elements.settingsDialog) closeSettingsDialog();
    });
  }
  if (elements.modeGroup) {
    elements.modeGroup.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setColorMode(btn.dataset.mode));
    });
  }
  if (elements.schemeGroup) {
    elements.schemeGroup.querySelectorAll('[data-scheme]').forEach((btn) => {
      btn.addEventListener('click', () => setTheme(btn.dataset.scheme, { persist: true }));
    });
  }
  if (elements.fontGroup) {
    elements.fontGroup.querySelectorAll('[data-font]').forEach((btn) => {
      btn.addEventListener('click', () => setFont(btn.dataset.font));
    });
  }
  if (elements.roundGroup) {
    elements.roundGroup.querySelectorAll('[data-round]').forEach((btn) => {
      btn.addEventListener('click', () => setRound(btn.dataset.round));
    });
  }
  if (elements.settingsBorders) {
    elements.settingsBorders.addEventListener('change', () => setBorders(elements.settingsBorders.checked));
  }
  if (elements.settingsDepth) {
    elements.settingsDepth.addEventListener('change', () => setDepth(elements.settingsDepth.checked));
  }
  if (elements.wallpaperGroup) {
    elements.wallpaperGroup.querySelectorAll('[data-wallpaper]').forEach((btn) => {
      btn.addEventListener('click', () => setWallpaper(btn.dataset.wallpaper));
    });
  }
  if (elements.settingsSound) {
    elements.settingsSound.addEventListener('change', () => {
      const enabled = elements.settingsSound.checked;
      setSoundState(enabled);
      // Same reasoning as the send-sound toggle below: flipping this on is
      // the one moment a person can judge the redesigned cue without
      // waiting for a real message to arrive.
      if (enabled) playSound('received');
    });
  }
  if (elements.settingsSoundSend) {
    elements.settingsSoundSend.addEventListener('change', () => {
      sendSoundEnabled = elements.settingsSoundSend.checked;
      try { localStorage.setItem(SEND_SOUND_KEY, String(sendSoundEnabled)); } catch {}
      if (sendSoundEnabled) playSound('sent');
    });
  }
  if (elements.settingsVolume) {
    elements.settingsVolume.addEventListener('input', () => {
      setSoundVolume(Number(elements.settingsVolume.value) / 100);
    });
    // Preview once the thumb is let go, not on every `input` tick while
    // dragging — a note fired per pixel of drag would just be noise, and
    // overlapping the still-decaying previous one would sound worse than
    // anything this slider is trying to fix.
    elements.settingsVolume.addEventListener('change', () => {
      if (soundEnabled) playSound('received');
    });
  }
  if (elements.settingsSoundPickBtn && elements.settingsSoundFile) {
    elements.settingsSoundPickBtn.addEventListener('click', () => {
      // The value is cleared first so re-picking the same file still fires
      // `change` (the browser suppresses it when the selection is identical).
      elements.settingsSoundFile.value = '';
      elements.settingsSoundFile.click();
    });
    elements.settingsSoundFile.addEventListener('change', () => {
      void importCustomSound(elements.settingsSoundFile.files?.[0] || null);
    });
  }
  if (elements.settingsSoundResetBtn) {
    elements.settingsSoundResetBtn.addEventListener('click', () => {
      void resetCustomSound();
    });
  }
  if (elements.settingsNotify) {
    elements.settingsNotify.addEventListener('change', () => {
      void setNotifyState(elements.settingsNotify.checked, true);
    });
  }
  if (elements.settingsTyping) {
    elements.settingsTyping.addEventListener('change', () => {
      typingEnabled = elements.settingsTyping.checked;
      try { localStorage.setItem(TYPING_KEY, String(typingEnabled)); } catch {}
      if (!typingEnabled) stopTyping();
    });
  }
  if (elements.settingsShowDeleted) {
    elements.settingsShowDeleted.addEventListener('change', () => {
      setShowDeletedMessages(elements.settingsShowDeleted.checked);
    });
  }
  if (elements.settingsHoliday) {
    elements.settingsHoliday.addEventListener('change', () => {
      holidayMode = elements.settingsHoliday.checked;
      try { localStorage.setItem(HOLIDAY_KEY, String(holidayMode)); } catch {}
      animateLogo();
    });
  }
  if (elements.settingsLinkPreview) {
    elements.settingsLinkPreview.addEventListener('change', () => {
      linkPreviewEnabled = elements.settingsLinkPreview.checked;
      try { localStorage.setItem(LINK_PREVIEW_KEY, String(linkPreviewEnabled)); } catch {}
      for (const thread of threads.values()) for (const row of thread.node.querySelectorAll('.row')) {
        const bubble = row.querySelector('.bubble');
        if (bubble) maybeAttachLinkPreview(row, bubble, row.messageText || '');
      }
    });
  }
  if (elements.settingsProfileBtn) {
    elements.settingsProfileBtn.addEventListener('click', () => {
      closeSettingsDialog();
      openProfileDialog();
    });
  }
  elements.settingsBackupCreateBtn?.addEventListener('click', () => runCoreE2eeFromSettings('/backup', 'create'));
  elements.settingsBackupStatusBtn?.addEventListener('click', () => runCoreE2eeFromSettings('/backup', 'status'));
  elements.settingsBackupRestoreBtn?.addEventListener('click', () => runCoreE2eeFromSettings('/backup', 'restore'));
  elements.settingsKeysResetBtn?.addEventListener('click', () => runCoreE2eeFromSettings('/keys', 'reset'));
  // `prefers-color-scheme` moving under `auto` has to repaint immediately:
  // the OS switching to night mode is exactly the case `auto` exists for.
  darkQuery.addEventListener('change', () => {
    if (currentMode === 'auto') applyMode();
  });
  if (elements.directBtn) elements.directBtn.addEventListener('click', toggleDirectLink);
  if (elements.toggleRosterBtn) elements.toggleRosterBtn.addEventListener('click', () => togglePane('roster'));
  if (elements.toggleInfoBtn) elements.toggleInfoBtn.addEventListener('click', () => togglePane('info'));
  if (elements.conversationMenuButton) {
    // `stopPropagation` is what keeps the menu on screen: `closeRosterMenu` is
    // bound to the window's click event, so a menu appended by a handler that
    // lets the click through is removed again in the same dispatch — the ⋮
    // looked like a dead button.
    elements.conversationMenuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openConversationMenu(elements.conversationMenuButton);
    });
  }
  if (elements.infoCloseBtn) {
    elements.infoCloseBtn.addEventListener('click', () => {
      if (wide.matches) setPaneVisible('info', false);
      else revealTalkPane();
      syncPaneButtons();
    });
  }
  if (elements.talkPeerBtn) {
    elements.talkPeerBtn.addEventListener('click', () => {
      if (wide.matches && paneVisible('info')) return;
      togglePane('info');
    });
  }
  if (elements.infoWakeBtn) elements.infoWakeBtn.addEventListener('click', () => executeCommand('/wake'));
  if (elements.infoExportBtn) elements.infoExportBtn.addEventListener('click', exportHistory);
  elements.infoSafetyConfirm?.addEventListener('click', () => {
    const code = activePeer ? safetyCodes.get(activePeer) : null;
    if (!coreE2ee || code?.status !== 'ready' || !code.masterKey) return;
    coreE2ee.confirmSafetyCode(activePeer, code.masterKey);
  });
  elements.infoSafetyTrust?.addEventListener('click', () => {
    if (!coreE2ee || !activePeer) return;
    runCoreE2eeCommand('/trust', '');
    forgetSafetyCodes(activePeer);
    renderInfoPanel();
  });
  if (elements.infoClearBtn) elements.infoClearBtn.addEventListener('click', () => executeCommand('/clear'));
  if (elements.infoPingBtn) elements.infoPingBtn.addEventListener('click', () => executeCommand('/ping'));

  // Панели переключаются с клавиатуры так же, как панели в терминальных
  // мультиплексорах: без ухода из поля ввода.
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'b' && key !== 'i') return;
    if (elements.app.hidden) return;
    event.preventDefault();
    togglePane(key === 'b' ? 'roster' : 'info');
  });

  if (elements.voiceButton) elements.voiceButton.addEventListener('click', startVoiceRecording);
  if (elements.voiceCancelBtn) elements.voiceCancelBtn.addEventListener('click', cancelVoiceRecording);
  if (elements.voiceSendBtn) elements.voiceSendBtn.addEventListener('click', stopVoiceRecordingAndSend);

  if (elements.passToggleBtn && elements.fieldPassword) {
    elements.passToggleBtn.addEventListener('click', () => {
      const isPass = elements.fieldPassword.type === 'password';
      elements.fieldPassword.type = isPass ? 'text' : 'password';
      elements.passToggleBtn.innerHTML = isPass
        ? '<svg class="icon" aria-hidden="true"><use href="#icon-eye-off"></use></svg>'
        : '<svg class="icon" aria-hidden="true"><use href="#icon-eye"></use></svg>';
      const lbl = isPass ? t('passToggleHide') : t('passToggleShow');
      elements.passToggleBtn.title = lbl;
      elements.passToggleBtn.setAttribute('aria-label', lbl);
    });
  }
  if (elements.passConfirmToggleBtn && elements.fieldPasswordConfirm) {
    elements.passConfirmToggleBtn.addEventListener('click', () => {
      const isPass = elements.fieldPasswordConfirm.type === 'password';
      elements.fieldPasswordConfirm.type = isPass ? 'text' : 'password';
      elements.passConfirmToggleBtn.innerHTML = isPass
        ? '<svg class="icon" aria-hidden="true"><use href="#icon-eye-off"></use></svg>'
        : '<svg class="icon" aria-hidden="true"><use href="#icon-eye"></use></svg>';
      const lbl = isPass ? t('passToggleHide') : t('passToggleShow');
      elements.passConfirmToggleBtn.title = lbl;
      elements.passConfirmToggleBtn.setAttribute('aria-label', lbl);
    });
  }
  if (elements.extraPassToggleBtn && elements.fieldExtraPassword) {
    elements.extraPassToggleBtn.addEventListener('click', () => {
      const isPass = elements.fieldExtraPassword.type === 'password';
      elements.fieldExtraPassword.type = isPass ? 'text' : 'password';
      elements.extraPassToggleBtn.innerHTML = isPass
        ? '<svg class="icon" aria-hidden="true"><use href="#icon-eye-off"></use></svg>'
        : '<svg class="icon" aria-hidden="true"><use href="#icon-eye"></use></svg>';
      const lbl = isPass ? t('passToggleHide') : t('passToggleShow');
      elements.extraPassToggleBtn.title = lbl;
      elements.extraPassToggleBtn.setAttribute('aria-label', lbl);
    });
  }

  elements.authSwitch.addEventListener('click', onAuthSwitch);
  if (elements.authForgotBtn) {
    elements.authForgotBtn.addEventListener('click', () => {
      setMode('recover');
      elements.fieldLogin.focus();
    });
  }
  elements.authForm.addEventListener('submit', onAuthSubmit);
  if (elements.logoutButton) elements.logoutButton.addEventListener('click', logout);
  if (elements.profileOpenButton) elements.profileOpenButton.addEventListener('click', openProfileDialog);
  if (elements.railSelfButton) elements.railSelfButton.addEventListener('click', openProfileDialog);
  if (elements.profileCloseButton) elements.profileCloseButton.addEventListener('click', closeProfileDialog);
  if (elements.profileCancelButton) elements.profileCancelButton.addEventListener('click', closeProfileDialog);
  if (elements.profileForm) elements.profileForm.addEventListener('submit', onProfileSubmit);
  if (elements.profileExtraPasswordEnabled) {
    elements.profileExtraPasswordEnabled.addEventListener('change', syncProfileExtraPasswordRows);
  }
  if (elements.attachButton) elements.attachButton.addEventListener('click', () => elements.fileInput?.click());
  if (elements.emojiButton) {
    preserveFocusOnPointerDown(elements.emojiButton);
    elements.emojiButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleEmojiPicker(event);
    });
  }
  if (elements.composerContextCancel) {
    elements.composerContextCancel.addEventListener('click', cancelComposerContext);
  }
  if (elements.fileInput) {
    elements.fileInput.addEventListener('change', () => {
      queueBrowserFiles([...elements.fileInput.files]);
      elements.fileInput.value = '';
    });
  }
  bindImageLightbox();
  bindImageSheet();
  if (elements.sendButton) {
    // A submit button takes focus on touch before `submit` runs, which closes
    // the iOS/Android keyboard. Keep the textarea focused and submit from the
    // same touch gesture; desktop click and keyboard submit stay native.
    elements.sendButton.addEventListener('touchstart', (event) => {
      event.preventDefault();
    }, { passive: false });
    elements.sendButton.addEventListener('touchend', (event) => {
      event.preventDefault();
      if (!elements.sendButton.disabled) {
        elements.composer.requestSubmit(elements.sendButton);
      }
    }, { passive: false });
  }
  elements.backButton.addEventListener('click', onBackToList);
  elements.composer.addEventListener('submit', onComposerSubmit);
  elements.input.addEventListener('keydown', onComposerKeydown);
  elements.input.addEventListener('input', onComposerInput);

  elements.inviteOpenButton.addEventListener('click', openInviteDialog);
  elements.inviteCloseButton.addEventListener('click', closeInviteDialog);
  elements.generateInviteButton.addEventListener('click', onGenerateInvite);
  elements.copyInviteButton.addEventListener('click', onCopyInvite);
  elements.acceptInviteForm.addEventListener('submit', onAcceptInviteSubmit);
  elements.friendRequestForm.addEventListener('submit', onFriendRequestSubmit);

  if (elements.recCloseBtn) {
    elements.recCloseBtn.addEventListener('click', () => {
      elements.recoveryDialog?.close();
      showApp();
      refreshRoster();
      connectSocket();
      checkPendingInvite();
    });
  }
  if (elements.recContinueBtn) {
    elements.recContinueBtn.addEventListener('click', () => {
      elements.recoveryDialog?.close();
      showApp();
      refreshRoster();
      connectSocket();
      checkPendingInvite();
    });
  }
  if (elements.recCopyBtn) {
    elements.recCopyBtn.addEventListener('click', onCopyRecoveryKey);
  }

  if (elements.logoBand) {
    elements.logoBand.addEventListener('click', () => {
      // Two things happen on a tap: the wordmark is retyped (the /logo
      // animation), and the band itself pulses. The retype alone is easy to
      // miss on a fast machine — the pulse is what makes the tap feel like it
      // landed. Restarted by hand because re-adding a class that is already
      // there does not replay a CSS animation.
      const art = elements.logoArt;
      if (art) {
        art.classList.remove('logo-art--pulse');
        // Reading offsetWidth forces the style flush that makes the removal
        // take effect before the class goes back on.
        void art.offsetWidth;
        art.classList.add('logo-art--pulse');
        art.addEventListener('animationend', () => art.classList.remove('logo-art--pulse'), { once: true });
      }
      animateLogo();
      playSound('sent');
    });
  }

  if (elements.scrollBottomBtn) {
    elements.scrollBottomBtn.addEventListener('click', () => {
      if (elements.transcript) {
        elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: 'smooth' });
      }
      unreadBelowCount = 0;
      updateScrollButton();
    });
  }

  if (elements.transcript) {
    elements.transcript.addEventListener('scroll', () => {
      const container = elements.transcript;
      noteTranscriptScroll();
      if (container.scrollTop < 80 && container.scrollHeight > container.clientHeight + 50) {
        const activeThread = activePeer ? threads.get(activePeer) : null;
        if (activeThread && activeThread.loaded && activeThread.readyForScrollLoad && !activeThread.loadingOlder && !activeThread.reachedBeginning) {
          void loadOlderMessages(activeThread);
        }
      }
      if (transcriptAtBottom()) {
        unreadBelowCount = 0;
        flushReadReceipts();
      }
      updateScrollButton();
    });
  }

  window.addEventListener('paste', (event) => {
    if (!activePeer || !authed) return;
    const images = [...(event.clipboardData?.items || [])]
      .filter((item) => item.type?.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    queueBrowserFiles(images);
  });

  // Dropping a file on the conversation is the same action as the paperclip,
  // and the drag has to be accepted on the whole talk column or the browser
  // navigates away to the dropped file instead.
  const dropZone = elements.transcript?.parentElement || elements.transcript;
  if (dropZone) {
    for (const event of ['dragenter', 'dragover']) {
      dropZone.addEventListener(event, (e) => {
        if (!activePeer || !authed) return;
        e.preventDefault();
        dropZone.classList.add('drop-target');
      });
    }
    for (const event of ['dragleave', 'drop']) {
      dropZone.addEventListener(event, () => dropZone.classList.remove('drop-target'));
    }
    dropZone.addEventListener('drop', (e) => {
      if (!activePeer || !authed) return;
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length === 0) return;
      e.preventDefault();
      queueBrowserFiles(files);
    });
  }

  // The band's width changes with the window and with either side panel
  // opening or closing, and a clipped wordmark is the bug this guards.
  window.addEventListener('resize', fitLogoBand);

  window.addEventListener('click', closeMessageMenu);
  window.addEventListener('resize', closeMessageMenu);
  elements.transcript?.addEventListener('scroll', closeMessageMenu);
  window.addEventListener('click', closeRosterMenu);
  window.addEventListener('resize', closeRosterMenu);
  elements.rosterList?.addEventListener('scroll', closeRosterMenu);
  window.addEventListener('click', closeEmojiPicker);
  window.addEventListener('resize', placeEmojiPicker);
  document.addEventListener('copy', copyEmojiAsText);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMessageMenu();
      closeEmojiPicker();
      // Escape also leaves the selection: it is the one key that cancels
      // whatever the pointer is in the middle of.
      exitSelectionMode();
    }
  });

  bindPresenceSignal();

  wide.addEventListener('change', onLayoutChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('beforeunload', releaseAttachmentUrls);
  window.addEventListener('beforeunload', releaseCustomSoundUrl);
}

function showRecoveryDialog(key) {
  if (!elements.recoveryDialog) {
    showApp();
    refreshRoster();
    connectSocket();
    return;
  }
  if (elements.recKeyInput) elements.recKeyInput.value = key;
  if (elements.recCopyStatus) elements.recCopyStatus.textContent = '';
  elements.recoveryDialog.showModal();
}

async function onCopyRecoveryKey() {
  const code = elements.recKeyInput?.value || '';
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    if (elements.recCopyStatus) {
      elements.recCopyStatus.textContent = t('recCopied');
      elements.recCopyStatus.className = 'modal-status success';
    }
  } catch {
    if (elements.recKeyInput) {
      elements.recKeyInput.select();
      elements.recKeyInput.setSelectionRange(0, 99999);
    }
  }
}

// --- Старт приложения ---------------------------------------------------

async function boot() {
  if (!token) {
    showAuth();
    checkPendingInvite();
    return;
  }
  try {
    const data = await request('GET', '/me');
    self = data.user;
    renderSelfIdentity();
    showApp();
    await refreshRoster();
    connectSocket();
    checkPendingInvite();
  } catch (err) {
    console.warn('[Tailchat] Failed to resume session:', err);
    expireSession();
  } finally {
    if (elements.boot) elements.boot.hidden = true;
  }
}

function showAuth() {
  elements.boot.hidden = true;
  elements.app.hidden = true;
  elements.auth.hidden = false;
  elements.fieldLogin.focus();
  if (swRegistration) swRegistration.update().catch(() => {});
}

function showApp() {
  elements.boot.hidden = true;
  elements.auth.hidden = true;
  elements.app.hidden = false;
  elements.app.dataset.pane = activePeer ? 'talk' : 'list';
  animateLogo();
}

function setMode(next) {
  mode = next;
  const isRegister = mode === 'register';
  const isRecover = mode === 'recover';
  // A prior "extra password required" prompt belongs to that attempt only;
  // switching auth tabs abandons it rather than carrying a stale field over.
  needExtraPassword = false;
  if (elements.fieldExtraPasswordRow) elements.fieldExtraPasswordRow.hidden = true;
  if (elements.fieldExtraPassword) elements.fieldExtraPassword.value = '';

  if (isRecover) {
    elements.authTitle.textContent = t('authTitleRecover');
    elements.authLead.textContent = t('authLeadRecover');
    if (elements.fieldNameRow) elements.fieldNameRow.hidden = true;
    if (elements.fieldPasswordConfirmRow) elements.fieldPasswordConfirmRow.hidden = true;
    if (elements.fieldRecoveryRow) elements.fieldRecoveryRow.hidden = false;
    elements.hintLogin.hidden = true;
    elements.hintPassword.textContent = t('hintPasswordRecover');
    elements.hintPassword.hidden = false;
    elements.authSubmit.textContent = t('authSubmitRecover');
    elements.authSwitchNote.textContent = t('authSwitchNoteRecover');
    elements.authSwitch.textContent = t('authSwitchRecover');
    if (elements.authForgotBtn) elements.authForgotBtn.hidden = true;
    elements.fieldPassword.autocomplete = 'new-password';
  } else if (isRegister) {
    elements.authTitle.textContent = t('authTitleRegister');
    elements.authLead.textContent = t('authLeadRegister');
    if (elements.fieldNameRow) elements.fieldNameRow.hidden = false;
    if (elements.fieldPasswordConfirmRow) elements.fieldPasswordConfirmRow.hidden = false;
    if (elements.fieldRecoveryRow) elements.fieldRecoveryRow.hidden = true;
    elements.hintLogin.hidden = false;
    elements.hintPassword.textContent = t('hintPasswordRegister');
    elements.hintPassword.hidden = false;
    if (elements.hintPasswordConfirm) {
      elements.hintPasswordConfirm.textContent = t('hintPasswordConfirm');
    }
    elements.authSubmit.textContent = t('authSubmitRegister');
    elements.authSwitchNote.textContent = t('authSwitchNoteRegister');
    elements.authSwitch.textContent = t('authSwitchRegister');
    if (elements.authForgotBtn) elements.authForgotBtn.hidden = true;
    elements.fieldPassword.autocomplete = 'new-password';
  } else {
    elements.authTitle.textContent = t('authTitleLogin');
    elements.authLead.textContent = t('authLeadLogin');
    if (elements.fieldNameRow) elements.fieldNameRow.hidden = true;
    if (elements.fieldPasswordConfirmRow) elements.fieldPasswordConfirmRow.hidden = true;
    if (elements.fieldRecoveryRow) elements.fieldRecoveryRow.hidden = true;
    elements.hintLogin.hidden = true;
    elements.hintPassword.hidden = true;
    elements.authSubmit.textContent = t('authSubmitLogin');
    elements.authSwitchNote.textContent = t('authSwitchNoteLogin');
    elements.authSwitch.textContent = t('authSwitchLogin');
    if (elements.authForgotBtn) elements.authForgotBtn.hidden = false;
    elements.fieldPassword.autocomplete = 'current-password';
  }
  clearAuthError();
}

function onAuthSwitch() {
  if (mode === 'recover') {
    setMode('login');
  } else {
    setMode(mode === 'login' ? 'register' : 'login');
  }
  elements.fieldLogin.focus();
}

async function onAuthSubmit(event) {
  event.preventDefault();
  if (authBusy) return;
  clearAuthError();

  const login = elements.fieldLogin.value.trim().replace(/^@+/, '').toLowerCase();
  const password = elements.fieldPassword.value;
  const extraPassword = elements.fieldExtraPassword ? elements.fieldExtraPassword.value : '';
  const name = elements.fieldName ? elements.fieldName.value.trim() : '';
  const recoveryKey = elements.fieldRecovery ? elements.fieldRecovery.value.trim() : '';

  if (!LOGIN_RE.test(login)) {
    showAuthError(t('errors.invalid_login'));
    elements.fieldLogin.focus();
    return;
  }
  if (password.length < 1 || password.length > 200) {
    showAuthError(t('errors.invalid_password'));
    elements.fieldPassword.focus();
    return;
  }
  if (mode === 'register') {
    const passwordConfirm = elements.fieldPasswordConfirm ? elements.fieldPasswordConfirm.value : '';
    if (password !== passwordConfirm) {
      showAuthError(t('errors.password_mismatch'));
      elements.fieldPasswordConfirm?.focus();
      return;
    }
  }
  if (mode === 'recover' && !recoveryKey) {
    showAuthError(t('errors.bad_recovery_key'));
    elements.fieldRecovery.focus();
    return;
  }
  if (mode === 'login' && needExtraPassword && !extraPassword) {
    showAuthError(errorText('extra_password_required'));
    elements.fieldExtraPassword?.focus();
    return;
  }

  setAuthBusy(true);
  try {
    let out;
    if (mode === 'recover') {
      out = await request('POST', '/recover', { login, recoveryKey, newPassword: password });
    } else if (mode === 'register') {
      out = await request('POST', '/register', { login, password, name, lang: currentLang });
    } else {
      out = await request('POST', '/login', {
        login, password, extraPassword: needExtraPassword ? extraPassword : undefined,
      });
    }
    token = out.token;
    writeToken(token);
    self = out.user;
    renderSelfIdentity();
    needExtraPassword = false;
    elements.authForm.reset();
    if (elements.fieldExtraPasswordRow) elements.fieldExtraPasswordRow.hidden = true;

    if (out.recoveryKey || out.newRecoveryKey) {
      showRecoveryDialog(out.recoveryKey || out.newRecoveryKey);
    } else {
      showApp();
      await refreshRoster();
      connectSocket();
      checkPendingInvite();
    }
  } catch (err) {
    if (mode === 'login' && err.code === 'extra_password_required') {
      // Primary password was correct; this account needs the second one too.
      // Not a failure — grow the form and ask for it instead of erroring out.
      needExtraPassword = true;
      if (elements.fieldExtraPasswordRow) elements.fieldExtraPasswordRow.hidden = false;
      showAuthError(errorText('extra_password_required'));
      elements.fieldExtraPassword?.focus();
    } else {
      console.error('[Tailchat Auth Error]', err);
      showAuthError(errorText(err.code || err.message));
    }
  } finally {
    setAuthBusy(false);
  }
}

function setAuthBusy(busy) {
  authBusy = busy;
  elements.authSubmit.disabled = busy;
  elements.fieldLogin.disabled = busy;
  if (elements.fieldName) elements.fieldName.disabled = busy;
  if (elements.fieldRecovery) elements.fieldRecovery.disabled = busy;
  elements.fieldPassword.disabled = busy;
}

function showAuthError(message) {
  elements.authError.textContent = message;
}

function clearAuthError() {
  elements.authError.textContent = '';
}

function logout() {
  for (const login of [...directLinks.keys()]) teardownDirect(login);
  stopHeartbeat();
  dropSocket();
  stopCore();
  // Receipts still pending belong to a session that is ending; the peers they
  // name are about to stop meaning anything.
  readReceiptQueue.length = 0;
  clearInterval(readReceiptTimer);
  readReceiptTimer = null;
  // A backoff already in flight would otherwise dial back in with the token we
  // are in the middle of throwing away.
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  // Both of these are per account and were read out of storage under the login
  // that is ending: the durable send queue holds another person's unsent
  // messages, and the feed cursor is a position in another account's log.
  // Leaving them loaded would have the *next* account's tab flush the previous
  // one's queue and page the feed from the previous one's cursor.
  forgetPendingSends();
  forgetSyncCursor();
  // The push repair key belongs to the account that is ending: nothing a worker
  // can read should keep a way to re-register this device for a login nobody is
  // signed in as any more.
  void clearPushRepair();
  token = null;
  self = null;
  users = [];
  activePeer = null;
  threads.clear();
  botActionsByPeer.clear();
  renderBotActions();
  elements.transcript.querySelectorAll('.thread').forEach((n) => n.remove());
  resetIncomingTransfers();
  // Both hold the ending account's pictures, possibly by `blob:` URL.
  if (elements.imageSheet?.open) elements.imageSheet.close();
  releaseAttachmentUrls();
  clearToken();
  setMode('login');
  showAuth();
  clearPendingPing();
}

function expireSession(reason) {
  if (reason) console.warn('[Tailchat] Expire session:', reason);
  stopCore();
  clearToken();
  // Same reasoning as `logout`: what was loaded under this login must not be
  // left for the next one (`forgetPendingSends`).
  forgetPendingSends();
  forgetSyncCursor();
  void clearPushRepair();
  token = null;
  showAuth();
  showAuthError(t('errors.auth_required'));
}

// --- Ростер контактов ---------------------------------------------------

async function refreshRoster() {
  try {
    const data = await request('GET', '/users');
    setUsers(data.users);
  } catch {}
}

function setUsers(next) {
  users = Array.isArray(next) ? next.slice().sort(compareUsers) : [];
  for (const user of users) {
    if (!Array.isArray(user.reactionEvents)) continue;
    const fresh = !threads.has(user.login);
    const thread = threadFor(user.login);
    if (fresh) thread.unread = user.pending || 0;
    thread.reactionEvents = new Map(user.reactionEvents.map(event => [event.id, event]));
    paintReactionEvents(thread);
  }
  // A roster that no longer names the open conversation means this account
  // deleted the contact somewhere else — the server broadcasts `k:'users'`
  // after `contact/remove`, which is how the other devices hear about it. The
  // thread cannot come back (the server's purge watermark is permanent), so
  // the conversation is closed and purged here the same way the deleting
  // device did it.
  if (activePeer && activePeer !== self?.login && !users.some((u) => u.login === activePeer)) {
    purgeRemovedContact(activePeer);
  }
  updateAppUnreadBadge();
  requestAnimationFrame(flushReactionReads);
  renderRoster();
  updatePeerHeader();
  renderInfoPanel();
}

// Pinned chats persist across reloads the same way the voice playback rate
// does — a single localStorage key, since a browser profile normally holds
// one logged-in account (see `TOKEN_KEY`). Saved Messages is never part of
// this set: it is always sorted first regardless (see `renderRoster`), so
// it never competes on recency with real conversations — «saved в ростере
// часто внизу оказывается» was exactly that competition.
const PINNED_KEY = 'tailchat-cloud-pinned';
function loadPinnedPeers() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((login) => typeof login === 'string') : [];
  } catch {
    return [];
  }
}
const pinnedPeers = new Set(loadPinnedPeers());
function savePinnedPeers() {
  try { localStorage.setItem(PINNED_KEY, JSON.stringify([...pinnedPeers])); } catch {}
}
function isPinned(login) {
  return pinnedPeers.has(login);
}
function togglePin(login) {
  if (pinnedPeers.has(login)) pinnedPeers.delete(login);
  else pinnedPeers.add(login);
  savePinnedPeers();
  renderRoster();
}

// Block state is server-authoritative, unlike the pin above: `user.blocked`
// rides on the roster entry the server already sends (`GET /users`, the
// `k:'ready'`/`k:'users'` websocket payload — see src/cloud/hub.js), so
// there is nothing to persist client-side. The two wrappers below shape the
// REST call and apply the flag to the in-memory roster at once, so the tab
// that clicked Block doesn't wait for the server's own broadcast of the
// same change to come back around (that broadcast still arrives and is a
// no-op against the flag already set here).
function isBlockedPeer(login) {
  return Boolean(users.find((u) => u.login === login)?.blocked);
}

function applyBlockedFlag(login, blocked) {
  const user = users.find((u) => u.login === login);
  if (user) user.blocked = blocked;
  renderRoster();
  if (activePeer === login) updateComposerState();
}

async function blockPeer(login) {
  try {
    await request('POST', '/block', { login });
    applyBlockedFlag(login, true);
  } catch (err) {
    const thread = threads.get(login);
    if (thread) systemNote(thread, errorText(err.code));
  }
}

async function unblockPeer(login) {
  try {
    await request('POST', '/unblock', { login });
    applyBlockedFlag(login, false);
  } catch (err) {
    const thread = threads.get(login);
    if (thread) systemNote(thread, errorText(err.code));
  }
}

// «Удалить контакт вместе с перепиской»: one-sided and permanent. The server
// drops the contact and this account's half of the thread — the purge
// watermark never clears, so re-adding the peer through an invite does not
// bring the messages back — while the peer keeps both their copy and their
// roster entry (`handleRemoveContact` in src/cloud/server.js). Nothing local
// is touched until the API has answered, and then every trace of the
// conversation goes at once.
async function removeContact(login) {
  if (!(await askRemoveContact())) return;
  try {
    await request('POST', '/contact/remove', { login });
  } catch (err) {
    // A refusal — an official contact this roster did not flag, a peer
    // already gone on the server — leaves the conversation exactly as it was,
    // so the failure has to be said rather than swallowed.
    const thread = threads.get(login);
    if (thread) systemNote(thread, errorText(err.code));
    return;
  }
  purgeRemovedContact(login);
  renderRoster();
  updateAppUnreadBadge();
  // That conversation is gone, so the confirmation note lands in Saved
  // Messages: the one thread the account always has and this never purges.
  if (self) systemNote(threadFor(self.login), t('rosterRemoveDone'));
}

// Everything this tab remembers about one conversation, dropped together: the
// roster entry, the thread and its rendered rows, the draft, the pin that
// would keep the row at the top of the list, and the direct link with its
// queued ICE candidates. Runs both for a deletion made here and for one that
// arrives from another device as a roster without the peer (see `setUsers`).
function purgeRemovedContact(login) {
  users = users.filter((u) => u.login !== login);
  drafts.delete(login);
  if (pinnedPeers.delete(login)) savePinnedPeers();
  teardownDirect(login);
  const thread = threads.get(login);
  if (thread) {
    thread.node.remove();
    threads.delete(login);
  }
  if (activePeer !== login) return;
  // The messages just deleted are the ones on screen: close the pane instead
  // of leaving an empty thread there, and drop the composer state naming it —
  // an edit or reply pointing at a message that no longer exists, and the
  // draft the composer was still holding.
  activePeer = null;
  composerContext = null;
  preEditDraft = null;
  updateComposerContextUI();
  setComposerValue('');
  // Same composer the app shows before any conversation is picked: empty, and
  // saying that there is no peer to write to.
  elements.input.placeholder = composerPlaceholderText();
  for (const th of threads.values()) th.node.hidden = true;
  elements.placeholder.hidden = false;
  updatePeerHeader();
  updateComposerState();
  refreshPeerActions();
  renderInfoPanel();
}

// This cannot be undone and the other side keeps their copy, so it takes an
// explicit yes. The app's dialogs are the static `<dialog class="modal-dialog">`
// cards in index.html, and the confirmation builds the same card out of the
// same classes rather than a browser `confirm()`. Esc, the close button and
// the backdrop all close it unanswered, which is the default answer.
function askRemoveContact() {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal-dialog';

    const card = document.createElement('div');
    card.className = 'modal-card';

    const header = document.createElement('header');
    header.className = 'modal-header';
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = t('rosterRemoveContact');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'icon-button modal-close';
    dismiss.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>';
    dismiss.setAttribute('aria-label', t('rosterRemoveCancel'));
    header.append(title, dismiss);

    const hint = document.createElement('p');
    hint.className = 'modal-hint';
    hint.textContent = t('rosterRemoveConfirm');

    // The one action row the stylesheet has, straight from the profile card.
    const actions = document.createElement('div');
    actions.className = 'profile-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'quiet-button';
    cancel.textContent = t('rosterRemoveCancel');
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary-button';
    confirm.textContent = t('rosterRemoveContact');
    actions.append(cancel, confirm);

    card.append(header, hint, actions);
    dialog.append(card);

    let confirmed = false;
    cancel.addEventListener('click', () => dialog.close());
    dismiss.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => {
      confirmed = true;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(confirmed);
    });

    document.body.append(dialog);
    dialog.showModal();
  });
}

// Renaming a contact is the one place a peer's display name is overridden, and
// the override is private: the server keeps the nickname for the account that
// set it and never tells the peer (issue #28). An empty field is not "no
// change" — confirming it clears the nickname — so the hint says so outright.
function askContactAlias(user) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal-dialog';

    const card = document.createElement('div');
    card.className = 'modal-card';

    const header = document.createElement('header');
    header.className = 'modal-header';
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = t('rosterRename');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'icon-button modal-close';
    dismiss.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>';
    dismiss.setAttribute('aria-label', t('rosterRenameCancel'));
    header.append(title, dismiss);

    const hint = document.createElement('p');
    hint.className = 'modal-hint';
    hint.textContent = t('rosterRenameHint');

    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.setAttribute('for', 'roster-alias-input');
    label.textContent = t('rosterRename');
    const input = document.createElement('input');
    input.id = 'roster-alias-input';
    input.type = 'text';
    input.maxLength = 32;
    input.autocomplete = 'off';
    input.value = user.alias ?? '';
    field.append(label, input);

    const status = document.createElement('p');
    status.className = 'modal-status';
    status.setAttribute('role', 'status');

    const actions = document.createElement('div');
    actions.className = 'profile-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'quiet-button';
    cancel.textContent = t('rosterRenameCancel');
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary-button';
    confirm.textContent = t('rosterRenameConfirm');
    actions.append(cancel, confirm);

    card.append(header, hint, field, status, actions);
    dialog.append(card);

    let outcome = null;
    let submitting = false;
    const submit = async () => {
      if (submitting) return;
      submitting = true;
      confirm.disabled = true;
      status.textContent = '';
      status.dataset.kind = '';
      try {
        const data = await request('POST', '/alias', { login: user.login, name: input.value.trim() });
        outcome = { alias: typeof data?.alias === 'string' ? data.alias : '' };
        dialog.close();
      } catch (err) {
        // A refusal leaves the roster exactly as it was, so the reason has to
        // be said inside the dialog rather than swallowed.
        submitting = false;
        confirm.disabled = false;
        status.textContent = errorText(err.code);
        status.dataset.kind = 'error';
      }
    };
    cancel.addEventListener('click', () => dialog.close());
    dismiss.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });

    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

async function renameContact(user) {
  const result = await askContactAlias(user);
  if (!result) return;
  const entry = users.find((u) => u.login === user.login);
  if (entry) entry.alias = result.alias;
  // Applying the returned value covers the instant; the server also re-sends
  // this account's own roster (`{k:'users'}`) after a change, which lands in
  // `setUsers` and repaints again for every other tab.
  renderRoster();
  updatePeerHeader();
  renderInfoPanel();
  showToast(result.alias ? t('rosterRenameDone', result.alias) : t('rosterRenameCleared'));
}

function compareUsers(a, b) {
  const pinnedA = isPinned(a.login);
  const pinnedB = isPinned(b.login);
  if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
  const blockedA = Boolean(a.blocked);
  const blockedB = Boolean(b.blocked);
  if (blockedA !== blockedB) return blockedA ? 1 : -1;
  const lastA = Math.max(rosterPreviewOf(a)?.ts || 0, threads.get(a.login)?.activityTs || 0);
  const lastB = Math.max(rosterPreviewOf(b)?.ts || 0, threads.get(b.login)?.activityTs || 0);
  if (lastA !== lastB) return lastB - lastA;
  // Alphabetical by the name the roster actually paints — the nickname this
  // account gave the contact included (issue #28). Sorting by the account name
  // while showing a nickname would put «Няша» where «Борис» belongs.
  return String(peerLabel(a)).localeCompare(String(peerLabel(b)))
    || a.login.localeCompare(b.login);
}

// Web's counterpart of the APK's `PresenceAvatar` (CloudScreen.kt): the first
// cluster of the shown name — `[...x][0]`, so an emoji is not cut in half — in
// a ring the presence tints and fills while online. `kind` is presenceKind(),
// `service` for an official account or `saved` for Saved Messages; every
// colour lives in the stylesheet.
function buildAvatar(label, kind) {
  const avatar = document.createElement('span');
  avatar.className = 'roster-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, label, kind);
  return avatar;
}

function paintAvatar(avatar, label, kind) {
  avatar.dataset.presence = kind;
  avatar.textContent = [...String(label || '').trim()][0]?.toUpperCase() || '?';
}

function buildSavedMessagesRow() {
  const li = document.createElement('li');
  li.className = 'roster-row';

  const btn = document.createElement('button');
  btn.className = 'roster-item roster-item--saved' + (activePeer === self.login ? ' active' : '');
  btn.dataset.login = self.login;
  if (activePeer === self.login) btn.setAttribute('aria-current', 'true');
  btn.type = 'button';
  btn.addEventListener('click', () => selectPeer(self.login));

  const name = document.createElement('strong');
  name.className = 'roster-name';
  name.textContent = t('savedMessages');

  const status = document.createElement('span');
  status.className = 'roster-status';
  status.textContent = t('savedMessagesHint');

  btn.append(buildAvatar('✎', 'saved'), name);
  const preview = buildRosterPreview(self);
  if (preview) btn.append(preview);
  btn.append(status);
  const meta = buildRosterMeta(self, false);
  if (meta) btn.append(meta);

  const thread = threads.get(self.login);
  if (thread && thread.unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'roster-badge';
    badge.textContent = String(thread.unread);
    btn.append(badge);
  }

  li.append(btn);
  return li;
}

// The last thing said in a conversation, as one clipped line under the name.
// Prefers what the client has actually seen live over the copy the server sent
// with the roster, so a message that arrives while the list is on screen
// updates it without waiting for the next `users` payload.
// Records a message against the conversation's roster preview, newest wins.
// Called from every path that puts a message on screen — live, self-synced,
// history, and this tab's own sends — because the roster has to agree with the
// transcript whichever of them learned about the message first.
function notePreview(peer, entry) {
  if (!peer || !entry || !Number.isFinite(entry.ts)) return;
  const thread = threads.get(peer);
  if (!thread) return;
  if (thread.lastMessage && thread.lastMessage.ts > entry.ts) return;
  thread.lastMessage = entry;
  const user = users.find(user => user.login === peer);
  if (user?.last?.id === entry.id && entry.id) user.last = { ...entry };
  scheduleRosterRender();
}

// Populating a thread from history calls the append helpers dozens of times in
// a row, and each one moves the preview. Rebuilding the whole roster per
// message would be dozens of full re-renders for one visible change, so the
// work is collapsed into the next frame.
let rosterRenderQueued = false;

function scheduleRosterRender() {
  if (rosterRenderQueued) return;
  rosterRenderQueued = true;
  requestAnimationFrame(() => {
    rosterRenderQueued = false;
    renderRoster();
  });
}

function rosterPreviewOf(user) {
  const thread = threads.get(user.login);
  const live = thread?.lastMessage ?? null;
  const stored = user.last ?? null;
  if (!live) return stored;
  if (!stored) return live;
  if (live.id && live.id === stored.id && stored.text !== live.text) return stored;
  return live.ts >= stored.ts ? live : stored;
}

// What a message with no text of its own is called in the roster.
function previewMediaLabel(media) {
  if (media === 'image') return t('previewImage');
  if (media === 'voice') return t('previewVoice');
  if (media === 'file') return t('previewFile');
  return '';
}

function buildRosterPreview(user) {
  const last = rosterPreviewOf(user);
  if (!last) return null;
  const body = last.text && last.text !== ''
    ? last.text
    : previewMediaLabel(last.media);
  if (body === '') return null;

  const line = document.createElement('span');
  line.className = 'roster-preview';

  // Who said it, when it was not the peer whose name is already on the row
  // above: an AI answer and one's own last word both need attributing, and
  // «You: …» is the difference between "they replied" and "they have not".
  const mine = last.from === self?.login && last.kind !== 'ai';
  const label = last.kind === 'ai'
    ? (last.author || 'tailik')
    : (mine ? t('previewYou') : null);
  if (label) {
    const who = document.createElement('span');
    who.className = 'roster-preview-author';
    who.textContent = `${label}:`;
    line.append(who);
  }
  // textContent, not innerHTML: this is somebody else's message text.
  const text = document.createElement('span');
  text.className = 'roster-preview-text';
  appendEmojiText(text, collapseForPreview(body));
  line.append(text);
  return line;
}

// The row's top-right corner: the delivery mark of one's own last message, then
// that message's time — `✓✓ 12:40`, the way Telegram draws it. Issue #25 first
// moved the mark from the head of the preview to its tail; at the tail its x
// followed the length of the text, so on a list of rows it jumped about. In this
// fixed column it sits in the same place on every row (owner, 2026-10-27), and
// the preview line gets the full width. A row with an unread pill draws no time
// (`withTime`), and the mark still takes the same corner.
//
// Same delivery convention as the bubble's own mark (`.bubble-mark` /
// `setMark`): only "read" gets a distinct look — the accent — while both "sent"
// and "delivered" are the neutral grey of the line they sit in, told apart by
// the glyph the same way the transcript tells them apart. The roster reads the
// delivered watermark the thread keeps for exactly this line, so the row cannot
// disagree with the bubble it stands for.
function buildRosterMeta(user, withTime) {
  const last = rosterPreviewOf(user);
  if (!last) return null;
  const meta = document.createElement('span');
  meta.className = 'roster-meta';
  let filled = false;
  if (last.from === self?.login && last.kind !== 'ai') {
    const thread = threads.get(user.login);
    // A message the server has not committed keeps the bubble's own ⧗/⚠: the
    // watermarks are times, and a message still on this device can sit below
    // them without the peer ever holding it (`markCommitted`). Android draws
    // the same (`rosterPreviewLine`).
    const ownMark = last.id ? thread?.marks.get(last.id) : null;
    const unsettled = ownMark
      ? (markCommitted(ownMark) ? '' : ownMark.dataset.state)
      : (last.id && pendingFor(user.login).some((entry) => entry.id === last.id) ? 'queued' : '');
    const read = !unsettled && Boolean(thread && last.ts > 0 && last.ts <= thread.peerReadTs);
    const delivered = !unsettled && Boolean(thread && last.ts > 0 && last.ts <= (thread.peerDeliveredTs || 0));
    const mark = document.createElement('span');
    mark.className = 'roster-mark';
    setMark(mark, unsettled || (read ? 'read' : (delivered ? 'ack' : 'sent')));
    meta.append(mark);
    filled = true;
  }
  if (withTime && last.ts) {
    const time = document.createElement('time');
    time.className = 'roster-time';
    time.dateTime = new Date(last.ts).toISOString();
    time.textContent = rosterTimeLabel(last.ts, new Date());
    meta.append(time);
    filled = true;
  }
  return filled ? meta : null;
}

// A transcript keeps newlines; a one-line preview cannot, and a message that is
// mostly blank lines would otherwise render as an empty row.
function collapseForPreview(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}

// Matches the `{name}` sender label already used on message bubbles and in
// the CLI transcript, so a name reads the same wherever it shows up.
function bracketName(name) {
  return `{${name}}`;
}

// The six places `self` changes (login, register, profile edit, socket hello,
// a push carrying a fresher profile, nickname change) all painted the same
// two elements from the same two expressions; one drifting from the other
// five was only a matter of time.
function renderSelfIdentity() {
  if (!self) return;
  if (elements.selfName) elements.selfName.textContent = bracketName(self.name || self.login);
  if (elements.selfLogin) elements.selfLogin.textContent = formatLogin(self.login);
  // The rail's avatar is the same identity in one glanceable cell: it has no
  // room for the name, so it carries the initial and a hover title does the
  // rest. `[...x][0]` rather than `x[0]`: a name starting with an emoji is one
  // cluster, and slicing the surrogate pair in half paints a replacement box.
  if (elements.railSelfInitial) {
    const label = String(self.name || self.login || '');
    elements.railSelfInitial.textContent = [...label][0]?.toUpperCase() ?? '•';
  }
}


function renderRoster() {
  elements.rosterList.innerHTML = '';
  elements.rosterEmpty.hidden = users.length > 0;
  // Saved Messages is drawn first, unconditionally — never mixed into the
  // recency sort below, or it would lose to whatever real conversation was
  // touched most recently, which was «saved в ростере часто внизу
  // оказывается»: on any remotely active account, that is almost always.
  if (self) elements.rosterList.append(buildSavedMessagesRow());
  const rosterUsers = self ? users.filter(user => user.login !== self.login) : [...users];
  rosterUsers.sort(compareUsers);
  for (const user of rosterUsers) {
    const li = document.createElement('li');
    li.className = 'roster-row';

    const btn = document.createElement('button');
    btn.className = 'roster-item' + (user.login === activePeer ? ' active' : '');
    btn.dataset.login = user.login;
    if (user.login === activePeer) btn.setAttribute('aria-current', 'true');
    if (user.blocked) btn.dataset.blocked = 'true';
    if (user.official) btn.dataset.official = 'true';
    btn.type = 'button';
    btn.addEventListener('click', () => selectPeer(user.login));

    const name = document.createElement('strong');
    name.className = 'roster-name';
    name.textContent = (isPinned(user.login) ? '📌 ' : '') + (user.blocked ? '🚫 ' : '') + bracketName(peerLabel(user));

    const status = document.createElement('span');
    status.className = 'roster-status';
    if (isServiceAccount(user)) {
      status.dataset.online = 'service';
      status.textContent = t('officialAccount');
    } else {
      status.dataset.online = presenceKind(user);
      status.textContent = presenceLabel(user);
      const dot = document.createElement('span');
      dot.className = 'roster-dot';
      dot.textContent = `${presenceGlyph(user)} `;
      status.prepend(dot);
    }

    btn.append(buildAvatar(peerLabel(user), isServiceAccount(user) ? 'service' : presenceKind(user)), name);
    const preview = buildRosterPreview(user);
    if (preview) btn.append(preview);
    btn.append(status);

    const thread = threads.get(user.login);
    const unreadCount = (thread ? thread.unread : user.pending || 0) + (thread?.reactionEvents?.size || 0);
    const meta = buildRosterMeta(user, unreadCount === 0);
    if (meta) btn.append(meta);
    if (unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'roster-badge';
      badge.textContent = String(unreadCount);
      btn.append(badge);
    }

    // Per-peer menu: the actions that used to live only in the info panel of
    // an already-open conversation, reachable from the list itself — «меню
    // для пользователей в ростере». Long-press works too, same as a bubble.
    const menuBtn = document.createElement('button');
    menuBtn.className = 'roster-menu-btn';
    menuBtn.type = 'button';
    menuBtn.textContent = '⋯';
    menuBtn.title = t('rosterMenu');
    menuBtn.setAttribute('aria-label', t('rosterMenu'));
    preserveFocusOnPointerDown(menuBtn);
    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openRosterMenu(menuBtn, user);
    });
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openRosterMenu(menuBtn, user);
    });

    li.append(btn, menuBtn);
    elements.rosterList.append(li);
  }
  // The bar's own empty-thread menu is read from the transcript, and this is
  // the one render every path that puts a message on screen already ends in —
  // so a seeded menu leaves with the first row without each caller having to
  // remember it.
  renderBotActions();
}


// The roster's own context menu. Reuses `msg-menu` styling and the same
// single-open-popover discipline as the message menu, so there is one menu
// look in this app rather than two.
let openRosterMenuNode = null;

function closeRosterMenu() {
  openRosterMenuNode?.remove();
  openRosterMenuNode = null;
}

function openConversationMenu(anchor) {
  const user = users.find((item) => item.login === activePeer);
  if (!user) return;
  closeRosterMenu();
  closeMessageMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');
  const add = (label, handler, { danger = false, enabled = true } = {}) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = danger ? 'msg-menu-item msg-menu-item--danger' : 'msg-menu-item';
    item.textContent = label;
    item.disabled = !enabled;
    item.addEventListener('click', () => {
      closeRosterMenu();
      handler();
    });
    menu.append(item);
  };
  add(t('rosterInfo'), () => {
    setPaneVisible('info', true);
    syncPaneButtons();
    renderInfoPanel();
  });
  const muted = mutedContacts.has(user.login);
  const muteLabels = muted
    ? { ru: 'Включить звук', en: 'Unmute', fr: 'Réactiver le son' }
    : { ru: 'Заглушить', en: 'Mute', fr: 'Mettre en sourdine' };
  add(muteLabels[currentLang] || muteLabels.en, () => setPeerMuted(user.login, !muted));
  if (coreE2ee) {
    // «Сверить» opens the safety code in Details — one way to verify a contact
    // (owner's decision, 2026-11-12, E2EE spec §8.9); the live comparison is
    // for your own devices.
    add(e2eeText('e2ee.menuVerify'), openSafetyCode);
    if (coreE2ee.hasChangedKeys(user.login)) add(e2eeText('e2ee.menuTrust'), () => runCoreE2eeCommand('/trust', ''));
  }
  add(user.blocked ? t('rosterUnblock') : t('rosterBlock'), () => {
    (user.blocked ? unblockPeer : blockPeer)(user.login);
  }, { danger: !user.blocked });
  document.body.append(menu);
  const box = safeAnchorRect(anchor);
  const menuBox = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(8, box.right - menuBox.width), window.innerWidth - menuBox.width - 8)}px`;
  menu.style.top = `${Math.min(box.bottom + 6, window.innerHeight - menuBox.height - 8)}px`;
  openRosterMenuNode = menu;
}

function openRosterMenu(anchor, user) {
  closeRosterMenu();
  closeMessageMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');

  const add = (label, handler, danger = false) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = danger ? 'msg-menu-item msg-menu-item--danger' : 'msg-menu-item';
    item.textContent = label;
    preserveFocusOnPointerDown(item);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeRosterMenu();
      handler();
    });
    menu.append(item);
  };

  add(t('rosterOpenChat'), () => selectPeer(user.login));
  add(isPinned(user.login) ? t('rosterUnpin') : t('rosterPin'), () => togglePin(user.login));
  // Works without opening the thread: the whole point is the badge that
  // nothing on screen can clear (a reaction on a message far up the log, a
  // queued frame in a conversation nobody wants to open).
  add(
    user.pending > 0 ? t('rosterMarkRead') : t('rosterMarkUnread'),
    () => (user.pending > 0 ? markConversationRead(user.login) : markConversationUnread(user.login)),
  );
  // Both need the conversation to be the active one — they act on the open
  // thread — so each selects the peer first and then runs.
  if (user.online) {
    add(t('infoWake'), async () => {
      await selectPeer(user.login);
      executeCommand('/wake');
    });
  }
  add(t('infoExport'), async () => {
    await selectPeer(user.login);
    exportHistory();
  });
  add(t('rosterCopyLogin'), () => {
    navigator.clipboard?.writeText(user.login).then(() => {
      const thread = activePeer ? threads.get(activePeer) : null;
      if (thread) systemNote(thread, t('rosterLoginCopied', user.login));
    }).catch(() => {});
  });
  add(t('rosterInfo'), async () => {
    await selectPeer(user.login);
    setPaneVisible('info', true);
    syncPaneButtons();
  });
  add(t('rosterRename'), () => renameContact(user));
  add(user.blocked ? t('rosterUnblock') : t('rosterBlock'), () => (user.blocked ? unblockPeer : blockPeer)(user.login), true);
  // The official accounts (`tailchat`, `tailik`) are refused by the API and
  // re-linked into every roster anyway, so the action is simply not offered
  // on them — `official` rides on the roster entry the server already sends.
  if (!user.official) {
    add(t('rosterRemoveContact'), () => removeContact(user.login), true);
  }
  add(t('rosterClearHistory'), async () => {
    await selectPeer(user.login);
    const thread = threads.get(user.login);
    const ids = thread ? [...thread.node.querySelectorAll('[data-id]')].map((row) => row.dataset.id) : [];
    if (ids.length === 0) return;
    deleteMessages(ids, 'self');
  }, true);

  document.body.append(menu);
  const box = safeAnchorRect(anchor);
  const menuBox = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left), window.innerWidth - menuBox.width - 8);
  const above = box.bottom + menuBox.height + 8 > window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${above ? Math.max(8, box.top - menuBox.height - 4) : box.bottom + 4}px`;
  openRosterMenuNode = menu;
}

// --- Выбор собеседника ---------------------------------------------------

const HISTORY_DAYS_DEFAULT = 3;
const HISTORY_DAYS_MS = HISTORY_DAYS_DEFAULT * 24 * 60 * 60 * 1000;

async function fetchInitialHistory(peer) {
  const since = Date.now() - HISTORY_DAYS_MS;
  let data = await request('GET', `/history?peer=${encodeURIComponent(peer)}&since=${since}&limit=60&view=web&deleted=1&media=ref${coreHistoryParam()}`);
  let msgs = data?.messages || [];
  let reachedBeginning = false;
  if (msgs.length === 0) {
    data = await request('GET', `/history?peer=${encodeURIComponent(peer)}&limit=60&view=web&deleted=1&media=ref${coreHistoryParam()}`);
    msgs = data?.messages || [];
    if (msgs.length < 60) {
      reachedBeginning = true;
    }
  }
  return {
    msgs,
    peerReadTs: data?.peerReadTs || 0,
    peerReadAt: data?.peerReadAt || 0,
    peerReadVia: data?.peerReadVia || '',
    // How far the peer's *device* holds this conversation, in the same shape
    // and from the same place as the read watermark above (`/api/history`).
    // `0` from an older server, which is also what the missing key means.
    peerDeliveredTs: data?.peerDeliveredTs || 0,
    reachedBeginning,
  };
}

async function loadOlderMessages(thread) {
  if (!thread || thread.loadingOlder || thread.reachedBeginning || !thread.loaded) return;
  if (!thread.oldestTs && !thread.oldestId) {
    thread.reachedBeginning = true;
    return;
  }
  thread.loadingOlder = true;
  const peer = thread.peer;
  try {
    const query = new URLSearchParams({
      peer,
      limit: '60',
      view: 'web',
      deleted: '1',
      media: 'ref',
    });
    if (coreSession) query.set('e2ee', '1');
    if (thread.oldestId) query.set('beforeId', thread.oldestId);
    else if (thread.oldestTs) query.set('before', String(thread.oldestTs));

    const data = await request('GET', `/history?${query.toString()}`);
    const msgs = data?.messages || [];
    if (msgs.length === 0) {
      thread.reachedBeginning = true;
      return;
    }
    if (msgs.length < 60) {
      thread.reachedBeginning = true;
    }
    const container = elements.transcript;
    const prevScrollHeight = container ? container.scrollHeight : 0;
    const prevScrollTop = container ? container.scrollTop : 0;

    populateHistory(
      thread,
      msgs,
      data?.peerReadTs || 0,
      data?.peerReadAt || 0,
      data?.peerReadVia || '',
      data?.peerDeliveredTs || 0,
    );

    if (container && peer === activePeer) {
      const heightDiff = container.scrollHeight - prevScrollHeight;
      container.scrollTop = prevScrollTop + heightDiff;
    }
  } catch (err) {
    console.warn('[Tailchat] Failed to load older history for', peer, err);
  } finally {
    thread.loadingOlder = false;
  }
}

// The newest page of one conversation, merged into whatever the thread already
// holds. One body, three callers: the reconcile of the open conversation, the
// account feed closing a gap in a cached one, and the reset that follows a
// cursor falling out of the server's window. Deliberately not the initial load
// — that one is the loader below, which is also what decides where the scroll
// starts.
async function refreshNewestPage(peer) {
  const thread = threads.get(peer);
  if (!thread) return false;
  try {
    const data = await request('GET', `/history?peer=${encodeURIComponent(peer)}&limit=60&view=web&deleted=1&media=ref${coreHistoryParam()}`);
    populateHistory(
      thread,
      data?.messages || [],
      data?.peerReadTs || 0,
      data?.peerReadAt || 0,
      data?.peerReadVia || '',
      data?.peerDeliveredTs || 0,
    );
    return true;
  } catch {
    // A failed merge is a gap that is still there: nothing was written, so the
    // caller keeps owing it (the feed's own ids stay owed, and the next nudge
    // offers them again).
    return false;
  }
}

async function reconcileActiveThread(peer) {
  if (peer !== activePeer) return;
  const thread = threadFor(peer);
  try {
    if (!thread.loaded) {
      const {
        msgs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs, reachedBeginning,
      } = await loadInitialHistory(peer);
      if (peer === activePeer) {
        populateHistory(thread, msgs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs);
        thread.loaded = true;
        if (reachedBeginning || msgs.length === 0) thread.reachedBeginning = true;
        scrollToLatest();
      }
    } else {
      await refreshNewestPage(peer);
      if (peer !== activePeer) return;
      scrollToLatest();
    }
  } catch {}
}

async function selectPeer(peer) {
  // Подписка следует за активным собеседником, поэтому незавершённая запись
  // для прежнего всё равно не ушла бы: сбрасываем её сразу и явно.
  if (voiceCapture && voiceCapture.peer !== peer) cancelVoiceRecording();
  if (activePeer === peer) {
    revealTalkPane();
    // A release announcement deliberately stays unread while it arrives in
    // an already-open Tailchat thread. Clicking that roster row is the
    // explicit acknowledgement that clears it.
    clearUnread(peer);
    return;
  }
  if (activePeer) {
    const currentThread = threads.get(activePeer);
    if (currentThread) currentThread.readyForScrollLoad = false;
  }
  // Edit/reply names a message that belongs to the peer being left; carrying
  // it over to a new conversation would attach it to the wrong thread.
  cancelComposerContext();
  clearPendingPing();
  stashDraft(activePeer);
  hideQuickReactions();
  activePeer = peer;
  // The ids belong to the conversation being left; a selection carried into
  // another one would name messages that are not on screen.
  exitSelectionMode();
  restoreDraft(peer);
  renderBotActions();
  // On a phone the band has zero width until the talk pane is the visible one,
  // so this is the first moment it can be measured at all — and the first
  // moment the transcript has a box to scroll in.
  revealTalkPane();
  hideTyping();
  renderRoster();
  updatePeerHeader();

  elements.placeholder.hidden = true;
  updateComposerState();
  refreshPeerActions();
  if (wide.matches) elements.input.focus();

  for (const [login, th] of threads) {
    th.node.hidden = login !== peer;
  }
  const thread = threadFor(peer);
  thread.node.hidden = false;
  // Whatever this tab is still holding for this conversation is drawn here,
  // before the history request rather than after it: `populateHistory` only
  // exists once the server answers, and a message composed while the link was
  // down has to be visible — with its clock — the moment its conversation is
  // opened, even if the link is still down and no answer is coming.
  ensurePendingRows(thread, peer);

  // Subscribe immediately: tells the server this socket is now viewing `peer`, so
  // queued frames drain over WebSocket without waiting for the history HTTP round trip.
  subscribeActivePeer(true);
  const hadUnread = thread.unread > 0;

  const seq = ++selectionSeq;
  if (!thread.loaded) {
    try {
      const {
        msgs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs, reachedBeginning,
      } = await loadInitialHistory(peer);
      if (seq === selectionSeq) {
        populateHistory(thread, msgs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs);
        thread.loaded = true;
        if (reachedBeginning || msgs.length === 0) thread.reachedBeginning = true;
      }
    } catch (err) {
      console.warn('[Tailchat] Failed to load history for', peer, err);
    }
  } else if (hadUnread) {
    void reconcileActiveThread(peer);
  }

  if (seq === selectionSeq) {
    scrollToLatest(true, true);
    clearUnread(peer);
    unreadBelowCount = 0;
    updateScrollButton();
    flushReadReceipts();
    renderInfoPanel();
    requestAnimationFrame(() => {
      if (seq === selectionSeq) {
        thread.readyForScrollLoad = true;
      }
    });
  }
}

// --- Предзагрузка истории ------------------------------------------------
//
// `selectPeer` only fetches a thread's history the moment it is actually
// opened — right, because that request must never queue behind one the
// visible conversation is waiting on. But once the roster is known the wire
// is otherwise idle, and the threads most likely to be opened next are
// exactly the top of that list (`compareUsers` already sorts it by recency,
// same order the roster itself is drawn in). Fetching those in the
// background means clicking one later shows a populated thread instantly
// instead of the empty pane + spinner `selectPeer` would otherwise leave on
// screen for a beat.
//
// Best-effort and bounded by connection quality: this is bandwidth spent
// before the person asks for it. Every roster conversation is still eligible,
// because a fixed first-eight cap made the ninth row indistinguishable from no
// preload at all. Three workers keep the browser and server responsive while
// filling the rest. `loadInitialHistory` owns the in-flight promise, so a click
// during preloading waits for that request instead of issuing a duplicate.
const PRELOAD_CONCURRENCY = 3;
const initialHistoryLoads = new Map();

function loadInitialHistory(peer) {
  const pending = initialHistoryLoads.get(peer);
  if (pending) return pending;
  const load = fetchInitialHistory(peer).finally(() => {
    if (initialHistoryLoads.get(peer) === load) initialHistoryLoads.delete(peer);
  });
  initialHistoryLoads.set(peer, load);
  return load;
}

function shouldPreloadHistory() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return true;
  if (conn.saveData) return false;
  if (typeof conn.effectiveType === 'string' && /2g/.test(conn.effectiveType)) return false;
  return true;
}

async function preloadThreads() {
  if (!authed || !shouldPreloadHistory()) return;
  const candidates = users
    .map((user) => user.login)
    .filter((login) => login !== activePeer && !threads.get(login)?.loaded);
  let cursor = 0;
  const preloadNext = async () => {
    while (cursor < candidates.length) {
      const login = candidates[cursor++];
      if (login === activePeer) continue;
      const thread = threadFor(login);
      if (thread.loaded) continue;
      try {
        const {
          msgs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs, reachedBeginning,
        } = await loadInitialHistory(login);
        if (!thread.loaded && login !== activePeer) {
          populateHistory(thread, msgs, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs);
          thread.loaded = true;
          if (reachedBeginning || msgs.length === 0) thread.reachedBeginning = true;
        }
      } catch {
        // Best effort: opening the conversation retries through the same loader.
      }
    }
  };
  const workers = Math.min(PRELOAD_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workers }, () => preloadNext()));
}

// The composer's own block gate: reads `user.blocked` off the in-memory
// roster (server-authoritative, see `applyBlockedFlag`) rather than any
// local state, so a peer freshly blocked in another tab disables the
// composer here the moment that tab's `k:'users'` broadcast lands.
function composerPlaceholderText() {
  if (!activePeer) return t('composerPlaceholderDisabled');
  return isBlockedPeer(activePeer) ? t('composerBlockedHint') : t('composerPlaceholderActive');
}

function updateComposerState() {
  if (!activePeer) return;
  const blocked = isBlockedPeer(activePeer);
  elements.input.disabled = blocked;
  elements.voiceButton.disabled = blocked;
  elements.attachButton.disabled = blocked;
  elements.emojiButton.disabled = blocked;
  elements.input.placeholder = composerPlaceholderText();
  renderBotActions();
}

// /wake и /ping требуют ответа собеседника: офлайн они молча ничего не делают,
// поэтому и предлагать их нечестно. Экспорт и очистка — локальные.
function refreshPeerActions() {
  const user = activePeer ? users.find((u) => u.login === activePeer) : null;
  const local = Boolean(activePeer);
  const live = local && Boolean(user?.online) && authed && !user?.blocked;
  if (elements.infoExportBtn) elements.infoExportBtn.disabled = !local;
  if (elements.infoClearBtn) elements.infoClearBtn.disabled = !local;
  if (elements.infoWakeBtn) elements.infoWakeBtn.disabled = !live;
  if (elements.infoPingBtn) elements.infoPingBtn.disabled = !live;
}

function updatePeerHeader() {
  updateDirectUi();
  if (elements.conversationMenuButton) {
    elements.conversationMenuButton.disabled = !activePeer || (self && activePeer === self.login);
  }
  if (!activePeer) {
    elements.peerName.textContent = t('peerChoose');
    elements.peerStatus.textContent = t('peerChooseLead');
    delete elements.peerStatus.dataset.online;
    return;
  }
  if (self && activePeer === self.login) {
    elements.peerName.textContent = t('savedMessages');
    elements.peerStatus.textContent = t('savedMessagesHint');
    delete elements.peerStatus.dataset.online;
    return;
  }
  const user = users.find((u) => u.login === activePeer);
  elements.peerName.textContent = user ? peerLabel(user) : activePeer;
  const service = isServiceAccount(user);
  const detail = user
    ? (service
      ? t('officialAccount')
      : (user.online
        ? t(`peer${presenceKind(user).charAt(0).toUpperCase()}${presenceKind(user).slice(1)}`)
        : t('peerOffline', humanLastSeen(user.lastSeen))))
    : '';
  elements.peerStatus.dataset.online = service ? 'service' : presenceKind(user);
  // `@login ● online` — the lamp *is* the separator, the way it is in the
  // Android client's two headers (`CompactBar`'s subtitle and the roster's own
  // self line) and in this app's roster status line below. The dot survives
  // only where there is no lamp to do the job: the service account's word,
  // which is not a presence at all.
  const separator = service ? ' · ' : ' ';
  elements.peerStatus.textContent = detail
    ? `${formatLogin(activePeer)}${separator}${detail}`
    : formatLogin(activePeer);
}

// Служебные аккаунты (`tailchat`, `tailik`) — это сам сервер, а не человек:
// `usersFor` (src/cloud/hub.js:360-370) всегда отдаёт им `online: true`, так
// что присутствие у них ничего не значит и не показывается совсем.
function isServiceAccount(user) {
  return Boolean(user?.official);
}

// Presence is a three-state signal now (see `bindPresenceSignal`), so it needs
// three of everything: a key, a word and a glyph. `offline` keeps the «был(а) …»
// wording it always had, because a timestamp says more than the word would.
function presenceKind(user) {
  if (!user?.online) return 'offline';
  if (user.state === 'away') return 'away';
  if (user.state === 'idle') return 'idle';
  return 'online';
}

function presenceLabel(user) {
  switch (presenceKind(user)) {
    case 'away': return t('presenceAway');
    case 'idle': return t('presenceIdle');
    case 'online': return t('online');
    default: return humanLastSeen(user?.lastSeen);
  }
}

function presenceGlyph(user) {
  switch (presenceKind(user)) {
    case 'away': return '◔';
    case 'idle': return '◐';
    case 'online': return '●';
    default: return '○';
  }
}

// --- Панели: показ, ширина, информация ------------------------------------

function readStoredFlag(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {}
  return fallback;
}

function readStoredRosterWidth() {
  try {
    const raw = Number.parseInt(localStorage.getItem(ROSTER_W_KEY) || '', 10);
    if (Number.isFinite(raw)) return clampRosterWidth(raw);
  } catch {}
  return ROSTER_W_DEFAULT;
}

function clampRosterWidth(px) {
  return Math.min(ROSTER_W_MAX, Math.max(ROSTER_W_MIN, Math.round(px)));
}

function setRosterWidth(px, persist = true) {
  const width = clampRosterWidth(px);
  elements.app.style.setProperty('--roster-user-w', `${width}px`);
  if (elements.paneGrip) elements.paneGrip.setAttribute('aria-valuenow', String(width));
  if (persist) {
    try {
      localStorage.setItem(ROSTER_W_KEY, String(width));
    } catch {}
  }
}

function readStoredInfoWidth() {
  try {
    const raw = Number.parseInt(localStorage.getItem(INFO_W_KEY) || '', 10);
    if (Number.isFinite(raw)) return clampInfoWidth(raw);
  } catch {}
  return INFO_W_DEFAULT;
}

function clampInfoWidth(px) {
  return Math.min(INFO_W_MAX, Math.max(INFO_W_MIN, Math.round(px)));
}

function setInfoWidth(px, persist = true) {
  const width = clampInfoWidth(px);
  elements.app.style.setProperty('--info-user-w', `${width}px`);
  if (elements.infoGrip) elements.infoGrip.setAttribute('aria-valuenow', String(width));
  if (persist) {
    try {
      localStorage.setItem(INFO_W_KEY, String(width));
    } catch {}
  }
}

function setPaneVisible(pane, visible) {
  const key = pane === 'roster' ? ROSTER_ON_KEY : INFO_ON_KEY;
  const attr = pane === 'roster' ? 'roster' : 'info';
  const button = pane === 'roster' ? elements.toggleRosterBtn : elements.toggleInfoBtn;
  elements.app.dataset[attr] = visible ? 'on' : 'off';
  if (button) button.setAttribute('aria-pressed', visible ? 'true' : 'false');
  if (elements.talkPeerBtn && pane === 'info') {
    elements.talkPeerBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');
  }
  try {
    localStorage.setItem(key, String(visible));
  } catch {}
  // A panel opening or closing resizes the talk column the logo band lives
  // in; the layout has to settle first, hence the next frame.
  requestAnimationFrame(fitLogoBand);
}

function paneVisible(pane) {
  return elements.app.dataset[pane === 'roster' ? 'roster' : 'info'] !== 'off';
}

// Узкий экран показывает по одной панели за раз, широкий — держит колонки.
function togglePane(pane) {
  if (!wide.matches) {
    const current = elements.app.dataset.pane;
    if (pane === 'roster') {
      if (current === 'list') revealTalkPane();
      else elements.app.dataset.pane = 'list';
    } else if (current === 'info') {
      revealTalkPane();
    } else {
      elements.app.dataset.pane = 'info';
      renderInfoPanel();
    }
    syncPaneButtons();
    return;
  }
  const next = !paneVisible(pane);
  setPaneVisible(pane, next);
  if (pane === 'info' && next) renderInfoPanel();
}

function syncPaneButtons() {
  if (wide.matches) {
    if (elements.toggleRosterBtn) {
      elements.toggleRosterBtn.setAttribute('aria-pressed', paneVisible('roster') ? 'true' : 'false');
    }
    if (elements.toggleInfoBtn) {
      elements.toggleInfoBtn.setAttribute('aria-pressed', paneVisible('info') ? 'true' : 'false');
    }
    if (elements.talkPeerBtn) {
      elements.talkPeerBtn.setAttribute('aria-expanded', paneVisible('info') ? 'true' : 'false');
    }
    return;
  }
  const pane = elements.app.dataset.pane;
  if (elements.toggleRosterBtn) {
    elements.toggleRosterBtn.setAttribute('aria-pressed', pane === 'list' ? 'true' : 'false');
  }
  if (elements.toggleInfoBtn) {
    elements.toggleInfoBtn.setAttribute('aria-pressed', pane === 'info' ? 'true' : 'false');
  }
  if (elements.talkPeerBtn) {
    elements.talkPeerBtn.setAttribute('aria-expanded', pane === 'info' ? 'true' : 'false');
  }
}

function initPanes() {
  setRosterWidth(readStoredRosterWidth(), false);
  setInfoWidth(readStoredInfoWidth(), false);
  setPaneVisible('roster', readStoredFlag(ROSTER_ON_KEY, true));
  setPaneVisible('info', readStoredFlag(INFO_ON_KEY, window.innerWidth >= INFO_AUTO_OPEN_WIDTH));
  syncPaneButtons();
  bindPaneGrip();
  bindInfoGrip();
  renderInfoPanel();
}

function bindPaneGrip() {
  const grip = elements.paneGrip;
  if (!grip) return;

  grip.addEventListener('pointerdown', (event) => {
    if (!wide.matches) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.dataset.dragging = 'yes';
    const startX = event.clientX;
    const startWidth = elements.roster ? elements.roster.getBoundingClientRect().width : ROSTER_W_DEFAULT;

    const onMove = (move) => setRosterWidth(startWidth + (move.clientX - startX), false);
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      delete grip.dataset.dragging;
      setRosterWidth(elements.roster ? elements.roster.getBoundingClientRect().width : ROSTER_W_DEFAULT);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });

  grip.addEventListener('keydown', (event) => {
    const delta = event.key === 'ArrowLeft' ? -ROSTER_W_STEP : (event.key === 'ArrowRight' ? ROSTER_W_STEP : 0);
    if (delta === 0) return;
    event.preventDefault();
    const current = elements.roster ? elements.roster.getBoundingClientRect().width : ROSTER_W_DEFAULT;
    setRosterWidth(current + delta);
  });
}

function bindInfoGrip() {
  const grip = elements.infoGrip;
  if (!grip) return;

  grip.addEventListener('pointerdown', (event) => {
    if (!wide.matches) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.dataset.dragging = 'yes';
    const startX = event.clientX;
    const startWidth = elements.infoPanel ? elements.infoPanel.getBoundingClientRect().width : INFO_W_DEFAULT;

    // The info panel sits on the right edge, so its resize handle is its
    // LEFT edge: dragging left (negative clientX delta) grows it, the
    // opposite sign from the roster's right-edge handle.
    const onMove = (move) => setInfoWidth(startWidth + (startX - move.clientX), false);
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      delete grip.dataset.dragging;
      setInfoWidth(elements.infoPanel ? elements.infoPanel.getBoundingClientRect().width : INFO_W_DEFAULT);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });

  grip.addEventListener('keydown', (event) => {
    const delta = event.key === 'ArrowLeft' ? INFO_W_STEP : (event.key === 'ArrowRight' ? -INFO_W_STEP : 0);
    if (delta === 0) return;
    event.preventDefault();
    const current = elements.infoPanel ? elements.infoPanel.getBoundingClientRect().width : INFO_W_DEFAULT;
    setInfoWidth(current + delta);
  });
}

function countThreadNodes(thread, selector) {
  return thread ? thread.node.querySelectorAll(selector).length : 0;
}

function renderInfoPanel() {
  if (!elements.infoPanel) return;
  // Панель скрыта — считать статистику по DOM незачем.
  const shown = wide.matches ? paneVisible('info') : elements.app.dataset.pane === 'info';
  if (!shown) return;
  const isSelfChat = Boolean(self) && activePeer === self.login;
  const user = activePeer && !isSelfChat ? users.find((u) => u.login === activePeer) : null;
  const thread = activePeer ? threads.get(activePeer) : null;

  elements.infoName.textContent = activePeer
    ? (isSelfChat ? t('savedMessages') : (user ? peerLabel(user) : activePeer))
    : t('infoNoPeer');
  elements.infoLogin.textContent = activePeer && !isSelfChat ? formatLogin(activePeer) : '';
  if (elements.infoAvatar) {
    elements.infoAvatar.hidden = !activePeer;
    if (isSelfChat) paintAvatar(elements.infoAvatar, '✎', 'saved');
    else if (user) paintAvatar(elements.infoAvatar, peerLabel(user), isServiceAccount(user) ? 'service' : presenceKind(user));
    else if (activePeer) paintAvatar(elements.infoAvatar, activePeer, 'offline');
  }
  if (isSelfChat) {
    delete elements.infoPresence.dataset.online;
    elements.infoPresence.textContent = t('savedMessagesHint');
  } else if (activePeer && user) {
    if (isServiceAccount(user)) {
      elements.infoPresence.dataset.online = 'service';
      elements.infoPresence.textContent = t('officialAccount');
    } else {
      elements.infoPresence.dataset.online = presenceKind(user);
      elements.infoPresence.textContent = user.online
        ? presenceLabel(user)
        : t('peerOffline', humanLastSeen(user.lastSeen));
    }
  } else {
    elements.infoPresence.dataset.online = 'no';
    elements.infoPresence.textContent = '';
  }

  elements.infoStatMsgs.textContent = String(countThreadNodes(thread, '.row'));
  elements.infoStatImages.textContent = String(countThreadNodes(thread, '.msg-image'));
  elements.infoStatVoice.textContent = String(countThreadNodes(thread, '.voice-card'));
  elements.infoStatUnread.textContent = String(thread?.unread || 0);

  // The deployment's name, not its hostname: «облако», not
  // `repentandliveholy.org` (owner: «название … поменять на cloud»). The address
  // itself is still the socket's and the invite links' — it is only the label
  // that stops being a URL.
  elements.infoServer.textContent = t('cloudName');
  elements.infoTransport.textContent = activePeer && directState(activePeer) === 'connected'
    ? 'p2p'
    : (location.protocol === 'https:' ? 'wss' : 'ws');
  elements.infoLatency.textContent = lastLatencyMs > 0 ? t('infoLatencyValue', lastLatencyMs) : '—';
  if (elements.infoRoute) elements.infoRoute.textContent = describeRoute();
  if (elements.infoClient) elements.infoClient.textContent = describePeerClient();
  refreshPeerActions();
  paintSafetyCode(user && !isServiceAccount(user) ? user.login : null);
}

// --- The safety code in Details ------------------------------------------
//
// Both accounts' master keys as emojis that stay put until one of them resets
// its keys (core `Event::SafetyCode`): unlike the live verification, nobody has
// to be online, so the two people can read it to each other whenever they
// talk (owner, 2026-11-11: «разве они не должны всегда показываться например
// в настройках аккаунта»). The core is asked once per peer and again when
// something it is made from may have moved — keys changed, a verification
// finished, this account reset its keys.

function forgetSafetyCodes(peer = null) {
  if (peer) safetyCodes.delete(peer);
  else safetyCodes.clear();
  if (!peer || safetyAskedFor === peer) safetyAskedFor = null;
}

function paintSafetyCode(peer) {
  const box = elements.infoSafety;
  if (!box) return;
  if (!peer || !coreE2ee) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  elements.infoSafetyHeading.textContent = e2eeText('e2ee.safetyTitle');
  elements.infoSafetyTrust.textContent = e2eeText('e2ee.menuTrust');
  elements.infoSafetyConfirm.textContent = e2eeText('e2ee.safetyConfirm');
  elements.infoSafetyTrust.hidden = true;
  const code = safetyCodes.get(peer);
  if (!code && safetyAskedFor !== peer) {
    safetyAskedFor = peer;
    if (!coreE2ee.requestSafetyCode(peer)) safetyCodes.set(peer, { status: 'unavailable' });
  }
  const status = elements.infoSafetyStatus;
  elements.infoSafetyCode.replaceChildren();
  elements.infoSafetyConfirm.hidden = true;
  delete status.dataset.verified;
  const current = safetyCodes.get(peer);
  if (!current) {
    status.textContent = e2eeText('e2ee.safetyLoading');
    return;
  }
  if (current.status !== 'ready') {
    status.textContent = e2eeText(current.status === 'no_keys' ? 'e2ee.safetyNoKeys' : 'e2ee.safetyUnavailable', { peer });
    return;
  }
  for (const half of safetyCodeHalves(current.halves)) {
    const row = document.createElement('div');
    row.className = 'info-safety-half';
    const who = document.createElement('span');
    who.className = 'info-safety-login';
    who.textContent = formatLogin(half.login);
    const emojis = document.createElement('div');
    emojis.className = 'info-safety-emojis';
    emojis.setAttribute('role', 'img');
    emojis.setAttribute('aria-label', `${half.login}: ${half.labels.join(', ')}`);
    half.emojis.forEach((emoji, i) => {
      const cell = document.createElement('span');
      cell.textContent = emoji;
      cell.title = half.labels[i] || '';
      emojis.append(cell);
    });
    row.append(who, emojis);
    elements.infoSafetyCode.append(row);
  }
  // Not verified is the ordinary state and is said quietly, as an offer; the
  // one alarm is a key change, which also holds everything sent to the peer
  // until the person compares the new code or accepts the keys.
  const changed = !current.verified && coreE2ee.hasChangedKeys(peer);
  status.dataset.verified = current.verified ? 'yes' : (changed ? 'changed' : 'no');
  status.textContent = e2eeText(
    current.verified ? 'e2ee.safetyIsVerifiedShort' : (changed ? 'e2ee.safetyKeyChanged' : 'e2ee.safetyNotVerified'),
    { peer },
  );
  elements.infoSafetyConfirm.hidden = Boolean(current.verified);
  elements.infoSafetyTrust.hidden = !changed;
}

// The conversation menu's «Сверить»: Details of the open conversation,
// scrolled to the code.
function openSafetyCode() {
  setPaneVisible('info', true);
  syncPaneButtons();
  renderInfoPanel();
  elements.infoSafety?.scrollIntoView?.({ block: 'nearest' });
}

function onSafetyCode(notice) {
  const peer = String(notice.peer || '');
  if (!peer) return;
  if (safetyAskedFor === peer) safetyAskedFor = null;
  safetyCodes.set(peer, {
    status: notice.status,
    halves: notice.halves,
    masterKey: notice.masterKey,
    verified: Boolean(notice.verified),
  });
  if (peer === activePeer) renderInfoPanel();
}

// The hops a message actually takes, written out rather than left as the word
// «wss». A direct data channel does not touch the server at all — which is the
// whole point of it — and that is worth being able to see rather than assume.
function describeRoute() {
  if (!activePeer) return '—';
  const me = t('routeYou');
  const them = displayName(activePeer);
  if (directState(activePeer) === 'connected') return `${me} → ${them} ${t('routeDirect')}`;
  // The middle hop carries the same name the «Server» row does: the route says
  // which way a message goes, not which hostname carries it.
  return `${me} → ${t('cloudName')} → ${them}`;
}

// What the far end is running, as its hello said. Unknown until it greets us —
// a peer reading another conversation never does, and that is not an error.
function describePeerClient() {
  if (!activePeer) return '—';
  const claimed = peerClients.get(activePeer);
  if (claimed === undefined || claimed === null) return t('routeClientUnknown');
  return claimed === 'web' ? t('routeClientWeb') : t('routeClientCli', claimed);
}

function onBackToList() {
  elements.app.dataset.pane = 'list';
  syncPaneButtons();
}

function onLayoutChange() {
  syncPaneButtons();
  if (wide.matches && !activePeer && users.length > 0) {
    selectPeer(users[0].login);
  }
}

// --- Сообщения -----------------------------------------------------------

function threadFor(peer) {
  let thread = threads.get(peer);
  if (!thread) {
    const node = document.createElement('div');
    node.className = 'thread';
    // What `threadGrowthObserver` reports back: the node alone does not say
    // which conversation grew.
    node.dataset.peer = peer;
    node.hidden = peer !== activePeer;
    elements.transcript.append(node);
    threadGrowthObserver?.observe(node);
    thread = {
      peer,
      node,
      loaded: false,
      loadingOlder: false,
      reachedBeginning: false,
      readyForScrollLoad: false,
      oldestTs: null,
      oldestId: null,
      seen: new Set(),
      // Message ids with a «напомнить ответить» pending on them. State of the
      // *thread* rather than of the moment it was set: the hub re-sends what
      // is pending on every `auth`, and at a reload the transcript is rebuilt
      // from history, which says nothing about reminders — so every row reads
      // this as it is drawn, and a frame that arrives before its row is not
      // lost (`noteReminderSet`).
      reminded: new Set(),
      marks: new Map(),
      lastDay: null,
      unread: 0,
      reactionEvents: new Map(),
      // id -> ts, so a single read receipt can be sent for the newest of them.
      unreadIds: new Map(),
      // Newest message seen in this tab, in the shape the server sends with the
      // roster. Kept so the roster's second line moves the moment something
      // arrives, rather than at the next `users` payload.
      lastMessage: null,
      // How far the peer has read this conversation, as a timestamp — the
      // same watermark `/api/history`'s `peerReadTs` and the `read` receipt
      // frame carry. Lets the roster preview draw ✓/✓✓ on this account's own
      // last message without re-deriving it from the (possibly unrendered)
      // transcript row. See `buildRosterPreview`.
      peerReadTs: 0,
      readTs: 0,
      // The client that last moved that watermark (`web`, `cli`,
      // `android/<build>`, or `''` when unknown), carried next to it so a
      // re-render of the thread does not lose which device read it.
      peerReadVia: '',
      // How far the peer's device *holds* this conversation — the delivered
      // watermark, `peerDeliveredTs` from `/api/history` and the number the
      // live `ack` stamps onto its frame. One rung below the read watermark
      // above and advanced the same way: only forwards. See
      // `applyPeerDeliveredWatermark`.
      peerDeliveredTs: 0,
    };
    threads.set(peer, thread);
  }
  return thread;
}

// History arrives after the fact, and a message typed while it was still in
// flight is already in the thread. Appending the older page after it would
// put the newest message in the middle of the transcript, above a wall of
// history — which is exactly «написал пока не открылось, потом сообщения не
// видно». So whatever was already on screen is remembered and the freshly
// built history rows are moved in front of it.
// `peerReadTs` is how far the other side has read (see `/api/history`): every
// own message at or below it is drawn ✓✓ in the accent colour instead of
// falling back to one ✓. `peerReadVia` names the client that moved that
// watermark, or `''` when the server has not recorded one.
//
// `peerDeliveredTs` is the rung below it — how far their *device* holds the
// conversation — and paints the same ✓✓ without the colour, so a message the
// peer's phone has received but not yet opened stops looking like one their
// server never got. Delivered goes first: reading implies holding, so on a mark
// both watermarks cover the read pass has to have the last word.
function populateHistory(thread, messages, peerReadTs = 0, peerReadAt = 0, peerReadVia = '', peerDeliveredTs = 0) {
  // The paging cursor moves past an edit's carrier even though it is not drawn,
  // or a page made only of carriers would be asked for again forever.
  for (const carrier of Array.isArray(messages) ? messages : []) {
    if (carrier?.sealedEdit !== true || !Number.isFinite(carrier.ts)) continue;
    if (thread.oldestTs === null || carrier.ts < thread.oldestTs) {
      thread.oldestTs = carrier.ts;
      thread.oldestId = carrier.id || null;
    }
  }
  messages = decryptHistoryPage(thread.peer, messages);
  const liveRows = [...thread.node.childNodes];
  const anchor = liveRows[0] || null;
  const deliveredUpTo = Math.max(thread.peerDeliveredTs || 0, Number.isFinite(peerDeliveredTs) ? peerDeliveredTs : 0);
  applyPeerDeliveredWatermark(thread, deliveredUpTo);
  if (Number.isFinite(peerReadTs) && peerReadTs > (thread.peerReadTs || 0)) {
    thread.peerReadTs = peerReadTs;
    thread.peerReadAt = peerReadAt;
    thread.peerReadVia = peerReadVia;
    scheduleRosterRender();
  }
  const readUpTo = thread.peerReadTs || 0;
  peerReadAt = thread.peerReadAt || peerReadAt;
  peerReadVia = thread.peerReadVia || '';
  for (const message of messages) {
    if (message && Number.isFinite(message.ts)) {
      if (thread.oldestTs === null || message.ts < thread.oldestTs) {
        thread.oldestTs = message.ts;
        thread.oldestId = message.id || null;
      }
    }
    const existing = message.id ? thread.node.querySelector(`[data-id="${CSS.escape(message.id)}"]`) : null;
    if (existing) {
      // A row already on screen must still take the server's read watermark:
      // the peer's `read` frame only reaches a session subscribed to that
      // conversation, so a message sent from another device of this account
      // (phone, CLI) sat on a single ✓ here until the page was reloaded, even
      // though `/history` had been saying ✓✓ all along.
      if (message.id && readUpTo > 0 && message.from === self?.login) {
        const mark = thread.marks.get(message.id);
        if (mark && (message.ts || 0) <= readUpTo) setMark(mark, 'read', peerReadAt, peerReadVia);
      }
      // This message is in the server's answer, so the server has it. For a row
      // this tab is still holding in its durable queue that is the same proof
      // `message-accepted` gives — the receipt can be lost on the way back
      // while the commit very much stands — and the server's own `ts` replaces
      // the local one for the same reason everywhere else: a watermark is
      // measured against the stored time, so a skewed local clock would leave
      // the ✓✓ unreachable forever.
      const ownMark = message.id ? thread.marks.get(message.id) : null;
      if (ownMark && message.from === self?.login) {
        if (Number.isFinite(message.ts) && message.ts > 0) ownMark.dataset.ts = String(message.ts);
        // The log has it, so the server committed it: ✓. Not the ✓✓ of a
        // delivery — that is `peerDeliveredTs` above and their own `ack`, and
        // the server's answer says nothing about their device. A mark the
        // delivered watermark already raised is left where it is.
        if (ownMark.dataset.state === 'queued') {
          setMark(ownMark, 'sent');
          settleCommittedMark(thread, ownMark);
        }
        if (message.id) forgetPendingSend(thread.peer, message.id);
      }
      if (message.deletedAt) tombstoneMessage(thread, existing);
      else if (existing.dataset.deleted !== 'true') {
        // Drawn earlier as "the key has not arrived", opened since: the whole
        // row, not its words alone (`redrawOpenedRow`).
        const sealedKey = `${thread.peer}\n${message.id}`;
        if (message.sealed === false && coreSealedRows.has(sealedKey)) {
          coreSealedRows.delete(sealedKey);
          if (redrawOpenedRow(thread, message)) continue;
        }
        if (typeof message.text === 'string' && existing.messageText !== message.text) {
          updateMessageText(thread.peer, message.id, message.text, message.editedAt);
        }
        if (message.editedAt) markMessageEdited(existing, message.editedAt);
        // The row already exists, so a reminder that arrived before it (a
        // reconnect mid-thread) has to be applied here too —
        // `markMessageReminded` itself is the one that knows it is idempotent.
        if (message.id) markMessageRemindedIfPending(thread, existing, message.id);
        existing.reactions = structuredClone(message.reactions || {});
        renderReactionButtons(existing);
      }
      continue;
    }
    const isAi = message.kind === 'ai' || message.author === 'ai';
    const own = isAi ? false : (message.from === self?.login);
    const author = isAi
      ? (message.author && message.author !== 'ai' ? message.author : 'tailik')
      : (own ? self.name : displayName(message.from));
    const voice = mediaSource(thread.peer, message.id, message.voice, 'voice');
    if (voice) {
      appendVoiceMessage(thread, {
        id: message.id,
        own,
        author,
        dataUrl: voice.dataUrl || null,
        mediaRef: voice.mediaRef || null,
        duration: voice.duration || 0,
        reactions: message.reactions,
        ts: message.ts || Date.now(),
        delivered: own && deliveredUpTo > 0 && (message.ts || 0) <= deliveredUpTo,
        read: own && readUpTo > 0 && (message.ts || 0) <= readUpTo,
        readAt: own && readUpTo > 0 && (message.ts || 0) <= readUpTo ? peerReadAt : 0,
        readVia: own && readUpTo > 0 && (message.ts || 0) <= readUpTo ? peerReadVia : '',
        text: typeof message.text === 'string' ? message.text : '',
        forwardedFrom: message.forwardedFrom,
        editedAt: message.editedAt,
      });
      continue;
    }
    // `mediaDropped` is the server telling us the attachment was evicted to
    // keep the conversation's stored media under budget (see
    // `CLOUD_HISTORY_MEDIA_BUDGET_CHARS`). The message itself is still real,
    // so it is drawn — with an honest note instead of a broken player.
    const text = message.mediaDropped && !message.text
      ? t('mediaExpired')
      : (message.text || '');
    appendMessage(thread, {
      id: message.id,
      own,
      kind: isAi ? 'ai' : 'human',
      author,
      text,
      image: mediaSource(thread.peer, message.id, message.image, 'image'),
      ts: message.ts || Date.now(),
      reactions: message.reactions,
      replyTo: message.replyTo,
      forwardedFrom: message.forwardedFrom,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
      delivered: own && deliveredUpTo > 0 && (message.ts || 0) <= deliveredUpTo,
      read: own && readUpTo > 0 && (message.ts || 0) <= readUpTo,
      readAt: own && readUpTo > 0 && (message.ts || 0) <= readUpTo ? peerReadAt : 0,
      readVia: own && readUpTo > 0 && (message.ts || 0) <= readUpTo ? peerReadVia : '',
      buttons: message.buttons,
    });
  }
  if (anchor) {
    for (const node of [...thread.node.childNodes]) {
      if (liveRows.includes(node)) continue;
      thread.node.insertBefore(node, anchor);
    }
    // The day divider bookkeeping now describes history, not the live rows
    // that ended up below it; reset it so the next message re-dates itself.
    thread.lastDay = null;
  }
  normalizeDateDividers(thread);
  paintReactionEvents(thread);
  // Anything this tab is still holding for this peer is, by definition, absent
  // from the page just merged — that is what being unsent means — so the rows
  // for it are drawn here rather than disappearing with the draft that produced
  // them. This is also the reload path: after a refresh the queue is read back
  // from storage and its rows reappear in the thread they belong to.
  ensurePendingRows(thread, thread.peer);
  // A history that turned out to be *empty* appends no row, and so reaches
  // none of the renders above: this is the one moment the actions bar learns
  // that an empty thread has finished loading and the menu can be offered.
  if (thread.peer === activePeer) renderBotActions();
  requestAnimationFrame(flushReactionReads);
}

// --- Syntax highlighting for fenced code (```) --------------------------
//
// Mirrors src/highlight.js's tokenizer: a pure, dependency-free function with
// no Node or blessed dependency, so it works verbatim in a browser. It is
// hand-mirrored rather than imported because app.js is a classic <script>
// with no bundler in this project, and src/ is not on the web server's
// static allow-list. Keep the two in sync by hand if one changes.
const CODE_ALIASES = {
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  js: 'js', javascript: 'js', mjs: 'js', ts: 'js', typescript: 'js', jsx: 'js',
  py: 'python', python: 'python',
  json: 'json',
};

const CODE_KEYWORDS = {
  shell: [
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while',
    'until', 'case', 'esac', 'function', 'return', 'break', 'continue', 'local',
  ],
  js: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'of', 'in', 'new', 'class', 'extends', 'try', 'catch', 'finally', 'throw',
    'async', 'await', 'import', 'export', 'from', 'default', 'typeof', 'switch',
    'case', 'break', 'continue', 'delete', 'void', 'instanceof', 'yield', 'super',
  ],
  python: [
    'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and',
    'or', 'is', 'import', 'from', 'as', 'class', 'try', 'except', 'finally',
    'raise', 'with', 'lambda', 'yield', 'pass', 'global', 'nonlocal', 'assert',
    'del', 'break', 'continue', 'async', 'await',
  ],
  json: [],
};

const CODE_CONSTANTS = {
  shell: ['true', 'false'],
  js: [
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this', 'globalThis',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set',
    'Symbol', 'JSON', 'Math', 'Date', 'RegExp', 'Error',
  ],
  python: [
    'None', 'True', 'False', 'self', 'cls', 'NotImplemented', 'str', 'int',
    'float', 'bool', 'bytes', 'list', 'dict', 'tuple', 'set',
  ],
  json: ['true', 'false', 'null'],
};

const CODE_COMMENT = { shell: '#', python: '#', js: '//', json: null };
const CODE_GENERIC_OPERATORS = /^(?:&&|\|\||=>|===|!==)/;
const CODE_GENERIC_COMMENT = /^\s*(?:#\s|\/\/)/;
const CODE_GENERIC_CONSTANTS = ['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN'];

const CODE_OPERATORS = {
  shell: /^(?:\$\(|`|&&|\|\||\||;;|;|&|\d?>>|\d?>&\d?|\d?>|<<<|<<|<|=)/,
  js: /^(?:=>|===|!==|==|!=|<=|>=|\*\*|&&|\|\||\?\?|\?\.|[=+\-*/%<>!?:&|^~])/,
  python: /^(?:==|!=|<=|>=|\*\*|\/\/|->|[=+\-*/%<>:&|^~])/,
  json: /^[:,]/,
};

const CODE_PUNCT = {
  shell: /^[[\](){}:,.*?~!@%^-]/,
  js: /^[[\](){};,.#@]/,
  python: /^[[\](){};,.@]/,
  json: /^[[\]{}]/,
};
const CODE_GENERIC_PUNCT = /^[[\](){};,]/;

const CODE_WORDS = {
  shell: /^[A-Za-z_][\w-]*/,
  js: /^[A-Za-z_$][\w$]*/,
  python: /^[A-Za-z_]\w*/,
  json: /^[A-Za-z_]\w*/,
};
const CODE_GENERIC_WORD = /^[A-Za-z_$][\w$]*/;

const CODE_QUOTED = /^(['"`])(?:\\.|[^\\])*?\1/;
const CODE_OPEN_QUOTE = /^(['"`]).*/;
const CODE_ESCAPE = /\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[\s\S])/g;
const CODE_NUMBER = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/;

const CODE_SHELL_VARIABLE = /^\$(?:\{[^}]*\}?|[A-Za-z_]\w*|[0-9@*#?$!_-])/;
const CODE_SHELL_FLAG = /^--?[A-Za-z0-9][\w-]*/;
const CODE_SHELL_PATHS = [
  /^(?:~|\.{1,2})?\/[^\s'"`;|&<>#()]*/,
  /^(?=[\w@%+-]*[A-Za-z])[\w@%+-]+(?:\.[\w+-]+)+/,
];

const CODE_COMMAND_AFTER_OPERATOR = new Set(['|', '||', '&&', ';', ';;', '&', '$(', '`']);
const CODE_COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'time', 'nohup', 'xargs', 'exec', 'command', 'watch',
  'then', 'do', 'else',
]);

function normaliseCodeLanguage(info) {
  const name = String(info ?? '').trim().toLowerCase().split(/\s+/)[0];
  return CODE_ALIASES[name] ?? null;
}

function isCodeCommandPosition(prev) {
  if (!prev) return true;
  if (prev.kind === 'operator') return CODE_COMMAND_AFTER_OPERATOR.has(prev.text);
  if (prev.kind === 'punct') return prev.text === '(' || prev.text === '{';
  return CODE_COMMAND_WRAPPERS.has(prev.text);
}

function codeWordKind(word, after, language, prev) {
  if (language) {
    if (CODE_KEYWORDS[language].includes(word)) return 'keyword';
    if (CODE_CONSTANTS[language].includes(word)) return 'builtin';
  } else if (CODE_GENERIC_CONSTANTS.includes(word)) {
    return 'builtin';
  }
  if (prev && prev.kind === 'keyword') {
    if (prev.text === 'class') return 'type';
    if (prev.text === 'function' || prev.text === 'def') return 'function';
  }
  if (after.startsWith('(')) return 'function';
  if (language === 'shell' && isCodeCommandPosition(prev)) return 'function';
  if ((language === 'js' || language === 'python')
      && prev && prev.kind === 'punct' && prev.text === '.') return 'member';
  if ((language === 'js' || language === 'python') && /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
    return 'type';
  }
  if (language === 'shell') return 'plain';
  return 'identifier';
}

function splitCodeEscapes(text, quote, language) {
  if (language === 'shell' && quote === "'") return [{ kind: 'string', text }];
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(CODE_ESCAPE)) {
    if (match.index > last) parts.push({ kind: 'string', text: text.slice(last, match.index) });
    parts.push({ kind: 'escape', text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'string', text: text.slice(last) });
  return parts;
}

function shellCodeToken(line) {
  const variable = CODE_SHELL_VARIABLE.exec(line);
  if (variable) return { kind: 'builtin', text: variable[0] };
  const operator = CODE_OPERATORS.shell.exec(line);
  if (operator) return { kind: 'operator', text: operator[0] };
  const flag = CODE_SHELL_FLAG.exec(line);
  if (flag) return { kind: 'flag', text: flag[0] };
  for (const pattern of CODE_SHELL_PATHS) {
    const path = pattern.exec(line);
    if (path) return { kind: 'string', text: path[0] };
  }
  return null;
}

function nextCodeTokens(line, language, atStart, prev) {
  const comment = CODE_COMMENT[language];
  if (comment && line.startsWith(comment)) return [{ kind: 'comment', text: line }];
  if (!language && atStart && CODE_GENERIC_COMMENT.test(line)) return [{ kind: 'comment', text: line }];
  const quoted = CODE_QUOTED.exec(line) ?? CODE_OPEN_QUOTE.exec(line);
  if (quoted) return splitCodeEscapes(quoted[0], quoted[1], language);
  if (language === 'shell') {
    const shell = shellCodeToken(line);
    if (shell) return [shell];
  }
  const number = CODE_NUMBER.exec(line);
  if (number) return [{ kind: 'number', text: number[0] }];
  const operator = (language ? CODE_OPERATORS[language] : CODE_GENERIC_OPERATORS).exec(line);
  if (operator) return [{ kind: 'operator', text: operator[0] }];
  const word = (language ? CODE_WORDS[language] : CODE_GENERIC_WORD).exec(line);
  if (word) {
    const after = line.slice(word[0].length);
    return [{ kind: codeWordKind(word[0], after, language, prev), text: word[0] }];
  }
  const punct = (language ? CODE_PUNCT[language] : CODE_GENERIC_PUNCT).exec(line);
  if (punct) return [{ kind: 'punct', text: punct[0] }];
  return [{ kind: 'plain', text: line[0] }];
}

function codeTokenise(line, language) {
  const tokens = [];
  let rest = line;
  let prev = null;
  while (rest.length > 0) {
    const next = nextCodeTokens(rest, language, rest.length === line.length, prev);
    for (const token of next) {
      const last = tokens[tokens.length - 1];
      if (last && last.kind === token.kind && token.kind === 'plain') last.text += token.text;
      else tokens.push({ ...token });
      if (token.text.trim()) prev = token;
      rest = rest.slice(token.text.length);
    }
  }
  return tokens;
}

// A small, deliberately conservative palette: existing theme accent variables
// (already correct in every colour theme and both light/dark modes) rather
// than a dozen hardcoded hex values tuned for one dark terminal palette that
// would only ever look right there. Kinds left out (plain, identifier) render
// in the code block's own text colour instead of adding a span for nothing.
const CODE_TOKEN_STYLE = {
  comment: { color: 'var(--muted)' },
  string: { color: 'var(--amber)' },
  escape: { color: 'var(--danger)' },
  number: { color: 'var(--ai)' },
  keyword: { color: 'var(--cobalt)', bold: true },
  builtin: { color: 'var(--cobalt)' },
  function: { color: 'var(--signal)' },
  member: { color: 'var(--signal)' },
  type: { color: 'var(--ai)' },
  flag: { color: 'var(--cobalt)' },
  operator: { color: 'var(--muted)' },
  punct: { color: 'var(--muted)' },
};

// A fence may name its language on its own opening line, same as GitHub
// markdown (```js). Strip that line out of what is shown instead of letting
// it read as the code's own first line — `text.slice(3, -3).trim()` used to
// hand the language tag straight to the reader as pasted code.
function parseFencedCode(text) {
  const inner = text.slice(3, -3);
  const firstBreak = inner.indexOf('\n');
  if (firstBreak === -1) return { language: null, code: inner.trim() };
  const tag = inner.slice(0, firstBreak).trim();
  if (tag && /^[A-Za-z][\w+-]*$/.test(tag)) {
    return { language: tag, code: inner.slice(firstBreak + 1).replace(/\n$/, '') };
  }
  return { language: null, code: inner.trim() };
}

function renderCodeBlock(text) {
  const { language, code } = parseFencedCode(text);
  const lang = normaliseCodeLanguage(language);
  const pre = document.createElement('pre');
  pre.className = 'msg-code';
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    for (const token of codeTokenise(line, lang)) {
      const style = CODE_TOKEN_STYLE[token.kind];
      if (!style) {
        pre.append(document.createTextNode(token.text));
        continue;
      }
      const span = document.createElement('span');
      span.style.color = style.color;
      if (style.bold) span.style.fontWeight = '700';
      span.textContent = token.text;
      pre.append(span);
    }
    if (i < lines.length - 1) pre.append(document.createTextNode('\n'));
  });
  return pre;
}

// Shared by appendMessage and updateMessageText, so an edited fenced-code or
// quote message re-renders the same way it did the first time instead of
// falling back to plain linked text — before this they were two separate
// copies of the same three-way branch, and only one of them knew about
// renderCodeBlock.
function renderMessageBody(container, text) {
  if (text.startsWith('```') && text.endsWith('```')) {
    container.append(renderCodeBlock(text));
  } else if (text.startsWith('> ')) {
    const quote = document.createElement('blockquote');
    quote.className = 'msg-quote';
    appendEmojiText(quote, text.slice(2));
    container.append(quote);
  } else {
    formatTextWithLinks(container, text);
  }
}

// Names still travel with every row for export and forward; in a 1:1 chat
// only an AI/service author (or a distinct author) needs a visible label.
function appendMessageAuthor(content, thread, { own, kind, author }) {
  if (own) return;
  const peer = users.find(user => user.login === thread.peer);
  const authorAccount = users.find(user => user.login === author || user.name === author);
  const service = isServiceAccount(peer) || isServiceAccount(authorAccount)
    || ['tailchat', 'tailik'].includes(thread.peer) || ['tailchat', 'tailik'].includes(author);
  const peerNames = [thread.peer, peer?.name, peer && peerLabel(peer), displayName(thread.peer)];
  if (kind !== 'ai' && !service && peerNames.includes(author)) return;
  const label = document.createElement('span');
  label.className = 'bubble-author';
  label.textContent = `{${author}}`;
  content.append(label);
}

// The hidden inline copy has exactly the real meta's width in every font and
// receipt state. It reserves the end of the final text line; the real controls
// stay bottom-right. Cards/block text use the same compact-height spacer below.
// No geometry reads or observers: metadata setters refresh the copy in place.
function layoutMessageMeta(row) {
  const content = row.querySelector('.bubble-content');
  const meta = row.querySelector('.bubble-meta');
  if (!content || !meta) return;
  content.querySelector('.bubble-meta-spacer')?.remove();
  if (row.dataset.image === 'bare') return;
  if (meta.parentElement !== content) content.append(meta);
  const last = meta.previousElementSibling;
  const spacer = meta.cloneNode(true);
  spacer.className = 'bubble-meta-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  spacer.inert = true;
  if (last?.matches('.bubble-text') && !last.querySelector('.msg-code, .msg-quote')) last.append(spacer);
  else meta.before(spacer);
}

function appendMessage(thread, {
  id, own, kind, author, text = '', image = null, attachment = null, reactions = null, ts, delivered = false,
  read = false, readAt = 0, readVia = '',
  queued = false,
  replyTo = null,
  forwardedFrom = null,
  editedAt = null,
  deletedAt = null,
  buttons = null,
}) {
  if (id && thread.seen.has(id)) return;
  if (id) thread.seen.add(id);

  // Recorded here rather than at each of the eight call sites, so the roster
  // line and the transcript can never disagree about what was said last.
  notePreview(thread.peer, {
    id,
    from: own ? self?.login : thread.peer,
    ts,
    kind: kind === 'ai' ? 'ai' : 'human',
    author,
    text,
    // A file counts as something said: without this the roster would keep
    // showing the message before it and claim that was the last word.
    media: image ? 'image' : (attachment ? 'file' : null),
  });


  const row = document.createElement('article');
  row.className = 'row';
  row.dataset.ts = String(ts);
  row.dataset.side = own ? 'own' : 'peer';
  row.dataset.kind = kind;
  row.dataset.author = author;
  if (id) row.dataset.id = id;
  if (editedAt) row.dataset.editedAt = String(editedAt);
  if (id) messageAttachments.set(id, { image, voice: null });
  row.reactions = reactions && typeof reactions === 'object' ? structuredClone(reactions) : {};

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const content = document.createElement('div');
  content.className = 'bubble-content';


  const replyEl = replyTo && typeof replyTo === 'object' && replyTo.id ? buildReplyQuote(replyTo) : null;
  const forwardEl = forwardedFrom && typeof forwardedFrom === 'object'
    ? buildForwardLabel(forwardedFrom) : null;
  let textEl = null;
  // A picture's text is laid out by `layoutImageMessage`: a caption goes under
  // the picture, a placeholder is not drawn at all.
  if (text !== '' && !hasPicture(image)) {
    textEl = document.createElement('p');
    textEl.className = 'bubble-text';
    renderMessageBody(textEl, text);
  }

  const meta = document.createElement('span');
  meta.className = 'bubble-meta';
  const timeEl = document.createElement('time');
  timeEl.className = 'bubble-time';
  timeEl.dateTime = new Date(ts).toISOString();
  timeEl.textContent = timeFormat.format(ts);
  meta.append(timeEl);

  if (own) {
    const mark = document.createElement('span');
    mark.className = 'bubble-mark';
    mark.dataset.ts = String(ts);
    setMark(mark, queued ? 'queued' : (read ? 'read' : (delivered ? 'ack' : 'sent')), readAt, readVia);
    meta.append(mark);
    if (id) thread.marks.set(id, mark);
  }
  const media = image ? 'image' : (attachment ? 'file' : null);
  attachMessageActions(row, {
    id, own, text, author, media,
  });

  appendMessageAuthor(content, thread, { own, kind, author });
  if (forwardEl) content.append(forwardEl);
  if (replyEl) content.append(replyEl);
  if (hasPicture(image)) content.append(buildImagePreview(image));
  if (textEl) content.append(textEl);
  if (attachment?.url) content.append(buildFileCard(attachment));
  if (Array.isArray(buttons) && buttons.length > 0) {
    content.append(buildMessageButtons(buttons));
  }
  content.append(meta);
  bubble.append(content);
  row.append(bubble);
  layoutMessageMeta(row);
  if (hasPicture(image)) layoutImageMessage(row, text);
  markJumboEmoji(row, text);
  renderReactionButtons(row);
  if (editedAt) markMessageEdited(row, editedAt);
  markMessageRemindedIfPending(thread, row, id);
  if (deletedAt) tombstoneMessage(thread, row);
  else maybeAttachLinkPreview(row, bubble, text);
  thread.node.append(row);
  paintReactionEvents(thread);
  scheduleDateDividers(thread);
  renderInfoPanel();
}
function buildMessageButtons(buttons) {
  const container = document.createElement('div');
  container.className = 'bubble-buttons';
  for (const item of buttons) {
    if (!item || typeof item !== 'object') continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bubble-btn';
    btn.textContent = item.label || item.id;
    btn.dataset.actionValue = item.value;
    btn.disabled = !activePeer || isBlockedPeer(activePeer);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      sendPlainMessage(item.value);
    });
    container.append(btn);
  }
  return container;
}


// «Переслано от …»: a label, not a link. A forward is a copy — the original
// lives in another conversation this account may not even be able to open.
function buildForwardLabel(forwardedFrom) {
  const label = document.createElement('p');
  label.className = 'bubble-forward';
  const who = forwardedFrom.name
    || users.find((u) => u.login === forwardedFrom.login)?.name
    || forwardedFrom.login
    || '';
  label.textContent = t('msgForwardedFrom', who);
  return label;
}

// The quoted reference a reply carries: a snapshot taken when it was sent,
// not a live lookup, so it still reads correctly even if the original later
// scrolled out of the loaded history or was deleted on the other side.
// Clicking it jumps to the original when that row is still on screen.
function buildReplyQuote(replyTo) {
  const quote = document.createElement('button');
  quote.type = 'button';
  quote.className = 'bubble-reply';
  quote.dataset.replyId = replyTo.id;
  const who = document.createElement('span');
  who.className = 'bubble-reply-author';
  // Not `displayName()`: that names your own login «Избранное»/Saved
  // Messages, which is a real label for a real conversation, not a person —
  // fine at the top of Saved Messages, wrong as the author of a quote inside
  // it. Replying to yourself has to still say your own name.
  const quoted = replyTo.from === self?.login ? null : users.find((u) => u.login === replyTo.from);
  who.textContent = replyTo.from === self?.login
    ? (self.name || self.login)
    : (quoted ? peerLabel(quoted) : replyTo.from);
  const snippet = document.createElement('span');
  snippet.className = 'bubble-reply-snippet';
  appendEmojiText(snippet, replyTo.text || previewMediaLabel(replyTo.media));
  quote.append(who, snippet);
  quote.addEventListener('click', (event) => {
    event.stopPropagation();
    scrollToMessage(replyTo.id);
  });
  return quote;
}

// A message that is nothing but one to three emoji drops its bubble and shows
// them large (A2). Anything else in the bubble — a reply quote, a forward
// label, a picture, a file, bot buttons — keeps the bubble it needs.
function markJumboEmoji(row, text) {
  const alone = !row.dataset.image
    && !row.querySelector('.bubble-reply, .bubble-forward, .file-card, .bubble-buttons');
  if (alone && isJumboEmoji(text)) row.dataset.jumbo = 'true';
  else delete row.dataset.jumbo;
}

function scrollToMessage(id) {
  if (!activePeer || !id) return;
  const row = threads.get(activePeer)?.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('row-flash');
  setTimeout(() => row.classList.remove('row-flash'), 900);
}

// The three markers the composer's Cmd/Ctrl+B, +I and +U insert, rendered as
// the elements they stand for. Everything the person typed is added as text
// (`appendEmojiText`) — the markup is built from elements, so no message can
// ever become HTML — and the pass is recursive so `**very *loud***` nests as
// written.
const EMPHASIS_RE = /\*\*([^\s*][^*]*?)\*\*|__([^\s_][^_]*?)__|\*([^\s*][^*]*?)\*/;
const EMPHASIS_MAX_DEPTH = 4;

function appendEmphasis(container, text, depth = 0) {
  let rest = text;
  if (depth < EMPHASIS_MAX_DEPTH) {
    for (let match = EMPHASIS_RE.exec(rest); match !== null; match = EMPHASIS_RE.exec(rest)) {
      if (match.index > 0) appendEmojiText(container, rest.slice(0, match.index));
      const tag = match[1] !== undefined ? 'strong' : (match[2] !== undefined ? 'u' : 'em');
      const el = document.createElement(tag);
      appendEmphasis(el, match[1] ?? match[2] ?? match[3], depth + 1);
      container.append(el);
      rest = rest.slice(match.index + match[0].length);
    }
  }
  if (rest !== '') appendEmojiText(container, rest);
}

function formatTextWithLinks(container, text) {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  let lastIdx = 0;
  let match;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      appendEmphasis(container, text.substring(lastIdx, match.index));
    }
    const a = document.createElement('a');
    a.href = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = match[0];
    container.append(a);
    lastIdx = urlRe.lastIndex;
  }
  if (lastIdx < text.length) {
    appendEmphasis(container, text.substring(lastIdx));
  }
}

// One preview card per message, built from whatever URL appears first in
// its text. The metadata fetch (title/description) is server-side
// (`/api/link-preview`, see `src/cloud/link-preview.js`) — the reader's
// browser never reaches that third-party host on its own for the HTML.
// The picture is the one exception: it loads as a normal `<img>` in the
// reader's own browser, the way every other chat client's link preview
// works too, so that host does see the reader's IP for the image request.
// `referrerpolicy="no-referrer"` at least keeps it from also learning which
// conversation the image came from. Cached per session by URL so scrolling
// through history with the same link posted twice costs one metadata
// request, not two.
const LINK_PREVIEW_URL_RE = /https?:\/\/[^\s]+/;
const linkPreviewCache = new Map();

function firstUrlIn(text) {
  const match = LINK_PREVIEW_URL_RE.exec(text || '');
  return match ? match[0].replace(/[.,!?;:]+$/, '').replace(/[)\]}]+$/, ending => {
    const pairs = { ')': '(', ']': '[', '}': '{' };
    return [...ending].filter(char => match[0].includes(pairs[char])).join('');
  }) : null;
}

async function fetchLinkPreviewClient(url) {
  if (linkPreviewCache.has(url)) return linkPreviewCache.get(url);
  const pending = request('GET', `/link-preview?url=${encodeURIComponent(url)}`)
    .then((data) => data.preview || null)
    .catch(() => null);
  linkPreviewCache.set(url, pending);
  const preview = await pending;
  if (preview) linkPreviewCache.set(url, preview);
  else linkPreviewCache.delete(url);
  return preview;
}

// The card's layout depends on the picture's own size, so the picture is
// settled before the card exists: inserting first and rearranging on `load`
// is exactly the jump under the reader this avoids. A host that neither
// answers nor fails within the wait gets a text card — the title should not
// hang on a slow image server. Not `loading="lazy"`: a lazy image that is not
// in the document never starts loading, and this one joins it only after.
const LINK_PREVIEW_IMAGE_WAIT_MS = 5000;
// Hero: wide enough to fill the bubble without turning to mush, and not a
// banner — a 4:1 strip across the top is a sliver, not a picture.
const LINK_PREVIEW_HERO_MIN_WIDTH = 240;
const LINK_PREVIEW_HERO_MAX_RATIO = 2.2;
// Below this on either side the `og:image` is a favicon or a tracking pixel,
// not something to show; under the thumbnail's own 56px it is shown at its
// own size rather than blown up into a blur (`--icon`).
const LINK_PREVIEW_MIN_IMAGE = 24;
const LINK_PREVIEW_THUMB = 56;

function settleLinkPreviewImage(img) {
  return new Promise((resolve) => {
    const finish = (loaded) => {
      clearTimeout(timer);
      resolve(loaded);
    };
    const timer = setTimeout(finish, LINK_PREVIEW_IMAGE_WAIT_MS, false);
    img.decode().then(() => finish(img.naturalWidth > 0 && img.naturalHeight > 0), () => finish(false));
  });
}

function linkPreviewLayout(img, video) {
  const { naturalWidth: width, naturalHeight: height } = img;
  if (Math.min(width, height) < LINK_PREVIEW_MIN_IMAGE) return 'text';
  // YouTube stays a hero whatever size its thumbnail turns out to be: the
  // play pill is what says «video», and it needs the picture under it.
  if (video) return 'hero';
  if (width >= LINK_PREVIEW_HERO_MIN_WIDTH && width / height <= LINK_PREVIEW_HERO_MAX_RATIO) return 'hero';
  return 'thumb';
}

// Resolves to `null` when there is nothing worth a card: no title means a
// bare link in the text, whatever else the page offered.
async function buildLinkPreviewCard(preview) {
  if (!preview.title || !/^https?:\/\//i.test(preview.url || '')) return null;
  const card = document.createElement('a');
  card.href = preview.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  const videoId = youtubeVideoId(preview.url);
  const imageUrl = preview.image || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);
  let layout = 'text';
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    const img = document.createElement('img');
    img.className = 'link-preview-image';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = imageUrl;
    if (await settleLinkPreviewImage(img)) layout = linkPreviewLayout(img, Boolean(videoId));
    if (layout === 'text') {
      img.removeAttribute('src');
    } else {
      // The hero's crop-or-fit choice is made in `app.css` against the card's
      // live width, which only CSS knows on every resize; it needs the ratio.
      img.style.setProperty('--ratio', String(img.naturalWidth / img.naturalHeight));
      if (layout === 'thumb' && Math.min(img.naturalWidth, img.naturalHeight) < LINK_PREVIEW_THUMB) {
        img.classList.add('link-preview-image--icon');
      }
      card.append(img);
      if (videoId) {
        const play = document.createElement('span');
        play.className = 'link-preview-play';
        play.textContent = '▶ YouTube';
        card.append(play);
      }
      // Already decoded, so this is the rare re-fetch failing later (cache
      // evicted, host gone): the card falls back to text in place instead of
      // keeping an empty frame where the picture was.
      img.addEventListener('error', () => {
        card.querySelectorAll('.link-preview-image, .link-preview-play').forEach(node => node.remove());
        card.className = 'link-preview link-preview--text';
      }, { once: true });
    }
  }
  card.className = `link-preview link-preview--${layout}`;
  const body = document.createElement('div');
  body.className = 'link-preview-body';
  if (preview.siteName) {
    const site = document.createElement('span');
    site.className = 'link-preview-site';
    site.textContent = preview.siteName;
    body.append(site);
  }
  const title = document.createElement('span');
  title.className = 'link-preview-title';
  title.textContent = preview.title;
  body.append(title);
  // Built for every layout and hidden by CSS on a thumbnail, so a thumbnail
  // that falls back to text gets its description back.
  if (preview.description) {
    const desc = document.createElement('span');
    desc.className = 'link-preview-desc';
    desc.textContent = preview.description;
    body.append(desc);
  }
  card.append(body);
  return card;
}

// Fire-and-forget from `appendMessage`, edits and the settings toggle: the
// bubble is already fully drawn and on screen by the time this resolves, so
// it only has to still be there and still be the same text — a deleted or
// re-edited message, or a toggle switched off meanwhile, is left alone rather
// than growing a card for a link it no longer has. Checked twice, because
// the picture's wait is a second chance for any of that to happen.
function maybeAttachLinkPreview(row, bubble, text) {
  const revision = row.previewRevision = (row.previewRevision || 0) + 1;
  bubble.querySelector('.link-preview')?.remove();
  layoutMessageMeta(row);
  if (!linkPreviewEnabled || row.dataset.deleted === 'true') return;
  const url = firstUrlIn(text);
  if (!url) return;
  const stale = () => row.previewRevision !== revision || row.dataset.deleted === 'true' || !row.isConnected || !linkPreviewEnabled;
  void (async () => {
    const preview = await fetchLinkPreviewClient(url);
    if (!preview || stale()) return;
    const card = await buildLinkPreviewCard(preview);
    if (!card || stale() || bubble.querySelector('.link-preview')) return;
    const content = bubble.querySelector('.bubble-content');
    content.insertBefore(card, content.querySelector(':scope > .bubble-meta'));
    layoutMessageMeta(row);
    // The thread's own `threadGrowthObserver` already follows the tail when
    // this card grows it; calling here as well would scroll twice.
    if (!threadGrowthObserver) followTailGrowth(row.closest('.thread')?.dataset.peer);
  })();
}

function renderReactionButtons(row) {
  const bubble = row.querySelector('.bubble');
  let container = bubble.querySelector('.bubble-reactions');
  const entries = Object.entries(row.reactions || {}).filter(([, members]) => Array.isArray(members) && members.length > 0);
  if (entries.length === 0) {
    container?.remove();
    return;
  }
  if (!container) {
    container = document.createElement('span');
    container.className = 'bubble-reactions';
  }
  // Reactions always have their own row below the content, never in the
  // timestamp's reserved last-line space or an image's overlay pill.
  bubble.append(container);
  container.replaceChildren();
  for (const [emoji, members] of entries) {
    const button = document.createElement('button');
    button.className = 'bubble-reaction';
    button.type = 'button';
    const count = document.createElement('span');
    count.className = 'bubble-reaction-count';
    count.textContent = String(members.length);
    appendEmojiText(button, emoji);
    button.append(count);
    button.dataset.mine = String(members.includes(self?.login));
    button.dataset.emoji = emoji;
    button.addEventListener('click', () => reactToMessage(row.dataset.id, emoji, !members.includes(self?.login)));
    container.append(button);
  }
}

function applyReaction(peer, { id, emoji, by, add }) {
  if (typeof id !== 'string' || typeof emoji !== 'string' || typeof by !== 'string') return;
  const row = threads.get(peer)?.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row || row.dataset.deleted === 'true') return;
  const reactions = row.reactions ?? (row.reactions = {});
  const members = reactions[emoji] ?? (reactions[emoji] = []);
  if (add && !members.includes(by)) members.push(by);
  if (!add) reactions[emoji] = members.filter((login) => login !== by);
  if (reactions[emoji].length === 0) delete reactions[emoji];
  renderReactionButtons(row);
}

// `edited: false` is for text that was always the message's own and only now
// became readable (the core decrypted it after its key arrived): no ✎.
function updateMessageText(peer, id, text, editedAt = Date.now(), { edited = true } = {}) {
  if (typeof id !== 'string' || typeof text !== 'string') return;
  const row = threads.get(peer)?.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row || row.dataset.deleted === 'true') return;
  const bubble = row.querySelector('.bubble');
  const content = bubble.querySelector('.bubble-content');
  if (row.dataset.image) {
    layoutImageMessage(row, text);
    renderReactionButtons(row);
  } else {
    let textEl = bubble.querySelector('.bubble-text');
    if (!textEl) {
      textEl = document.createElement('p');
      textEl.className = 'bubble-text';
      content.insertBefore(textEl, content.querySelector(':scope > .bubble-meta'));
    }
    textEl.replaceChildren();
    renderMessageBody(textEl, text);
  }
  row.messageText = text;
  markJumboEmoji(row, text);
  if (edited) markMessageEdited(row, editedAt);
  markMessageRemindedIfPending(threads.get(peer), row, id);
  maybeAttachLinkPreview(row, bubble, text);
  layoutMessageMeta(row);
  const thread = threads.get(peer);
  if (thread?.lastMessage?.id === id) notePreview(peer, { ...thread.lastMessage, text });
}

function reactToMessage(id, emoji, add = true) {
  if (!activePeer || !id || !emoji || Array.from(emoji).length > 16) return;
  if (sendFrame(activePeer, { t: 'react', id, emoji, add })) applyReaction(activePeer, {
    id, emoji, by: self?.login || '', add,
  });
}

function editMessage(id, text) {
  if (!activePeer || !id || text.trim() === '') return false;
  // On the core the edit is the core's action: in an encrypted conversation it
  // is a carrier whose target and words are inside the ciphertext, otherwise
  // the open `edit` frame. It never takes `sendFrame`'s direct channel, which
  // would leave the server — and the account's other devices — behind.
  const peer = activePeer;
  const carrier = coreSession ? `m-${randomHex(12)}` : null;
  // The words go on screen first, so a refusal that comes back at once and one
  // that comes later are both undone the same way (`settleCoreEdit`).
  if (carrier) rememberCoreEdit(carrier, peer, id, text);
  updateMessageText(peer, id, text);
  const handed = coreSession
    ? coreSession.editText(peer, carrier, id, text)
    : sendFrame(peer, { t: 'edit', id, text });
  if (!handed) {
    if (carrier) {
      const edit = coreEdits.get(carrier);
      coreEdits.delete(carrier);
      if (edit) restoreEditedText(edit);
    }
    return false;
  }
  return true;
}

// The core's edits not yet confirmed, by the id of the message that carries
// each: what the row showed before, to put back if the core cannot send it.
const coreEdits = new Map();
const CORE_EDITS_LIMIT = 100;

function rememberCoreEdit(carrier, peer, id, text) {
  const row = threads.get(peer)?.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  coreEdits.delete(carrier);
  coreEdits.set(carrier, {
    peer,
    id,
    shown: text,
    text: typeof row?.messageText === 'string' ? row.messageText : null,
    editedAt: Number(row?.dataset?.editedAt) || 0,
    wasEdited: Boolean(row?.querySelector?.('.bubble-edited')),
  });
  if (coreEdits.size > CORE_EDITS_LIMIT) coreEdits.delete(coreEdits.keys().next().value);
}

// Puts the target's old words back — unless someone has edited it again since —
// and says so: an edit that did not leave must not look like one that did.
function restoreEditedText(edit) {
  const thread = threads.get(edit.peer);
  const row = thread?.node.querySelector(`[data-id="${CSS.escape(edit.id)}"]`);
  if (row && edit.text !== null && row.messageText === edit.shown) {
    updateMessageText(edit.peer, edit.id, edit.text, 0, { edited: false });
    if (!edit.wasEdited) {
      row.querySelector('.bubble-edited')?.remove();
      delete row.dataset.editedAt;
      layoutMessageMeta(row);
    } else if (edit.editedAt) {
      row.dataset.editedAt = String(edit.editedAt);
    }
  }
  if (thread) systemNote(thread, t('editFailed'));
}

// A notice about the message an edit travels in: committed settles it, a
// refusal or a give-up undoes it on screen. `true` when it was one of these.
function settleCoreEdit(notice) {
  const edit = notice?.id ? coreEdits.get(notice.id) : null;
  if (!edit) return false;
  const failed = notice.kind === 'refused' || notice.kind === 'server-error'
    || (notice.kind === 'receipt' && notice.receipt === 'failed');
  if (failed) {
    coreEdits.delete(notice.id);
    restoreEditedText(edit);
    return true;
  }
  if (notice.kind === 'receipt' && ['sent', 'delivered', 'read'].includes(notice.receipt)) {
    coreEdits.delete(notice.id);
    return true;
  }
  return false;
}

// --- Меню сообщения ------------------------------------------------------

let openMenuNode = null;

function closeMessageMenu() {
  openMenuNode?.remove();
  openMenuNode = null;
}

// One row of a `.msg-menu`. Shared by single-message and selection context
// menus, so the two cannot drift — including the `stopPropagation`, which is
// what keeps a click from reaching the window listener that would otherwise
// close the menu in the same tick its handler opened something.
function appendMenuItem(menu, label, handler, danger = false) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = danger ? 'msg-menu-item msg-menu-item--danger' : 'msg-menu-item';
  item.textContent = label;
  preserveFocusOnPointerDown(item);
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    closeMessageMenu();
    handler();
  });
  menu.append(item);
}

// Where a menu goes for a given anchor: above all to the anchor's right edge,
// clamped to the viewport, below it unless there is no room and then above.
// Shared rather than copied — the 2026-09-21 round counted five copies of this
// arithmetic, and a new menu is not a reason for a sixth.
function placeMenu(menu, anchor) {
  const box = safeAnchorRect(anchor);
  const menuBox = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left - menuBox.width + box.width), window.innerWidth - menuBox.width - 8);
  const above = box.bottom + menuBox.height + 8 > window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${above ? Math.max(8, box.top - menuBox.height - 4) : box.bottom + 4}px`;
}


// An anchor can go stale if its row re-renders while a menu is in flight —
// an edit, a fresh reaction or a marker update. Its bounding rectangle
// is then all zeros, which is what put the message menu, the forward picker,
// the reaction popover and the roster menu in the screen's top-left corner
// instead of near whatever was actually pressed. Falling back to the row (or
// roster item) the anchor lives in keeps the menu where the thing it is about
// actually is; the viewport centre is only for the anchor and its row both
// having left the document.
function safeAnchorRect(anchor) {
  const box = anchor?.getBoundingClientRect?.();
  if (box && (box.width > 0 || box.height > 0 || box.top > 0 || box.left > 0)) return box;
  const live = anchor?.closest?.('.row, .roster-item, li');
  const liveBox = live?.getBoundingClientRect?.();
  if (liveBox && (liveBox.width > 0 || liveBox.height > 0)) return liveBox;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  return { top: cy, bottom: cy, left: cx, right: cx, width: 0, height: 0 };
}

let hoverQuickReactions = null;
let quickReactionHoverTimer = null;

function cancelQuickReactionHover() {
  clearTimeout(quickReactionHoverTimer);
  quickReactionHoverTimer = null;
}

function scheduleQuickReactions(row, event) {
  if (event.pointerType !== 'mouse') return;
  cancelQuickReactionHover();
  quickReactionHoverTimer = setTimeout(() => {
    quickReactionHoverTimer = null;
    showQuickReactions(row, event);
  }, 500);
}

function hideQuickReactions() {
  cancelQuickReactionHover();
  const state = hoverQuickReactions;
  if (!state) return;
  clearTimeout(state.leaveTimer);
  state.observer.disconnect();
  state.panel.remove();
  document.removeEventListener('pointermove', trackQuickReactions);
  document.removeEventListener('pointerdown', dismissQuickReactions, true);
  window.removeEventListener('scroll', placeQuickReactions, true);
  window.removeEventListener('resize', placeQuickReactions);
  window.removeEventListener('blur', hideQuickReactions);
  hoverQuickReactions = null;
}

function dismissQuickReactions(event) {
  if (!hoverQuickReactions?.panel.contains(event.target)) hideQuickReactions();
}

function trackQuickReactions(event) {
  const state = hoverQuickReactions;
  if (!state || (event.clientX === state.x && event.clientY === state.y)) return;
  state.x = event.clientX;
  state.y = event.clientY;
  clearTimeout(state.leaveTimer);
  if (!state.row.contains(event.target) && !state.panel.contains(event.target)) {
    // A short bridge across the gap, not a dismissal on layout-driven
    // pointerleave: typing and a new message can move the row under the mouse.
    state.leaveTimer = setTimeout(hideQuickReactions, 180);
  }
}

function placeQuickReactions() {
  const state = hoverQuickReactions;
  if (!state) return;
  const { row, panel } = state;
  const bubble = row.querySelector('.bubble');
  const box = bubble?.getBoundingClientRect();
  const viewport = elements.transcript.getBoundingClientRect();
  if (!row.isConnected || row.dataset.deleted === 'true' || !box?.height
      || box.bottom <= viewport.top || box.top >= viewport.bottom) {
    hideQuickReactions();
    return;
  }
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const beside = row.dataset.side === 'own' ? box.left - width - 4 : box.right + 4;
  panel.style.left = `${Math.max(viewport.left + 4, Math.min(beside, viewport.right - width - 4))}px`;
  panel.style.top = `${Math.max(viewport.top + 4, Math.min(box.top, viewport.bottom - height - 4))}px`;
}

function showQuickReactions(row, event) {
  const touch = isTouchActivation(event);
  if ((!touch && event.pointerType !== 'mouse') || selectionMode || openMenuNode || emojiPicker
      || row.dataset.deleted === 'true') return;
  if (hoverQuickReactions?.row === row) {
    clearTimeout(hoverQuickReactions.leaveTimer);
    return;
  }
  if (hoverQuickReactions?.x === event.clientX && hoverQuickReactions?.y === event.clientY) return;
  hideQuickReactions();
  const panel = buildQuickReactions(row.dataset.id, { anchor: row.querySelector('.bubble'), onDone: hideQuickReactions });
  panel.classList.add('message-quick-reactions');
  panel.classList.toggle('message-quick-reactions--touch', touch);
  const observer = new ResizeObserver(placeQuickReactions);
  hoverQuickReactions = { row, panel, observer, x: event.clientX, y: event.clientY, leaveTimer: null };
  document.body.append(panel);
  observer.observe(panel);
  observer.observe(elements.transcript);
  observer.observe(row.parentElement);
  document.addEventListener('pointermove', trackQuickReactions);
  document.addEventListener('pointerdown', dismissQuickReactions, true);
  window.addEventListener('scroll', placeQuickReactions, true);
  window.addEventListener('resize', placeQuickReactions);
  window.addEventListener('blur', hideQuickReactions);
  placeQuickReactions();
}

function attachMessageActions(row, { id, own, text, author, media }) {
  if (!id) return;
  row.messageText = text;
  // History pages, edits and marker updates all redraw rows: a message that is
  // selected comes back selected rather than losing its fill to a re-render.
  if (selectionMode && selectedIds.has(id)) row.classList.add('row-selected');
  const current = () => {
    const mark = row.querySelector('.bubble-meta > .bubble-mark');
    return {
      id, own, text: row.messageText || '', author, media,
      editedAt: Number(row.dataset.editedAt) || 0,
      readAt: own && mark?.dataset.state === 'read' ? Number(mark.dataset.readAt) || 0 : 0,
      readVia: own && mark?.dataset.state === 'read' ? (mark.dataset.readVia || '') : '',
    };
  };
  row.addEventListener('pointerenter', event => scheduleQuickReactions(row, event));
  row.addEventListener('pointerleave', cancelQuickReactionHover);
  row.tabIndex = 0;
  // Mouse holds select; touch holds open the menu without an extra button.
  let touchHold = null;
  let touchPoint = null;
  let touchMenuOpened = false;
  const cancelTouchHold = () => {
    clearTimeout(touchHold);
    touchHold = null;
    window.removeEventListener('scroll', cancelTouchHold, true);
  };
  row.addEventListener('pointerdown', event => {
    cancelTouchHold();
    touchMenuOpened = false;
    // Image-only messages still need a place to hold. Other controls keep
    // their own gestures, including links, audio playback and text fields.
    if (event.target.closest('a, button:not(.msg-image-wrap), input, audio, video, label')) return;
    if (row.dataset.deleted === 'true') return;
    if (event.pointerType === 'touch') {
      touchPoint = { x: event.clientX, y: event.clientY };
      const peer = activePeer;
      touchHold = setTimeout(() => {
        cancelTouchHold();
        if (!row.isConnected || activePeer !== peer || row.dataset.deleted === 'true') return;
        touchMenuOpened = true;
        openMessageMenu(row.querySelector('.bubble'), current());
      }, 500);
      window.addEventListener('scroll', cancelTouchHold, true);
      return;
    }
    if (event.pointerType === 'mouse' && event.button === 0) beginSelectDrag(id);
  });
  row.addEventListener('pointermove', event => {
    if (touchHold !== null && Math.hypot(event.clientX - touchPoint.x, event.clientY - touchPoint.y) > 10) cancelTouchHold();
  });
  row.addEventListener('pointerup', cancelTouchHold);
  row.addEventListener('pointercancel', cancelTouchHold);
  row.addEventListener('click', event => {
    if (touchMenuOpened) {
      touchMenuOpened = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Протяжка заканчивается кликом по баблу, на котором она началась, —
    // этот клик не отмечает сообщение второй раз.
    if (dragJustEnded) {
      dragJustEnded = false;
      return;
    }
    if (event.target.closest('a, button, input, audio, video, label')) return;
    if (row.dataset.deleted === 'true') return;
    if (selectionMode) toggleRowSelection(id);
    else if (isTouchActivation(event)) showQuickReactions(row, event);
  }, true);
  row.addEventListener('contextmenu', event => {
    if (event.target.closest('a, input, audio, video')) return;
    event.preventDefault();
    if (row.dataset.deleted !== 'true') openMessageMenu(row.querySelector('.bubble'), current());
  });
  row.addEventListener('keydown', event => {
    if (event.target !== row) return;
    if (event.key === 'Escape') closeMessageMenu();
    if ((event.shiftKey && event.key === 'F10') && row.dataset.deleted !== 'true') {
      event.preventDefault(); openMessageMenu(row.querySelector('.bubble'), current());
    }
  });
}

// Which client moved the peer's read watermark — the three kinds the server
// keeps (`normalizeClientKind` in src/cloud/accounts.js). The build number an
// Android client appends (`android/<build>`) is deliberately dropped here:
// the menu says «телефон», not a build id. Anything else is unknown and must
// add nothing to the line rather than name a client that was never recorded.
function readViaLabel(via) {
  if (via === 'web') return t('viaWeb');
  if (via === 'cli') return t('viaCli');
  if (typeof via === 'string' && via.startsWith('android')) return t('viaAndroid');
  return '';
}

function messageMenuDetails({ own, readAt = 0, editedAt = 0, readVia = '' }) {
  const details = [];
  if (own && readAt > 0) {
    const via = readViaLabel(readVia);
    details.push(via
      ? t('msgReadAt', `${messageEventTime(readAt)} · ${via}`)
      : t('msgReadAt', messageEventTime(readAt)));
  }
  if (editedAt > 0) details.push(t('msgEditedAt', messageEventTime(editedAt)));
  return details;
}

function replyReminderDue(preset, now = Date.now()) {
  if (preset === '15m') return now + 15 * 60 * 1000;
  if (preset === '1h') return now + 60 * 60 * 1000;
  const due = new Date(now);
  if (preset === 'evening') {
    due.setHours(19, 0, 0, 0);
    if (due.getTime() <= now) due.setDate(due.getDate() + 1);
    return due.getTime();
  }
  due.setDate(due.getDate() + 1);
  due.setHours(9, 0, 0, 0);
  return due.getTime();
}

function scheduleReplyReminder(peer, messageId, preset) {
  if (!peer || !messageId) return false;
  return sendEnvelope({
    k: 'reply-reminder',
    peer,
    messageId,
    dueAt: replyReminderDue(preset),
  });
}

function openMessageMenu(anchor, {
  id, own, text, author, media, editedAt = 0, readAt = 0, readVia = '',
}) {
  if (selectionMode && selectedIds.has(id)) {
    openSelectionMenu(anchor);
    return;
  }
  closeMessageMenu();
  hideQuickReactions();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');

  const add = (label, handler, danger = false) => appendMenuItem(menu, label, handler, danger);
  add(t('msgReply'), () => startReplyToMessage({
    id, own, authorName: author, text, media,
  }));
  // Keep the action order shared with the APK: Reply, Forward, Remind.
  add(t('msgForward'), () => openForwardPicker(anchor, id));
  add(t('msgRemind'), () => openReminderPicker(anchor, id));
  if (own && text) add(t('msgEdit'), () => startEditMessage(id, text));
  if (text) {
    add(t('msgCopy'), () => {
      navigator.clipboard?.writeText(text).then(() => {
        const thread = activePeer ? threads.get(activePeer) : null;
        if (thread) systemNote(thread, t('msgCopied'));
      }).catch(() => {});
    });
  }
  // «Выбрать» starts the selection on this message. It is the entry a pointer
  // that cannot drag a range has — a finger — and the same mode a mouse enters
  // by dragging across the transcript.
  add(t('msgSelect'), () => enterSelectionMode(id));
  add(t('msgDeleteMine'), () => deleteMessages([id], 'self'));
  if (own) add(t('msgDeleteAll'), () => deleteMessages([id], 'all'), true);
  const details = messageMenuDetails({
    own, readAt, editedAt, readVia,
  });
  if (details.length > 0) {
    const block = document.createElement('div');
    block.className = 'msg-menu-details';
    for (const detail of details) {
      const line = document.createElement('p');
      line.textContent = detail;
      block.append(line);
    }
    menu.append(block);
  }

  document.body.append(menu);
  placeMenu(menu, anchor);
  openMenuNode = menu;
}

// «Переслать»: pick a contact, and the message is re-sent to them as a new
// message of this account carrying who said it first. Media rides along —
// forwarding a photo without the photo would be a quote, not a forward.
function openForwardPicker(anchor, ids) {
  closeMessageMenu();
  const sourcePeer = activePeer;
  const source = threads.get(sourcePeer);
  const rows = (Array.isArray(ids) ? ids : [ids])
    .map((id) => source?.node.querySelector(`[data-id="${CSS.escape(id)}"]`))
    .filter(Boolean);
  if (!rows.length) return;
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');
  const title = document.createElement('p');
  title.className = 'msg-menu-title';
  title.textContent = t('msgForwardTo');
  menu.append(title);

  const targets = [
    ...(self ? [{ login: self.login, name: t('savedMessages') }] : []),
    ...users.filter((user) => user.login !== self?.login),
  ];
  for (const target of targets) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'msg-menu-item';
    item.textContent = peerLabel(target);
    preserveFocusOnPointerDown(item);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMessageMenu();
      void forwardMessage(rows, target.login, sourcePeer);
    });
    menu.append(item);
  }

  document.body.append(menu);
  const box = safeAnchorRect(anchor);
  const menuBox = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left - menuBox.width + box.width), window.innerWidth - menuBox.width - 8);
  const above = box.bottom + menuBox.height + 8 > window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${above ? Math.max(8, box.top - menuBox.height - 4) : box.bottom + 4}px`;
  openMenuNode = menu;
}

// «Напомнить ответить»: one line in the main menu, four in its own picker —
// same shape as «Переслать» above, so a fourth preset never means a fifth
// flat row crowding the primary menu.
function openReminderPicker(anchor, id) {
  closeMessageMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');
  const title = document.createElement('p');
  title.className = 'msg-menu-title';
  title.textContent = t('msgRemind');
  menu.append(title);

  const presetKeys = { '15m': 'msgRemind15m', '1h': 'msgRemind1h', evening: 'msgRemindEvening', tomorrow: 'msgRemindTomorrow' };
  for (const preset of ['15m', '1h', 'evening', 'tomorrow']) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'msg-menu-item';
    item.textContent = t(presetKeys[preset]);
    preserveFocusOnPointerDown(item);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMessageMenu();
      if (!scheduleReplyReminder(activePeer, id, preset)) return;
      noteReminderSet(threadFor(activePeer), id);
    });
    menu.append(item);
  }

  document.body.append(menu);
  const box = safeAnchorRect(anchor);
  const menuBox = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left - menuBox.width + box.width), window.innerWidth - menuBox.width - 8);
  const above = box.bottom + menuBox.height + 8 > window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${above ? Math.max(8, box.top - menuBox.height - 4) : box.bottom + 4}px`;
  openMenuNode = menu;
}

// The row is still the only place the client keeps a message's rendered
// text, but its attachment payload comes from `messageAttachments` instead
// of scraping the DOM: a voice card never puts a queryable
// `<audio src="data:...">` element on screen (see the Map's own comment),
// so that always came back empty and a voice forward silently did nothing.
async function forwardMessage(rows, peer, sourcePeer) {
  // Snapshot the whole batch before navigation changes activePeer or the DOM.
  const messages = rows.map(row => {
    const originLogin = row.dataset.side === 'own' ? self?.login : sourcePeer;
    const originName = row.dataset.author || displayName(originLogin);
    // An image-only row draws no `.bubble-text`, but the frame it came from
    // still carries the placeholder text the APK and terminal show.
    const text = emojiPlainText(row.querySelector('.bubble-text')) ?? row.messageText ?? '';
    const { image = null, voice = null } = messageAttachments.get(row.dataset.id) || {};
    return { text, image, voice, forwardedFrom: { login: originLogin, name: originName } };
  }).filter(message => message.text !== '' || message.image || message.voice);
  if (!messages.length) return;

  exitSelectionMode();
  await selectPeer(peer);
  const thread = threadFor(peer);
  for (const { text, image, voice, forwardedFrom } of messages) {
    const id = `m-${randomHex(12)}`;
    const ts = Date.now();
    const frame = { t: 'msg', id, ts, text, forwardedFrom };
    // A forward always carries the bytes: a reference names the source
    // conversation, which the recipient cannot read. A referenced attachment
    // that cannot be fetched (deleted, evicted, offline) is not forwarded as
    // an empty shell — the whole message stops here, like a failed send.
    let imageUrl = null;
    let voiceUrl = null;
    try {
      imageUrl = image ? await attachmentDataUrl(image) : null;
      voiceUrl = voice ? await attachmentDataUrl(voice) : null;
    } catch {
      systemNote(thread, t('mediaFailed'));
      return;
    }
    if (imageUrl) frame.image = { dataUrl: imageUrl, width: image.width || 0, height: image.height || 0 };
    if (voiceUrl) frame.voice = { dataUrl: voiceUrl, duration: voice.duration || 0 };
    // On the core a forward is one sealed message, label and bytes inside the
    // ciphertext, and never the open frame below. A media forward carries a
    // caption, as a sent one does: the core refuses an empty message.
    const viaCore = Boolean(coreSession);
    let sendText = text;
    if (viaCore && sendText === '') {
      sendText = voiceUrl ? t('voiceMessageNotify', formatClock(voice.duration || 0)) : t('pastedImage');
    }
    if (!viaCore && !(await sendFrameReliably(peer, frame))) return;
    if (voiceUrl) {
      appendVoiceMessage(thread, {
        id, own: true, author: self.name, dataUrl: voiceUrl, duration: voice.duration || 0, ts, text: sendText, forwardedFrom,
        queued: viaCore,
      });
    } else {
      appendMessage(thread, {
        id, own: true, kind: 'human', author: self.name, text: sendText, ts,
        image: imageUrl ? frame.image : null, forwardedFrom, queued: viaCore,
      });
    }
    scrollToLatest(true);
    if (viaCore) {
      const options = { forwardedFrom };
      if (frame.image) options.image = frame.image;
      if (frame.voice) options.voice = frame.voice;
      if (!coreSession.sendWith(peer, id, sendText, options)) {
        failCoreSend(thread, id);
        return;
      }
    }
    playSound('sent');
  }
}

function systemNote(thread, text) {
  const note = document.createElement('p');
  note.className = 'system-note';
  note.textContent = text;
  thread.node.append(note);
  scrollToLatest();
}

const TOAST_DURATION_MS = 2600;
let toastEl = null;
let toastTimer = null;

// A brief popup for feedback that is not part of the conversation — /ping's
// "sent…"/latency/timeout readout used to go through `systemNote` and sit in
// the transcript forever, which is not what any of the three said: they are
// a status line about the connection, not something either side "said".
function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.dataset.visible = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.dataset.visible = 'false';
  }, TOAST_DURATION_MS);
}

// One ladder, shared with Android (`cloudReceiptGlyph` in CloudScreen.kt):
// ⧗ while the message is still only on this device, ✓ once the server has
// committed it, ✓✓ once the peer's *device* holds it (their `ack` frame, or the
// delivery watermark `/api/history` carries), ✓✓ in the accent colour once
// their read watermark has passed it, ⚠ when the send is not coming back and
// needs a decision. The two ✓✓ rungs are told apart by colour alone: `sent` and
// `ack` keep the neutral grey of the line they sit in (`.bubble-mark` /
// `.roster-mark` inherit it from `.bubble-meta` / `.roster-meta`), and `read`
// — nothing else — takes the accent. `queued` is the state the durable queue
// introduced: before it, a row was drawn as accepted the instant it was rendered
// and a message that never reached the server looked exactly like one that had.
function setMark(mark, state, readAt = 0, readVia = '') {
  mark.dataset.state = state;
  if (state === 'read' && Number.isFinite(readAt) && readAt > 0) {
    mark.dataset.readAt = String(readAt);
  }
  // Which client last moved the peer's read watermark here — the same value
  // `/api/history` sends as `peerReadVia`. Stored beside the time so the
  // message menu can name the device from the row it was opened on; dropped
  // for every state that is not a read, and for an unknown kind, so a mark
  // that never learned a client keeps rendering as the time alone.
  if (state === 'read' && readVia) mark.dataset.readVia = readVia;
  else delete mark.dataset.readVia;
  if (state === 'read') mark.textContent = '✓✓';
  else if (state === 'queued') mark.textContent = '⧗';
  else if (state === 'failed') mark.textContent = '⚠';
  else if (state === 'ack') mark.textContent = '✓✓';
  else mark.textContent = '✓';
  const row = mark.closest?.('.row');
  if (row) layoutMessageMeta(row);
}

// Only a message the server committed can be on the peer's device or read by
// them. The watermarks are points in time, and a row still on this device
// (`queued`) — or one the queue gave up on (`failed`) — can sit below them
// without the server ever having seen it; raising it drew ✓✓ on a message
// nobody received. Android skips the same rows (`MessageDao.markOwnReadUpTo`).
function markCommitted(mark) {
  const state = mark.dataset.state;
  return state !== 'queued' && state !== 'failed';
}

// A mark that just became committed (`sent`) takes the thread's watermarks it
// was too early for: an acceptance can arrive after the peer has already read
// the message (its first reply was lost and the retry was a duplicate).
// Measured against the mark's own — by now server — time. The roster follows,
// because its preview may have been this very message's ⧗/⚠.
function settleCommittedMark(thread, mark) {
  const ts = Number(mark.dataset.ts) || 0;
  if (ts > 0 && ts <= (thread.peerReadTs || 0)) {
    setMark(mark, 'read', thread.peerReadAt || 0, thread.peerReadVia || '');
  } else if (ts > 0 && ts <= (thread.peerDeliveredTs || 0) && mark.dataset.state !== 'read') {
    setMark(mark, 'ack');
  }
  scheduleRosterRender();
}

// The line the transcript keeps at the first message that arrived without
// being seen, so coming back to a conversation shows exactly where reading
// stopped instead of leaving the new rows indistinguishable from old ones.
// One per thread: the oldest unread row is the only place it belongs.
function ensureUnreadDivider(thread, beforeRow) {
  if (!thread || !beforeRow || thread.unreadDivider?.isConnected) return;
  const divider = document.createElement('div');
  divider.className = 'unread-divider';
  const badge = document.createElement('span');
  badge.className = 'unread-badge-line';
  badge.textContent = t('newMessages');
  divider.append(badge);
  thread.node.insertBefore(divider, beforeRow);
  thread.unreadDivider = divider;
}

function clearUnreadDivider(thread) {
  if (!thread?.unreadDivider) return;
  thread.unreadDivider.remove();
  thread.unreadDivider = null;
}


let unreadBelowCount = 0;

// --- Следование за хвостом ------------------------------------------------
//
// Following the newest message is an *intent* this client has to carry, not a
// measurement it can repeat: on a phone the transcript is `display: none`
// while the roster pane is up (`app.css`'s narrow-pane media query), and every
// geometry read on a `display: none` element is 0 — so `scrollHeight -
// clientHeight - scrollTop < 90` reads as *at the bottom* whatever the reader
// was looking at, and `scrollTop = scrollHeight` is a silent no-op. The
// conversation then opened on its oldest loaded message, with the new one
// below the fold and nothing on screen to say so («в web новые сообщения не
// опускают экран вниз сами»).
//
// The flag therefore survives the gap: it is set by every deliberate move to
// the bottom and cleared only by a real scroll away from it, and it is what a
// reveal consults — the pane coming back into layout, or a row growing under a
// reader who was already at the bottom.
let followTail = true;

function transcriptMeasurable() {
  const container = elements.transcript;
  return Boolean(container) && container.clientHeight > 0;
}

/** The transcript's own scrolling moved it; remember whether it sits at the tail. */
function noteTranscriptScroll() {
  if (transcriptMeasurable()) followTail = transcriptAtBottom();
}

/** The talk pane, revealed on a phone, is the moment the transcript has a box
 *  again — and the band its first measurable width. A reader who was following
 *  the tail is put back on it, after the frame that gives the pane that box. */
function revealTalkPane() {
  elements.app.dataset.pane = 'talk';
  requestAnimationFrame(() => {
    if (followTail) scrollToLatest(true, true);
    fitLogoBand();
  });
}

/** A row grew under the reader — a picture finishing its decode, the link
 *  preview card that replaces a bare URL once `/api/link-preview` answers, a
 *  voice waveform drawn on demand. No message arrived, so nothing else would
 *  scroll again: the bottom of the transcript simply moved down, out of view. */
function followTailGrowth(peer) {
  if (!peer || peer !== activePeer) return;
  if (!followTail || !transcriptMeasurable()) return;
  scrollToLatest(true, true);
}

// One observer for every thread node `threadFor` creates; only the active one
// is ever consulted, inside `followTailGrowth`.
const threadGrowthObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    for (const entry of entries) followTailGrowth(String(entry.target?.dataset?.peer ?? ''));
  })
  : null;

// The arrow scrolls to the tail whenever the reader has scrolled away from
// it, unread or not — the reader who just wants back down after re-reading
// history is not signalling anything, so the button cannot depend on a
// count of new messages. The badge is a separate, corner-anchored element
// (see .scroll-badge in app.css) that layers "something new arrived" on top
// of "you can scroll down", instead of merging the two into one signal.
function updateScrollButton() {
  if (!elements.scrollBottomBtn || !elements.scrollBadge) return;
  elements.scrollBottomBtn.hidden = followTail;
  elements.scrollBadge.hidden = unreadBelowCount <= 0;
  if (unreadBelowCount > 0) elements.scrollBadge.textContent = String(unreadBelowCount);
}

function scrollToLatest(force = false, instant = false) {
  const container = elements.transcript;
  if (!container) return;

  if (force) {
    if (instant) {
      const scrollBehavior = container.style.scrollBehavior;
      container.style.scrollBehavior = 'auto';
      container.scrollTop = container.scrollHeight;
      container.style.scrollBehavior = scrollBehavior;
    } else {
      container.scrollTop = container.scrollHeight;
    }
    unreadBelowCount = 0;
    followTail = true;
    updateScrollButton();
    return;
  }

  const fromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
  // A `display: none` transcript measures 0 for all three, which reads as "at
  // the bottom" whatever the reader was doing; the honest answer there is the
  // remembered intent, and the geometry is re-read the moment it has a box
  // again (`revealTalkPane`).
  if (followTail || !transcriptMeasurable() || fromBottom < 90) {
    container.scrollTop = container.scrollHeight;
    followTail = true;
    unreadBelowCount = 0;
    updateScrollButton();
  } else {
    followTail = false;
    unreadBelowCount += 1;
    updateScrollButton();
  }
}

/** A layout shift moved the transcript's scroll position without any message
 *  arriving — the typing bar appearing or disappearing resizes the flex
 *  column it sits beside. A reader already pinned to the bottom must stay
 *  pinned there, but a reader who scrolled away to read history gets no
 *  phantom "unread" bump for a typing indicator that carries no content. */
function pinToTailOnLayoutShift() {
  if (followTail) scrollToLatest(true, true);
}

function clearPendingPing() {
  if (!pendingPing) return;
  clearTimeout(pendingPing.timer);
  pendingPing = null;
}

// --- Присутствие: активен / не за компьютером / отошёл -------------------
//
// The same three states and the same two thresholds as `src/presence.js`, so
// a terminal and a browser describe the same person the same way. Focus is
// the strong signal (a hidden tab is not being read), the timers are the weak
// one, and the state is pushed as its own envelope rather than a frame: it is
// account-wide, not part of any one conversation, and `k` envelopes are
// outside the hub's per-frame rate limit.

let presenceState = 'active';
let presenceIdleTimer = null;
let presenceAwayTimer = null;

function publishPresence(state, { force = false } = {}) {
  if (!force && presenceState === state) return;
  presenceState = state;
  if (authed) sendEnvelope({ k: 'state', state });
  if (activePeer) sendFrame(activePeer, { t: 'focus', state });
}

function armPresenceTimers() {
  clearTimeout(presenceIdleTimer);
  clearTimeout(presenceAwayTimer);
  presenceIdleTimer = setTimeout(() => {
    publishPresence('idle');
    presenceAwayTimer = setTimeout(() => publishPresence('away'), AWAY_AFTER_MS);
  }, IDLE_AFTER_MS);
}

function notePresenceActivity() {
  if (document.hidden) return;
  publishPresence('active');
  armPresenceTimers();
  // Touching the app is also the moment to admit that what is on screen has
  // been read: an installed PWA rarely gets a `focus` event of its own.
  flushReadReceipts();
}

function notePresenceAway() {
  clearTimeout(presenceIdleTimer);
  clearTimeout(presenceAwayTimer);
  publishPresence('idle');
  presenceAwayTimer = setTimeout(() => publishPresence('away'), AWAY_AFTER_MS);
}

function bindPresenceSignal() {
  window.addEventListener('focus', notePresenceActivity);
  // A window `blur` on a phone means far less than it does on a desktop — the
  // keyboard, the notification shade and every system dialog raise it while
  // the person is still reading. Only a hidden page is really unattended;
  // a blur just lets the ordinary idle timer run.
  window.addEventListener('blur', () => {
    if (document.hidden) notePresenceAway();
    else armPresenceTimers();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) notePresenceAway();
    else notePresenceActivity();
  });
  for (const event of ['keydown', 'pointerdown', 'wheel']) {
    window.addEventListener(event, notePresenceActivity, { passive: true });
  }
  armPresenceTimers();
}

// --- Удаление сообщений ---------------------------------------------------
//
// Two scopes, one frame. `all` purges the shared conversation on the server
// and tells the other side to drop it too; `self` only records the ids as
// hidden for this account, so the peer's copy — and their memory of it — is
// left alone. Neither can unsend a notification that already arrived, which
// is why «удалить у всех» is offered only for one's own messages.

function removeLocalMessages(peer, ids, tombstone = true) {
  const thread = threads.get(peer);
  if (!thread) return 0;
  let removed = 0;
  for (const id of ids) {
    const row = thread.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) {
      if (tombstone) tombstoneMessage(thread, row);
      else row.remove();
      removed += 1;
    }
    thread.marks.delete(id);
    if (thread.unreadIds.delete(id) && thread.unread > 0) thread.unread -= 1;
    // `seen` is deliberately kept: a queued copy of the same frame must not
    // be able to redraw a message the person just deleted.
  }
  if (removed > 0) {
    scheduleDateDividers(thread);
    renderRoster();
    renderInfoPanel();
    updateAppUnreadBadge();
  }
  return removed;
}

// --- Message selection ---------------------------------------------------
//
// Hold the mouse/trackpad button to enter message selection, then drag a range.
// Ordinary clicks do not enter the mode. Once selecting, clicks toggle rows;
// Escape, «Отмена» or clearing the last row exits. Touch uses ⋯ → «Выбрать».
let selectionMode = false;
const selectedIds = new Set();

const SELECTION_HOLD_MS = 150;
let dragEdgeId = null;
let selectionHoldTimer = null;
let dragAnchorId = null;
let selectionPointer = null;
// Suppress the click generated by releasing a held selection gesture.
let dragJustEnded = false;

function activeThread() {
  return activePeer ? threads.get(activePeer) : null;
}

function enterSelectionMode(id) {
  hideQuickReactions();
  selectionMode = true;
  if (id) selectedIds.add(id);
  renderSelectionState();
}

function exitSelectionMode() {
  onSelectDragEnd();
  if (!selectionMode && selectedIds.size === 0) return;
  selectionMode = false;
  selectedIds.clear();
  closeMessageMenu();
  for (const thread of threads.values()) {
    for (const row of thread.node.querySelectorAll('.row-selected')) {
      row.classList.remove('row-selected');
    }
  }
  renderSelectionState();
}

function toggleRowSelection(id) {
  if (!activePeer || !id) return;
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  if (selectedIds.size === 0) exitSelectionMode();
  else enterSelectionMode();
}

// DOM order rather than the order they were picked: messages marked bottom-up
// must still be forwarded and deleted in the order they were written in.
function selectedIdsInOrder() {
  const thread = activeThread();
  if (!thread) return [];
  return [...thread.node.querySelectorAll('.row[data-id]')]
    .map((row) => row.dataset.id)
    .filter((id) => selectedIds.has(id));
}

function renderSelectionState() {
  const thread = activeThread();
  if (thread) {
    if (selectionMode) {
      // A redrawn transcript is where an id can disappear from under a
      // selection (a message deleted on another device, a page that no longer
      // holds it). Dropping it here is what keeps the count from naming a
      // message that is not on screen.
      const live = new Set([...thread.node.querySelectorAll('.row[data-id]')].map((row) => row.dataset.id));
      for (const id of [...selectedIds]) if (!live.has(id)) selectedIds.delete(id);
      if (selectedIds.size === 0) {
        exitSelectionMode();
        return;
      }
    }
    for (const row of thread.node.querySelectorAll('.row[data-id]')) {
      row.classList.toggle('row-selected', selectionMode && selectedIds.has(row.dataset.id));
    }
  }
}

// After the initial hold, crossing a message midpoint updates the range
// immediately. Rows span both sides of the transcript, so dragging does not
// require hunting for each alternating own/peer bubble.

function applyDragSelection(over) {
  const rows = [...(activeThread()?.node.querySelectorAll('.row[data-id]') ?? [])];
  const from = rows.findIndex(row => row.dataset.id === dragAnchorId);
  const to = rows.findIndex(row => row.dataset.id === over);
  if (from < 0 || to < 0) return;
  selectedIds.clear();
  if (from !== to) {
    for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      selectedIds.add(row.dataset.id);
    }
  }
  dragEdgeId = over;
  selectionMode = selectedIds.size > 0;
  renderSelectionState();
}

function onSelectDragMove(event) {
  selectionPointer = event;
  if (dragAnchorId === null) return;
  const thread = activeThread();
  const under = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.row[data-id]');
  const over = under?.dataset.id;
  if (!over || !thread?.node.contains(under)) return;
  const rows = [...thread.node.querySelectorAll('.row[data-id]')];
  const from = rows.findIndex(row => row.dataset.id === dragAnchorId);
  const edge = rows.findIndex(row => row.dataset.id === dragEdgeId);
  const to = rows.findIndex(row => row.dataset.id === over);
  if (from < 0 || edge < 0 || to < 0 || to === edge) return;
  const box = under.querySelector('.bubble').getBoundingClientRect();
  const midpoint = box.top + box.height / 2;
  if ((to > edge && event.clientY < midpoint)
      || (to < edge && event.clientY > midpoint)) return;
  const retracing = edge !== from && (to - edge) * (edge - from) < 0;
  // Crossing the anchor clears the old range, never grows an opposite one.
  applyDragSelection(retracing && (to - from) * (edge - from) <= 0 ? dragAnchorId : over);
}

function onSelectDragEnd() {
  clearTimeout(selectionHoldTimer);
  selectionHoldTimer = null;
  window.removeEventListener('pointermove', onSelectDragMove);
  window.removeEventListener('pointerup', onSelectDragEnd);
  window.removeEventListener('pointercancel', onSelectDragEnd);
  window.removeEventListener('blur', onSelectDragEnd);
  window.removeEventListener('scroll', onSelectDragEnd, true);
  const held = dragAnchorId !== null;
  dragAnchorId = null;
  dragEdgeId = null;
  selectionPointer = null;
  if (!held) return;
  dragJustEnded = true;
  setTimeout(() => { dragJustEnded = false; }, 0);
}

function beginSelectDrag(id) {
  onSelectDragEnd();
  dragJustEnded = false;
  window.addEventListener('pointermove', onSelectDragMove);
  selectionHoldTimer = setTimeout(() => {
    selectionHoldTimer = null;
    if (!activeThread()?.node.querySelector(`[data-id="${CSS.escape(id)}"]`)) return;
    dragAnchorId = id;
    dragEdgeId = id;
    enterSelectionMode(id);
    if (selectionPointer) onSelectDragMove(selectionPointer);
  }, SELECTION_HOLD_MS);
  window.addEventListener('pointerup', onSelectDragEnd);
  window.addEventListener('pointercancel', onSelectDragEnd);
  window.addEventListener('blur', onSelectDragEnd);
  window.addEventListener('scroll', onSelectDragEnd, true);
}

// The selection owns its context menu only; the composer never changes.
function openSelectionMenu(anchor) {
  if (!activePeer || selectedIds.size === 0) return;
  const ids = selectedIdsInOrder();
  const thread = activeThread();
  const allOwn = ids.every((id) => (
    thread?.node.querySelector(`[data-id="${CSS.escape(id)}"]`)?.dataset.side === 'own'
  ));
  closeMessageMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.setAttribute('role', 'menu');
  const title = document.createElement('p');
  title.className = 'msg-menu-title';
  title.textContent = t('msgSelectedCount', ids.length);
  menu.append(title);
  appendMenuItem(menu, `${t('msgForward')} (${ids.length})`, () => {
    openForwardPicker(anchor, ids);
  });
  appendMenuItem(menu, `${t('msgDeleteMine')} (${ids.length})`, () => {
    deleteMessages(ids, 'self');
    exitSelectionMode();
  });
  if (allOwn) {
    appendMenuItem(menu, `${t('msgDeleteAll')} (${ids.length})`, () => {
      deleteMessages(ids, 'all');
      exitSelectionMode();
    }, true);
  }
  appendMenuItem(menu, t('msgSelectCancel'), exitSelectionMode);
  document.body.append(menu);
  placeMenu(menu, anchor);
  openMenuNode = menu;
}

function deleteMessages(ids, scope) {
  if (!activePeer || ids.length === 0) return;
  const peer = activePeer;
  if (!sendFrame(peer, { t: 'del', ids, scope })) return;
  removeLocalMessages(peer, ids, scope === 'all');
}


// --- Ядро (этап 7, под флагом) -------------------------------------------
//
// The web on the Rust core, the browser's `TAILCHAT_CORE=1`: `?core=1` in the
// address turns it on for this browser (remembered), `?core=0` turns it off.
// Without the flag nothing below runs and the tab is exactly the classic one.
//
// `web/cloud/core/web-session.js` hands `connectSocket` a WebSocket-shaped
// object whose bytes go through the core (the table is `core/routing.js`, the
// same one the terminal uses): the core owns the real socket, its IndexedDB
// store, the send queue of plain texts, the receipts and the account feed.
// What the core learns beside the wire comes back through `onCoreEvent`.
//
// One tab per account runs the core — the store is one per account, and two
// drivers writing it would race — so a second tab finds the lock taken and
// stays classic. A core that cannot start (no wasm on this server, no
// IndexedDB, a token it does not take) leaves the page classic too, said once
// in the console.

// What `auth` claims for this page. The core claims the same minus
// `media-ref-v1`: its codec cannot store a reference yet, and a message it
// cannot store is one it never acks (the terminal's choice too, CLASSIC_CAPS).
const SOCKET_CAPS = ['durable-ack', 'addressed-send', 'sync-v1', 'sync-nudge-v1', 'read-ack-v1'];
const CORE_FLAG_KEY = 'tailchat-core';
const CORE_BASE = '/tailchat/core/';

let coreSession = null;
// The encryption commands (`e2ee-commands.js`) and what their screens need.
let coreE2ee = null;
// The safety code per peer as the core last told it (Details), the peer
// whose code is on its way, and the emoji table's reader — the commands' own
// (`safetyCodeText`), set when the core loads; until then no code arrives.
const safetyCodes = new Map();
let safetyAskedFor = null;
let safetyCodeHalves = () => [];
let coreE2eeStrings = null;
let coreSasEmojis = [];
// The conversation the notice being handled is about: its lines go into that
// conversation when it is the open one, and into a toast otherwise.
let coreE2eePeer = null;
let sasDialog = null; // { id, dialog }
let signInAgainShown = false;
let coreRelease = null; // ends the tab's hold on the account's core
let coreStorage = null;
let coreOpening = null;
let coreRefused = false; // could not start on this page load: classic from here on
// Rows drawn as "the key has not arrived" (`peer\nid`): when the core later
// decrypts one it says `stored` again, and the row's text is put in place.
const coreSealedRows = new Set();

// History over HTTP knows nothing of the socket's capabilities: a page on the
// core asks for the envelopes (`e2ee=1`, server.js), which it can open, instead
// of the stub text an older client gets.
function coreHistoryParam() {
  return coreSession ? '&e2ee=1' : '';
}

const coreFlag = (() => {
  try {
    const asked = new URLSearchParams(location.search).get('core');
    if (asked === '1') localStorage.setItem(CORE_FLAG_KEY, '1');
    else if (asked === '0') localStorage.removeItem(CORE_FLAG_KEY);
    return localStorage.getItem(CORE_FLAG_KEY) === '1';
  } catch {
    return false;
  }
})();

function coreWanted() {
  return coreFlag && !coreRefused && Boolean(self?.login) && Boolean(token);
}

// Loads the core for the signed-in account and dials again, with it or —
// when it could not start — without.
function startCore() {
  if (coreOpening) return coreOpening;
  const login = self.login;
  const tokenAtStart = token;
  coreOpening = (async () => {
    let release = null;
    let storage = null;
    try {
      const [session, idb, wasm, commands, strings] = await Promise.all([
        import(`${CORE_BASE}web-session.js`),
        import(`${CORE_BASE}idb-storage.js`),
        import(`${CORE_BASE}pkg/tailchat_web.js`),
        import(`${CORE_BASE}e2ee-commands.js`),
        import(`${CORE_BASE}e2ee-strings.js`),
      ]);
      release = await session.acquireCoreLock(login);
      await wasm.default();
      storage = await idb.openIdbStorage(await session.coreStoreName(login, tokenAtStart));
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const started = await session.startWebCoreSession({
        wasm,
        storage,
        onEvent: onCoreEvent,
        account: {
          login,
          token: tokenAtStart,
          socketUrl: `${proto}//${location.host}/tailchat/ws`,
          httpBase: `${location.origin}/tailchat`,
          e2ee: true,
          extraCaps: [...SOCKET_CAPS],
          deviceName: commands.browserDeviceName(navigator.userAgent),
        },
      });
      if (token !== tokenAtStart || self?.login !== login) {
        // Signed out (or into another account) while loading.
        started.stop();
        storage.close();
        release();
        return;
      }
      coreSession = started;
      coreStorage = storage;
      coreRelease = release;
      coreE2eeStrings = strings.E2EE_STRINGS;
      coreSasEmojis = commands.SAS_EMOJIS;
      safetyCodeHalves = commands.safetyCodeText;
      coreE2ee = createCoreE2ee(commands.createE2eeCommands);
      syncCoreE2eeSettings();
      console.info('[Tailchat] core: on');
    } catch (error) {
      storage?.close();
      release?.();
      coreRefused = true;
      console.warn('[Tailchat] core unavailable, classic transport:', error?.message || error);
    } finally {
      coreOpening = null;
    }
    if (token === tokenAtStart) connectSocket();
  })();
  return coreOpening;
}

function stopCore() {
  const session = coreSession;
  coreSession = null;
  coreE2ee = null;
  forgetSafetyCodes();
  closeSasDialog();
  syncCoreE2eeSettings();
  session?.stop();
  coreStorage?.close();
  coreStorage = null;
  coreRelease?.();
  coreRelease = null;
  coreSealedRows.clear();
}

// The core's receipt words, as this page's mark states.
const CORE_MARKS = { sent: 'sent', delivered: 'ack', read: 'read' };

function onCoreEvent(notice) {
  if (settleCoreEdit(notice)) return;
  switch (notice.kind) {
    case 'message-added':
    case 'receipt':
      // An edit's carrier has no row, so no mark to move.
      if (notice.editOf) return;
      applyCoreReceipt(notice.peer, notice.id, notice.ts, notice.kind === 'receipt' ? notice.receipt : 'queued');
      return;
    case 'refused':
      if (notice.peer && notice.id) {
        const mark = threads.get(notice.peer)?.marks.get(notice.id);
        if (mark && !markCommitted(mark)) {
          setMark(mark, 'failed');
          mark.title = String(notice.reason || '');
          scheduleRosterRender();
        }
      }
      return;
    case 'server-error':
      // Said by the core itself, before the wire: a device of this
      // conversation reads only the inline form of an attachment and this
      // one does not fit a frame in it (R3). The mark is already ⚠.
      if (notice.code === 'peer_outdated' && notice.peer && notice.id) {
        const thread = threads.get(notice.peer);
        const mark = thread?.marks.get(notice.id);
        if (mark) mark.title = t('peerOutdatedMedia');
        if (thread) systemNote(thread, t('peerOutdatedMedia'));
        return;
      }
      handleCoreE2eeNotice(notice);
      return;
    case 'stored':
      paintCoreRow(notice.peer, notice.id);
      return;
    case 'own-read':
      applySyncedRead(notice.peer, notice.readTs || 0);
      return;
    case 'storage-failed':
    case 'encryption-failed':
      console.warn(`[Tailchat] core ${notice.kind}:`, notice.reason);
      return;
    default:
      // The encryption notices (verification, trust, backup, sign in again)
      // go to their screens. `removed`: the live `del` frame and the history
      // reconcile already take rows off this page. `held` has no screen, as in
      // the terminal: the core keeps the message and nothing asks to send it
      // in the clear.
      handleCoreE2eeNotice(notice);
  }
}

// --- Encryption screens (stage 7, under the core flag) --------------------
//
// The commands and their state — which verification waits for a "yes", whose
// keys changed, which restore waits for the core — are the terminal's module
// (`web/cloud/core/e2ee-commands.js`), run here unchanged; its lines become
// system notes. What the page adds is the surface the terminal draws as text:
// the emoji comparison as a dialog with two buttons, the secret prompt as a
// masked field, the recovery key with a Copy button, "sign in again" with the
// button that does it, and the same actions in the conversation menu and in
// Settings.


function e2eeText(key, vars = {}) {
  const name = String(key).replace(/^e2ee\./, '');
  const lang = I18N[currentLang] ? currentLang : 'ru';
  const template = I18N[lang].e2ee?.[name]
    ?? coreE2eeStrings?.[lang]?.[name]
    ?? coreE2eeStrings?.en?.[name]
    ?? key;
  return String(template).replace(/\{(\w+)\}/g, (whole, field) => (
    vars?.[field] === undefined || vars?.[field] === null ? whole : String(vars[field])
  ));
}

function coreSay(line, about = null) {
  const text = String(line ?? '').trim();
  if (!text) return;
  const subject = about?.peer ?? coreE2eePeer;
  // About this account's own devices: Saved Messages is the conversation with
  // yourself, so the note is kept there; a toast says it now when another
  // conversation is open. In somebody else's thread it read as a check with
  // *them* (live test, 2026-11-11: "compare with godsheep" under roman).
  if (self?.login && subject === self.login) {
    const own = threads.get(self.login);
    if (own) systemNote(own, text);
    if (!own || activePeer !== self.login) showToast(text);
    return;
  }
  const target = subject || activePeer;
  const thread = target && target === activePeer ? threads.get(target) : null;
  if (thread) systemNote(thread, text);
  else showToast(text);
}

function createCoreE2ee(createE2eeCommands) {
  return createE2eeCommands({
    getSession: () => coreSession,
    getApi: () => ({
      async e2eeKeysQuery(logins) {
        const out = await request('POST', '/e2ee/keys/query', { logins });
        return out?.users && typeof out.users === 'object' ? out.users : {};
      },
    }),
    getPeer: () => activePeer,
    getSelf: () => self?.login ?? null,
    promptSecret: askCoreSecret,
    say: coreSay,
    t: e2eeText,
  });
}

// The page draws these two itself; every other notice is the module's.
const CORE_E2EE_SCREENS = {
  'backup-created': showBackupKeyDialog,
  'device-keys-conflict': showSignInAgainDialog,
};

function handleCoreE2eeNotice(notice) {
  if (!coreE2ee || !notice?.kind) return;
  const screen = CORE_E2EE_SCREENS[notice.kind];
  if (screen) {
    screen(notice);
    return;
  }
  const handler = coreE2ee.events[`core-${notice.kind}`];
  if (!handler) {
    noteSafetyCodeNotice(notice);
    return;
  }
  coreE2eePeer = typeof notice.peer === 'string' ? notice.peer : null;
  try {
    handler(notice);
  } finally {
    coreE2eePeer = null;
  }
  if (notice.kind === 'sas-code-ready') openSasDialog(notice);
  else if (notice.kind === 'sas-cancelled' && sasDialog?.id === notice.transactionId) closeSasDialog();
  else if (notice.kind === 'device-verified') closeSasDialog();
  noteSafetyCodeNotice(notice);
}

// The safety code's part of the core's news.
function noteSafetyCodeNotice(notice) {
  if (notice.kind === 'safety-code') onSafetyCode(notice);
  // What a code is made from may have moved: ask again when it is next shown.
  if (['key-changed', 'device-verified'].includes(notice.kind) && notice.peer) {
    forgetSafetyCodes(notice.peer);
    if (notice.peer === activePeer) renderInfoPanel();
  }
  // This device's keys are on the server (every connection says so once):
  // what was asked before that — a panel left open across a reload asks the
  // moment the page starts — was answered "not running yet" and is stale.
  // Owner's first look at 1.143: "encryption is not running on this device
  // yet" under a conversation whose verification lines were right there.
  if (notice.kind === 'device-registered' || notice.kind === 'cross-signing-reset') {
    forgetSafetyCodes();
    renderInfoPanel();
  }
}

function runCoreE2eeCommand(cmd, arg) {
  const fail = (error) => coreSay(e2eeText('e2ee.failed', { reason: error?.message ?? String(error) }));
  // A new verification ends the previous one in the module (it is cancelled
  // on both sides), so its dialog goes too instead of offering an answer to a
  // handshake that no longer exists.
  if (cmd === '/verify' && !['yes', 'y', 'да', 'no', 'n', 'нет'].includes(String(arg ?? '').trim().toLowerCase())) {
    closeSasDialog();
  }
  try {
    const run = {
      '/verify': () => coreE2ee.verify(arg),
      '/safety': () => coreE2ee.safety(arg),
      '/trust': () => coreE2ee.trust(),
      '/backup': () => coreE2ee.backup(arg),
      '/keys': () => coreE2ee.keys(arg),
    }[cmd];
    void Promise.resolve(run?.()).catch(fail);
  } catch (error) {
    fail(error);
  }
}

// The card every encryption dialog is built from: the static dialogs' own
// classes (`askRemoveContact`), header with a close button, then `body`.
// Esc, the close button and the backdrop close it; `onClose` runs once.
function coreDialog(titleText, onClose) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal-dialog';
  const card = document.createElement('div');
  card.className = 'modal-card';
  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.textContent = titleText;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'icon-button modal-close';
  dismiss.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>';
  dismiss.setAttribute('aria-label', e2eeText('e2ee.secretCancel'));
  header.append(title, dismiss);
  card.append(header);
  dialog.append(card);
  dismiss.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  return { dialog, card };
}

function coreHint(text) {
  const hint = document.createElement('p');
  hint.className = 'modal-hint';
  hint.textContent = text;
  return hint;
}

function coreActions(...buttons) {
  const actions = document.createElement('div');
  actions.className = 'profile-actions';
  for (const [label, kind, handler] of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind === 'primary' ? 'primary-button' : 'quiet-button';
    button.textContent = label;
    button.addEventListener('click', handler);
    actions.append(button);
  }
  return actions;
}

function showCoreDialog(dialog) {
  document.body.append(dialog);
  dialog.showModal();
}

// The emoji comparison. The answer goes through the module's own `/verify
// yes|no`, so the dialog and the command are one state: answering either way
// settles both, and a dialog closed unanswered cancels — the other side would
// otherwise wait for a "yes" that never comes.
function openSasDialog({ transactionId, peer, emojiIndices = [], decimals = [] }) {
  closeSasDialog();
  let answered = false;
  const answer = (confirm) => {
    if (answered) return;
    answered = true;
    if (sasDialog?.id === transactionId) sasDialog = null;
    runCoreE2eeCommand('/verify', confirm ? 'yes' : 'no');
  };
  const { dialog, card } = coreDialog(e2eeText('e2ee.sasTitle', { peer }), () => {
    // Closed by the person (Esc, ✕, backdrop) while still ours: a "no".
    if (!answered && sasDialog?.id === transactionId) answer(false);
  });
  const emojis = document.createElement('div');
  emojis.className = 'sas-emojis';
  for (const index of emojiIndices) {
    const [glyph, label] = coreSasEmojis[index] ?? ['🔒', 'lock'];
    const cell = document.createElement('figure');
    cell.className = 'sas-emoji';
    const big = document.createElement('span');
    big.className = 'sas-emoji-glyph';
    big.textContent = glyph;
    const caption = document.createElement('figcaption');
    caption.className = 'sas-emoji-label';
    caption.textContent = label;
    cell.append(big, caption);
    emojis.append(cell);
  }
  const numbers = document.createElement('p');
  numbers.className = 'sas-numbers';
  numbers.textContent = decimals.join('  ');
  card.append(
    coreHint(e2eeText('e2ee.sasHint', { peer })),
    emojis,
    numbers,
    coreActions(
      [e2eeText('e2ee.sasDiffer'), 'quiet', () => { answer(false); dialog.close(); }],
      [e2eeText('e2ee.sasMatch'), 'primary', () => { answer(true); dialog.close(); }],
    ),
  );
  sasDialog = { id: transactionId, dialog };
  showCoreDialog(dialog);
}

// The verification ended elsewhere (verified, cancelled there, the core
// stopped): the dialog goes without answering anything.
function closeSasDialog() {
  const open = sasDialog;
  sasDialog = null;
  open?.dialog.close();
}

// `promptSecret` for the module: a masked field, resolved with what was typed,
// or with '' when the dialog was closed — the module reads '' as "cancelled".
function askCoreSecret({ title, subtitle, prompt, hint }) {
  return new Promise((resolve) => {
    // Settled by the buttons themselves, not only by `close`: a hidden tab may
    // hold the `close` task back, and the restore would then wait on a dialog
    // that is already gone. `close` still answers Esc, ✕ and the backdrop.
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { dialog, card } = coreDialog(title, () => finish(''));
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.setAttribute('for', 'core-secret-input');
    label.textContent = prompt;
    const input = document.createElement('input');
    input.id = 'core-secret-input';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    field.append(label, input);
    const submit = () => {
      finish(input.value);
      dialog.close();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });
    card.append(
      coreHint(subtitle),
      field,
      coreHint(hint),
      coreActions(
        [e2eeText('e2ee.secretCancel'), 'quiet', () => {
          finish('');
          dialog.close();
        }],
        [e2eeText('e2ee.secretConfirm'), 'primary', submit],
      ),
    );
    showCoreDialog(dialog);
    input.focus();
  });
}

// The recovery key is shown once, so it gets a dialog with a Copy button
// rather than a line that scrolls away. It is never written anywhere else.
function showBackupKeyDialog({ version, recoveryKey }) {
  const { dialog, card } = coreDialog(e2eeText('e2ee.backupKeyTitle'));
  const box = document.createElement('div');
  box.className = 'invite-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.spellcheck = false;
  input.value = String(recoveryKey ?? '');
  const status = document.createElement('p');
  status.className = 'modal-status';
  status.setAttribute('role', 'status');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'primary-button';
  copy.textContent = e2eeText('e2ee.copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = e2eeText('e2ee.copied');
      status.dataset.kind = 'success';
    } catch {
      input.select();
      status.textContent = e2eeText('e2ee.copyFailed');
      status.dataset.kind = 'error';
    }
  });
  box.append(input, copy);
  card.append(
    coreHint(e2eeText('e2ee.backupKeyHint', { version })),
    box,
    status,
    coreActions([e2eeText('e2ee.done'), 'primary', () => dialog.close()]),
  );
  showCoreDialog(dialog);
  input.select();
}

// The server holds other keys under this sign-in's device: this browser's
// store is not the one that registered it, and the core has stopped trying.
// A new sign-in gets a new store (`coreStoreName`), which is the whole fix.
function showSignInAgainDialog() {
  if (signInAgainShown) return;
  signInAgainShown = true;
  const { dialog, card } = coreDialog(e2eeText('e2ee.signInAgainTitle'));
  card.append(
    coreHint(e2eeText('e2ee.signInAgain', { self: self?.login || '' })),
    coreActions(
      [e2eeText('e2ee.later'), 'quiet', () => dialog.close()],
      [e2eeText('e2ee.signInAgainNow'), 'primary', () => {
        dialog.close();
        logout();
      }],
    ),
  );
  showCoreDialog(dialog);
}

// Settings' encryption section exists only while the core runs.
function syncCoreE2eeSettings() {
  if (elements.settingsE2eeSection) elements.settingsE2eeSection.hidden = !coreE2ee;
}

function runCoreE2eeFromSettings(cmd, arg) {
  closeSettingsDialog();
  if (coreE2ee) runCoreE2eeCommand(cmd, arg);
}

// One rung of one own message, never backwards; `read` and `delivered` are
// watermarks, so every committed mark at or below the message moves with it —
// the same rule the live `read`/`ack` frames and `/api/history` follow here.
function applyCoreReceipt(peer, id, ts, receipt) {
  const thread = threads.get(peer);
  const mark = thread?.marks.get(id);
  if (!mark) return;
  if (receipt === 'queued') {
    // A retry takes a ⚠ back to the clock; a fresh send is drawn on it already.
    if (mark.dataset.state === 'failed') setMark(mark, 'queued');
    return;
  }
  if (receipt === 'failed') {
    if (!markCommitted(mark)) {
      setMark(mark, 'failed');
      scheduleRosterRender();
    }
    return;
  }
  const state = CORE_MARKS[receipt];
  if (!state) return;
  if (Number.isFinite(ts) && ts > 0) mark.dataset.ts = String(ts);
  if (mark.dataset.state === 'queued' || mark.dataset.state === 'failed') {
    setMark(mark, 'sent');
    settleCommittedMark(thread, mark);
  }
  const at = Number(mark.dataset.ts) || 0;
  if (state === 'read') applyPeerReadWatermark(peer, at);
  else if (state === 'ack') applyPeerDeliveredWatermark(thread, at);
}

// A core row in the shape `/api/history` gives, for `populateHistory` and
// `handleFrame`: a received message, or one of ours (`sent`, `pending`) — the
// core keeps the text of what this device encrypted, the server only the
// envelope. `null` for anything else.
function coreRowMessage(row) {
  if (!row || !['message', 'sent', 'pending'].includes(row.source)) return null;
  // The carrier of an edit is the store's proof the edit was applied, not a
  // message: it is never drawn, previewed or counted.
  if (row.editOf) return null;
  const reactions = {};
  for (const { emoji, by } of Array.isArray(row.reactions) ? row.reactions : []) {
    if (typeof emoji === 'string' && Array.isArray(by)) reactions[emoji] = by;
  }
  const sealed = row.protection === 'waiting' || row.protection === 'undecryptable';
  return {
    sealed,
    id: row.id,
    from: row.from,
    ts: row.ts,
    kind: row.kind === 'ai' ? 'ai' : 'human',
    author: row.author || undefined,
    text: sealed ? t('msgEncryptedWaiting') : (row.text || ''),
    image: row.image || undefined,
    voice: row.voice || undefined,
    replyTo: row.replyTo || undefined,
    forwardedFrom: row.forwardedFrom || undefined,
    buttons: Array.isArray(row.buttons) && row.buttons.length > 0 ? row.buttons : undefined,
    editedAt: row.editedAt || undefined,
    mediaDropped: row.mediaDropped || undefined,
    reactions,
  };
}

// The server keeps an encrypted message as an envelope it cannot read; the
// core holds what it decrypted. A history page shows the core's text in its
// place, or says the key has not arrived — never an empty bubble.
function decryptHistoryPage(peer, messages) {
  // An edit's carrier is the server's envelope for an edit, whichever client
  // reads it: a core page puts the new text on the target below, a page
  // without the core could not read it anyway (its stub says "update").
  if (Array.isArray(messages) && messages.some((m) => m?.sealedEdit === true)) {
    messages = messages.filter((m) => m?.sealedEdit !== true);
  }
  if (!coreSession || !Array.isArray(messages) || !messages.some((m) => m?.e2ee)) return messages;
  const known = new Map();
  for (const row of coreSession.conversation(peer, 1000)) known.set(row.id, row);
  return messages.map((message) => {
    if (!message?.e2ee) return message;
    const decrypted = coreRowMessage(known.get(message.id));
    if (!decrypted || decrypted.sealed) coreSealedRows.add(`${peer}\n${message.id}`);
    if (decrypted) return { ...decrypted, deletedAt: message.deletedAt, editedAt: message.editedAt || decrypted.editedAt };
    return { ...message, text: t('msgEncryptedWaiting') };
  });
}

// A received row that was drawn while the core could not open it — its words
// were "the key has not arrived" — holds the placeholder and nothing else. When
// the core opens it, the quote, the forward label and the attachment come with
// the words, and the row has to be drawn again, in the same place: setting the
// text alone would leave a reply without its quote and a voice note without its
// player. `false` when the row has none of those (the text is all there is).
function redrawOpenedRow(thread, message) {
  if (!(message.replyTo || message.forwardedFrom || message.image || message.voice || message.buttons)) return false;
  const old = thread.node.querySelector(`[data-id="${CSS.escape(message.id)}"]`);
  if (!old) return false;
  const own = old.dataset.side === 'own';
  const author = old.dataset.author;
  thread.seen.delete(message.id);
  const voice = mediaSource(thread.peer, message.id, message.voice, 'voice');
  if (voice) {
    appendVoiceMessage(thread, {
      id: message.id,
      own,
      author,
      dataUrl: voice.dataUrl || null,
      mediaRef: voice.mediaRef || null,
      duration: voice.duration || 0,
      reactions: message.reactions,
      ts: message.ts || Date.now(),
      text: typeof message.text === 'string' ? message.text : '',
      forwardedFrom: message.forwardedFrom,
      editedAt: message.editedAt,
    });
  } else {
    appendMessage(thread, {
      id: message.id,
      own,
      kind: message.kind === 'ai' ? 'ai' : 'human',
      author,
      text: message.text || '',
      image: mediaSource(thread.peer, message.id, message.image, 'image'),
      ts: message.ts || Date.now(),
      reactions: message.reactions,
      replyTo: message.replyTo,
      forwardedFrom: message.forwardedFrom,
      editedAt: message.editedAt,
      buttons: message.buttons,
    });
  }
  const fresh = thread.node.lastElementChild;
  if (fresh && fresh !== old) {
    thread.node.insertBefore(fresh, old);
    old.remove();
    normalizeDateDividers(thread);
  }
  return true;
}

// A row the core stored that never crossed the wire in a form this page can
// draw: an encrypted message (the core owns its frame and decrypts it), or one
// the feed fetched for a conversation this tab holds. Drawn through
// `handleFrame`, so the sound, the unread count and the read receipt are the
// live path's own. Deferred a turn: a plain live frame is handed over right
// after the core stores it, and that frame — not this — is the one to draw.
function paintCoreRow(peer, id) {
  if (!coreSession || typeof peer !== 'string' || typeof id !== 'string') return;
  if (!threads.get(peer)?.loaded) return;
  setTimeout(() => {
    const thread = threads.get(peer);
    if (!coreSession || !thread) return;
    const key = `${peer}\n${id}`;
    if (thread.seen.has(id) && !coreSealedRows.has(key)) return;
    const rows = coreSession.conversation(peer, 50);
    const row = rows.find((item) => item.id === id);
    // A carrier says its target changed: the target's text, from the store,
    // goes into the row on screen, marked edited. Whoever authored the edit,
    // and whichever device it came from, is the same here.
    if (row?.editOf) {
      const target = rows.find((item) => item.id === row.editOf);
      const shown = thread.node.querySelector(`[data-id="${CSS.escape(row.editOf)}"]`);
      // Already showing these words (the author's own edit was drawn when it was
      // typed): nothing to repaint.
      if (target && typeof target.text === 'string' && shown?.messageText !== target.text) {
        updateMessageText(peer, target.id, target.text, target.editedAt || Date.now());
      }
      return;
    }
    const message = coreRowMessage(row);
    if (!message) return;
    if (thread.seen.has(id)) {
      // Drawn sealed earlier; now the core has opened it.
      if (message.sealed) return;
      coreSealedRows.delete(key);
      if (redrawOpenedRow(thread, message)) return;
      updateMessageText(peer, id, message.text, 0, { edited: false });
      return;
    }
    // Our own sends were drawn by the composer (or, after a reload, by
    // `ensurePendingRows` and history); only a received message is new here.
    if (row.source !== 'message') return;
    if (message.sealed) coreSealedRows.add(key);
    const isSelf = message.from === self?.login;
    handleFrame(peer, {
      t: message.kind === 'ai' ? 'ai' : 'msg',
      id: message.id,
      ts: message.ts,
      text: message.text,
      name: message.author,
      image: message.image,
      voice: message.voice,
      replyTo: message.replyTo,
      forwardedFrom: message.forwardedFrom,
      buttons: message.buttons,
      reactions: message.reactions,
    }, isSelf);
  }, 0);
}


// --- WebSocket -----------------------------------------------------------

function connectSocket() {
  if (socket || !token) return;
  // On the core a dropped page socket is replaced at once (`handleSocketGone`),
  // so the word stays the one for a link that was already up.
  setConnection('connecting', coreSession && everConnected ? t('connReconnecting') : t('connConnecting'));
  // Under the core flag the first connection waits for the core to load; the
  // load calls back here, with the core or — when it could not start — without.
  if (!coreSession && coreWanted()) {
    void startCore();
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/tailchat/ws`;

  try {
    socket = coreSession ? coreSession.connect() : new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    lastServerMessageAt = Date.now();
    // The core watches its own socket's silence and redials (`driver.rs`); a
    // second watchdog here could only drop the page's view of a healthy link.
    if (!coreSession) startHeartbeat();
    // What this client implements, so the server can tell it things an older
    // tab could not use and refuse nothing an older tab could do:
    //   - `durable-ack` / `addressed-send`: a message may be addressed to a peer
    //     this socket is not subscribed to, and its acceptance comes back as
    //     `message-accepted`. Together they are what lets the durable send queue
    //     retry a message at all — and they are the reason a frame written a
    //     moment before the peer was switched is delivered instead of refused
    //     with `not_subscribed` (`relay` in `src/cloud/hub.js`).
    //   - `sync-v1` / `sync-nudge-v1`: the account feed exists and the server
    //     will say when it moved, which is how the conversations this tab is not
    //     looking at stay in step.
    //   - `read-ack-v1`: a socket write is not a committed read watermark.
    //     Keep viewed receipts queued until the server acknowledges them.
    sendEnvelope({
      k: 'auth',
      token,
      webFeatures: true,
      caps: [...SOCKET_CAPS, MEDIA_REF_CAP],
    });
  };

  socket.onmessage = (event) => {
    // Any byte at all, of any kind: the point is liveness, not what was said.
    lastServerMessageAt = Date.now();
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEnvelope(payload);
  };

  socket.onclose = () => {
    socket = null;
    handleSocketGone();
  };

  socket.onerror = () => {
    socket?.close();
  };
}

// Everything that has to be forgotten when the link is gone, whichever way we
// found out — a real `close` event, or the heartbeat concluding it never would.
function handleSocketGone() {
  stopHeartbeat();
  clearPendingPing();
  authed = false;
  subscribedPeer = null;
  for (const entry of readReceiptQueue) entry.sentAt = 0;
  resetIncomingTransfers();
  setConnection('offline', everConnected ? t('connReconnecting') : t('connOffline'));
  refreshPeerActions();
  // The core redials on its own clock; the page's next socket costs nothing and
  // simply opens when the core's connection does, so it is asked for at once.
  if (coreSession && token) connectSocket();
  else scheduleReconnect();
  // A pass cannot be in flight without a socket, and the entries that were in
  // it are still unanswered: the queue keeps ticking on its own timer so the
  // next connection (this tab's or a reload's) picks them up.
  syncInFlight = false;
  schedulePendingRetry();
}

// A socket we have stopped believing in. Its handlers are detached first,
// because a half-open socket may take minutes to admit it is closed — or never
// — and a late `onclose` would then tear down whatever connection replaced it.
function dropSocket() {
  const dead = socket;
  if (!dead) return;
  socket = null;
  authed = false;
  subscribedPeer = null;
  dead.onopen = null;
  dead.onmessage = null;
  dead.onclose = null;
  dead.onerror = null;
  try {
    dead.close();
  } catch {
    // Already gone at the transport level; nothing left to close.
  }
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const silence = Date.now() - lastServerMessageAt;
    if (silence >= HEARTBEAT_SILENCE_MS) {
      // Two probes have now gone unanswered. Whatever the socket claims, it is
      // not carrying anything, so replace it rather than wait for an event
      // that a half-open connection is never going to deliver.
      dropSocket();
      handleSocketGone();
      return;
    }
    if (silence >= HEARTBEAT_MS) sendEnvelope({ k: 'who' });
  }, HEARTBEAT_MS);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
}

// The page becoming visible again, or the OS admitting the network is back,
// is better evidence than any timer: reconnect now instead of waiting out the
// remaining backoff.
function reconnectNow() {
  if (!token) return;
  if (coreSession) {
    // The core owns the real socket: a link that is up is asked to prove it
    // (`probe`), one that is down is redialled now instead of at the end of
    // its backoff.
    if (socket?.readyState === WebSocket.OPEN) {
      coreSession.probe();
      if (activePeer) void reconcileActiveThread(activePeer);
      return;
    }
    coreSession.reconnect();
    if (!socket) connectSocket();
    return;
  }
  if (socket) {
    // Coming back to the tab is exactly when a socket that slept through a
    // suspend is still claiming to be open. Refusing to act because `socket`
    // is non-null is what used to leave the app wedged until a full reload:
    // a link that has been silent is dropped here rather than trusted.
    const stale = socket.readyState !== WebSocket.OPEN
      && socket.readyState !== WebSocket.CONNECTING;
    if (!stale && Date.now() - lastServerMessageAt < HEARTBEAT_MS) {
      // Plausibly alive — ask the server to prove it instead of throwing away
      // a working connection. The heartbeat takes it from here if it lies.
      sendEnvelope({ k: 'who' });
      if (activePeer) void reconcileActiveThread(activePeer);
      return;
    }
    dropSocket();
    stopHeartbeat();
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelay = RECONNECT_MIN_MS;
  connectSocket();
}

window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    reconnectNow();
    if (swRegistration) swRegistration.update().catch(() => {});
  }
});

function handleEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.k === 'ready') {
    authed = true;
    if (payload.self?.login) {
      // Merged for the same reason the profile envelope is (see below): the two
      // carry the same three fields and a tab that has already learned
      // `extraPasswordEnabled` from HTTP keeps it when the socket reconnect
      // arrives.
      self = { ...self, ...payload.self };
      renderSelfIdentity();
    }
    serverCaps = new Set(Array.isArray(payload.caps) ? payload.caps.filter((cap) => typeof cap === 'string') : []);
    setConnection('online', t('connOnline'));
    everConnected = true;
    if (Array.isArray(payload.users)) setUsers(payload.users);
    subscribeActivePeer(true);
    if (activePeer) void reconcileActiveThread(activePeer);
    publishPresence(presenceState, { force: true });
    refreshPeerActions();
    void subscribeWebPush();
    void preloadThreads();
    // The durable queue lives in storage, and this is the first moment the tab
    // knows which account's queue to read. Flushing on every `ready` is what
    // makes a reload, a reconnect and a fresh login all end the same way: the
    // unanswered messages go out again, under their original ids.
    loadPendingSends();
    flushPendingSends();
    startSyncPump();
    return;
  }
  if (payload.k === 'message-accepted') {
    // The server committed a message. For one this tab is still holding in its
    // durable queue that is the receipt the send was waiting for — the socket
    // accepting the frame never was, and a session that treated it as one
    // cleared the composer for a message the server might never have seen.
    if (typeof payload.id === 'string') {
      acceptPendingSend(payload.peer, payload.id, Number.isFinite(payload.ts) ? payload.ts : 0);
    }
    return;
  }
  if (payload.k === 'sync-page') {
    applySyncPage(payload);
    return;
  }
  if (payload.k === 'sync-nudge') {
    startSyncPump();
    return;
  }
  if (payload.k === 'profile' && payload.user?.login === self?.login) {
    // Merged rather than replaced: the self this tab holds is assembled from
    // whichever envelope spoke last, and a deployment that sends a narrower
    // `profile` (or a client that has just seen a wider one) must not be able to
    // erase a field the other did supply — losing `extraPasswordEnabled` here
    // made the profile dialog offer to *set* an additional password that was
    // already set.
    self = { ...self, ...payload.user };
    renderSelfIdentity();
    return;
  }
  if (payload.k === 'subscribed') {
    subscribedPeer = payload.peer;
    // The subscription is what `sendFrame` needs to route anything on a server
    // that cannot address a peer this socket is not watching, and it is also
    // the moment a message that lost the race against it — written the instant
    // the conversation was switched — can finally go out. Retrying here rather
    // than only on the timer is what makes the race invisible instead of three
    // seconds long.
    loadPendingSends();
    flushPendingSends(payload.peer);
    const waiters = subscriptionWaiters.get(payload.peer);
    if (waiters) {
      subscriptionWaiters.delete(payload.peer);
      for (const resolve of waiters) resolve(true);
    }
    greetPeer();
    if (payload.peer === activePeer) void reconcileActiveThread(payload.peer);
    // Receipts that could not go out before — the socket was down, or this tab
    // was watching another conversation — are offered again here, because a
    // subscription is exactly what `sendFrame` was waiting for. This is also the
    // path a reconnect takes: `ready` re-subscribes, so a read receipt written
    // for a message read behind the offline banner goes out as soon as the link
    // is back rather than at the next focus.
    pumpReadReceipts();
    return;
  }
  if (payload.k === 'presence') {
    paintPresence(payload.peer, Boolean(payload.online), payload.lastSeen, payload.state);
    return;
  }
  if (payload.k === 'users' || payload.k === 'roster') {
    if (Array.isArray(payload.users)) setUsers(payload.users);
    void preloadThreads();
    return;
  }
  if (payload.k === 'reply-reminder-set') {
    // The hub answers the connection that set one, and again on every `auth`
    // with everything still pending (src/cloud/hub.js): the same mark the
    // local click puts up, redrawn from the server, so it survives a reload
    // and reaches this account's other sessions.
    const reminder = payload.reminder;
    if (!reminder || typeof reminder.peer !== 'string') return;
    noteReminderSet(threadFor(reminder.peer), reminder.messageId);
    return;
  }
  if (payload.k === 'reply-reminder-fired') {
    const reminder = payload.reminder;
    if (!reminder || typeof reminder.id !== 'string' || typeof reminder.peer !== 'string') return;
    const thread = threadFor(reminder.peer);
    if (typeof reminder.messageId === 'string') {
      noteReminderFired(thread, reminder.messageId);
    }
    systemNote(thread, t('replyReminderDue', displayName(reminder.peer)));
    void showWebNotification({
      title: 'Tailchat',
      body: t('replyReminderDue', displayName(reminder.peer)),
      tag: `tailchat-reply-reminder-${reminder.id}`,
      peer: reminder.peer,
      messageId: reminder.messageId,
    });
    sendEnvelope({ k: 'reply-reminder-ack', id: reminder.id });
    return;
  }
  if (payload.k === 'read-sync') {
    applySyncedRead(payload.peer, payload.readTs);
    return;
  }
  if (payload.k === 'read-accepted') {
    if (typeof payload.peer !== 'string') return;
    if (payload.id === null) {
      const at = readReceiptQueue.findIndex((entry) => entry.peer === payload.peer && entry.id === null);
      if (at >= 0) readReceiptQueue.splice(at, 1);
    }
    applySyncedRead(payload.peer, payload.readTs);
    if (payload.id === null) {
      const thread = threads.get(payload.peer);
      if (thread) {
        thread.reactionEvents?.clear();
        paintReactionEvents(thread);
      }
      if (payload.readTs === 0) settleReadReceipt({ peer: payload.peer, id: null });
    }
    return;
  }
  if (payload.k === 'message-event') {
    handleFrame(payload.from, payload.d, Boolean(payload.self));
    return;
  }
  if (payload.k === 'conversation-update') {
    const thread = threadFor(payload.from);
    if (payload.last) notePreview(payload.from, payload.last);
    const viewable = payload.from === activePeer && messageIsOnScreen(payload.from);
    if (payload.from === activePeer) {
      subscribeActivePeer(true);
      void reconcileActiveThread(payload.from);
    }
    if (!payload.self && !viewable) {
      thread.unread += 1;
      const release = payload.from === OFFICIAL_ACCOUNT_LOGIN
        && String(payload.last?.id || '').startsWith('release-');
      notifyReceivedSound(payload.from, { force: release });
      if (release) offerWebUpdate();
    }
    // A message to a conversation this socket is not subscribed to reaches it
    // only as this envelope — the frame itself waits in the server's queue
    // until somebody opens the conversation — so the `ack` in `handleFrame`
    // never ran and the author sat on ✓ until then. The tab now holds the
    // message (`last` is the whole record), which is what the delivered rung
    // means. AI answers take no ack, as in `handleFrame`. Android does the same
    // from its feed (`SyncEngine.applySyncPage`).
    const lastId = typeof payload.last?.id === 'string' ? payload.last.id : '';
    if (!payload.self && lastId && payload.last.from === payload.from && payload.last.kind !== 'ai') {
      sendMessageFrame(payload.from, { t: 'ack', id: lastId });
    }
    renderRoster(); updateAppUnreadBadge();
    return;
  }
  if (payload.k === 'frame') {
    if (typeof payload.d?.t === 'string' && payload.d.t.startsWith('rtc-')) {
      handleRtcFrame(payload.from, payload.d);
      return;
    }
    handleFrame(payload.from, payload.d, Boolean(payload.self));
    return;
  }
  if (payload.k === 'error') {
    handleServerError(payload);
  }
}

function handleServerError(payload) {
  if (payload.code === 'auth_failed' || payload.code === 'auth_required' || payload.code === 'unknown_token') {
    expireSession();
    return;
  }
  // A refusal aimed at one of this tab's own unanswered sends. The two codes
  // that reach here are both permanent for that id — the server either knows the
  // id with different content, or refused to write it — so retrying is not a
  // plan: the entry leaves the queue and its row says so, which is the
  // difference between «отправляется» and «не отправлено». Anything else
  // (`too_fast`, a transient `store_failed`) stays queued and goes out again.
  const refusedId = typeof payload.id === 'string' ? payload.id : '';
  const refusedPeer = typeof payload.peer === 'string' && payload.peer !== ''
    ? payload.peer
    : [...pendingSends.keys()].find((peer) => pendingFor(peer).some((item) => item.id === refusedId));
  if (refusedId && refusedPeer && (payload.code === 'message_id_conflict' || payload.code === 'store_failed')) {
    failPendingSend(refusedPeer, refusedId, payload.code);
  }
  const thread = activePeer ? threads.get(activePeer) : null;
  if (thread) systemNote(thread, errorText(payload.code));
  else setConnection('offline', errorText(payload.code));
}

function greetPeer() {
  if (!activePeer || !self) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sendFrame(activePeer, { t: 'hello', name: self.name, connId: randomHex(16), v: 'web', tz, lang: currentLang });
}

function matchesPendingPong(pending, from, frame) {
  return Boolean(
    pending
    && pending.peer === from
    && (frame.id === pending.id || !Object.hasOwn(frame, 'id'))
  );
}

function handleFrame(from, frame, isSelf = false) {
  if (typeof from !== 'string' || !frame || typeof frame !== 'object') return;

  if (frame.t === 'hello') {
    if (typeof frame.name === 'string' && frame.name !== '') {
      const u = users.find((item) => item.login === from);
      if (u && u.name !== frame.name) {
        u.name = frame.name;
        renderRoster();
        if (from === activePeer) updatePeerHeader();
      }
    }
    // Remembered, never answered: replying to a hello with a hello is the
    // feedback loop AGENTS.md rule 4 exists to prevent. A terminal that learns
    // nothing about this client from here simply reports the version as
    // unknown, which src/cli.js no longer mistakes for an out-of-date peer.
    peerClients.set(from, typeof frame.v === 'string' ? frame.v : null);
    if (from === activePeer) renderInfoPanel();
    return;
  }

  if (frame.t === 'pong') {
    // Pre-0.81d web peers returned `{t:'pong', ts}` without an id. Preserve
    // that one compatibility path, but never let a different peer or a pong
    // carrying a wrong id complete the request.
    if (matchesPendingPong(pendingPing, from, frame)) {
      const elapsed = Math.round(performance.now() - pendingPing.start);
      clearPendingPing();
      lastLatencyMs = elapsed;
      showToast(t('pingResult', elapsed));
      renderInfoPanel();
    }
    return;
  }

  if (frame.t === 'ping') {
    sendFrame(from, { t: 'pong', id: frame.id, ts: Date.now() });
    return;
  }

  if (frame.t === 'wake') {
    playSound('wake');
    triggerWakeAnimation();
    const thread = threadFor(from);
    systemNote(thread, t('wakeReceived', displayName(from)));
    showWebNotification({
      title: '🔔 Tailchat Wake',
      body: t('wakeReceived', displayName(from)),
      tag: `tailchat-wake-${from}`,
      peer: from,
    });
    return;
  }

  if (frame.t === 'focus') {
    paintPresence(from, true, undefined, frame.state);
    return;
  }

  // An edit's carrier as a classic page receives it: the server's stub for an
  // envelope it cannot open, flagged. Not a message, not an unread, not a sound.
  if (frame.sealedEdit === true) return;

  if (frame.t === 'edit') {
    updateMessageText(from, frame.id, frame.text, frame.editedAt);
    return;
  }

  if (frame.t === 'react') {
    applyReaction(from, frame);
    return;
  }
  if (frame.t === 'actions') {
    applyBotActions(from, frame.actions);
    return;
  }

  if (frame.t === 'typing') {
    showTyping(from, frame.state === 'start', frame.name);
    return;
  }

  if (frame.t === 'ack' || frame.t === 'read') {
    applyReceipt(from, frame);
    return;
  }

  // Deletion arrives as a control frame, before the «is this something we
  // draw?» gate below: it is the one frame whose job is to *undraw*.
  if (frame.t === 'del') {
    const ids = Array.isArray(frame.ids) ? frame.ids.filter((id) => typeof id === 'string' && id !== '') : [];
    if (ids.length > 0) removeLocalMessages(from, ids);
    return;
  }

  if (frame.t === 'holiday' && typeof frame.on === 'boolean') {
    holidayMode = frame.on;
    try {
      localStorage.setItem(HOLIDAY_KEY, String(holidayMode));
    } catch {}
    return;
  }

  if (frame.t === 'file-offer') {
    receiveFileOffer(from, frame);
    return;
  }
  if (frame.t === 'file-chunk') {
    receiveFileChunk(from, frame);
    return;
  }
  if (frame.t === 'file-done') {
    void receiveFileDone(from, frame);
    return;
  }
  if (frame.t === 'file-deny') {
    const thread = threadFor(from);
    systemNote(thread, t('fileFailed', safeAttachmentName(frame.name || 'file')));
    return;
  }

  if (!RENDERED_FRAMES.has(frame.t)) return;

  // Handle voice frames
  const liveVoice = mediaSource(from, frame.id, frame.voice, 'voice');
  if (liveVoice) {
    const thread = threadFor(from);
    const id = typeof frame.id === 'string' ? frame.id : null;
    const known = id ? thread.seen.has(id) : false;
    // `formatClock`, the player's own clock. This line used to call a
    // `formatDuration` that never existed: every voice note arriving in an
    // open tab threw before it was drawn, so it showed up only after a reload
    // and its `ack`/`read` never left — the sender's mark stuck on ✓.
    const durText = formatClock(liveVoice.duration || 0);
    appendVoiceMessage(thread, {
      id,
      own: isSelf,
      author: isSelf ? self.name : authorLabelFor(from, frame.name),
      dataUrl: liveVoice.dataUrl || null,
      mediaRef: liveVoice.mediaRef || null,
      duration: liveVoice.duration || 0,
      ts: Number.isFinite(frame.ts) ? frame.ts : Date.now(),
      text: typeof frame.text === 'string' ? frame.text : '',
      forwardedFrom: frame.forwardedFrom,
    });
    if (!isSelf) {
      notifyReceivedSound(from);
      showWebNotification({
        title: `${displayName(from)} (Tailchat)`,
        body: t('voiceMessageNotify', durText),
        tag: `tailchat-msg-${from}`,
        peer: from,
      });
    }
    if (from === activePeer) {
      hideTyping();
      // A message synced back from another of my own devices is exactly as
      // much "my own send" as one typed here — every local send elsewhere in
      // this file force-scrolls (scrollToLatest(true)); the soft version
      // below is for a genuine incoming peer message, where yanking a person
      // away from history they are reading would be rude. Without this the
      // tab silently sat scrolled up after a CLI-side send, with only the
      // floating "new messages" badge — indistinguishable from an unread
      // peer message — to say anything had arrived.
      scrollToLatest(isSelf);
    }
    // Same receipt contract as the text path below: acknowledge delivery, then
    // read, and hold the read receipt for messages that arrive while the peer
    // is not on screen. Without the `ack` a voice note's checkmark never left
    // the single ✓, and without the unread queue a voice note read after the
    // fact was never marked read at all.
    if (!id || isSelf) return;
    sendMessageFrame(from, { t: 'ack', id });
    if ((thread.readTs || 0) > 0 && (thread.readTs || 0) >= (Number.isFinite(frame.ts) ? frame.ts : 0)) return;
    const isViewable = messageIsOnScreen(from);
    if (isViewable) {
      thread.unreadIds.set(id, Number.isFinite(frame.ts) ? frame.ts : Date.now());
      // Queued rather than fired straight at the socket: this read is as real
      // as any other, and a `sendFrame` that returns false would have lost it
      // while the badge below had already been cleared.
      queueReadReceipts(from, [id]);
      return;
    }
    thread.unreadIds.set(id, Number.isFinite(frame.ts) ? frame.ts : Date.now());
    ensureUnreadDivider(thread, thread.node.lastElementChild);
    if (!known) {
      thread.unread += 1;
      renderRoster();
      updateAppUnreadBadge();
    }
    return;
  }

  const thread = threadFor(from);
  const isAi = frame.t === 'ai';
  const text = typeof frame.text === 'string' ? frame.text : '';
  const liveImage = mediaSource(from, frame.id, frame.image, 'image');
  if (text === '' && !liveImage) return;
  const id = typeof frame.id === 'string' ? frame.id : null;
  const ts = Number.isFinite(frame.ts) ? frame.ts : Date.now();
  const release = from === OFFICIAL_ACCOUNT_LOGIN && String(id || '').startsWith('release-');

  const known = id ? thread.seen.has(id) : false;
  const author = isAi
    ? (typeof frame.name === 'string' && frame.name !== '' ? frame.name : 'tailik')
    : (isSelf ? (self.name || self.login) : authorLabelFor(from, frame.name));

  appendMessage(thread, {
    id,
    own: isAi ? false : isSelf,
    kind: isAi ? 'ai' : 'human',
    author,
    text,
    image: liveImage,
    reactions: frame.reactions,
    replyTo: frame.replyTo,
    forwardedFrom: frame.forwardedFrom,
    ts,
    buttons: frame.buttons,
  });

  if (!isSelf) {
    notifyReceivedSound(from, { force: release });
    if (release) offerWebUpdate();
    showWebNotification({
      title: isAi ? `${author} (Tailchat)` : `${displayName(from)} (Tailchat)`,
      body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      tag: `tailchat-msg-${from}`,
      peer: from,
    });
  }

  if (from === activePeer) {
    hideTyping();
    scrollToLatest(isSelf);
  }

  if (isAi || !id || isSelf) return;
  // Addressed, not subscription-bound: the message arrives on every socket of
  // this account whichever conversation is open, and an `ack` dropped because
  // another one was open left the author on ✓ until this side opened the
  // conversation — the delivered rung never happened.
  sendMessageFrame(from, { t: 'ack', id });
  if ((thread.readTs || 0) >= ts) return;
  // `document.hasFocus()` is false in an installed PWA far more often than the
  // conversation is actually unattended (any system chrome, the keyboard, a
  // notification shade steals it), and a message the person is looking at
  // right now must not stay unread. Being on screen means: this peer's thread,
  // a visible tab, the talk pane on a phone — and the newest rows actually in
  // view, which is what `messageIsOnScreen` adds.
  const isViewable = from !== OFFICIAL_ACCOUNT_LOGIN && messageIsOnScreen(from);
  if (isViewable) {
    thread.unreadIds.set(id, ts);
    // Same as the voice path above: the queue owns the receipt, and it is this
    // device's only chance to tell the other side the message was read.
    queueReadReceipts(from, [id]);
    return;
  }
  thread.unreadIds.set(id, ts);
  ensureUnreadDivider(thread, thread.node.lastElementChild);
  if (!known) {
    thread.unread += 1;
    renderRoster();
    updateAppUnreadBadge();
  }
}

// A read receipt is a watermark, not a statement about one bubble: nobody can
// read the newest message without having read everything above it. Receipts
// also get lost — the paced queue drops what it cannot deliver, a socket swap
// eats the rest — which used to leave a run of older messages stuck on ✓
// underneath a newer ✓✓ until the page was reloaded (the reload path already
// used the server's `peerReadTs` watermark, which is what made the mismatch
// look like a phantom).
function applyReceipt(from, frame) {
  if (typeof frame.id !== 'string') return;
  const thread = threads.get(from);
  const mark = thread?.marks.get(frame.id);
  // Set by the hub on the way through (`markDelivered`'s watermark), so it is
  // the same number `/api/history` would send after a reload. An older server
  // sends none, and then only the named frame itself is taken below.
  const deliveredTs = Number.isFinite(frame.deliveredTs) && frame.deliveredTs > 0 ? frame.deliveredTs : 0;
  if (thread && frame.t === 'read' && Number.isFinite(frame.readTs) && frame.readTs > 0) {
    applyPeerReadWatermark(from, frame.readTs, frame.readAt, frame.via);
    applyPeerDeliveredWatermark(thread, Math.max(frame.readTs, deliveredTs));
    return;
  }
  if (!mark) {
    // No rendered bubble for this id — a background thread never opened, or
    // a roster preview with no transcript behind it yet. Still worth taking
    // the watermark when it names the roster's own current preview, so a
    // message read while its thread was never opened still shows ✓✓ there.
    if (thread) {
      if (frame.t === 'read' && thread.lastMessage?.id === frame.id
        && thread.lastMessage.ts > thread.peerReadTs) {
        thread.peerReadTs = thread.lastMessage.ts;
        thread.peerReadVia = typeof frame.via === 'string' ? frame.via : '';
        scheduleRosterRender();
      }
      applyPeerDeliveredWatermark(thread, deliveredTs);
    }
    return;
  }
  if (frame.t !== 'read') {
    // Their device holds this one: the delivered rung, drawn as ✓✓ in the
    // line's own neutral colour — only a *read* is the peer's claim about
    // reading, and only that takes the accent. The frame names one message but
    // the number it carries is a watermark over the whole run below it, which
    // is what heals the receipts a socket swap ate.
    if (mark.dataset.state !== 'read') setMark(mark, 'ack');
    applyPeerDeliveredWatermark(thread, deliveredTs);
    return;
  }
  const upTo = Number(mark.dataset.ts) || 0;
  for (const other of thread.marks.values()) {
    // The named message itself was read, so the server had it whatever its
    // mark said; the rest of the run only if committed (`markCommitted`).
    if ((Number(other.dataset.ts) || 0) <= upTo && (other === mark || markCommitted(other))) {
      setMark(other, 'read', frame.readAt, frame.via);
    }
  }
  if (upTo > thread.peerReadTs) {
    thread.peerReadTs = upTo;
    thread.peerReadAt = Number.isFinite(frame.readAt) ? frame.readAt : 0;
    thread.peerReadVia = typeof frame.via === 'string' ? frame.via : '';
    scheduleRosterRender();
  }
  // Reading implies delivery — the rule the server's own `deliveredTs` follows
  // (`markRead` raises the delivered watermark too) — so a read advance carries
  // the delivered one up to the same place instead of leaving the thread's two
  // watermarks describing different points in the conversation.
  applyPeerDeliveredWatermark(thread, Math.max(upTo, deliveredTs));
}

// A peer's socket dies every time their phone locks or hops Wi-Fi→LTE, and it
// is back within a second or two. That blip never reaches this client: «away»
// is held where it is decided (`PRESENCE_GRACE_MS` in `src/cloud/hub.js`), so
// what arrives in a `presence` frame or a roster is a verdict, and holding it
// again here would only make the roster and the conversation header disagree
// about the same person by the length of the hold.
function paintPresence(login, online, lastSeen, state) {
  const user = users.find((u) => u.login === login);
  if (!user) return;
  user.online = online;
  if (typeof state === 'string') user.state = state;
  if (Number.isFinite(lastSeen)) user.lastSeen = lastSeen;
  else if (!online) user.lastSeen = Date.now();
  users.sort(compareUsers);
  renderRoster();
  if (login === activePeer) {
    updatePeerHeader();
    renderInfoPanel();
  }
}

function subscribeActivePeer(force = false) {
  if (!authed || !activePeer) return;
  if (!force && subscribedPeer === activePeer) return;
  sendEnvelope({ k: 'subscribe', peer: activePeer });
}

// Resolves once the server acks a subscription to `peer` (or immediately if
// it already has), so a send that must land right after switching peers —
// forwarding to someone who isn't the open conversation — doesn't race the
// ack. Bounded: a peer that never confirms (offline hub, dropped socket)
// must not hang the caller forever.
function waitForSubscription(peer, timeoutMs = 4000) {
  if (subscribedPeer === peer) return Promise.resolve(true);
  return new Promise((resolve) => {
    let waiters = subscriptionWaiters.get(peer);
    if (!waiters) {
      waiters = new Set();
      subscriptionWaiters.set(peer, waiters);
    }
    const settle = (ok) => {
      waiters.delete(settle);
      if (waiters.size === 0) subscriptionWaiters.delete(peer);
      resolve(ok);
    };
    waiters.add(settle);
    setTimeout(() => settle(false), timeoutMs);
  });
}

// The hub disconnects a client that sends more than 60 frames in a second, and
// opening a conversation with a hundred queued messages used to send a hundred
// read receipts in one go. The client reconnected, drained the same queue,
// marked the same messages read and was cut off again — a loop the terminal saw
// as an endless run of «connected to roman (web)». Receipts are paced instead:
// they are bookkeeping, and nothing about them needs to be instant.
const READ_RECEIPT_BURST = 15;
const READ_RECEIPT_INTERVAL_MS = 400;
const readReceiptQueue = [];
let readReceiptTimer = null;

function appIsForeground() {
  return document.visibilityState === 'visible'
    && typeof document.hasFocus === 'function'
    && document.hasFocus();
}

function pumpReadReceipts() {
  let sent = 0;
  const now = Date.now();
  for (let at = 0; at < readReceiptQueue.length && sent < READ_RECEIPT_BURST;) {
    const next = readReceiptQueue[at];
    if (next.sentAt && now - next.sentAt < 3000) {
      at += 1;
      continue;
    }
    const written = next.id === null
      ? sendEnvelope({ k: 'mark-read', peer: next.peer })
      : sendFrame(next.peer, { t: 'read', id: next.id });
    if (!written) {
      at += 1;
      continue;
    }
    sent += 1;
    if (serverCaps.has('read-ack-v1')) {
      next.sentAt = now;
      at += 1;
    } else {
      settleReadReceipt(next);
      readReceiptQueue.splice(at, 1);
    }
  }
  if (readReceiptQueue.length > 0) return;
  clearInterval(readReceiptTimer);
  readReceiptTimer = null;
}

// Older servers do not acknowledge reads. Only that negotiated fallback
// settles on socket write; capable servers settle via read-accepted/read-sync.
function settleReadReceipt(entry) {
  const thread = threads.get(entry.peer);
  if (!thread) return;
  const upTo = Number.isFinite(entry.ts) ? entry.ts : 0;
  if (upTo > (thread.readTs || 0)) thread.readTs = upTo;
  let covered = entry.id === null;
  for (const [id, ts] of thread.unreadIds) {
    if (entry.id === null || id === entry.id || (upTo > 0 && Number.isFinite(ts) && ts <= upTo)) {
      thread.unreadIds.delete(id);
      covered = true;
    }
  }
  // A receipt with no covered incoming rows cannot clear a newer badge.
  if (!covered || thread.unreadIds.size > 0) return;
  clearUnreadDivider(thread);
  thread.unread = 0;
  if (entry.id === null) {
    thread.reactionEvents?.clear();
    paintReactionEvents(thread);
  }
  renderRoster();
  updateAppUnreadBadge();
}

// Everything that has to be true before an arriving message may be called
// read without anybody having looked at it.
function messageIsOnScreen(from) {
  if (from !== activePeer || !appIsForeground()) return false;
  if (!wide.matches && elements.app.dataset.pane !== 'talk') return false;
  return transcriptAtBottom();
}

function queueReadReceipts(peer, ids) {
  const thread = threads.get(peer);
  for (const id of ids) {
    // The same read can be offered twice before its receipt has gone out — a
    // second `focus`, a scroll back to the bottom, the reconnect hook — and the
    // id deliberately stays in `thread.unreadIds` until the frame is taken, so
    // the queue has to recognise what it already holds instead of saying it
    // twice. The message's own time rides along: it is what `settleReadReceipt`
    // compares against when the receipt finally lands.
    if (readReceiptQueue.some((entry) => entry.peer === peer && entry.id === id)) continue;
    readReceiptQueue.push({ peer, id, ts: Number(thread?.unreadIds.get(id)) || 0 });
  }
  if (readReceiptQueue.length === 0) return;
  // The first batch goes immediately — a handful of receipts is the common
  // case and waiting out a tick for those would be pure latency.
  pumpReadReceipts();
  if (readReceiptQueue.length > 0 && !readReceiptTimer) {
    readReceiptTimer = setInterval(pumpReadReceipts, READ_RECEIPT_INTERVAL_MS);
  }
}

// `store.markRead` on the server keeps a per-conversation timestamp watermark
// that never moves backwards, so one frame for the newest unread message says
// exactly what one frame per unread message said — minus the burst that used
// to trip the hub's 60-frames-a-second cut-off and lose receipts with it.
function newestUnreadId(thread) {
  let newest = null;
  let newestTs = -1;
  for (const [id, ts] of thread.unreadIds) {
    const at = Number.isFinite(ts) ? ts : 0;
    if (at >= newestTs) {
      newestTs = at;
      newest = id;
    }
  }
  return newest;
}

// Whether the newest rows are actually on screen. A message that arrived
// while the person was reading further up was being marked read the instant
// it landed — no roster badge, no divider, nothing left to come back to, so
// it read as «иногда я не вижу новые сообщения и они теряются». Anything
// below the fold stays unread until the transcript is scrolled down to it.
const AT_BOTTOM_SLACK_PX = 90;

function transcriptAtBottom() {
  const container = elements.transcript;
  if (!container) return true;
  return container.scrollHeight - container.clientHeight - container.scrollTop < AT_BOTTOM_SLACK_PX;
}

function flushReadReceipts() {
  if (!activePeer || !appIsForeground()) return;
  // Release announcements must first surface as unread and raise the official
  // account in the roster. They are cleared only by an explicit roster click.
  if (activePeer === OFFICIAL_ACCOUNT_LOGIN) return;
  if (!wide.matches && elements.app.dataset.pane !== 'talk') return;
  if (!transcriptAtBottom()) return;
  clearUnread(activePeer);
  // The queue retains unread state until acceptance; clearUnread only picks
  // a rendered incoming row, so history catch-up cannot read an unseen tail.
}

window.addEventListener('focus', flushReadReceipts);
document.addEventListener('visibilitychange', flushReadReceipts);

function reportTyping() {
  if (!activePeer || !authed || !typingEnabled) return;
  const now = Date.now();
  if (now - typingSentAt >= TYPING_REPEAT_MS) {
    typingSentAt = now;
    sendFrame(activePeer, { t: 'typing', state: 'start' });
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(() => stopTyping(), TYPING_IDLE_MS);
}

function stopTyping() {
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  if (!activePeer || !authed || typingSentAt === 0) return;
  typingSentAt = 0;
  sendFrame(activePeer, { t: 'typing', state: 'stop' });
}

function onVisibilityChange() {
  // Coming back to the tab is not the same as having seen what arrived: the
  // held receipts go out through the same gate as everywhere else, which
  // refuses while the transcript is scrolled away from the newest rows.
  if (document.hidden) stopTyping();
  else {
    flushReadReceipts();
    // Permission can be granted or revoked in the browser's own settings while
    // this tab is in the background; the row that describes it is redrawn on
    // the way back so «разрешить уведомления» stops being claimed, or starts
    // being claimed, the moment it is true.
    updateNotifyBtn();
  }
}

function clearUnread(peer) {
  if (!messageIsOnScreen(peer)) return;
  const thread = threads.get(peer);
  if (!thread) return;
  let newest = newestUnreadId(thread);
  if (!newest && thread.unread > 0) {
    // History may be the only copy in this tab. Receipt the newest *rendered*
    // incoming row, never the server's unseen tail through bulk mark-read.
    const rows = thread.node.querySelectorAll('[data-id][data-side="peer"]');
    const row = rows[rows.length - 1];
    if (row) {
      newest = row.dataset.id;
      thread.unreadIds.set(newest, Number(row.dataset.ts) || 0);
    }
  }
  if (newest) queueReadReceipts(peer, [newest]);
  renderInfoPanel();
}

// Explicit «отметить прочитанным» deliberately includes the server's unseen
// tail. Automatic viewing only receipts rendered incoming rows.
function markConversationRead(peer) {
  if (typeof peer !== 'string' || peer === '') return;
  queueReadReceipts(peer, [null]);
}

function markConversationUnread(peer) {
  if (typeof peer !== 'string' || peer === '') return;
  if (!sendEnvelope({ k: 'mark-unread', peer })) return;
  const thread = threadFor(peer);
  thread.unread = Math.max(1, thread.unread);
  renderRoster();
  updateAppUnreadBadge();
}

function applySyncedRead(peer, readTs = 0) {
  if (typeof peer !== 'string' || !Number.isFinite(readTs) || readTs <= 0) return;
  const thread = threadFor(peer);
  thread.readTs = Math.max(thread.readTs || 0, readTs);
  let removed = 0;
  for (const [id, ts] of thread.unreadIds) {
    if (ts <= thread.readTs) {
      thread.unreadIds.delete(id);
      removed += 1;
    }
  }
  for (let at = readReceiptQueue.length - 1; at >= 0; at -= 1) {
    const entry = readReceiptQueue[at];
    if (entry.peer === peer && entry.id !== null && entry.ts > 0 && entry.ts <= thread.readTs) {
      readReceiptQueue.splice(at, 1);
    }
  }
  const user = users.find((item) => item.login === peer);
  const preview = thread.lastMessage || user?.last;
  const newerIncoming = preview?.from === peer && preview.ts > thread.readTs;
  thread.unread = thread.unreadIds.size > 0 || newerIncoming
    ? Math.max(thread.unreadIds.size, thread.unread - removed) : 0;
  if (thread.unread === 0) {
    thread.reactionEvents?.clear();
    clearUnreadDivider(thread);
    paintReactionEvents(thread);
  }
  if (user) user.pending = thread.unread;
  users.sort(compareUsers);
  renderRoster();
  updateAppUnreadBadge();
  renderInfoPanel();
}

const peerTypingVoices = new Set();
let aiTypingVoice = null;
let sendingFileLabel = null;

function renderTypingIndicator() {
  const labels = [];
  for (const v of peerTypingVoices) {
    labels.push(displayName(v));
  }
  if (aiTypingVoice) labels.push(aiTypingVoice);

  let text;
  let nowHidden;
  if (sendingFileLabel) {
    text = `sending ${sendingFileLabel}`;
    nowHidden = false;
  } else if (labels.length === 0) {
    text = '';
    nowHidden = true;
  } else {
    text = `${[...new Set(labels)].join(' + ')} typing`;
    nowHidden = false;
  }

  elements.typing.textContent = text;
  const wasHidden = elements.typingBar ? elements.typingBar.hidden : true;
  if (elements.typingBar) elements.typingBar.hidden = nowHidden;
  // The bar is a flex sibling of `.transcript`, not an overlay — showing or
  // hiding it resizes the transcript itself. A reader already pinned to the
  // bottom must stay pinned, or the newest lines slide out from under the
  // bar that just appeared with no visual cue anything moved — the "screen
  // doesn't follow when the other side is typing" report.
  if (wasHidden !== nowHidden) pinToTailOnLayoutShift();
}

// `voice` is the optional name on the frame: a terminal composing an AI answer
// announces it under the model's name rather than the person's, so the reader
// can tell «roman печатает» from «tailik печатает». `aiTypingVoice` has been
// rendered all along — nothing ever set it, because this argument was being
// dropped on the floor here.
function showTyping(peer, start = true, voice = null) {
  if (peer !== activePeer) return;
  const named = typeof voice === 'string' && voice !== '' ? voice : null;
  const asAi = named !== null && named !== displayName(peer);

  if (!start) {
    if (asAi) aiTypingVoice = null;
    else peerTypingVoices.delete(peer);
  } else {
    if (asAi) aiTypingVoice = named;
    else peerTypingVoices.add(peer);
    clearTimeout(typingExpireTimer);
    // One timer for both: a client that goes away mid-sentence owes us no stop
    // frame, and an indicator left running forever is worse than one that
    // gives up a little early.
    typingExpireTimer = setTimeout(() => {
      peerTypingVoices.delete(peer);
      aiTypingVoice = null;
      renderTypingIndicator();
    }, TYPING_EXPIRE_MS);
  }
  renderTypingIndicator();
}

function hideTyping() {
  clearTimeout(typingExpireTimer);
  typingExpireTimer = null;
  peerTypingVoices.clear();
  aiTypingVoice = null;
  sendingFileLabel = null;
  renderTypingIndicator();
}

// A relay link that blips for a few hundred milliseconds is not something the
// reader needs to watch happen. Coming back online paints immediately — good
// news is never worth delaying — but a drop has to persist before the badge
// admits it, so an ordinary reconnect passes without the indicator flashing.
const CONNECTION_BLIP_MS = 1200;
let connectionDowngradeTimer = null;
// Tracked here rather than read back off a DOM dataset attribute: the only
// place connection state used to live in the DOM was the footer indicator,
// now removed in favour of the compact dot next to the username in the
// roster, which is not always on screen (the roster itself is hidden on a
// phone mid-chat) to read state back from reliably.
let lastPaintedConnectionState = 'offline';

function paintConnection(state, label) {
  lastPaintedConnectionState = state;
  // Two indicators, one source: the roster header's line on a phone, the rail
  // avatar on a desktop window. Painting both keeps the one that is on screen
  // correct without anyone having to know which layout is active.
  for (const dot of [elements.selfConnectionDot, elements.railSelfDot]) {
    if (!dot) continue;
    dot.dataset.state = state;
    // aria-hidden stays on: this is now the only place the status shows, but
    // it is a secondary, glanceable indicator rather than vital information —
    // the composer, the send button and every actual failure already say
    // "offline" in words where it matters. A title still gives a mouse/
    // trackpad user something on hover.
    dot.title = label;
  }
}

function setConnection(state, label) {
  clearTimeout(connectionDowngradeTimer);
  connectionDowngradeTimer = null;
  if (state === 'online') {
    paintConnection(state, label);
    return;
  }
  // Already showing something other than online: the reader has seen the bad
  // news, and refining it costs no extra flicker.
  if (lastPaintedConnectionState !== 'online') {
    paintConnection(state, label);
    return;
  }
  connectionDowngradeTimer = setTimeout(() => {
    connectionDowngradeTimer = null;
    paintConnection(state, label);
  }, CONNECTION_BLIP_MS);
}

function sendEnvelope(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

// A frame bound for a peer we hold an open WebRTC data channel to skips the
// cloud relay entirely — the point of "direct" is that the server never
// sees the content. Two exceptions have to ride the relay instead:
//
//  * signaling frames (rtc-*), because they're what negotiates the channel
//    that would otherwise carry them;
//  * receipts (`read`, `ack`), because the server is not a bystander to them
//    but the one that keeps the watermark: it is where the other side's *other*
//    devices, and its own `/api/history`, learn that a message was received or
//    read. Privacy is about content, and a receipt carries none — but one sent
//    down a direct channel leaves the peer's phone and laptop showing ✓ forever
//    while the device that read the message sits right next to them. The two
//    clients may still talk peer-to-peer about everything else.
const RELAY_ONLY_FRAMES = new Set(['read', 'ack']);

function sendFrame(to, frame) {
  const link = directLinks.get(to);
  // On the core a message or an edit that reaches this function is one the core
  // did not carry: it must go through the server like every other, not out of
  // band, where nothing the core keeps — the store, the encryption — sees it.
  const coreContent = Boolean(coreSession) && (frame.t === 'msg' || frame.t === 'edit');
  const relayOnly = RELAY_ONLY_FRAMES.has(frame.t) || String(frame.t).startsWith('rtc-') || coreContent;
  if (link?.dc?.readyState === 'open' && !relayOnly) {
    try {
      link.dc.send(JSON.stringify(frame));
      return true;
    } catch {
      // Fall through to the relay — a send failure on a channel that still
      // reports "open" is rare but not impossible, and the message matters
      // more than the transport that carries it.
    }
  }
  if (!authed || subscribedPeer !== to) return false;
  return sendEnvelope({ k: 'frame', to, d: frame });
}

// Same as `sendFrame`, but for a caller that just switched the active peer
// (forwarding a message to someone who isn't the open conversation): the
// first attempt can lose the race against the `subscribed` ack, so one
// retry is given after that ack actually lands instead of failing silently.
async function sendFrameReliably(to, frame) {
  if (sendFrame(to, frame)) return true;
  if (!(await waitForSubscription(to))) return false;
  return sendFrame(to, frame);
}

// A message — and the `ack` for one received — rather than any frame at all,
// may be addressed to a conversation this socket is not currently subscribed
// to: one socket can only hold one subscription, and neither the durable send
// queue nor a delivery receipt for a background conversation may have to
// borrow it. Only a
// server that announced `addressed-send` accepts that (`relay` in
// `src/cloud/hub.js` checks the same capability before it allows a target other
// than the subscription), so the fallback refuses on anything older rather than
// sending a frame the server will answer with `not_subscribed`.
//
// The peer must still be a contact: the roster is the friend list, and the
// server checks the same thing from its own side.
function sendMessageFrame(to, frame) {
  if (sendFrame(to, frame)) return true;
  if (!authed || !serverCaps.has('addressed-send')) return false;
  if (to !== self?.login && !users.some((user) => user.login === to)) return false;
  return sendEnvelope({ k: 'frame', to, d: frame });
}

// --- Direct P2P (WebRTC) ---------------------------------------------------
//
// Opportunistic upgrade, never a requirement: the cloud relay above is the
// baseline every account gets, and this only replaces it for one
// conversation once both sides are online and a peer-to-peer path exists.
// STUN only, no TURN — it connects when the NAT allows a direct path and
// falls back to the relay when it doesn't, exactly like the terminal
// client's "P2P first, cloud fallback" per docs/archive/local+cloud.md.

const directLinks = new Map(); // login -> { pc, dc, state }
const pendingIceCandidates = new Map(); // login -> candidates queued before a remote description lands

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

function ensureDirectLink(login) {
  let link = directLinks.get(login);
  if (!link) {
    link = { pc: null, dc: null, state: 'idle' };
    directLinks.set(login, link);
  }
  return link;
}

function directState(login) {
  return directLinks.get(login)?.state || 'idle';
}

function setDirectState(login, state) {
  ensureDirectLink(login).state = state;
  if (login === activePeer) updateDirectUi();
}

function teardownDirect(login, finalState = 'idle') {
  const link = directLinks.get(login);
  pendingIceCandidates.delete(login);
  if (!link) {
    if (login === activePeer) updateDirectUi();
    return;
  }
  try { link.dc?.close(); } catch {}
  try { link.pc?.close(); } catch {}
  directLinks.delete(login);
  if (finalState === 'idle') {
    if (login === activePeer) updateDirectUi();
  } else {
    setDirectState(login, finalState);
  }
}

async function flushPendingIce(login, pc) {
  const queued = pendingIceCandidates.get(login);
  if (!queued) return;
  pendingIceCandidates.delete(login);
  for (const candidate of queued) {
    try { await pc.addIceCandidate(candidate); } catch {}
  }
}

function attachDataChannel(login, link, dc) {
  link.dc = dc;
  dc.onopen = () => setDirectState(login, 'connected');
  dc.onclose = () => { if (directLinks.get(login) === link) teardownDirect(login); };
  dc.onerror = () => { if (directLinks.get(login) === link) teardownDirect(login, 'failed'); };
  // A direct frame is handled exactly like a relayed one — same render path,
  // same receipts, same image/voice decoding — so nothing downstream needs
  // to know which transport a message arrived on.
  dc.onmessage = (event) => {
    try {
      handleFrame(login, JSON.parse(event.data), false);
    } catch {}
  };
}

function createDirectPeerConnection(login) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pc.onicecandidate = (event) => {
    if (event.candidate) sendFrame(login, { t: 'rtc-ice', candidate: event.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      teardownDirect(login, pc.connectionState === 'failed' ? 'failed' : 'idle');
    }
  };
  pc.ondatachannel = (event) => {
    const link = ensureDirectLink(login);
    link.pc = pc;
    attachDataChannel(login, link, event.channel);
  };
  return pc;
}

// Both sides can click "Direct" at once; a fixed, deterministic tiebreaker
// (the lower login offers) means exactly one offer survives instead of the
// two colliding.
function isDirectInitiator(login) {
  return Boolean(self) && self.login < login;
}

async function startDirectLink(login) {
  if (!self || !login) return;
  const state = directState(login);
  if (state === 'connecting' || state === 'connected') return;
  setDirectState(login, 'connecting');
  const link = ensureDirectLink(login);
  const pc = createDirectPeerConnection(login);
  link.pc = pc;
  if (isDirectInitiator(login)) {
    const dc = pc.createDataChannel('tailchat');
    attachDataChannel(login, link, dc);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendFrame(login, { t: 'rtc-offer', sdp: pc.localDescription.sdp });
    } catch {
      teardownDirect(login, 'failed');
    }
  } else {
    // We're the answerer role, but the initiator has no reason yet to know
    // we want a channel — nudge them so their side actually sends the offer.
    sendFrame(login, { t: 'rtc-request' });
  }
}


async function handleRtcFrame(from, frame) {
  if (!self || !from) return;
  if (frame.t === 'rtc-request') {
    if (isDirectInitiator(from) && directState(from) !== 'connecting' && directState(from) !== 'connected') {
      startDirectLink(from);
    }
  } else if (frame.t === 'rtc-offer') {
    if (isDirectInitiator(from) && directState(from) === 'connecting') {
      // Glare: we already sent our own offer and the tiebreaker says ours
      // should win, so this incoming one is dropped rather than answered.
      return;
    }
    const link = ensureDirectLink(from);
    if (!link.pc || directState(from) !== 'connecting') {
      teardownDirect(from);
      link.pc = createDirectPeerConnection(from);
      setDirectState(from, 'connecting');
    }
    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp: frame.sdp });
      await flushPendingIce(from, link.pc);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      sendFrame(from, { t: 'rtc-answer', sdp: link.pc.localDescription.sdp });
    } catch {
      teardownDirect(from, 'failed');
    }
  } else if (frame.t === 'rtc-answer') {
    const link = directLinks.get(from);
    if (!link?.pc) return;
    try {
      await link.pc.setRemoteDescription({ type: 'answer', sdp: frame.sdp });
      await flushPendingIce(from, link.pc);
    } catch {
      teardownDirect(from, 'failed');
    }
  } else if (frame.t === 'rtc-ice') {
    const link = directLinks.get(from);
    if (link?.pc?.remoteDescription) {
      try { await link.pc.addIceCandidate(frame.candidate); } catch {}
    } else {
      const queued = pendingIceCandidates.get(from) || [];
      queued.push(frame.candidate);
      pendingIceCandidates.set(from, queued);
    }
  }
}

function updateDirectUi() {
  const btn = elements.directBtn;
  if (!btn) return;
  const user = activePeer ? users.find((u) => u.login === activePeer) : null;
  const isSelfChat = Boolean(self) && activePeer === self.login;
  const supported = typeof RTCPeerConnection === 'function';
  const eligible = Boolean(activePeer) && !isSelfChat && supported;
  const state = eligible ? directState(activePeer) : 'idle';
  btn.dataset.state = state;
  btn.disabled = !eligible || (!user?.online && state === 'idle');
  btn.title = state === 'connected' ? t('directOnTitle')
    : state === 'connecting' ? t('directConnectingTitle')
    : state === 'failed' ? t('directFailedTitle')
    : t('directOffTitle');
  btn.setAttribute('aria-label', btn.title);
  renderInfoPanel();
}

function toggleDirectLink() {
  if (!activePeer) return;
  const state = directState(activePeer);
  if (state === 'connected' || state === 'connecting') {
    teardownDirect(activePeer);
  } else {
    startDirectLink(activePeer);
  }
}


// --- HTTP API ------------------------------------------------------------

async function request(method, path, body, bearer = token) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response = null;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw { code: 'network' };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw { code: data?.error || data?.code || 'unknown_action', status: response.status };
  }
  return data;
}

// --- Инвайты ------------------------------------------------------------

// The deployment's own bound on both passwords (`PASSWORD_MAX` in
// `src/cloud/accounts.js`). Checked here as well as there so the answer is
// immediate and the same in both fields, and so a test can pin the boundary
// without a server.
const PASSWORD_MAX_CHARS = 200;

function syncProfileExtraPasswordRows() {
  const checked = Boolean(elements.profileExtraPasswordEnabled?.checked);
  if (elements.profileExtraPasswordRow) elements.profileExtraPasswordRow.hidden = !checked;
  if (elements.profileExtraPasswordConfirmRow) elements.profileExtraPasswordConfirmRow.hidden = !checked;
  if (!checked) {
    if (elements.profileExtraPassword) elements.profileExtraPassword.value = '';
    if (elements.profileExtraPasswordConfirm) elements.profileExtraPasswordConfirm.value = '';
  }
}

function openProfileDialog() {
  if (!self || !elements.profileDialog) return;
  elements.profileLogin.value = self.login;
  elements.profileName.value = self.name || self.login;
  elements.profileCurrentPassword.value = '';
  elements.profileNewPassword.value = '';
  elements.profileConfirmPassword.value = '';
  if (elements.profileExtraPasswordEnabled) {
    elements.profileExtraPasswordEnabled.checked = Boolean(self.extraPasswordEnabled);
  }
  syncProfileExtraPasswordRows();
  elements.profileStatus.textContent = '';
  elements.profileStatus.dataset.kind = '';
  elements.profileSaveButton.disabled = false;
  elements.profileDialog.showModal();
  elements.profileName.focus();
}

function closeProfileDialog() {
  elements.profileDialog?.close();
}

async function onProfileSubmit(event) {
  event.preventDefault();
  if (!self || elements.profileSaveButton.disabled) return;
  const name = elements.profileName.value.trim();
  const currentPassword = elements.profileCurrentPassword.value;
  const newPassword = elements.profileNewPassword.value;
  const confirmPassword = elements.profileConfirmPassword.value;
  const extraEnabledNow = Boolean(self.extraPasswordEnabled);
  const extraChecked = Boolean(elements.profileExtraPasswordEnabled?.checked);
  const extraPassword = elements.profileExtraPassword ? elements.profileExtraPassword.value : '';
  const extraPasswordConfirm = elements.profileExtraPasswordConfirm ? elements.profileExtraPasswordConfirm.value : '';

  if (!name) {
    elements.profileStatus.dataset.kind = 'error';
    elements.profileStatus.textContent = errorText('invalid_name');
    elements.profileName.focus();
    return;
  }
  // The two password changes are independent operations that happen to share
  // one proof: `currentPassword` authorizes whichever of them is asked for, and
  // needing it is not the same as changing it. Deriving "the primary password is
  // changing" from the *current* field — which is what this used to do — meant
  // that typing the current primary password in order to set or clear the
  // additional one was read as a request to change the primary password to
  // nothing, and the form refused locally with `invalid_password` before the
  // server ever heard about the additional one. Only the new fields say what is
  // being changed.
  const changingMainPassword = Boolean(newPassword || confirmPassword);
  if (changingMainPassword && (!currentPassword || !newPassword || newPassword !== confirmPassword)) {
    elements.profileStatus.dataset.kind = 'error';
    elements.profileStatus.textContent = newPassword !== confirmPassword
      ? errorText('password_mismatch')
      : errorText('invalid_password');
    return;
  }
  if (changingMainPassword && newPassword.length > PASSWORD_MAX_CHARS) {
    elements.profileStatus.dataset.kind = 'error';
    elements.profileStatus.textContent = errorText('invalid_password');
    return;
  }

  // Three states for the additional password: unchecked while it was on =
  // remove it; checked with nothing typed while it was already on = leave it
  // alone; checked with something typed, or checked while it was off = set
  // or replace it.
  let extraPasswordField; // undefined: no change to send
  if (!extraChecked && extraEnabledNow) {
    extraPasswordField = '';
  } else if (extraChecked && (extraPassword || extraPasswordConfirm || !extraEnabledNow)) {
    if (!extraPassword || extraPassword !== extraPasswordConfirm) {
      elements.profileStatus.dataset.kind = 'error';
      elements.profileStatus.textContent = extraPassword !== extraPasswordConfirm
        ? errorText('password_mismatch')
        : errorText('invalid_password');
      return;
    }
    // One character is a valid additional password — the deployment allows
    // 1–200 for both kinds, and a form that demanded more would be inventing a
    // rule the server does not have. Only the ceiling is worth refusing here,
    // because the server's answer to it is the same generic
    // `invalid_password` that would leave the person guessing which field was
    // too long.
    if (extraPassword.length > PASSWORD_MAX_CHARS) {
      elements.profileStatus.dataset.kind = 'error';
      elements.profileStatus.textContent = errorText('invalid_password');
      return;
    }
    extraPasswordField = extraPassword;
  }
  const changingExtraPassword = extraPasswordField !== undefined;
  if (changingExtraPassword && !currentPassword) {
    elements.profileStatus.dataset.kind = 'error';
    elements.profileStatus.textContent = errorText('bad_credentials');
    elements.profileCurrentPassword.focus();
    return;
  }

  elements.profileSaveButton.disabled = true;
  elements.profileSaveButton.textContent = t('profileSaving');
  elements.profileStatus.textContent = '';
  try {
    const body = { name };
    if (changingMainPassword || changingExtraPassword) {
      body.currentPassword = currentPassword;
    }
    if (changingMainPassword) {
      body.newPassword = newPassword;
    }
    if (changingExtraPassword) {
      body.extraPassword = extraPasswordField;
    }
    const data = await request('PATCH', '/profile', body);
    self = data.user;
    renderSelfIdentity();
    elements.profileName.value = self.name || self.login;
    elements.profileCurrentPassword.value = '';
    elements.profileNewPassword.value = '';
    elements.profileConfirmPassword.value = '';
    if (elements.profileExtraPasswordEnabled) {
      elements.profileExtraPasswordEnabled.checked = Boolean(self.extraPasswordEnabled);
    }
    syncProfileExtraPasswordRows();
    elements.profileStatus.dataset.kind = 'success';
    elements.profileStatus.textContent = t('profileSaved');
  } catch (error) {
    elements.profileStatus.dataset.kind = 'error';
    elements.profileStatus.textContent = errorText(error.code);
  } finally {
    elements.profileSaveButton.disabled = false;
    elements.profileSaveButton.textContent = t('profileSave');
  }
}

function openInviteDialog() {
  elements.myInviteInput.value = '';
  elements.myInviteStatus.textContent = '';
  elements.copyInviteButton.disabled = true;
  elements.acceptInviteForm.reset();
  elements.acceptInviteStatus.textContent = '';
  elements.friendRequestForm.reset();
  elements.friendRequestStatus.textContent = '';
  elements.inviteDialog.showModal();
}

function closeInviteDialog() {
  elements.inviteDialog.close();
}

function parseInviteCode(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  const match = /[?&]invite=([a-f0-9]{64})/i.exec(trimmed);
  if (match) return match[1].toLowerCase();
  const hexMatch = /^[a-f0-9]{64}$/i.exec(trimmed);
  if (hexMatch) return hexMatch[0].toLowerCase();
  return trimmed;
}

async function onGenerateInvite() {
  elements.myInviteStatus.textContent = t('creating');
  elements.generateInviteButton.disabled = true;
  try {
    const data = await request('POST', '/invite');
    const inviteUrl = `${location.origin}/tailchat/?invite=${data.invite}`;
    elements.myInviteInput.value = inviteUrl;
    elements.copyInviteButton.disabled = false;
    elements.myInviteStatus.textContent = t('createdNotice');
  } catch (err) {
    elements.myInviteStatus.textContent = errorText(err.code);
  } finally {
    elements.generateInviteButton.disabled = false;
  }
}

async function onCopyInvite() {
  const text = elements.myInviteInput.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    elements.myInviteStatus.textContent = t('copied');
  } catch {
    elements.myInviteStatus.textContent = t('copyManual');
  }
}

async function processPendingInvite(rawInput, isAuto = false) {
  const tokenCode = parseInviteCode(rawInput);
  if (!tokenCode) return false;

  if (elements.acceptInviteStatus) elements.acceptInviteStatus.textContent = t('checking');
  if (elements.acceptInviteButton) elements.acceptInviteButton.disabled = true;

  try {
    const data = await request('POST', '/invite/accept', { invite: tokenCode });
    const friendName = peerLabel(data.friend) || data.friend.login;
    if (elements.acceptInviteStatus) {
      elements.acceptInviteStatus.textContent = t('friendAdded', friendName);
    }
    if (elements.acceptInviteInput) elements.acceptInviteInput.value = '';
    await refreshRoster();
    if (data.friend.login) {
      await selectPeer(data.friend.login);
    }
    if (isAuto) {
      if (elements.inviteDialog?.open) {
        setTimeout(() => closeInviteDialog(), 1200);
      }
    } else {
      setTimeout(() => closeInviteDialog(), 1200);
    }
    return true;
  } catch (err) {
    if (elements.acceptInviteStatus) {
      elements.acceptInviteStatus.textContent = errorText(err.code);
    }
    if (isAuto) {
      openInviteDialog();
      if (elements.acceptInviteStatus) {
        elements.acceptInviteStatus.textContent = errorText(err.code);
      }
    }
    return false;
  } finally {
    if (elements.acceptInviteButton) elements.acceptInviteButton.disabled = false;
  }
}

async function checkPendingInvite() {
  let invite = '';
  try {
    const params = new URLSearchParams(location.search);
    const urlInvite = params.get('invite');
    if (urlInvite) {
      invite = urlInvite;
      params.delete('invite');
      const newSearch = params.toString();
      const newUrl = location.pathname + (newSearch ? `?${newSearch}` : '') + location.hash;
      history.replaceState(null, '', newUrl);
    }
  } catch {}

  if (!invite) {
    try {
      invite = sessionStorage.getItem('tc_invite') || '';
    } catch {}
  }

  if (!invite) return;

  if (token) {
    try {
      sessionStorage.removeItem('tc_invite');
    } catch {}
    await processPendingInvite(invite, true);
  } else {
    try {
      sessionStorage.setItem('tc_invite', invite);
    } catch {}
  }
}

async function onAcceptInviteSubmit(event) {
  event.preventDefault();
  const rawInput = elements.acceptInviteInput.value.trim();
  await processPendingInvite(rawInput, false);
}

// The server strips one leading `@` and lowercases the login itself, but the
// field is where people paste «@roman » with a stray space, and an empty
// request must never leave the browser.
function parseFriendLogin(input) {
  if (!input || typeof input !== 'string') return '';
  return input.trim().replace(/^@/, '').trim();
}

async function onFriendRequestSubmit(event) {
  event.preventDefault();
  const login = parseFriendLogin(elements.friendRequestInput.value);
  if (!login) return;

  elements.friendRequestStatus.textContent = t('friendRequestSending');
  elements.friendRequestButton.disabled = true;
  try {
    const data = await request('POST', '/friend/request', { login });
    elements.friendRequestInput.value = '';
    if (data.state === 'friends') {
      // The contact already exists server-side (mutual request, restored
      // contact), so the same roster catch-up an accepted invite does applies.
      elements.friendRequestStatus.textContent = t('friendInContacts', peerLabel(data.friend) || login);
      await refreshRoster();
      if (data.friend?.login) await selectPeer(data.friend.login);
      setTimeout(() => closeInviteDialog(), 1200);
      return;
    }
    elements.friendRequestStatus.textContent = t('friendRequested', OFFICIAL_ACCOUNT_LOGIN);
  } catch (err) {
    elements.friendRequestStatus.textContent = errorText(err.code);
  } finally {
    elements.friendRequestButton.disabled = false;
  }
}

// --- Утилиты -------------------------------------------------------------

function readToken() {
  try {
    let val = sessionStorage.getItem(TOKEN_KEY);
    if (!val) {
      // Migrate and purge legacy token from localStorage so the disk profile holds no credentials
      val = localStorage.getItem(TOKEN_KEY);
      if (val) {
        sessionStorage.setItem(TOKEN_KEY, val);
        localStorage.removeItem(TOKEN_KEY);
      }
    }
    return val;
  } catch {
    return null;
  }
}

function writeToken(val) {
  try {
    sessionStorage.setItem(TOKEN_KEY, val);
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// A peer's name, and only a peer's: this account's own private nickname for
// them wins over the name they chose for themselves and over their login. The
// server sends `alias` only to the account that set it (issue #28), so the
// peer never learns it and never sees it used for anyone else.
function peerLabel(user) {
  if (!user) return '';
  return user.alias || user.name || user.login || '';
}

function displayName(login) {
  if (self && login === self.login) return t('savedMessages');
  const found = users.find((u) => u.login === login);
  return found ? peerLabel(found) : login;
}

// What a message's bubble calls its author. A peer the roster knows is named the
// way the roster names them — the nickname this account gave them (issue #28)
// wins over the name the frame declares, exactly as it does in the roster and
// the conversation header, or one rename would leave three different names for
// one person on one screen. `declared` (the sender's own `frame.name`) is only
// worth anything for a peer the roster has never heard of, which is the case it
// was introduced for.
function authorLabelFor(login, declared) {
  // Membership, not "did the label change": a nickname that happens to equal the
  // login is still this account's name for that person, and letting the frame's
  // own `name` win over it would put a second name on the same screen.
  const found = users.find((u) => u.login === login);
  if (found) return peerLabel(found);
  return typeof declared === 'string' && declared !== '' ? declared : login;
}

function errorText(code) {
  const dict = I18N[currentLang]?.errors || I18N.ru.errors;
  return dict[code] || dict.unknown_action || 'Error';
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t('today');
  const y = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === y.toDateString()) return t('yesterday');
  return dayFormat.format(d);
}

// The roster's right-hand stamp, which is a *distance* rather than a clock: a
// conversation last touched three weeks ago has no useful time of day, and the
// row it sits on is one line. So it walks one ladder — the clock today,
// «вчера», the weekday while that is still a day somebody remembers, then a
// short date, with the year only once it is a different one.
function midnight(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function rosterTimeLabel(ts, now) {
  const d = new Date(ts);
  if (d.toDateString() === now.toDateString()) return timeFormat.format(d);
  const y = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === y.toDateString()) return t('yesterday');
  // Whole local days, so a DST shift inside the span cannot turn two days into
  // one and move the label a rung early.
  const days = Math.round((midnight(now) - midnight(d)) / 86400_000);
  if (days < 7) return weekdayFormat.format(d);
  const day = dayShortFormat.format(d);
  return d.getFullYear() === now.getFullYear()
    ? day
    : `${day} '${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

function humanLastSeen(lastSeen) {
  if (!Number.isFinite(lastSeen) || lastSeen <= 0) return t('lastSeenLongAgo');
  const delta = Math.max(0, Date.now() - lastSeen);
  const m = Math.round(delta / 60_000);
  if (m < 1) return t('lastSeenJustNow');
  if (m < 60) return t('lastSeenMinutes', m);
  const h = Math.round(m / 60);
  if (h < 24) return t('lastSeenHours', h);
  const d = Math.round(h / 24);
  return t('lastSeenDays', d);
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Progressive Web App (PWA) Install Support ---------------------------

let deferredInstallPrompt = null;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// An unauthenticated tab has no active chat, drafts or live socket to lose:
// reloading it immediately on controllerchange guarantees the user always sees
// the latest deployment without needing manual Shift+F5 hard refreshes.
// An active user session must never be forcibly reloaded out from under the user.
function shouldAutoReloadForUpdate(hadControllerAtLoad, isAuthed) {
  return Boolean(hadControllerAtLoad && !isAuthed);
}

function setupPwa() {
  if ('serviceWorker' in navigator) {
    // `sw.js` calls `skipWaiting()` on install and `clients.claim()` on
    // activate, so a new deploy swaps the controller for every open tab
    // without waiting for a manual reload — `controllerchange` is that
    // swap. A controller already existing when this script first ran means
    // this page was already being served by a previous version; the
    // *first* `controllerchange` a tab ever sees (fresh install, no prior
    // controller) is not an update, so it is not offered as one.
    const hadControllerAtLoad = Boolean(navigator.serviceWorker.controller);
    let updateOffered = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadControllerAtLoad || updateOffered) return;
      updateOffered = true;
      if (shouldAutoReloadForUpdate(hadControllerAtLoad, Boolean(self))) {
        window.location.reload();
        return;
      }
      offerWebUpdate();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/tailchat/sw.js', { scope: '/tailchat/' })
        .then((reg) => {
          swRegistration = reg;
          console.log('[PWA] Service Worker registered:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
    });
  }
  if (elements.updateAvailableBtn) {
    elements.updateAvailableBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }

  // Chrome / Android / Edge install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallButtons(true);
  });

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] Tailchat was installed');
    deferredInstallPrompt = null;
    showInstallButtons(false);
  });

  // For iOS Safari: show manual install button if not already in standalone mode
  if (isIos && !isStandalone) {
    showInstallButtons(true);
  }

  function onInstallClick() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') {
          console.log('[PWA] User accepted install prompt');
        }
        deferredInstallPrompt = null;
        showInstallButtons(false);
      });
    } else if (isIos) {
      if (elements.pwaIosDialog && typeof elements.pwaIosDialog.showModal === 'function') {
        elements.pwaIosDialog.showModal();
      }
    }
  }

  if (elements.authPwaInstallBtn) {
    elements.authPwaInstallBtn.addEventListener('click', onInstallClick);
  }
  if (elements.settingsInstallBtn) {
    elements.settingsInstallBtn.addEventListener('click', () => {
      closeSettingsDialog();
      onInstallClick();
    });
  }

  if (elements.pwaIosCloseBtn) {
    elements.pwaIosCloseBtn.addEventListener('click', () => {
      if (elements.pwaIosDialog) elements.pwaIosDialog.close();
    });
  }
  if (elements.pwaIosAckBtn) {
    elements.pwaIosAckBtn.addEventListener('click', () => {
      if (elements.pwaIosDialog) elements.pwaIosDialog.close();
    });
  }
}

function offerWebUpdate() {
  if (!elements.updateAvailableBtn) return;
  elements.updateAvailableBtn.hidden = false;
  elements.updateAvailableBtn.classList.add('rail-update--attention');
  elements.updateAvailableBtn.title = t('updateAvailableTitle');
}

function showInstallButtons(show) {
  if (elements.authPwaInstallBtn) {
    elements.authPwaInstallBtn.hidden = !show;
  }
  if (elements.settingsInstallBtn) {
    elements.settingsInstallBtn.hidden = !show;
  }
}

// --- Запуск приложения ---------------------------------------------------

void (async () => {
  try {
    setTheme(currentTheme);
    setFont(currentFont, { persist: false });
    setRound(currentRound);
    setBorders(bordersOn, { persist: false });
    setDepth(depthOn, { persist: false });
    setWallpaper(currentWallpaper, { persist: false });
    setLanguage(currentLang);
    // The cache-buster on the stylesheet is the package version (see AGENTS.md
    // rule 7), so the footer of the settings dialog never needs its own copy.
    if (elements.settingsVersion) {
      elements.settingsVersion.textContent = APP_VERSION ? `Tailchat ${APP_VERSION}` : 'Tailchat';
    }
    setSoundState(soundEnabled);
    setSoundVolume(soundVolume);
    updateNotifyBtn();
    initPanes();
    setupPwa();
    // Resolve the per-device override before binding anything that can play a
    // cue: the first preview or notification in a restored session must use
    // the selected sound too.
    await loadCustomSound();
    bindEvents();
    initWorkspaceTools();
    elements.transcript.addEventListener('scroll', flushReactionReads, { passive: true, capture: true });
    window.addEventListener('focus', flushReactionReads);
    document.addEventListener('visibilitychange', flushReactionReads);
    boot();
  } catch (err) {
    console.error('[Tailchat] Startup error:', err);
    if (elements.boot) elements.boot.hidden = true;
    if (elements.auth) elements.auth.hidden = false;
  }
})();

// Fallback watchdog: ensure the app never stays stuck on "Загрузка…"
setTimeout(() => {
  if (elements.boot && !elements.boot.hidden && elements.app && elements.app.hidden) {
    console.warn('[Tailchat] Boot watchdog triggered, showing auth form');
    if (elements.boot) elements.boot.hidden = true;
    if (elements.auth) elements.auth.hidden = false;
  }
}, 2000);



// Web workspace tools. Search only inspects loaded content and never changes
// message markup, so links, reactions, code blocks and media keep their handlers.
function initWorkspaceTools() {
  const copy = {
    ru: ['Найти собеседника', 'Все', 'Непрочитанные', 'Ничего не найдено', 'Поиск в переписке', 'Поиск по загруженным сообщениям', 'Предыдущий результат', 'Следующий результат', 'Закрыть поиск', 'Нет совпадений'],
    en: ['Find a person', 'All', 'Unread', 'No conversations found', 'Search conversation', 'Search loaded messages', 'Previous result', 'Next result', 'Close search', 'No matches'],
    fr: ['Chercher un contact', 'Tous', 'Non lus', 'Aucune conversation', 'Rechercher dans la conversation', 'Rechercher dans les messages chargés', 'Résultat précédent', 'Résultat suivant', 'Fermer la recherche', 'Aucun résultat'],
  };
  const labels = () => copy[currentLang] || copy.en;
  const make = (tag, cls, parent) => {
    const node = document.createElement(tag);
    node.className = cls;
    parent.append(node);
    return node;
  };
  const button = (parent, text) => {
    const node = make('button', 'workspace-button', parent);
    node.type = 'button';
    node.textContent = text;
    return node;
  };
  const rosterTitleRow = document.querySelector('.roster-title-row');
  const rosterOpener = document.querySelector('#roster-search-button');
  const rosterSearch = make('div', 'roster-search', document.querySelector('.roster-top'));
  rosterSearch.hidden = true;
  rosterSearch.setAttribute('role', 'search');
  const people = make('input', 'workspace-search', rosterSearch);
  people.type = 'search';
  people.autocomplete = 'off';
  const closePeople = button(rosterSearch, '×');
  const empty = make('p', 'empty-note', rosterSearch);
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  const filterPeople = () => {
    const query = people.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const row of elements.rosterList.querySelectorAll('.roster-row')) {
      const item = row.querySelector('[data-login]') || row;
      const name = row.querySelector('.roster-name')?.textContent || '';
      row.hidden = !`${name} ${item.dataset.login || ''}`.toLocaleLowerCase().includes(query);
      if (!row.hidden) count++;
    }
    empty.hidden = count > 0 || !query;
  };
  const toggleRosterSearch = (open) => {
    rosterTitleRow.hidden = open;
    rosterSearch.hidden = !open;
    rosterOpener.setAttribute('aria-expanded', String(open));
    if (open) people.focus();
    else {
      people.value = '';
      filterPeople();
    }
  };
  rosterOpener.addEventListener('click', () => toggleRosterSearch(true));
  closePeople.addEventListener('click', () => toggleRosterSearch(false));
  people.addEventListener('input', filterPeople);
  people.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      toggleRosterSearch(false);
    }
  });
  new MutationObserver(filterPeople).observe(elements.rosterList, { childList: true, subtree: true, characterData: true });

  const opener = make('button', 'conversation-search-toggle', document.querySelector('.talk-top'));
  opener.type = 'button';
  opener.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-search"></use></svg>';
  // Sits left of the «⋮» menu, not after it — swapped from append order per
  // owner feedback, so the search glass no longer trails the overflow menu.
  elements.conversationMenuButton?.before(opener);
  opener.setAttribute('aria-expanded', 'false');
  opener.setAttribute('aria-controls', 'conversation-search');
  const bar = document.createElement('div');
  bar.className = 'conversation-search';
  bar.id = 'conversation-search';
  bar.hidden = true;
  bar.setAttribute('role', 'search');
  document.querySelector('.transcript-wrapper').prepend(bar);
  const query = make('input', 'workspace-search', bar);
  query.type = 'search';
  const result = make('span', 'search-result-count', bar);
  result.setAttribute('role', 'status');
  const previous = button(bar, '↑');
  const next = button(bar, '↓');
  const close = button(bar, '×');
  let matches = [];
  let selected = -1;
  let peer = activePeer;
  const focusResult = (index, scroll = true) => {
    matches.forEach(row => row.classList.remove('search-current'));
    selected = matches.length ? (index + matches.length) % matches.length : -1;
    const row = matches[selected];
    if (row) {
      row.classList.add('search-current');
      if (scroll) row.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    result.textContent = !query.value.trim() ? '' : matches.length ? `${selected + 1} / ${matches.length}` : labels()[9];
    previous.disabled = next.disabled = matches.length === 0;
  };
  const search = (scroll = false) => {
    const old = matches[selected];
    matches.forEach(row => row.classList.remove('search-match', 'search-current'));
    if (peer !== activePeer) { peer = activePeer; query.value = ''; }
    const text = query.value.trim().toLocaleLowerCase();
    matches = bar.hidden || !text ? [] : [...(threads.get(activePeer)?.node.querySelectorAll('.row') || [])].filter(row =>
      (emojiPlainText(row.querySelector('.bubble-text')) ?? row.messageText ?? '').toLocaleLowerCase().includes(text));
    matches.forEach(row => row.classList.add('search-match'));
    focusResult(Math.max(0, matches.indexOf(old)), scroll);
  };
  const toggle = (visible) => {
    bar.hidden = !visible;
    opener.setAttribute('aria-expanded', String(visible));
    if (visible) { query.focus(); query.select(); search(); }
    else { query.value = ''; search(); opener.focus(); }
  };
  opener.addEventListener('click', () => toggle(bar.hidden));
  close.addEventListener('click', () => toggle(false));
  query.addEventListener('input', () => search(true));
  previous.addEventListener('click', () => focusResult(selected - 1));
  next.addEventListener('click', () => focusResult(selected + 1));
  bar.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); toggle(false); }
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); focusResult(selected + (event.shiftKey ? -1 : 1)); }
  });
  window.addEventListener('keydown', event => {
    if (elements.app.hidden || document.querySelector('dialog[open]') || event.altKey || event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); toggle(true);
    }
  });
  let frame = 0;
  new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; search(); });
  }).observe(elements.transcript, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  const translate = () => {
    const l = labels();
    people.placeholder = l[0]; people.setAttribute('aria-label', l[0]);
    empty.textContent = l[3];
    rosterOpener.title = l[0]; rosterOpener.setAttribute('aria-label', l[0]);
    closePeople.title = l[8]; closePeople.setAttribute('aria-label', l[8]);
    opener.title = `${l[4]} (Ctrl/⌘ F)`; opener.setAttribute('aria-label', l[4]);
    query.placeholder = l[5]; query.setAttribute('aria-label', l[5]);
    [previous, next, close].forEach((node, index) => { node.title = l[index + 6]; node.setAttribute('aria-label', l[index + 6]); });
    filterPeople(); search();
  };
  new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  translate();
}

// Reconcile date labels after history/live overlap. Dates belong to the
// chronologically ordered rows, never to the last network batch received.
function normalizeDateDividers(thread) {
  thread.node.querySelectorAll('.day-divider').forEach(node => node.remove());

  const rows = [...thread.node.querySelectorAll('.row[data-ts]')].filter(row => !row.hidden);
  const ordered = [...rows].sort((a, b) => Number(a.dataset.ts) - Number(b.dataset.ts));
  if (ordered.some((row, index) => row !== rows[index])) {
    const slots = rows.map(row => { const slot = document.createComment('message'); row.replaceWith(slot); return slot; });
    slots.forEach((slot, index) => slot.replaceWith(ordered[index]));
  }
  const days = new Set();
  for (const row of ordered) {
    const ts = Number(row.dataset.ts);
    const day = dayKey(ts);
    if (days.has(day)) continue;
    days.add(day);
    const divider = document.createElement('div');
    divider.className = 'day-divider';
    divider.dataset.day = day;
    const badge = document.createElement('span');
    badge.className = 'day-badge';
    badge.textContent = dayLabel(ts);
    divider.append(badge);
    thread.node.insertBefore(divider, row);
  }
  thread.lastDay = ordered.length ? dayKey(Number(ordered.at(-1).dataset.ts)) : null;
}
function scheduleDateDividers(thread) {
  if (thread.dateFrame) return;
  thread.dateFrame = requestAnimationFrame(() => {
    thread.dateFrame = null;
    const pinned = thread.peer === activePeer && transcriptAtBottom();
    normalizeDateDividers(thread);
    if (pinned) scrollToLatest(true, true);
    flushReactionReads();
  });
}
function markMessageEdited(row, editedAt = 0) {
  if (Number.isFinite(editedAt) && editedAt > 0) row.dataset.editedAt = String(editedAt);
  const meta = row.querySelector('.bubble-meta');
  if (!meta || meta.querySelector('.bubble-edited')) return;
  const mark = document.createElement('span');
  mark.className = 'bubble-edited';
  mark.textContent = '✎';
  mark.title = ({ ru: 'Изменено', en: 'Edited', fr: 'Modifié' })[currentLang] || 'Edited';
  mark.setAttribute('aria-label', mark.title);
  meta.prepend(mark);
  layoutMessageMeta(row);
}

// «маленький серый, как и другие, как например изменено»: same shape as
// `markMessageEdited` above — a `.bubble-meta` span, not a fresh visual
// idiom of its own. Cleared once the reminder actually fires (§10 AGENTS.md:
// the icon means "a reminder is pending", not "one was ever set").
function markMessageReminded(row) {
  const meta = row.querySelector('.bubble-meta');
  if (!meta || meta.querySelector('.bubble-reminded')) return;
  const mark = document.createElement('span');
  mark.className = 'bubble-reminded';
  mark.textContent = '⏰';
  mark.title = ({ ru: 'Напоминание установлено', en: 'Reminder set', fr: 'Rappel programmé' })[currentLang] || 'Reminder set';
  mark.setAttribute('aria-label', mark.title);
  meta.prepend(mark);
  layoutMessageMeta(row);
}

/** The reminder mark for a row that already exists in the DOM: the same fact
 *  [noteReminderSet] records, applied to a row drawn before the frame landed
 *  (`markMessageReminded` is itself idempotent — it returns early when the
 *  mark is already there). */
function markMessageRemindedIfPending(thread, row, id) {
  if (!thread || !row || typeof id !== 'string' || id === '') return;
  if (thread.reminded.has(id)) markMessageReminded(row);
}

function clearMessageReminded(row) {
  row.querySelector('.bubble-meta > .bubble-reminded')?.remove();
  layoutMessageMeta(row);
}

/**
 * A reminder is pending on [id] — the hub's own `reply-reminder-set`, the same
 * frame it answers the connection that set one with and re-sends for
 * everything still pending on every `auth`.
 *
 * Recorded on the thread *and* drawn, in that order: the frame can arrive
 * before the row exists (a reload rebuilds the transcript from history, and
 * the greeting is sent before any of it is fetched), and a mark that only ever
 * touched the DOM was lost in exactly that case.
 */
function noteReminderSet(thread, id) {
  if (!thread || typeof id !== 'string' || id === '') return;
  thread.reminded.add(id);
  const row = thread.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) markMessageReminded(row);
}

/** The reminder came due: the mark means «pending», not «was ever set». */
function noteReminderFired(thread, id) {
  if (!thread || typeof id !== 'string' || id === '') return;
  thread.reminded.delete(id);
  const row = thread.node.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) clearMessageReminded(row);
}

function messageEventTime(value) {
  return new Intl.DateTimeFormat(localeFor(currentLang), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}
function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      id = url.searchParams.get('v');
      if (!id && /^\/(shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split('/')[2];
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

function tombstoneMessage(thread, row) {
  if (row.dataset.deleted === 'true') return;
  if (hoverQuickReactions?.row === row) hideQuickReactions();
  row.dataset.deleted = 'true';
  row.hidden = !showDeletedMessages;
  row.previewRevision = (row.previewRevision || 0) + 1;
  row.messageText = '';
  row.reactions = {};
  row.querySelectorAll('audio, video').forEach(media => media.pause());
  if (row.dataset.id) forgetMedia(thread.peer, row.dataset.id);
  const bubble = row.querySelector('.bubble');
  const content = bubble.querySelector('.bubble-content');
  const meta = bubble.querySelector('.bubble-meta');
  const author = bubble.querySelector('.bubble-author');
  meta?.querySelectorAll('.bubble-edited, .bubble-mark').forEach(node => node.remove());
  const text = document.createElement('p');
  text.className = 'bubble-text';
  text.textContent = t('msgDeleted');
  content.replaceChildren(...[author, text, meta].filter(Boolean));
  bubble.querySelector('.bubble-reactions')?.remove();
  // The picture is gone, so is its bubble-less layout.
  delete row.dataset.image;
  bubble.style.removeProperty('--image-w');
  layoutMessageMeta(row);
  if (thread.lastMessage?.id === row.dataset.id) thread.lastMessage = null;
  for (const [id, event] of thread.reactionEvents || []) if (event.messageId === row.dataset.id) thread.reactionEvents.delete(id);
}
function paintReactionEvents(thread) {
  for (const row of thread.node.querySelectorAll('.row')) {
    const events = [...(thread.reactionEvents?.values() || [])].filter(event => event.messageId === row.dataset.id);
    for (const button of row.querySelectorAll('.bubble-reaction')) {
      button.dataset.unread = String(events.some(event => event.emoji === button.dataset.emoji));
    }
  }
}
function flushReactionReads() {
  if (!activePeer || !authed || !appIsForeground()) return;
  if (!wide.matches && elements.app.dataset.pane !== 'talk') return;
  const thread = threads.get(activePeer);
  if (!thread?.reactionEvents?.size) return;
  const viewport = elements.transcript.getBoundingClientRect();
  const ids = [];
  for (const [id, event] of thread.reactionEvents) {
    const row = thread.node.querySelector(`[data-id="${CSS.escape(event.messageId)}"]`);
    const badge = [...(row?.querySelectorAll('.bubble-reaction') || [])].find(button => button.dataset.emoji === event.emoji);
    // No badge to look at: the reacted message is not on the loaded page (or
    // its reaction was taken back, or the message was deleted). Nothing the
    // person does in this conversation could ever acknowledge it, and it was
    // keeping an unread badge on the roster permanently — «висят
    // непрочитанные и ничего с этим не сделаешь». Reading the newest page of
    // an open conversation is the acknowledgement.
    if (!badge) {
      if (thread.loaded && transcriptAtBottom()) ids.push(id);
      continue;
    }
    const box = badge.getBoundingClientRect();
    const strip = badge.closest('.bubble-reactions').getBoundingClientRect();
    if (box.top >= viewport.top && box.bottom <= viewport.bottom && box.height > 0
        && box.left >= Math.max(viewport.left, strip.left)
        && box.right <= Math.min(viewport.right, strip.right)) ids.push(id);
  }
  if (!ids.length) return;
  // One account-level acknowledgement, no peer control-frame echo.
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    if (sendEnvelope({ k: 'reaction-read', peer: activePeer, ids: batch })) batch.forEach(id => thread.reactionEvents.delete(id));
  }
  paintReactionEvents(thread); renderRoster(); updateAppUnreadBadge();
}
