import { Collection, type FetchMessagesOptions, type Message, SnowflakeUtil } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordRelay } from '../../relay';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { type CapturedRequest, chatCompletionBody, createCapturingClient } from '../../test-support/capturingClient';
import { createFakeBotMessage, createFakeMessage, type FakeMessageOptions } from '../../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { FEATURE_HEADER } from '../usage';
import { prepareSummaryPrompt, runSummaryTool, summarizeChannel } from './summary';

// Cached voice transcripts, keyed by message id (the media feature's cache, stubbed).
const transcripts = vi.hoisted(() => new Map<string, string>());
vi.mock('../media', () => ({
  getCachedTranscript: (messageId: string) => transcripts.get(messageId),
  transcribeAudio: async () => undefined,
  describeVideo: async () => undefined,
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
  store.upsertIdentity('u-jason', 'Jason');
  store.upsertIdentity('u-felix', 'Felix');
  store.updateIdentityMeta('u-felix', { irl_name: 'Félix R', aliases_add: ['Fefe'] });
  store.upsertIdentity('u-simon', 'Simon');
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

function said(minutesAgo: number, who: 'jason' | 'felix' | 'simon', content: string, opts: FakeMessageOptions = {}) {
  const names = { jason: 'Jason', felix: 'Felix', simon: 'Simon' };
  return msgAt(minutesAgo, { authorId: `u-${who}`, authorDisplayName: names[who], content, ...opts });
}

type Channel = { trigger: Message; fetchCalls: FetchMessagesOptions[] };

/**
 * A trigger message whose channel serves `history` with Discord's pagination semantics: newest first,
 * `before` exclusive, at most `limit` per page.
 */
function channelWith(history: Message[], trigger: Message = said(0, 'felix', '@Frigidaire catch me up')): Channel {
  const all = [...history, trigger].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  const fetchCalls: FetchMessagesOptions[] = [];
  const channel = trigger.channel as unknown as {
    name: string;
    messages: { fetch: (opts: FetchMessagesOptions) => Promise<Collection<string, Message>> };
  };
  channel.name = 'banana-combo';
  channel.messages.fetch = async (opts: FetchMessagesOptions) => {
    fetchCalls.push(opts);
    const before = opts.before ? BigInt(opts.before) : undefined;
    const page = all.filter((m) => before === undefined || BigInt(m.id) < before).slice(0, opts.limit ?? 50);
    return new Collection(page.map((m) => [m.id, m]));
  };
  return { trigger, fetchCalls };
}

function okClient(summary = 'Jason and Simon argued about pizza.') {
  return createCapturingClient([{ body: chatCompletionBody(summary) }]);
}

function userPrompt(request: CapturedRequest): string {
  const messages = request.body.messages as { role: string; content: string }[];
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

const now = () => NOW;

describe('summarizeChannel', () => {
  it('calls OpenRouter with the chat model, ZDR routing and the summary feature tag', async () => {
    const { trigger } = channelWith([said(30, 'jason', 'pineapple pizza is elite'), said(20, 'simon', 'no')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe('deepseek/deepseek-v3.2:nitro');
    expect(requests[0].body.provider).toEqual({ zdr: true });
    expect(requests[0].headers.get(FEATURE_HEADER)).toBe('summary');
    expect(result).toContain('Jason and Simon argued about pizza.');
    expect(result).toMatch(/^Summary of #banana-combo from 2026-01-15 11:00 to 2026-01-15 12:00 Eastern \(2 messages from 2 people\):/);
  });

  it('renders Eastern timestamps, leaves out the request itself and anything outside the range', async () => {
    const { trigger } = channelWith([
      said(120, 'jason', 'too early to count'),
      said(45, 'jason', 'who is up for wings tonight'),
      said(40, 'simon', 'me'),
    ]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('[2026-01-15 11:15] Jason: who is up for wings tonight');
    expect(prompt).toContain('[2026-01-15 11:20] Simon: me');
    expect(prompt).not.toContain('too early to count');
    expect(prompt).not.toContain('catch me up');
  });

  it('attributes relayed messages to their real author, keeps the bot, and drops other bots', async () => {
    const relay = msgAt(30, { webhookId: 'wh-1', authorUsername: 'Jason', content: 'https://fxtwitter.com/x/status/1' });
    recordRelay({ messageId: relay.id, channelId: 'channel-1', authorId: 'u-jason', authorName: 'Jason', kind: 'link_fix' });
    const botReply = createFakeBotMessage({
      messageId: snowflake(new Date(NOW.getTime() - 25 * MIN)),
      createdAt: new Date(NOW.getTime() - 25 * MIN),
      content: 'that tweet is fake',
    }).message;
    const otherBot = msgAt(24, { authorId: 'music-bot', authorIsBot: true, authorDisplayName: 'Jockie', content: 'Now playing' });
    const foreignWebhook = msgAt(23, { webhookId: 'wh-2', applicationId: 'other-app', authorUsername: 'Jason', content: 'rss item' });
    const { trigger } = channelWith([relay, botReply, otherBot, foreignWebhook, said(20, 'simon', 'lol')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('Jason: https://fxtwitter.com/x/status/1');
    expect(prompt).toContain('Frigidaire (bot): that tweet is fake');
    expect(prompt).not.toContain('Now playing');
    expect(prompt).not.toContain('rss item');
    // The bot is not counted as one of the people talking.
    expect(result).toContain('(3 messages from 2 people)');
  });

  it('adds link-preview text, attachments, stickers, cached voice transcripts and reply context', async () => {
    const tweet = said(50, 'jason', 'https://fxtwitter.com/nasa/status/1', {
      embeds: [{ authorName: 'NASA (@NASA)', description: 'Artemis launch moved to Friday', url: 'https://x.com/nasa' }],
    });
    const voice = said(45, 'simon', '', { attachments: [{ url: 'https://cdn.example/voice.ogg', contentType: 'audio/ogg' }] });
    transcripts.set(voice.id, 'I am not driving to Laval again');
    const reply = said(40, 'felix', 'fair', { referencedMessageId: voice.id, stickers: [{ id: 's1', name: 'pepe', format: 1 }] });
    const photo = said(35, 'jason', '<:trolle:111> look <@222333444555666777>', {
      attachments: [{ url: 'https://cdn.example/a.png', contentType: 'image/png' }],
      mentionedUsers: [{ id: '222333444555666777', displayName: 'Simon' }],
    });
    const { trigger } = channelWith([tweet, voice, reply, photo]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain('[link: NASA (@NASA) — Artemis launch moved to Friday]');
    expect(prompt).toContain('Simon: [audio] [voice message transcript: I am not driving to Laval again]');
    expect(prompt).toContain('Felix (replying to Simon): fair [sticker: pepe]');
    expect(prompt).toContain('Jason: :trolle: look @Simon [image]');
  });

  it('names people by their current display name from the identities table', async () => {
    // Fetched history often has no member data: the author's global name is all the message carries.
    const { trigger } = channelWith([said(30, 'jason', 'hi', { memberIsNull: true, authorDisplayName: 'jay_global' })]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(userPrompt(requests[0])).toContain('] Jason: hi');
  });

  it("includes a who's-who block from identities and never injects memories", async () => {
    await store.save({ category: 'fact', subject: 'Jason', subject_user_id: 'u-jason', content: 'Secretly owns eleven cats' });
    const { trigger } = channelWith([said(30, 'jason', 'anyway')]);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    const prompt = userPrompt(requests[0]);
    expect(prompt).toContain("WHO'S WHO");
    expect(prompt).toContain('- Felix — real name Félix R; also called Fefe');
    expect(prompt).not.toContain('eleven cats');
    const system = (requests[0].body.messages as { role: string; content: string }[])[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Use only what is in the transcript');
  });

  it('names who asked', async () => {
    const { trigger } = channelWith([said(30, 'jason', 'anyway')]);
    const { client, requests } = okClient();

    await summarizeChannel({
      message: trigger,
      start: new Date(NOW.getTime() - HOUR),
      requesterId: 'u-felix',
      client,
      now,
    });

    expect(userPrompt(requests[0])).toContain('Requested by Felix.');
  });

  it('drops the OLDEST messages first when the range is over budget, and says so', async () => {
    const history: Message[] = [];
    for (let i = 0; i < 160; i++) {
      history.push(said(200 - i, i % 2 ? 'jason' : 'simon', `${i === 0 ? 'OLDEST' : i === 159 ? 'NEWEST' : 'msg'} ${'x'.repeat(1500)}`));
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
    for (let i = 0; i < 250; i++) history.push(said(250 - i, 'jason', `m${i}`));
    const { trigger, fetchCalls } = channelWith(history);
    const { client, requests } = okClient();

    await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - 120 * MIN), client, now });

    // 120 minutes of messages at one per minute: two pages cover them; the third page is never needed.
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toMatchObject({ limit: 100, before: trigger.id });
    expect(userPrompt(requests[0])).toContain('Range: 2026-01-15 10:00 to 2026-01-15 12:00 (Eastern), 120 messages.');
  });

  it('starts fetching at the end of the range when it ends before the request', async () => {
    const { trigger, fetchCalls } = channelWith([said(600, 'jason', 'last night stuff'), said(30, 'simon', 'today stuff')]);
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
    const { trigger } = channelWith([said(600, 'jason', 'old')]);
    const { client, requests } = okClient();

    const result = await summarizeChannel({ message: trigger, start: new Date(NOW.getTime() - HOUR), client, now });

    expect(result).toMatch(/no messages in #banana-combo between 2026-01-15 11:00 and 2026-01-15 12:00/);
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
    const { trigger } = channelWith([said(30, 'jason', 'anyway')]);
    const failing = createCapturingClient([{ status: 500, body: { error: { message: 'boom', code: 500 } } }]);
    const empty = createCapturingClient([{ body: chatCompletionBody('   ') }]);

    const start = new Date(NOW.getTime() - HOUR);
    expect(await summarizeChannel({ message: trigger, start, client: failing.client, now })).toMatch(/model call failed/);
    expect(await summarizeChannel({ message: trigger, start, client: empty.client, now })).toMatch(/returned nothing/);
  });
});

describe('runSummaryTool (summarize_messages arguments)', () => {
  it('reads start/end as Eastern wall-clock time', async () => {
    const { trigger } = channelWith([said(90, 'jason', 'in range'), said(200, 'jason', 'before range')]);
    const { client, requests } = okClient();

    // 10:00–11:45 EST = 15:00–16:45 UTC; NOW is 17:00 UTC.
    const result = await runSummaryTool(trigger, { start_time: '2026-01-15 10:00', end_time: '2026-01-15 11:45' }, { client, now });

    expect(result).toContain('from 2026-01-15 10:00 to 2026-01-15 11:45 Eastern');
    expect(userPrompt(requests[0])).toContain('in range');
    expect(userPrompt(requests[0])).not.toContain('before range');
  });

  it('still honors an explicit UTC offset', async () => {
    const { trigger } = channelWith([said(30, 'jason', 'anyway')]);
    const { client } = okClient();

    const result = await runSummaryTool(trigger, { start_time: '2026-01-15T16:00:00Z' }, { client, now });

    expect(result).toContain('from 2026-01-15 11:00 to 2026-01-15 12:00 Eastern');
  });

  it('defaults the end to now and clamps a future end', async () => {
    const { trigger } = channelWith([said(30, 'jason', 'anyway')]);
    const { client } = okClient();

    const result = await runSummaryTool(trigger, { start_time: '2026-01-15 11:00', end_time: '2026-01-16 11:00' }, { client, now });

    expect(result).toContain('to 2026-01-15 12:00 Eastern');
  });

  it('caps the range at 7 days and says so', async () => {
    const { trigger, fetchCalls } = channelWith([said(30, 'jason', 'anyway')]);
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
        said(200, 'felix', 'heading out'),
        said(150, 'jason', 'felix left lol'),
        said(100, 'simon', 'wings at 8'),
      ]);
      const { client, requests } = okClient();

      const result = await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('felix left lol');
      expect(prompt).toContain('wings at 8');
      expect(prompt).not.toContain('heading out');
      expect(prompt).toContain('Requested by Felix, who was last active here at 2026-01-15 08:40: this is what they missed.');
      expect(result).toContain('from 2026-01-15 08:40 to 2026-01-15 12:00 Eastern');
    });

    it('skips the messages of the current visit ("yo" right before "catch me up")', async () => {
      const { trigger } = channelWith([
        said(300, 'felix', 'gn'),
        said(200, 'jason', 'big news'),
        said(3, 'felix', 'yo'),
      ]);
      const { client, requests } = okClient();

      await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('big news');
      expect(prompt).not.toContain('] Felix: gn');
    });

    it("counts the asker's relayed messages as theirs", async () => {
      const relay = msgAt(60, { webhookId: 'wh-1', authorUsername: 'Felix', content: 'https://fxtwitter.com/y/status/2' });
      recordRelay({ messageId: relay.id, channelId: 'channel-1', authorId: 'u-felix', authorName: 'Felix', kind: 'link_fix' });
      const { trigger } = channelWith([said(300, 'felix', 'old'), relay, said(30, 'jason', 'after the link')]);
      const { client, requests } = okClient();

      await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      const prompt = userPrompt(requests[0]);
      expect(prompt).toContain('after the link');
      expect(prompt).not.toContain('fxtwitter');
    });

    it('reuses the messages it scanned instead of fetching them again', async () => {
      const { trigger, fetchCalls } = channelWith([said(200, 'felix', 'bye'), said(100, 'jason', 'hi')]);
      const { client } = okClient();

      await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      expect(fetchCalls).toHaveLength(1);
    });

    it('tells the model when there is no earlier message within 7 days', async () => {
      const { trigger } = channelWith([said(8 * 24 * 60, 'felix', 'ancient'), said(100, 'jason', 'hi')]);
      const { client, requests } = okClient();

      const result = await runSummaryTool(trigger, { since_my_last_message: true }, { client, now });

      expect(result).toMatch(/Felix has no earlier message in #banana-combo going back to 2026-01-08 12:00/);
      expect(result).toMatch(/start_time/);
      expect(requests).toHaveLength(0);
    });
  });
});

describe('prepareSummaryPrompt (legacy adapter)', () => {
  it('builds a prompt from the same pipeline for the old provider method', async () => {
    const { trigger } = channelWith([said(30, 'jason', 'legacy path works')]);
    const prepared = await prepareSummaryPrompt(trigger, '2026-01-15T16:00:00Z', '2026-01-15T17:00:00Z');
    expect(prepared.error).toBeUndefined();
    expect(prepared.prompt).toContain('legacy path works');
    expect((await prepareSummaryPrompt(trigger, 'nope', 'nope')).error).toMatch(/Invalid date/);
  });
});
