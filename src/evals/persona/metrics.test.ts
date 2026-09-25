import { describe, expect, it } from 'vitest';
import { checkExpectations, countSentences, measureReply } from './metrics';
import type { Expectations } from './scenarioFile';

function expectations(overrides: Partial<Expectations> = {}): Expectations {
  return { notes: 'n/a', maxCustomEmojis: 1, mustMatch: [], mustNotMatch: [], ...overrides };
}

function failed(results: ReturnType<typeof checkExpectations>): string[] {
  return results.filter((r) => !r.passed).map((r) => r.name);
}

describe('countSentences', () => {
  it('counts terminal punctuation and line breaks as boundaries', () => {
    expect(countSentences('one. two! three?')).toBe(3);
    expect(countSentences('first line\nsecond line')).toBe(2);
    expect(countSentences('trailing thought…  and more')).toBe(2);
  });

  it('does not split on the dots inside a URL or count emoji-only fragments', () => {
    expect(countSentences('look at https://example.com/a.b.c first')).toBe(1);
    expect(countSentences('lmao. <:KEKW:200000000000000001>')).toBe(1);
  });

  it('is zero for an empty or emoji-only reply', () => {
    expect(countSentences('')).toBe(0);
    expect(countSentences('<:KEKW:200000000000000001>')).toBe(0);
  });
});

describe('measureReply', () => {
  it('counts characters, custom and unicode emojis', () => {
    const metrics = measureReply('  nah <:KEKW:200000000000000001> <a:pog:200000000000000002> 💀  ', ['Ana']);
    expect(metrics.chars).toBe('nah <:KEKW:200000000000000001> <a:pog:200000000000000002> 💀'.length);
    expect(metrics.customEmojis).toBe(2);
    expect(metrics.unicodeEmojis).toBe(1);
  });

  it("flags a reply that opens with the speaker's name, but not a word that merely starts with it", () => {
    expect(measureReply('Ana, you fell off', ['Ana']).startsWithName).toBe(true);
    expect(measureReply('@ana lol', ['Ana']).startsWithName).toBe(true);
    expect(measureReply('Anatomy says no', ['Ana']).startsWithName).toBe(false);
    expect(measureReply('lol ana', ['Ana']).startsWithName).toBe(false);
  });

  it('detects assistant-speak and disclaimer tells', () => {
    expect(measureReply("As an AI, I can't have opinions.", ['Ana']).styleTells).toEqual(['as-an-ai']);
    expect(measureReply("Great question! Let me know if you need more.", ['Ana']).styleTells).toEqual([
      'happy-to-help',
      'let-me-know',
    ]);
    expect(measureReply("It's important to remember to keep it respectful.", ['Ana']).styleTells).toEqual([
      'important-to',
    ]);
    expect(measureReply('9800X3D, not close', ['Ana']).styleTells).toEqual([]);
  });
});

describe('checkExpectations', () => {
  it('passes a short, clean reply against the universal rules', () => {
    const reply = 'pineapple wins, fight me';
    expect(failed(checkExpectations(reply, measureReply(reply, ['Ana']), expectations()))).toEqual([]);
  });

  it('fails an empty reply, style tells, a name opener and too many emojis', () => {
    const empty = checkExpectations('', measureReply('', ['Ana']), expectations());
    expect(failed(empty)).toEqual(['replied']);

    const reply = 'Ana, great question! <:a:200000000000000001> <:b:200000000000000002>';
    expect(failed(checkExpectations(reply, measureReply(reply, ['Ana']), expectations()))).toEqual([
      'no-style-tells',
      'no-name-opener',
      'max-custom-emojis',
    ]);
  });

  it('applies length bounds only when the scenario sets them', () => {
    const reply = 'One. Two. Three. Four.';
    const metrics = measureReply(reply, ['Ana']);
    expect(failed(checkExpectations(reply, metrics, expectations()))).toEqual([]);
    expect(
      failed(checkExpectations(reply, metrics, expectations({ maxSentences: 3, maxChars: 10, minChars: 100 }))),
    ).toEqual(['max-chars', 'min-chars', 'max-sentences']);
  });

  it('matches mustMatch / mustNotMatch case-insensitively and reports what was found', () => {
    const reply = 'Turn off XMP, then run MemTest. Just kidding, buy a new PC.';
    const results = checkExpectations(
      reply,
      measureReply(reply, ['Ana']),
      expectations({ mustMatch: ['xmp', 'bios'], mustNotMatch: ['just kidding'] }),
    );
    expect(failed(results)).toEqual(['must-match /bios/', 'must-not-match /just kidding/']);
    expect(results.find((r) => r.name === 'must-not-match /just kidding/')?.detail).toBe('found "Just kidding"');
  });

  it("checks the memory store after the turn when the scenario asks (a correction was saved, the stale fact is gone)", () => {
    const reply = 'congrats on selling out';
    const exp = expectations({
      memoryAfter: { activeMustMatch: ['Shopify'], activeMustNotMatch: ['Ubisoft'] },
    });
    const metrics = measureReply(reply, ['Ana']);

    expect(failed(checkExpectations(reply, metrics, exp, ['Ana: Ana works at Shopify.']))).toEqual([]);
    expect(failed(checkExpectations(reply, metrics, exp, ['Ana: Ana works at Ubisoft.']))).toEqual([
      'memory-has /Shopify/',
      'memory-lacks /Ubisoft/',
    ]);
  });
});
