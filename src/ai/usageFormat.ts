// Pure text formatting of a UsageSummary, shared by the weekly digest and the query_costs tool.
import type { UsageSummary, UsageTotals } from './usage';

/** '$12.35', '$0.42', '$0.0042', '$0.00' — sub-cent amounts keep enough digits to be non-zero. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3).replace(/0$/, '')}`;
  if (amount >= 0.0001) return `$${Number(amount.toPrecision(2))}`;
  return '<$0.0001';
}

/** '850', '12.3k', '4.1M'. */
export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${trimZero((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1_000) return `${trimZero((count / 1_000).toFixed(1))}k`;
  return String(Math.round(count));
}

function trimZero(value: string): string {
  return value.replace(/\.0$/, '');
}

function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
}

function item(label: string, totals: UsageTotals): string {
  return `${label} ${formatUsd(totals.costUsd)} (${plural(totals.requests, 'call')})`;
}

export type SpendText = {
  /** '$3.21 over 1.2k calls (1.4M prompt + 52k completion tokens)' */
  headline: string;
  /** 'chat $2.10 (800 calls) · learner $0.60 (48 calls) · …' — empty when nothing was recorded. */
  byFeature: string;
  /** Top models by cost, same format. */
  topModels: string;
  /** Caveats worth stating: unpriced calls, tracking that started mid-range. */
  notes: string[];
};

export function describeSpend(
  summary: UsageSummary,
  opts: { maxFeatures?: number; maxModels?: number } = {},
): SpendText {
  const { total } = summary;
  const maxFeatures = opts.maxFeatures ?? 8;
  const maxModels = opts.maxModels ?? 3;

  const headline =
    total.requests === 0
      ? 'nothing recorded'
      : `${formatUsd(total.costUsd)} over ${plural(total.requests, 'call')} (${formatCount(total.promptTokens)} prompt + ${formatCount(total.completionTokens)} completion tokens)`;

  const features = summary.byFeature.slice(0, maxFeatures).map((f) => item(f.feature, f));
  const hiddenFeatures = summary.byFeature.length - features.length;
  if (hiddenFeatures > 0) features.push(`+${hiddenFeatures} more`);

  const notes: string[] = [];
  if (total.unpricedRequests > 0) {
    notes.push(
      `${plural(total.unpricedRequests, 'call')} reported no cost and ${total.unpricedRequests === 1 ? 'is' : 'are'} not in the total.`,
    );
  }
  if (summary.trackedSince && summary.trackedSince > summary.fromDay) {
    notes.push(`Cost tracking started ${summary.trackedSince}; earlier days are not covered.`);
  }

  return {
    headline,
    byFeature: features.join(' · '),
    topModels: summary.byModel
      .slice(0, maxModels)
      .map((m) => item(m.model, m))
      .join(' · '),
    notes,
  };
}
