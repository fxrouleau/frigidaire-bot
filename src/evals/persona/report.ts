// Aggregation and rendering of persona eval results: per-model means of the judge's rubric scores, the
// deterministic metrics and the hard checks, as a comparison table plus a per-scenario grid.
import { type JudgeVerdict, RUBRIC_DIMENSIONS, type RubricDimension, overallScore } from './judge';
import type { CheckResult, ReplyMetrics } from './metrics';

export type ScenarioRun = {
  model: string;
  scenarioId: string;
  title: string;
  reply: string;
  /** Set when the turn failed (provider error, or the bot posted its error reply). */
  error?: string;
  durationMs: number;
  /** USD spent by the candidate model's turn (chat + retrieval embeddings); undefined when unknown. */
  costUsd?: number;
  /** Host tools the model called during the turn, in order. */
  toolCalls: string[];
  metrics: ReplyMetrics;
  checks: CheckResult[];
  judge?: JudgeVerdict;
  judgeError?: string;
};

export type ModelSummary = {
  model: string;
  runs: number;
  errors: number;
  judged: number;
  /** Mean of the per-run overall scores (1-5), or null when nothing was judged. */
  overall: number | null;
  dimensions: Record<RubricDimension, number | null>;
  checksPassed: number;
  checksTotal: number;
  avgChars: number;
  avgSentences: number;
  /** Share of replies with at least one custom emoji. */
  emojiReplyRate: number;
  /** Replies with an assistant-speak / disclaimer tell. */
  styleTellReplies: number;
  totalCostUsd: number | null;
  avgDurationMs: number;
};

export type EvalReport = {
  version: 1;
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  models: string[];
  scenarioIds: string[];
  runs: ScenarioRun[];
  summary: ModelSummary[];
};

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarizeModel(model: string, runs: ScenarioRun[]): ModelSummary {
  const mine = runs.filter((r) => r.model === model);
  const judged = mine.filter((r): r is ScenarioRun & { judge: JudgeVerdict } => r.judge !== undefined);
  // Replies that exist; a failed turn has no reply worth measuring.
  const answered = mine.filter((r) => r.error === undefined);
  const costs = mine.map((r) => r.costUsd).filter((c): c is number => c !== undefined);

  const dimensions = {} as Record<RubricDimension, number | null>;
  for (const d of RUBRIC_DIMENSIONS) {
    dimensions[d] = mean(judged.map((r) => r.judge.scores[d].score));
  }
  const checks = mine.flatMap((r) => r.checks);

  return {
    model,
    runs: mine.length,
    errors: mine.length - answered.length,
    judged: judged.length,
    overall: mean(judged.map((r) => overallScore(r.judge))),
    dimensions,
    checksPassed: checks.filter((c) => c.passed).length,
    checksTotal: checks.length,
    avgChars: mean(answered.map((r) => r.metrics.chars)) ?? 0,
    avgSentences: mean(answered.map((r) => r.metrics.sentences)) ?? 0,
    emojiReplyRate:
      answered.length === 0 ? 0 : answered.filter((r) => r.metrics.customEmojis > 0).length / answered.length,
    styleTellReplies: answered.filter((r) => r.metrics.styleTells.length > 0).length,
    totalCostUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    avgDurationMs: mean(mine.map((r) => r.durationMs)) ?? 0,
  };
}

/** One summary per model, in the order the models were given. */
export function summarizeRuns(runs: ScenarioRun[], models: string[]): ModelSummary[] {
  return models.map((model) => summarizeModel(model, runs));
}

// ---- Text tables ----

function fixed(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits);
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const DIMENSION_HEADERS: Record<RubricDimension, string> = {
  brevity: 'brev',
  in_character: 'char',
  no_moralizing: 'nomor',
  answers_message: 'answer',
  emoji_discipline: 'emoji',
  memory_use: 'memory',
};

export function renderComparisonTable(summaries: ModelSummary[]): string {
  const header = [
    'model',
    'overall',
    ...RUBRIC_DIMENSIONS.map((d) => DIMENSION_HEADERS[d]),
    'checks',
    'chars',
    'sent',
    'emoji%',
    'tells',
    'errors',
    'cost',
    'avg s',
  ];
  const rows = summaries.map((s) => [
    s.model,
    fixed(s.overall),
    ...RUBRIC_DIMENSIONS.map((d) => fixed(s.dimensions[d], 1)),
    `${s.checksPassed}/${s.checksTotal}`,
    s.avgChars.toFixed(0),
    s.avgSentences.toFixed(1),
    `${Math.round(s.emojiReplyRate * 100)}%`,
    String(s.styleTellReplies),
    String(s.errors),
    s.totalCostUsd === null ? '—' : `$${s.totalCostUsd.toFixed(4)}`,
    (s.avgDurationMs / 1000).toFixed(1),
  ]);
  return renderTable(header, rows);
}

/** Scenario × model grid: the judge's overall score and the failed checks per cell. */
export function renderScenarioTable(runs: ScenarioRun[], models: string[], scenarioIds: string[]): string {
  const header = ['scenario', ...models];
  const rows = scenarioIds.map((id) => [
    id,
    ...models.map((model) => {
      const run = runs.find((r) => r.model === model && r.scenarioId === id);
      if (!run) return '';
      if (run.error !== undefined) return 'ERROR';
      const score = run.judge ? overallScore(run.judge).toFixed(1) : '—';
      const failed = run.checks.filter((c) => !c.passed).length;
      return failed > 0 ? `${score} (${failed}✗)` : score;
    }),
  ]);
  return renderTable(header, rows);
}
