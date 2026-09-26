// What the chat model sees each turn (catch-up between pings, reply context, attribution, channel/time,
// person-keyed memories, the history budget) and how the turn ends (tool limits, reactions, errors,
// attachments). The older agent behaviors live in agent.test.ts.
import { ChannelType, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import { FakeEmbeddingProvider } from '../test-support/fakeEmbeddings';
import { FakeProvider, textResponse, toolCallResponse } from '../test-support/fakeProvider';
import {
  AgentOrchestrator,
  type AgentOrchestratorOptions,
  ERROR_REPLIES,
  answerDanglingToolCalls,
  compareSnowflakes,
  describeNowET,
  pickErrorReply,
} from './agent';
import type { ContentEnricher } from './enrichers';
import { TRIMMED_NOTE } from './historyBudget';
import { TRANSCRIPT_HEADER } from './media/autoTranscribe';
import { getMemoryStore, setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import type { ConversationEntry, ProviderChatResponse, ToolDefinition } from './types';

// Discord ids are numeric snowflakes; the fake channel log orders and filters by them like the API.
const CH = '555000000000000001';
const BOT_ID = '900000000000000001';
const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const CAROL = '100000000000000003';
const DAVE = '100000000000000004';
const WHEELIE = '100000000000000042';
const JASPER = '100000000000000005';
const OTHER_BOT = '800000000000000001';

type MessageEntry = Extract<ConversationEntry, { kind: 'message' }>;

// The reply-context entry's opening (the static prompt mentions "a REPLY CONTEXT block" too).
const REPLY_CONTEXT = 'REPLY CONTEXT — the current message replies to';

const BASE: FakeMessageOptions = {
  messageId: '99000',
  channelId: CH,
  botUserId: BOT_ID,
  authorId: ALICE,
  authorDisplayName: 'Alice',
};

/** A plain member message in the test channel. */
function chat(id: string, content: string, opts: FakeMessageOptions = {}): Message {
  return createFakeMessage({ ...BASE, messageId: id, content, ...opts }).message;
}

function makeAgent(provider: FakeProvider, opts: Partial<AgentOrchestratorOptions> = {}): AgentOrchestrator {
  return new AgentOrchestrator({
    resolveProvider: () => provider,
    tools: [],
    timeoutMs: 60_000,
    enrichers: [],
    contextLengths: { get: async () => undefined },
    channelNotes: () => ({ notes: {}, invalid: false }),
    ...opts,
  });
}

function textOf(entry: ConversationEntry | undefined): string {
  if (entry?.kind !== 'message') return '';
  return entry.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

function messageEntries(entries: ConversationEntry[]): MessageEntry[] {
  return entries.filter((e): e is MessageEntry => e.kind === 'message');
}

/** Index of the first message entry whose text contains `needle` (-1 when none). */
function indexOfText(entries: ConversationEntry[], needle: string): number {
  return entries.findIndex((e) => textOf(e).includes(needle));
}

function countText(entries: ConversationEntry[], needle: string): number {
  return entries.filter((e) => textOf(e).includes(needle)).length;
}

/** The per-turn dynamic context entry (the developer entry that starts with the current time). */
function dynamicEntryText(entries: ConversationEntry[]): string {
  return textOf(messageEntries(entries).find((e) => e.role === 'developer' && textOf(e).startsWith('Current time:')));
}

function jumpLink(messageId: string): string {
  return `https://discord.com/channels/guild-1/${CH}/${messageId}`;
}

beforeEach(() => {
  setMemoryStoreForTesting(new MemoryStore(':memory:'));
  setBotDbForTesting(new BotDb(':memory:'));
  vi.stubEnv('DEBUG_CAPTURE', '0');
  // Quiet: tests that assert on a log line read these spies' calls.
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('catching up between pings', () => {
  it('shows what was said since the last ping, attributed, without repeating its own reply', async () => {
    const provider = new FakeProvider([textResponse('first reply'), textResponse('second reply')]);
    const agent = makeAgent(provider);

    const seed = chat('1000', 'before the first ping', { authorId: BOB, authorDisplayName: 'Bob' });
    const ping1 = createFakeMessage({
      ...BASE,
      messageId: '1010',
      content: 'yo fridge',
      channelMessages: [seed],
      replyImpl: async () => ({ id: '1011' }),
    });
    await agent.handleMention(ping1.message);

    const ownReply = createFakeBotMessage({ messageId: '1011', content: 'first reply', channelId: CH, botUserId: BOT_ID });
    const bobTalk = chat('1012', 'anyone up for league tonight', { authorId: BOB, authorDisplayName: 'Bob' });
    const otherBot = chat('1013', 'GG you leveled up!', {
      authorId: OTHER_BOT,
      authorDisplayName: 'MEE6',
      authorIsBot: true,
    });
    const relay = chat('1014', 'https://fixvx.com/someone/status/1', {
      webhookId: 'hook-1',
      authorId: 'hook-1',
      authorUsername: 'Carol',
      authorDisplayName: 'Carol',
    });
    recordRelay({ messageId: '1014', channelId: CH, authorId: CAROL, authorName: 'Carol', kind: 'link_fix' });
    const log = [seed, ping1.message, ownReply.message, bobTalk, otherBot, relay];
    const ping2 = createFakeMessage({ ...BASE, messageId: '1020', content: 'thoughts?', channelMessages: log });

    await agent.handleMention(ping2.message);

    const second = provider.calls[1].messages;
    expect(second[0]).toEqual(provider.calls[0].messages[0]);
    // Its own reply appears once (from the state), not again from the channel.
    expect(messageEntries(second).filter((e) => e.role === 'assistant' && textOf(e) === 'first reply')).toHaveLength(1);
    // Members' messages, including the link-fix relay as its real author; other bots are skipped.
    const bob = indexOfText(second, `Bob (id:${BOB}): anyone up for league tonight`);
    const carol = indexOfText(second, `Carol (id:${CAROL}): https://fixvx.com/someone/status/1`);
    expect(bob).toBeGreaterThan(0);
    expect(carol).toBeGreaterThan(bob);
    expect(countText(second, 'leveled up')).toBe(0);
    // History comes before this turn's dynamic context, which comes right before the ping itself.
    // (Each turn's dynamic entry stays in the window; this turn's is the last one.)
    const dynamic = second.findLastIndex((e) => textOf(e).startsWith('Current time:'));
    expect(dynamic).toBeGreaterThan(carol);
    expect(textOf(second.at(-1))).toContain('thoughts?');
    expect(dynamic).toBe(second.length - 2);
    // The first-window seed was not fetched again.
    expect(ping2.recorders.messagesFetch.calls).toEqual([[{ limit: 100, before: '1020' }]]);
  });

  it('does not repeat a ping that link fixing reposted: the relay of a message already in the window is skipped', async () => {
    const provider = new FakeProvider([textResponse('clean'), textResponse('two')]);
    const agent = makeAgent(provider);
    // Alice pings with a tweet; the turn sees it, then link fixing deletes it and reposts it as a relay.
    const ping1 = createFakeMessage({
      ...BASE,
      messageId: '8000',
      content: 'fridge look https://x.com/someone/status/42',
      channelMessages: [],
    });
    await agent.handleMention(ping1.message);

    const relayOfPing = chat('8001', 'fridge look https://fixvx.com/someone/status/42', {
      webhookId: 'hook-1',
      authorId: 'hook-1',
      authorUsername: 'Alice',
      authorDisplayName: 'Alice',
    });
    recordRelay({
      messageId: '8001',
      originalId: '8000',
      channelId: CH,
      authorId: ALICE,
      authorName: 'Alice',
      kind: 'link_fix',
    });
    // A relay of a message the window never saw is still shown.
    const otherRelay = chat('8002', 'https://fixvx.com/other/status/7', {
      webhookId: 'hook-2',
      authorId: 'hook-2',
      authorUsername: 'Carol',
      authorDisplayName: 'Carol',
    });
    recordRelay({
      messageId: '8002',
      originalId: '7999',
      channelId: CH,
      authorId: CAROL,
      authorName: 'Carol',
      kind: 'link_fix',
    });
    const ping2 = createFakeMessage({
      ...BASE,
      messageId: '8003',
      authorId: BOB,
      authorDisplayName: 'Bob',
      content: 'fridge thoughts?',
      channelMessages: [relayOfPing, otherRelay],
    });
    await agent.handleMention(ping2.message);

    const second = provider.calls[1].messages;
    expect(countText(second, 'someone/status/42')).toBe(1);
    expect(countText(second, 'other/status/7')).toBe(1);
  });

  it('does not bring back a pinged message as new when the link fix reposted it while it was being answered', async () => {
    const provider = new FakeProvider([textResponse('looks fake'), textResponse('sure'), textResponse('ok')]);
    const agent = makeAgent(provider);
    const question = 'fridge what do you make of this https://x.com/u/status/1';
    const ping1 = createFakeMessage({
      ...BASE,
      messageId: '1010',
      content: question,
      channelMessages: [],
      replyImpl: async () => ({ id: '1012' }),
    });
    await agent.handleMention(ping1.message);

    // Meanwhile the link fix reposted the question (as Alice) and deleted the original.
    const relay = chat('1011', 'fridge what do you make of this https://fixvx.com/u/status/1', {
      webhookId: 'hook-1',
      authorId: 'hook-1',
      authorUsername: 'Alice',
      authorDisplayName: 'Alice',
    });
    recordRelay({ messageId: '1011', channelId: CH, authorId: ALICE, authorName: 'Alice', kind: 'link_fix', originalId: '1010' });
    const ownReply = createFakeBotMessage({ messageId: '1012', content: 'looks fake', channelId: CH, botUserId: BOT_ID });
    const bobTalk = chat('1013', 'it is real', { authorId: BOB, authorDisplayName: 'Bob' });
    const log = [relay, ownReply.message, bobTalk];

    const ping2 = createFakeMessage({ ...BASE, messageId: '1020', content: 'you sure?', channelMessages: log });
    await agent.handleMention(ping2.message);

    const second = provider.calls[1].messages;
    expect(countText(second, 'what do you make of this')).toBe(1);
    expect(indexOfText(second, question)).toBeGreaterThan(0);
    expect(indexOfText(second, `Bob (id:${BOB}): it is real`)).toBeGreaterThan(indexOfText(second, question));

    // Replying to the relay is replying to a message already in the window: no reply-context block.
    const ping3 = createFakeMessage({
      ...BASE,
      messageId: '1030',
      content: 'this one',
      referencedMessageId: '1011',
      channelMessages: [...log, ping2.message],
    });
    await agent.handleMention(ping3.message);

    const third = provider.calls[2].messages;
    expect(indexOfText(third, REPLY_CONTEXT)).toBe(-1);
    expect(countText(third, 'what do you make of this')).toBe(1);
    expect(textOf(third.at(-1))).toContain(`(replying to Alice — ${jumpLink('1011')}): this one`);
  });

  it("drops its own auto-transcript replies from seeded history and from the catch-up", async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);
    const transcript = (id: string, said: string) =>
      createFakeBotMessage({ messageId: id, content: `${TRANSCRIPT_HEADER}\n> ${said}`, channelId: CH, botUserId: BOT_ID })
        .message;

    const seeded = [chat('7000', 'earlier chatter'), transcript('7001', 'seeded voice words')];
    const ping1 = createFakeMessage({ ...BASE, messageId: '7002', content: 'fridge?', channelMessages: seeded });
    await agent.handleMention(ping1.message);
    expect(countText(provider.calls[0].messages, 'seeded voice words')).toBe(0);
    expect(countText(provider.calls[0].messages, 'earlier chatter')).toBe(1);

    const log = [...seeded, ping1.message, chat('7003', 'more chatter'), transcript('7004', 'caught-up voice words')];
    const ping2 = createFakeMessage({ ...BASE, messageId: '7005', content: 'and now?', channelMessages: log });
    await agent.handleMention(ping2.message);
    expect(countText(provider.calls[1].messages, 'caught-up voice words')).toBe(0);
    expect(countText(provider.calls[1].messages, 'more chatter')).toBe(1);
  });

  it('keeps only the newest 100 messages and says how many earlier ones were skipped', async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);
    const ping1 = createFakeMessage({ ...BASE, messageId: '2000', content: 'first', channelMessages: [] });
    await agent.handleMention(ping1.message);

    const between = Array.from({ length: 130 }, (_, i) =>
      chat(String(2001 + i), `chatter number ${i + 1}`, { authorId: BOB, authorDisplayName: 'Bob' }),
    );
    const ping2 = createFakeMessage({
      ...BASE,
      messageId: '2200',
      content: 'what did I miss',
      channelMessages: [ping1.message, ...between],
    });
    await agent.handleMention(ping2.message);

    const second = provider.calls[1].messages;
    expect(countText(second, 'chatter number')).toBe(100);
    expect(indexOfText(second, 'chatter number 30:')).toBe(-1);
    expect(indexOfText(second, 'chatter number 31')).toBeGreaterThan(0);
    const note = indexOfText(second, '[30 earlier channel messages since your last reply were skipped');
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(indexOfText(second, 'chatter number 31'));
  });

  it('moves the watermark to the current ping, so the next turn does not repeat the catch-up', async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two'), textResponse('three')]);
    const agent = makeAgent(provider);
    const ping1 = createFakeMessage({ ...BASE, messageId: '3000', content: 'first', channelMessages: [] });
    const talk = chat('3001', 'something happened', { authorId: BOB, authorDisplayName: 'Bob' });
    const ping2 = createFakeMessage({ ...BASE, messageId: '3002', content: 'second', channelMessages: [ping1.message, talk] });
    const ping3 = createFakeMessage({
      ...BASE,
      messageId: '3003',
      content: 'third',
      channelMessages: [ping1.message, talk, ping2.message],
    });

    await agent.handleMention(ping1.message);
    await agent.handleMention(ping2.message);
    await agent.handleMention(ping3.message);

    expect(countText(provider.calls[1].messages, 'something happened')).toBe(1);
    expect(countText(provider.calls[2].messages, 'something happened')).toBe(1);
    // The previous ping is already in the window as a user entry; it isn't re-rendered either.
    expect(countText(provider.calls[2].messages, ': second')).toBe(1);
  });

  it('answers anyway when the catch-up fetch fails', async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);
    const ping1 = createFakeMessage({ ...BASE, messageId: '4000', content: 'first', channelMessages: [] });
    await agent.handleMention(ping1.message);

    const ping2 = createFakeMessage({ ...BASE, messageId: '4001', content: 'second' });
    (ping2.message.channel.messages as unknown as { fetch: () => Promise<never> }).fetch = async () => {
      throw new Error('Missing Access');
    };
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await agent.handleMention(ping2.message);

    expect(ping2.recorders.reply.calls).toEqual([['two']]);
  });
});

describe('reply context', () => {
  // An old thread (990 ← 1000) with neighbours, buried under 30 newer messages so it is outside the
  // 25-message seed of a new window.
  function oldThreadLog(referencedContent = 'nah you are wrong'): Message[] {
    const fillers = Array.from({ length: 30 }, (_, i) =>
      chat(String(4000 + i), `filler ${i}`, { authorId: BOB, authorDisplayName: 'Bob' }),
    );
    return [
      chat('990', 'hot take: pineapple on pizza is elite', { authorId: BOB, authorDisplayName: 'Bob' }),
      chat('995', 'before zero', { authorId: CAROL, authorDisplayName: 'Carol' }),
      chat('996', 'before one', { authorId: CAROL, authorDisplayName: 'Carol' }),
      chat('997', 'before two', { authorId: CAROL, authorDisplayName: 'Carol' }),
      chat('998', 'before three', { authorId: CAROL, authorDisplayName: 'Carol' }),
      chat('1000', referencedContent, {
        referencedMessageId: '990',
        attachments: [
          { url: 'https://cdn.discordapp.com/attachments/1/2/proof.png', contentType: 'image/png', name: 'proof.png' },
        ],
      }),
      chat('1001', 'after one', { authorId: CAROL, authorDisplayName: 'Carol' }),
      chat('1002', 'after two', { authorId: CAROL, authorDisplayName: 'Carol' }),
      chat('1003', 'after three', { authorId: CAROL, authorDisplayName: 'Carol' }),
      ...fillers,
    ];
  }

  it('shows the replied-to message, its chain and its neighbours right before the ping, with jump links', async () => {
    const roles: string[] = [];
    const enricher: ContentEnricher = {
      name: 'spy',
      enrich: async (msg, role) => {
        roles.push(`${msg.id}:${role}`);
        return msg.id === '1000' ? [{ type: 'text', text: '[enriched 1000]' }] : [];
      },
    };
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider, { enrichers: [enricher] });
    const ping = createFakeMessage({
      ...BASE,
      messageId: '5000',
      authorId: DAVE,
      authorDisplayName: 'Dave',
      content: 'is this still true?',
      referencedMessageId: '1000',
      channelMessages: oldThreadLog(),
    });

    await agent.handleMention(ping.message);

    const messages = provider.calls[0].messages;
    const current = textOf(messages.at(-1));
    expect(current).toContain(`Dave (id:${DAVE}) (replying to Alice — ${jumpLink('1000')}): is this still true?`);

    const context = messages.at(-2);
    expect(context?.kind === 'message' && context.role).toBe('user');
    const text = textOf(context);
    expect(text).toContain(REPLY_CONTEXT);
    const root = text.indexOf(`Bob: hot take: pineapple on pizza is elite (${jumpLink('990')})`);
    const referenced = text.indexOf('↳ [');
    expect(root).toBeGreaterThan(0);
    expect(referenced).toBeGreaterThan(root);
    expect(text).toContain(
      `Alice: nah you are wrong [image: proof.png https://cdn.discordapp.com/attachments/1/2/proof.png] (${jumpLink('1000')})  ← the message being replied to`,
    );
    for (const shown of ['before one', 'before two', 'before three', 'after one', 'after two']) {
      expect(text).toContain(shown);
    }
    expect(text).not.toContain('before zero');
    expect(text).not.toContain('after three');
    // The replied-to message's image and enrichment (paid work allowed for the 'reference' role).
    expect(context?.kind === 'message' && context.content).toContainEqual({
      type: 'image',
      url: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
    });
    expect(text).toContain('[enriched 1000]');
    expect(roles).toContain('1000:reference');
    // The dynamic context still comes before the reply context.
    expect(textOf(messages.at(-3))).toMatch(/^Current time:/);
  });

  it('only names the replied-to message when it is already in the window', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({
      ...BASE,
      messageId: '5000',
      content: 'lmao',
      referencedMessageId: '4020',
      channelMessages: oldThreadLog(),
    });

    await agent.handleMention(ping.message);

    const messages = provider.calls[0].messages;
    expect(indexOfText(messages, REPLY_CONTEXT)).toBe(-1);
    expect(textOf(messages.at(-1))).toContain(`(replying to Bob — ${jumpLink('4020')}): lmao`);
    expect(textOf(messages.at(-2))).toMatch(/^Current time:/);
  });

  it('runs the paid reference enrichers on an in-window replied-to message and adds only what is new', async () => {
    // History rendering is cache-only; replying to a message is what makes its paid enrichment worth it.
    const enricher = (cachedInHistory: boolean): ContentEnricher => ({
      name: 'voice',
      enrich: async (msg, role) => {
        if (msg.id !== '4020') return [];
        if (role === 'reference' || cachedInHistory) return [{ type: 'text', text: '[voice transcript: meet at 8]' }];
        return [];
      },
    });
    const ping = (log: Message[]) =>
      createFakeMessage({
        ...BASE,
        messageId: '5000',
        content: 'what did he say',
        referencedMessageId: '4020',
        channelMessages: log,
      });

    const fresh = new FakeProvider([textResponse('ok')]);
    await makeAgent(fresh, { enrichers: [enricher(false)] }).handleMention(ping(oldThreadLog()).message);
    const extra = fresh.calls[0].messages.at(-2);
    expect(textOf(extra)).toContain(`REPLY CONTEXT — more on the message being replied to (Bob, ${jumpLink('4020')})`);
    expect(textOf(extra)).toContain('[voice transcript: meet at 8]');

    const cached = new FakeProvider([textResponse('ok')]);
    await makeAgent(cached, { enrichers: [enricher(true)] }).handleMention(ping(oldThreadLog()).message);
    expect(countText(cached.calls[0].messages, '[voice transcript: meet at 8]')).toBe(1);
    expect(indexOfText(cached.calls[0].messages, 'REPLY CONTEXT — more on')).toBe(-1);
  });

  describe('a reply to its own auto-transcript', () => {
    const VOICE_ID = '1000';
    const TRANSCRIPT_ID = '1001';
    const SAID = 'I never lost a single game';
    const voice = () =>
      chat(VOICE_ID, '', {
        authorId: BOB,
        authorDisplayName: 'Bob',
        attachments: [
          {
            url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg',
            contentType: 'audio/ogg',
            name: 'voice-message.ogg',
          },
        ],
      });
    // discord.js caches the messages it fetched (here: the voice message, for the transcript's label).
    const transcriptReply = (cachedMessages: Message[] = []) =>
      createFakeBotMessage({
        messageId: TRANSCRIPT_ID,
        content: `${TRANSCRIPT_HEADER}\n> ${SAID}`,
        channelId: CH,
        botUserId: BOT_ID,
        referencedMessageId: VOICE_ID,
        cachedMessages,
      }).message;
    const spy = (roles: string[]): ContentEnricher => ({
      name: 'voice',
      enrich: async (msg, role) => {
        roles.push(`${msg.id}:${role}`);
        return msg.id === VOICE_ID ? [{ type: 'text', text: `[voice message from Bob: ${SAID}]` }] : [];
      },
    });
    const ping = (log: Message[]) =>
      createFakeMessage({
        ...BASE,
        messageId: '5000',
        authorId: DAVE,
        authorDisplayName: 'Dave',
        content: 'is that true?',
        referencedMessageId: TRANSCRIPT_ID,
        channelMessages: log,
      });
    const fillers = () =>
      Array.from({ length: 30 }, (_, i) => chat(String(4000 + i), `filler ${i}`, { authorId: CAROL, authorDisplayName: 'Carol' }));

    it('is about the voice message: its author, its transcript, never "(you)"', async () => {
      const roles: string[] = [];
      const provider = new FakeProvider([textResponse('ok')]);
      const agent = makeAgent(provider, { enrichers: [spy(roles)] });

      await agent.handleMention(ping([voice(), transcriptReply([voice()]), ...fillers()]).message);

      const messages = provider.calls[0].messages;
      expect(textOf(messages.at(-1))).toContain(`(replying to Bob's voice message — ${jumpLink(VOICE_ID)}): is that true?`);
      const context = textOf(messages.at(-2));
      expect(context).toContain(REPLY_CONTEXT);
      expect(context).toContain(
        `Bob: [attachment: voice-message.ogg https://cdn.discordapp.com/attachments/1/2/voice-message.ogg] (${jumpLink(VOICE_ID)})  ← the message being replied to`,
      );
      expect(context).toContain(`transcript of Bob's voice message: ${TRANSCRIPT_HEADER}`);
      expect(context).toContain(`[voice message from Bob: ${SAID}]`);
      expect(roles).toContain(`${VOICE_ID}:reference`);
      for (const entry of messages) expect(textOf(entry)).not.toContain('Frigidaire (you)');
    });

    it('names the voice message when it is already in the window, and adds its transcript only once', async () => {
      const roles: string[] = [];
      const provider = new FakeProvider([textResponse('ok')]);
      const agent = makeAgent(provider, { enrichers: [spy(roles)] });

      await agent.handleMention(ping([voice(), transcriptReply()]).message);

      const messages = provider.calls[0].messages;
      expect(textOf(messages.at(-1))).toContain(`(replying to Bob's voice message — ${jumpLink(VOICE_ID)}): is that true?`);
      expect(countText(messages, SAID)).toBe(1);
      for (const entry of messages) expect(textOf(entry)).not.toContain('Frigidaire (you)');
    });

    it('labels a transcript that has to stand on its own as the voice message\'s transcript', async () => {
      // The voice message is gone (deleted, or unreadable): the transcript is still not the bot talking.
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const provider = new FakeProvider([textResponse('ok')]);
      const agent = makeAgent(provider);

      await agent.handleMention(ping([transcriptReply(), ...fillers()]).message);

      const messages = provider.calls[0].messages;
      expect(textOf(messages.at(-1))).toContain(`(replying to a voice message's transcript — ${jumpLink(TRANSCRIPT_ID)})`);
      expect(textOf(messages.at(-2))).toContain(`transcript of a voice message: ${TRANSCRIPT_HEADER}`);
      for (const entry of messages) expect(textOf(entry)).not.toContain('Frigidaire (you)');
    });
  });

  it('degrades to a note when the replied-to message cannot be fetched', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({
      ...BASE,
      messageId: '5000',
      content: 'this',
      referencedMessageId: '777',
      channelMessages: [],
    });

    await agent.handleMention(ping.message);

    expect(textOf(provider.calls[0].messages.at(-1))).toContain('(replying to a message that could not be loaded)');
    expect(ping.recorders.reply.calls).toEqual([['ok']]);
  });

  it('ignores forwards (only replies carry reply context)', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({
      ...BASE,
      messageId: '5000',
      content: 'look',
      referencedMessageId: '1000',
      referencedMessageType: 1,
      channelMessages: oldThreadLog(),
    });

    await agent.handleMention(ping.message);

    expect(textOf(provider.calls[0].messages.at(-1))).not.toContain('replying to');
    expect(indexOfText(provider.calls[0].messages, REPLY_CONTEXT)).toBe(-1);
  });

  it('bounds the size of the reply context', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({
      ...BASE,
      messageId: '5000',
      content: 'tl;dr?',
      referencedMessageId: '1000',
      channelMessages: oldThreadLog('wall of text '.repeat(2000)),
    });

    await agent.handleMention(ping.message);

    const text = textOf(provider.calls[0].messages.at(-2));
    expect(text).toContain(REPLY_CONTEXT);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('← the message being replied to');
  });
});

describe('uploaded files', () => {
  const CSV_URL = 'https://cdn.discordapp.com/attachments/1/2/data.csv?ex=abc&is=def&hm=123&';
  const PNG_URL = 'https://cdn.discordapp.com/attachments/1/3/photo.png?ex=abc&is=def&hm=456&';
  const CHART_URL = 'https://cdn.discordapp.com/attachments/1/4/chart.png?ex=abc&is=def&hm=789&';
  const csv = { url: CSV_URL, contentType: 'text/csv', name: 'data.csv', size: 12_345 };
  const png = { url: PNG_URL, contentType: 'image/png', name: 'photo.png', size: 400_000 };
  const CSV_LINE = `[attachment: data.csv (12 KB) ${CSV_URL}]`;
  const PNG_LINE = `[image: photo.png ${PNG_URL}]`;

  it('names every file on the current message with its size and download link; images still go as images', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);

    await agent.handleMention(
      createFakeMessage({ ...BASE, content: 'crunch this', attachments: [csv, png] }).message,
    );

    const current = provider.calls[0].messages.at(-1);
    expect(textOf(current)).toContain(`Alice (id:${ALICE}): crunch this ${CSV_LINE} ${PNG_LINE}`);
    expect(current?.kind === 'message' && current.content).toContainEqual({ type: 'image', url: PNG_URL });
  });

  it('shows a file-only message as its files', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);

    await agent.handleMention(createFakeMessage({ ...BASE, content: '', attachments: [csv] }).message);

    expect(textOf(provider.calls[0].messages.at(-1))).toMatch(new RegExp(`Alice \\(id:${ALICE}\\): \\[attachment: data\\.csv`));
  });

  it('links files in seeded history, in the catch-up and on its own earlier replies', async () => {
    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const agent = makeAgent(provider);
    const seeded = [
      chat('7000', 'here is the export', { authorId: BOB, authorDisplayName: 'Bob', attachments: [csv] }),
      createFakeBotMessage({
        messageId: '7001',
        content: 'made you a chart',
        channelId: CH,
        botUserId: BOT_ID,
        attachments: [{ url: CHART_URL, contentType: 'image/png', name: 'chart.png', size: 20_000 }],
      }).message,
    ];
    const first = createFakeMessage({ ...BASE, messageId: '7002', content: 'thoughts?', channelMessages: seeded });
    await agent.handleMention(first.message);

    const history = provider.calls[0].messages;
    expect(indexOfText(history, `Bob (id:${BOB}): here is the export ${CSV_LINE}`)).toBeGreaterThan(0);
    expect(
      messageEntries(history).some(
        (e) => e.role === 'assistant' && textOf(e) === `made you a chart\n[image: chart.png ${CHART_URL}]`,
      ),
    ).toBe(true);

    const later = [
      ...seeded,
      first.message,
      chat('7003', 'and the photo', { authorId: CAROL, authorDisplayName: 'Carol', attachments: [png] }),
    ];
    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '7004', content: 'now?', channelMessages: later }).message,
    );

    expect(indexOfText(provider.calls[1].messages, `Carol (id:${CAROL}): and the photo ${PNG_LINE}`)).toBeGreaterThan(0);
  });

  it('keeps a reply-context link whole when the message text around it is cut', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const fillers = Array.from({ length: 30 }, (_, i) =>
      chat(String(4000 + i), `filler ${i}`, { authorId: CAROL, authorDisplayName: 'Carol' }),
    );
    const log = [chat('1000', 'long story '.repeat(300), { authorId: BOB, authorDisplayName: 'Bob', attachments: [csv] }), ...fillers];

    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '5000', content: 'run it', referencedMessageId: '1000', channelMessages: log })
        .message,
    );

    const context = textOf(provider.calls[0].messages.at(-2));
    expect(context).toContain(REPLY_CONTEXT);
    expect(context).toContain(`… ${CSV_LINE} (${jumpLink('1000')})  ← the message being replied to`);
  });
});

describe('attribution in rendered history', () => {
  it('labels relays as their real author, keeps its own messages as assistant turns and skips other bots', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    recordRelay({ messageId: '6001', channelId: CH, authorId: CAROL, authorName: 'Carol', kind: 'link_fix' });
    const log = [
      chat('6000', 'hello', { authorId: BOB, authorDisplayName: 'Bob' }),
      chat('6001', 'https://kkinstagram.com/reel/abc/', {
        webhookId: 'hook-1',
        authorId: 'hook-1',
        authorUsername: 'Carol',
        authorDisplayName: 'Carol',
      }),
      chat('6002', 'I am a different bot', { authorId: OTHER_BOT, authorDisplayName: 'MEE6', authorIsBot: true }),
      createFakeBotMessage({ messageId: '6003', content: 'an earlier reply of mine', channelId: CH, botUserId: BOT_ID })
        .message,
      chat('6004', 'github: 3 new commits', {
        webhookId: 'hook-2',
        authorId: 'hook-2',
        authorUsername: 'GitHub',
        applicationId: '700000000000000001',
      }),
    ];
    const ping = createFakeMessage({ ...BASE, messageId: '6010', content: 'sup', channelMessages: log });

    await agent.handleMention(ping.message);

    const messages = provider.calls[0].messages;
    expect(indexOfText(messages, `Bob (id:${BOB}): hello`)).toBeGreaterThan(0);
    expect(indexOfText(messages, `Carol (id:${CAROL}): https://kkinstagram.com/reel/abc/`)).toBeGreaterThan(0);
    expect(messageEntries(messages).some((e) => e.role === 'assistant' && textOf(e) === 'an earlier reply of mine')).toBe(
      true,
    );
    expect(indexOfText(messages, 'different bot')).toBe(-1);
    expect(indexOfText(messages, '3 new commits')).toBe(-1);
  });
});

describe('channel awareness and the current time', () => {
  it('puts the current time and the channel (topic + note) in the per-turn context, not the static prompt', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider, {
      channelNotes: () => ({ notes: { [CH]: 'the main hangout where basically everything happens' }, invalid: false }),
    });
    const ping = createFakeMessage({
      ...BASE,
      messageId: '7000',
      content: 'hi',
      channelName: 'bagel-bar',
      channelTopic: 'no   thoughts,\nonly vibes',
      channelMessages: [],
    });

    await agent.handleMention(ping.message);

    const messages = provider.calls[0].messages;
    const dynamic = dynamicEntryText(messages);
    expect(dynamic).toMatch(/^Current time: [A-Z][a-z]+day \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} E[SD]T \(America\/New_York\)\./);
    expect(dynamic).toContain('Channel: #bagel-bar — no thoughts, only vibes');
    expect(dynamic).toContain('About this channel: the main hangout where basically everything happens');
    const staticPrompt = textOf(messages[0]);
    expect(staticPrompt).not.toMatch(/current time is/i);
    expect(staticPrompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("gives a thread its parent channel's note", async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider, { channelNotes: () => ({ notes: { '42': 'mostly League clips' }, invalid: false }) });
    const ping = createFakeMessage({
      ...BASE,
      messageId: '7000',
      content: 'hi',
      channelType: ChannelType.PublicThread,
      channelName: 'that pentakill',
      parentChannelId: '42',
      parentChannelName: 'clips',
      channelMessages: [],
    });

    await agent.handleMention(ping.message);

    const dynamic = dynamicEntryText(provider.calls[0].messages);
    expect(dynamic).toContain('Channel: thread "that pentakill" in #clips');
    expect(dynamic).toContain('About this channel: mostly League clips');
  });

  it('warns once about an invalid CHANNEL_NOTES and carries on without notes', async () => {
    vi.stubEnv('CHANNEL_NOTES', '{not json');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider, { channelNotes: undefined });
    const ping1 = createFakeMessage({ ...BASE, messageId: '7000', content: 'a', channelMessages: [] });
    const ping2 = createFakeMessage({ ...BASE, messageId: '7001', content: 'b', channelMessages: [] });

    await agent.handleMention(ping1.message);
    await agent.handleMention(ping2.message);

    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('CHANNEL_NOTES'))).toHaveLength(1);
    expect(dynamicEntryText(provider.calls[1].messages)).not.toContain('About this channel');
    expect(ping2.recorders.reply.calls).toEqual([['two']]);
  });
});

describe('memories by person', () => {
  it("finds the speaker's memories by their stable id after a nickname change", async () => {
    await getMemoryStore().save({ category: 'fact', subject: 'OldNick', content: 'mains jungle', subject_user_id: ALICE });
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({ ...BASE, authorDisplayName: 'NewNick', content: 'yo', channelMessages: [] });

    await agent.handleMention(ping.message);

    const dynamic = dynamicEntryText(provider.calls[0].messages);
    expect(dynamic).toContain('What you know about the person talking to you right now (NewNick)');
    expect(dynamic).toContain('- mains jungle');
  });

  it("finds the speaker's memories filed under an alias", async () => {
    const store = getMemoryStore();
    store.upsertIdentity(ALICE, 'Alice');
    store.updateIdentityMeta(ALICE, { aliases_add: ['Al'] });
    await store.save({ category: 'fact', subject: 'Al', content: 'hates cilantro' });
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({ ...BASE, content: 'yo', channelMessages: [] });

    await agent.handleMention(ping.message);

    expect(dynamicEntryText(provider.calls[0].messages)).toContain('- hates cilantro');
  });

  it("shows an @-mentioned person's memories under their current display name", async () => {
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
    store.upsertIdentity(WHEELIE, 'OldWheels');
    store.upsertIdentity(WHEELIE, 'Wheelie');
    await store.save({ category: 'fact', subject: 'OldWheels', content: 'plays valorant nightly', subject_user_id: WHEELIE });
    setMemoryStoreForTesting(store);
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({
      ...BASE,
      content: `whats up with <@${WHEELIE}>`,
      mentionedUsers: [{ id: WHEELIE, displayName: 'Wheelie' }],
      channelMessages: [],
    });

    await agent.handleMention(ping.message);

    expect(dynamicEntryText(provider.calls[0].messages)).toContain('- Wheelie: plays valorant nightly');
  });

  it('pulls memories for people named in plain text, never the speaker or the bot', async () => {
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
    store.upsertIdentity(JASPER, 'Jasper');
    store.upsertIdentity(ALICE, 'Alice');
    store.upsertIdentity(BOT_ID, 'Frigidaire');
    await store.save({ category: 'fact', subject: 'Jasper', content: 'owes everyone money', subject_user_id: JASPER });
    await store.save({ category: 'fact', subject: 'Frigidaire', content: 'is a fridge', subject_user_id: BOT_ID });
    setMemoryStoreForTesting(store);
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({
      ...BASE,
      content: 'frigidaire did jasper ever pay you back',
      botDisplayName: 'Frigidaire',
      channelMessages: [],
    });

    await agent.handleMention(ping.message);

    const dynamic = dynamicEntryText(provider.calls[0].messages);
    expect(dynamic).toContain('What you know about others mentioned in this message:');
    expect(dynamic).toContain('- Jasper: owes everyone money');
    expect(dynamic).not.toContain('is a fridge');
  });

  it('pulls memories for people named by Discord handle or IRL first name', async () => {
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
    store.upsertIdentity(JASPER, 'Jasper', 'lapinlune');
    store.upsertIdentity(CAROL, 'xX_Car_Xx');
    store.updateIdentityMeta(CAROL, { irl_name: 'Caroline Smith' });
    await store.save({ category: 'fact', subject: 'Jasper', content: 'owes everyone money', subject_user_id: JASPER });
    await store.save({ category: 'fact', subject: 'xX_Car_Xx', content: 'drives a forklift', subject_user_id: CAROL });
    setMemoryStoreForTesting(store);
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({ ...BASE, content: 'did lapinlune and caroline ever meet', channelMessages: [] });

    await agent.handleMention(ping.message);

    const dynamic = dynamicEntryText(provider.calls[0].messages);
    expect(dynamic).toContain('- Jasper: owes everyone money');
    expect(dynamic).toContain('- xX_Car_Xx: drives a forklift');
  });

  it('tells the model to look someone up when nothing about them is in context', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    await agent.handleMention(createFakeMessage({ ...BASE, content: 'hi', channelMessages: [] }).message);

    expect(textOf(provider.calls[0].messages[0])).toContain('call recall_memories for them before answering');
  });
});

describe('linked side accounts (LINKED_ACCOUNTS)', () => {
  // DAVE posts from a side account that belongs to BOB.
  beforeEach(() => {
    vi.stubEnv('LINKED_ACCOUNTS', `${DAVE}:${BOB}`);
  });

  function linkedStore(): MemoryStore {
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
    store.upsertIdentity(BOB, 'Bob', 'bobby_b');
    store.upsertIdentity(DAVE, 'BobAlt', 'bob_alt');
    setMemoryStoreForTesting(store);
    return store;
  }

  it("gives a side account's speaker the main account's memories and id", async () => {
    const store = linkedStore();
    await store.save({ category: 'fact', subject: 'Bob', content: 'plays bass in a cover band', subject_user_id: BOB });
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);
    const ping = createFakeMessage({ ...BASE, authorId: DAVE, authorDisplayName: 'BobAlt', content: 'yo', channelMessages: [] });

    await agent.handleMention(ping.message);

    const messages = provider.calls[0].messages;
    expect(dynamicEntryText(messages)).toContain('- plays bass in a cover band');
    // The turn itself is attributed to the person (main id, main name), not to the side account.
    expect(indexOfText(messages, `Bob (id:${BOB}): yo`)).toBeGreaterThan(0);
  });

  it("pulls the main account's memories for a side account named or @-mentioned", async () => {
    const store = linkedStore();
    await store.save({ category: 'fact', subject: 'Bob', content: 'plays bass in a cover band', subject_user_id: BOB });
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);

    const named = createFakeMessage({ ...BASE, messageId: '99001', content: 'is bob_alt around', channelMessages: [] });
    await agent.handleMention(named.message);
    expect(dynamicEntryText(provider.calls[0].messages)).toContain('- Bob: plays bass in a cover band');

    setMemoryStoreForTesting(linkedStore());
    await getMemoryStore().save({ category: 'fact', subject: 'Bob', content: 'hates cilantro', subject_user_id: BOB });
    const mentioned = createFakeMessage({
      ...BASE,
      messageId: '99002',
      channelId: '555000000000000002',
      content: `what about <@${DAVE}>`,
      mentionedUsers: [{ id: DAVE, displayName: 'BobAlt' }],
      channelMessages: [],
    });
    await agent.handleMention(mentioned.message);
    expect(dynamicEntryText(provider.calls[1].messages)).toContain('- Bob: hates cilantro');
  });

  it('lists the side account on its member’s SERVER PEOPLE line, never as its own person', async () => {
    linkedStore();
    const provider = new FakeProvider([textResponse('ok')]);
    const agent = makeAgent(provider);

    await agent.handleMention(createFakeMessage({ ...BASE, content: 'hi', channelMessages: [] }).message);

    const staticPrompt = textOf(provider.calls[0].messages[0]);
    expect(staticPrompt).toContain(
      `- Bob @bobby_b (id:${BOB}) — also posts as BobAlt @bob_alt (id:${DAVE})`,
    );
    expect(staticPrompt).not.toContain('\n- BobAlt');
  });
});

describe('history budget', () => {
  const bigSeed = () =>
    Array.from({ length: 25 }, (_, i) =>
      chat(String(8000 + i), `${i} ${'x'.repeat(1400)}`, { authorId: BOB, authorDisplayName: 'Bob' }),
    );

  it('trims the window when persisting, leaving one note and the static prompt untouched', async () => {
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider, { historyTokenBudget: 4000 });
    const ping1 = createFakeMessage({ ...BASE, messageId: '8100', content: 'first', channelMessages: bigSeed() });
    const ping2 = createFakeMessage({ ...BASE, messageId: '8101', content: 'second', channelMessages: [] });

    await agent.handleMention(ping1.message);
    await agent.handleMention(ping2.message);

    // Turn 1 ran with the whole seed; the persisted state was cut to budget.
    expect(countText(provider.calls[0].messages, 'x'.repeat(100))).toBe(25);
    const second = provider.calls[1].messages;
    expect(second[0]).toEqual(provider.calls[0].messages[0]);
    expect(textOf(second[1])).toBe(TRIMMED_NOTE);
    expect(countText(second, TRIMMED_NOTE)).toBe(1);
    expect(countText(second, 'x'.repeat(100))).toBeLessThan(25);
    // The newest seed message and the reply survive; the oldest went.
    expect(indexOfText(second, `24 ${'x'.repeat(10)}`)).toBeGreaterThan(0);
    expect(indexOfText(second, `: 0 ${'x'.repeat(10)}`)).toBe(-1);
    expect(textOf(second.at(-1))).toContain('second');
    expect(info.mock.calls.some(([line]) => /history_trim .*phase=persist budget=4000/.test(String(line)))).toBe(true);
  });

  it("trims before the call when the window would overflow the model's context", async () => {
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider([textResponse('one')]);
    // A 6k-token model: budget 3k, and the 25 × ~400-token seed is past 90% of the context.
    const agent = makeAgent(provider, { contextLengths: { get: async () => 6000 } });
    const ping = createFakeMessage({ ...BASE, messageId: '8100', content: 'first', channelMessages: bigSeed() });

    await agent.handleMention(ping.message);

    expect(textOf(provider.calls[0].messages[1])).toBe(TRIMMED_NOTE);
    expect(info.mock.calls.some(([line]) => /history_trim .*phase=preflight budget=3000/.test(String(line)))).toBe(true);
  });

  it('lets a memory come back once a preflight trim dropped the entry that carried it', async () => {
    await getMemoryStore().save({ category: 'fact', subject: 'Alice', content: 'mains jungle', subject_user_id: ALICE });
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider([textResponse('one'), textResponse('two'), textResponse('three')]);
    // A 6k-token model: budget 3k, preflight past 5.4k. The persist trim then has nothing left to drop.
    const agent = makeAgent(provider, { contextLengths: { get: async () => 6000 } });
    const catchUp = Array.from({ length: 25 }, (_, i) =>
      chat(String(8101 + i), `${i} ${'x'.repeat(1400)}`, { authorId: BOB, authorDisplayName: 'Bob' }),
    );
    const dynamicTexts = (entries: ConversationEntry[]) =>
      messageEntries(entries)
        .filter((e) => e.role === 'developer' && textOf(e).startsWith('Current time:'))
        .map(textOf);

    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '8100', content: 'yo', channelMessages: [] }).message,
    );
    expect(dynamicEntryText(provider.calls[0].messages)).toContain('- mains jungle');
    // A busy stretch between pings: the catch-up overflows the context, so turn 2 is cut before its call.
    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '8150', content: 'yo', channelMessages: catchUp }).message,
    );
    const trims = info.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('history_trim'));
    expect(trims.some((line) => line.includes('phase=preflight'))).toBe(true);
    expect(trims.some((line) => line.includes('phase=persist'))).toBe(false);
    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '8200', content: 'yo again', channelMessages: [] }).message,
    );

    // Turn 1's context entry is gone from the window, so turn 3 brings the memory back (once).
    const third = provider.calls[2].messages;
    expect(countText(third, 'mains jungle')).toBe(1);
    expect(dynamicTexts(third).at(-1)).toContain('- mains jungle');
  });

  it('sizes the budget from the smallest context among the fallback models, capped at 500k', async () => {
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider([textResponse('one')]);
    Object.defineProperty(provider, 'chatModels', { value: ['primary/model', 'small/model'] });
    const asked: string[] = [];
    const agent = makeAgent(provider, {
      contextLengths: {
        get: async (model: string) => {
          asked.push(model);
          return model === 'small/model' ? 6000 : 1_310_720;
        },
      },
    });

    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '8100', content: 'first', channelMessages: bigSeed() }).message,
    );

    expect(asked.sort()).toEqual(['primary/model', 'small/model']);
    expect(info.mock.calls.some(([line]) => /history_trim .*budget=3000/.test(String(line)))).toBe(true);
  });

  it('honors HISTORY_TOKEN_BUDGET over the model-derived budget', async () => {
    vi.stubEnv('HISTORY_TOKEN_BUDGET', '5000');
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider([textResponse('one')]);
    const agent = makeAgent(provider, { contextLengths: { get: async () => 1_310_720 } });

    await agent.handleMention(
      createFakeMessage({ ...BASE, messageId: '8100', content: 'first', channelMessages: bigSeed() }).message,
    );

    expect(info.mock.calls.some(([line]) => /history_trim .*phase=persist budget=5000/.test(String(line)))).toBe(true);
  });
});

describe('tool limits and dangling calls', () => {
  let executed: string[];
  const echo: ToolDefinition = {
    name: 'echo_tool',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
    handler: async (_ctx, args) => {
      executed.push(String(args.n));
      return `echo ${String(args.n)}`;
    },
  };

  beforeEach(() => {
    executed = [];
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  const call = (id: string) => ({ id, name: 'echo_tool', arguments: { n: id } });
  const results = (entries: ConversationEntry[]) =>
    entries.filter((e): e is Extract<ConversationEntry, { kind: 'tool_result' }> => e.kind === 'tool_result');

  it('answers every call it will not run before forcing a text-only reply', async () => {
    const provider = new FakeProvider([toolCallResponse([call('t1'), call('t2'), call('t3')]), textResponse('forced')]);
    const agent = makeAgent(provider, { tools: [echo], maxToolInvocations: 2 });

    await agent.handleMention(createFakeMessage({ ...BASE, content: 'go', channelMessages: [] }).message);

    expect(executed).toEqual([]);
    const forced = provider.calls[1];
    expect(forced.toolChoice).toBe('none');
    expect(results(forced.messages).map((r) => [r.id, r.content])).toEqual([
      ['t1', 'not executed: tool call limit reached for this turn'],
      ['t2', 'not executed: tool call limit reached for this turn'],
      ['t3', 'not executed: tool call limit reached for this turn'],
    ]);
  });

  it('keeps the results of calls that ran and answers only the ones over the limit', async () => {
    const provider = new FakeProvider([
      toolCallResponse([call('t1')]),
      toolCallResponse([call('t2'), call('t3')]),
      textResponse('forced'),
    ]);
    const agent = makeAgent(provider, { tools: [echo], maxToolInvocations: 2 });

    await agent.handleMention(createFakeMessage({ ...BASE, content: 'go', channelMessages: [] }).message);

    expect(executed).toEqual(['t1']);
    expect(results(provider.calls[2].messages).map((r) => [r.id, r.content])).toEqual([
      ['t1', 'echo t1'],
      ['t2', 'not executed: tool call limit reached for this turn'],
      ['t3', 'not executed: tool call limit reached for this turn'],
    ]);
  });

  it('never stores an unanswered call when a forced text-only call still returns tool calls', async () => {
    const provider = new FakeProvider([
      toolCallResponse([call('t1')]),
      toolCallResponse([call('t2')], 'fine, here'),
      textResponse('next turn'),
    ]);
    const agent = makeAgent(provider, { tools: [echo], maxToolRounds: 0 });
    // maxToolRounds 0: the first tool round is already the last, so the second call is the forced one.
    const ping1 = createFakeMessage({ ...BASE, messageId: '9000', content: 'go', channelMessages: [] });
    const ping2 = createFakeMessage({ ...BASE, messageId: '9001', content: 'again', channelMessages: [] });

    await agent.handleMention(ping1.message);
    await agent.handleMention(ping2.message);

    expect(provider.calls[1].toolChoice).toBe('none');
    const t2 = results(provider.calls[2].messages).find((r) => r.id === 't2');
    expect(t2?.content).toBe('not executed: that tool is not available');
  });

  it('answers a call to a tool it does not offer and asks again, instead of ending the turn blank', async () => {
    // run_code has a handler but is gated off (no sandbox), so the provider only offers echo_tool.
    const gated: ToolDefinition = {
      name: 'run_code',
      description: 'gated',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        executed.push('run_code');
        return 'ran';
      },
    };
    const provider = new FakeProvider([
      toolCallResponse([{ id: 'r1', name: 'run_code', arguments: { code: 'print(137.5 * 1.18 / 4)' } }]),
      textResponse('40.56 each'),
    ]);
    const agent = makeAgent(provider, { tools: [echo, gated] });
    const ping = createFakeMessage({ ...BASE, content: 'split 137.50 four ways with 18% tip', channelMessages: [] });

    await agent.handleMention(ping.message);

    expect(executed).toEqual([]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].toolChoice).toBe('auto');
    expect(results(provider.calls[1].messages).map((r) => [r.id, r.content])).toEqual([
      ['r1', 'not executed: that tool is not available'],
    ]);
    expect(ping.recorders.reply.calls).toEqual([['40.56 each']]);
    expect(getMemoryStore().getByCategory('capability_gap').map((m) => m.content)).toEqual([
      'Tool "run_code" requested but not offered',
    ]);
  });

  it('runs the offered calls of a mixed round and answers the rest as not available', async () => {
    const provider = new FakeProvider([
      toolCallResponse([call('t1'), { id: 'w1', name: 'web_search', arguments: { query: 'score' } }]),
      textResponse('done'),
    ]);
    const agent = makeAgent(provider, { tools: [echo] });

    await agent.handleMention(createFakeMessage({ ...BASE, content: 'go', channelMessages: [] }).message);

    expect(executed).toEqual(['t1']);
    expect(results(provider.calls[1].messages).map((r) => [r.id, r.content])).toEqual([
      ['t1', 'echo t1'],
      ['w1', 'not executed: that tool is not available'],
    ]);
  });

  it('bounds a model that keeps calling a tool it does not offer by the round limit', async () => {
    const unoffered = (id: string) => toolCallResponse([{ id, name: 'run_code', arguments: {} }]);
    const provider = new FakeProvider([unoffered('r1'), unoffered('r2'), textResponse('fine, by hand')]);
    const agent = makeAgent(provider, { tools: [echo], maxToolRounds: 1 });
    const ping = createFakeMessage({ ...BASE, content: 'go', channelMessages: [] });

    await agent.handleMention(ping.message);

    expect(provider.calls.map((c) => c.toolChoice)).toEqual(['auto', 'auto', 'none']);
    expect(ping.recorders.reply.calls).toEqual([['fine, by hand']]);
  });

  it('defaults are generous: 25 rounds and 200 invocations', async () => {
    const script: ProviderChatResponse[] = Array.from({ length: 12 }, (_, i) => toolCallResponse([call(`r${i}`)]));
    const provider = new FakeProvider([...script, textResponse('done')]);
    const agent = makeAgent(provider, { tools: [echo] });

    await agent.handleMention(createFakeMessage({ ...BASE, content: 'go', channelMessages: [] }).message);

    expect(executed).toHaveLength(12);
    expect(provider.calls.every((c) => c.toolChoice === 'auto')).toBe(true);
  });
});

describe('answerDanglingToolCalls', () => {
  it('places a synthetic result right after each unanswered call group, after the merged assistant text', () => {
    const entries: ConversationEntry[] = [
      { kind: 'message', role: 'user', content: [{ type: 'text', text: 'q' }] },
      { kind: 'tool_call', id: 'a', name: 'x', arguments: {} },
      { kind: 'tool_call', id: 'b', name: 'x', arguments: {} },
      { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'let me check' }] },
      { kind: 'tool_result', id: 'a', name: 'x', content: 'done' },
      { kind: 'message', role: 'user', content: [{ type: 'text', text: 'next' }] },
      { kind: 'tool_call', id: 'c', name: 'y', arguments: {} },
    ];

    expect(answerDanglingToolCalls(entries, 'skipped')).toBe(2);
    expect(entries.map((e) => (e.kind === 'message' ? e.role : `${e.kind}:${e.id}`))).toEqual([
      'user',
      'tool_call:a',
      'tool_call:b',
      'assistant',
      'tool_result:a',
      'tool_result:b',
      'user',
      'tool_call:c',
      'tool_result:c',
    ]);
    expect(answerDanglingToolCalls(entries, 'skipped')).toBe(0);
  });
});

describe('reactions, served-by and the reply', () => {
  const reactTool: ToolDefinition = {
    name: 'react',
    description: 'reacts',
    parameters: { type: 'object', properties: {} },
    handler: async (ctx) => {
      ctx.turn.reactions.push('😂');
      return 'Reacted with 😂.';
    },
  };

  it('logs reactions and the model that actually served in reply_stats', async () => {
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider(
      [
        { ...toolCallResponse([{ id: 'r1', name: 'react', arguments: {} }]), servedBy: 'backup/model' },
        { ...textResponse(''), servedBy: 'backup/model' },
      ],
      { supportedTools: [{ name: 'react', type: 'function', hostHandled: true }] },
    );
    const agent = makeAgent(provider, { tools: [reactTool] });
    const ping = createFakeMessage({ ...BASE, content: 'thanks fridge', channelMessages: [] });

    await agent.handleMention(ping.message);

    expect(ping.recorders.reply.calls).toHaveLength(0);
    const stats = info.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith('reply_stats'));
    expect(stats).toContain('reactions=1');
    expect(stats).toContain('served_by=backup/model');
    expect(stats).toContain('model=fake-model');
  });

  it('logs served_by=unknown when the provider does not say', async () => {
    const info = vi.spyOn(logger, 'info');
    const provider = new FakeProvider([textResponse('hi')]);
    const agent = makeAgent(provider);

    await agent.handleMention(createFakeMessage({ ...BASE, content: 'yo', channelMessages: [] }).message);

    const stats = info.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith('reply_stats'));
    expect(stats).toContain('served_by=unknown');
    expect(stats).toContain('reactions=0');
  });

  it('sends at most 10 files per message, the first batch with the text', async () => {
    const manyFiles: ToolDefinition = {
      name: 'make_files',
      description: 'files',
      parameters: { type: 'object', properties: {} },
      handler: async (ctx) => {
        for (let i = 0; i < 12; i++) ctx.turn.files.push({ attachment: Buffer.from('x'), name: `f${i}.png` });
        return 'made';
      },
    };
    const provider = new FakeProvider(
      [toolCallResponse([{ id: 'c1', name: 'make_files', arguments: {} }]), textResponse('here')],
      { supportedTools: [{ name: 'make_files', type: 'function', hostHandled: true }] },
    );
    const agent = makeAgent(provider, { tools: [manyFiles] });
    const ping = createFakeMessage({ ...BASE, content: 'charts', channelMessages: [] });

    await agent.handleMention(ping.message);

    const payloads = ping.recorders.reply.calls.map(([p]) => p as { content?: string; files: unknown[] });
    expect(payloads.map((p) => [p.content, p.files.length])).toEqual([
      ['here', 10],
      [undefined, 2],
    ]);
  });

  it('still sends the text when Discord rejects the attachment as too large', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const bigFile: ToolDefinition = {
      name: 'make_file',
      description: 'file',
      parameters: { type: 'object', properties: {} },
      handler: async (ctx) => {
        ctx.turn.files.push({ attachment: Buffer.from('x'), name: 'huge.png' });
        return 'made';
      },
    };
    const provider = new FakeProvider(
      [toolCallResponse([{ id: 'c1', name: 'make_file', arguments: {} }]), textResponse('look at this')],
      { supportedTools: [{ name: 'make_file', type: 'function', hostHandled: true }] },
    );
    const agent = makeAgent(provider, { tools: [bigFile] });
    const ping = createFakeMessage({
      ...BASE,
      content: 'render it',
      channelMessages: [],
      replyImpl: async (payload) => {
        if (typeof payload === 'object' && payload !== null && 'files' in payload) {
          throw Object.assign(new Error('Request entity too large'), { code: 40005 });
        }
        return { id: '1' };
      },
    });

    await agent.handleMention(ping.message);

    expect(ping.recorders.reply.calls.at(-1)).toEqual(['look at this\n(the file was too big for Discord to take)']);
  });
});

describe('in-character errors', () => {
  it('picks a line from the pool with the injected RNG', () => {
    expect(pickErrorReply(() => 0)).toBe(ERROR_REPLIES[0]);
    expect(pickErrorReply(() => 0.9999)).toBe(ERROR_REPLIES.at(-1));
    expect(pickErrorReply(() => 1)).toBe(ERROR_REPLIES.at(-1));
    expect(ERROR_REPLIES.length).toBeGreaterThanOrEqual(8);
    for (const line of ERROR_REPLIES) expect(line.length).toBeLessThan(120);
  });

  it('replies in character when the turn blows up', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const provider = new FakeProvider([{ error: new Error('upstream exploded') }]);
    const agent = makeAgent(provider, { random: () => 0.5 });
    const ping = createFakeMessage({ ...BASE, content: 'yo', channelMessages: [] });

    await agent.handleMention(ping.message);

    expect(ping.recorders.reply.calls).toEqual([[ERROR_REPLIES[Math.floor(0.5 * ERROR_REPLIES.length)]]]);
    expect(ping.recorders.reply.calls.flat().join(' ')).not.toMatch(/encountered an error/);
  });
});

describe('helpers', () => {
  it('describeNowET names the weekday and the EDT/EST zone', () => {
    expect(describeNowET(new Date('2026-09-25T15:31:56Z'))).toBe('Friday 2026-09-25T11:31:56 EDT');
    expect(describeNowET(new Date('2026-01-02T15:00:00Z'))).toBe('Friday 2026-01-02T10:00:00 EST');
  });

  it('compareSnowflakes orders numerically, not lexically', () => {
    expect(compareSnowflakes('999', '1000')).toBeLessThan(0);
    expect(compareSnowflakes('1400000000000000001', '900000000000000042')).toBeGreaterThan(0);
    expect(compareSnowflakes('42', '42')).toBe(0);
  });
});
