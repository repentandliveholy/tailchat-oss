// blessed's textarea is append-only: its key handler has an empty branch for the
// arrow keys, so a typed draft can only be corrected with backspace. This model
// owns the draft and a cursor so editing behaves like any other input field.
//
// The cursor indexes code points, not UTF-16 units, so one keypress never lands
// between the halves of a surrogate pair.
export function createEditor(initial = '') {
  let chars = Array.from(initial);
  let index = chars.length;
  // Paste blocks: spans over `chars` created by insertPaste. A collapsed span
  // renders as one "pasted N lines" cell and behaves as one atom; an expanded
  // span is ordinary editable text that togglePaste can fold back.
  let blocks = []; // { start, end, collapsed } — sorted, non-overlapping

  const clamp = () => {
    if (index < 0) index = 0;
    if (index > chars.length) index = chars.length;
  };

  const normalize = () => {
    blocks = blocks.filter((b) => b.start < b.end && b.end <= chars.length)
      .sort((a, b) => a.start - b.start);
  };

  // Splices at `at` shift spans that start at or after it; a span an edit cuts
  // into grows or shrinks with it. Whole-block deletions are the caller's job.
  const shiftFrom = (at, delta) => {
    for (const b of blocks) {
      if (b.start >= at) { b.start += delta; b.end += delta; }
      else if (b.end > at) b.end += delta;
    }
    normalize();
  };

  const collapsedEndingAt = (pos) => blocks.find((b) => b.collapsed && b.end === pos) ?? null;
  const collapsedStartingAt = (pos) => blocks.find((b) => b.collapsed && b.start === pos) ?? null;
  const collapsedAt = (pos) => blocks.find((b) => b.collapsed && b.start <= pos && pos < b.end) ?? null;

  // Deletes [from, to). A collapsed marker deletes whole, so the range widens
  // over every collapsed span it touches.
  const deleteRange = (from, to) => {
    if (from >= to) return;
    let lo = from;
    let hi = to;
    const doomed = new Set();
    for (const b of blocks) {
      if (b.collapsed && b.start < hi && b.end > lo) {
        doomed.add(b);
        lo = Math.min(lo, b.start);
        hi = Math.max(hi, b.end);
      }
    }
    chars.splice(lo, hi - lo);
    blocks = blocks.filter((b) => !doomed.has(b));
    shiftFrom(lo, -(hi - lo));
  };

  const insertText = (text) => {
    const added = Array.from(String(text ?? ''));
    if (added.length === 0) return;
    chars.splice(index, 0, ...added);
    shiftFrom(index, added.length);
    index += added.length;
  };

  const insertPaste = (text) => {
    const value = String(text ?? '');
    if (value.split('\n').length < 2) { insertText(value); return false; }
    const added = Array.from(value);
    const start = index;
    chars.splice(index, 0, ...added);
    shiftFrom(index, added.length);
    blocks.push({ start, end: start + added.length, collapsed: true });
    normalize();
    index = start + added.length;
    return true;
  };

  // The draft as the terminal sees it: a collapsed block is one cell, its
  // hidden newlines do not start new lines. Each line carries its char range.
  function layout() {
    const lines = [];
    let runs = [];
    let lineStart = 0;
    let i = 0;
    while (i < chars.length) {
      const block = collapsedAt(i);
      if (block) { runs.push({ block: true, from: block.start, to: block.end }); i = block.end; continue; }
      if (chars[i] === '\n') {
        lines.push({ runs, from: lineStart, to: i });
        runs = [];
        lineStart = i + 1;
        i++;
        continue;
      }
      const from = i;
      while (i < chars.length && chars[i] !== '\n' && !collapsedAt(i)) i++;
      runs.push({ block: false, from, to: i });
    }
    lines.push({ runs, from: lineStart, to: chars.length });
    return lines;
  }

  const lineAt = (pos, lines = layout()) => {
    for (const line of lines) if (pos >= line.from && pos <= line.to) return line;
    return lines[lines.length - 1] ?? { runs: [], from: 0, to: 0 };
  };

  const columnAt = (pos, line) => {
    let cells = 0;
    for (const run of line.runs) {
      if (run.block) {
        if (pos < run.to) return cells;
        cells += 1;
      } else {
        if (pos < run.to) return cells + (pos - run.from);
        cells += run.to - run.from;
      }
    }
    return cells;
  };

  const posAtColumn = (line, column) => {
    let cells = 0;
    for (const run of line.runs) {
      if (run.block) {
        if (column === cells) return run.from;
        cells += 1;
        continue;
      }
      const width = run.to - run.from;
      if (column < cells + width) return run.from + (column - cells);
      cells += width;
    }
    return line.to;
  };

  const displayValue = (label = (count) => `pasted ${count} lines`) => {
    let out = '';
    let i = 0;
    for (const b of blocks.filter((x) => x.collapsed).sort((a, b) => a.start - b.start)) {
      out += chars.slice(i, b.start).join('');
      const count = chars.slice(b.start, b.end).filter((c) => c === '\n').length + 1;
      out += label(count);
      i = b.end;
    }
    return out + chars.slice(i).join('');
  };

  const togglePaste = () => {
    const b = blocks.find((x) => x.start <= index && index <= x.end) ?? null;
    if (!b) return false;
    b.collapsed = !b.collapsed;
    if (b.collapsed) index = b.end;
    return true;
  };

  return {
    value() { return chars.join(''); },
    cursor() { return index; },

    cursorPosition() {
      const lines = layout();
      const line = lineAt(index, lines);
      return { line: lines.indexOf(line), column: columnAt(index, line) };
    },

    insert: insertText,
    insertPaste,
    togglePaste,
    displayValue,

    backspace() {
      const block = collapsedEndingAt(index);
      if (block) {
        deleteRange(block.start, block.end);
        index = block.start;
        return;
      }
      if (index === 0) return;
      deleteRange(index - 1, index);
      index--;
    },

    del() {
      const block = collapsedStartingAt(index);
      if (block) { deleteRange(block.start, block.end); return; }
      if (index >= chars.length) return;
      deleteRange(index, index + 1);
    },

    left() {
      const block = collapsedEndingAt(index);
      index = block ? block.start : index - 1;
      clamp();
    },

    right() {
      const block = collapsedStartingAt(index);
      index = block ? block.end : index + 1;
      clamp();
    },

    home() { index = lineAt(index).from; clamp(); },
    end() { index = lineAt(index).to; clamp(); },

    killLine() {
      deleteRange(index, lineAt(index).to);
    },

    killToStart() {
      const start = lineAt(index).from;
      deleteRange(start, index);
      index = start;
    },

    killWord() {
      const start = lineAt(index).from;
      let from = index;
      const stepBack = () => {
        const block = blocks.find((b) => b.collapsed && b.start < from && from <= b.end);
        if (block) return { pos: block.start, ch: null };
        return { pos: from - 1, ch: chars[from - 1] };
      };
      while (from > start) {
        const p = stepBack();
        if (p.ch !== ' ') break;
        from = p.pos;
      }
      while (from > start) {
        const p = stepBack();
        if (p.ch === ' ') break;
        from = p.pos;
      }
      deleteRange(from, index);
      index = from;
    },

    up() {
      const lines = layout();
      const li = lines.findIndex((l) => index >= l.from && index <= l.to);
      if (li <= 0) return;
      index = posAtColumn(lines[li - 1], columnAt(index, lines[li]));
      clamp();
    },

    down() {
      const lines = layout();
      const li = lines.findIndex((l) => index >= l.from && index <= l.to);
      if (li < 0 || li >= lines.length - 1) return false;
      index = posAtColumn(lines[li + 1], columnAt(index, lines[li]));
      clamp();
      return true;
    },

    setValue(text) {
      chars = Array.from(String(text ?? ''));
      blocks = [];
      index = chars.length;
    },

    clear() {
      chars = [];
      blocks = [];
      index = 0;
    },
  };
}
