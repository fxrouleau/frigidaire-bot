// Per-feature attribution for OpenRouter spend.
//
// Every OpenRouter call passes `featureRequestOptions(feature)` as the OpenAI SDK's per-request options
// (the second argument of `create()`). The shared client's fetch (src/ai/usageFetch.ts) reads that tag
// back off the request, strips it, and after a successful JSON response records the response's `model`
// and `usage` (tokens + cost) here. OpenRouter includes usage and cost in every response (the old
// `usage: { include: true }` request flag is deprecated and a no-op), so no request body is touched.
// Calls that bypass the SDK (the decisions endpoint) report through recordUsage() directly.
//
// The ledger is one bot.db table keyed by (Eastern calendar day, feature, model): a handful of rows per
// day, so it is never pruned. Eastern days because that is how the group (and query_costs) talk about
// "today" and "this week".
import { config } from '../config';
import { logger } from '../logger';
import { getBotDb } from '../storage/botDb';
import { easternParts, easternWallClockToDate } from './utils';

export const FEATURE_HEADER = 'X-Frigidaire-Feature';

export type UsageFeature =
  | 'chat'
  | 'summary'
  | 'image'
  | 'learner'
  | 'self_improvement'
  | 'emoji_caption'
  | 'embedding'
  | 'judge'
  | 'gate'
  | 'transcription'
  | 'video'
  | 'command'
  | 'wrapped'
  | 'birthday'
  | 'ramble'
  | 'auto_react'
  | 'eval'
  | 'other';

/** Per-request SDK options that tag a call with its feature. */
export function featureRequestOptions(feature: UsageFeature): { headers: Record<string, string> } {
  return { headers: { [FEATURE_HEADER]: feature } };
}

export type UsageEntry = {
  feature: UsageFeature;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** USD, as reported by OpenRouter. Absent ⇒ the call is counted as "unpriced". */
  cost?: number;
  /** When the call happened (epoch ms); defaults to now. */
  at?: number;
};

/**
 * A usage row whose feature came off the wire (the request's tag header). Any sane slug is kept as-is
 * rather than checked against UsageFeature, so a feature added to the union later is never silently
 * folded into 'other' by a stale runtime list.
 */
export type TaggedUsageEntry = Omit<UsageEntry, 'feature'> & { feature: string };

const FEATURE_SLUG = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_MODEL_LENGTH = 200;

const LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_ledger (
    day TEXT NOT NULL,
    feature TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    unpriced_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, feature, model)
  ) WITHOUT ROWID;
`;

function ledger() {
  const db = getBotDb();
  db.ensureSchema('usage_ledger', LEDGER_SCHEMA);
  return db;
}

/** Normalizes a feature tag: a lowercase slug, or 'other' for anything missing or malformed. */
export function normalizeFeature(raw: string | null | undefined): string {
  const value = raw?.trim().toLowerCase();
  return value && FEATURE_SLUG.test(value) ? value : 'other';
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Records one call's usage in the ledger. Never throws: a ledger problem must not fail the AI call. */
export function recordUsage(entry: UsageEntry): void {
  recordTaggedUsage(entry);
}

/** recordUsage() for a feature tag read off a request (see TaggedUsageEntry). */
export function recordTaggedUsage(entry: TaggedUsageEntry): void {
  if (!config.costs.ledgerEnabled) return;
  try {
    const model = entry.model.trim().slice(0, MAX_MODEL_LENGTH) || 'unknown';
    const priced = entry.cost !== undefined && Number.isFinite(entry.cost) && entry.cost >= 0;
    ledger()
      .stmt(
        `INSERT INTO usage_ledger (day, feature, model, requests, prompt_tokens, completion_tokens, cost_usd, unpriced_requests)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(day, feature, model) DO UPDATE SET
           requests = requests + 1,
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           unpriced_requests = unpriced_requests + excluded.unpriced_requests`,
      )
      .run(
        easternDayKey(entry.at ?? Date.now()),
        normalizeFeature(entry.feature),
        model,
        tokenCount(entry.promptTokens),
        tokenCount(entry.completionTokens),
        priced ? entry.cost : 0,
        priced ? 0 : 1,
      );
  } catch (error) {
    // WARN, not debug: a failing ledger write is an infrastructure problem (bot.db unwritable), and
    // the only symptom would otherwise be a digest that quietly under-reports.
    logger.warn(`usage: failed to record ${entry.feature}/${entry.model}:`, error);
  }
}

export type UsageTotals = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Calls whose response carried no cost (counted in `requests`, not in `costUsd`). */
  unpricedRequests: number;
};

export type UsageSummary = {
  /** First Eastern day covered (YYYY-MM-DD, inclusive). */
  fromDay: string;
  /** Last Eastern day covered (inclusive). Earlier than fromDay when the range is empty. */
  toDay: string;
  total: UsageTotals;
  /** Highest cost first (then most requests). */
  byFeature: Array<UsageTotals & { feature: string }>;
  /** Highest cost first (then most requests). */
  byModel: Array<UsageTotals & { model: string }>;
  /** The earliest day the ledger has any row for, so a report can say when tracking started. */
  trackedSince?: string;
};

type LedgerRow = {
  feature: string;
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  unpriced_requests: number;
};

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedRequests: 0 };
}

function addRow(totals: UsageTotals, row: LedgerRow): void {
  totals.requests += row.requests;
  totals.promptTokens += row.prompt_tokens;
  totals.completionTokens += row.completion_tokens;
  totals.costUsd += row.cost_usd;
  totals.unpricedRequests += row.unpriced_requests;
}

function byCostDesc(a: UsageTotals, b: UsageTotals): number {
  return b.costUsd - a.costUsd || b.requests - a.requests;
}

/**
 * Spend over every Eastern calendar day that overlaps [sinceMs, untilMs). The ledger's resolution is a
 * day, so a range is widened to whole days: pass the start of an Eastern day as `untilMs` to cover only
 * the days before it (what the weekly digest does, so consecutive digests never count a day twice).
 */
export function getUsageSummary(sinceMs: number, untilMs: number): UsageSummary {
  const empty = untilMs <= sinceMs;
  const fromDay = easternDayKey(sinceMs);
  const toDay = empty ? previousDayKey(fromDay) : easternDayKey(untilMs - 1);
  const summary: UsageSummary = { fromDay, toDay, total: emptyTotals(), byFeature: [], byModel: [] };

  const db = ledger();
  const first = db.stmt('SELECT MIN(day) AS day FROM usage_ledger').get() as { day: string | null } | undefined;
  if (first?.day) summary.trackedSince = first.day;
  if (empty) return summary;

  const rows = db
    .stmt(
      `SELECT feature, model,
              SUM(requests) AS requests,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(cost_usd) AS cost_usd,
              SUM(unpriced_requests) AS unpriced_requests
       FROM usage_ledger
       WHERE day BETWEEN ? AND ?
       GROUP BY feature, model`,
    )
    .all(fromDay, toDay) as LedgerRow[];

  const features = new Map<string, UsageTotals & { feature: string }>();
  const models = new Map<string, UsageTotals & { model: string }>();
  for (const row of rows) {
    addRow(summary.total, row);

    let feature = features.get(row.feature);
    if (!feature) {
      feature = { feature: row.feature, ...emptyTotals() };
      features.set(row.feature, feature);
    }
    addRow(feature, row);

    let model = models.get(row.model);
    if (!model) {
      model = { model: row.model, ...emptyTotals() };
      models.set(row.model, model);
    }
    addRow(model, row);
  }

  summary.byFeature = [...features.values()].sort(byCostDesc);
  summary.byModel = [...models.values()].sort(byCostDesc);
  return summary;
}

// ---- Eastern calendar days ----

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The Eastern calendar day (YYYY-MM-DD) an instant falls on. */
export function easternDayKey(ms: number): string {
  const p = easternParts(new Date(ms));
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * Midnight Eastern (as epoch ms) of the day `offsetDays` calendar days after the Eastern day containing
 * `ms` (negative = before). Calendar arithmetic, so DST days are 23 or 25 hours long as they should be.
 */
export function startOfEasternDay(ms: number, offsetDays = 0): number {
  const p = easternParts(new Date(ms));
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
  return easternWallClockToDate(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()).getTime();
}

function previousDayKey(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}
