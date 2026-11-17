// Pure ASCII on purpose, like the emoticons: every character is one cell wide,
// so a picture never reflows the transcript on a narrow terminal or on a peer
// whose font lacks the glyph. Curly braces are excluded because blessed would
// read them as markup.
export const MAX_ART_WIDTH = 44;
export const MAX_ART_ROWS = 9;

// Grouped by what the sender means, so /asc sad is a mood and not a lottery.
// Several variants per mood keep it from going stale.
export const ART = {
  happy: [
    [
      "   .-'''-.",
      '  /       \\',
      ' |  o   o  |',
      ' |    ^    |',
      '  \\  \\_/  /',
      "   '-.....-'",
    ],
    [
      '  \\o/   \\o/   \\o/',
      '   |     |     |',
      '  / \\   / \\   / \\',
    ],
    [
      '   _____',
      '  /     \\',
      ' | () () |',
      '  \\  ^  /',
      "   |||||",
      '   \\___/',
    ],
  ],
  sad: [
    [
      "   .-'''-.",
      '  /       \\',
      ' |  o   o  |',
      ' |    ^    |',
      '  \\  /~\\  /',
      "   '-.....-'",
    ],
    [
      '      .--.',
      '   .-(    ).',
      '  (___.__)__)',
      "   ' ' ' ' '",
      "    ' ' ' '",
      "     ' ' '",
    ],
    [
      '   ___',
      '  /   \\',
      ' | - - |',
      " |  ~  |",
      '  \\___/',
      '   | |',
      "  ,' ',",
    ],
  ],
  ok: [
    [
      '  _____  _  __',
      ' |  _  || |/ /',
      ' | | | ||   /',
      ' | |_| ||   \\',
      ' |_____||_|\\_\\',
    ],
    [
      '        ___',
      '       /  /',
      '  __  /  /',
      ' |  \\/  /',
      '  \\     /',
      "   \\___/",
    ],
  ],
  no: [
    [
      '  _   _  _____',
      ' | \\ | ||  _  |',
      ' |  \\| || | | |',
      ' | |\\  || |_| |',
      ' |_| \\_||_____|',
    ],
    [
      '  \\             /',
      '   \\           /',
      '    \\         /',
      '     \\       /',
      '      \\     /',
      '       \\   /',
      '        \\ /',
      '         X',
    ],
  ],
  cat: [
    [
      '  /\\_/\\',
      ' ( -.- )',
      '  > ~ <   zzz',
    ],
    [
      '     /\\     /\\',
      '    /  \\___/  \\',
      '   |  o     o  |',
      '   |     >     |',
      '    \\  \\___/  /',
      "     '-.....-'",
    ],
  ],
  dog: [
    [
      '   / \\__',
      '  (    @\\___',
      '  /         O',
      ' /   (_____/',
      '/_____/   U',
    ],
  ],
  bird: [
    [
      '    __',
      ' <(o )___',
      '  ( ._> /',
      "   `---'",
    ],
    [
      '   __  __',
      '  /  \\/  \\',
      ' | () () |',
      '  \\  ~~  /',
      "   `----'",
    ],
  ],
  shrug: [
    [
      ' \\_(-_-)_/',
    ],
    [
      '   .--.',
      '  |o_o |',
      '  |:_/ |',
      ' //   \\ \\',
      '(|     | )',
      "/'\\_   _/`\\",
    ],
  ],
  coffee: [
    [
      '   ( (',
      '    ) )',
      '  ........',
      '  |      |]',
      '  \\      /',
      "   `----'",
    ],
  ],
  cow: [
    [
      '  ,__,',
      '  (oo)____',
      '  (__)    )\\',
      '     ||--|| *',
    ],
  ],
};

export const MOODS = Object.keys(ART);

const ALL = Object.values(ART).flat();

const draw = (list, pick) => {
  const index = Math.min(list.length - 1, Math.floor(pick() * list.length));
  return list[index].join('\n');
};

// Returns the picture, or the list of moods when the name means nothing here —
// guessing at "sadd" would send the wrong feeling.
export function pickArt(mood, pick = Math.random) {
  const name = String(mood ?? '').trim().toLowerCase();
  if (name === '') return { ok: true, art: draw(ALL, pick) };
  if (!Object.hasOwn(ART, name)) return { ok: false, moods: MOODS };
  return { ok: true, art: draw(ART[name], pick) };
}
