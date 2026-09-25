import { ChannelType } from 'discord.js';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { FEATURE_HEADER } from '../ai/usage';
import { config } from '../config';
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
  parseWrappedPreviewCommand,
  renderWrapped,
  runWrappedCheck,
  runWrappedPreview,
  yearPeriod,
  yearToDatePeriod,
} from './wrapped';

const MAIN = '100000000000000001';
const CLIPS = '100000000000000002';
const MODLOGS = '100000000000000004';
const REPORT = '100000000000000005';
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
  vi.stubEnv('REPORT_CHANNEL_ID', '');
  vi.stubEnv('WRAPPED_CHANNEL_ID', '');
  vi.stubEnv('WRAPPED_ENABLED', '');
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

describe('config', () => {
  it('posts to the report channel by default, never the main channel on its own', () => {
    vi.stubEnv('MAIN_CHANNEL_ID', MAIN);
    expect(config.archive.wrappedChannelId).toBeUndefined();
    vi.stubEnv('REPORT_CHANNEL_ID', REPORT);
    expect(config.archive.wrappedChannelId).toBe(REPORT);
    vi.stubEnv('WRAPPED_CHANNEL_ID', CLIPS);
    expect(config.archive.wrappedChannelId).toBe(CLIPS);
  });
});

describe('periods and scheduling', () => {
  it('bounds a year in Eastern time, due on Jan 1 at 15:00 ET', () => {
    const year = yearPeriod(2025);
    expect(year).toMatchObject({ key: 'year:2025', label: '2025', year: 2025 });
    expect(year.partial).toBeUndefined();
    expect(new Date(year.startMs).toISOString()).toBe('2025-01-01T05:00:00.000Z'); // EST
    expect(new Date(year.endMs).toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(new Date(year.dueAtMs).toISOString()).toBe('2026-01-01T20:00:00.000Z');
  });

  it('previews the current Eastern year up to now', () => {
    const now = new Date('2026-09-25T16:00:00Z');
    const ytd = yearToDatePeriod(now);
    expect(ytd).toMatchObject({ key: 'preview:2026', label: '2026', year: 2026, partial: true });
    expect(new Date(ytd.startMs).toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(ytd.endMs).toBe(now.getTime());
    // 2026-12-31 23:30 ET is still 2026 in Eastern time, though already 2027 in UTC.
    expect(yearToDatePeriod(new Date('2027-01-01T04:30:00Z')).year).toBe(2026);
  });

  it('is due only on Jan 1 from 15:00 ET, for three days; no monthly posts', () => {
    expect(duePeriods(new Date('2027-01-01T19:59:00Z'))).toEqual([]); // 14:59 EST
    expect(duePeriods(new Date('2027-01-01T20:00:00Z')).map((p) => p.key)).toEqual(['year:2026']);
    expect(duePeriods(new Date('2027-01-03T12:00:00Z')).map((p) => p.key)).toEqual(['year:2026']);
    expect(duePeriods(new Date('2027-01-04T20:00:00Z'))).toEqual([]);
    // The 1st of any other month at 15:00 ET: nothing (monthly Wrapped is gone).
    expect(duePeriods(new Date('2026-09-01T19:00:00Z'))).toEqual([]);
    expect(duePeriods(new Date('2026-02-01T20:00:00Z'))).toEqual([]);
  });
});

describe('watermark', () => {
  const T = Date.UTC(2027, 0, 1, 20, 0);

  it('claims a period once; a retry can be reclaimed until it fails for good', () => {
    expect(claimWrappedPeriod('year:2026', T)).toBe(true);
    expect(claimWrappedPeriod('year:2026', T + 1)).toBe(false);
    finishWrappedPeriod('year:2026', 'retry', T + 2);
    expect(claimWrappedPeriod('year:2026', T + 3)).toBe(true);
    finishWrappedPeriod('year:2026', 'retry', T + 4);
    expect(claimWrappedPeriod('year:2026', T + 5)).toBe(true);
    finishWrappedPeriod('year:2026', 'retry', T + 6);
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'failed', attempts: 3 });
    expect(claimWrappedPeriod('year:2026', T + 7)).toBe(false);
  });

  it('takes over an abandoned claim that sent nothing, never one that was sending', () => {
    expect(claimWrappedPeriod('year:2026', T)).toBe(true);
    expect(claimWrappedPeriod('year:2026', T + 14 * MINUTE)).toBe(false);
    expect(claimWrappedPeriod('year:2026', T + 15 * MINUTE)).toBe(true);
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'posting', attempts: 2 });

    markWrappedSending('year:2026', T + 16 * MINUTE);
    expect(claimWrappedPeriod('year:2026', T + 24 * 60 * MINUTE)).toBe(false);
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
    mostReacted: {
      authorId: JASON,
      authorName: 'Jason',
      total: 14,
      reactions: [
        { id: '300000000000000001', name: 'kekw', animated: false, count: 9 },
        { id: null, name: '😂', animated: false, count: 4 },
        { id: null, name: '💀', animated: false, count: 1 },
      ],
      content: 'the *depot* is hiring',
      messageId: '600000000000000002',
      channelId: MAIN,
      guildId: GUILD_ID,
    },
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
    const period = yearPeriod(2026);
    const text = renderWrapped(period, sampleStats(), { ...renderOptions, intro: 'Felix_needs a hobby' });
    expect(text).toBe(renderWrapped(period, sampleStats(), { ...renderOptions, intro: 'Felix_needs a hobby' }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('📦 **Frigidaire Wrapped — 2026**');
    expect(lines[1]).toBe('*Felix\\_needs a hobby*');
    expect(text).toContain('💬 **1,234** messages from **3** people');
    expect(text).toContain(`1. <@${FELIX}> — 700`);
    expect(text).toContain('2. **Ghost_y** — 34');
    expect(text).toContain('📅 Busiest day **Fri, Aug 14** (210 messages) · peak hour **11 PM–12 AM** ET');
    expect(text).toContain(`📍 Top channel: <#${MAIN}> (1,000 messages)`);
    expect(text).toContain('😂 Top emojis: <:kekw:300000000000000001> ×12');
    expect(text).toContain(
      `🔥 Most reacted message of the year: <@${JASON}> — 14 reactions (<:kekw:300000000000000001> ×9 😂 ×4 💀 ×1) — "the \\*depot\\* is hiring" https://discord.com/channels/${GUILD_ID}/${MAIN}/600000000000000002`,
    );
    expect(text).toContain('🔗 Links: Twitter/X 5 · other 2');
    expect(text).toContain(`🎙️ Voice messages: 3 — most from <@${JASON}> (2)`);
    expect(text).toContain(`🫣 Most regretted: <@${JASON}> — 3 messages deleted and put right back; runners-up <@${FELIX}> (1)`);
    expect(text).toContain(`✏️ 9 edits (<@${FELIX}>: 5) · 🗑️ 1 deletion (<@${JASON}>: 1)`);
    expect(text).toContain(`📜 Ramble of the year: <@${FELIX}> with 812 characters — "\\*\\*hear me out\\*\\* word`);
    expect(text).toContain(`https://discord.com/channels/${GUILD_ID}/${MAIN}/600000000000000001`);
    expect(text).toContain(`🤖 You pinged me 40 times (<@${JASON}>: 30); I answered 38 times`);
    expect(text).not.toContain('month');
  });

  it('shows what an image-only most reacted message carried, and only the top three emojis', () => {
    const stats = sampleStats();
    const text = renderWrapped(
      yearPeriod(2026),
      sampleStats({
        mostReacted: {
          ...stats.mostReacted!,
          total: 1,
          content: '',
          attachmentName: 'meme_final.png',
          reactions: [{ id: null, name: '😂', animated: false, count: 1 }],
        },
      }),
      renderOptions,
    );
    expect(text).toContain(`🔥 Most reacted message of the year: <@${JASON}> — 1 reaction (😂 ×1) — [meme\\_final.png] https://`);
  });

  it('leaves out lines with nothing to report, and marks a partial year, banner and footnotes', () => {
    const text = renderWrapped(
      yearToDatePeriod(new Date('2026-09-25T16:00:00Z')),
      sampleStats({
        activeMembers: 1,
        topEmojis: [],
        links: [],
        voice: { total: 0 },
        regrets: { total: 0, top: [] },
        edits: { total: 0 },
        deletions: { total: 0 },
        longest: undefined,
        mostReacted: undefined,
        botPings: { total: 0, botReplies: 0 },
        busiestDay: undefined,
        busiestHour: undefined,
      }),
      { ...renderOptions, banner: 'preview', footnotes: ['Still importing.', 'counted 2 channels'] },
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('-# preview');
    expect(lines[1]).toBe('📦 **Frigidaire Wrapped — 2026 (so far)**');
    expect(text).toContain('from **1** person');
    for (const marker of ['😂', '🔥', '🔗', '🎙️', '🫣', '✏️', '🗑️', '📜', '🤖', '📅']) expect(text).not.toContain(marker);
    expect(text.endsWith('\n-# Still importing.\n-# counted 2 channels')).toBe(true);
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
    const intro = await generateWrappedIntro(yearPeriod(2026), sampleStats(), (a) => a.authorName, {
      client: capturingClient(loadFixture('text-response'), seen),
      model: 'test/model',
    });
    expect(intro).toBe('Hello! This is a plain text reply.');
    expect(seen.body).toMatchObject({ model: 'test/model', provider: { zdr: true } });
    expect(seen.headers?.get(FEATURE_HEADER)).toBe('wrapped');
    const prompt = JSON.stringify(seen.body?.messages);
    expect(prompt).toContain('Year: 2026.');
    expect(prompt).toContain('Felix (700)');
    expect(prompt).toContain('Most reacted message: Jason (14 reactions)');
    expect(prompt).not.toContain('hear me out'); // no message text leaves the archive
    expect(prompt).not.toContain('depot');
  });

  it('returns undefined on an API error or without a key', async () => {
    const seen = {};
    expect(
      await generateWrappedIntro(yearPeriod(2026), sampleStats(), (a) => a.authorName, {
        client: capturingClient(loadFixture('http-500-error'), seen),
      }),
    ).toBeUndefined();
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(await generateWrappedIntro(yearPeriod(2026), sampleStats(), (a) => a.authorName)).toBeUndefined();
  });
});

type Sent = { channelId: string; content: string; allowedMentions: { parse: never[] } };

/**
 * A guild where #banana-combo and #clips are public, and #mod-logs and #bot-testing (the report
 * channel) are mods-only.
 */
function fakeGuildChannels(sent: Sent[], sendImpl?: (channelId: string, content: string) => Promise<{ id: string }>) {
  const visible: Record<string, string[]> = {
    [MAIN]: [EVERYONE_ROLE, MOD_ROLE],
    [CLIPS]: [EVERYONE_ROLE, MOD_ROLE],
    [MODLOGS]: [MOD_ROLE],
    [REPORT]: [MOD_ROLE],
  };
  const permissioned = (id: string) => ({
    id,
    type: ChannelType.GuildText,
    permissionsFor: (role: { id: string }) => ({ has: () => visible[id].includes(role.id) }),
  });
  const guild = {
    id: GUILD_ID,
    channels: { cache: new Map(Object.keys(visible).map((id) => [id, permissioned(id)])) },
    roles: {
      cache: new Map([
        [EVERYONE_ROLE, { id: EVERYONE_ROLE }],
        [MOD_ROLE, { id: MOD_ROLE }],
      ]),
    },
    emojis: { cache: new Map([['300000000000000001', {}]]) },
  };
  return (id: string): WrappedChannel => ({
    ...permissioned(id),
    permissionsFor: permissioned(id).permissionsFor as unknown as WrappedChannel['permissionsFor'],
    guild,
    send: async (options) => {
      sent.push({ channelId: id, ...options });
      return sendImpl ? sendImpl(id, options.content) : { id: `posted-${sent.length}` };
    },
  });
}

function seedStore(store: ArchiveStore, at: number) {
  for (const [id, name] of [
    [MAIN, 'banana-combo'],
    [CLIPS, 'clips'],
    [MODLOGS, 'mod-logs'],
  ]) {
    store.upsertChannel({ id, guildId: GUILD_ID, name, parentId: null, type: ChannelType.GuildText });
  }
  store.upsertMessages([
    archiveInput({
      id: snowflake(at, 1),
      createdAt: at,
      content: 'public <:kekw:300000000000000001>',
      authorId: FELIX,
      reactions: [{ id: null, name: '😂', count: 2, me: true }],
    }),
    archiveInput({
      id: snowflake(at, 2),
      createdAt: at + MINUTE,
      content: 'clip',
      channelId: CLIPS,
      authorId: JASON,
      authorName: 'Jason',
      reactions: [{ id: '300000000000000001', name: 'kekw', count: 3 }],
    }),
    archiveInput({
      id: snowflake(at, 3),
      createdAt: at + 2 * MINUTE,
      content: `private mod stuff ${'x'.repeat(500)}`,
      channelId: MODLOGS,
      authorId: JASON,
      authorName: 'Jason',
      reactions: [{ id: null, name: '👀', count: 9 }],
    }),
  ]);
}

describe('runWrappedCheck', () => {
  // 2027-01-01 15:00 EST: 2026 is due.
  const NOW = Date.UTC(2027, 0, 1, 20, 0);
  const IN_2026 = Date.UTC(2026, 7, 14, 16, 0);
  let store: ArchiveStore;
  let sent: Sent[];
  let channel: (id: string, send?: (channelId: string, content: string) => Promise<{ id: string }>) => WrappedChannel;

  beforeEach(() => {
    store = new ArchiveStore(':memory:');
    sent = [];
    channel = (id, send) => fakeGuildChannels(sent, send)(id);
  });

  afterEach(() => {
    store.close();
  });

  function deps(overrides: Partial<WrappedDeps> = {}): WrappedDeps & { intro: ReturnType<typeof vi.fn> } {
    const intro = vi.fn(async () => 'what a year');
    return {
      now: () => new Date(NOW),
      store: () => store,
      channelId: () => MAIN,
      fetchChannel: async (id: string) => channel(id),
      botUserId: BOT_USER_ID,
      botName: 'Frigidaire',
      intro,
      syncBusy: () => false,
      ...overrides,
    } as WrappedDeps & { intro: ReturnType<typeof vi.fn> };
  }

  it('posts the year once, without pings, leaving private channels out', async () => {
    seedStore(store, IN_2026);
    const d = deps();
    await runWrappedCheck(d);
    expect(sent).toHaveLength(1);
    const text = sent[0].content;
    expect(sent[0]).toMatchObject({ channelId: MAIN, allowedMentions: { parse: [] } });
    expect(text).toContain('Wrapped — 2026**');
    expect(text).not.toContain('so far');
    expect(text).not.toContain('preview');
    expect(text).toContain('*what a year*');
    expect(text).toContain('💬 **2** messages from **2** people');
    expect(text).toContain('<:kekw:300000000000000001> ×1');
    // Jason's clip (3 kekw) beats Felix's message (2 😂, one of them the bot's own); mod-logs never counts.
    expect(text).toContain(`🔥 Most reacted message of the year: <@${JASON}> — 3 reactions (<:kekw:300000000000000001> ×3) — "clip"`);
    expect(text).not.toContain('private mod stuff');
    expect(text).not.toContain('👀');
    expect(d.intro).toHaveBeenCalledTimes(1);
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'posted', messageId: 'posted-1' });

    await runWrappedCheck(d);
    expect(sent).toHaveLength(1);
  });

  it('skips a year with nothing archived, and waits while the gap fill runs', async () => {
    await runWrappedCheck(deps({ syncBusy: () => true }));
    expect(getWrappedStatus('year:2026')).toBeUndefined();
    await runWrappedCheck(deps());
    expect(sent).toHaveLength(0);
    expect(getWrappedStatus('year:2026')?.status).toBe('skipped');
  });

  it('retries after a failed send or a missing channel', async () => {
    seedStore(store, IN_2026);
    await runWrappedCheck(deps({ fetchChannel: async () => undefined }));
    expect(getWrappedStatus('year:2026')?.status).toBe('retry');

    await runWrappedCheck(
      deps({
        fetchChannel: async (id) =>
          channel(id, async () => {
            throw new Error('Missing Permissions');
          }),
      }),
    );
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'retry', attempts: 2 });

    await runWrappedCheck(deps());
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'posted', attempts: 3 });
  });

  it('does not repost a partly sent (multi-message) post', async () => {
    seedStore(store, IN_2026);
    let calls = 0;
    await runWrappedCheck(
      deps({
        intro: async () => 'y'.repeat(270),
        fetchChannel: async (id) =>
          channel(id, async () => {
            calls++;
            if (calls > 1) throw new Error('rate limited');
            return { id: 'first-chunk' };
          }),
        // A long title forces a second chunk.
        botName: 'F'.repeat(1900),
      }),
    );
    expect(calls).toBe(2);
    expect(getWrappedStatus('year:2026')).toMatchObject({ status: 'posted', messageId: 'first-chunk' });
  });

  it('respects WRAPPED_LLM_INTRO=false and adds a coverage note while history is still importing', async () => {
    seedStore(store, IN_2026);
    vi.stubEnv('WRAPPED_LLM_INTRO', 'false');
    vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', CLIPS);
    const d = deps();
    await runWrappedCheck(d);
    expect(d.intro).not.toHaveBeenCalled();
    expect(sent[0].content).toContain('-# Still importing older history');
  });

  it('does nothing without a Wrapped channel or when nothing is due (the 1st of a normal month included)', async () => {
    seedStore(store, IN_2026);
    await runWrappedCheck(deps({ channelId: () => undefined }));
    await runWrappedCheck(deps({ now: () => new Date(Date.UTC(2026, 8, 1, 19, 0)) }));
    await runWrappedCheck(deps({ now: () => new Date(Date.UTC(2027, 0, 15)) }));
    expect(sent).toHaveLength(0);
    expect(getWrappedStatus('year:2026')).toBeUndefined();
    expect(getWrappedStatus('month:2026-08')).toBeUndefined();
  });

  it('filters by audience, not by accident: unfiltered, the mods-only message would count', () => {
    seedStore(store, IN_2026);
    const all = computeWrappedStats({ startMs: yearPeriod(2026).startMs, endMs: yearPeriod(2026).endMs }, { store });
    expect(all.totalMessages).toBe(3);
    expect(all.mostReacted?.content).toContain('private mod stuff');
  });
});

describe('preview', () => {
  // 2026-09-25 12:00 EDT.
  const NOW = Date.UTC(2026, 8, 25, 16, 0);
  const IN_2026 = Date.UTC(2026, 7, 14, 16, 0);
  const IN_2025 = Date.UTC(2025, 5, 1, 16, 0);
  let store: ArchiveStore;
  let sent: Sent[];
  let channelOf: (id: string) => WrappedChannel;

  beforeEach(() => {
    store = new ArchiveStore(':memory:');
    sent = [];
    channelOf = fakeGuildChannels(sent);
  });

  afterEach(() => {
    store.close();
  });

  function deps(overrides: Partial<WrappedDeps> = {}): WrappedDeps {
    return {
      now: () => new Date(NOW),
      store: () => store,
      channelId: () => MAIN,
      fetchChannel: async (id: string) => channelOf(id),
      botUserId: BOT_USER_ID,
      botName: 'Frigidaire',
      intro: async () => 'preview intro',
      syncBusy: () => false,
      ...overrides,
    };
  }

  it('parses the command', () => {
    expect(parseWrappedPreviewCommand('!wrapped')).toEqual({});
    expect(parseWrappedPreviewCommand('  !Wrapped 2025 ')).toEqual({ year: 2025 });
    expect(parseWrappedPreviewCommand('!wrapped please')).toBeUndefined();
    expect(parseWrappedPreviewCommand('wrapped')).toBeUndefined();
    expect(parseWrappedPreviewCommand('!wrapped 25')).toBeUndefined();
  });

  it('posts this year so far where it was asked, with the real audience, and never touches the watermark', async () => {
    seedStore(store, IN_2026);
    await runWrappedPreview({ channelId: REPORT }, deps());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelId: REPORT, allowedMentions: { parse: [] } });
    const lines = sent[0].content.split('\n');
    expect(lines[0]).toBe(`-# 👀 preview, not the real post: that one goes to <#${MAIN}> on Jan 1 at 3 PM ET`);
    expect(lines[1]).toBe('📦 **Frigidaire Wrapped — 2026 (so far)**');
    expect(lines[2]).toBe('*preview intro*');
    // The Wrapped channel is public, so the mods-only channel doesn't count even though the report
    // channel's readers could see it.
    expect(sent[0].content).toContain('💬 **2** messages from **2** people');
    expect(sent[0].content).not.toContain('private mod stuff');
    expect(sent[0].content).toContain(`-# counted 2 channels: <#${MAIN}>, <#${CLIPS}>`);
    expect(getWrappedStatus('preview:2026')).toBeUndefined();
    expect(getWrappedStatus('year:2026')).toBeUndefined();
  });

  it('counts what the report channel can see when it is the Wrapped channel too', async () => {
    seedStore(store, IN_2026);
    await runWrappedPreview({ channelId: REPORT }, deps({ channelId: () => REPORT }));
    expect(sent[0].content).toContain('💬 **3** messages');
    expect(sent[0].content).toContain('counted 3 channels');
  });

  it('previews a whole past year on request', async () => {
    seedStore(store, IN_2025);
    await runWrappedPreview({ channelId: REPORT, year: 2025 }, deps());
    expect(sent[0].content).toContain('📦 **Frigidaire Wrapped — 2025**');
    expect(sent[0].content).not.toContain('so far');
    expect(sent[0].content).toContain('💬 **2** messages');
  });

  it('says so for a future year, a busy gap fill, an empty year, or a missing Wrapped channel', async () => {
    await runWrappedPreview({ channelId: REPORT, year: 2031 }, deps());
    expect(sent.at(-1)?.content).toBe('-# no Wrapped for 2031: pick a year from 2015 to 2026.');

    await runWrappedPreview({ channelId: REPORT }, deps({ syncBusy: () => true }));
    expect(sent.at(-1)?.content).toContain('still catching up');

    await runWrappedPreview({ channelId: REPORT }, deps());
    expect(sent.at(-1)?.content).toContain('-# nothing archived for 2026');
    expect(sent.at(-1)?.content).toContain('counted no channels');

    seedStore(store, IN_2026);
    vi.stubEnv('WRAPPED_ENABLED', 'false');
    await runWrappedPreview(
      { channelId: REPORT },
      deps({ fetchChannel: async (id) => (id === REPORT ? channelOf(id) : undefined) }),
    );
    const text = sent.at(-1)?.content ?? '';
    expect(text).toContain(`⚠️ can't see the Wrapped channel <#${MAIN}>`);
    expect(text).toContain('WRAPPED_ENABLED=false');
    expect(text).toContain('💬 **3** messages'); // counted for the report channel's audience instead
  });

  it('answers a crash in character and logs it', async () => {
    seedStore(store, IN_2026);
    await runWrappedPreview(
      { channelId: REPORT },
      deps({
        store: () => {
          throw new Error('disk on fire');
        },
      }),
    );
    expect(sent.at(-1)?.content).toBe("-# couldn't build the Wrapped preview; the logs say why.");
  });
});
