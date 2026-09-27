import { describe, expect, it } from 'vitest';
import {
  clampQuote,
  EVIDENCE_LIMITS,
  evidenceFromMessage,
  mergeEvidence,
  normalizeEvidence,
  parseEvidence,
  serializeEvidence,
} from './evidence';

const id = (n: number) => `12000000000000${String(n).padStart(5, '0')}`;

describe('normalizeEvidence', () => {
  it('keeps snowflake ids (sorted, deduped) and a clamped one-line quote', () => {
    expect(
      normalizeEvidence({ message_ids: [id(3), 'nope', id(1), id(3), 42], quote: ' said\nthis\u0007 ' }),
    ).toEqual({ messageIds: [id(1), id(3)], quote: 'said this' });
    expect(clampQuote('x'.repeat(500))).toHaveLength(EVIDENCE_LIMITS.quoteMaxChars);
  });

  it('is undefined when nothing usable is left, and reads its stored form', () => {
    expect(normalizeEvidence({ messageIds: ['x'] })).toBeUndefined();
    expect(normalizeEvidence('not json')).toBeUndefined();
    expect(normalizeEvidence(null)).toBeUndefined();
    const stored = serializeEvidence({ messageIds: [id(2)], quote: 'hi' });
    expect(parseEvidence(stored)).toEqual({ messageIds: [id(2)], quote: 'hi' });
    expect(serializeEvidence(undefined)).toBeNull();
    expect(evidenceFromMessage(undefined)).toBeUndefined();
    expect(evidenceFromMessage(id(5))).toEqual({ messageIds: [id(5)] });
  });
});

describe('mergeEvidence', () => {
  it('keeps where it started and the newest ids, and the newer quote', () => {
    const older = { messageIds: Array.from({ length: 10 }, (_, i) => id(i)), quote: 'first' };
    const newer = { messageIds: Array.from({ length: 10 }, (_, i) => id(100 + i)) };
    const merged = mergeEvidence(older, newer);
    expect(merged?.messageIds).toHaveLength(EVIDENCE_LIMITS.maxMessageIds);
    expect(merged?.messageIds.slice(0, 3)).toEqual([id(0), id(1), id(2)]);
    expect(merged?.messageIds.at(-1)).toBe(id(109));
    expect(merged?.quote).toBe('first');
    expect(mergeEvidence(older, { messageIds: [], quote: 'second' })?.quote).toBe('second');
    expect(mergeEvidence(undefined, newer)).toBe(newer);
  });
});
