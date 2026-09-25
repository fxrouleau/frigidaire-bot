import { ChannelType } from 'discord.js';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { FEATURE_HEADER } from '../ai/usage';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { BOT_USER_ID, GUILD_ID, archiveInput, snowflake } from '../test-support/fakeArchive';
import { type OpenRouterFixture, loadFixture } from '../test-support/openRouterFetch';
import { ArchiveStore } from './archiveStore';
import { type WrappedStats, computeWrappedStats } from './stats';
import {
  type WrappedChannel,
  type WrappedDeps,
  claimWrappedPeriod,
  cleanIntro,
  duePeriods,
  finishWrappedPeriod,
  generateWrappedIntro,
  getWrappedStatus,
  markWrappedSending,
  monthPeriod,
  renderWrapped,
  runWrappedCheck,
  yearPeriod,
} from './wrapped';

const MAIN = '100000000000000001';
const CLIPS = '100000000000000002';
const MODLOGS = '100000000000000004';
const FELIX = '200000000000000001';
const JASON = '200000000000000002';
const EVERYONE_ROLE = GUILD_ID;
const MOD_ROLE = '400000000000000001';
const MINUTE = 60_000;

let botDb: BotDb;

beforeEach(() => {
  botDb = new BotDb(':memory:');
  setBotDbForTesting(botDb);
  setMemoryStoreForTesting(new MemoryStore(':memory:'));
  vi.stubEnv('MAIN_CHANNEL_ID', '');
  vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', '');
  vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', '');
  vi.stubEnv('WRAPPED_LLM_INTRO', '');
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
  botDb.close();
  vi.unstubAllEnvs();
});

describe('periods and scheduling', () => {
  it('bounds a month and a year in Eastern time, DST included, due on the next 1st at 15:00 ET', () => {
    const march = monthPeriod(2026, 3);
    expect(march).toMatchObject({ kind: 'month', key: 'month:2026-03', label: 'March 2026' });
    expect(new Date(march.startMs).toISOString()).toBe('2026-03-01T05:00:00.000Z'); // EST
    expect(new Date(march.endMs).toISOString()).toBe('2026-04-01T04:00:00.000Z'); // EDT
    expect(new Date(march.dueAtMs).toISOString()).toBe('2026-04-01T19:00:00.000Z');

    const december = monthPeriod(2025, 12);
    expect(new Date(december.endMs).toISOString()).toBe('2026-01-01T05:00:00.000Z');

    const year = yearPeriod(2025);
    expect(year).toMatchObject({ kind: 'year', key: 'year:2025', label: '2025' });
    expect(new Date(year.dueAtMs).toISOString()).toBe('2026-01-01T20:00:00.000Z');
  });

  it('is due from 15:00 ET on the 1st for three days; Jan 1 also closes the year', () => {
    expect(duePeriods(new Date('2026-09-01T18:59:00Z'))).toEqual([]); // 14:59 EDT
    expect(duePeriods(new Date('2026-09-01T19:00:00Z')).map((p) => p.key)).toEqual(['month:2026-08']);
    expect(duePeriods(new Date('2026-09-03T12:00:00Z')).map((p) => p.key)).toEqual(['month:2026-08']);
    expect(duePeriods(new Date('2026-09-04T19:00:00Z'))).toEqual([]);
    expect(duePeriods(new Date('2026-09-15T19:00:00Z'))).toEqual([]);
    expect(duePeriods(new Date('2027-01-01T20:00:00Z')).map((p) => p.key)).toEqual(['month:2026-12', 'year:2026']);
  });
});

describe('watermark', () => {
  const T = Date.UTC(2026, 8, 1, 19, 0);

  it('claims a period once; a retry can be reclaimed until it fails for good', () => {
    expect(claimWrappedPeriod('month:2026-08', T)).toBe(true);
    expect(claimWrappedPeriod('month:2026-08', T + 1)).toBe(false);
    finishWrappedPeriod('month:2026-08', 'retry', T + 2);
    expect(claimWrappedPeriod('month:2026-08', T + 3)).toBe(true);
    finishWrappedPeriod('month:2026-08', 'retry', T + 4);
    expect(claimWrappedPeriod('month:2026-08', T + 5)).toBe(true);
    finishWrappedPeriod('month:2026-08', 'retry', T + 6);
    expect(getWrappedStatus('month:2026-08')).toMatchObject({ status: 'failed', attempts: 3 });
    expect(claimWrappedPeriod('month:2026-08', T + 7)).toBe(false);
  });

  it('takes over an abandoned claim that sent nothing, never one that was sending', () => {
    expect(claimWrappedPeriod('month:2026-08', T)).toBe(true);
    expect(claimWrappedPeriod('month:2026-08', T + 14 * MINUTE)).toBe(false);
    expect(claimWrappedPeriod('month:2026-08', T + 15 * MINUTE)).toBe(true);
    expect(getWrappedStatus('month:2026-08')).toMatchObject({ status: 'posting', attempts: 2 });

    markWrappedSending('month:2026-08', T + 16 * MINUTE);
    expect(claimWrappedPeriod('month:2026-08', T + 24 * 60 * MINUTE)).toBe(false);
  });

  it('records the posted message id', () => {
    claimWrappedPeriod('year:2026', T);
    finishWrappedPeriod('year:2026', 'posted', T + 1, '555');
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'posted', messageId: '555', updatedAt: T + 1 });
  });
});

function sampleStats(overrides: Partial<WrappedStats> = {}): WrappedStats {
  return {
    totalMessages: 1234,
    activeMembers: 3,
    topMembers: [
      { authorId: FELIX, authorName: 'Felix', count: 700 },
      { authorId: null, authorName: 'Ghost_y', count: 34 },
    ],
    busiestDay: { date: '2026-08-14', count: 210 },
    busiestHour: { hour: 23, count: 99 },
    topChannel: { channelId: MAIN, count: 1000 },
    topEmojis: [{ id: '300000000000000001', name: 'kekw', animated: false, count: 12 }],
    links: [
      { platform: 'twitter', count: 5 },
      { platform: 'other', count: 2 },
    ],
    voice: { total: 3, top: { authorId: JASON, authorName: 'Jason', count: 2 } },
    regrets: {
      total: 4,
      top: [
        { authorId: JASON, authorName: 'Jason', count: 3 },
        { authorId: FELIX, authorName: 'Felix', count: 1 },
      ],
    },
    edits: { total: 9, top: { authorId: FELIX, authorName: 'Felix', count: 5 } },
    deletions: { total: 1, top: { authorId: JASON, authorName: 'Jason', count: 1 } },
    longest: {
      authorId: FELIX,
      authorName: 'Felix',
      length: 812,
      content: `**hear me out** ${'word '.repeat(60)}`,
      messageId: '600000000000000001',
      channelId: MAIN,
      guildId: GUILD_ID,
    },
    botPings: { total: 40, top: { authorId: JASON, authorName: 'Jason', count: 30 }, botReplies: 38 },
    ...overrides,
  };
}

const renderOptions = {
  botName: 'Frigidaire',
  person: (a: { authorId: string | null; authorName: string }) => (a.authorId ? `<@${a.authorId}>` : `**${a.authorName}**`),
  emoji: (e: { id: string; name: string; animated: boolean }) => `<:${e.name}:${e.id}>`,
  channel: (id: string) => `<#${id}>`,
};

describe('renderWrapped', () => {
  it('renders every section deterministically', () => {
    const period = monthPeriod(2026, 8);
    const text = renderWrapped(period, sampleStats(), { ...renderOptions, intro: 'Felix_needs a hobby' });
    expect(text).toBe(renderWrapped(period, sampleStats(), { ...renderOptions, intro: 'Felix_needs a hobby' }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('📦 **Frigidaire Wrapped — August 2026**');
    expect(lines[1]).toBe('*Felix\\_needs a hobby*');
    expect(text).toContain('💬 **1,234** messages from **3** people');
    expect(text).toContain(`1. <@${FELIX}> — 700`);
    expect(text).toContain('2. **Ghost_y** — 34');
    expect(text).toContain('📅 Busiest day **Fri, Aug 14** (210 messages) · peak hour **11 PM–12 AM** ET');
    expect(text).toContain(`📍 Top channel: <#${MAIN}> (1,000 messages)`);
    expect(text).toContain('😂 Top emojis: <:kekw:300000000000000001> ×12');
    expect(text).toContain('🔗 Links: Twitter/X 5 · other 2');
    expect(text).toContain(`🎙️ Voice messages: 3 — most from <@${JASON}> (2)`);
    expect(text).toContain(`🫣 Most regretted: <@${JASON}> — 3 messages deleted and put right back; runners-up <@${FELIX}> (1)`);
    expect(text).toContain(`✏️ 9 edits (<@${FELIX}>: 5) · 🗑️ 1 deletion (<@${JASON}>: 1)`);
    expect(text).toContain(`📜 Ramble of the month: <@${FELIX}> with 812 characters — "\\*\\*hear me out\\*\\* word`);
    expect(text).toContain(`https://discord.com/channels/${GUILD_ID}/${MAIN}/600000000000000001`);
    expect(text).toContain(`🤖 You pinged me 40 times (<@${JASON}>: 30); I answered 38 times`);
  });

  it('leaves out lines with nothing to report and titles a year', () => {
    const text = renderWrapped(
      yearPeriod(2026),
      sampleStats({
        activeMembers: 1,
        topEmojis: [],
        links: [],
        voice: { total: 0 },
        regrets: { total: 0, top: [] },
        edits: { total: 0 },
        deletions: { total: 0 },
        longest: undefined,
        botPings: { total: 0, botReplies: 0 },
        busiestDay: undefined,
        busiestHour: undefined,
      }),
      { ...renderOptions, coverageNote: 'Still importing.' },
    );
    expect(text).toContain('Wrapped — the year 2026');
    expect(text).toContain('from **1** person');
    for (const marker of ['😂', '🔗', '🎙️', '🫣', '✏️', '🗑️', '📜', '🤖', '📅']) expect(text).not.toContain(marker);
    expect(text.endsWith('\n-# Still importing.')).toBe(true);
  });
});

describe('intro line', () => {
  it('cleans quotes, labels and extra lines', () => {
    expect(cleanIntro('"Jason pinged the bot 30 times. Get a job."')).toBe('Jason pinged the bot 30 times. Get a job.');
    expect(cleanIntro('\n\nIntro: **Felix wrote a novel**\nsecond line')).toBe('Felix wrote a novel');
    expect(cleanIntro('   ')).toBeUndefined();
    expect(cleanIntro(null)).toBeUndefined();
    expect(cleanIntro('x'.repeat(400))).toHaveLength(280);
  });

  function capturingClient(fixture: OpenRouterFixture, seen: { body?: Record<string, unknown>; headers?: Headers }) {
    return new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (_url: unknown, init?: { body?: string; headers?: HeadersInit }) => {
        seen.body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        seen.headers = new Headers(init?.headers);
        return new Response(JSON.stringify(fixture.response), {
          status: fixture.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    });
  }

  it('asks the chat model once, ZDR-routed and tagged as Wrapped, with names and numbers only', async () => {
    const seen: { body?: Record<string, unknown>; headers?: Headers } = {};
    const intro = await generateWrappedIntro(monthPeriod(2026, 8), sampleStats(), (a) => a.authorName, {
      client: capturingClient(loadFixture('text-response'), seen),
      model: 'test/model',
    });
    expect(intro).toBe('Hello! This is a plain text reply.');
    expect(seen.body).toMatchObject({ model: 'test/model', provider: { zdr: true } });
    expect(seen.headers?.get(FEATURE_HEADER)).toBe('wrapped');
    const prompt = JSON.stringify(seen.body?.messages);
    expect(prompt).toContain('Felix (700)');
    expect(prompt).not.toContain('hear me out'); // no message text leaves the archive
  });

  it('returns undefined on an API error or without a key', async () => {
    const seen = {};
    expect(
      await generateWrappedIntro(monthPeriod(2026, 8), sampleStats(), (a) => a.authorName, {
        client: capturingClient(loadFixture('http-500-error'), seen),
      }),
    ).toBeUndefined();
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(await generateWrappedIntro(monthPeriod(2026, 8), sampleStats(), (a) => a.authorName)).toBeUndefined();
  });
});

describe('runWrappedCheck', () => {
  // 2026-09-01 15:00 EDT: August 2026 is due.
  const NOW = Date.UTC(2026, 8, 1, 19, 0);
  const AUG = Date.UTC(2026, 7, 14, 16, 0);
  let store: ArchiveStore;
  let sent: { content: string; allowedMentions: { parse: never[] } }[];

  beforeEach(() => {
    store = new ArchiveStore(':memory:');
    sent = [];
    for (const [id, name] of [
      [MAIN, 'banana-combo'],
      [CLIPS, 'clips'],
      [MODLOGS, 'mod-logs'],
    ]) {
      store.upsertChannel({ id, guildId: GUILD_ID, name, parentId: null, type: ChannelType.GuildText });
    }
  });

  afterEach(() => {
    store.close();
  });

  /** The Wrapped channel: #banana-combo and #clips are public, #mod-logs is mods-only. */
  function wrappedChannel(send?: (content: string) => Promise<{ id: string }>): WrappedChannel {
    const visible: Record<string, string[]> = {
      [MAIN]: [EVERYONE_ROLE, MOD_ROLE],
      [CLIPS]: [EVERYONE_ROLE, MOD_ROLE],
      [MODLOGS]: [MOD_ROLE],
    };
    const permissioned = (id: string) => ({
      id,
      type: ChannelType.GuildText,
      permissionsFor: (role: { id: string }) => ({ has: () => visible[id].includes(role.id) }),
    });
    const roles = new Map([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE }],
      [MOD_ROLE, { id: MOD_ROLE }],
    ]);
    return {
      ...permissioned(MAIN),
      permissionsFor: permissioned(MAIN).permissionsFor as unknown as WrappedChannel['permissionsFor'],
      guild: {
        id: GUILD_ID,
        channels: { cache: new Map([MAIN, CLIPS, MODLOGS].map((id) => [id, permissioned(id)])) },
        roles: { cache: roles },
        emojis: { cache: new Map([['300000000000000001', {}]]) },
      },
      send: async (options) => {
        sent.push(options);
        return send ? send(options.content) : { id: `posted-${sent.length}` };
      },
    };
  }

  function deps(overrides: Partial<WrappedDeps> = {}): WrappedDeps & { intro: ReturnType<typeof vi.fn> } {
    const intro = vi.fn(async () => 'what a month');
    return {
      now: () => new Date(NOW),
      store: () => store,
      channelId: () => MAIN,
      fetchChannel: async () => wrappedChannel(),
      botUserId: BOT_USER_ID,
      botName: 'Frigidaire',
      intro,
      syncBusy: () => false,
      ...overrides,
    } as WrappedDeps & { intro: ReturnType<typeof vi.fn> };
  }

  function seedAugust() {
    store.upsertMessages([
      archiveInput({ id: snowflake(AUG, 1), createdAt: AUG, content: 'public <:kekw:300000000000000001>', authorId: FELIX }),
      archiveInput({ id: snowflake(AUG, 2), createdAt: AUG + MINUTE, content: 'clip', channelId: CLIPS, authorId: JASON, authorName: 'Jason' }),
      archiveInput({
        id: snowflake(AUG, 3),
        createdAt: AUG + 2 * MINUTE,
        content: `private mod stuff ${'x'.repeat(500)}`,
        channelId: MODLOGS,
        authorId: JASON,
        authorName: 'Jason',
      }),
    ]);
  }

  it('posts a due period once, without pings, leaving private channels out', async () => {
    seedAugust();
    const d = deps();
    await runWrappedCheck(d);
    expect(sent).toHaveLength(1);
    const text = sent[0].content;
    expect(sent[0].allowedMentions).toEqual({ parse: [] });
    expect(text).toContain('Wrapped — August 2026');
    expect(text).toContain('*what a month*');
    expect(text).toContain('💬 **2** messages from **2** people');
    expect(text).toContain('<:kekw:300000000000000001> ×1');
    expect(text).not.toContain('private mod stuff');
    expect(d.intro).toHaveBeenCalledTimes(1);
    expect(getWrappedStatus('month:2026-08')).toMatchObject({ status: 'posted', messageId: 'posted-1' });

    await runWrappedCheck(d);
    expect(sent).toHaveLength(1);
  });

  it('skips a period with nothing archived, and waits while the gap fill runs', async () => {
    await runWrappedCheck(deps({ syncBusy: () => true }));
    expect(getWrappedStatus('month:2026-08')).toBeUndefined();
    await runWrappedCheck(deps());
    expect(sent).toHaveLength(0);
    expect(getWrappedStatus('month:2026-08')?.status).toBe('skipped');
  });

  it('retries after a failed send or a missing channel', async () => {
    seedAugust();
    await runWrappedCheck(deps({ fetchChannel: async () => undefined }));
    expect(getWrappedStatus('month:2026-08')?.status).toBe('retry');

    await runWrappedCheck(
      deps({
        fetchChannel: async () =>
          wrappedChannel(async () => {
            throw new Error('Missing Permissions');
          }),
      }),
    );
    expect(getWrappedStatus('month:2026-08')).toMatchObject({ status: 'retry', attempts: 2 });

    await runWrappedCheck(deps());
    expect(getWrappedStatus('month:2026-08')).toMatchObject({ status: 'posted', attempts: 3 });
  });

  it('does not repost a partly sent (multi-message) post', async () => {
    seedAugust();
    let calls = 0;
    await runWrappedCheck(
      deps({
        intro: async () => 'y'.repeat(270),
        fetchChannel: async () =>
          wrappedChannel(async () => {
            calls++;
            if (calls > 1) throw new Error('rate limited');
            return { id: 'first-chunk' };
          }),
        // A long top-yappers list forces a second chunk.
        botName: 'F'.repeat(1900),
      }),
    );
    expect(calls).toBe(2);
    expect(getWrappedStatus('month:2026-08')).toMatchObject({ status: 'posted', messageId: 'first-chunk' });
  });

  it('respects WRAPPED_LLM_INTRO=false and adds a coverage note while history is still importing', async () => {
    seedAugust();
    vi.stubEnv('WRAPPED_LLM_INTRO', 'false');
    vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', CLIPS);
    const d = deps();
    await runWrappedCheck(d);
    expect(d.intro).not.toHaveBeenCalled();
    expect(sent[0].content).toContain('-# Still importing older history');
  });

  it('does nothing without a Wrapped channel or when nothing is due', async () => {
    seedAugust();
    await runWrappedCheck(deps({ channelId: () => undefined }));
    await runWrappedCheck(deps({ now: () => new Date(Date.UTC(2026, 8, 15)) }));
    expect(sent).toHaveLength(0);
    expect(getWrappedStatus('month:2026-08')).toBeUndefined();
  });

  it('filters by audience, not by accident: unfiltered, the mods-only message would count', () => {
    seedAugust();
    const all = computeWrappedStats({ startMs: monthPeriod(2026, 8).startMs, endMs: monthPeriod(2026, 8).endMs }, { store });
    expect(all.totalMessages).toBe(3);
  });
});
