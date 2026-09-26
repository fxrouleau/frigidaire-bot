import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  FEATURE_HEADER,
  easternDayKey,
  featureRequestOptions,
  getUsageSummary,
  normalizeFeature,
  recordTaggedUsage,
  recordUsage,
  startOfEasternDay,
} from './usage';

// 2026-09-24 12:00 EDT.
const NOON_SEP_24 = Date.parse('2026-09-24T16:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let db: BotDb;

type Row = {
  day: string;
  feature: string;
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  unpriced_requests: number;
};

function rows(): Row[] {
  return db.db.prepare('SELECT * FROM usage_ledger ORDER BY day, feature, model').all() as Row[];
}

beforeEach(() => {
  db = new BotDb(':memory:');
  setBotDbForTesting(db);
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('featureRequestOptions', () => {
  it('tags the request with the feature header', () => {
    expect(featureRequestOptions('learner')).toEqual({ headers: { [FEATURE_HEADER]: 'learner' } });
  });
});

describe('Eastern day helpers', () => {
  it('keys a timestamp by its Eastern calendar day, not the UTC one', () => {
    expect(easternDayKey(Date.parse('2026-09-25T03:30:00Z'))).toBe('2026-09-24'); // 23:30 EDT
    expect(easternDayKey(Date.parse('2026-09-25T04:00:00Z'))).toBe('2026-09-25'); // midnight EDT
    expect(easternDayKey(Date.parse('2026-01-15T04:30:00Z'))).toBe('2026-01-14'); // 23:30 EST
  });

  it('finds Eastern midnight in summer and winter', () => {
    expect(new Date(startOfEasternDay(NOON_SEP_24)).toISOString()).toBe('2026-09-24T04:00:00.000Z');
    expect(new Date(startOfEasternDay(Date.parse('2026-01-15T12:00:00Z'))).toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    );
  });

  it('does calendar-day arithmetic across the spring-forward switch (2026-03-08)', () => {
    const tuesday = Date.parse('2026-03-10T16:00:00Z');
    expect(new Date(startOfEasternDay(tuesday, -1)).toISOString()).toBe('2026-03-09T04:00:00.000Z'); // EDT
    expect(new Date(startOfEasternDay(tuesday, -3)).toISOString()).toBe('2026-03-07T05:00:00.000Z'); // EST
    expect(new Date(startOfEasternDay(tuesday, 1)).toISOString()).toBe('2026-03-11T04:00:00.000Z');
  });
});

describe('normalizeFeature', () => {
  it('keeps lowercase slugs and folds anything else into other', () => {
    expect(normalizeFeature('chat')).toBe('chat');
    expect(normalizeFeature(' Link_Reader ')).toBe('link_reader');
    expect(normalizeFeature('a-brand-new-feature')).toBe('other');
    expect(normalizeFeature('drop table; --')).toBe('other');
    expect(normalizeFeature('')).toBe('other');
    expect(normalizeFeature(null)).toBe('other');
    expect(normalizeFeature('x'.repeat(41))).toBe('other');
  });
});

describe('recordUsage', () => {
  it('upserts one row per (Eastern day, feature, model), summing requests, tokens and cost', () => {
    recordUsage({ feature: 'chat', model: 'm1', promptTokens: 100, completionTokens: 10, cost: 0.001, at: NOON_SEP_24 });
    recordUsage({
      feature: 'chat',
      model: 'm1',
      promptTokens: 50,
      completionTokens: 5,
      cost: 0.002,
      at: NOON_SEP_24 + HOUR,
    });

    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row).toMatchObject({
      day: '2026-09-24',
      feature: 'chat',
      model: 'm1',
      requests: 2,
      prompt_tokens: 150,
      completion_tokens: 15,
      unpriced_requests: 0,
    });
    expect(row.cost_usd).toBeCloseTo(0.003, 10);
  });

  it('keeps separate rows for different days, features and models', () => {
    recordUsage({ feature: 'chat', model: 'm1', cost: 0.01, at: NOON_SEP_24 });
    recordUsage({ feature: 'chat', model: 'm2', cost: 0.01, at: NOON_SEP_24 });
    recordUsage({ feature: 'learner', model: 'm1', cost: 0.01, at: NOON_SEP_24 });
    // 23:30 EDT on the 24th is still the 24th; 00:30 EDT on the 25th is not.
    recordUsage({ feature: 'chat', model: 'm1', cost: 0.01, at: Date.parse('2026-09-25T03:30:00Z') });
    recordUsage({ feature: 'chat', model: 'm1', cost: 0.01, at: Date.parse('2026-09-25T04:30:00Z') });

    expect(rows().map((r) => `${r.day} ${r.feature} ${r.model} ${r.requests}`)).toEqual([
      '2026-09-24 chat m1 2',
      '2026-09-24 chat m2 1',
      '2026-09-24 learner m1 1',
      '2026-09-25 chat m1 1',
    ]);
  });

  it('counts a call without a usable cost as unpriced instead of guessing', () => {
    recordUsage({ feature: 'chat', model: 'm1', at: NOON_SEP_24 });
    recordUsage({ feature: 'chat', model: 'm1', cost: Number.NaN, at: NOON_SEP_24 });
    recordUsage({ feature: 'chat', model: 'm1', cost: -1, at: NOON_SEP_24 });
    recordUsage({ feature: 'chat', model: 'm1', cost: 0, at: NOON_SEP_24 }); // free models cost exactly 0

    expect(rows()[0]).toMatchObject({ requests: 4, cost_usd: 0, unpriced_requests: 3 });
  });

  it('sanitizes tokens, model and feature', () => {
    recordTaggedUsage({ feature: 'Not A Slug', model: '   ', promptTokens: -5, completionTokens: 2.6, at: NOON_SEP_24 });
    expect(rows()[0]).toMatchObject({ feature: 'other', model: 'unknown', prompt_tokens: 0, completion_tokens: 3 });
  });

  it('keeps an unknown but well-formed feature tag (a feature added after this list was written)', () => {
    recordTaggedUsage({ feature: 'reminders', model: 'm1', cost: 0.01, at: NOON_SEP_24 });
    expect(rows()[0].feature).toBe('reminders');
  });

  it('is a no-op when the ledger is disabled', () => {
    vi.stubEnv('USAGE_LEDGER_ENABLED', 'false');
    recordUsage({ feature: 'chat', model: 'm1', cost: 0.01, at: NOON_SEP_24 });
    vi.stubEnv('USAGE_LEDGER_ENABLED', 'true');
    expect(getUsageSummary(NOON_SEP_24 - DAY, NOON_SEP_24 + DAY).total.requests).toBe(0);
  });

  it('never throws when the database is unusable; it logs a warning instead', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    db.close();
    expect(() => recordUsage({ feature: 'chat', model: 'm1', cost: 0.01 })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage: failed to record chat/m1'), expect.anything());
  });
});

describe('getUsageSummary', () => {
  function seedWeek(): void {
    recordUsage({ feature: 'chat', model: 'deepseek', promptTokens: 1000, completionTokens: 100, cost: 0.5, at: NOON_SEP_24 });
    recordUsage({ feature: 'chat', model: 'deepseek', promptTokens: 1000, completionTokens: 100, cost: 0.5, at: NOON_SEP_24 - DAY });
    recordUsage({ feature: 'learner', model: 'qwen', promptTokens: 5000, completionTokens: 500, cost: 0.2, at: NOON_SEP_24 });
    recordUsage({ feature: 'embedding', model: 'qwen-embed', promptTokens: 300, cost: 0.0001, at: NOON_SEP_24 });
    recordUsage({ feature: 'embedding', model: 'qwen-embed', promptTokens: 300, at: NOON_SEP_24 });
    // Outside the ranges below.
    recordUsage({ feature: 'image', model: 'gemini-image', cost: 5, at: NOON_SEP_24 - 10 * DAY });
  }

  it('aggregates totals, per feature and per model, most expensive first', () => {
    seedWeek();
    const summary = getUsageSummary(NOON_SEP_24 - 2 * DAY, NOON_SEP_24 + HOUR);

    expect(summary.fromDay).toBe('2026-09-22');
    expect(summary.toDay).toBe('2026-09-24');
    expect(summary.total).toMatchObject({ requests: 5, promptTokens: 7600, completionTokens: 700, unpricedRequests: 1 });
    expect(summary.total.costUsd).toBeCloseTo(1.2001, 10);
    expect(summary.byFeature.map((f) => [f.feature, f.requests])).toEqual([
      ['chat', 2],
      ['learner', 1],
      ['embedding', 2],
    ]);
    expect(summary.byModel.map((m) => m.model)).toEqual(['deepseek', 'qwen', 'qwen-embed']);
    expect(summary.trackedSince).toBe('2026-09-14');
  });

  it('covers whole Eastern days; an Eastern-midnight end excludes that day', () => {
    seedWeek();
    const startOfSep24 = startOfEasternDay(NOON_SEP_24);
    const summary = getUsageSummary(NOON_SEP_24 - 3 * DAY, startOfSep24);

    expect(summary.toDay).toBe('2026-09-23');
    expect(summary.total.requests).toBe(1);
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['chat']);
  });

  it('returns zeros (and an inverted day range) for an empty or backwards range', () => {
    seedWeek();
    const summary = getUsageSummary(NOON_SEP_24, NOON_SEP_24);
    expect(summary.total.requests).toBe(0);
    expect(summary.byFeature).toEqual([]);
    expect(summary.toDay < summary.fromDay).toBe(true);
  });

  it('works on an empty ledger', () => {
    const summary = getUsageSummary(NOON_SEP_24 - DAY, NOON_SEP_24);
    expect(summary.total).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedRequests: 0 });
    expect(summary.trackedSince).toBeUndefined();
  });
});
