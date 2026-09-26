// The daily spending cap on video understanding (VIDEO_DAILY_BUDGET_USD, default $0.50).
//
// Watching is the one media feature whose cost scales with what members post and ask: a 5-minute clip
// is ~30k tokens, and every follow-up question about it is another call. So before any video-model
// call, today's (Eastern calendar day) 'video' spend is read from the usage ledger — the same numbers
// query_costs and the digest report — and once it reaches the budget, nothing is watched until
// midnight ET. Transcription (Whisper, a fraction of a cent per minute) is not counted.
//
// The ledger books a call a moment after its response arrives, so two clips watched at the same instant
// can overshoot by one call (~$0.002); that is the price of not keeping a second set of books.
import { config } from '../../config';
import { logger } from '../../logger';
import { getUsageSummary, startOfEasternDay } from '../usage';

/** Today's (Eastern) spend on the video feature, in USD, from the usage ledger. */
export function videoSpendTodayUsd(now = Date.now()): number {
  try {
    return getUsageSummary(startOfEasternDay(now), now + 1).byFeature.find((f) => f.feature === 'video')?.costUsd ?? 0;
  } catch (error) {
    // A ledger that can't be read must not take video understanding down with it.
    logger.warn('video: could not read today’s video spend from the usage ledger:', error);
    return 0;
  }
}

export type BudgetVerdict = { ok: true } | { ok: false; spentUsd: number; budgetUsd: number };

export type VideoBudgetOptions = {
  /** Default: VIDEO_DAILY_BUDGET_USD (0 = unlimited). */
  dailyUsd?: () => number;
  /** Default: the usage ledger. */
  spentTodayUsd?: (now: number) => number;
  /** Default: USAGE_LEDGER_ENABLED — without the ledger there is nothing to measure against. */
  ledgerEnabled?: () => boolean;
  now?: () => number;
};

export class VideoBudget {
  private readonly dailyUsd: () => number;
  private readonly spentTodayUsd: (now: number) => number;
  private readonly ledgerEnabled: () => boolean;
  private readonly now: () => number;
  private warnedNoLedger = false;

  constructor(opts: VideoBudgetOptions = {}) {
    this.dailyUsd = opts.dailyUsd ?? (() => config.media.videoDailyBudgetUsd);
    this.spentTodayUsd = opts.spentTodayUsd ?? videoSpendTodayUsd;
    this.ledgerEnabled = opts.ledgerEnabled ?? (() => config.costs.ledgerEnabled);
    this.now = opts.now ?? Date.now;
  }

  /** Whether another video-model call fits in today's budget. */
  check(): BudgetVerdict {
    const budgetUsd = this.dailyUsd();
    if (budgetUsd <= 0) return { ok: true };
    if (!this.ledgerEnabled()) {
      if (!this.warnedNoLedger) {
        this.warnedNoLedger = true;
        logger.warn('video: VIDEO_DAILY_BUDGET_USD is set but USAGE_LEDGER_ENABLED=false, so it cannot be enforced');
      }
      return { ok: true };
    }
    const spentUsd = this.spentTodayUsd(this.now());
    return spentUsd < budgetUsd ? { ok: true } : { ok: false, spentUsd, budgetUsd };
  }
}
