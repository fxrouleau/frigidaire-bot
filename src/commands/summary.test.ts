import { Collection, type FetchMessagesOptions, type Message, SnowflakeUtil } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import {
  type ChannelSummaryResult,
  type SummarizeChannelOptions,
  summarizeChannelResult,
} from '../ai/tools/summary';
import { FEATURE_HEADER } from '../ai/usage';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { chatCompletionBody, createCapturingClient } from '../test-support/capturingClient';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { createRecorder } from '../test-support/recorder';
import { LINES } from './respond';
import { summarizeFromMessage } from './summary';

vi.mock('../ai/media', () => ({
  getCachedTranscript: () => undefined,
  transcribeAudio: async () => undefined,
  describeVideo: async () => undefined,
}));

const message = { id: 'm-1' } as unknown as Message;
const start = new Date('2026-09-24T12:00:00.000Z');
const end = new Date('2026-09-25T12:00:00.000Z');

function pipelineReturning(result: ChannelSummaryResult) {
  return createRecorder<[SummarizeChannelOptions], Promise<ChannelSummaryResult>>(async () => result);
}

describe('summarizeFromMessage', () => {
  it('asks the summary pipeline for the range from the target message, as the requester', async () => {
    const summarize = pipelineReturning({
      ok: true,
      summary: 'they planned a BBQ',
      header: 'Summary of #general from … (3 messages from 2 people):',
      caveats: [],
      peopleFooter: 'People in this stretch: Jason, Simon.',
    });
    const result = await summarizeFromMessage({ message, start, end, requesterId: 'u-felix' }, summarize);

    expect(summarize.calls).toEqual([[{ message, messageRole: 'target', start, end, requesterId: 'u-felix' }]]);
    // The range header and the people footer are for the chat model, not the channel.
    expect(result).toEqual({ ok: true, text: 'they planned a BBQ' });
  });

  it('keeps caveats as small print under the summary', async () => {
    const summarize = pipelineReturning({
      ok: true,
      summary: 'they planned a BBQ',
      header: 'Summary of …',
      caveats: ['History before the first summarized message could not be fetched.'],
    });
    expect(await summarizeFromMessage({ message, start, end }, summarize)).toEqual({
      ok: true,
      text: 'they planned a BBQ\n-# History before the first summarized message could not be fetched.',
    });
  });

  it('turns each failure into a private, in-character reason', async () => {
    const reasons = await Promise.all(
      (['no_messages', 'history_unreadable', 'model_failed', 'model_empty'] as const).map((reason) =>
        summarizeFromMessage({ message, start, end }, pipelineReturning({ ok: false, reason, message: 'for the model' })),
      ),
    );
    expect(reasons).toEqual([
      { ok: false, reason: 'nothing to summarize from there' },
      { ok: false, reason: "can't read the history in there" },
      { ok: false, reason: LINES.failed },
      { ok: false, reason: LINES.failed },
    ]);
  });
});

describe('summarizeFromMessage through the real pipeline', () => {
  const NOW = new Date('2026-01-15T17:00:00Z');
  const MIN = 60_000;
  let seq = 0;

  beforeEach(() => {
    setBotDbForTesting(new BotDb(':memory:'));
    const store = new MemoryStore(':memory:');
    store.upsertIdentity('u-jason', 'Jason');
    store.upsertIdentity('u-simon', 'Simon');
    setMemoryStoreForTesting(store);
  });

  afterEach(() => {
    setBotDbForTesting(undefined);
    setMemoryStoreForTesting(undefined);
  });

  function said(minutesAgo: number, who: 'jason' | 'simon', content: string): Message {
    const createdAt = new Date(NOW.getTime() - minutesAgo * MIN);
    seq += 1;
    const messageId = SnowflakeUtil.generate({ timestamp: createdAt, increment: BigInt(seq), workerId: 1n, processId: 1n }).toString();
    const names = { jason: 'Jason', simon: 'Simon' };
    return createFakeMessage({ messageId, createdAt, authorId: `u-${who}`, authorDisplayName: names[who], content }).message;
  }

  it('summarizes the target and everything after it with one ZDR call tagged summary', async () => {
    const target = said(40, 'jason', 'who is up for wings');
    const history = [said(50, 'simon', 'older stuff'), target, said(30, 'simon', 'me'), said(20, 'jason', '7pm then')];
    const channel = target.channel as unknown as {
      name: string;
      messages: { fetch: (opts: FetchMessagesOptions) => Promise<Collection<string, Message>> };
    };
    channel.name = 'banana-combo';
    channel.messages.fetch = async (opts) => {
      const before = opts.before ? BigInt(opts.before) : undefined;
      const page = history
        .filter((m) => before === undefined || BigInt(m.id) < before)
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .slice(0, opts.limit ?? 50);
      return new Collection(page.map((m) => [m.id, m]));
    };
    const { client, requests } = createCapturingClient([{ body: chatCompletionBody('- Wings at 7pm (Jason, Simon)') }]);

    const result = await summarizeFromMessage({ message: target, start: target.createdAt, end: NOW, requesterId: 'u-simon' }, (opts) =>
      summarizeChannelResult({ ...opts, client, now: () => NOW }),
    );

    expect(result).toEqual({ ok: true, text: '- Wings at 7pm (Jason, Simon)' });
    expect(requests).toHaveLength(1);
    expect(requests[0].body.provider).toEqual({ zdr: true });
    expect(requests[0].headers.get(FEATURE_HEADER)).toBe('summary');
    const prompt = JSON.stringify(requests[0].body.messages);
    expect(prompt).toContain('Jason: who is up for wings');
    expect(prompt).toContain('Jason: 7pm then');
    expect(prompt).not.toContain('older stuff');
  });
});
