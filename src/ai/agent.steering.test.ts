// Follow-ups folded into a running turn (src/ai/turnSteering.ts): a member who keeps typing while the bot
// answers them gets one reply to all of it, never one per line.
import type { Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeMessage, type FakeMessageOptions, sentContent } from '../test-support/fakeDiscord';
import { type ChatInput, FakeProvider, textResponse, toolCallResponse } from '../test-support/fakeProvider';
import { AgentOrchestrator, EMPTY_REPLIES, FOLLOW_UP_NOTE } from './agent';
import { setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import { MAX_STEER_RESTARTS } from './turnSteering';
import type { ConversationEntry, ProviderChatResponse, ToolDefinition } from './types';

const BOT = '900000000000000001';
const MARCO = '100000000000000001';
const BOB = '100000000000000002';

function textOf(entry: ConversationEntry | undefined): string {
  if (entry?.kind !== 'message') return '';
  return entry.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** Where in a request the entry containing `text` sits (-1 when it isn't there). */
function indexOfText(input: ChatInput, text: string): number {
  return input.messages.findIndex((entry) => textOf(entry).includes(text));
}

function replyStats(): string[] {
  return vi
    .mocked(logger.info)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith('reply_stats'));
}

/** One channel: every message posted through `post` lands in the same log the agent fetches from. */
function channel() {
  const log: Message[] = [];
  const post = (id: string, content: string, extra: Partial<FakeMessageOptions> = {}) => {
    const fake = createFakeMessage({
      channelId: '555000000000000001',
      botUserId: BOT,
      authorId: MARCO,
      authorDisplayName: 'Marco',
      messageId: id,
      content,
      channelMessages: log,
      ...extra,
    });
    log.push(fake.message);
    return fake;
  };
  return { post };
}

/** A model call that only ends when it is cancelled, after `during` ran (with the call out). */
function cancelledCall(during: () => void): (input: ChatInput) => Promise<ProviderChatResponse> {
  return (input) =>
    new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      during();
    });
}

function makeAgent(provider: FakeProvider, tools: ToolDefinition[] = []): AgentOrchestrator {
  return new AgentOrchestrator({
    resolveProvider: () => provider,
    tools,
    timeoutMs: 60_000,
    enrichers: [],
    contextLengths: { get: async () => undefined },
    channelNotes: () => ({ notes: {}, invalid: false }),
  });
}

beforeEach(() => {
  setMemoryStoreForTesting(new MemoryStore(':memory:'));
  setBotDbForTesting(new BotDb(':memory:'));
  vi.stubEnv('DEBUG_CAPTURE', '0');
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('follow-ups from the person being answered', () => {
  it('cancels the model call a follow-up lands in and answers everything once, replying to the newest line', async () => {
    const { post } = channel();
    const first = post('6000', `<@${BOT}> yo`);
    const aside = post('6001', 'lol same', { authorId: BOB, authorDisplayName: 'Bob' });
    const follow = post('6002', 'what time is the raid tonight');
    let followUp: Promise<void> | undefined;
    const provider = new FakeProvider([
      cancelledCall(() => {
        followUp = ref.agent.handleMention(follow.message, { unprompted: true });
      }),
      textResponse('9, same as always'),
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message);
    await followUp;

    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1];
    // The whole stretch since the turn's own message goes in, under one note: the aside as history too.
    const note = indexOfText(second, FOLLOW_UP_NOTE);
    expect(note).toBeGreaterThan(indexOfText(second, 'yo'));
    expect(indexOfText(second, 'lol same')).toBeGreaterThan(note);
    expect(indexOfText(second, 'what time is the raid')).toBeGreaterThan(indexOfText(second, 'lol same'));
    expect(second.messages.at(-1)).toMatchObject({ role: 'user', messageIds: ['6002'] });
    // One reply, to the newest line.
    expect(first.recorders.reply.calls).toHaveLength(0);
    expect(aside.recorders.reply.calls).toHaveLength(0);
    expect(follow.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['9, same as always']);
    expect(replyStats()).toHaveLength(1);
    expect(replyStats()[0]).toMatch(/ steered=1 restarts=1 ms=\d+ /);
  });

  it('never cancels a running tool: the follow-up goes in before the next call', async () => {
    const { post } = channel();
    const first = post('6100', `<@${BOT}> remind me about the raid`);
    const follow = post('6101', 'actually make it 8');
    let followUp: Promise<void> | undefined;
    let toolRuns = 0;
    const slowTool: ToolDefinition = {
      name: 'echo_tool',
      description: 'Echo tool for tests',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        toolRuns++;
        followUp = ref.agent.handleMention(follow.message);
        return 'reminder set for 9';
      },
    };
    const provider = new FakeProvider([
      toolCallResponse([{ id: 'call-1', name: 'echo_tool', arguments: {} }]),
      textResponse('moved it to 8'),
    ]);
    const ref = { agent: makeAgent(provider, [slowTool]) };

    await ref.agent.handleMention(first.message);
    await followUp;

    expect(toolRuns).toBe(1);
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1];
    expect(second.messages.findIndex((e) => e.kind === 'tool_result')).toBeLessThan(indexOfText(second, FOLLOW_UP_NOTE));
    expect(indexOfText(second, 'actually make it 8')).toBe(second.messages.length - 1);
    expect(follow.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['moved it to 8']);
    expect(first.recorders.reply.calls).toHaveLength(0);
    expect(replyStats()[0]).toMatch(/ steered=1 restarts=0 /);
  });

  it('drops an answer that came back as the follow-up landed, instead of posting it', async () => {
    const { post } = channel();
    const first = post('6200', `<@${BOT}> who's on tonight`);
    const follow = post('6201', 'and who brings snacks');
    let followUp: Promise<void> | undefined;
    const provider = new FakeProvider([
      // A provider that answers anyway: the call was cancelled, so the draft is dropped all the same.
      () => {
        followUp = ref.agent.handleMention(follow.message);
        return textResponse('just Bob');
      },
      textResponse('Bob, and Bob brings snacks'),
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message);
    await followUp;

    expect(provider.calls).toHaveLength(2);
    expect(indexOfText(provider.calls[1], 'just Bob')).toBe(-1);
    expect(follow.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual([
      'Bob, and Bob brings snacks',
    ]);
    expect(first.recorders.reply.calls).toHaveLength(0);
  });

  it('turns an unprompted turn into a prompted one when a follow-up pings the bot', async () => {
    const { post } = channel();
    const first = post('6300', 'fridge you there');
    const follow = post('6301', `<@${BOT}> hello??`);
    let followUp: Promise<void> | undefined;
    const provider = new FakeProvider([
      cancelledCall(() => {
        followUp = ref.agent.handleMention(follow.message);
      }),
      textResponse(''),
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message, { unprompted: true });
    await followUp;

    // An empty answer to a ping gets an in-character line (an unprompted one would post nothing).
    const posted = follow.recorders.reply.calls.map(([payload]) => sentContent(payload));
    expect(posted).toHaveLength(1);
    expect(EMPTY_REPLIES).toContain(posted[0]);
  });

  it('stays silent when every line was unprompted and there is nothing to say', async () => {
    const { post } = channel();
    const first = post('6400', 'fridge you there');
    const follow = post('6401', 'fridge??');
    let followUp: Promise<void> | undefined;
    const provider = new FakeProvider([
      cancelledCall(() => {
        followUp = ref.agent.handleMention(follow.message, { unprompted: true });
      }),
      textResponse(''),
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message, { unprompted: true });
    await followUp;

    expect(follow.recorders.reply.calls).toHaveLength(0);
    expect(first.recorders.reply.calls).toHaveLength(0);
  });

  it(`cancels at most ${MAX_STEER_RESTARTS} calls per turn; a later line gets its own turn`, async () => {
    const { post } = channel();
    const first = post('6500', `<@${BOT}> ok so`);
    const lines = [1, 2, 3, 4].map((n) => post(`650${n}`, `line ${n}`));
    const followUps: Array<Promise<void>> = [];
    const send = (n: number) => () => {
      followUps.push(ref.agent.handleMention(lines[n].message));
    };
    const provider = new FakeProvider([
      cancelledCall(send(0)),
      cancelledCall(send(1)),
      cancelledCall(send(2)),
      // Past the cap the call runs to its end, and the fourth line waits for a turn of its own.
      () => {
        send(3)();
        return textResponse('answer to lines 1-3');
      },
      textResponse('answer to line 4'),
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message);
    await Promise.all(followUps);

    expect(provider.calls).toHaveLength(5);
    expect(lines[2].recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['answer to lines 1-3']);
    expect(lines[3].recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['answer to line 4']);
    // The fourth line's turn sees the reply that went out before it.
    expect(indexOfText(provider.calls[4], 'answer to lines 1-3')).toBeGreaterThan(0);
    expect(replyStats()[0]).toMatch(new RegExp(` steered=3 restarts=${MAX_STEER_RESTARTS} `));
  });
});

describe('what is not folded in', () => {
  it("queues someone else's message behind the running turn, which it then sees", async () => {
    const { post } = channel();
    const first = post('6600', `<@${BOT}> best pizza in town?`);
    const bob = post('6601', `<@${BOT}> and best burger?`, { authorId: BOB, authorDisplayName: 'Bob' });
    let bobsTurn: Promise<void> | undefined;
    const provider = new FakeProvider([
      () => {
        bobsTurn = ref.agent.handleMention(bob.message);
        return textResponse('the corner place');
      },
      textResponse('the diner'),
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message);
    await bobsTurn;

    expect(provider.calls).toHaveLength(2);
    expect(indexOfText(provider.calls[0], FOLLOW_UP_NOTE)).toBe(-1);
    expect(first.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['the corner place']);
    expect(bob.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['the diner']);
    expect(indexOfText(provider.calls[1], 'the corner place')).toBeGreaterThan(0);
  });

  it('gives a line sent while the reply is being posted a turn of its own', async () => {
    const { post } = channel();
    let followUp: Promise<void> | undefined;
    const follow = post('6701', 'wait one more thing');
    const first = post('6700', `<@${BOT}> quick q`, {
      replyImpl: async () => {
        followUp = ref.agent.handleMention(follow.message);
        return {};
      },
    });
    const provider = new FakeProvider([textResponse('sure'), textResponse('go on')]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(first.message);
    await followUp;

    expect(provider.calls).toHaveLength(2);
    expect(first.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['sure']);
    expect(follow.recorders.reply.calls.map(([payload]) => sentContent(payload))).toEqual(['go on']);
    expect(indexOfText(provider.calls[1], FOLLOW_UP_NOTE)).toBe(-1);
  });

  it('leaves an older message of the same person (routed late) to its own turn', async () => {
    const { post } = channel();
    // The gate was still deciding on "fridge who carries" when Marco pinged right after it.
    const late = post('6800', 'fridge who carries tonight');
    const ping = post('6801', `<@${BOT}> hello?`);
    let lateTurn: Promise<void> | undefined;
    const provider = new FakeProvider([
      () => {
        lateTurn = ref.agent.handleMention(late.message, { unprompted: true });
        return textResponse('you do, obviously');
      },
    ]);
    const ref = { agent: makeAgent(provider) };

    await ref.agent.handleMention(ping.message);
    await lateTurn;

    // Not a follow-up (no cancelled call), and its own turn sees it was already answered with it in view.
    expect(provider.calls).toHaveLength(1);
    expect(late.recorders.reply.calls).toHaveLength(0);
    expect(vi.mocked(logger.info).mock.calls.flat().join('\n')).toMatch(/Skipping the unprompted turn for message 6800/);
  });
});
