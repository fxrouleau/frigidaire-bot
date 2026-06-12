// Pure rendering for the weekly self-diagnosis digest. No Discord, no env, no file IO — every input
// is passed in, so the whole module is trivially unit-testable. The event handler (events/reportDigest)
// does the data gathering and posting.
import { MAX_CAPTURES } from './debugCapture';

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
  /** Last successful digest run. Items updated at/after it are "new this week"; null ⇒ everything is new. */
  watermark: Date | null;
  signals: DigestSignal[];
  failures: DigestFailure[];
  captures: ErrorCaptureSummary;
};

export function buildDigest(opts: BuildDigestOptions): string {
  const { periodStart, periodEnd, watermark, signals, failures, captures } = opts;

  const header = `🩺 Weekly self-diagnosis digest · ${isoDate(periodStart)} → ${isoDate(periodEnd)}`;
  const newSignals = signals.filter((s) => isNew(s.updated_at, watermark));
  const newFailures = failures.filter((f) => isNew(f.updated_at, watermark));
  const backlogTotal = signals.length + failures.length;

  // Quiet week: nothing in self-diagnosis moved since the last run — collapse to one line.
  if (newSignals.length === 0 && newFailures.length === 0) {
    return `${header}\n\nNo new self-diagnosis signals this week. ${backlogTotal} active in backlog, ${captures.total} AI errors captured.`;
  }

  const lines: string[] = [header, ''];

  lines.push(`Improvement signals — ${signals.length} active (${newSignals.length} new this week)`);
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

  lines.push(`Runtime failures logged this week — ${newFailures.length}`);
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

  return lines.join('\n');
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
