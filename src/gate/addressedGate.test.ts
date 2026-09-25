import type { Message } from 'discord.js';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  maxPer10Min: 4,
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
    expect(verdict).toEqual({ respond: true, trigger: 'name', probability: 0.7 });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet below the threshold ("fridge" as a refrigerator)', async () => {
    const { gate } = harness({}, 0.12);
    expect(await gate.evaluate(human('the beer is in the fridge').message)).toEqual({
      respond: false,
      reason: 'below_threshold',
      trigger: 'name',
      probability: 0.12,
    });
  });

  it('fails closed when the model gives no answer or the classifier throws', async () => {
    const { gate } = harness({}, null);
    expect(await gate.evaluate(human('fridge you there').message)).toEqual({
      respond: false,
      reason: 'no_answer',
      trigger: 'name',
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
});

describe('AddressedGate follow-ups', () => {
  it('treats the next message from whoever the bot just answered as a candidate', async () => {
    const { gate, classify } = harness();
    gate.noteBotMessage(botPost(T0 - 30_000, { repliedUserId: 'user-1' }));

    const verdict = await gate.evaluate(human('why tho').message);

    expect(verdict).toMatchObject({ respond: true, trigger: 'followup' });
    const input = classify.mock.calls[0][0];
    expect(input.secondsSinceBotSpoke).toBe(30);
    expect(input.authorIsBotsPartner).toBe(true);
  });

  it('reports name+followup when both apply', async () => {
    const { gate } = harness();
    gate.noteBotMessage(botPost(T0 - 10_000, { repliedUserId: 'user-1' }));
    expect(await gate.evaluate(human('fridge why tho').message)).toMatchObject({ trigger: 'name+followup' });
  });

  it('is not a follow-up for someone else, after the window, or with the rule disabled', async () => {
    const { gate, classify } = harness();
    gate.noteBotMessage(botPost(T0 - 30_000, { repliedUserId: 'user-1' }));
    expect((await gate.evaluate(human('why tho', { authorId: 'user-2' }).message)).respond).toBe(false);
    expect((await gate.evaluate(human('why tho', { at: T0 + 91_000 }).message)).respond).toBe(false);

    const off = harness({ followupSeconds: 0 });
    off.gate.noteBotMessage(botPost(T0 - 30_000, { repliedUserId: 'user-1' }));
    expect(await off.gate.evaluate(human('why tho').message)).toEqual({ respond: false, reason: 'no_trigger' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('ignores bot posts in channels the gate does not watch', async () => {
    const { gate } = harness();
    gate.noteBotMessage(botPost(T0 - 30_000, { repliedUserId: 'user-1', channelId: 'other' }));
    expect((await gate.evaluate(human('why tho').message)).respond).toBe(false);
  });

  it("uses the routed turn's author when the bot's answer was a plain send (the original got deleted)", async () => {
    const { gate, clock } = harness();
    const question = human('<@bot-1> best jinx build?', { at: T0 - 40_000 }).message;
    clock.now = T0 - 40_000;
    gate.noteRouted(question);
    clock.now = T0 - 30_000;
    gate.noteBotMessage(botPost(T0 - 30_000)); // no repliedUser: fell back to channel.send
    gate.noteTurnDone(question);

    expect(await gate.evaluate(human('what about vs ksante').message)).toMatchObject({
      respond: true,
      trigger: 'followup',
    });
  });

  it('stops standing in for plain bot posts shortly after the routed turn ends', async () => {
    const { gate, clock } = harness();
    const question = human('<@bot-1> best jinx build?', { at: T0 - 120_000 }).message;
    clock.now = T0 - 120_000;
    gate.noteRouted(question);
    clock.now = T0 - 100_000;
    gate.noteBotMessage(botPost(T0 - 100_000, { repliedUserId: 'user-1' }));
    gate.noteTurnDone(question);

    // A minute later the bot posts something that answers nobody (a reminder, a digest).
    clock.now = T0 - 30_000;
    gate.noteBotMessage(botPost(T0 - 30_000, { content: 'reminder: gym at 6' }));

    expect(await gate.evaluate(human('ok').message)).toEqual({ respond: false, reason: 'no_trigger' });
  });

  it('only lets a routed turn stand in for a bounded time while it runs', async () => {
    const { gate, clock } = harness();
    clock.now = T0 - 400_000;
    gate.noteRouted(human('<@bot-1> think hard about this', { at: T0 - 400_000 }).message);
    clock.now = T0 - 30_000; // over 5 minutes later, turn never reported done
    gate.noteBotMessage(botPost(T0 - 30_000));
    expect((await gate.evaluate(human('so?').message)).respond).toBe(false);
  });

  it('skips a follow-up with nothing to read', async () => {
    const { gate, classify } = harness();
    gate.noteBotMessage(botPost(T0 - 5_000, { repliedUserId: 'user-1' }));
    expect(await gate.evaluate(human('').message)).toEqual({ respond: false, reason: 'no_text', trigger: 'followup' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('describes attachments so an image-only follow-up still has something to judge', async () => {
    const { gate, classify } = harness();
    gate.noteBotMessage(botPost(T0 - 5_000, { repliedUserId: 'user-1' }));
    await gate.evaluate(
      human('', { attachments: [{ url: 'https://cdn.example/a.png', contentType: 'image/png', name: 'a.png' }] })
        .message,
    );
    expect(classify.mock.calls[0][0].message.text).toBe('[image]');
  });
});

describe('AddressedGate rate limit', () => {
  it('allows GATE_MAX_PER_10MIN unsolicited replies per channel, then skips without calling the model', async () => {
    const { gate, classify, clock } = harness({ maxPer10Min: 2 });
    expect((await gate.evaluate(human('fridge one').message)).respond).toBe(true);
    clock.now += 60_000;
    expect((await gate.evaluate(human('fridge two').message)).respond).toBe(true);
    clock.now += 60_000;
    expect(await gate.evaluate(human('fridge three').message)).toEqual({
      respond: false,
      reason: 'rate_limited',
      trigger: 'name',
    });
    expect(classify).toHaveBeenCalledTimes(2);

    // Another channel has its own budget.
    const elsewhere = harness({ maxPer10Min: 2, channelIds: [CHANNEL, 'main-2'] });
    expect((await elsewhere.gate.evaluate(human('fridge hi', { channelId: 'main-2' }).message)).respond).toBe(true);

    // Ten minutes after the first reply, a slot frees up.
    clock.now = T0 + 10 * 60_000 + 1;
    expect((await gate.evaluate(human('fridge four').message)).respond).toBe(true);
  });

  it('does not count skipped decisions against the budget', async () => {
    const { gate } = harness({ maxPer10Min: 1 }, 0.2);
    for (let i = 0; i < 3; i++) {
      expect(await gate.evaluate(human(`the fridge is empty ${i}`).message)).toMatchObject({ reason: 'below_threshold' });
    }
  });

  it('re-checks the limit after the (slow) decision so concurrent candidates cannot overshoot it', async () => {
    const { gate } = harness({ maxPer10Min: 1 });
    const verdicts = await Promise.all([
      gate.evaluate(human('fridge a').message),
      gate.evaluate(human('fridge b').message),
    ]);
    expect(verdicts.filter((v) => v.respond)).toHaveLength(1);
    expect(verdicts.find((v) => !v.respond)).toMatchObject({ reason: 'rate_limited', probability: 0.9 });
  });

  it('never replies unprompted with a limit of 0', async () => {
    const { gate, classify } = harness({ maxPer10Min: 0 });
    expect(await gate.evaluate(human('fridge hi').message)).toMatchObject({ reason: 'rate_limited' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('an unsolicited reply makes its author the pending partner for plain sends', async () => {
    const { gate, clock } = harness();
    const addressed = human('fridge who wins worlds', { at: T0 - 20_000 }).message;
    clock.now = T0 - 20_000;
    expect((await gate.evaluate(addressed)).respond).toBe(true);
    gate.noteBotMessage(botPost(T0 - 10_000));
    clock.now = T0;
    expect(await gate.evaluate(human('T1 no way').message)).toMatchObject({ respond: true, trigger: 'followup' });
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
