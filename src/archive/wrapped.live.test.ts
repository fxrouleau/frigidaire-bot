// Live, paid, opt-in smoke test of the Wrapped intro line against the real OpenRouter API (the configured
// CHAT_MODEL with ZDR-only routing). SKIPPED unless RUN_LIVE=1 and OPENROUTER_API_KEY are set.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// One short completion on a names-and-numbers digest: a fraction of a cent.
import { describe, expect, it } from 'vitest';
import type { WrappedStats } from './stats';
import { generateWrappedIntro, yearPeriod } from './wrapped';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;

const person = (authorName: string, count: number) => ({ authorId: null, authorName, count });

const STATS: WrappedStats = {
  totalMessages: 48_210,
  activeMembers: 9,
  topMembers: [person('Jason', 14_002), person('Simon', 9_870), person('Felix', 6_311)],
  busiestHour: { hour: 23, count: 4_120 },
  topEmojis: [],
  links: [],
  voice: { total: 0 },
  regrets: { total: 12, top: [person('Jason', 9)] },
  edits: { total: 800, top: person('Felix', 402) },
  deletions: { total: 0 },
  botPings: { total: 1_500, top: person('Simon', 700), botReplies: 1_480 },
};

describe.skipIf(!RUN_LIVE)('Wrapped intro live (paid, opt-in)', () => {
  it('writes one clean line from the ZDR-routed chat model', async () => {
    const intro = await generateWrappedIntro(yearPeriod(2026), STATS, (a) => a.authorName);
    console.log(`WRAPPED_INTRO ${intro}`);
    expect(intro).toBeTruthy();
    expect(intro).not.toContain('\n');
    expect((intro ?? '').length).toBeLessThanOrEqual(280);
  }, 60_000);
});
