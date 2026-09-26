import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmojiRow } from '../ai/memory/memoryStore';
import { AddressedGate } from '../gate/addressedGate';
import { BotDb } from '../storage/botDb';
import { createFakeMessage } from '../test-support/fakeDiscord';
import {
  type AutoReactSettings,
  AutoReactor,
  type AutoReactorDeps,
  type Candidate,
  type CandidateSnapshot,
} from './autoReactor';
import type { ReactionGuide } from './guide';
import type { JudgeInput, Verdict } from './judge';
import { AutoReactLedger } from './ledger';

const T0 = Date.UTC(2026, 8, 25, 16, 0);
const MIN = 60_000;
const KEKW = '300000000000000001';
const REMI = '200000000000000001';
const DALE = '200000000000000002';

const READY_GUIDE: ReactionGuide = {
  messages: 1000,
  reactedMessages: 300,
  baseRate: 0.3,
  emojis: [],
  text: '- :KEKW: (40×)',
  builtAt: T0,
};

const EMOJIS: EmojiRow[] = [
  { id: KEKW, name: 'KEKW', animated: 0, caption: null, captioned_at: null, active: 1, use_count: 0, last_used_at: null },
];

type Harness = {
  reactor: AutoReactor;
  ledger: AutoReactLedger;
  judge: ReturnType<typeof vi.fn<(input: JudgeInput) => Promise<Verdict | undefined>>>;
  report: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  loadImages: ReturnType<typeof vi.fn<(urls: string[], max: number) => Promise<string[]>>>;
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  settings: AutoReactSettings;
  clock: { now: number };
  guide: { current: ReactionGuide };
  /** Message ids the agent was handed (the gate's wasRouted). */
  routed: Set<string>;
  /** `channel:user` pairs the gate counts as partners in an active exchange (its isInExchange). */
  partners: Set<string>;
  fire(): Promise<void>;
};

function harness(overrides: Partial<AutoReactSettings> = {}, verdict: Verdict | undefined = undefined): Harness {
  const settings: AutoReactSettings = {
    mode: 'on',
    maxPerDay: 3,
    minGapMs: 45 * MIN,
    minProfileMessages: 200,
    delayMs: 10_000,
    ...overrides,
  };
  const clock = { now: T0 };
  const guide = { current: READY_GUIDE };
  const timers: Harness['timers'] = [];
  const db = new BotDb(':memory:');
  const ledger = new AutoReactLedger(() => db);
  const judge = vi.fn(async (_input: JudgeInput) => verdict ?? { react: true, emoji: 'KEKW', why: 'legendary fail' });
  const report = vi.fn(async (_text: string) => {});
  const loadImages = vi.fn(async (urls: string[], max: number) => urls.slice(0, max).map((u) => `data:${u}`));
  const routed = new Set<string>();
  const partners = new Set<string>();
  const deps: AutoReactorDeps = {
    settings: () => settings,
    judge,
    guide: () => guide.current,
    ledger,
    emojis: () => EMOJIS,
    loadImages,
    report,
    wasRouted: (messageId) => routed.has(messageId),
    inExchange: (channelId, userId) => partners.has(`${channelId}:${userId}`),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  const reactor = new AutoReactor(deps);
  return {
    reactor,
    ledger,
    judge,
    report,
    loadImages,
    timers,
    settings,
    clock,
    guide,
    routed,
    partners,
    async fire() {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
      await reactor.idle();
    },
  };
}

function candidate(
  id: string,
  // null ⇒ not a member's post (the snapshot is undefined).
  snapshot: Partial<CandidateSnapshot> | null = {},
  react: (emoji: string) => Promise<void> = async () => {},
): Candidate & { reacted: string[] } {
  const reacted: string[] = [];
  return {
    id,
    channelId: 'main',
    url: `https://discord.com/channels/g/main/${id}`,
    createdAt: T0,
    reacted,
    snapshot: () =>
      snapshot === null
        ? undefined
        : {
            authorId: REMI,
            authorName: 'Remi',
            text: 'I parallel parked into a hydrant',
            notes: [],
            imageUrls: [],
            botReacted: false,
            ...snapshot,
          },
    context: (limit) => [{ author: 'Dale', text: `context (limit ${limit})` }],
    react: async (emoji) => {
      await react(emoji);
      reacted.push(emoji);
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AutoReactor: flow', () => {
  it('waits out the delay, then reacts with the resolved server emoji', async () => {
    const h = harness();
    const post = candidate('m1', { imageUrls: ['https://cdn.discordapp.com/a.png'] });
    h.reactor.observe(post);
    expect(h.timers.map((t) => t.ms)).toEqual([10_000]);
    expect(h.judge).not.toHaveBeenCalled();

    await h.fire();
    expect(post.reacted).toEqual([`KEKW:${KEKW}`]);
    expect(h.ledger.since(0)).toMatchObject([{ messageId: 'm1', emoji: `<:KEKW:${KEKW}>`, mode: 'on', why: 'legendary fail' }]);
    expect(h.report).not.toHaveBeenCalled();

    const input = h.judge.mock.calls[0][0];
    expect(input.post).toEqual({
      author: 'Remi',
      text: 'I parallel parked into a hydrant',
      notes: [],
      images: ['data:https://cdn.discordapp.com/a.png'],
    });
    expect(input.context).toEqual([{ author: 'Dale', text: 'context (limit 6)' }]);
    expect(input.guide).toBe(READY_GUIDE);
  });

  it('accepts a unicode emoji', async () => {
    const h = harness({}, { react: true, emoji: '💀', why: 'dead' });
    const post = candidate('m1');
    const outcome = await h.reactor.evaluate(post);
    expect(outcome).toEqual({ status: 'reacted', emoji: '💀', why: 'dead' });
    expect(post.reacted).toEqual(['💀']);
  });

  it('does nothing when the judge says no', async () => {
    const h = harness({}, { react: false, why: 'just logistics' });
    const post = candidate('m1');
    expect(await h.reactor.evaluate(post)).toEqual({ status: 'no_reaction', why: 'just logistics' });
    expect(post.reacted).toEqual([]);
    expect(h.ledger.has('m1')).toBe(false);
  });

  it('never reacts with an emoji that does not exist', async () => {
    const h = harness({}, { react: true, emoji: 'totallyrealemoji', why: 'lol' });
    const post = candidate('m1');
    expect(await h.reactor.evaluate(post)).toMatchObject({ status: 'invalid_emoji', emoji: 'totallyrealemoji' });
    expect(post.reacted).toEqual([]);
    expect(h.ledger.has('m1')).toBe(false);
  });

  it('skips without a verdict (model down)', async () => {
    const h = harness();
    h.judge.mockResolvedValueOnce(undefined);
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'no verdict' });
  });

  it('gives the budget slot back when Discord refuses the reaction', async () => {
    const h = harness();
    const post = candidate('m1', {}, async () => {
      throw new Error('Missing Permissions');
    });
    expect(await h.reactor.evaluate(post)).toEqual({
      status: 'failed',
      emoji: `<:KEKW:${KEKW}>`,
      error: 'Missing Permissions',
    });
    expect(h.ledger.has('m1')).toBe(false);
  });
});

describe('AutoReactor: shadow mode', () => {
  it('reports what it would react with, never reacts, and still spends the budget', async () => {
    const h = harness({ mode: 'shadow' });
    const post = candidate('m1');
    expect(await h.reactor.evaluate(post)).toEqual({ status: 'shadow', emoji: `<:KEKW:${KEKW}>`, why: 'legendary fail' });
    expect(post.reacted).toEqual([]);
    expect(h.report).toHaveBeenCalledTimes(1);
    const line = h.report.mock.calls[0][0];
    expect(line).toContain(`would react <:KEKW:${KEKW}> to Remi's post https://discord.com/channels/g/main/m1`);
    expect(line).toContain('why: legendary fail');
    expect(h.ledger.since(0)).toMatchObject([{ messageId: 'm1', mode: 'shadow' }]);

    // The budget applies in shadow mode too: the next post within the gap isn't even judged.
    h.clock.now += 10 * MIN;
    expect(await h.reactor.evaluate(candidate('m2'))).toEqual({ status: 'skipped', reason: 'budget (gap)' });
    expect(h.judge).toHaveBeenCalledTimes(1);
  });

  it('never lets a report line ping anyone', async () => {
    const h = harness({ mode: 'shadow' }, { react: true, emoji: '😂', why: 'tagging @everyone lol' });
    await h.reactor.evaluate(candidate('m1', { authorName: '@here' }));
    const line = h.report.mock.calls[0][0];
    expect(line).not.toContain('@everyone');
    expect(line).not.toContain('@here');
  });
});

describe('AutoReactor: gates', () => {
  it('does nothing at all when off', async () => {
    const h = harness({ mode: 'off' });
    h.reactor.observe(candidate('m1'));
    expect(h.timers).toEqual([]);
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'off' });
  });

  it('learns first: no judging until the archive has enough reacted posts', async () => {
    const h = harness();
    h.guide.current = { ...READY_GUIDE, reactedMessages: 199 };
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'learning' });
    expect(h.judge).not.toHaveBeenCalled();
    h.guide.current = READY_GUIDE;
    expect(await h.reactor.evaluate(candidate('m1'))).toMatchObject({ status: 'reacted' });
  });

  it('keeps to the daily cap and the minimum gap', async () => {
    const h = harness({ maxPerDay: 2, minGapMs: 45 * MIN });
    expect(await h.reactor.evaluate(candidate('m1'))).toMatchObject({ status: 'reacted' });
    h.clock.now += 44 * MIN;
    expect(await h.reactor.evaluate(candidate('m2'))).toEqual({ status: 'skipped', reason: 'budget (gap)' });
    h.clock.now += 1 * MIN;
    expect(await h.reactor.evaluate(candidate('m2'))).toMatchObject({ status: 'reacted' });
    h.clock.now += 60 * MIN;
    expect(await h.reactor.evaluate(candidate('m3'))).toEqual({ status: 'skipped', reason: 'budget (daily_cap)' });
    expect(h.judge).toHaveBeenCalledTimes(2);
    h.clock.now = T0 + 24 * 60 * MIN + 1;
    expect(await h.reactor.evaluate(candidate('m3'))).toMatchObject({ status: 'reacted' });
  });

  it('never reacts twice to the same post', async () => {
    const h = harness({ minGapMs: 0 });
    expect(await h.reactor.evaluate(candidate('m1'))).toMatchObject({ status: 'reacted' });
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'already reacted' });
  });

  it('skips posts the bot already reacted to, and non-member posts', async () => {
    const h = harness();
    expect(await h.reactor.evaluate(candidate('m1', { botReacted: true }))).toEqual({
      status: 'skipped',
      reason: 'bot already reacted',
    });
    expect(await h.reactor.evaluate(candidate('m2', null))).toEqual({ status: 'skipped', reason: 'not a member post' });
    expect(h.judge).not.toHaveBeenCalled();
  });

  it('skips a post the bot replied to', async () => {
    const h = harness();
    h.reactor.noteBotMessage('main', { repliedToId: 'm1' });
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'bot replied' });
  });

  it('skips a post the agent was handed, before and after the judge', async () => {
    const h = harness();
    h.routed.add('m1');
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'bot replied' });
    expect(h.judge).not.toHaveBeenCalled();

    // The gate routed it while the judge was thinking (its decision-model call can outlast the delay).
    h.judge.mockImplementationOnce(async () => {
      h.routed.add('m2');
      return { react: true, emoji: 'KEKW', why: 'lol' };
    });
    expect(await h.reactor.evaluate(candidate('m2'))).toEqual({ status: 'skipped', reason: 'bot replied' });
    expect(h.ledger.has('m2')).toBe(false);
  });

  it("treats a relay as its original: the original's answer or reaction counts, its deletion doesn't", async () => {
    const relay = (id: string, originalId: string) => ({ ...candidate(id), originalId: () => originalId });
    const h = harness({ minGapMs: 0 });
    // The link fixer deletes the original (autoReactDelete cancels it); the relay is the candidate now.
    h.reactor.cancel('orig-1');
    h.reactor.cancel('orig-2');
    h.reactor.cancel('orig-3');

    // The agent was handed the original (a pinging reply or a mention holding a link), by its own id.
    h.routed.add('orig-1');
    expect(await h.reactor.evaluate(relay('relay-1', 'orig-1'))).toEqual({ status: 'skipped', reason: 'bot replied' });
    // The bot's reply went to the original.
    h.reactor.noteBotMessage('main', { repliedToId: 'orig-2' });
    expect(await h.reactor.evaluate(relay('relay-2', 'orig-2'))).toEqual({ status: 'skipped', reason: 'bot replied' });
    expect(h.judge).not.toHaveBeenCalled();
    // The gate routed the original while the judge was deciding on the relay.
    h.judge.mockImplementationOnce(async () => {
      h.routed.add('orig-3');
      return { react: true, emoji: 'KEKW', why: 'lol' };
    });
    expect(await h.reactor.evaluate(relay('relay-3', 'orig-3'))).toEqual({ status: 'skipped', reason: 'bot replied' });
    expect(h.ledger.has('relay-3')).toBe(false);

    // A regret repost of a post the bot already reacted to is still the same post.
    expect(await h.reactor.evaluate(candidate('orig-4'))).toMatchObject({ status: 'reacted' });
    expect(await h.reactor.evaluate(relay('relay-4', 'orig-4'))).toEqual({
      status: 'skipped',
      reason: 'already reacted',
    });

    // A relay whose original nobody answered is judged like any post.
    expect(await h.reactor.evaluate(relay('relay-5', 'orig-5'))).toMatchObject({ status: 'reacted' });
  });

  it('skips a post whose author the gate counts as mid-exchange (its follow-ups are the gate\'s)', async () => {
    const h = harness();
    h.partners.add(`main:${REMI}`);
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({
      status: 'skipped',
      reason: 'author is talking with the bot',
    });
    expect(h.judge).not.toHaveBeenCalled();
    // Other members are unaffected, and so is the author once the gate's exchange is over.
    expect(await h.reactor.evaluate(candidate('m2', { authorId: DALE }))).toMatchObject({ status: 'reacted' });
    h.partners.clear();
    h.clock.now += 45 * MIN;
    expect(await h.reactor.evaluate(candidate('m3'))).toMatchObject({ status: 'reacted' });
  });

  it('asks the real gate: every partner of the exchange, side accounts included, not just the last one answered', async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `200000000000000009:${REMI}`);
    try {
      const clock = { now: T0 };
      const gate = new AddressedGate({
        classify: async () => undefined,
        now: () => clock.now,
        settings: () => ({
          enabled: true,
          channelIds: ['main'],
          names: ['fridge'],
          followupSeconds: 120,
          maxPer10Min: 30,
          maxColdPer10Min: 3,
          threshold: 0.7,
        }),
      });
      const answer = (authorId: string, messageId: string) => {
        const { message } = createFakeMessage({ channelId: 'main', authorId, messageId, content: '<@bot-1> yo' });
        gate.noteRouted(message);
        gate.noteTurnDone(message);
      };
      answer(REMI, 'q1');
      clock.now += 60_000;
      answer(DALE, 'q2'); // the bot's latest answer went to Dale; Remi is still a partner

      const h = harness();
      const reactor = new AutoReactor({
        settings: () => h.settings,
        judge: h.judge,
        guide: () => h.guide.current,
        ledger: h.ledger,
        emojis: () => EMOJIS,
        loadImages: h.loadImages,
        report: h.report,
        inExchange: (channelId, userId) => gate.isInExchange(channelId, userId),
        now: () => clock.now,
      });
      expect(await reactor.evaluate(candidate('m1', { authorId: '200000000000000009' }))).toMatchObject({
        reason: 'author is talking with the bot',
      });
      clock.now += 121_000;
      expect(await reactor.evaluate(candidate('m2'))).toMatchObject({ status: 'reacted' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops a deleted post while it waits, and never reacts to one deleted mid-judgement', async () => {
    const h = harness();
    h.reactor.observe(candidate('m1'));
    h.reactor.cancel('m1');
    expect(h.timers[0].cleared).toBe(true);
    expect(h.reactor.pendingCount).toBe(0);
    await h.fire();
    expect(h.judge).not.toHaveBeenCalled();

    const post = candidate('m2');
    h.judge.mockImplementationOnce(async () => {
      h.reactor.cancel('m2');
      return { react: true, emoji: 'KEKW', why: 'lol' };
    });
    expect(await h.reactor.evaluate(post)).toEqual({ status: 'skipped', reason: 'deleted' });
    expect(post.reacted).toEqual([]);
    expect(h.ledger.has('m2')).toBe(false);
  });

  it('does not react when the bot replied while the judge was thinking', async () => {
    const h = harness();
    h.judge.mockImplementationOnce(async () => {
      h.reactor.noteBotMessage('main', { repliedToId: 'm1' });
      return { react: true, emoji: 'KEKW', why: 'lol' };
    });
    expect(await h.reactor.evaluate(candidate('m1'))).toEqual({ status: 'skipped', reason: 'bot replied' });
  });

  it('spends the last slot once when two decisions finish together', async () => {
    const h = harness({ maxPerDay: 1, minGapMs: 0 });
    const a = candidate('m1');
    const b = candidate('m2');
    h.reactor.observe(a);
    h.reactor.observe(b);
    await h.fire();
    expect([...a.reacted, ...b.reacted]).toHaveLength(1);
    expect(h.ledger.since(0)).toHaveLength(1);
  });

  it('queues a post once and bounds the waiting list', () => {
    const h = harness();
    h.reactor.observe(candidate('m1'));
    h.reactor.observe(candidate('m1'));
    expect(h.reactor.pendingCount).toBe(1);
    for (let i = 0; i < 80; i++) h.reactor.observe(candidate(`x${i}`));
    expect(h.reactor.pendingCount).toBe(50);
  });

  it('never throws out of an evaluation', async () => {
    const h = harness();
    const broken: Candidate = {
      ...candidate('m1'),
      snapshot: () => {
        throw new Error('boom');
      },
    };
    expect(await h.reactor.evaluate(broken)).toEqual({ status: 'skipped', reason: 'error' });
  });
});
