import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordUsage = vi.hoisted(() => vi.fn());
vi.mock('../ai/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/usage')>()),
  recordUsage,
}));

import { DECISIONS_ENDPOINT } from '../ai/decisions';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import {
  RAMBLE_LINES,
  RAMBLE_QUESTION,
  type RambleInput,
  type RambleSettings,
  RambleWatcher,
  buildRambleState,
  createBotDbRambleCooldowns,
  createRambleCheck,
} from './ramble';

const BOT_ID = 'bot-1';
const MAIN = 'main-1';
const RAMBLE_CHANNEL = 'ramble-1';
const JASON = 'jason-1';
const T0 = Date.parse('2026-09-25T18:00:00Z');
// ~250 characters of prose: four of these clear the default 800-character rule.
const LONG = `${'and another thing about the patch notes, '.repeat(6)}honestly`;

const SETTINGS: RambleSettings = {
  userIds: [JASON],
  channelId: RAMBLE_CHANNEL,
  watchChannelIds: [MAIN],
  minMessages: 4,
  minChars: 800,
  windowSeconds: 300,
  cooldownMinutes: 120,
  threshold: 0.7,
  model: 'typesafe/jev-1.13',
};

type Harness = {
  watcher: RambleWatcher;
  check: Mock<(input: RambleInput) => Promise<number | undefined>>;
  clock: { now: number };
  settings: RambleSettings;
};

function harness(overrides: Partial<RambleSettings> = {}, answer: number | null = 0.9): Harness {
  const clock = { now: T0 };
  const settings = { ...SETTINGS, ...overrides };
  const check = vi.fn<(input: RambleInput) => Promise<number | undefined>>(async () => answer ?? undefined);
  const watcher = new RambleWatcher({
    settings: () => settings,
    check,
    cooldowns: createBotDbRambleCooldowns(),
    now: () => clock.now,
    random: () => 0,
  });
  return { watcher, check, clock, settings };
}

let counter = 0;

function post(content: string, at: number, opts: FakeMessageOptions = {}) {
  return createFakeMessage({
    content,
    botUserId: BOT_ID,
    channelId: MAIN,
    authorId: JASON,
    authorDisplayName: 'Jason',
    messageId: `m-${++counter}`,
    createdAt: new Date(at),
    ...opts,
  });
}

/** Feeds `count` long Jason messages 20 s apart starting at `start`; returns the last fake and outcome. */
async function rant(h: Harness, count: number, start = T0) {
  let last = post(LONG, start);
  let outcome = await h.watcher.observe(last.message);
  for (let i = 1; i < count; i++) {
    h.clock.now = start + i * 20_000;
    last = post(LONG, h.clock.now);
    outcome = await h.watcher.observe(last.message);
  }
  return { last, outcome };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
  recordUsage.mockReset();
  vi.restoreAllMocks();
});

describe('RambleWatcher rule (free)', () => {
  it('is off without watched members or without a ramble channel', async () => {
    expect(await harness({ userIds: [] }).watcher.observe(post(LONG, T0).message)).toBe('off');
    expect(await harness({ channelId: undefined }).watcher.observe(post(LONG, T0).message)).toBe('off');
  });

  it('never watches the ramble channel itself, or channels outside the watch list', async () => {
    const h = harness({ watchChannelIds: [MAIN, RAMBLE_CHANNEL] });
    expect(await h.watcher.observe(post(LONG, T0, { channelId: RAMBLE_CHANNEL }).message)).toBe('ignored');
    expect(await h.watcher.observe(post(LONG, T0, { channelId: 'clips-1' }).message)).toBe('ignored');
  });

  it('needs both enough messages and enough characters inside the window', async () => {
    const h = harness();
    expect((await rant(h, 3)).outcome).toBe('below_rule');

    const short = harness();
    for (let i = 0; i < 8; i++) {
      short.clock.now = T0 + i * 10_000;
      expect(await short.watcher.observe(post('nah fr', short.clock.now).message)).toBe('below_rule');
    }
    expect(h.check).not.toHaveBeenCalled();
    expect(short.check).not.toHaveBeenCalled();
  });

  it('forgets messages older than the window', async () => {
    const h = harness();
    await rant(h, 3, T0);
    // Six minutes later: the first three dropped out of the 5-minute window.
    h.clock.now = T0 + 6 * 60_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('below_rule');
    expect(h.check).not.toHaveBeenCalled();
  });

  it('does not count links and emoji markup as ramble length', async () => {
    const h = harness({ minMessages: 1, minChars: 100 });
    const linkDump = `https://example.com/${'a'.repeat(200)} <:kekw:123456789012345678>`;
    expect(await h.watcher.observe(post(linkDump, T0).message)).toBe('below_rule');
  });

  it("ignores other members' messages (but keeps them as context) and other bots entirely", async () => {
    const h = harness();
    expect(await h.watcher.observe(post(LONG, T0, { authorId: 'kev-1', authorDisplayName: 'Kev' }).message)).toBe(
      'ignored',
    );
    const hermes = post('daily recap', T0 + 1_000, { authorId: 'hermes', authorDisplayName: 'Hermes', authorIsBot: true });
    expect(await h.watcher.observe(hermes.message)).toBe('ignored');
    await rant(h, 4, T0 + 2_000);
    const transcript = h.check.mock.calls[0][0].transcript;
    expect(transcript.map((line) => line.author)).toEqual(['Kev', 'Jason', 'Jason', 'Jason', 'Jason']);
  });
});

describe('RambleWatcher decision and nudge', () => {
  it('confirms with the decision model and replies once, without a ping, pointing at the ramble channel', async () => {
    const h = harness();
    const { last, outcome } = await rant(h, 4);

    expect(outcome).toBe('nudged');
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.check.mock.calls[0][0].author).toBe('Jason');
    expect(last.recorders.reply.calls).toEqual([
      [
        {
          content: RAMBLE_LINES[0].replaceAll('{channel}', `<#${RAMBLE_CHANNEL}>`),
          allowedMentions: { repliedUser: false },
          failIfNotExists: false,
        },
      ],
    ]);
  });

  it("includes the bot's own messages in the transcript, marked", async () => {
    const h = harness();
    const bot = createFakeBotMessage({
      content: 'bro',
      botUserId: BOT_ID,
      channelId: MAIN,
      messageId: 'b-1',
      createdAt: new Date(T0 - 1_000),
    });
    expect(await h.watcher.observe(bot.message)).toBe('ignored');
    await rant(h, 4);
    expect(h.check.mock.calls[0][0].transcript[0]).toEqual({ author: 'Frigidaire', text: 'bro', self: true });
  });

  it('stays quiet when the model says it is a conversation, and asks again only after two more messages', async () => {
    const h = harness({}, 0.3);
    expect((await rant(h, 4)).outcome).toBe('not_ramble');

    h.clock.now += 20_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('recheck_wait');
    h.clock.now += 20_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('not_ramble');
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('fails closed (and waits before retrying) when the model gives no answer or the check throws', async () => {
    const h = harness({}, null);
    const { last, outcome } = await rant(h, 4);
    expect(outcome).toBe('no_answer');
    expect(last.recorders.reply.calls).toHaveLength(0);
    h.clock.now += 20_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('recheck_wait');

    const throwing = new RambleWatcher({
      settings: () => SETTINGS,
      check: async () => {
        throw new Error('boom');
      },
      cooldowns: createBotDbRambleCooldowns(),
      now: () => T0,
    });
    let outcomeThrown = '';
    for (let i = 0; i < 4; i++) outcomeThrown = await throwing.observe(post(LONG, T0 + i * 1_000).message);
    expect(outcomeThrown).toBe('no_answer');
  });

  it('nudges a member at most once per cooldown, persisted across restarts', async () => {
    const h = harness();
    expect((await rant(h, 4)).outcome).toBe('nudged');
    h.clock.now += 20_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('cooldown');

    // A fresh watcher (a redeploy) reads the cooldown back from bot.db.
    const restarted = harness();
    restarted.clock.now = h.clock.now + 60_000;
    expect((await rant(restarted, 4, restarted.clock.now)).outcome).toBe('cooldown');
    expect(restarted.check).not.toHaveBeenCalled();

    // Two hours after the nudge, a new ramble can be nudged again.
    const later = harness();
    later.clock.now = T0 + 60_000 + 120 * 60_000 + 1;
    expect((await rant(later, 4, later.clock.now)).outcome).toBe('nudged');
  });

  it('keeps the cooldown when the reply fails (e.g. a missing permission)', async () => {
    const h = harness();
    let outcome = '';
    for (let i = 0; i < 4; i++) {
      h.clock.now = T0 + i * 20_000;
      const fake = post(LONG, h.clock.now, {
        replyImpl: async () => {
          throw new Error('Missing Permissions');
        },
      });
      outcome = await h.watcher.observe(fake.message);
    }
    expect(outcome).toBe('nudge_failed');
    h.clock.now += 20_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('cooldown');
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it('asks only once while a check is in flight', async () => {
    let release: (value: number) => void = () => {};
    const check = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const watcher = new RambleWatcher({
      settings: () => ({ ...SETTINGS, minMessages: 1, minChars: 10 }),
      check,
      cooldowns: createBotDbRambleCooldowns(),
      now: () => T0,
      random: () => 0,
    });
    const first = watcher.observe(post(LONG, T0).message);
    expect(await watcher.observe(post(LONG, T0 + 1_000).message)).toBe('checking');
    release(0.95);
    expect(await first).toBe('nudged');
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('createBotDbRambleCooldowns', () => {
  it('still enforces the cooldown in memory when bot.db is unavailable', () => {
    const broken = new BotDb(':memory:');
    broken.close();
    setBotDbForTesting(broken);
    const cooldowns = createBotDbRambleCooldowns();

    expect(cooldowns.lastNudgedAt(JASON)).toBeUndefined();
    cooldowns.recordNudge(JASON, T0);
    expect(cooldowns.lastNudgedAt(JASON)).toBe(T0);
  });

  it('keeps the newest of the stored and remembered times', () => {
    const first = createBotDbRambleCooldowns();
    first.recordNudge(JASON, T0 + 5_000);
    const second = createBotDbRambleCooldowns();
    second.recordNudge(JASON, T0);
    // The second instance wrote an older time to the table, but remembers only its own; the first one
    // remembers the newer time it recorded.
    expect(first.lastNudgedAt(JASON)).toBe(T0 + 5_000);
    expect(second.lastNudgedAt(JASON)).toBe(T0);
  });
});

describe('RambleWatcher.pickLine', () => {
  it('picks with the injected RNG and never repeats the previous line', () => {
    const watcher = new RambleWatcher({
      settings: () => SETTINGS,
      check: async () => undefined,
      random: () => 0.5,
      lines: ['a', 'b', 'c'],
    });
    expect(watcher.pickLine()).toBe('b');
    expect(watcher.pickLine()).toBe('c');
    expect(watcher.pickLine()).toBe('b');
  });

  it('every bundled line points at the channel', () => {
    expect(RAMBLE_LINES.length).toBeGreaterThanOrEqual(10);
    for (const line of RAMBLE_LINES) expect(line).toContain('{channel}');
  });
});

describe('ramble decision question', () => {
  const INPUT: RambleInput = {
    author: 'Jason',
    transcript: [
      { author: 'Jason', text: LONG },
      { author: 'Kev', text: 'ok' },
      { author: 'Frigidaire', text: 'bro', self: true },
      { author: 'Jason', text: LONG },
    ],
  };

  it("describes the author's share of the chat in words and marks the bot", () => {
    const state = buildRambleState(INPUT);
    expect(state.author).toBe('Jason');
    expect(state.author_wrote).toBe('about half of the messages in `recent_chat`');
    expect((state.recent_chat as Array<{ author: string }>)[2].author).toBe('Frigidaire (the bot)');
    expect(buildRambleState({ author: 'Jason', transcript: [{ author: 'Jason', text: 'x' }] }).author_wrote).toBe(
      'every message in `recent_chat`',
    );
  });

  it('keeps the transcript short', () => {
    const long = { author: 'Jason', transcript: Array.from({ length: 40 }, () => ({ author: 'Jason', text: 'y'.repeat(2000) })) };
    const lines = buildRambleState(long).recent_chat as Array<{ text: string }>;
    expect(lines).toHaveLength(16);
    expect(lines[0].text.length).toBeLessThanOrEqual(300);
  });

  it('asks the decision model with ZDR routing and attributes the cost to the ramble feature', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          model: 'typesafe/jev-1.13-20260917',
          answers: { answer: { type: 'noul', noul: 0.82 } },
          usage: { input_tokens: 900, output_tokens: 20, cost: 0.00004 },
        }),
        { status: 200 },
      );
    });
    const check = createRambleCheck({ apiKey: 'sk-test', fetch: fetchImpl as unknown as typeof globalThis.fetch });

    expect(await check(INPUT)).toBe(0.82);
    expect(fetchImpl.mock.calls[0][0]).toBe(DECISIONS_ENDPOINT);
    expect(bodies[0]).toMatchObject({
      model: 'typesafe/jev-1.13',
      provider: { zdr: true },
      state: buildRambleState(INPUT),
      questions: { answer: RAMBLE_QUESTION },
    });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'ramble', cost: 0.00004 }));
  });
});
