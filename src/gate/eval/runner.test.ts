import { describe, expect, it, vi } from 'vitest';
import type { AddressedInput } from '../addressed';
import type { GateEvalCase, SourcedCase } from './cases';
import {
  EVAL_THRESHOLDS,
  type EvalResult,
  confusionAt,
  formatMisclassified,
  formatTable,
  misclassified,
  runCases,
} from './runner';

const NAMES = ['fridge', 'bot'];

function sourced(id: string, label: boolean, text: string, extra: Partial<GateEvalCase> = {}): SourcedCase {
  return { source: 'cases.json', case: { id, label, context: [], message: { author: 'Marco', text }, ...extra } };
}

function result(id: string, label: boolean, probability: number | undefined, prefilter = true): EvalResult {
  return { id, source: 'cases.json', label, text: id, probability, prefilter };
}

describe('runCases', () => {
  it('classifies every case with the live input and records whether the prefilter passes it', async () => {
    const seen: AddressedInput[] = [];
    const classify = vi.fn(async (input: AddressedInput) => {
      seen.push(input);
      return input.message.text.includes('fridge') ? 0.9 : 0.1;
    });
    const progress: Array<[number, number]> = [];
    const cases = [
      sourced('a', true, 'fridge who wins'),
      sourced('b', false, 'why tho', { botLastSpokeSecondsAgo: 20, talkingWithBot: true }),
      sourced('c', false, 'gg'),
    ];

    const results = await runCases(cases, classify, { names: NAMES, followupSeconds: 120, concurrency: 2 }, (d, t) =>
      progress.push([d, t]),
    );

    expect(results.map((r) => [r.id, r.probability, r.prefilter])).toEqual([
      ['a', 0.9, true],
      ['b', 0.1, true],
      ['c', 0.1, false],
    ]);
    expect(seen.find((input) => input.message.text === 'why tho')).toMatchObject({
      nicknames: NAMES,
      secondsSinceBotSpoke: 20,
      authorIsBotsPartner: true,
    });
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it('counts a classifier failure as no answer instead of aborting the run', async () => {
    const results = await runCases(
      [sourced('a', true, 'fridge hi')],
      async () => {
        throw new Error('HTTP 500');
      },
      { names: NAMES, followupSeconds: 120 },
    );
    expect(results[0].probability).toBeUndefined();
  });
});

describe('confusionAt', () => {
  const results = [
    result('tp', true, 0.95),
    result('fn-low', true, 0.55),
    result('fn-none', true, undefined),
    result('fp', false, 0.8),
    result('tn', false, 0.1),
    result('fp-filtered', false, 0.99, false),
  ];

  it('computes precision, recall and F1 for the model alone', () => {
    const c = confusionAt(results, 0.7, false);
    expect(c).toMatchObject({ tp: 1, fp: 2, fn: 2, tn: 1 });
    expect(c.precision).toBeCloseTo(1 / 3);
    expect(c.recall).toBeCloseTo(1 / 3);
    expect(c.f1).toBeCloseTo(1 / 3);
  });

  it('end to end, drops what the prefilter would never send', () => {
    const c = confusionAt(results, 0.7, true);
    expect(c).toMatchObject({ tp: 1, fp: 1, fn: 2, tn: 2 });
    expect(c.precision).toBeCloseTo(0.5);
  });

  it('leaves undefined ratios when there is nothing to divide', () => {
    const c = confusionAt([result('tn', false, 0.1)], 0.5, false);
    expect(c).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 1, precision: undefined, recall: undefined, f1: undefined });
  });
});

describe('reporting', () => {
  const results = [result('a', true, 0.95), result('b', true, 0.6), result('c', false, 0.75), result('d', false, 0.2)];

  it('prints one row per threshold', () => {
    const table = formatTable(results, false).split('\n');
    expect(table).toHaveLength(EVAL_THRESHOLDS.length + 1);
    expect(table[0]).toMatch(/^threshold\s+precision\s+recall\s+f1/);
    // At 0.7: a (tp), b (fn), c (fp), d (tn).
    expect(table.find((row) => row.startsWith('0.70'))).toMatch(/50\.0%\s+50\.0%\s+50\.0%\s+1\s+1\s+1\s+1$/);
    expect(formatTable([], false)).toContain('n/a');
  });

  it('lists misclassified cases, most confidently wrong first', () => {
    const wrong = misclassified([...results, result('e', true, undefined)], 0.7, false);
    expect(wrong.map((r) => r.id)).toEqual(['e', 'b', 'c']);

    const text = formatMisclassified(
      [{ ...result('b', true, 0.6), note: 'follow-up', text: 'why tho' }, result('x', false, 0.9, false)],
      0.7,
      true,
    );
    expect(text).toBe('MISSED  p=0.60    b (cases.json): "why tho" — follow-up');
    expect(formatMisclassified([result('a', true, 0.95)], 0.7, true)).toBe('(none)');
  });

  it('flags cases the prefilter drops', () => {
    const text = formatMisclassified([result('missed', true, 0.9, false)], 0.7, true);
    expect(text).toContain('[prefilter drops it]');
  });
});
