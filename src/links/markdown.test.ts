import { describe, expect, it } from 'vitest';
import { codeSpans, isInsideSpan, trimLinkEnd } from './markdown';

describe('codeSpans', () => {
  it('finds inline code, double-backtick code and fenced blocks', () => {
    const text = 'a `b` c ``d ` e`` f ```\ng\n``` h';
    const spans = codeSpans(text);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual(['`b`', '``d ` e``', '```\ng\n```']);
  });

  it('treats unmatched backticks as text', () => {
    expect(codeSpans('a ` b')).toEqual([]);
    expect(codeSpans('```never closed')).toEqual([]);
  });

  it('honors backslash escapes outside code', () => {
    expect(codeSpans('\\`not code`')).toEqual([]);
  });

  it('reports membership by index', () => {
    const spans = codeSpans('x `code` y');
    expect(isInsideSpan(2, spans)).toBe(true);
    expect(isInsideSpan(7, spans)).toBe(true);
    expect(isInsideSpan(8, spans)).toBe(false);
  });
});

describe('trimLinkEnd', () => {
  it.each([
    ['https://x.com/u/status/1)', '[t](', 'https://x.com/u/status/1'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'see ', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['https://x.com/u/status/1**', '**', 'https://x.com/u/status/1'],
    ['https://x.com/u/status/1_', 'hey _', 'https://x.com/u/status/1'],
    ['https://x.com/u/status/1?igsh=abc_', 'no italics ', 'https://x.com/u/status/1?igsh=abc_'],
    ['https://x.com/u/status/1~~', '~~', 'https://x.com/u/status/1'],
    ['https://x.com/u/status/1.', 'end of sentence ', 'https://x.com/u/status/1'],
    ['https://x.com/u/status/1?!', 'what ', 'https://x.com/u/status/1'],
    ['https://x.com/u/status/1]', '[', 'https://x.com/u/status/1'],
    ['https://x.com/u/status/1).', '(', 'https://x.com/u/status/1'],
  ])('%s after %j → %s', (url, before, expected) => {
    expect(trimLinkEnd(url, before)).toBe(expected);
  });
});
