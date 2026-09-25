import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { toolDefinitions } from '../tools';
import { type ToolHandlerContext, createTurnEffects } from '../types';
import { recordUsage } from '../usage';
import { costPeriodRange, costTools, formatCostReport } from './costs';

const DAY = 24 * 60 * 60 * 1000;
const tool = costTools[0];

function ctx(): ToolHandlerContext {
  return {
    message: createFakeMessage().message,
    provider: new FakeProvider([]),
    channelId: 'channel-1',
    turn: createTurnEffects(),
  };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('query_costs tool', () => {
  it('is registered in the chat tool surface', () => {
    expect(tool.name).toBe('query_costs');
    expect(toolDefinitions.some((t) => t.name === 'query_costs')).toBe(true);
    expect(tool.parameters).toMatchObject({ required: ['period'] });
  });

  it('reports the period total, per feature and top models', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-25T16:00:00Z'), toFake: ['Date'] });
    recordUsage({ feature: 'chat', model: 'deepseek/deepseek-v3.2', promptTokens: 9000, completionTokens: 300, cost: 0.04 });
    recordUsage({ feature: 'learner', model: 'qwen/qwen3-vl', promptTokens: 20000, completionTokens: 900, cost: 0.11 });
    recordUsage({ feature: 'chat', model: 'deepseek/deepseek-v3.2', cost: 0.5, at: Date.now() - 3 * DAY });
    recordUsage({ feature: 'image', model: 'gemini-image', cost: 9, at: Date.now() - 40 * DAY });

    const today = await tool.handler(ctx(), { period: 'today' });
    expect(today).toContain('OpenRouter spend for today (2026-09-25, Eastern days, USD): $0.15 over 2 calls');
    expect(today).toContain('By feature: learner $0.11 (1 call) · chat $0.04 (1 call)');
    expect(today).toContain('Top models: qwen/qwen3-vl $0.11 (1 call) · deepseek/deepseek-v3.2 $0.04 (1 call)');

    const week = await tool.handler(ctx(), { period: 'week' });
    expect(week).toContain('the past 7 days (2026-09-19 → 2026-09-25');
    expect(week).toContain('$0.65 over 3 calls');
    expect(week).not.toContain('gemini-image');

    const month = await tool.handler(ctx(), { period: 'month' });
    expect(month).toContain('the past 30 days (2026-08-27 → 2026-09-25');
    expect(month).toContain('$0.65 over 3 calls');
    expect(month).not.toContain('Cost tracking started'); // the ledger predates the window
  });

  it('warns when the window starts before the ledger does (right after the first deploy)', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-25T16:00:00Z'), toFake: ['Date'] });
    recordUsage({ feature: 'chat', model: 'deepseek/deepseek-v3.2', cost: 0.2, at: Date.now() - 2 * DAY });

    const month = await tool.handler(ctx(), { period: 'month' });
    expect(month).toContain('Note: Cost tracking started 2026-09-23; earlier days are not covered.');
  });

  it('falls back to the past week for a missing or unknown period', async () => {
    const result = await tool.handler(ctx(), { period: 'fortnight' });
    expect(result).toContain('the past 7 days');
    expect(result).toContain('nothing recorded');
  });

  it('says tracking is off when the ledger is disabled', async () => {
    vi.stubEnv('USAGE_LEDGER_ENABLED', '0');
    expect(await tool.handler(ctx(), { period: 'today' })).toBe(
      'Cost tracking is turned off on this bot, so there are no numbers to report.',
    );
  });
});

describe('costPeriodRange', () => {
  it('starts at Eastern midnight of the first day and ends now', () => {
    const now = Date.parse('2026-09-25T02:00:00Z'); // 22:00 EDT on the 24th
    expect(new Date(costPeriodRange('today', now).sinceMs).toISOString()).toBe('2026-09-24T04:00:00.000Z');
    expect(new Date(costPeriodRange('week', now).sinceMs).toISOString()).toBe('2026-09-18T04:00:00.000Z');
    expect(costPeriodRange('month', now).untilMs).toBe(now);
  });
});

describe('formatCostReport', () => {
  it('prints a single day without a range arrow', () => {
    const text = formatCostReport('today', {
      fromDay: '2026-09-25',
      toDay: '2026-09-25',
      total: { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedRequests: 0 },
      byFeature: [],
      byModel: [],
    });
    expect(text).toBe('OpenRouter spend for today (2026-09-25, Eastern days, USD): nothing recorded.');
  });
});
