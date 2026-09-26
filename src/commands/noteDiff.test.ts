import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, renderDiff } from './noteDiff';

const note = (...lines: string[]) => lines.join('\n');

describe('diffLines', () => {
  it('aligns unchanged lines and puts a removal before the addition that replaces it', () => {
    const before = note('## Now', 'Plays Valorant most nights.', 'Works at the bakery.', '', '## Traits', 'Deadpan.');
    const after = note('## Now', 'Quit Valorant in August 2026.', 'Works at the bakery.', '', '## Traits', 'Deadpan.');
    expect(diffLines(before, after)).toEqual([
      { op: ' ', text: '## Now' },
      { op: '-', text: 'Plays Valorant most nights.' },
      { op: '+', text: 'Quit Valorant in August 2026.' },
      { op: ' ', text: 'Works at the bakery.' },
      { op: ' ', text: '' },
      { op: ' ', text: '## Traits' },
      { op: ' ', text: 'Deadpan.' },
    ]);
  });

  it('handles pure additions, pure removals and new or removed notes', () => {
    expect(diffStats(diffLines(note('a', 'c'), note('a', 'b', 'c')))).toEqual({ removed: 0, added: 1 });
    expect(diffStats(diffLines(note('a', 'b', 'c'), note('a', 'c')))).toEqual({ removed: 1, added: 0 });
    expect(diffLines('', note('x', 'y')).map((l) => l.op)).toEqual(['+', '+']);
    expect(diffLines(note('x', 'y'), '').map((l) => l.op)).toEqual(['-', '-']);
  });

  it('ignores line-ending and trailing-whitespace differences at the end', () => {
    expect(diffStats(diffLines('a\r\nb\n\n', 'a\nb'))).toEqual({ removed: 0, added: 0 });
  });
});

describe('renderDiff', () => {
  it('shows each change with a line of context and folds long unchanged stretches', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[10] = 'line 10, reworded';
    const text = renderDiff(lines.join('\n'), changed.join('\n'), 4000);
    expect(text).toBe(
      [
        '```diff',
        '  ⋯ 9 unchanged lines',
        '  line 9',
        '- line 10',
        '+ line 10, reworded',
        '  line 11',
        '  ⋯ 8 unchanged lines',
        '```',
      ].join('\n'),
    );
  });

  it('renders a new note as all additions and a removed one as all removals', () => {
    expect(renderDiff(undefined, note('## Now', 'Runs the MTG nights.'), 500)).toBe(
      '```diff\n+ ## Now\n+ Runs the MTG nights.\n```',
    );
    expect(renderDiff('Old topic.', undefined, 500)).toBe('```diff\n- Old topic.\n```');
  });

  it('says when the text did not change at all', () => {
    expect(renderDiff('same', 'same', 500)).toBe('(no change to the text)');
  });

  it("can't be closed early by a fence inside the note", () => {
    const text = renderDiff('before', 'uses ``` in a sentence', 500);
    expect(text.match(/```/g)).toHaveLength(2);
  });

  it('cuts a long diff to the budget and says how much is left', () => {
    const after = Array.from({ length: 200 }, (_, i) => `A fairly long added line number ${i} about the group.`).join('\n');
    const text = renderDiff('', after, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.startsWith('```diff\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
    expect(text).toMatch(/… \d+ more lines\n```$/);
  });

  it('cuts inside one giant line rather than showing nothing', () => {
    const text = renderDiff('', 'x'.repeat(5000), 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toMatch(/^```diff\n\+ x+…\n```$/);
  });

  it('stays fast on large rewrites', () => {
    const before = Array.from({ length: 700 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 700 }, (_, i) => `new ${i}`).join('\n');
    expect(diffStats(diffLines(before, after))).toEqual({ removed: 700, added: 700 });
  });
});
