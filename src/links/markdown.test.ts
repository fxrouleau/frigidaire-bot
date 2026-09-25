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
    ['https://x.com/u/status/1).', '(', 'https://x.com/u/status/1'],
  ])('%s after %j → %s', (url, before, expected) => {
    expect(trimLinkEnd(url, before)).toBe(expected);
  });

  // Underscores, checked against simple-markdown (what Discord's parser is built on): the trailing `_`
  // is trimmed only when Discord reads it as the end of italics/underline, not merely because some `_`
  // appears earlier in the message.
  it.each([
    // An italic phrase around the link, and `a_b link_` (Discord renders "b link" in italics).
    ['https://x.com/u/status/1_', '_look ', 'https://x.com/u/status/1'],
    ['https://x.com/a/status/1?s=46&t=AbC_', '@some_user ', 'https://x.com/a/status/1?s=46&t=AbC'],
    // Underline may span a lone `_` inside the link.
    ['https://x.com/some_user/status/1__', '__', 'https://x.com/some_user/status/1'],
    // Italics can't span a lone `_` inside the link: the trailing `_` is the share token's.
    ['https://x.com/some_user/status/1?t=abc_', 'hey_ ', 'https://x.com/some_user/status/1?t=abc_'],
    ['https://x.com/u/status/1?t=a_bc_', '_see ', 'https://x.com/u/status/1?t=a_bc_'],
    // The earlier `_` never opened italics: inside another link, already closed, escaped, or in code.
    ['https://x.com/u/status/2?t=abc_', 'https://x.com/foo_bar/status/1 ', 'https://x.com/u/status/2?t=abc_'],
    ['https://x.com/u/status/1?t=abc_', '_a_ ', 'https://x.com/u/status/1?t=abc_'],
    ['https://x.com/u/status/1?t=abc_', 'a\\_b ', 'https://x.com/u/status/1?t=abc_'],
    ['https://x.com/u/status/1?t=abc_', '`a_b` ', 'https://x.com/u/status/1?t=abc_'],
  ])('%s after %j → %s', (url, before, expected) => {
    expect(trimLinkEnd(url, before)).toBe(expected);
  });
});
