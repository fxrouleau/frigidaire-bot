// query_costs: report OpenRouter spend per feature from the usage ledger (src/ai/usage.ts).
import { config } from '../../config';
import type { ToolDefinition } from '../types';
import { type UsageSummary, getUsageSummary, startOfEasternDay } from '../usage';
import { describeSpend } from '../usageFormat';

export const COST_PERIODS = ['today', 'week', 'month'] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

// Rolling windows of whole Eastern days ending today, so "this week" never means "since Monday".
const PERIOD_DAYS: Record<CostPeriod, number> = { today: 1, week: 7, month: 30 };
const PERIOD_LABELS: Record<CostPeriod, string> = {
  today: 'today',
  week: 'the past 7 days',
  month: 'the past 30 days',
};

function parsePeriod(raw: unknown): CostPeriod {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (COST_PERIODS as readonly string[]).includes(value) ? (value as CostPeriod) : 'week';
}

/** [since, until) for a period: from midnight Eastern `days - 1` days ago up to now. */
export function costPeriodRange(period: CostPeriod, now: number = Date.now()): { sinceMs: number; untilMs: number } {
  return { sinceMs: startOfEasternDay(now, -(PERIOD_DAYS[period] - 1)), untilMs: now };
}

/** The tool's answer: plain facts for the model to put in its own words. */
export function formatCostReport(period: CostPeriod, summary: UsageSummary): string {
  const spend = describeSpend(summary);
  const range = summary.fromDay === summary.toDay ? summary.fromDay : `${summary.fromDay} → ${summary.toDay}`;
  const lines = [`OpenRouter spend for ${PERIOD_LABELS[period]} (${range}, Eastern days, USD): ${spend.headline}.`];
  if (spend.byFeature) lines.push(`By feature: ${spend.byFeature}`);
  if (spend.topModels) lines.push(`Top models: ${spend.topModels}`);
  for (const note of spend.notes) lines.push(`Note: ${note}`);
  return lines.join('\n');
}

const queryCostsTool: ToolDefinition = {
  name: 'query_costs',
  description:
    'Look up what running the bot has cost in AI fees (OpenRouter, USD): total, per feature (chat, memory learner, embeddings, image generation, …) and top models. Use when someone asks how much the bot costs, what it spent today/this week/this month, or what the most expensive part of it is.',
  parameters: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: [...COST_PERIODS],
        description: '"today", "week" (the past 7 days incl. today) or "month" (the past 30 days incl. today).',
      },
    },
    required: ['period'],
    additionalProperties: false,
  },
  handler: async (_ctx, args) => {
    if (!config.costs.ledgerEnabled) {
      return 'Cost tracking is turned off on this bot, so there are no numbers to report.';
    }
    const period = parsePeriod(args.period);
    const { sinceMs, untilMs } = costPeriodRange(period);
    return formatCostReport(period, getUsageSummary(sinceMs, untilMs));
  },
};

export const costTools: ToolDefinition[] = [queryCostsTool];
