import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import {
  RAMBLE_LINES,
  type RambleOutcome,
  type RambleSettings,
  RambleWatcher,
  createBotDbRambleCooldowns,
} from './ramble';
import type { RambleExampleRequest, RambleExamples } from './rambleExamples';
import type { RambleJudgeInput, RambleVerdict } from './rambleJudge';

const BOT_ID = '900000000000000001';
const MAIN = '300000000000000002';
const RAMBLE_CHANNEL = '300000000000000001';
const GUS = '100000000000000001';
const GUS_SIDE = '200000000000000001';
const KEV = '100000000000000002';
const T0 = Date.parse('2026-09-25T18:00:00Z');
// Enough prose that three of these clear the "not worth a call" floor; far below the long-message rule.
const LINE = 'ok but hear me out about the pigeons';
const LONG = `${'and another thing about the pigeons and the moon, '.repeat(13)}honestly`;

const SETTINGS: RambleSettings = {
  userIds: [GUS],
  channelId: RAMBLE_CHANNEL,
  watchChannelIds: [MAIN],
  mainChannelId: MAIN,
  minMessages: 3,
  longMessageChars: 600,
  windowSeconds: 300,
  cooldownMinutes: 120,
  threshold: 0.75,
};

const EXAMPLES: RambleExamples = {
  rambles: ['what if clouds are just sky sheep'],
  ramblesAreTheirs: true,
  normal: ['down for ranked at 9'],
};

type Harness = {
  watcher: RambleWatcher;
  judge: Mock<(input: RambleJudgeInput) => Promise<RambleVerdict | undefined>>;
  examples: Mock<(request: RambleExampleRequest) => RambleExamples>;
  clock: { now: number };
  settings: RambleSettings;
};

/** `verdict: null` = the judge gives no answer. */
function harness(overrides: Partial<RambleSettings> = {}, verdict: RambleVerdict | null = { ramble: true, confidence: 0.9 }): Harness {
  const clock = { now: T0 };
  const settings = { ...SETTINGS, ...overrides };
  const judge = vi.fn<(input: RambleJudgeInput) => Promise<RambleVerdict | undefined>>(async () => verdict ?? undefined);
  const examples = vi.fn<(request: RambleExampleRequest) => RambleExamples>(() => EXAMPLES);
  const watcher = new RambleWatcher({
    settings: () => settings,
    judge,
    examples,
    cooldowns: createBotDbRambleCooldowns(),
    now: () => clock.now,
    random: () => 0,
  });
  return { watcher, judge, examples, clock, settings };
}

let counter = 0;

/** A message in the main channel, by Gus unless overridden, at `at`. */
function post(content: string, at: number, opts: FakeMessageOptions = {}) {
  return createFakeMessage({
    content,
    botUserId: BOT_ID,
    channelId: MAIN,
    authorId: GUS,
    authorDisplayName: 'Gus',
    messageId: `m-${++counter}`,
    createdAt: new Date(at),
    ...opts,
  });
}

/** Feeds messages 20 s apart starting at `start` (the clock follows); returns every outcome and the last fake. */
async function say(h: Harness, contents: string[], start = h.clock.now, opts: FakeMessageOptions = {}) {
  const outcomes: RambleOutcome[] = [];
  let last = post(contents[0], start, opts);
  for (const [i, content] of contents.entries()) {
    h.clock.now = start + i * 20_000;
    last = post(content, h.clock.now, opts);
    outcomes.push(await h.watcher.observe(last.message));
  }
  return { outcomes, last };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('RambleWatcher prefilter (free)', () => {
  it('is off without watched members or without a ramble channel', async () => {
    expect(await harness({ userIds: [] }).watcher.observe(post(LONG, T0).message)).toBe('off');
    expect(await harness({ channelId: undefined }).watcher.observe(post(LONG, T0).message)).toBe('off');
  });

  it('never watches the ramble channel itself, or channels outside the watch list', async () => {
    const h = harness({ watchChannelIds: [MAIN, RAMBLE_CHANNEL] });
    expect(await h.watcher.observe(post(LONG, T0, { channelId: RAMBLE_CHANNEL }).message)).toBe('ignored');
    expect(await h.watcher.observe(post(LONG, T0, { channelId: 'clips-1' }).message)).toBe('ignored');
    expect(h.judge).not.toHaveBeenCalled();
  });

  it('asks the judge once the member posts RAMBLE_MIN_MESSAGES messages in a row', async () => {
    const h = harness({}, { ramble: false, confidence: 0.9 });
    const { outcomes } = await say(h, [LINE, `${LINE} again`, `${LINE} and again`]);
    expect(outcomes).toEqual(['below_rule', 'below_rule', 'not_ramble']);
    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.judge.mock.calls[0][0].run.map((m) => m.text)).toEqual([LINE, `${LINE} again`, `${LINE} and again`]);
  });

  it('needs them in a row: anyone else talking (the bot included) starts the count over', async () => {
    const h = harness();
    await say(h, [LINE, LINE]);
    h.clock.now += 5_000;
    await h.watcher.observe(post('lol what', h.clock.now, { authorId: KEV, authorDisplayName: 'Kev' }).message);
    expect((await say(h, [LINE, LINE], h.clock.now + 5_000)).outcomes).toEqual(['below_rule', 'below_rule']);
    h.clock.now += 5_000;
    const botReply = createFakeBotMessage({
      botUserId: BOT_ID,
      channelId: MAIN,
      content: 'bro',
      messageId: `b-${++counter}`,
      createdAt: new Date(h.clock.now),
    });
    expect(await h.watcher.observe(botReply.message)).toBe('ignored');
    expect((await say(h, [LINE, LINE], h.clock.now + 5_000)).outcomes).toEqual(['below_rule', 'below_rule']);
    expect(h.judge).not.toHaveBeenCalled();
  });

  it('lets other bots and webhook relays pass without counting or breaking the run', async () => {
    const h = harness();
    await say(h, [LINE, LINE]);
    h.clock.now += 1_000;
    const relay = post(`${LINE} https://fixvx.com/x/status/1`, h.clock.now, { webhookId: 'wh-1' });
    expect(await h.watcher.observe(relay.message)).toBe('ignored');
    const otherBot = post('daily recap', h.clock.now, { authorId: 'hermes', authorIsBot: true });
    expect(await h.watcher.observe(otherBot.message)).toBe('ignored');
    expect((await say(h, [LINE], h.clock.now + 1_000)).outcomes).toEqual(['nudged']);
  });

  it('only counts the run inside RAMBLE_WINDOW_SECONDS', async () => {
    const h = harness();
    await say(h, [LINE, LINE]);
    // Six minutes later: the first two are out of the window.
    expect((await say(h, [LINE], T0 + 6 * 60_000)).outcomes).toEqual(['below_rule']);
    expect((await say(h, [LINE, LINE], h.clock.now + 20_000)).outcomes).toEqual(['below_rule', 'nudged']);
  });

  it('does not spend a call on a run of one-word messages', async () => {
    const h = harness();
    expect((await say(h, ['lol', 'wait', 'what', 'no', 'bro'])).outcomes.every((o) => o === 'below_rule')).toBe(true);
    expect(h.judge).not.toHaveBeenCalled();
  });

  it('asks about one long message on its own, counting prose only (links and emoji markup are not prose)', async () => {
    const h = harness();
    expect(await h.watcher.observe(post(`https://example.com/${'a'.repeat(900)}`, T0).message)).toBe('below_rule');
    h.clock.now += 60_000;
    expect(await h.watcher.observe(post('<:kekw:123456789012345678> '.repeat(40), h.clock.now).message)).toBe(
      'below_rule',
    );
    h.clock.now += 60_000;
    const kev = post('what', h.clock.now, { authorId: KEV, authorDisplayName: 'Kev' });
    await h.watcher.observe(kev.message);
    h.clock.now += 1_000;
    expect(await h.watcher.observe(post(LONG, h.clock.now).message)).toBe('nudged');
    expect(h.judge.mock.calls[0][0].run).toEqual([{ text: LONG }]);
  });

  it('leaves the member alone while they are talking to the bot', async () => {
    const h = harness();
    await say(h, [LINE, LINE]);
    const toBot = post(`<@${BOT_ID}> ${LINE}`, h.clock.now + 5_000, { mentionedUserIds: [BOT_ID] });
    expect(await h.watcher.observe(toBot.message)).toBe('addressed_bot');
    const reply = post(LINE, h.clock.now + 6_000, { referencedMessageId: 'b-1', repliedUserId: BOT_ID });
    expect(await h.watcher.observe(reply.message)).toBe('addressed_bot');
    expect(h.judge).not.toHaveBeenCalled();
  });

  it("follows a member onto their side account (LINKED_ACCOUNTS): one run, one person, one cooldown", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${GUS_SIDE}:${GUS}`);
    const h = harness();
    await say(h, [LINE, LINE]);
    const side = { authorId: GUS_SIDE, authorDisplayName: 'gus alt' };
    expect((await say(h, [LINE], h.clock.now + 20_000, side)).outcomes).toEqual(['nudged']);
    // Nudged as the side account: the main account is in cooldown too.
    expect((await say(h, [LONG], h.clock.now + 60_000)).outcomes).toEqual(['cooldown']);
  });
});

describe('RambleWatcher judgement', () => {
  it('gives the judge the run, what came right before it, the examples and the member name', async () => {
    const h = harness();
    await h.watcher.observe(post('anyone up for ranked', T0 - 30_000, { authorId: KEV, authorDisplayName: 'Kev' }).message);
    await h.watcher.observe(
      createFakeBotMessage({
        botUserId: BOT_ID,
        channelId: MAIN,
        content: 'always',
        messageId: 'b-ctx',
        createdAt: new Date(T0 - 25_000),
      }).message,
    );
    await say(h, [LINE, `wait <@${KEV}> look`, 'pigeons are not real and never were'], T0, {
      mentionedUsers: [{ id: KEV, displayName: 'Kev' }],
    });

    const input = h.judge.mock.calls[0][0];
    expect(input.author).toBe('Gus');
    expect(input.run.map((m) => m.text)).toEqual([LINE, 'wait @Kev look', 'pigeons are not real and never were']);
    expect(input.before).toEqual([
      { author: 'Kev', text: 'anyone up for ranked' },
      { author: 'Frigidaire', text: 'always', self: true },
    ]);
    expect(input.examples).toBe(EXAMPLES);
    expect(h.examples).toHaveBeenCalledWith({ userId: GUS, rambleChannelId: RAMBLE_CHANNEL, normalChannelId: MAIN });
  });

  it('names who a message in the run replies to', async () => {
    const h = harness();
    await say(h, [LINE, LINE, LINE], T0, { referencedMessageId: 'k-1', repliedUserId: KEV, repliedUserDisplayName: 'Kev' });
    expect(h.judge.mock.calls[0][0].run[0]).toEqual({ text: LINE, replyTo: 'Kev' });
  });

  it('nudges once, without a ping, with a line pointing at the ramble channel', async () => {
    const h = harness();
    const { outcomes, last } = await say(h, [LINE, LINE, LINE]);
    expect(outcomes.at(-1)).toBe('nudged');
    expect(last.recorders.reply.calls).toEqual([
      [
        {
          content: RAMBLE_LINES[0].replaceAll('{channel}', `<#${RAMBLE_CHANNEL}>`),
          allowedMentions: { repliedUser: false },
          failIfNotExists: false,
        },
      ],
    ]);
    // Still going: cooldown, no second call.
    expect((await say(h, [LINE, LINE, LINE], h.clock.now + 20_000)).outcomes).toEqual([
      'cooldown',
      'cooldown',
      'cooldown',
    ]);
    expect(h.judge).toHaveBeenCalledTimes(1);
  });

  it('only nudges on a confident "ramble"', async () => {
    const unsure = harness({}, { ramble: true, confidence: 0.6 });
    expect((await say(unsure, [LINE, LINE, LINE])).outcomes.at(-1)).toBe('not_ramble');
    const normal = harness({}, { ramble: false, confidence: 0.95 });
    const { outcomes, last } = await say(normal, [LINE, LINE, LINE]);
    expect(outcomes.at(-1)).toBe('not_ramble');
    expect(last.recorders.reply.calls).toHaveLength(0);
  });

  it('fails closed when the judge has no answer or throws', async () => {
    const h = harness({}, null);
    expect((await say(h, [LINE, LINE, LINE])).outcomes.at(-1)).toBe('no_answer');

    const throwing = new RambleWatcher({
      settings: () => SETTINGS,
      judge: async () => {
        throw new Error('boom');
      },
      examples: () => EXAMPLES,
      now: () => T0,
    });
    const outcomes: RambleOutcome[] = [];
    for (let i = 0; i < 3; i++) outcomes.push(await throwing.observe(post(LINE, T0 + i * 1_000).message));
    expect(outcomes.at(-1)).toBe('no_answer');
  });

  it('judges zero-shot when the examples cannot be loaded', async () => {
    const h = harness();
    h.examples.mockImplementation(() => {
      throw new Error('archive gone');
    });
    expect((await say(h, [LINE, LINE, LINE])).outcomes.at(-1)).toBe('nudged');
    expect(h.judge.mock.calls[0][0].examples).toEqual({ rambles: [], ramblesAreTheirs: false, normal: [] });
  });

  it('after a "no", waits for two more messages, but judges a new long message right away', async () => {
    const h = harness({}, { ramble: false, confidence: 0.9 });
    const { outcomes } = await say(h, [LINE, LINE, LINE, LINE, LINE]);
    expect(outcomes).toEqual(['below_rule', 'below_rule', 'not_ramble', 'recheck_wait', 'not_ramble']);
    expect((await say(h, [LONG], h.clock.now + 20_000)).outcomes).toEqual(['not_ramble']);
    expect(h.judge).toHaveBeenCalledTimes(3);
  });

  it('asks once at a time per member and channel', async () => {
    let release: (verdict: RambleVerdict) => void = () => {};
    const judge = vi.fn(() => new Promise<RambleVerdict | undefined>((resolve) => (release = resolve)));
    const watcher = new RambleWatcher({
      settings: () => SETTINGS,
      judge,
      examples: () => EXAMPLES,
      cooldowns: createBotDbRambleCooldowns(),
      now: () => T0,
      random: () => 0,
    });
    await watcher.observe(post(LINE, T0 - 2_000).message);
    await watcher.observe(post(LINE, T0 - 1_000).message);
    const first = watcher.observe(post(LINE, T0).message);
    expect(await watcher.observe(post(LONG, T0 + 1_000).message)).toBe('checking');
    release({ ramble: true, confidence: 0.95 });
    expect(await first).toBe('nudged');
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('keeps the cooldown across a restart (bot.db) and after a failed send', async () => {
    const h = harness();
    const failing = { replyImpl: async () => Promise.reject(new Error('Missing Permissions')) };
    expect((await say(h, [LINE, LINE, LINE], T0, failing)).outcomes.at(-1)).toBe('nudge_failed');

    const restarted = harness();
    restarted.clock.now = T0 + 60 * 60_000;
    expect((await say(restarted, [LINE, LINE, LINE])).outcomes.at(-1)).toBe('cooldown');
    restarted.clock.now = T0 + 121 * 60_000;
    expect((await say(restarted, [LINE, LINE, LINE])).outcomes.at(-1)).toBe('nudged');
  });
});

describe('RambleWatcher and the gate', () => {
  it('does not judge a message the gate already handed to the agent', async () => {
    const routed = new Set<string>();
    const judge = vi.fn(async () => ({ ramble: true, confidence: 0.99 }));
    const watcher = new RambleWatcher({
      settings: () => SETTINGS,
      judge,
      examples: () => EXAMPLES,
      cooldowns: createBotDbRambleCooldowns(),
      now: () => T0,
      wasRouted: (message) => routed.has(message.id),
    });
    await watcher.observe(post(LINE, T0 - 2_000).message);
    await watcher.observe(post(LINE, T0 - 1_000).message);
    const named = post(`fridge ${LINE}`, T0);
    routed.add(named.message.id);

    expect(await watcher.observe(named.message)).toBe('addressed_bot');
    expect(judge).not.toHaveBeenCalled();
  });

  it('answers instead of nudging when the gate routes the message while the judge thinks', async () => {
    const routed = new Set<string>();
    let release: (verdict: RambleVerdict) => void = () => {};
    const watcher = new RambleWatcher({
      settings: () => SETTINGS,
      judge: () => new Promise<RambleVerdict | undefined>((resolve) => (release = resolve)),
      examples: () => EXAMPLES,
      cooldowns: createBotDbRambleCooldowns(),
      now: () => T0,
      wasRouted: (message) => routed.has(message.id),
    });
    await watcher.observe(post(LINE, T0 - 2_000).message);
    await watcher.observe(post(LINE, T0 - 1_000).message);
    const named = post(`fridge ${LINE}`, T0);
    const outcome = watcher.observe(named.message);
    routed.add(named.message.id); // the gate's decision lands first
    release({ ramble: true, confidence: 0.99 });

    expect(await outcome).toBe('addressed_bot');
    expect(named.recorders.reply.calls).toHaveLength(0);
    // No nudge happened, so no cooldown either.
    expect(createBotDbRambleCooldowns().lastNudgedAt(GUS)).toBeUndefined();
  });
});

describe('createBotDbRambleCooldowns', () => {
  it('still enforces the cooldown in memory when bot.db is unavailable', () => {
    const broken = new BotDb(':memory:');
    broken.close();
    setBotDbForTesting(broken);
    const cooldowns = createBotDbRambleCooldowns();

    expect(cooldowns.lastNudgedAt(GUS)).toBeUndefined();
    cooldowns.recordNudge(GUS, T0);
    expect(cooldowns.lastNudgedAt(GUS)).toBe(T0);
  });

  it('keeps the newest of the stored and remembered times', () => {
    const first = createBotDbRambleCooldowns();
    first.recordNudge(GUS, T0 + 5_000);
    const second = createBotDbRambleCooldowns();
    second.recordNudge(GUS, T0);
    // The second instance wrote an older time to the table, but remembers only its own; the first one
    // remembers the newer time it recorded.
    expect(first.lastNudgedAt(GUS)).toBe(T0 + 5_000);
    expect(second.lastNudgedAt(GUS)).toBe(T0);
  });
});

describe('RambleWatcher.pickLine', () => {
  it('picks with the injected RNG and never repeats the previous line', () => {
    const watcher = new RambleWatcher({
      settings: () => SETTINGS,
      judge: async () => undefined,
      examples: () => EXAMPLES,
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
