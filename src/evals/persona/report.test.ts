import { describe, expect, it } from 'vitest';
import { type JudgeVerdict, RUBRIC_DIMENSIONS, type RubricDimension } from './judge';
import { measureReply } from './metrics';
import { type ScenarioRun, renderComparisonTable, renderScenarioTable, summarizeModel, summarizeRuns } from './report';

function verdict(score: number, overrides: Partial<Record<RubricDimension, number>> = {}): JudgeVerdict {
  const scores = Object.fromEntries(
    RUBRIC_DIMENSIONS.map((d) => [d, { score: overrides[d] ?? score, reason: '' }]),
  ) as JudgeVerdict['scores'];
  return { scores, summary: '' };
}

function run(overrides: Partial<ScenarioRun> & Pick<ScenarioRun, 'model' | 'scenarioId'>): ScenarioRun {
  const reply = overrides.reply ?? 'short reply.';
  return {
    title: overrides.scenarioId,
    reply,
    durationMs: 1000,
    toolCalls: [],
    metrics: measureReply(reply, ['Ana']),
    checks: [{ name: 'replied', passed: true, detail: '' }],
    ...overrides,
  };
}

const RUNS: ScenarioRun[] = [
  run({ model: 'a', scenarioId: 's1', judge: verdict(5), costUsd: 0.001, durationMs: 2000 }),
  run({
    model: 'a',
    scenarioId: 's2',
    reply: 'Great question! <:KEKW:200000000000000001> Two sentences here.',
    judge: verdict(3, { brevity: 1 }),
    costUsd: 0.003,
    durationMs: 4000,
    checks: [
      { name: 'replied', passed: true, detail: '' },
      { name: 'no-style-tells', passed: false, detail: 'happy-to-help' },
    ],
  }),
  run({ model: 'b', scenarioId: 's1', reply: '', error: 'provider timeout', durationMs: 120_000 }),
  run({ model: 'b', scenarioId: 's2', judgeError: 'judge returned junk' }),
];

describe('summarizeModel', () => {
  it('averages the judge scores per dimension and overall, and the deterministic metrics', () => {
    const a = summarizeModel('a', RUNS);
    expect(a).toMatchObject({ model: 'a', runs: 2, errors: 0, judged: 2, checksPassed: 2, checksTotal: 3 });
    expect(a.dimensions.brevity).toBe(3); // (5 + 1) / 2
    expect(a.dimensions.in_character).toBe(4); // (5 + 3) / 2
    const secondOverall = (3 * (RUBRIC_DIMENSIONS.length - 1) + 1) / RUBRIC_DIMENSIONS.length;
    expect(a.overall).toBeCloseTo((5 + secondOverall) / 2);
    expect(a.emojiReplyRate).toBe(0.5);
    expect(a.styleTellReplies).toBe(1);
    expect(a.totalCostUsd).toBeCloseTo(0.004);
    expect(a.avgDurationMs).toBe(3000);
  });

  it('leaves failed turns out of the reply metrics and unjudged runs out of the scores', () => {
    const b = summarizeModel('b', RUNS);
    expect(b).toMatchObject({ runs: 2, errors: 1, judged: 0, overall: null, totalCostUsd: null });
    expect(b.dimensions.brevity).toBeNull();
    expect(b.avgChars).toBe('short reply.'.length);
  });

  it('is all zeros / nulls for a model with no runs', () => {
    expect(summarizeModel('c', RUNS)).toMatchObject({
      runs: 0,
      overall: null,
      avgChars: 0,
      emojiReplyRate: 0,
      totalCostUsd: null,
    });
  });
});

describe('summarizeRuns', () => {
  it('keeps the order the models were given in', () => {
    expect(summarizeRuns(RUNS, ['b', 'a']).map((s) => s.model)).toEqual(['b', 'a']);
  });
});

describe('renderComparisonTable', () => {
  it('prints one aligned row per model with a dash for unknown values', () => {
    const table = renderComparisonTable(summarizeRuns(RUNS, ['a', 'b']));
    const lines = table.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^model\s+overall\s+brev\s+char\s+nomor\s+answer\s+emoji\s+memory\s+checks/);
    expect(lines[1]).toMatch(/^-+ {2}-+/);
    expect(lines[2]).toMatch(/^a\s+\d\.\d\d\s+3\.0\s+4\.0/);
    expect(lines[2]).toContain('2/3');
    expect(lines[2]).toContain('$0.0040');
    expect(lines[3]).toMatch(/^b\s+—/);
    // Every row is as wide as the header's columns (right-aligned numbers).
    expect(new Set(lines.map((l) => l.length)).size).toBeLessThanOrEqual(2);
  });
});

describe('renderScenarioTable', () => {
  it('shows the overall score per cell, the failed-check count, errors and unjudged runs', () => {
    const table = renderScenarioTable(RUNS, ['a', 'b'], ['s1', 's2', 's3']);
    const [, , s1, s2, s3] = table.split('\n');
    expect(s1).toMatch(/^s1\s+5\.0\s+ERROR$/);
    expect(s2).toMatch(/^s2\s+\d\.\d \(1✗\)\s+—$/);
    expect(s3.trim()).toBe('s3');
  });
});
