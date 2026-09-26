// A turn the gate routed (nobody pinged the bot) says so in that turn's dynamic context; an explicit
// mention's turn is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeMessage } from '../test-support/fakeDiscord';
import { FakeProvider, textResponse } from '../test-support/fakeProvider';
import { AgentOrchestrator, LATE_MESSAGE_NOTE, UNPROMPTED_NOTE } from './agent';
import { setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import type { ConversationEntry } from './types';

const BASE: FakeMessageOptions = {
  channelId: '555000000000000001',
  botUserId: '900000000000000001',
  authorId: '100000000000000001',
  authorDisplayName: 'Marco',
  channelMessages: [],
};

function makeAgent(provider: FakeProvider): AgentOrchestrator {
  return new AgentOrchestrator({
    resolveProvider: () => provider,
    tools: [],
    timeoutMs: 60_000,
    enrichers: [],
    contextLengths: { get: async () => undefined },
    channelNotes: () => ({ notes: {}, invalid: false }),
  });
}

function textOf(entry: ConversationEntry | undefined): string {
  if (entry?.kind !== 'message') return '';
  return entry.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** Every dynamic context entry in a chat input (they start with the current time), oldest first. */
function dynamicEntries(entries: ConversationEntry[]): string[] {
  return entries
    .filter((e) => e.kind === 'message' && e.role === 'developer' && textOf(e).startsWith('Current time:'))
    .map(textOf);
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

describe('unprompted turns (routed by the gate)', () => {
  it("tells the model in the turn's context that nobody pinged it", async () => {
    const provider = new FakeProvider([textResponse('T1, obviously')]);
    const agent = makeAgent(provider);
    const message = createFakeMessage({ ...BASE, messageId: '1000', content: 'fridge who wins worlds' });

    await agent.handleMention(message.message, { unprompted: true });

    const [dynamic] = dynamicEntries(provider.calls[0].messages);
    expect(dynamic).toContain(UNPROMPTED_NOTE);
    expect(UNPROMPTED_NOTE).toMatch(/Don't say they pinged, tagged or mentioned you/);
    // The note sits right before the message it is about.
    expect(textOf(provider.calls[0].messages.at(-2))).toContain(UNPROMPTED_NOTE);
    expect(message.recorders.reply.calls).toEqual([['T1, obviously']]);
  });

  it('leaves an explicit mention exactly as it was, even later in the same window', async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);
    const gated = createFakeMessage({ ...BASE, messageId: '2000', content: 'fridge you up?' });
    const pinged = createFakeMessage({ ...BASE, messageId: '2001', content: '<@900000000000000001> ok real question' });

    await agent.handleMention(gated.message, { unprompted: true });
    await agent.handleMention(pinged.message);

    const [first, second] = dynamicEntries(provider.calls[1].messages);
    // The earlier unprompted turn keeps its note in the window; this turn's own context has none.
    expect(first).toContain(UNPROMPTED_NOTE);
    expect(second).not.toContain(UNPROMPTED_NOTE);
    expect(dynamicEntries(provider.calls[1].messages)).toHaveLength(2);
  });

  it('has no note without the flag', async () => {
    const provider = new FakeProvider([textResponse('yo')]);
    const agent = makeAgent(provider);
    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '3000', content: '<@900000000000000001> hi' }).message);
    expect(dynamicEntries(provider.calls[0].messages).join('\n')).not.toContain('Nobody pinged you');
  });
});

describe('turns that land after a later turn (the gate was still deciding when a ping came in)', () => {
  const BOB = '100000000000000002';
  const CAROL = '100000000000000003';

  /** A window opened by Marco's ping; Bob then names the bot, and Carol pings right after. */
  function scene() {
    const opening = createFakeMessage({ ...BASE, messageId: '5000', content: '<@900000000000000001> yo' });
    const named = (channelMessages: FakeMessageOptions['channelMessages']) =>
      createFakeMessage({
        ...BASE,
        messageId: '5001',
        authorId: BOB,
        authorDisplayName: 'Bob',
        content: 'fridge who carries the raid tonight',
        channelMessages,
      });
    const late = named([opening.message]);
    const ping = createFakeMessage({
      ...BASE,
      messageId: '5002',
      authorId: CAROL,
      authorDisplayName: 'Carol',
      content: '<@900000000000000001> you awake?',
      channelMessages: [opening.message, late.message],
    });
    return { opening, late, ping };
  }

  it("drops a gate-routed turn whose message the bot already answered past, instead of replying to it twice", async () => {
    const provider = new FakeProvider([textResponse('sup'), textResponse('always, and bob carries')]);
    const agent = makeAgent(provider);
    const { opening, late, ping } = scene();

    await agent.handleMention(opening.message);
    // Carol's ping is routed at once; its catch-up already shows Bob's message.
    await agent.handleMention(ping.message);
    expect(provider.calls[1].messages.filter((e) => textOf(e).includes('who carries the raid'))).toHaveLength(1);
    // Then the gate's verdict on Bob's message comes back.
    await agent.handleMention(late.message, { unprompted: true });

    expect(provider.calls).toHaveLength(2);
    expect(late.recorders.reply.calls).toHaveLength(0);
    expect(vi.mocked(logger.info).mock.calls.flat().join('\n')).toMatch(/Skipping the unprompted turn for message 5001/);
  });

  it('still answers a late explicit turn, telling the model why its message shows up twice', async () => {
    const provider = new FakeProvider([textResponse('sup'), textResponse('always'), textResponse('bob does')]);
    const agent = makeAgent(provider);
    const { opening, late, ping } = scene();

    await agent.handleMention(opening.message);
    await agent.handleMention(ping.message);
    await agent.handleMention(late.message);

    expect(provider.calls).toHaveLength(3);
    const dynamic = dynamicEntries(provider.calls[2].messages);
    expect(dynamic.at(-1)).toContain(LATE_MESSAGE_NOTE);
    expect(dynamic.slice(0, -1).join('\n')).not.toContain(LATE_MESSAGE_NOTE);
    expect(late.recorders.reply.calls).toEqual([['bob does']]);
  });

  it('answers a gate-routed turn normally when no later turn has shown its message', async () => {
    const provider = new FakeProvider([textResponse('sup'), textResponse('bob, obviously')]);
    const agent = makeAgent(provider);
    const { opening, late } = scene();

    await agent.handleMention(opening.message);
    await agent.handleMention(late.message, { unprompted: true });

    expect(provider.calls).toHaveLength(2);
    const current = dynamicEntries(provider.calls[1].messages).at(-1);
    expect(current).toContain(UNPROMPTED_NOTE);
    expect(current).not.toContain(LATE_MESSAGE_NOTE);
    expect(late.recorders.reply.calls).toEqual([['bob, obviously']]);
  });
});
