import { describe, expect, it } from 'vitest';
import { earlierPart, noteShapeWarnings, splitSections, withoutEarlier } from './sections';

const PROFILE = `Remi, the group's night owl.

## Now
Runs day shifts at a bakery (since 2026-08).

## Traits
Dry humor; answers questions with questions.

## Circles & people
- The MTG crew: Friday drafts.

## Earlier
- Back in 2017 played a lot of Overwatch.
### Old jobs
- Barista (2018–2020).

## Notes
Kept after Earlier.`;

describe('withoutEarlier', () => {
  it('drops the Earlier section and its subsections, keeps the rest', () => {
    const text = withoutEarlier(PROFILE);
    expect(text).toContain('## Now');
    expect(text).toContain('## Circles & people');
    expect(text).toContain('Kept after Earlier.');
    expect(text).not.toContain('Overwatch');
    expect(text).not.toContain('Barista');
  });

  it('returns a note without headings as it is, and ignores headings in code fences', () => {
    expect(withoutEarlier('  plain note  ')).toBe('plain note');
    const fenced = '## Now\n```\n## Earlier\n```\nstill now';
    expect(withoutEarlier(fenced)).toBe(fenced);
  });
});

describe('earlierPart', () => {
  it('returns only the dated footnotes', () => {
    expect(earlierPart(PROFILE)).toBe('## Earlier\n- Back in 2017 played a lot of Overwatch.\n### Old jobs\n- Barista (2018–2020).');
    expect(earlierPart('## Now\nx')).toBe('');
  });
});

describe('splitSections', () => {
  it('keeps the text before the first heading as a level-0 section', () => {
    const sections = splitSections(PROFILE);
    expect(sections[0]).toMatchObject({ heading: '', level: 0 });
    expect(sections.map((s) => s.heading)).toContain('Circles & people');
  });
});

describe('noteShapeWarnings', () => {
  it('accepts the profile shape and reports what is missing or out of order', () => {
    expect(noteShapeWarnings(PROFILE, 'profile')).toEqual([]);
    expect(noteShapeWarnings('## Earlier\nx\n## Now\ny', 'topic')).toEqual([
      'sections out of order (expected Now, Earlier)',
    ]);
    expect(noteShapeWarnings('just text', 'profile')).toEqual([
      'no "## Now" section',
      'no "## Traits" section',
      'no "## Circles & people" section',
    ]);
  });
});
