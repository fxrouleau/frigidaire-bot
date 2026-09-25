import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { recordUsage, startOfEasternDay } from '../usage';
import { VideoBudget, videoSpendTodayUsd } from './videoBudget';

// 2026-09-25 15:00 ET (19:00 UTC, EDT).
const NOW = Date.UTC(2026, 8, 25, 19, 0, 0);

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('videoSpendTodayUsd', () => {
  it("sums today's (Eastern) video rows from the usage ledger, nothing else", () => {
    recordUsage({ feature: 'video', model: 'google/gemini-3.5-flash-lite', cost: 0.2, at: NOW - 60_000 });
    recordUsage({ feature: 'video', model: 'z-ai/glm-5.3-flash', cost: 0.1, at: startOfEasternDay(NOW) + 1000 });
    recordUsage({ feature: 'transcription', model: 'openai/whisper-large-v3', cost: 5, at: NOW });
    recordUsage({ feature: 'video', model: 'google/gemini-3.5-flash-lite', cost: 9, at: startOfEasternDay(NOW) - 1000 });

    expect(videoSpendTodayUsd(NOW)).toBeCloseTo(0.3, 10);
  });
});

describe('VideoBudget', () => {
  it('allows calls until the ledger reaches the budget', () => {
    const budget = new VideoBudget({ dailyUsd: () => 0.5, now: () => NOW });
    expect(budget.check()).toEqual({ ok: true });

    recordUsage({ feature: 'video', model: 'm', cost: 0.5, at: NOW });
    expect(budget.check()).toEqual({ ok: false, spentUsd: 0.5, budgetUsd: 0.5 });
  });

  it('starts fresh at midnight Eastern', () => {
    recordUsage({ feature: 'video', model: 'm', cost: 1, at: NOW });
    let now = NOW;
    const budget = new VideoBudget({ dailyUsd: () => 0.5, now: () => now });
    expect(budget.check().ok).toBe(false);
    now = startOfEasternDay(NOW, 1) + 1;
    expect(budget.check().ok).toBe(true);
  });

  it('treats 0 as unlimited', () => {
    recordUsage({ feature: 'video', model: 'm', cost: 100, at: NOW });
    expect(new VideoBudget({ dailyUsd: () => 0, now: () => NOW }).check()).toEqual({ ok: true });
  });

  it('defaults to VIDEO_DAILY_BUDGET_USD = $0.50', () => {
    recordUsage({ feature: 'video', model: 'm', cost: 0.49, at: NOW });
    expect(new VideoBudget({ now: () => NOW }).check().ok).toBe(true);
    vi.stubEnv('VIDEO_DAILY_BUDGET_USD', '0.25');
    expect(new VideoBudget({ now: () => NOW }).check().ok).toBe(false);
  });

  it("warns once, and doesn't block, when the ledger is off", () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const budget = new VideoBudget({ dailyUsd: () => 0.5, spentTodayUsd: () => 99, ledgerEnabled: () => false });
    expect(budget.check().ok).toBe(true);
    expect(budget.check().ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
