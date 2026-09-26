// Line diffs for the owner's edit preview in the notes viewer: what a drafted edit would change in a note,
// as a ```diff block (removed lines `-`, added lines `+`, a line of context around each change, long
// unchanged stretches folded), cut to fit one embed. Pure functions.

export type DiffOp = ' ' | '-' | '+';
export type DiffLine = { op: DiffOp; text: string };

/** Lines of context kept around each change. */
export const DIFF_CONTEXT_LINES = 1;
// Past this many LCS cells (lines × lines, after the common head and tail are set aside) the middle is
// shown as removed-then-added instead of aligned: notes are capped at 8,000 characters, so real notes
// never get near it.
const MAX_LCS_CELLS = 250_000;
const FENCE_OPEN = '```diff\n';
const FENCE_CLOSE = '\n```';
// Room kept for the "… N more lines" marker (newline included), and the shortest piece of a line worth
// showing when it has to be cut.
const MARKER_RESERVE = 24;
const MIN_PARTIAL_LINE = 40;

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return normalized.length === 0 ? [] : normalized.split('\n');
}

/**
 * The line diff turning `before` into `after`: unchanged lines, removals and additions in order, removals
 * before the additions that replace them (a longest-common-subsequence alignment).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (text: string): DiffLine => ({ op: ' ', text });
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle =
    middleA.length * middleB.length > MAX_LCS_CELLS
      ? [
          ...middleA.map((text): DiffLine => ({ op: '-', text })),
          ...middleB.map((text): DiffLine => ({ op: '+', text })),
        ]
      : alignedDiff(middleA, middleB);
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(endA).map(same)];
}

function alignedDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: '-', text: a[i++] });
    } else {
      out.push({ op: '+', text: b[j++] });
    }
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

/** Counts of removed and added lines. */
export function diffStats(lines: DiffLine[]): { removed: number; added: number } {
  return {
    removed: lines.filter((l) => l.op === '-').length,
    added: lines.filter((l) => l.op === '+').length,
  };
}

// A literal ``` inside a note would close the diff's fence early.
function fenceSafe(text: string): string {
  return text.replace(/```/g, '`​``');
}

/**
 * The diff as a ```diff block within `maxChars`: changed lines with DIFF_CONTEXT_LINES of context,
 * unchanged stretches folded into one `  ⋯ N unchanged lines` line, and when it still doesn't fit, cut
 * after the last whole line that does with a `… N more lines` marker. `before` absent: the note is new
 * (all additions); `after` absent: it is removed (all removals).
 */
export function renderDiff(before: string | undefined, after: string | undefined, maxChars: number): string {
  const lines = diffLines(before ?? '', after ?? '');
  if (!lines.some((l) => l.op !== ' ')) return '(no change to the text)';

  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.op === ' ') return;
    for (let k = index - DIFF_CONTEXT_LINES; k <= index + DIFF_CONTEXT_LINES; k++) {
      if (k >= 0 && k < lines.length) keep[k] = true;
    }
  });

  const rendered: string[] = [];
  let folded = 0;
  const flushFolded = () => {
    if (folded > 0) rendered.push(`  ⋯ ${folded} unchanged line${folded === 1 ? '' : 's'}`);
    folded = 0;
  };
  lines.forEach((line, index) => {
    if (!keep[index]) {
      folded++;
      return;
    }
    flushFolded();
    rendered.push(fenceSafe(line.text.length > 0 ? `${line.op} ${line.text}` : line.op).trimEnd() || ' ');
  });
  flushFolded();

  const budget = maxChars - FENCE_OPEN.length - FENCE_CLOSE.length;
  const body: string[] = [];
  let used = 0;
  for (let index = 0; index < rendered.length; index++) {
    const line = rendered[index];
    const separator = body.length > 0 ? 1 : 0;
    const reserve = index < rendered.length - 1 ? MARKER_RESERVE : 0;
    if (used + separator + line.length + reserve <= budget) {
      body.push(line);
      used += separator + line.length;
      continue;
    }
    // Out of room: cut inside this line when a useful piece of it fits, then say how much is left.
    const room = budget - used - separator - MARKER_RESERVE;
    let rest = rendered.length - index;
    if (room >= MIN_PARTIAL_LINE) {
      body.push(`${line.slice(0, room - 1)}…`);
      rest--;
    }
    if (rest > 0) body.push(`… ${rest} more line${rest === 1 ? '' : 's'}`);
    break;
  }
  return `${FENCE_OPEN}${body.join('\n')}${FENCE_CLOSE}`;
}
