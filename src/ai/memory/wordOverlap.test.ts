import { describe, expect, it } from 'vitest';
import { wordOverlap } from './wordOverlap';

describe('wordOverlap', () => {
  it('returns 1.0 for identical strings', () => {
    expect(wordOverlap('Felix loves coding', 'Felix loves coding')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(wordOverlap('apples bananas cherries', 'dogs elephants foxes')).toBe(0.0);
  });

  it('returns > 0.6 for high meaningful overlap', () => {
    const score = wordOverlap('Felix lives in Toronto Canada', 'Felix lives in Montreal Canada');
    expect(score).toBeGreaterThan(0.6);
  });

  it('returns <= 0.6 for low meaningful overlap', () => {
    const score = wordOverlap('Lives in Toronto', 'Works as a plumber downtown');
    expect(score).toBeLessThanOrEqual(0.6);
  });

  it('returns 0 when at least one string is empty', () => {
    expect(wordOverlap('', 'hello world')).toBe(0);
    expect(wordOverlap('hello world', '')).toBe(0);
    expect(wordOverlap('', '')).toBe(0);
  });

  it('is case insensitive', () => {
    expect(wordOverlap('HELLO WORLD', 'hello world')).toBe(1.0);
  });

  it('handles single word strings', () => {
    expect(wordOverlap('Felix', 'Felix')).toBe(1.0);
    expect(wordOverlap('Felix', 'Alex')).toBe(0.0);
  });

  // Stop-word filtering tests
  it('returns low score for strings sharing only stop words', () => {
    const score = wordOverlap('Felix is in the house', 'Alex is in the park');
    expect(score).toBeLessThan(0.6);
  });

  it('returns low score for stop-word-heavy sentences with no meaningful overlap', () => {
    const score = wordOverlap('He is at the store', 'She was at the park');
    expect(score).toBeLessThan(0.6);
  });

  it('returns 0 when both strings are entirely stop words', () => {
    expect(wordOverlap('is the a', 'is the a')).toBe(0);
  });

  it('preserves meaningful overlap despite stop-word removal', () => {
    const score = wordOverlap('Felix loves programming Python', 'Felix enjoys programming Python');
    expect(score).toBeGreaterThan(0.6);
  });
});
