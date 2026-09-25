import { Collection } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoReactor, setAutoReactorForTesting } from '../reactions';
import type { Candidate } from '../reactions/autoReactor';
import { AutoReactLedger } from '../reactions/ledger';
import { BotDb } from '../storage/botDb';
import { type EventMessage, type FakeMessageOptions, createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import autoReactEvent from './autoReact';
import autoReactDeleteEvent from './autoReactDelete';

function withReactionCache(message: EventMessage): EventMessage {
  (message as unknown as Record<string, unknown>).reactions = { cache: new Collection() };
  return message;
}

function post(opts: FakeMessageOptions = {}): EventMessage {
  return withReactionCache(createFakeMessage({ channelId: 'main', messageId: '1001', content: 'lol', ...opts }).message);
}

let reactor: AutoReactor;
let observed: Candidate[];
let timers: Array<() => void>;
const judge = vi.fn(async () => ({ react: false, why: 'meh' }));

beforeEach(() => {
  vi.stubEnv('MAIN_CHANNEL_ID', 'main');
  vi.stubEnv('AUTO_REACT_MODE', 'on');
  timers = [];
  const db = new BotDb(':memory:');
  reactor = new AutoReactor({
    settings: () => ({
      mode: 'on',
      maxPerDay: 3,
      minGapMs: 0,
      minProfileMessages: 0,
      delayMs: 10_000,
      exchangeWindowMs: 120_000,
    }),
    judge,
    guide: () => ({ messages: 0, reactedMessages: 0, baseRate: 0, emojis: [], text: '', builtAt: 0 }),
    ledger: new AutoReactLedger(() => db),
    emojis: () => [],
    loadImages: async () => [],
    report: async () => {},
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => {},
  });
  observed = [];
  const observe = reactor.observe.bind(reactor);
  vi.spyOn(reactor, 'observe').mockImplementation((candidate) => {
    observed.push(candidate);
    observe(candidate);
  });
  setAutoReactorForTesting(reactor);
});

afterEach(() => {
  setAutoReactorForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('autoReact event', () => {
  it('queues a member post in the main channel (AUTO_REACT_CHANNELS defaults to it)', async () => {
    await autoReactEvent.execute(post());
    expect(observed.map((c) => c.id)).toEqual(['1001']);
    expect(reactor.pendingCount).toBe(1);
  });

  it('ignores other channels, bot names, and everything when off', async () => {
    await autoReactEvent.execute(post({ channelId: 'elsewhere' }));
    await autoReactEvent.execute(post({ content: 'fridge thoughts?' }));
    vi.stubEnv('AUTO_REACT_MODE', 'off');
    await autoReactEvent.execute(post());
    expect(observed).toEqual([]);
  });

  it('honors AUTO_REACT_CHANNELS', async () => {
    vi.stubEnv('AUTO_REACT_CHANNELS', 'clips, main');
    await autoReactEvent.execute(post({ channelId: 'clips', messageId: '1' }));
    expect(observed.map((c) => c.id)).toEqual(['1']);
  });

  it("notes the bot's own replies so the post it answered is never reacted to", async () => {
    await autoReactEvent.execute(post());
    const reply = withReactionCache(
      createFakeBotMessage({ channelId: 'main', messageId: '2002', referencedMessageId: '1001', repliedUserId: 'user-1' })
        .message,
    );
    await autoReactEvent.execute(reply);
    expect(observed.map((c) => c.id)).toEqual(['1001']);
    for (const fire of timers.splice(0)) fire();
    await reactor.idle();
    expect(judge).not.toHaveBeenCalled();
  });

  it('a deleted post is dropped', async () => {
    await autoReactEvent.execute(post());
    await autoReactDeleteEvent.execute(post());
    expect(reactor.pendingCount).toBe(0);
  });
});
