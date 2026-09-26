import type { Message } from 'discord.js';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSCRIPT_HEADER } from '../ai/media/autoTranscribe';
import { rememberTranscriptReply } from '../ai/media/store';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import type { AddressedInput } from './addressed';
import { AddressedGate, type GateSettings, renderMessageText } from './addressedGate';

const BOT_ID = 'bot-1';
const CHANNEL = 'main-1';
const T0 = Date.parse('2026-09-25T18:00:00Z');

const SETTINGS: GateSettings = {
  enabled: true,
  channelIds: [CHANNEL],
  names: ['fridge', 'frigidaire', 'frigi', 'bot', 'clanker'],
  followupSeconds: 120,
  maxPer10Min: 30,
  maxColdPer10Min: 6,
  threshold: 0.7,
};

type Harness = {
  gate: AddressedGate;
  classify: Mock<(input: AddressedInput) => Promise<number | undefined>>;
  clock: { now: number };
  settings: GateSettings;
};

/** `answer: null` = the model gives no answer. */
function harness(overrides: Partial<GateSettings> = {}, answer: number | null = 0.9): Harness {
  const clock = { now: T0 };
  const settings = { ...SETTINGS, ...overrides };
  const classify = vi.fn<(input: AddressedInput) => Promise<number | undefined>>(async () => answer ?? undefined);
  const gate = new AddressedGate({ classify, settings: () => settings, now: () => clock.now });
  return { gate, classify, clock, settings };
}

let messageCounter = 0;

/** A human message in the gate's channel at `at` (defaults to T0). */
function human(content: string, opts: FakeMessageOptions & { at?: number } = {}) {
  const { at, ...rest } = opts;
  return createFakeMessage({
    content,
    botUserId: BOT_ID,
    channelId: CHANNEL,
    messageId: `m-${++messageCounter}`,
    authorId: 'user-1',
    authorDisplayName: 'Marco',
    createdAt: new Date(at ?? T0),
    ...rest,
  });
}

/** One of the bot's own posts (a reply to `repliedUserId` when given). */
function botPost(at: number, opts: FakeMessageOptions = {}): Message {
  return createFakeBotMessage({
    content: 'kraken into ie',
    botUserId: BOT_ID,
    channelId: CHANNEL,
    messageId: `b-${++messageCounter}`,
    createdAt: new Date(at),
    ...opts,
  }).message;
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.restoreAllMocks();
});

describe('AddressedGate prefilter (free checks, no API call)', () => {
  it('does nothing when disabled', async () => {
    const { gate, classify } = harness({ enabled: false });
    expect(await gate.evaluate(human('fridge who wins worlds').message)).toEqual({ respond: false, reason: 'disabled' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('only watches the configured channels (none configured ⇒ gate off)', async () => {
    const { gate, classify } = harness();
    const elsewhere = human('fridge who wins worlds', { channelId: 'clips-1' });
    expect(await gate.evaluate(elsewhere.message)).toEqual({ respond: false, reason: 'not_watched' });

    const off = harness({ channelIds: [] });
    expect(await off.gate.evaluate(human('fridge who wins worlds').message)).toEqual({
      respond: false,
      reason: 'not_watched',
    });
    expect(classify).not.toHaveBeenCalled();
    expect(off.classify).not.toHaveBeenCalled();
  });

  it('ignores other bots and webhook posts', async () => {
    const { gate, classify } = harness();
    expect((await gate.evaluate(human('fridge hi', { authorIsBot: true, authorId: 'hermes' }).message)).respond).toBe(
      false,
    );
    const relay = human('fridge look at this https://fixvx.com/x/status/1', { webhookId: 'wh-1' });
    expect(await gate.evaluate(relay.message)).toEqual({ respond: false, reason: 'not_human' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('skips a plain message that neither names the bot nor follows up on it, without fetching history', async () => {
    const { gate, classify } = harness();
    const fake = human('who is playing tonight');
    expect(await gate.evaluate(fake.message)).toEqual({ respond: false, reason: 'no_trigger' });
    expect(classify).not.toHaveBeenCalled();
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });

  it('matches names as whole words only, and not inside links or emoji markup', async () => {
    const { gate, classify } = harness();
    for (const text of [
      'the refrigerator is broken',
      'botlane is so weak this patch',
      'check https://example.com/fridge-deals',
      'lmao <:clanker:123456789012345678>',
    ]) {
      expect(await gate.evaluate(human(text).message)).toEqual({ respond: false, reason: 'no_trigger' });
    }
    expect(classify).not.toHaveBeenCalled();
  });

  it("always counts the bot's own display name, even when GATE_NAMES leaves it out", async () => {
    const { gate, classify } = harness({ names: ['clanker'] });
    const verdict = await gate.evaluate(human('Frigidaire what do you think').message);
    expect(verdict).toMatchObject({ respond: true, trigger: 'name' });
    expect(classify).toHaveBeenCalledTimes(1);
  });
});

describe('AddressedGate decision', () => {
  it('answers a name-addressed message the model scores at or above the threshold', async () => {
    const { gate, classify } = harness({}, 0.7);
    const verdict = await gate.evaluate(human('yo fridge who wins worlds').message);
    expect(verdict).toEqual({ respond: true, trigger: 'name', probability: 0.7, cold: true });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet below the threshold ("fridge" as a refrigerator)', async () => {
    const { gate } = harness({}, 0.12);
    expect(await gate.evaluate(human('the beer is in the fridge').message)).toEqual({
      respond: false,
      reason: 'below_threshold',
      trigger: 'name',
      probability: 0.12,
      cold: true,
    });
  });

  it('fails closed when the model gives no answer or the classifier throws', async () => {
    const { gate } = harness({}, null);
    expect(await gate.evaluate(human('fridge you there').message)).toEqual({
      respond: false,
      reason: 'no_answer',
      trigger: 'name',
      cold: true,
    });

    const throwing = new AddressedGate({
      classify: async () => {
        throw new Error('boom');
      },
      settings: () => SETTINGS,
      now: () => T0,
    });
    expect(await throwing.evaluate(human('fridge you there').message)).toMatchObject({
      respond: false,
      reason: 'no_answer',
    });
  });

  it('gives the model the message, recent chat (bot and other bots marked, relays attributed) and names', async () => {
    const { gate, classify } = harness();
    const history = [
      human('worlds draw just dropped', { at: T0 - 60_000, authorId: 'user-2', authorDisplayName: 'Kev' }).message,
      botPost(T0 - 50_000, { content: 'T1 again lol', repliedUserId: 'user-2' }),
      createFakeMessage({
        content: 'daily recap: 412 messages',
        authorId: 'hermes',
        authorDisplayName: 'Hermes',
        authorIsBot: true,
        channelId: CHANNEL,
        messageId: 'h-1',
        createdAt: new Date(T0 - 40_000),
      }).message,
    ];
    // Out of order on purpose: Discord returns newest first.
    const fake = human('fridge who wins worlds', { historyMessages: [...history].reverse() });

    await gate.evaluate(fake.message);

    expect(fake.recorders.messagesFetch.calls[0]).toEqual([{ limit: 6, before: fake.message.id }]);
    const input = classify.mock.calls[0][0];
    expect(input.botName).toBe('Frigidaire');
    expect(input.nicknames).toEqual(SETTINGS.names);
    expect(input.message).toEqual({ author: 'Marco', text: 'fridge who wins worlds', replyTo: undefined });
    expect(input.context).toEqual([
      { author: 'Kev', text: 'worlds draw just dropped' },
      { author: 'Frigidaire', kind: 'self', text: 'T1 again lol' },
      { author: 'Hermes', kind: 'other_bot', text: 'daily recap: 412 messages' },
    ]);
    // Nothing tracked yet, so the timing is read off the fetched history: the bot answered Kev, not Marco.
    expect(input.secondsSinceBotSpoke).toBe(50);
    expect(input.authorIsBotsPartner).toBe(false);
  });

  it("doesn't read its voice-message transcripts off the history as the bot speaking to their author", async () => {
    const { gate, classify } = harness();
    const history = [
      human('', { at: T0 - 60_000, authorId: 'user-1', authorDisplayName: 'Marco' }).message,
      botPost(T0 - 55_000, { content: '-# 🎙️ transcript\n> on joue ce soir?', repliedUserId: 'user-1' }),
    ];
    const fake = human('fridge on joue ou pas', { historyMessages: [...history].reverse() });

    await gate.evaluate(fake.message);

    const input = classify.mock.calls[0][0];
    expect(input.secondsSinceBotSpoke).toBeUndefined();
    expect(input.authorIsBotsPartner).toBe(false);
  });

  it('still decides (without context) when the history fetch fails', async () => {
    const { gate, classify } = harness();
    const fake = human('fridge help');
    (fake.message.channel as unknown as { messages: { fetch: () => Promise<never> } }).messages.fetch = async () => {
      throw new Error('Missing Access');
    };

    expect((await gate.evaluate(fake.message)).respond).toBe(true);
    expect(classify.mock.calls[0][0].context).toEqual([]);
  });

  it('names who a Discord reply points at', async () => {
    const { gate, classify } = harness();
    await gate.evaluate(
      human('fridge tell theo he is wrong', {
        referencedMessageId: 'ref-1',
        repliedUserId: 'user-3',
        mentionedUsers: [{ id: 'user-3', displayName: 'Theo' }],
      }).message,
    );
    expect(classify.mock.calls[0][0].message.replyTo).toBe('Theo');
  });

  it("doesn't pass the bot's voice-message transcripts off as the bot talking", async () => {
    const { gate, classify } = harness();
    const voice = human('', {
      at: T0 - 60_000,
      ...KEV,
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg', contentType: 'audio/ogg' }],
    }).message;
    const transcript = botPost(T0 - 55_000, { content: `${TRANSCRIPT_HEADER}\n> fridge is washed`, repliedUserId: KEV.authorId });
    const stored = botPost(T0 - 50_000, { content: '> and so is everyone else', repliedUserId: KEV.authorId });
    rememberTranscriptReply(stored.id, voice.id);
    // Kev's voice message, its transcript in two parts, then Marco replies to the transcript (ping on).
    const fake = human('fridge lmaooo he really said that', {
      historyMessages: [stored, transcript, voice],
      referencedMessageId: transcript.id,
      repliedUserId: BOT_ID,
      replyPinged: true,
      cachedMessages: [transcript],
    });

    await gate.evaluate(fake.message);

    const input = classify.mock.calls[0][0];
    expect(input.message.replyTo).toBe('a voice message');
    expect(input.context).toEqual([{ author: 'Kev', text: '[voice message]' }]);
    // Nothing the bot said is in the history: the transcripts don't count as it speaking.
    expect(input.secondsSinceBotSpoke).toBeUndefined();
    expect(input.authorIsBotsPartner).toBe(false);
  });
});

/**
 * The bot answered `author` here: a routed turn (explicit mention/reply) for a message by them at `at`,
 * the bot's post a few seconds later, and the turn finishing right after.
 */
function answered(h: Harness, at: number, author: FakeMessageOptions = {}): void {
  const question = human('<@bot-1> quick one', { at, ...author }).message;
  h.clock.now = at;
  h.gate.noteRouted(question);
  h.clock.now = at + 5_000;
  const where = author.channelId ? { channelId: author.channelId } : {};
  h.gate.noteBotMessage(botPost(at + 5_000, { repliedUserId: author.authorId ?? 'user-1', ...where }));
  h.gate.noteTurnDone(question);
}

const KEV = { authorId: 'user-2', authorDisplayName: 'Kev' };
const THEO = { authorId: 'user-3', authorDisplayName: 'Theo' };

describe('AddressedGate exchanges (follow-ups without a name)', () => {
  it('treats the next message from whoever the bot just answered as a candidate', async () => {
    const h = harness();
    answered(h, T0 - 35_000);
    h.clock.now = T0;

    const verdict = await h.gate.evaluate(human('why tho').message);

    expect(verdict).toEqual({ respond: true, trigger: 'followup', probability: 0.9, cold: false });
    const input = h.classify.mock.calls[0][0];
    expect(input.secondsSinceBotSpoke).toBe(30);
    expect(input.authorIsBotsPartner).toBe(true);
  });

  it('reports name+followup when both apply', async () => {
    const h = harness();
    answered(h, T0 - 15_000);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('fridge why tho').message)).toMatchObject({ trigger: 'name+followup' });
  });

  it('every member the bot exchanged with during the exchange is a partner, not only the last one', async () => {
    const h = harness();
    answered(h, T0 - 60_000); // Marco
    answered(h, T0 - 20_000, KEV);
    h.clock.now = T0;

    expect(await h.gate.evaluate(human('why tho').message)).toMatchObject({ respond: true, trigger: 'followup' });
    expect(await h.gate.evaluate(human('nah that is wrong', KEV).message)).toMatchObject({
      respond: true,
      trigger: 'followup',
    });
    // Theo never talked to the bot: without a name it's just chat.
    expect(await h.gate.evaluate(human('who wants food', THEO).message)).toEqual({
      respond: false,
      reason: 'no_trigger',
    });
  });

  it('slides: each answer extends the exchange, which keeps its earlier partners', async () => {
    const h = harness();
    answered(h, T0); // Marco, done at T0+5s
    answered(h, T0 + 100_000, KEV); // done at T0+105s: the exchange now runs to T0+225s
    h.clock.now = T0 + 200_000;
    // Marco's own answer was 195 s ago, past GATE_FOLLOWUP_SECONDS, but the exchange is still going.
    expect(await h.gate.evaluate(human('ok but why', { at: h.clock.now }).message)).toMatchObject({
      respond: true,
      trigger: 'followup',
    });

    const later = harness();
    answered(later, T0);
    answered(later, T0 + 100_000, KEV);
    later.clock.now = T0 + 226_000; // 121 s after the last answer: over
    expect(await later.gate.evaluate(human('ok but why', { at: later.clock.now }).message)).toEqual({
      respond: false,
      reason: 'no_trigger',
    });
  });

  it('forgets the partners once an exchange lapses, even if a new one starts', async () => {
    const h = harness();
    answered(h, T0); // Marco
    answered(h, T0 + 300_000, KEV); // a new exchange, Kev only
    h.clock.now = T0 + 310_000;

    expect(await h.gate.evaluate(human('why tho', { at: h.clock.now }).message)).toEqual({
      respond: false,
      reason: 'no_trigger',
    });
    expect(await h.gate.evaluate(human('why tho', { at: h.clock.now, ...KEV }).message)).toMatchObject({
      respond: true,
    });
  });

  it('counts the author of a turn still being answered as a partner (a second thought mid-turn)', async () => {
    const h = harness();
    h.gate.noteRouted(human('<@bot-1> best jinx build?', { at: T0 - 3_000 }).message);

    expect(await h.gate.evaluate(human('vs ksante i mean').message)).toMatchObject({
      respond: true,
      trigger: 'followup',
      cold: false,
    });
  });

  it('keeps counting a turn that is still running after 15 minutes (a long run_code call)', async () => {
    const h = harness();
    h.clock.now = T0 - 15 * 60_000;
    h.gate.noteRouted(human('<@bot-1> crunch this dataset', { at: h.clock.now }).message);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('also add a chart').message)).toMatchObject({
      respond: true,
      trigger: 'followup',
      cold: false,
    });
  });

  it('stops counting a turn that never reports back after 20 minutes', async () => {
    const h = harness();
    h.clock.now = T0 - 20 * 60_000 - 1_000;
    h.gate.noteRouted(human('<@bot-1> think hard about this', { at: h.clock.now }).message);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('so?').message)).toEqual({ respond: false, reason: 'no_trigger' });
  });

  it("still counts a slow turn's answer when it reports back after those 20 minutes", async () => {
    const h = harness();
    // Queued behind other turns, then two long runs: the answer lands 21 minutes after the ping.
    const slow = human('<@bot-1> run the numbers both ways', { at: T0 - 21 * 60_000 }).message;
    h.clock.now = T0 - 21 * 60_000;
    h.gate.noteRouted(slow);
    // Meanwhile the channel state is read (someone else's message), which drops the stale turn.
    h.clock.now = T0 - 30_000;
    expect(await h.gate.evaluate(human('lol', { at: h.clock.now, ...KEV }).message)).toEqual({
      respond: false,
      reason: 'no_trigger',
    });
    expect(h.gate.isInExchange(CHANNEL, 'user-1')).toBe(false);

    h.clock.now = T0 - 10_000;
    h.gate.noteTurnDone(slow);
    expect(h.gate.isInExchange(CHANNEL, 'user-1')).toBe(true);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('ok and?').message)).toMatchObject({
      respond: true,
      trigger: 'followup',
      cold: false,
    });
  });

  it('a bot post that answers nobody (a ramble nudge, a transcript, a reminder) starts no exchange', async () => {
    const h = harness();
    // The nudge is a Discord reply to Marco, but no turn was routed: it is not a conversation.
    h.gate.noteBotMessage(botPost(T0 - 10_000, { content: 'this is a #rambles moment', repliedUserId: 'user-1' }));

    expect(await h.gate.evaluate(human('i am NOT rambling').message)).toEqual({ respond: false, reason: 'no_trigger' });
    // Naming the bot still works, and the decision still hears that the bot just spoke.
    expect(await h.gate.evaluate(human('fridge i am NOT rambling').message)).toMatchObject({
      respond: true,
      trigger: 'name',
      cold: true,
    });
    expect(h.classify.mock.calls[0][0]).toMatchObject({ secondsSinceBotSpoke: 10, authorIsBotsPartner: false });
  });

  it("continues an exchange from a member's side account (LINKED_ACCOUNTS)", async () => {
    const MAIN = '100000000000000001';
    const SIDE = '200000000000000001';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    try {
      const h = harness();
      answered(h, T0 - 30_000, { authorId: MAIN });
      h.clock.now = T0;
      expect(await h.gate.evaluate(human('also this', { authorId: SIDE }).message)).toMatchObject({
        respond: true,
        trigger: 'followup',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores turns and bot posts in channels the gate does not watch', async () => {
    const h = harness();
    answered(h, T0 - 30_000, { channelId: 'other' });
    h.clock.now = T0;
    expect((await h.gate.evaluate(human('why tho').message)).respond).toBe(false);
  });

  it('has no exchanges at all with GATE_FOLLOWUP_SECONDS=0 (every name-drop is cold)', async () => {
    const h = harness({ followupSeconds: 0 });
    answered(h, T0 - 30_000);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('why tho').message)).toEqual({ respond: false, reason: 'no_trigger' });
    expect(await h.gate.evaluate(human('fridge why tho').message)).toMatchObject({ trigger: 'name', cold: true });
  });

  it('makes the author of a message the gate routed a partner', async () => {
    const h = harness();
    const addressed = human('fridge who wins worlds', { at: T0 - 20_000 }).message;
    h.clock.now = T0 - 20_000;
    expect(await h.gate.evaluate(addressed)).toMatchObject({ respond: true, cold: true });
    h.clock.now = T0 - 10_000;
    h.gate.noteTurnDone(addressed);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('T1 no way').message)).toMatchObject({
      respond: true,
      trigger: 'followup',
      cold: false,
    });
  });

  it('skips a follow-up with nothing to read', async () => {
    const h = harness();
    answered(h, T0 - 10_000);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('').message)).toEqual({
      respond: false,
      reason: 'no_text',
      trigger: 'followup',
      cold: false,
    });
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('describes attachments so an image-only follow-up still has something to judge', async () => {
    const h = harness();
    answered(h, T0 - 10_000);
    h.clock.now = T0;
    await h.gate.evaluate(
      human('', { attachments: [{ url: 'https://cdn.example/a.png', contentType: 'image/png', name: 'a.png' }] })
        .message,
    );
    expect(h.classify.mock.calls[0][0].message.text).toBe('[image]');
  });
});

describe('AddressedGate.wasRouted', () => {
  it('remembers which messages were handed to the agent (explicit or by the gate), in any channel', async () => {
    const h = harness();
    const pinged = human('<@bot-1> yo', { channelId: 'not-a-gate-channel' }).message;
    const named = human('fridge who wins worlds').message;
    const plain = human('who is playing tonight', KEV).message; // not in the exchange, names nobody
    h.gate.noteRouted(pinged);
    await h.gate.evaluate(named);
    await h.gate.evaluate(plain);

    expect(h.gate.wasRouted(pinged.id)).toBe(true);
    expect(h.gate.wasRouted(named.id)).toBe(true);
    expect(h.gate.wasRouted(plain.id)).toBe(false);
  });

  it('forgets the oldest ids past a few hundred', () => {
    const h = harness();
    const first = human('<@bot-1> first').message;
    h.gate.noteRouted(first);
    for (let i = 0; i < 200; i++) h.gate.noteRouted(human(`<@bot-1> ${i}`).message);
    expect(h.gate.wasRouted(first.id)).toBe(false);
  });
});

describe('AddressedGate.isInExchange (asked by auto-react)', () => {
  it('is true for every partner of the active exchange, and only while it lasts', () => {
    const h = harness();
    answered(h, T0 - 60_000); // user-1
    answered(h, T0 - 20_000, KEV);
    h.clock.now = T0;
    expect(h.gate.isInExchange(CHANNEL, 'user-1')).toBe(true);
    expect(h.gate.isInExchange(CHANNEL, KEV.authorId)).toBe(true);
    expect(h.gate.isInExchange(CHANNEL, THEO.authorId)).toBe(false);
    expect(h.gate.isInExchange('clips-1', 'user-1')).toBe(false);

    // GATE_FOLLOWUP_SECONDS after the last answer (T0-15s), the exchange and its partners are over.
    h.clock.now = T0 + 106_000;
    expect(h.gate.isInExchange(CHANNEL, KEV.authorId)).toBe(false);
    expect(h.gate.isInExchange(CHANNEL, 'user-1')).toBe(false);
  });

  it('counts a turn still being answered, and a side account as its member', () => {
    vi.stubEnv('LINKED_ACCOUNTS', '100000000000000002:100000000000000001');
    try {
      const h = harness();
      h.gate.noteRouted(human('<@bot-1> thoughts?', { authorId: '100000000000000001' }).message);
      expect(h.gate.isInExchange(CHANNEL, '100000000000000002')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is false when the gate is off or not watching the channel', () => {
    const off = harness({ enabled: false });
    answered(off, T0 - 10_000);
    off.clock.now = T0;
    expect(off.gate.isInExchange(CHANNEL, 'user-1')).toBe(false);
    const noFollowups = harness({ followupSeconds: 0 });
    answered(noFollowups, T0 - 10_000);
    noFollowups.clock.now = T0;
    expect(noFollowups.gate.isInExchange(CHANNEL, 'user-1')).toBe(false);
  });
});

describe('AddressedGate caps', () => {
  it('caps cold name-drops at GATE_MAX_COLD_PER_10MIN per channel, without calling the model', async () => {
    // No follow-up window: every name-drop is cold.
    const { gate, classify, clock } = harness({ followupSeconds: 0, maxColdPer10Min: 2 });
    expect(await gate.evaluate(human('fridge one').message)).toMatchObject({ respond: true, cold: true });
    clock.now += 60_000;
    expect((await gate.evaluate(human('fridge two').message)).respond).toBe(true);
    clock.now += 60_000;
    expect(await gate.evaluate(human('fridge three').message)).toEqual({
      respond: false,
      reason: 'cold_limited',
      trigger: 'name',
      cold: true,
    });
    expect(classify).toHaveBeenCalledTimes(2);

    // Another channel has its own budget.
    const elsewhere = harness({ followupSeconds: 0, maxColdPer10Min: 2, channelIds: [CHANNEL, 'main-2'] });
    expect((await elsewhere.gate.evaluate(human('fridge hi', { channelId: 'main-2' }).message)).respond).toBe(true);

    // Ten minutes after the first reply, a slot frees up.
    clock.now = T0 + 10 * 60_000 + 1;
    expect((await gate.evaluate(human('fridge four').message)).respond).toBe(true);
  });

  it('a name-drop after the exchange lapsed is cold again', async () => {
    const h = harness({ maxColdPer10Min: 1 });
    const first = human('fridge one').message;
    expect(await h.gate.evaluate(first)).toMatchObject({ respond: true, cold: true });
    h.clock.now = T0 + 5_000;
    h.gate.noteTurnDone(first);
    h.clock.now = T0 + 130_000; // 125 s after the answer: the exchange is over
    expect(await h.gate.evaluate(human('fridge two', { at: h.clock.now }).message)).toEqual({
      respond: false,
      reason: 'cold_limited',
      trigger: 'name',
      cold: true,
    });
  });

  it('does not cap a burst: during an exchange only the runaway guard applies', async () => {
    const h = harness({ maxColdPer10Min: 1, maxPer10Min: 5 });
    answered(h, T0 - 10_000);
    for (let i = 0; i < 5; i++) {
      h.clock.now = T0 + i * 30_000;
      const followup = human(`and ${i}?`, { at: h.clock.now }).message;
      expect(await h.gate.evaluate(followup)).toMatchObject({ respond: true, cold: false });
      h.clock.now += 5_000;
      h.gate.noteTurnDone(followup);
    }
    h.clock.now = T0 + 5 * 30_000;
    expect(await h.gate.evaluate(human('and one more', { at: h.clock.now }).message)).toEqual({
      respond: false,
      reason: 'rate_limited',
      trigger: 'followup',
      cold: false,
    });
  });

  it('never counts explicit mentions and replies against any cap', async () => {
    const h = harness({ maxPer10Min: 1, maxColdPer10Min: 1 });
    for (let i = 0; i < 10; i++) answered(h, T0 + i * 10_000);
    h.clock.now = T0 + 100_000;
    expect(await h.gate.evaluate(human('why tho', { at: h.clock.now }).message)).toMatchObject({ respond: true });
  });

  it('does not count skipped decisions against the budget', async () => {
    const { gate } = harness({ maxPer10Min: 1, maxColdPer10Min: 1 }, 0.2);
    for (let i = 0; i < 3; i++) {
      expect(await gate.evaluate(human(`the fridge is empty ${i}`).message)).toMatchObject({ reason: 'below_threshold' });
    }
  });

  it('re-checks the caps after the (slow) decision so concurrent candidates cannot overshoot them', async () => {
    const { gate } = harness({ maxColdPer10Min: 1 });
    const verdicts = await Promise.all([
      gate.evaluate(human('fridge a').message),
      gate.evaluate(human('fridge b').message),
    ]);
    expect(verdicts.filter((v) => v.respond)).toHaveLength(1);
    expect(verdicts.find((v) => !v.respond)).toMatchObject({ reason: 'cold_limited', probability: 0.9 });
  });

  it('never replies unprompted with GATE_MAX_PER_10MIN=0', async () => {
    const h = harness({ maxPer10Min: 0 });
    answered(h, T0 - 10_000);
    h.clock.now = T0;
    expect(await h.gate.evaluate(human('fridge hi').message)).toMatchObject({ reason: 'rate_limited' });
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('with GATE_MAX_COLD_PER_10MIN=0 it only ever joins exchanges someone started with a mention', async () => {
    const h = harness({ maxColdPer10Min: 0 });
    expect(await h.gate.evaluate(human('fridge hi').message)).toMatchObject({ reason: 'cold_limited' });
    answered(h, T0 + 10_000, KEV);
    h.clock.now = T0 + 20_000;
    expect(await h.gate.evaluate(human('fridge hi', { at: h.clock.now }).message)).toMatchObject({
      respond: true,
      trigger: 'name',
      cold: false,
    });
  });
});

describe('renderMessageText', () => {
  it('renders mentions, emojis, stickers and files readably', () => {
    const { message } = createFakeMessage({
      content: 'yo <@123456789012345678> look <:kekw:123456789012345679>',
      mentionedUsers: [{ id: '123456789012345678', displayName: 'Kev' }],
      stickers: [{ id: 's1', name: 'pepe', format: 1 }],
      attachments: [
        { url: 'https://cdn.example/v.mp4', contentType: 'video/mp4', name: 'v.mp4' },
        { url: 'https://cdn.example/voice.ogg', contentType: 'audio/ogg', name: 'voice-message.ogg' },
        { url: 'https://cdn.example/notes.txt', contentType: 'text/plain', name: 'notes.txt' },
      ],
    });
    expect(renderMessageText(message, BOT_ID, 'Frigidaire')).toBe(
      'yo @Kev look :kekw: [video] [voice message] [file: notes.txt] [sticker: pepe]',
    );
  });

  it("names the bot when it is mentioned, and falls back to a link preview's title for a bare embed", () => {
    const { message } = createFakeMessage({ content: '', embeds: [{ title: 'Faker retires (not clickbait)' }] });
    expect(renderMessageText(message, BOT_ID, 'Frigidaire')).toBe('[link preview: Faker retires (not clickbait)]');
    const ping = createFakeMessage({ content: 'hey <@123456789012345670>' });
    expect(renderMessageText(ping.message, '123456789012345670', 'Frigidaire')).toBe('hey @Frigidaire');
  });
});
