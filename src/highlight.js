// Syntax highlighting for fenced code, the way a chat app shows it: the language
// from the fence decides the keywords, and the rest is the handful of token kinds
// every language shares.
//
// Deliberately not a parser. A chat message is a fragment — half a pipeline, one
// function, a pasted error — so anything that needs real context would be wrong
// more often than a few honest regexes.

const ALIASES = {
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  js: 'js', javascript: 'js', mjs: 'js', ts: 'js', typescript: 'js', jsx: 'js',
  py: 'python', python: 'python',
  json: 'json',
};

// Keywords are the words that shape a line. In a shell that is only the control
// words: `git` and `rm` are not grammar, they are the thing being called, so they
// are left out and picked up by command position instead — which also means an
// unlisted command like `fastfetch` is coloured the same as `ls`.
const KEYWORDS = {
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

// Values rather than actions: a name that stands for a value means the same thing
// whether or not it is being called, so these are checked before call position and
// `str(x)` stays a built-in instead of turning into some function of the author's.
const CONSTANTS = {
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

const COMMENT = { shell: '#', python: '#', js: '//', json: null };

// Without a language nothing may be claimed about keywords — `export` and
// `function` belong to both a shell and JavaScript, and guessing from the first
// word labelled a JavaScript paste as shell. What is left is what every language
// agrees on: quoted text, numbers, a comment at the start of a line, a name being
// called, brackets, and a few operators that are never part of a path.
const GENERIC_OPERATORS = /^(?:&&|\|\||=>|===|!==)/;
const GENERIC_COMMENT = /^\s*(?:#\s|\/\/)/;
// These few words are the same value in every language that has them, so reading
// them costs no guess about which language this is.
const GENERIC_CONSTANTS = ['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN'];

// Per language on purpose: in a shell a `/` is a path and `--x` is a flag, so
// treating them as operators paints half a command line one colour for nothing.
// The shell list carries the pipes and redirects, which are the joints a reader
// looks for first in a pasted command; `$(` and a backtick count as operators so
// the word after them is read as a command.
const OPERATORS = {
  shell: /^(?:\$\(|`|&&|\|\||\||;;|;|&|\d?>>|\d?>&\d?|\d?>|<<<|<<|<|=)/,
  js: /^(?:=>|===|!==|==|!=|<=|>=|\*\*|&&|\|\||\?\?|\?\.|[=+\-*/%<>!?:&|^~])/,
  python: /^(?:==|!=|<=|>=|\*\*|\/\/|->|[=+\-*/%<>:&|^~])/,
  json: /^[:,]/,
};

// Brackets, commas and dots are scaffolding: separating them from the operators
// keeps `=` and `|` loud while the frame of the line stays quiet.
const PUNCT = {
  shell: /^[[\](){}:,.*?~!@%^-]/,
  js: /^[[\](){};,.#@]/,
  python: /^[[\](){};,.@]/,
  json: /^[[\]{}]/,
};
const GENERIC_PUNCT = /^[[\](){};,]/;

// A shell word may contain hyphens (`node-fetch`), a JavaScript one may start with
// `$`. Elsewhere a hyphen is a minus, so it must not be glued into the word.
const WORDS = {
  shell: /^[A-Za-z_][\w-]*/,
  js: /^[A-Za-z_$][\w$]*/,
  python: /^[A-Za-z_]\w*/,
  json: /^[A-Za-z_]\w*/,
};
const GENERIC_WORD = /^[A-Za-z_$][\w$]*/;

const QUOTED = /^(['"`])(?:\\.|[^\\])*?\1/;
const OPEN_QUOTE = /^(['"`]).*/;
const ESCAPE = /\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[\s\S])/g;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/;

// `$HOME`, `${x}`, `$1`, `$?` — one token including the braces, so a variable does
// not fall apart into punctuation the reader has to reassemble.
const SHELL_VARIABLE = /^\$(?:\{[^}]*\}?|[A-Za-z_]\w*|[0-9@*#?$!_-])/;
const SHELL_FLAG = /^--?[A-Za-z0-9][\w-]*/;
// A path is anything holding a slash, plus the bare filenames that read as one
// (`index.js`). The lookahead keeps `1.5` a number rather than a file.
const SHELL_PATHS = [
  /^(?:~|\.{1,2})?\/[^\s'"`;|&<>#()]*/,
  /^(?=[\w@%+-]*[A-Za-z])[\w@%+-]+(?:\.[\w+-]+)+/,
];

// After these, the next word is the thing being run, not an argument.
const COMMAND_AFTER_OPERATOR = new Set(['|', '||', '&&', ';', ';;', '&', '$(', '`']);
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'time', 'nohup', 'xargs', 'exec', 'command', 'watch',
  'then', 'do', 'else',
]);

export function normaliseLanguage(info) {
  const name = String(info ?? '').trim().toLowerCase().split(/\s+/)[0];
  return ALIASES[name] ?? null;
}

// A command is the first word of a line and the first word after anything that
// starts a new one. Nothing else about the line is needed, which is why this
// survives being handed half a pipeline.
function isCommandPosition(prev) {
  if (!prev) return true;
  if (prev.kind === 'operator') return COMMAND_AFTER_OPERATOR.has(prev.text);
  if (prev.kind === 'punct') return prev.text === '(' || prev.text === '{';
  return COMMAND_WRAPPERS.has(prev.text);
}

function wordKind(word, after, language, prev) {
  if (language) {
    if (KEYWORDS[language].includes(word)) return 'keyword';
    if (CONSTANTS[language].includes(word)) return 'builtin';
  } else if (GENERIC_CONSTANTS.includes(word)) {
    return 'builtin';
  }
  // A declaration keyword names the thing it declares: `class` a type, `def` and
  // `function` a callable — and the class head's `(` is a base list, not a call.
  if (prev && prev.kind === 'keyword') {
    if (prev.text === 'class') return 'type';
    if (prev.text === 'function' || prev.text === 'def') return 'function';
  }
  // A name being called is an action, not a value.
  if (after.startsWith('(')) return 'function';
  if (language === 'shell' && isCommandPosition(prev)) return 'function';
  // The part after a dot is a field of the thing before it, not a free variable.
  if ((language === 'js' || language === 'python')
      && prev && prev.kind === 'punct' && prev.text === '.') return 'member';
  // PascalCase is the one convention these two languages share for a type, and it
  // is cheap to spot: an uppercase start with no gaps.
  if ((language === 'js' || language === 'python') && /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
    return 'type';
  }
  // A shell word is an argument, not a variable: colouring `push origin main` the
  // same green as a code variable made the middle of every command one flat
  // colour. Plain text lets the command, the flags, the paths and the pipes do
  // the talking.
  if (language === 'shell') return 'plain';
  return 'identifier';
}

// A backslash is literal inside shell single quotes, so an escape is only marked
// where the language actually treats it as one.
function splitEscapes(text, quote, language) {
  if (language === 'shell' && quote === "'") return [{ kind: 'string', text }];
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(ESCAPE)) {
    if (match.index > last) parts.push({ kind: 'string', text: text.slice(last, match.index) });
    parts.push({ kind: 'escape', text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'string', text: text.slice(last) });
  return parts;
}

// Before numbers, so `2>&1` stays one redirect instead of a stray 2.
function shellToken(line) {
  const variable = SHELL_VARIABLE.exec(line);
  if (variable) return { kind: 'builtin', text: variable[0] };
  const operator = OPERATORS.shell.exec(line);
  if (operator) return { kind: 'operator', text: operator[0] };
  const flag = SHELL_FLAG.exec(line);
  if (flag) return { kind: 'flag', text: flag[0] };
  for (const pattern of SHELL_PATHS) {
    const path = pattern.exec(line);
    if (path) return { kind: 'string', text: path[0] };
  }
  return null;
}

// Ordered so the greedy kinds win: a `#` inside quotes is a string, not a comment.
// Returns a list because a string can carry escapes inside it.
function nextTokens(line, language, atStart, prev) {
  const comment = COMMENT[language];
  if (comment && line.startsWith(comment)) return [{ kind: 'comment', text: line }];
  // A hash needs a space after it so a JavaScript private field stays code, and
  // `//` only counts at the start so a URL keeps its slashes.
  if (!language && atStart && GENERIC_COMMENT.test(line)) return [{ kind: 'comment', text: line }];
  // An unterminated quote runs to the end: a pasted fragment often cuts one off.
  const quoted = QUOTED.exec(line) ?? OPEN_QUOTE.exec(line);
  if (quoted) return splitEscapes(quoted[0], quoted[1], language);
  if (language === 'shell') {
    const shell = shellToken(line);
    if (shell) return [shell];
  }
  const number = NUMBER.exec(line);
  if (number) return [{ kind: 'number', text: number[0] }];
  const operator = (language ? OPERATORS[language] : GENERIC_OPERATORS).exec(line);
  if (operator) return [{ kind: 'operator', text: operator[0] }];
  const word = (language ? WORDS[language] : GENERIC_WORD).exec(line);
  if (word) {
    const after = line.slice(word[0].length);
    return [{ kind: wordKind(word[0], after, language, prev), text: word[0] }];
  }
  const punct = (language ? PUNCT[language] : GENERIC_PUNCT).exec(line);
  if (punct) return [{ kind: 'punct', text: punct[0] }];
  return [{ kind: 'plain', text: line[0] }];
}

export function tokenise(line, language) {
  const tokens = [];
  let rest = line;
  // The last token that is not whitespace: all the context a command needs.
  let prev = null;
  while (rest.length > 0) {
    const next = nextTokens(rest, language, rest.length === line.length, prev);
    for (const token of next) {
      const last = tokens[tokens.length - 1];
      // Merge neighbours of the same kind so the output carries one tag per run
      // rather than one per character.
      if (last && last.kind === token.kind && token.kind === 'plain') last.text += token.text;
      else tokens.push({ ...token });
      if (token.text.trim()) prev = token;
      rest = rest.slice(token.text.length);
    }
  }
  return tokens;
}

// Ten kinds, one colour each, all taken from what blessed's tag parser accepts.
// Chosen bright rather than pastel: a pastel hue sits next to the near-white
// plain text and the eye slides off it, which is exactly the complaint a code
// block answered with "barely any colour". Saturated hues stay separate from one
// another and from the green frame around them.
// Ten-plus kinds, one colour each. The tag parser cannot name the ANSI bright
// colours (`bright blue` has a space in it, which the tag regex will not match),
// so brightness has to come from hex. These sit on the saturated edge of the
// 256-colour cube rather than the pastel one the old palette lived on: a keyword
// should shout, not whisper.
export const TOKEN_COLOR = {
  plain: '#e4e4e4',
  comment: '#7f7f7f',
  string: '#ffd700',
  escape: '#ff8700',
  number: '#af5fff',
  keyword: '#0087ff',
  builtin: '#ff5f5f',
  function: '#ff0087',
  operator: '#00d7ff',
  punct: '#9e9e9e',
  identifier: '#00d75f',
  member: '#ff5faf',
  type: '#00d7af',
  // An option is one step brighter than the keyword blue and never bold, so a
  // shell flag reads as a flag and not as the shape of a statement.
  flag: '#00afff',
};


// The two kinds worth finding at a glance get bold on top of their colour: the
// word that shapes the line, and the name the line actually calls.
// blessed caches its hex→palette matches against an 8-colour table while it
// boots, so a hex that lands exactly on a palette entry comes back as a base
// colour — a vivid blue arrived as cyan. A numeric 256-colour tag has no such
// cache, so the index is computed here and handed over directly.
export function hexTo256(hex) {
  const level = (value) => Math.max(0, Math.min(5, Math.round((value - 55) / 40)));
  const r = level(parseInt(hex.slice(1, 3), 16));
  const g = level(parseInt(hex.slice(3, 5), 16));
  const b = level(parseInt(hex.slice(5, 7), 16));
  return 16 + r * 36 + g * 6 + b;
}

// Only keywords are bold: `const`, `function`, `import` are the first words of a
// line and the ones the eye must land on first, the way VS Code makes keywords the
// loudest thing in a statement.
const BOLD_KINDS = new Set(['keyword']);


// `escape` is injected because the caller owns the escaping rules of its own
// renderer, and escaping must happen per token, after tokenising the raw text.
export function highlight(line, language, { escape = (v) => v, themed = true } = {}) {
  if (!themed) return escape(line);
  return tokenise(line, language)
    .map(({ kind, text }) => {
      const color = TOKEN_COLOR[kind];
      const safe = escape(text);
      if (!color) return safe;
      const index = hexTo256(color);
      return BOLD_KINDS.has(kind)
        ? `{bold}{${index}-fg}${safe}{/${index}-fg}{/bold}`
        : `{${index}-fg}${safe}{/${index}-fg}`;
    })
    .join('');
}
