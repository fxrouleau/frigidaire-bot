import { ChannelType, Collection, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { GUILD_ID, archivableMessage, archiveInput, snowflake } from '../test-support/fakeArchive';
import { ArchiveStore, compareSnowflakes } from './archiveStore';
import { ArchiveSync, type ArchiveSyncDeps, type HistorySource, discordSyncDeps, historySourceOf } from './backfill';

const CHANNEL = '100000000000000001';
const OTHER = '100000000000000002';
const T0 = Date.UTC(2024, 0, 1, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type FetchOptions = { before?: string; after?: string; limit: number };

type FakeHistory = HistorySource & { messages: Message[]; calls: FetchOptions[]; failures: unknown[] };

/** A channel with `count` messages one minute apart; fetchPage behaves like Discord's history endpoint. */
function fakeHistory(count: number, opts: { id?: string; name?: string; start?: number; botEvery?: number } = {}) {
  const id = opts.id ?? CHANNEL;
  const start = opts.start ?? T0;
  const messages = Array.from({ length: count }, (_, i) =>
    archivableMessage({
      id: snowflake(start + i * MINUTE),
      createdAt: start + i * MINUTE,
      channelId: id,
      content: `message ${i}`,
      // Other bots' messages are fetched (and advance the cursor) but not archived.
      ...(opts.botEvery && i % opts.botEvery === 0 ? { authorBot: true, authorId: '999' } : {}),
    }),
  );
  const history: FakeHistory = {
    id,
    type: ChannelType.GuildText,
    name: opts.name ?? 'bagel-bar',
    guildId: GUILD_ID,
    parentId: null,
    createdTimestamp: start - MINUTE,
    lastMessageId: messages.at(-1)?.id ?? null,
    messages,
    calls: [],
    failures: [],
    fetchPage: async (options) => {
      history.calls.push(options);
      const failure = history.failures.shift();
      if (failure) throw failure;
      const all = history.messages;
      // Discord returns newest first in every mode.
      if (options.before) {
        const before = options.before;
        return all
          .filter((m) => compareSnowflakes(m.id, before) < 0)
          .slice(-options.limit)
          .reverse();
      }
      if (options.after) {
        const after = options.after;
        return all
          .filter((m) => compareSnowflakes(m.id, after) > 0)
          .slice(0, options.limit)
          .reverse();
      }
      return all.slice(-options.limit).reverse();
    },
  };
  return history;
}

let store: ArchiveStore;
let now: number;
let sleeps: number[];
let channels: Map<string, HistorySource>;
let backfillIds: string[];

function makeDeps(overrides: Partial<ArchiveSyncDeps> = {}): ArchiveSyncDeps {
  return {
    store: () => store,
    resolveChannel: async (id) => channels.get(id),
    peekChannel: (id) => channels.get(id),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => now,
    delayMs: () => 1100,
    backfillChannelIds: () => backfillIds,
    ...overrides,
  };
}

beforeEach(() => {
  store = new ArchiveStore(':memory:');
  setBotDbForTesting(new BotDb(':memory:'));
  now = T0 + 1000 * HOUR;
  sleeps = [];
  channels = new Map();
  backfillIds = [CHANNEL];
});

afterEach(() => {
  setBotDbForTesting(undefined);
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('backfill', () => {
  it('pages backwards 100 at a time to the start of the channel, politely spaced, and marks it done', async () => {
    const history = fakeHistory(250);
    channels.set(CHANNEL, history);
    const sync = new ArchiveSync(makeDeps());
    expect(await sync.run()).toBe(true);

    expect(store.countMessages(CHANNEL)).toBe(250);
    expect(history.calls.map((c) => c.limit)).toEqual([100, 100, 100]);
    expect(history.calls[0].before).toBeUndefined();
    expect(history.calls[1].before).toBe(history.messages[150].id);
    expect(history.calls[2].before).toBe(history.messages[50].id);
    // No wait before the very first request, the configured delay before each later one.
    expect(sleeps).toEqual([1100, 1100]);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({ done: true, pages: 3, fetched: 250 });
    expect(store.getChannel(CHANNEL)?.name).toBe('bagel-bar');

    // A finished channel costs nothing on the next run.
    await new ArchiveSync(makeDeps()).run();
    expect(history.calls).toHaveLength(3);
  });

  it('resumes from its saved cursor after a restart, without refetching', async () => {
    const history = fakeHistory(250);
    channels.set(CHANNEL, history);
    const first = new ArchiveSync(
      makeDeps({
        sleep: async () => {
          first.stop(); // the process stops before the second request
        },
      }),
    );
    await first.run();
    expect(store.countMessages(CHANNEL)).toBe(100);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({
      done: false,
      cursorId: history.messages[150].id,
      lastError: null,
    });
    expect(history.calls).toHaveLength(1);

    await new ArchiveSync(makeDeps()).run();
    expect(store.countMessages(CHANNEL)).toBe(250);
    expect(history.calls.slice(1).map((c) => c.before)).toEqual([history.messages[150].id, history.messages[50].id]);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({ done: true, pages: 3 });
  });

  it('starts below the oldest message live ingest already archived', async () => {
    const history = fakeHistory(120);
    channels.set(CHANNEL, history);
    store.upsertMessages(history.messages.slice(100).map((m) => archiveInput({ id: m.id, createdAt: m.createdTimestamp })));

    await new ArchiveSync(makeDeps()).run();
    expect(history.calls[0].before).toBe(history.messages[100].id);
    expect(store.countMessages(CHANNEL)).toBe(120);
    expect(store.getBackfillState(CHANNEL)?.done).toBe(true);
  });

  it('finishes on an empty page when the history is an exact multiple of the page size', async () => {
    const history = fakeHistory(100);
    channels.set(CHANNEL, history);
    await new ArchiveSync(makeDeps()).run();
    expect(history.calls).toHaveLength(2);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({ done: true, pages: 2, cursorId: history.messages[0].id });
  });

  it('advances past pages of messages it does not archive (other bots)', async () => {
    const history = fakeHistory(150, { botEvery: 2 });
    channels.set(CHANNEL, history);
    await new ArchiveSync(makeDeps()).run();
    expect(store.countMessages(CHANNEL)).toBe(75);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({ done: true, fetched: 150 });
  });

  it('retries transient failures with backoff and carries on', async () => {
    const history = fakeHistory(50);
    history.failures.push(Object.assign(new Error('Service Unavailable'), { status: 503 }), new Error('ECONNRESET'));
    channels.set(CHANNEL, history);
    await new ArchiveSync(makeDeps()).run();
    expect(sleeps).toEqual([4000, 8000]); // max(2 s, delay) × 2^attempt
    expect(store.getBackfillState(CHANNEL)?.done).toBe(true);
  });

  it('gives up for an hour on missing access, then tries again', async () => {
    const history = fakeHistory(50);
    history.failures.push(Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }));
    channels.set(CHANNEL, history);
    const sync = new ArchiveSync(makeDeps());
    await sync.run();
    expect(history.calls).toHaveLength(1); // not retried
    expect(store.getBackfillState(CHANNEL)).toMatchObject({ done: false, lastError: 'fetch failed' });

    await sync.run();
    expect(history.calls).toHaveLength(1);

    now += HOUR;
    await sync.run();
    expect(store.getBackfillState(CHANNEL)).toMatchObject({ done: true, lastError: null });
  });

  it('records an error for a channel that is missing, unreadable, ignored or not a text channel', async () => {
    backfillIds = [CHANNEL, OTHER, '100000000000000009'];
    channels.set(OTHER, { ...fakeHistory(5, { id: OTHER }), type: ChannelType.GuildVoice });
    await new ArchiveSync(makeDeps({ resolveChannel: async (id) => (id === CHANNEL ? undefined : channels.get(id)) })).run();
    expect(store.getBackfillState(CHANNEL)?.lastError).toBe('channel not found or not readable');
    expect(store.getBackfillState(OTHER)?.lastError).toBe('channel is not a text channel or thread');

    vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', OTHER);
    now += 2 * HOUR;
    await new ArchiveSync(makeDeps()).run();
    expect(store.getBackfillState(OTHER)?.lastError).toBe('channel is in ARCHIVE_IGNORE_CHANNELS');

    await new ArchiveSync(
      makeDeps({
        resolveChannel: async () => {
          throw new Error('Unknown Channel');
        },
      }),
    ).backfill();
    expect(store.getBackfillState('100000000000000009')?.lastError).toBe('channel not found or not readable');
  });

  it('logs progress with a storage estimate every 25 pages', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    channels.set(CHANNEL, fakeHistory(2550));
    await new ArchiveSync(makeDeps()).run();
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('back to') && l.includes('projected') && l.includes('B/message'))).toBe(true);
    expect(lines.some((l) => l.includes('complete') && l.includes('2,550 message(s)'))).toBe(true);
  });

  it('refuses to start a second run while one is in progress', async () => {
    const history = fakeHistory(10);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    history.fetchPage = async () => {
      await gate;
      return [];
    };
    channels.set(CHANNEL, history);
    const sync = new ArchiveSync(makeDeps());
    const first = sync.run();
    await Promise.resolve();
    expect(sync.status()).toEqual({ running: true, phase: 'backfill' });
    expect(await sync.run()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(sync.status()).toEqual({ running: false, phase: 'idle' });
  });
});

describe('gap fill', () => {
  it('pages forward from the newest archived message of every channel with history', async () => {
    backfillIds = [];
    const history = fakeHistory(260);
    channels.set(CHANNEL, history);
    store.upsertMessages(history.messages.slice(0, 10).map((m) => archiveInput({ id: m.id, createdAt: m.createdTimestamp })));

    const added = await new ArchiveSync(makeDeps()).gapFill();
    expect(added).toBe(250);
    expect(history.calls.map((c) => c.after)).toEqual([
      history.messages[9].id,
      history.messages[109].id,
      history.messages[209].id,
    ]);
    expect(store.countMessages(CHANNEL)).toBe(260);
  });

  it('costs no request for an up-to-date channel, or one that is gone from the cache', async () => {
    backfillIds = [];
    const upToDate = fakeHistory(5);
    channels.set(CHANNEL, upToDate);
    store.upsertMessages(upToDate.messages.map((m) => archiveInput({ id: m.id, createdAt: m.createdTimestamp })));
    store.upsertMessage(archiveInput({ id: snowflake(T0, 1), channelId: OTHER }));

    expect(await new ArchiveSync(makeDeps()).gapFill()).toBe(0);
    expect(upToDate.calls).toHaveLength(0);
  });
});

describe('maintenance', () => {
  it('resumes an unfinished backfill when nothing is running', async () => {
    const history = fakeHistory(30);
    channels.set(CHANNEL, history);
    const sync = new ArchiveSync(makeDeps());
    sync.maintenance();
    await vi.waitFor(() => expect(store.getBackfillState(CHANNEL)?.done).toBe(true));

    sync.maintenance(); // done ⇒ nothing to resume
    expect(history.calls).toHaveLength(1);
  });

  it('does not resume when backfill is disabled', () => {
    vi.stubEnv('ARCHIVE_BACKFILL_ENABLED', 'false');
    const history = fakeHistory(30);
    channels.set(CHANNEL, history);
    new ArchiveSync(makeDeps()).maintenance();
    expect(history.calls).toHaveLength(0);
  });
});

describe('discord.js adapters', () => {
  it('wraps a text channel as a history source that fetches without caching', async () => {
    const fetch = vi.fn(async (_options: object) => new Collection<string, Message>([['1', archivableMessage()]]));
    const source = historySourceOf({
      id: CHANNEL,
      type: ChannelType.GuildText,
      name: 'bagel-bar',
      isTextBased: () => true,
      messages: { fetch },
    });
    expect(source?.name).toBe('bagel-bar');
    expect(await source?.fetchPage({ before: '5', limit: 100 })).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith({ before: '5', limit: 100, cache: false });

    expect(historySourceOf(undefined)).toBeUndefined();
    expect(historySourceOf({ id: '1', type: ChannelType.GuildVoice, isTextBased: () => false })).toBeUndefined();
  });

  it('resolves channels from the cache first, then the API', async () => {
    const cached = { id: CHANNEL, type: ChannelType.GuildText, isTextBased: () => true, messages: { fetch: vi.fn() } };
    const fetched = { ...cached, id: OTHER };
    const client = {
      channels: { cache: new Collection([[CHANNEL, cached]]), fetch: vi.fn(async () => fetched) },
    } as unknown as Parameters<typeof discordSyncDeps>[0];
    const deps = discordSyncDeps(client);
    expect((await deps.resolveChannel(CHANNEL))?.id).toBe(CHANNEL);
    expect((await deps.resolveChannel(OTHER))?.id).toBe(OTHER);
    expect(deps.peekChannel(OTHER)).toBeUndefined();
    expect(deps.delayMs()).toBe(1100);
  });
});
