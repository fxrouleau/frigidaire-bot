// Pure rendering for the weekly self-diagnosis digest. No Discord, no env, no file IO — every input
// is passed in, so the whole module is trivially unit-testable. The event handler (events/reportDigest)
// does the data gathering and posting.
import { MAX_CAPTURES } from './debugCapture';
import type { UsageSummary } from './usage';
import { describeSpend } from './usageFormat';

// Learner-authored signals: rendered WITH their content (capability gaps, pain points, etc.).
export const SIGNAL_CATEGORIES = ['capability_gap', 'pain_point', 'feature_request', 'improvement_idea'] as const;
// failureLogger-authored runtime failures: rendered as COUNTS only (no content — they're terse and noisy).
export const FAILURE_CATEGORIES = ['parse_failure', 'tool_error', 'missing_context', 'unrecognized_content'] as const;

// Display cap per category — the underlying counts still reflect the true totals.
const MAX_ITEMS_PER_CATEGORY = 10;

export type DigestSignal = { category: string; content: string; updated_at: string };
export type DigestFailure = { category: string; updated_at: string };

/** Minimal, privacy-safe slice of an error capture — never carries conversation payload. */
export type CaptureMeta = { timestamp: string; status?: number; message: string };

export type ErrorCaptureSummary = {
  /** Captures within the `since` window. */
  total: number;
  /** True when the capture dir is at MAX_CAPTURES (older errors were pruned ⇒ `total` is a lower bound). */
  capped: boolean;
  /** Grouped error labels, highest count first. */
  byType: Array<{ label: string; count: number }>;
};

export type BuildDigestOptions = {
  periodStart: Date;
  periodEnd: Date;
  /** Last successful digest run. Items updated at/after it are "new"; null (first digest) ⇒ everything is new. */
  watermark: Date | null;
  signals: DigestSignal[];
  failures: DigestFailure[];
  captures: ErrorCaptureSummary;
  /** OpenRouter spend over the period's complete Eastern days; undefined (ledger unreadable/off) ⇒ no section. */
  spend?: UsageSummary;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A digest normally runs a week (+ up to one check interval) after the last one. Within this band it is
// "weekly" and its news is "this week"; outside it (the bot was down for a month, DIGEST_PERIOD_MS was
// changed) the wording says what the period really is instead of calling five weeks "this week".
const WEEK_BAND_MS = { min: 6 * DAY_MS, max: 8 * DAY_MS };

export type DigestPeriod = {
  /** The header's title: 'Weekly self-diagnosis digest', or 'Self-diagnosis digest' plus the span. */
  title: string;
  /** What "new" is relative to: 'this week', 'since the last digest', or 'so far' on the first digest. */
  scope: string;
};

/** How a digest names its period, from its real length and whether a previous digest exists. */
export function describePeriod(periodStart: Date, periodEnd: Date, watermark: Date | null): DigestPeriod {
  const spanMs = periodEnd.getTime() - periodStart.getTime();
  const weekly = spanMs >= WEEK_BAND_MS.min && spanMs <= WEEK_BAND_MS.max;
  return {
    title: weekly ? 'Weekly self-diagnosis digest' : `Self-diagnosis digest (${formatSpan(spanMs)})`,
    // No previous digest ⇒ every active item counts as new, whatever the header's dates say.
    scope: watermark === null ? 'so far' : weekly ? 'this week' : 'since the last digest',
  };
}

/** '5 weeks', '10 days', '1 day', '6 hours' — rounded, for a header. */
export function formatSpan(ms: number): string {
  const days = ms / DAY_MS;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // Whole weeks only within ~half a day of a multiple of 7 (35.4 days is "5 weeks", 20 days is not "3 weeks").
  if (days >= 14 && Math.abs(days / 7 - Math.round(days / 7)) < 0.075) return unit(Math.round(days / 7), 'week');
  if (days >= 1) return unit(Math.round(days), 'day');
  return unit(Math.max(1, Math.round(ms / (60 * 60 * 1000))), 'hour');
}

export function buildDigest(opts: BuildDigestOptions): string {
  const { periodStart, periodEnd, watermark, signals, failures, captures, spend } = opts;

  const period = describePeriod(periodStart, periodEnd, watermark);
  const header = `🩺 ${period.title} · ${isoDate(periodStart)} → ${isoDate(periodEnd)}`;
  const newSignals = signals.filter((s) => isNew(s.updated_at, watermark));
  const newFailures = failures.filter((f) => isNew(f.updated_at, watermark));
  const backlogTotal = signals.length + failures.length;

  const spendSection = spend ? `\n\n${renderSpend(spend).join('\n')}` : '';

  // Quiet period: nothing in self-diagnosis moved since the last run — collapse to one line (plus the
  // spend, which is worth seeing every time).
  if (newSignals.length === 0 && newFailures.length === 0) {
    return `${header}\n\nNo new self-diagnosis signals ${period.scope}. ${backlogTotal} active in backlog, ${captures.total} AI errors captured.${spendSection}`;
  }

  const lines: string[] = [header, ''];

  lines.push(`Improvement signals — ${signals.length} active (${newSignals.length} new ${period.scope})`);
  for (const category of SIGNAL_CATEGORIES) {
    const items = signals.filter((s) => s.category === category);
    if (items.length === 0) continue;
    lines.push(`  ${category} (${items.length}):`);
    for (const item of items.slice(0, MAX_ITEMS_PER_CATEGORY)) {
      const prefix = isNew(item.updated_at, watermark) ? '   🆕 ' : '      ';
      lines.push(`${prefix}${item.content}`);
    }
  }
  lines.push('');

  lines.push(`Runtime failures logged ${period.scope} — ${newFailures.length}`);
  const failureCounts = countByCategory(newFailures);
  if (failureCounts.length > 0) {
    lines.push(`  ${failureCounts.map(([cat, n]) => `${cat}: ${n}`).join('   ')}`);
  }
  lines.push('');

  const cappedNote = captures.capped ? ` (≥, capped at ${MAX_CAPTURES})` : '';
  lines.push(`AI errors captured (data/debug) — ${captures.total}${cappedNote}`);
  if (captures.byType.length > 0) {
    lines.push(`  ${captures.byType.map((t) => `${t.label} ×${t.count}`).join(' · ')}`);
  }
  lines.push('');

  lines.push(`Backlog totals: ${backlogTotal} active self-diagnosis items.`);

  return `${lines.join('\n')}${spendSection}`;
}

/** The Spend section: total, per feature, top models. Covers whole Eastern days (see getUsageSummary). */
function renderSpend(spend: UsageSummary): string[] {
  if (spend.toDay < spend.fromDay) return ['Spend (OpenRouter) — no complete day since the last digest.'];
  const text = describeSpend(spend);
  const lines = [`Spend (OpenRouter, ${spend.fromDay} → ${spend.toDay} ET) — ${text.headline}`];
  if (text.byFeature) lines.push(`  by feature: ${text.byFeature}`);
  if (text.topModels) lines.push(`  top models: ${text.topModels}`);
  for (const note of text.notes) lines.push(`  ${note}`);
  return lines;
}

export function summarizeErrorCaptures(captures: CaptureMeta[], since: Date): ErrorCaptureSummary {
  // `capped` keys off the on-disk file count: the dir prunes at MAX_CAPTURES, so a full dir means
  // older captures are gone and the windowed `total` undercounts the true number of errors.
  const capped = captures.length >= MAX_CAPTURES;
  const sinceMs = since.getTime();

  const counts = new Map<string, number>();
  let total = 0;
  for (const capture of captures) {
    const ts = new Date(capture.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    total += 1;
    const label = captureLabel(capture);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const byType = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { total, capped, byType };
}

function isNew(updatedAt: string, watermark: Date | null): boolean {
  if (watermark === null) return true;
  const ts = parseTimestamp(updatedAt);
  return ts !== null && ts >= watermark.getTime();
}

/** Parses either a SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no zone) or an ISO timestamp. */
function parseTimestamp(value: string): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function countByCategory(items: DigestFailure[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A short, payload-free label for an error capture: HTTP status + kind, or a bare network error code. */
function captureLabel(capture: CaptureMeta): string {
  const message = capture.message ?? '';
  const status = capture.status;
  // Node network errors (no HTTP status) carry a code like ECONNRESET / ETIMEDOUT — surface it verbatim.
  const code = message.match(/\bE[A-Z]{2,}\b/)?.[0];
  if (status === undefined) {
    return code ?? shortHead(message);
  }
  return `${status} ${kindForStatus(status, message)}`;
}

function kindForStatus(status: number, message: string): string {
  const m = message.toLowerCase();
  if (status === 429 || m.includes('rate limit') || m.includes('too many requests')) return 'rate_limit';
  if (status >= 500) return 'upstream';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  return 'error';
}

function shortHead(message: string): string {
  const token = message.match(/[A-Za-z][A-Za-z0-9_]+/)?.[0];
  return token ? token.toLowerCase() : 'error';
}
