// Just enough of Discord's markdown for link fixing to rewrite a URL without breaking what surrounds it.
//
// A link token is found by a greedy URL pattern, and Discord markdown wraps links in characters a URL
// may also contain. Two things go wrong without this module: a closing delimiter gets swallowed into
// the URL and replaced away (`||link||` lost its closing `||` and was reposted UNSPOILERED, `[t](link)`
// lost its `)`), and links the author deliberately put in code (`` `link` ``, fenced blocks) get
// rewritten even though Discord never embeds them.

export type Span = { start: number; end: number };

function runLength(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === '`') length++;
  return length;
}

/** Index of the next backtick run of exactly `length` at or after `from`, or -1. */
function findRun(text: string, from: number, length: number): number {
  let index = text.indexOf('`', from);
  while (index !== -1) {
    const run = runLength(text, index);
    if (run === length) return index;
    index = text.indexOf('`', index + run);
  }
  return -1;
}

/**
 * The ranges Discord renders as code: fenced blocks (```…```) and inline code (`…`, ``…``). Close to
 * Discord's own parser for chat purposes: a run of one or two backticks closes at the next run of the
 * same length, a run of three or more opens a fence that closes at the next ```, unmatched backticks
 * are literal text, and a backslash outside code escapes the next character.
 */
export function codeSpans(text: string): Span[] {
  const spans: Span[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char !== '`') {
      index++;
      continue;
    }
    const run = runLength(text, index);
    const fence = run >= 3;
    const close = fence ? text.indexOf('```', index + run) : findRun(text, index + run, run);
    if (close === -1) {
      index += run;
      continue;
    }
    const end = close + (fence ? runLength(text, close) : run);
    spans.push({ start: index, end });
    index = end;
  }
  return spans;
}

export function isInsideSpan(index: number, spans: readonly Span[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

// Sentence punctuation right after a link belongs to the sentence (Discord's own autolinker drops these too).
const SENTENCE_END = new Set(['.', ',', ':', ';', '!', '?', "'", '"']);
// Emphasis delimiters are only trimmed when the same character opens somewhere before the link: a
// `_` or `*` at the very end of a query string (base64-ish share tokens end in `_`) is otherwise kept.
const EMPHASIS = new Set(['*', '_', '~']);

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total++;
  return total;
}

/**
 * Trims markdown and sentence punctuation off the end of a matched URL so the replacement leaves it
 * in the message: `)` when it doesn't balance an opener inside the URL (masked links, parenthesized
 * links), `*` `_` `~` when the same delimiter opened earlier in the message (bold/italic/strikethrough),
 * and trailing sentence punctuation. `|`, backticks and square brackets never get this far: the URL
 * patterns exclude them.
 */
export function trimLinkEnd(url: string, textBefore: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    const head = url.slice(0, end);
    if (SENTENCE_END.has(char)) {
      end--;
    } else if (char === ')' && count(head, ')') > count(head, '(')) {
      end--;
    } else if (EMPHASIS.has(char) && textBefore.includes(char)) {
      end--;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}
