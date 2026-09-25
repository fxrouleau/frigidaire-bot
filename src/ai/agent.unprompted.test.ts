// A turn the gate routed (nobody pinged the bot) says so in that turn's dynamic context; an explicit
// mention's turn is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeMessage } from '../test-support/fakeDiscord';
import { FakeProvider, textResponse } from '../test-support/fakeProvider';
import { AgentOrchestrator, UNPROMPTED_NOTE } from './agent';
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
