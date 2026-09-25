import { describe, expect, it } from 'vitest';
import type { UsageSummary, UsageTotals } from './usage';
import { describeSpend, formatCount, formatUsd } from './usageFormat';

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedRequests: 0, ...overrides };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    fromDay: '2026-09-18',
    toDay: '2026-09-24',
    total: totals(),
    byFeature: [],
    byModel: [],
    trackedSince: '2026-09-01',
    ...overrides,
  };
}

describe('formatUsd', () => {
  it.each([
    [0, '$0.00'],
    [-1, '$0.00'],
    [Number.NaN, '$0.00'],
    [12.345, '$12.35'],
    [1, '$1.00'],
    [0.42, '$0.42'],
    [0.125, '$0.125'],
    [0.0042, '$0.0042'],
    [0.00015, '$0.00015'],
    [0.00000005, '<$0.0001'],
  ])('%s → %s', (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });
});

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [850, '850'],
    [1000, '1k'],
    [12_345, '12.3k'],
    [4_100_000, '4.1M'],
  ])('%s → %s', (count, expected) => {
    expect(formatCount(count)).toBe(expected);
  });
});

describe('describeSpend', () => {
  it('renders headline, features and the top models', () => {
    const text = describeSpend(
      summary({
        total: totals({ requests: 1234, promptTokens: 1_400_000, completionTokens: 52_000, costUsd: 3.21 }),
        byFeature: [
          { feature: 'chat', ...totals({ requests: 800, costUsd: 2.1 }) },
          { feature: 'learner', ...totals({ requests: 48, costUsd: 0.6 }) },
          { feature: 'embedding', ...totals({ requests: 1, costUsd: 0.0001 }) },
        ],
        byModel: [
          { model: 'a', ...totals({ requests: 1, costUsd: 2 }) },
          { model: 'b', ...totals({ requests: 2, costUsd: 1 }) },
          { model: 'c', ...totals({ requests: 3, costUsd: 0.2 }) },
          { model: 'd', ...totals({ requests: 4, costUsd: 0.01 }) },
        ],
      }),
    );

    expect(text.headline).toBe('$3.21 over 1.2k calls (1.4M prompt + 52k completion tokens)');
    expect(text.byFeature).toBe('chat $2.10 (800 calls) · learner $0.60 (48 calls) · embedding $0.0001 (1 call)');
    expect(text.topModels).toBe('a $2.00 (1 call) · b $1.00 (2 calls) · c $0.20 (3 calls)');
    expect(text.notes).toEqual([]);
  });

  it('says so when nothing was recorded', () => {
    const text = describeSpend(summary());
    expect(text.headline).toBe('nothing recorded');
    expect(text.byFeature).toBe('');
    expect(text.topModels).toBe('');
  });

  it('notes unpriced calls and a range that starts before tracking did', () => {
    const text = describeSpend(
      summary({ total: totals({ requests: 5, costUsd: 0.1, unpricedRequests: 2 }), trackedSince: '2026-09-22' }),
    );
    expect(text.notes).toEqual([
      '2 calls reported no cost and are not in the total.',
      'Cost tracking started 2026-09-22; earlier days are not covered.',
    ]);
  });

  it('caps the feature list and says how many were left out', () => {
    const byFeature = Array.from({ length: 10 }, (_, i) => ({ feature: `f${i}`, ...totals({ requests: 1 }) }));
    const text = describeSpend(summary({ byFeature }), { maxFeatures: 3 });
    expect(text.byFeature).toBe('f0 $0.00 (1 call) · f1 $0.00 (1 call) · f2 $0.00 (1 call) · +7 more');
  });
});
