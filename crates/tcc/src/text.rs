//! Text helpers: wrapping by display width, cleaning foreign text, and the
//! one-line input editor.

use unicode_width::{UnicodeWidthChar as _, UnicodeWidthStr as _};

/// Display width of a string, in terminal cells.
pub fn width(text: &str) -> usize {
    text.width()
}

fn char_width(c: char) -> usize {
    c.width().unwrap_or(0)
}

/// A clamp from `usize` for ratatui's `u16` coordinates.
pub fn to_u16(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

/// Terminal control sequences in a peer's text would act on *this* terminal:
/// every control character but the newline is shown as a replacement mark.
pub fn clean(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() && c != '\n' {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

/// `@Bob` and ` bob ` are both the login `bob`.
pub fn login_of(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_lowercase()
}

/// `text` cut to `max` cells, with `…` if it did not fit.
pub fn truncate(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = char_width(c);
        if used + w + 1 > max {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('…');
    out
}

/// Greedy word wrap by display width. Newlines are kept; a word longer than a
/// line is broken where it must be. Always at least one (possibly empty) line.
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let max = max.max(1);
    let mut out = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        let mut used = 0usize;
        for word in paragraph.split(' ') {
            let w = width(word);
            if !line.is_empty() {
                if used + 1 + w <= max {
                    line.push(' ');
                    line.push_str(word);
                    used += 1 + w;
                    continue;
                }
                out.push(std::mem::take(&mut line));
                used = 0;
            }
            if w <= max {
                line.push_str(word);
                used = w;
                continue;
            }
            for c in word.chars() {
                let cw = char_width(c);
                if used + cw > max && !line.is_empty() {
                    out.push(std::mem::take(&mut line));
                    used = 0;
                }
                line.push(c);
                used += cw;
            }
        }
        out.push(line);
    }
    out
}

/// The line being typed, with a cursor and a memory of what was sent.
#[derive(Default)]
pub struct Input {
    chars: Vec<char>,
    cursor: usize,
    recall: Vec<String>,
    /// Which remembered line is shown (`None`: the live draft).
    at: Option<usize>,
    draft: Vec<char>,
}

/// Remembered lines kept for Up/Down.
const RECALL_MAX: usize = 100;

impl Input {
    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn insert(&mut self, c: char) {
        self.chars.insert(self.cursor, c);
        self.cursor += 1;
        self.at = None;
    }

    /// Pasted text: newlines stay, other controls go.
    pub fn insert_str(&mut self, text: &str) {
        for c in text.replace("\r\n", "\n").replace('\r', "\n").chars() {
            if c == '\n' || !c.is_control() {
                self.insert(c);
            }
        }
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.chars.remove(self.cursor);
            self.at = None;
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
            self.at = None;
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.chars.len());
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.chars.len();
    }

    fn is_space(&self, index: usize) -> bool {
        self.chars.get(index).is_some_and(|c| c.is_whitespace())
    }

    fn word_start(&self) -> usize {
        let mut i = self.cursor;
        while i > 0 && self.is_space(i - 1) {
            i -= 1;
        }
        while i > 0 && !self.is_space(i - 1) {
            i -= 1;
        }
        i
    }

    pub fn word_left(&mut self) {
        self.cursor = self.word_start();
    }

    pub fn word_right(&mut self) {
        let mut i = self.cursor;
        while i < self.chars.len() && self.is_space(i) {
            i += 1;
        }
        while i < self.chars.len() && !self.is_space(i) {
            i += 1;
        }
        self.cursor = i;
    }

    pub fn kill_word_back(&mut self) {
        let start = self.word_start();
        self.chars.drain(start..self.cursor);
        self.cursor = start;
        self.at = None;
    }

    pub fn kill_to_start(&mut self) {
        self.chars.drain(..self.cursor);
        self.cursor = 0;
        self.at = None;
    }

    pub fn kill_to_end(&mut self) {
        self.chars.truncate(self.cursor);
        self.at = None;
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
        self.at = None;
    }

    /// The finished line; it is remembered for Up/Down.
    pub fn take(&mut self) -> String {
        let line = self.text();
        if !line.trim().is_empty() && self.recall.last() != Some(&line) {
            self.recall.push(line.clone());
            if self.recall.len() > RECALL_MAX {
                self.recall.remove(0);
            }
        }
        self.clear();
        line
    }

    fn show(&mut self, line: &str) {
        self.chars = line.chars().collect();
        self.cursor = self.chars.len();
    }

    /// Older remembered line.
    pub fn up(&mut self) {
        let next = match self.at {
            None if self.recall.is_empty() => return,
            None => {
                self.draft = self.chars.clone();
                self.recall.len() - 1
            }
            Some(0) => return,
            Some(i) => i - 1,
        };
        self.at = Some(next);
        if let Some(line) = self.recall.get(next).cloned() {
            self.show(&line);
        }
    }

    /// Newer remembered line, ending at the draft.
    pub fn down(&mut self) {
        let Some(i) = self.at else { return };
        if i + 1 < self.recall.len() {
            self.at = Some(i + 1);
            if let Some(line) = self.recall.get(i + 1).cloned() {
                self.show(&line);
            }
        } else {
            self.at = None;
            self.chars = std::mem::take(&mut self.draft);
            self.cursor = self.chars.len();
        }
    }

    /// What fits in `max` cells with the cursor in view, and the cursor's
    /// column in it. A newline is drawn as `↵`.
    pub fn view(&self, max: usize) -> (String, usize) {
        let max = max.max(2);
        let shown = |c: char| if c == '\n' { '↵' } else { c };
        let mut start = self.cursor;
        let mut used = 0;
        while start > 0 {
            let w = self.chars.get(start - 1).map_or(0, |c| char_width(shown(*c)));
            if used + w > max - 1 {
                break;
            }
            used += w;
            start -= 1;
        }
        let mut out = String::new();
        let mut taken = 0;
        for c in self.chars.iter().skip(start) {
            let c = shown(*c);
            let w = char_width(c);
            if taken + w > max {
                break;
            }
            out.push(c);
            taken += w;
        }
        (out, used)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_breaks_on_words_and_keeps_newlines() {
        assert_eq!(wrap("hello brave new world", 11), ["hello brave", "new world"]);
        assert_eq!(wrap("a\n\nb", 10), ["a", "", "b"]);
        assert_eq!(wrap("", 10), [""]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
    }

    #[test]
    fn wrap_counts_cells_not_characters() {
        // Each of these is two cells wide.
        assert_eq!(wrap("日本語です", 6), ["日本語", "です"]);
        for line in wrap("смешанный mixed 日本語 text", 9) {
            assert!(width(&line) <= 9, "{line:?}");
        }
    }

    #[test]
    fn clean_replaces_controls_but_not_newlines() {
        assert_eq!(clean("a\u{1b}[2Jb\nc"), "a\u{fffd}[2Jb\nc");
    }

    #[test]
    fn truncate_fits_the_cells() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdefghij", 5), "abcd…");
        assert!(width(&truncate("日本語です", 5)) <= 5);
    }

    fn typed(text: &str) -> Input {
        let mut input = Input::default();
        input.insert_str(text);
        input
    }

    #[test]
    fn editing_moves_by_words_and_kills() {
        let mut input = typed("one two three");
        input.word_left();
        input.kill_word_back();
        assert_eq!(input.text(), "one three");
        input.kill_to_end();
        assert_eq!(input.text(), "one ");
        input.home();
        input.delete();
        assert_eq!(input.text(), "ne ");
        input.end();
        input.kill_to_start();
        assert!(input.is_empty());
    }

    #[test]
    fn recall_walks_back_and_returns_to_the_draft() {
        let mut input = Input::default();
        for line in ["first", "second"] {
            input.insert_str(line);
            input.take();
        }
        input.insert_str("draft");
        input.up();
        assert_eq!(input.text(), "second");
        input.up();
        input.up();
        assert_eq!(input.text(), "first");
        input.down();
        input.down();
        assert_eq!(input.text(), "draft");
    }

    #[test]
    fn view_keeps_the_cursor_inside_the_window() {
        let input = typed("0123456789abcdef");
        let (shown, column) = input.view(8);
        assert!(width(&shown) <= 8);
        assert!(column < 8);
        assert!(shown.ends_with('f'));
        let mut input = typed("line one\nline two");
        input.home();
        assert!(input.view(40).0.contains('↵'));
    }

    #[test]
    fn paste_keeps_newlines_and_drops_other_controls() {
        let input = typed("a\r\nb\u{1b}c");
        assert_eq!(input.text(), "a\nbc");
    }
}
