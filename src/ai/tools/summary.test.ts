import { Collection, type FetchMessagesOptions, type Message, SnowflakeUtil } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_MODEL } from '../../config';
import { recordRelay } from '../../relay';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { type CapturedRequest, chatCompletionBody, createCapturingClient } from '../../test-support/capturingClient';
import { createFakeBotMessage, createFakeMessage, type FakeMessageOptions } from '../../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { FEATURE_HEADER } from '../usage';
import { runSummaryTool, summarizeChannel, summarizeChannelResult } from './summary';

// Cached voice transcripts, keyed by message id (the media feature's cache, stubbed).
const transcripts = vi.hoisted(() => new Map<string, string>());
vi.mock('../media', () => ({
  getCachedTranscript: (messageId: string) => transcripts.get(messageId),
  transcribeAudio: async () => undefined,
}));

// "Now" for every test: 2026-01-15 12:00 Eastern (EST, UTC-5).
const NOW = new Date('2026-01-15T17:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let store: MemoryStore;
let seq = 0;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  transcripts.clear();
  store.upsertIdentity('u-jasper', 'Jasper');
  store.upsertIdentity('u-remi', 'Remi');
  store.updateIdentityMeta('u-remi', { irl_name: 'Rémi L', aliases_add: ['Fefe'] });
  store.upsertIdentity('u-silas', 'Silas');
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

/** A real snowflake for a timestamp, so `before` pagination behaves like Discord's. */
function snowflake(at: Date): string {
  seq += 1;
  return SnowflakeUtil.generate({ timestamp: at, increment: BigInt(seq % 4096), workerId: 1n, processId: 1n }).toString();
}

function msgAt(minutesAgo: number, opts: FakeMessageOptions = {}): Message {
  const createdAt = new Date(NOW.getTime() - minutesAgo * MIN);
  return createFakeMessage({ messageId: snowflake(createdAt), createdAt, ...opts }).message;
}

function said(minutesAgo: number, who: 'jasper' | 'remi' | 'silas', content: string, opts: FakeMessageOptions = {}) {
  const names = { jasper: 'Jasper', remi: 'Remi', silas: 'Silas' };
  return msgAt(minutesAgo, { authorId: `u-${who}`, authorDisplayName: names[who], content, ...opts });
}

type Channel = { trigger: Message; fetchCalls: FetchMessagesOptions[] };

/**
 * A trigger message whose channel serves `history` with Discord's pagination semantics: newest first,
 * `before` exclusive, at most `limit` per page.
 */
function channelWith(history: Message[], trigger: Message = said(0, 'remi', '@Frigidaire catch me up')): Channel {
  const all = [...history, trigger].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  const fetchCalls: FetchMessagesOptions[] = [];
  const channel = trigger.channel as unknown as {
    name: string;
    messages: { fetch: (opts: FetchMessagesOptions) => Promise<Collection<string, Message>> };
  };
  channel.name = 'bagel-bar';
  channel.messages.fetch = async (opts: FetchMessagesOptions) => {
    fetchCalls.push(opts);
    const before = opts.before ? BigInt(opts.before) : undefined;
    const page = all.filter((m) => before === undefined || BigInt(m.id) < before).slice(0, opts.limit ?? 50);
    return new Collection(page.map((m) => [m.id, m]));
  };
  return { trigger, fetchCalls };
}

function okClient(summary = 'Jasper and Silas argued about pizza.') {
  return createCapturingClient([{ body: chatCompletionBody(summary) }]);
}

function userPrompt(request: CapturedRequest): string {
  const messages = request.body.messages as { role: string; content: string }[];
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

const now = () => NOW;

describe('summarizeChannel', () => {
  it('calls OpenRouter with the chat model, ZDR routing and the summary feature tag', async () => {
    const { trigger } = channelWith([said(30, 'jasper', 'pineapple pizza is elite'), said(20, 'silas', 'no')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe(DEFAULT_CHAT_MODEL);
    expect(requests[0].body.provider).toEqual({ zdr: true });
    expect(requests[0].headers.get(FEATURE_HEADER)).toBe('summary');
    expect(result).toContain('Jasper and Silas argued about pizza.');
    expect(result).toMatch(/^Summary of #bagel-bar from 2026-01-15 11:00 to 2026-01-15 12:00 Eastern \(2 messages from 2 people\):/);
  });

  it('renders Eastern timestamps, leaves out the request itself and anything outside the range', async () => {
    const { trigger } = channelWith([
      said(120, 'jasper', 'too early to count'),
      said(45, 'jasper', 'who is up for wings tonight'),
      said(40, 'silas', 'me'),
    ]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('[2026-01-15 11:15] Jasper: who is up for wings tonight');
    expect(prompt).toContain('[2026-01-15 11:20] Silas: me');
    expect(prompt).not.toContain('too early to count');
    expect(prompt).not.toContain('catch me up');
  });

  it('attributes relayed messages to their real author, keeps the bot, and drops other bots', async () => {
    const relay = msgAt(30, { webhookId: 'wh-1', authorUsername: 'Jasper', content: 'https://fxtwitter.com/x/status/1' });
    recordRelay({ messageId: relay.id, channelId: 'channel-1', authorId: 'u-jasper', authorName: 'Jasper', kind: 'link_fix' });
    const botReply = createFakeBotMessage({
      messageId: snowflake(new Date(NOW.getTime() - 25 * MIN)),
      createdAt: new Date(NOW.getTime() - 25 * MIN),
      content: 'that tweet is fake',
    }).message;
    const otherBot = msgAt(24, { authorId: 'music-bot', authorIsBot: true, authorDisplayName: 'Jockie', content: 'Now playing' });
    const foreignWebhook = msgAt(23, { webhookId: 'wh-2', applicationId: 'other-app', authorUsername: 'Jasper', content: 'rss item' });
    const { trigger } = channelWith([relay, botReply, otherBot, foreignWebhook, said(20, 'silas', 'lol')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('Jasper: https://fxtwitter.com/x/status/1');
    expect(prompt).toContain('Frigidaire (bot): that tweet is fake');
    expect(prompt).not.toContain('Now playing');
    expect(prompt).not.toContain('rss item');
    // The bot is not counted as one of the people talking.
    expect(result).toContain('(3 messages from 2 people)');
  });

  it('adds link-preview text, attachments, stickers, cached voice transcripts and reply context', async () => {
    const tweet = said(50, 'jasper', 'https://fxtwitter.com/nasa/status/1', {
      embeds: [{ authorName: 'NASA (@NASA)', description: 'Artemis launch moved to Friday', url: 'https://x.com/nasa' }],
    });
    const voice = said(45, 'silas', '', { attachments: [{ url: 'https://cdn.example/voice.ogg', contentType: 'audio/ogg' }] });
    transcripts.set(voice.id, 'I am not driving to Laval again');
    const reply = said(40, 'remi', 'fair', { referencedMessageId: voice.id, stickers: [{ id: 's1', name: 'pepe', format: 1 }] });
    const photo = said(35, 'jasper', '<:trolle:111> look <@222333444555666777>', {
      attachments: [{ url: 'https://cdn.example/a.png', contentType: 'image/png' }],
      mentionedUsers: [{ id: '222333444555666777', displayName: 'Silas' }],
    });
    const { trigger } = channelWith([tweet, voice, reply, photo]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('[link: NASA (@NASA) — Artemis launch moved to Friday]');
    expect(prompt).toContain('Silas: [audio] [voice message transcript: I am not driving to Laval again]');
    expect(prompt).toContain('Remi (replying to Silas): fair [sticker: pepe]');
    expect(prompt).toContain('Jasper: :trolle: look @Silas [image]');
  });

  it("leaves out the bot's transcript replies: the voice message's line carries the transcript", async () => {
    const voice = said(45, 'silas', '', { attachments: [{ url: 'https://cdn.example/voice.ogg', contentType: 'audio/ogg' }] });
    transcripts.set(voice.id, 'I am not driving to Laval again');
    const at = new Date(NOW.getTime() - 44 * MIN);
    const transcriptReply = createFakeBotMessage({
      messageId: snowflake(at),
      createdAt: at,
      content: '-# 🎙️ transcript\n> I am not driving to Laval again',
      referencedMessageId: voice.id,
    }).message;
    const { trigger } = channelWith([voice, transcriptReply, said(40, 'remi', 'fair')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('Silas: [audio] [voice message transcript: I am not driving to Laval again]');
    expect(prompt).not.toContain('(bot)');
    expect(prompt.split('I am not driving to Laval again')).toHaveLength(2);
    expect(result).toContain('(2 messages from 2 people)');
  });

  it('names people by their current display name from the identities table', async () => {
    // Fetched history often has no member data: the author's global name is all the message carries.
    const { trigger } = channelWith([said(30, 'jasper', 'hi', { memberIsNull: true, authorDisplayName: 'jay_global' })]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(userPrompt(requests[0])).toContain('] Jasper: hi');
  });

  it("gives a who's-who with background memories for the people who talked and the people referenced", async () => {
    store.upsertIdentity('u-jasper', 'Jasper', 'lapinlune');
    store.upsertIdentity('u-bob', 'Bob');
    store.upsertIdentity('123456789012345678', 'Wheelie');
    await store.save({ category: 'fact', subject: 'Jasper', subject_user_id: 'u-jasper', content: 'Works nights at the depot' });
    // Filed under his handle, without an id: still his (every name he goes by counts).
    await store.save({ category: 'preference', subject: 'lapinlune', content: 'Hates pineapple on pizza' });
    await store.save({ category: 'event', subject: 'Jasper', subject_user_id: 'u-jasper', content: 'Moving apartments on Saturday' });
    await store.save({ category: 'image', subject: 'Jasper', subject_user_id: 'u-jasper', content: 'Shared a hotdog photo' });
    await store.save({ category: 'fact', subject: 'Remi', subject_user_id: 'u-remi', content: 'Owns a husky named Loki' });
    await store.save({ category: 'fact', subject: 'Bob', subject_user_id: 'u-bob', content: 'Lives in Ottawa' });
    const { trigger } = channelWith([
      said(30, 'jasper', 'has anyone seen fefe today'),
      said(25, 'silas', 'no but <@123456789012345678> owes me 20 bucks'),
    ]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain("WHO'S WHO");
    expect(prompt).toContain('- Jasper (@lapinlune) [1 message]');
    expect(prompt).toMatch(/background: .*Works nights at the depot/);
    expect(prompt).toMatch(/background: .*Hates pineapple on pizza/);
    expect(prompt).toContain('- Silas [1 message]');
    expect(prompt).toContain("- Remi — real name Rémi L; also called Fefe [mentioned, didn't talk]");
    expect(prompt).toContain('background: Owns a husky named Loki');
    expect(prompt).toContain("- Wheelie [mentioned, didn't talk]");
    // Moments are not background, and nobody outside the stretch is listed.
    expect(prompt).not.toContain('Moving apartments');
    expect(prompt).not.toContain('hotdog');
    expect(prompt).not.toContain('Bob');
    expect(prompt).not.toContain('Ottawa');

    const system = (requests[0].body.messages as { role: string; content: string }[])[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Report only what is in the transcript');
    // The tool's summary goes to the chat model, which relays it.
    expect(system.content).toContain("handed to the group's bot");
    expect(system.content).toContain('Never state a fact from them unless the transcript itself says it');

    expect(result.split('\n').at(-1)).toBe('People in this stretch: Jasper, Silas; mentioned without talking: Remi (Rémi L), Wheelie.');
  });

  it("counts a linked side account's messages and names as its member (LINKED_ACCOUNTS)", async () => {
    const MAIN = '120000000000000001';
    const SIDE = '120000000000000002';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    try {
      store.upsertIdentity(MAIN, 'Toby', 'toby_main');
      store.upsertIdentity(SIDE, 'Tohbee', 'tobyclone');
      await store.save({ category: 'fact', subject: 'Toby', subject_user_id: MAIN, content: 'Owns a canoe' });
      // Filed under the side account's name, without an id: still his.
      await store.save({ category: 'fact', subject: 'Tohbee', content: 'Lives in Laval' });
      const { trigger } = channelWith([
        msgAt(30, { authorId: MAIN, authorDisplayName: 'Toby', content: 'on my main now' }),
        msgAt(25, { authorId: SIDE, authorDisplayName: 'Tohbee', content: 'and now on my alt' }),
        said(20, 'silas', 'tohbee is the same guy lol'),
      ]);
      const { client, requests } = okClient();

      const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('] Toby: and now on my alt');
      expect(prompt).toContain('- Toby (@toby_main) [2 messages]');
      expect(prompt).toMatch(/background: .*Owns a canoe/);
      expect(prompt).toMatch(/background: .*Lives in Laval/);
      expect(prompt).not.toContain('- Tohbee');
      expect(result.split('\n').at(-1)).toBe('People in this stretch: Toby, Silas.');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('caps background at the 8 most active people and 4 memories each, and never throws on a memory failure', async () => {
    const history: Message[] = [];
    for (let p = 0; p < 10; p++) {
      store.upsertIdentity(`u-p${p}`, `Person${p}`);
      for (let m = 0; m < 5; m++) {
        await store.save({ category: 'fact', subject: `Person${p}`, subject_user_id: `u-p${p}`, content: `trait ${m} of person ${p} xyz${p}${m}` });
      }
      // Person0 talks the most, Person9 the least.
      for (let n = 0; n < 10 - p; n++) {
        history.push(msgAt(50 - p - n / 20, { authorId: `u-p${p}`, authorDisplayName: `Person${p}`, content: `hello ${n}` }));
      }
    }
    const { trigger } = channelWith(history);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    const whoIsWho = prompt.slice(prompt.indexOf("WHO'S WHO"), prompt.indexOf('TRANSCRIPT:'));
    const backgrounds = whoIsWho.split('\n').filter((line) => line.trim().startsWith('background:'));
    expect(backgrounds).toHaveLength(8);
    for (const line of backgrounds) expect(line.split(' | ')).toHaveLength(4);
    expect(whoIsWho).toContain('- Person0 [10 messages]');
    expect(whoIsWho).toContain('- Person9 [1 message]');
    expect(whoIsWho.indexOf('Person0')).toBeLessThan(whoIsWho.indexOf('Person9'));
    expect(whoIsWho).not.toMatch(/xyz9\d/);

    // A memory-store failure costs the background, never the summary.
    vi.spyOn(store, 'getForPerson').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const again = okClient();
    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client: again.client, now });
    expect(result).toContain('Jasper and Silas argued about pizza.');
    expect(userPrompt(again.requests[0])).not.toContain('background:');
  });

  it('names who asked', async () => {
    const { trigger } = channelWith([said(30, 'jasper', 'anyway')]);
    const { client, requests } = okClient();

    await summarizeChannel({
      message: trigger,
      start: new Date(NOW.getTime() - HOUR),
      requesterId: 'u-remi',
      client,
      now,
    });

    expect(userPrompt(requests[0])).toContain('Requested by Remi.');
  });

  it('drops the OLDEST messages first when the range is over budget, and says so', async () => {
    const history: Message[] = [];
    for (let i = 0; i < 160; i++) {
      history.push(said(200 - i, i % 2 ? 'jasper' : 'silas', `${i === 0 ? 'OLDEST' : i === 159 ? 'NEWEST' : 'msg'} ${'x'.repeat(1500)}`));
    }
    const { trigger } = channelWith(history);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - 5 * HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('NEWEST');
    expect(prompt).not.toContain('OLDEST');
    expect(prompt).toMatch(/\[\d+ older messages, before 2026-01-15 \d\d:\d\d, are left out/);
    expect(prompt.length).toBeLessThan(220_000);
    expect(result).toMatch(/the \d+ oldest messages were skipped/);
  });

  it('pages back through history with `before` and stops once it passes the start', async () => {
    const history: Message[] = [];
    for (let i = 0; i < 250; i++) history.push(said(250 - i, 'jasper', `m${i}`));
    const { trigger, fetchCalls } = channelWith(history);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - 120 * MIN), client, now });

    // 120 minutes of messages at one per minute: two pages cover them; the third page is never needed.
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toMatchObject({ limit: 100, before: trigger.id });
    expect(userPrompt(requests[0])).toContain('Range: 2026-01-15 10:00 to 2026-01-15 12:00 (Eastern), 120 messages.');
  });

  it('starts fetching at the end of the range when it ends before the request', async () => {
    const { trigger, fetchCalls } = channelWith([said(600, 'jasper', 'last night stuff'), said(30, 'silas', 'today stuff')]);
    const { client, requests } = okClient();

    await summarizeChannel({
      message: trigger,
      start: new Date(NOW.getTime() - 12 * HOUR),
      end: new Date(NOW.getTime() - 6 * HOUR),
      client,
      now,
    });

    expect(fetchCalls[0].before).not.toBe(trigger.id);
    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('last night stuff');
    expect(prompt).not.toContain('today stuff');
  });

  it('reports an empty range without calling the model', async () => {
    const { trigger } = channelWith([said(600, 'jasper', 'old')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(result).toMatch(/no messages in #bagel-bar between 2026-01-15 11:00 and 2026-01-15 12:00/);
    expect(requests).toHaveLength(0);
  });

  it('turns a Discord fetch failure (missing permission) into a plain explanation', async () => {
    const { trigger } = channelWith([]);
    (trigger.channel as unknown as { messages: { fetch: () => Promise<never> } }).messages.fetch = async () => {
      throw new Error('Missing Access');
    };
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(result).toMatch(/couldn't read this channel's history/i);
    expect(requests).toHaveLength(0);
  });

  it('turns a model failure or an empty answer into a plain explanation', async () => {
    const { trigger } = channelWith([said(30, 'jasper', 'anyway')]);
    const failing = createCapturingClient([{ status: 500, body: { error: { message: 'boom', code: 500 } } }]);
    const empty = createCapturingClient([{ body: chatCompletionBody('   ') }]);

    const start = new Date(NOW.getTime() - HOUR);
    expect(await summarizeChannel({ message: trigger, start, client: failing.client, now })).toMatch(/model call failed/);
    expect(await summarizeChannel({ message: trigger, start, client: empty.client, now })).toMatch(/returned nothing/);
  });
});

describe('runSummaryTool (summarize_messages arguments)', () => {
  it('reads start/end as Eastern wall-clock time', async () => {
    const { trigger } = channelWith([said(90, 'jasper', 'in range'), said(200, 'jasper', 'before range')]);
    const { client, requests } = okClient();

    // 10:00–11:45 EST = 15:00–16:45 UTC; NOW is 17:00 UTC.
    const result = await runSummaryTool(trigger, { start_time: '2026-01-15 10:00', end_time: '2026-01-15 11:45' }, { client, now });

    expect(result).toContain('from 2026-01-15 10:00 to 2026-01-15 11:45 Eastern');
    expect(userPrompt(requests[0])).toContain('in range');
    expect(userPrompt(requests[0])).not.toContain('before range');
  });

  it('still honors an explicit UTC offset', async () => {
    const { trigger } = channelWith([said(30, 'jasper', 'anyway')]);
    const { client } = okClient();

    const result = await runSummaryTool(trigger, { start_time: '2026-01-15T16:00:00Z' }, { client, now });

    expect(result).toContain('from 2026-01-15 11:00 to 2026-01-15 12:00 Eastern');
  });

  it('defaults the end to now and clamps a future end', async () => {
    const { trigger } = channelWith([said(30, 'jasper', 'anyway')]);
    const { client } = okClient();

    const result = await runSummaryTool(trigger, { start_time: '2026-01-15 11:00', end_time: '2026-01-16 11:00' }, { client, now });

    expect(result).toContain('to 2026-01-15 12:00 Eastern');
  });

  it('caps the range at 7 days and says so', async () => {
    const { trigger, fetchCalls } = channelWith([said(30, 'jasper', 'anyway')]);
    const { client } = okClient();

    const result = await runSummaryTool(trigger, { start_time: '2026-01-01 00:00' }, { client, now });

    expect(result).toContain('from 2026-01-08 12:00 to 2026-01-15 12:00 Eastern');
    expect(result).toMatch(/at most 7 days, so this starts at 2026-01-08 12:00 instead of 2026-01-01 00:00/);
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it('rejects unparseable times, a missing start and an inverted range without any network call', async () => {
    const { trigger, fetchCalls } = channelWith([]);
    const { client, requests } = okClient();

    expect(await runSummaryTool(trigger, { start_time: 'last night' }, { client, now })).toMatch(/Invalid start_time/);
    expect(await runSummaryTool(trigger, { start_time: '2026-01-15 10:00', end_time: 'soon' }, { client, now })).toMatch(
      /Invalid end_time/,
    );
    expect(await runSummaryTool(trigger, {}, { client, now })).toMatch(/start_time.*since_my_last_message/);
    expect(await runSummaryTool(trigger, { start_time: '2026-01-15 11:00', end_time: '2026-01-15 10:00' }, { client, now })).toMatch(
      /must be before/,
    );
    expect(fetchCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  describe('since_my_last_message', () => {
    it("starts right after the asker's last message and tells the summarizer what they missed", async () => {
      const { trigger } = channelWith([
        said(200, 'remi', 'heading out'),
        said(150, 'jasper', 'remi left lol'),
        said(100, 'silas', 'wings at 8'),
      ]);
      const { client, requests } = okClient();

      const result = await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('remi left lol');
      expect(prompt).toContain('wings at 8');
      expect(prompt).not.toContain('heading out');
      expect(prompt).toContain('Requested by Remi, who was last active here at 2026-01-15 08:40: this is what they missed.');
      expect(result).toContain('from 2026-01-15 08:40 to 2026-01-15 12:00 Eastern');
    });

    it('skips the messages of the current visit ("yo" right before "catch me up")', async () => {
      const { trigger } = channelWith([
        said(300, 'remi', 'gn'),
        said(200, 'jasper', 'big news'),
        said(3, 'remi', 'yo'),
      ]);
      const { client, requests } = okClient();

      await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('big news');
      expect(prompt).not.toContain('] Remi: gn');
    });

    it("counts the asker's relayed messages as theirs", async () => {
      const relay = msgAt(60, { webhookId: 'wh-1', authorUsername: 'Remi', content: 'https://fxtwitter.com/y/status/2' });
      recordRelay({ messageId: relay.id, channelId: 'channel-1', authorId: 'u-remi', authorName: 'Remi', kind: 'link_fix' });
      const { trigger } = channelWith([said(300, 'remi', 'old'), relay, said(30, 'jasper', 'after the link')]);
      const { client, requests } = okClient();

      await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('after the link');
      expect(prompt).not.toContain('fxtwitter');
    });

    it('reuses the messages it scanned instead of fetching them again', async () => {
      const { trigger, fetchCalls } = channelWith([said(200, 'remi', 'bye'), said(100, 'jasper', 'hi')]);
      const { client } = okClient();

      await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      expect(fetchCalls).toHaveLength(1);
    });

    it('tells the model when there is no earlier message within 7 days', async () => {
      const { trigger } = channelWith([said(8 * 24 * 60, 'remi', 'ancient'), said(100, 'jasper', 'hi')]);
      const { client, requests } = okClient();

      const result = await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      expect(result).toMatch(/Remi has no earlier message in #bagel-bar going back to 2026-01-08 12:00/);
      expect(result).toMatch(/start_time/);
      expect(requests).toHaveLength(0);
    });
  });
});

describe('summarizeChannelResult', () => {
  it('returns the summary, header, caveats and people footer as data', async () => {
    const { trigger } = channelWith([said(30, 'jasper', 'pineapple pizza is elite'), said(20, 'silas', 'no')]);
    const { client } = okClient();

    const result = await summarizeChannelResult({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(result).toEqual({
      ok: true,
      summary: 'Jasper and Silas argued about pizza.',
      header: 'Summary of #bagel-bar from 2026-01-15 11:00 to 2026-01-15 12:00 Eastern (2 messages from 2 people):',
      caveats: [],
      peopleFooter: 'People in this stretch: Jasper, Silas.',
    });
    // summarizeChannel() is the same result, formatted for the chat model.
    const text = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client: okClient().client, now });
    expect(text).toBe(
      [
        'Summary of #bagel-bar from 2026-01-15 11:00 to 2026-01-15 12:00 Eastern (2 messages from 2 people):',
        'Jasper and Silas argued about pizza.',
        'People in this stretch: Jasper, Silas.',
      ].join('\n'),
    );
  });

  it('says why there is no summary', async () => {
    const empty = channelWith([said(120, 'jasper', 'too early')]);
    expect(
      await summarizeChannelResult({ message: empty.trigger, start: new Date(NOW.getTime() - HOUR), client: okClient().client, now }),
    ).toMatchObject({ ok: false, reason: 'no_messages', message: expect.stringMatching(/^There are no messages in #bagel-bar/) });

    const { trigger } = channelWith([said(30, 'jasper', 'hi')]);
    const broken = createCapturingClient([{ status: 500, body: { error: { message: 'upstream died' } } }]);
    expect(await summarizeChannelResult({ message: trigger, start: new Date(NOW.getTime() - HOUR), client: broken.client, now })).toMatchObject({
      ok: false,
      reason: 'model_failed',
    });
    const blank = createCapturingClient([{ body: chatCompletionBody('   ') }]);
    expect(await summarizeChannelResult({ message: trigger, start: new Date(NOW.getTime() - HOUR), client: blank.client, now })).toMatchObject({
      ok: false,
      reason: 'model_empty',
    });

    const unreadable = channelWith([said(30, 'jasper', 'hi')]);
    (unreadable.trigger.channel as unknown as { messages: { fetch: () => Promise<never> } }).messages.fetch = async () => {
      throw new Error('Missing Access');
    };
    expect(
      await summarizeChannelResult({ message: unreadable.trigger, start: new Date(NOW.getTime() - HOUR), client: okClient().client, now }),
    ).toMatchObject({ ok: false, reason: 'history_unreadable' });
  });

  it("summarizes from a target message: it is included, and history is read back from the range's end", async () => {
    const before = said(50, 'silas', 'said before the target');
    const target = said(40, 'jasper', 'the target itself');
    const after = [said(30, 'remi', 'first reply'), said(20, 'silas', 'second reply')];
    const { fetchCalls } = channelWith([before, ...after], target);
    const { client, requests } = okClient();

    const result = await summarizeChannelResult({
      message: target,
      messageRole: 'target',
      start: target.createdAt,
      end: NOW,
      requesterId: 'u-remi',
      client,
      now,
    });

    expect(result.ok).toBe(true);
    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('Jasper: the target itself');
    expect(prompt).toContain('Remi: first reply');
    expect(prompt).toContain('Silas: second reply');
    expect(prompt).not.toContain('said before the target');
    expect(prompt).toContain('Requested by Remi.');
    // Paged from the end of the range, not from the target (which would only see older messages).
    expect(BigInt(String(fetchCalls[0].before))).toBeGreaterThan(BigInt(after[1].id));

    // A requester the identities table doesn't know is never mistaken for the target's author.
    const again = okClient();
    await summarizeChannelResult({
      message: target,
      messageRole: 'target',
      start: target.createdAt,
      requesterId: 'u-stranger',
      client: again.client,
      now,
    });
    expect(userPrompt(again.requests[0])).not.toContain('Requested by');
  });
});
