export const EMOJIS = [
  { emoji: '👌', help: 'OK' },
  { emoji: '👍', help: 'Thumbs Up / Yes' },
  { emoji: '👎', help: 'Thumbs Down / No' },
  { emoji: '💖', help: 'Love / Heart' },
  { emoji: '😊', help: 'Smile' },
  { emoji: '😂', help: 'Laugh' },
  { emoji: '🤔', help: 'Thinking' },
  { emoji: '🙏', help: 'Please / Thanks' },
];

export const EMOJI_DICT = {
  'ok': '👌',
  'ок': '👌',
  'd\'accord': '👌',
  'good': '👍',
  'хорошо': '👍',
  'bien': '👍',
  'bad': '👎',
  'плохо': '👎',
  'mal': '👎',
  'love': '💖',
  'любовь': '💖',
  'amour': '💖',
  'please': '🙏',
  'пожалуйста': '🙏',
  'svp': '🙏',
  'smile': '😊',
  'улыбка': '😊',
  'sourire': '😊',
};

export const COLON_EMOJIS = {
  ':ok': '👌', ':ok:': '👌',
  ':good': '👍', ':good:': '👍',
  ':bad': '👎', ':bad:': '👎',
  ':love': '💖', ':love:': '💖',
  ':please': '🙏', ':please:': '🙏',
  ':smile': '😊', ':smile:': '😊',
  ':cry': '😢', ':cry:': '😢',
  ':laugh': '😂', ':laugh:': '😂',
  ':yes': '✔️', ':yes:': '✔️',
  ':no': '❌', ':no:': '❌'
};

// Helper function to replace words in a string (controlled by setting)
export function replaceEmojis(text) {
  return text.split(' ').map(word => {
    // Strip basic punctuation at the end for matching
    const match = word.replace(/[.,!?]$/, '').toLowerCase();
    if (EMOJI_DICT[match]) {
      // Create a regex to replace the match ignoring case, but keep the trailing punctuation
      return word.replace(new RegExp(`^${match}`, 'i'), EMOJI_DICT[match]);
    }
    return word;
  }).join(' ');
}

// Unconditional replacement for explicit :emoji: syntax
export function replaceColonEmojis(text) {
  // Regex to match :word: or :word followed by space or end of string
  // It's safer to just replace them anywhere they appear as a distinct word token
  return text.split(' ').map(word => {
    // Keep trailing punctuation like :ok, or :ok:!
    const coreMatch = word.replace(/[.,!?]$/, '').toLowerCase();
    if (COLON_EMOJIS[coreMatch]) {
      return word.replace(new RegExp(`^${coreMatch}`, 'i'), COLON_EMOJIS[coreMatch]);
    }
    return word;
  }).join(' ');
}
