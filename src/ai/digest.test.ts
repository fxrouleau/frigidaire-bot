import { describe, expect, it } from 'vitest';
import { splitMessage } from '../utils';
import {
  type BuildDigestOptions,
  type CaptureMeta,
  buildDigest,
  summarizeErrorCaptures,
} from './digest';

const WATERMARK = new Date('2026-06-10T00:00:00Z');

// updated_at strings in SQLite format. Anything on the 11th is "new this week" (>= watermark);
// anything in early June is "standing".
const NEW = '2026-06-11 12:00:00';
const OLD = '2026-06-01 12:00:00';

function baseOpts(overrides: Partial<BuildDigestOptions> = {}): BuildDigestOptions {
  return {
    periodStart: new Date('2026-06-12T00:00:00Z'),
    periodEnd: new Date('2026-06-19T00:00:00Z'),
    watermark: WATERMARK,
    signals: [],
    failures: [],
    captures: { total: 0, capped: false, byType: [] },
    ...overrides,
  };
}

describe('buildDigest', () => {
  it('renders the full digest: header, grouped signals, failure counts, captures, backlog', () => {
    const digest = buildDigest(
      baseOpts({
        signals: [
          { category: 'capability_gap', content: 'Cannot read receipts', updated_at: NEW },
          { category: 'capability_gap', content: 'Cannot react to clips', updated_at: OLD },
          { category: 'pain_point', content: 'Responses too long', updated_at: NEW },
        ],
        failures: [
          { category: 'tool_error', updated_at: NEW },
          { category: 'tool_error', updated_at: NEW },
          { category: 'parse_failure', updated_at: NEW },
          { category: 'missing_context', updated_at: OLD }, // standing — not counted this week
        ],
        captures: {
          total: 9,
          capped: true,
          byType: [
            { label: '429 rate_limit', count: 6 },
            { label: '500 upstream', count: 2 },
            { label: 'ECONNRESET', count: 1 },
          ],
        },
      }),
    );

    expect(digest).toContain('🩺 Weekly self-diagnosis digest · 2026-06-12 → 2026-06-19');
    expect(digest).toContain('Improvement signals — 3 active (2 new this week)');
    expect(digest).toContain('  capability_gap (2):');
    expect(digest).toContain('   🆕 Cannot read receipts');
    expect(digest).toContain('      Cannot react to clips');
    expect(digest).toContain('  pain_point (1):');
    expect(digest).toContain('   🆕 Responses too long');
    expect(digest).toContain('Runtime failures logged this week — 3');
    expect(digest).toContain('  tool_error: 2   parse_failure: 1');
    expect(digest).not.toContain('missing_context'); // standing failure excluded from this-week counts
    expect(digest).toContain('AI errors captured (data/debug) — 9 (≥, capped at 50)');
    expect(digest).toContain('  429 rate_limit ×6 · 500 upstream ×2 · ECONNRESET ×1');
    expect(digest).toContain('Backlog totals: 7 active self-diagnosis items.');
  });

  it('partitions 🆕 vs standing strictly by the watermark', () => {
    const digest = buildDigest(
      baseOpts({
        signals: [
          { category: 'feature_request', content: 'fresh idea', updated_at: NEW },
          { category: 'feature_request', content: 'old idea', updated_at: OLD },
        ],
      }),
    );
    expect(digest).toContain('   🆕 fresh idea');
    expect(digest).toContain('      old idea');
  });

  it('omits the (≥, capped) note when the capture dir is not full', () => {
    const digest = buildDigest(
      baseOpts({
        signals: [{ category: 'pain_point', content: 'x', updated_at: NEW }],
        captures: { total: 3, capped: false, byType: [{ label: '500 upstream', count: 3 }] },
      }),
    );
    expect(digest).toContain('AI errors captured (data/debug) — 3');
    expect(digest).not.toContain('capped at 50');
  });

  it('caps each category at 10 rendered items but reports the true count in the header', () => {
    const signals = Array.from({ length: 12 }, (_, i) => ({
      category: 'capability_gap',
      content: `gap number ${i}`,
      updated_at: NEW,
    }));
    const digest = buildDigest(baseOpts({ signals }));

    expect(digest).toContain('  capability_gap (12):');
    expect(digest).toContain('gap number 9'); // 10th item (0-indexed) shown
    expect(digest).not.toContain('gap number 10'); // 11th item dropped by the display cap
    expect(digest).not.toContain('gap number 11');
  });

  it('collapses to a single terse line on a quiet week (nothing new)', () => {
    const digest = buildDigest(
      baseOpts({
        signals: [{ category: 'capability_gap', content: 'old', updated_at: OLD }],
        failures: [{ category: 'tool_error', updated_at: OLD }],
        captures: { total: 4, capped: false, byType: [] },
      }),
    );
    expect(digest).toContain('No new self-diagnosis signals this week. 2 active in backlog, 4 AI errors captured.');
    expect(digest).not.toContain('Improvement signals');
    expect(digest).not.toContain('Runtime failures');
  });

  it('treats a null watermark (first run ever) as everything-is-new', () => {
    const digest = buildDigest(
      baseOpts({
        watermark: null,
        signals: [{ category: 'capability_gap', content: 'first', updated_at: OLD }],
      }),
    );
    expect(digest).toContain('Improvement signals — 1 active (1 new this week)');
    expect(digest).toContain('   🆕 first');
  });

  it('splits an oversized digest into <=2000-char chunks via splitMessage', () => {
    const signals = Array.from({ length: 4 }, (_, i) => ({
      category: 'capability_gap',
      content: `${'long signal content '.repeat(30)} #${i}`,
      updated_at: NEW,
    }));
    const digest = buildDigest(baseOpts({ signals }));
    expect(digest.length).toBeGreaterThan(2000);

    const chunks = splitMessage(digest);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe('summarizeErrorCaptures', () => {
  const SINCE = new Date('2026-06-10T00:00:00Z');

  it('groups by status/error-kind, sorted by count desc', () => {
    const captures: CaptureMeta[] = [
      { timestamp: '2026-06-11T00:00:00Z', status: 429, message: '429 Too Many Requests' },
      { timestamp: '2026-06-11T01:00:00Z', status: 429, message: 'Rate limit exceeded' },
      { timestamp: '2026-06-11T02:00:00Z', status: 500, message: 'Internal Server Error' },
      { timestamp: '2026-06-11T03:00:00Z', message: 'read ECONNRESET' },
    ];
    const summary = summarizeErrorCaptures(captures, SINCE);

    expect(summary.total).toBe(4);
    expect(summary.capped).toBe(false);
    expect(summary.byType[0]).toEqual({ label: '429 rate_limit', count: 2 });
    expect(summary.byType).toContainEqual({ label: '500 upstream', count: 1 });
    expect(summary.byType).toContainEqual({ label: 'ECONNRESET', count: 1 });
  });

  it('excludes captures older than `since`', () => {
    const captures: CaptureMeta[] = [
      { timestamp: '2026-06-11T00:00:00Z', status: 500, message: 'recent' },
      { timestamp: '2026-06-09T00:00:00Z', status: 500, message: 'too old' },
    ];
    const summary = summarizeErrorCaptures(captures, SINCE);
    expect(summary.total).toBe(1);
  });

  it('flags capped=true once the dir holds MAX_CAPTURES (50) files', () => {
    const make = (n: number): CaptureMeta[] =>
      Array.from({ length: n }, (_, i) => ({
        timestamp: '2026-06-11T00:00:00Z',
        status: 500,
        message: `err ${i}`,
      }));

    expect(summarizeErrorCaptures(make(49), SINCE).capped).toBe(false);
    const full = summarizeErrorCaptures(make(50), SINCE);
    expect(full.capped).toBe(true);
    expect(full.total).toBe(50);
  });

  it('handles the empty case', () => {
    expect(summarizeErrorCaptures([], SINCE)).toEqual({ total: 0, capped: false, byType: [] });
  });
});
