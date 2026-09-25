import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { FEATURE_HEADER } from '../ai/usage';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createPostableChannel, createSchedulingClient } from '../test-support/fakeScheduling';
import {
  BirthdayAnnouncer,
  type BirthdayMessageInput,
  type BirthdayWriter,
  createBirthdayWriter,
  fallbackBirthdayMessage,
  finalizeBirthdayMessage,
} from './birthdayAnnouncer';
import { getBirthday, saveBirthday } from './birthdayStore';

const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const CHANNEL = 'birthday-channel';

// Eastern wall-clock instants (EDT = UTC-4 in September).
const SEPT25_1459 = Date.UTC(2026, 8, 25, 18, 59);
const SEPT25_1500 = Date.UTC(2026, 8, 25, 19, 0);
const SEPT25_2330 = Date.UTC(2026, 8, 26, 3, 30);
const SEPT26_1600 = Date.UTC(2026, 8, 26, 20, 0);

let memory: MemoryStore;

function birthday(userId: string, month: number, day: number, year: number | null = null, lastAnnouncedYear = null) {
  saveBirthday({ userId, date: { month, day, year }, setBy: 'test', now: 0, lastAnnouncedYear });
}

function writerSaying(text: string | undefined) {
  const inputs: BirthdayMessageInput[] = [];
  const writer: BirthdayWriter = async (input) => {
    inputs.push(input);
    return text;
  };
  return { writer, inputs };
}

function setup(opts: { writer?: BirthdayWriter; members?: Array<{ id: string; displayName: string }> } = {}) {
  const target = createPostableChannel({ id: CHANNEL, members: opts.members });
  const { client } = createSchedulingClient({ [CHANNEL]: target.channel });
  const announcer = new BirthdayAnnouncer({ client, writer: opts.writer ?? writerSaying('🎂 happy bday').writer });
  return { target, client, announcer };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  vi.stubEnv('BIRTHDAY_CHANNEL_ID', CHANNEL);
  vi.stubEnv('MAIN_CHANNEL_ID', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('BirthdayAnnouncer.run', () => {
  it('waits for the afternoon, then announces once with a ping limited to the birthday person', async () => {
    birthday(ALICE, 9, 25);
    birthday(BOB, 9, 26);
    const { writer } = writerSaying(`🎂 <@${ALICE}> another year closer to the grave`);
    const { target, announcer } = setup({ writer });

    expect(await announcer.run(SEPT25_1459)).toBe(0);
    expect(target.sent).toHaveLength(0);

    expect(await announcer.run(SEPT25_1500)).toBe(1);
    expect(target.sent).toHaveLength(1);
    expect(target.sent[0]).toMatchObject({
      content: `🎂 <@${ALICE}> another year closer to the grave`,
      allowedMentions: { parse: [], users: [ALICE] },
      enforceNonce: true,
    });
    expect(String(target.sent[0].nonce).length).toBeLessThanOrEqual(25);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBe(2026);

    // Later ticks the same day post nothing more.
    expect(await announcer.run(SEPT25_1500 + 30_000)).toBe(0);
    expect(target.sent).toHaveLength(1);
  });

  it('is restart-safe: a fresh announcer does not repeat this year', async () => {
    birthday(ALICE, 9, 25);
    await setup().announcer.run(SEPT25_1500);

    const afterRestart = setup();
    expect(await afterRestart.announcer.run(SEPT25_1500 + 60_000)).toBe(0);
    expect(afterRestart.target.sent).toHaveLength(0);
  });

  it('announces late the same evening if the bot was offline all afternoon, but never the next day', async () => {
    birthday(ALICE, 9, 25);
    const lateSameDay = setup();
    expect(await lateSameDay.announcer.run(SEPT25_2330)).toBe(1);

    birthday(BOB, 9, 25);
    const nextDay = setup();
    expect(await nextDay.announcer.run(SEPT26_1600)).toBe(0);
    expect(getBirthday(BOB)?.lastAnnouncedYear).toBeNull();
  });

  it('announces a Feb 29 birthday on Feb 28 in a common year', async () => {
    birthday(ALICE, 2, 29);
    const { target, announcer } = setup();
    expect(await announcer.run(Date.UTC(2027, 1, 28, 21, 0))).toBe(1); // 16:00 EST
    expect(target.sent).toHaveLength(1);
  });

  it('respects BIRTHDAY_ANNOUNCE_HOUR', async () => {
    vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '9');
    birthday(ALICE, 9, 25);
    const { announcer } = setup();
    expect(await announcer.run(Date.UTC(2026, 8, 25, 12, 59))).toBe(0); // 08:59 EDT
    expect(await announcer.run(Date.UTC(2026, 8, 25, 13, 0))).toBe(1); // 09:00 EDT
  });

  it('is off without a channel (BIRTHDAY_CHANNEL_ID and MAIN_CHANNEL_ID unset) or when disabled', async () => {
    birthday(ALICE, 9, 25);
    vi.stubEnv('BIRTHDAY_CHANNEL_ID', '');
    const off = setup();
    expect(await off.announcer.run(SEPT25_1500)).toBe(0);

    vi.stubEnv('BIRTHDAY_CHANNEL_ID', CHANNEL);
    vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', 'false');
    const disabled = setup();
    expect(await disabled.announcer.run(SEPT25_1500)).toBe(0);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBeNull();
  });

  it('defaults to MAIN_CHANNEL_ID', async () => {
    vi.stubEnv('BIRTHDAY_CHANNEL_ID', '');
    vi.stubEnv('MAIN_CHANNEL_ID', CHANNEL);
    birthday(ALICE, 9, 25);
    const { target, announcer } = setup();
    await announcer.run(SEPT25_1500);
    expect(target.sent).toHaveLength(1);
  });

  it('falls back to the template when the writer has nothing or throws', async () => {
    birthday(ALICE, 9, 25, 1996);
    birthday(BOB, 9, 25);
    const failing = setup({ writer: writerSaying(undefined).writer });
    await failing.announcer.run(SEPT25_1500);
    expect(failing.target.sent.map((m) => m.content).sort()).toEqual(
      [`🎂 Happy 30th birthday <@${ALICE}>!`, `🎂 Happy birthday <@${BOB}>!`].sort(),
    );

    birthday(ALICE, 9, 25, 1996);
    const throwing = setup({
      writer: async () => {
        throw new Error('model exploded');
      },
    });
    expect(await throwing.announcer.run(SEPT25_1500)).toBe(1);
    expect(throwing.target.sent[0].content).toBe(`🎂 Happy 30th birthday <@${ALICE}>!`);
  });

  it('hands the writer their name, age and a few relevant memories', async () => {
    memory.upsertIdentity(ALICE, 'Alice');
    const facts = [
      'works night shifts as an ER nurse',
      'owns two greyhounds named Salt and Pepper',
      'refuses to eat cilantro',
      'mains Thresh in League',
      'moved to Montreal last spring',
      'collects vintage film cameras',
      'is training for a half marathon',
    ];
    for (const content of facts) await memory.save({ category: 'fact', subject: 'Alice', content });
    await memory.save({ category: 'image', subject: 'Alice', content: 'shared a cat gif', subject_user_id: ALICE });
    birthday(ALICE, 9, 25, 1990);
    const { writer, inputs } = writerSaying('🎂 hbd');
    const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice (server nick)' }] });

    await announcer.run(SEPT25_1500);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ userId: ALICE, name: 'Alice (server nick)', age: 36, botName: 'Frigidaire' });
    expect(inputs[0].memories).toHaveLength(5);
    expect(inputs[0].memories.join(' ')).not.toContain('cat gif');
  });

  it("finds memories filed under any name they go by: Discord handle, and a linked side account's names", async () => {
    const SIDE = '400000000000000003';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${ALICE}`);
    try {
      memory.upsertIdentity(ALICE, 'Alice', 'alice_handle');
      memory.upsertIdentity(SIDE, 'AliceAlt', 'alice_alt');
      await memory.save({ category: 'fact', subject: 'alice_handle', content: 'works night shifts as an ER nurse' });
      await memory.save({ category: 'fact', subject: 'AliceAlt', content: 'owns two greyhounds' });
      await memory.save({ category: 'fact', subject: 'Bob', content: 'mains Thresh in League' });
      birthday(ALICE, 9, 25);
      const { writer, inputs } = writerSaying('🎂 hbd');
      const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

      await announcer.run(SEPT25_1500);

      expect([...inputs[0].memories].sort()).toEqual(['owns two greyhounds', 'works night shifts as an ER nurse']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('skips (and settles for the year) someone who left the server', async () => {
    birthday(ALICE, 9, 25);
    const { target, announcer } = setup({ members: [{ id: BOB, displayName: 'Bob' }] });
    expect(await announcer.run(SEPT25_1500)).toBe(0);
    expect(target.sent).toHaveLength(0);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBe(2026);
  });

  it('releases the claim when the post fails and retries after a backoff', async () => {
    birthday(ALICE, 9, 25);
    let fail = true;
    const target = createPostableChannel({
      id: CHANNEL,
      sendImpl: async () => {
        if (fail) throw new Error('Service Unavailable');
        return { id: 'ok' };
      },
    });
    const { client } = createSchedulingClient({ [CHANNEL]: target.channel });
    const announcer = new BirthdayAnnouncer({ client, writer: writerSaying('🎂 hbd').writer });

    expect(await announcer.run(SEPT25_1500)).toBe(0);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBeNull();

    fail = false;
    // Backoff: the next 30 s tick doesn't retry yet…
    expect(await announcer.run(SEPT25_1500 + 30_000)).toBe(0);
    expect(target.channel.send.calls).toHaveLength(1);
    // …a minute later it does.
    expect(await announcer.run(SEPT25_1500 + 60_000)).toBe(1);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBe(2026);
    // Same nonce both times, so a first send that actually went through is deduplicated by Discord.
    expect(target.channel.send.calls[0][0].nonce).toBe(target.channel.send.calls[1][0].nonce);
  });

  it('backs off when the channel itself is unavailable', async () => {
    birthday(ALICE, 9, 25);
    const { client, channelsFetch } = createSchedulingClient({});
    const announcer = new BirthdayAnnouncer({ client, writer: writerSaying('🎂 hbd').writer });

    await announcer.run(SEPT25_1500);
    await announcer.run(SEPT25_1500 + 30_000);
    expect(channelsFetch.calls).toHaveLength(1);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBeNull();
  });
});

describe('finalizeBirthdayMessage / fallbackBirthdayMessage', () => {
  it('strips wrapping quotes, adds the cake and makes sure the person is pinged', () => {
    expect(finalizeBirthdayMessage('"happy birthday you old fart"', ALICE)).toBe(
      `🎂 <@${ALICE}> happy birthday you old fart`,
    );
    expect(finalizeBirthdayMessage(`hbd <@${ALICE}>, finally legal to rent a car`, ALICE)).toBe(
      `🎂 hbd <@${ALICE}>, finally legal to rent a car`,
    );
  });

  it('rejects empty or runaway output', () => {
    expect(finalizeBirthdayMessage('   ', ALICE)).toBeUndefined();
    expect(finalizeBirthdayMessage(null, ALICE)).toBeUndefined();
    expect(finalizeBirthdayMessage('a'.repeat(700), ALICE)).toBeUndefined();
  });

  it('uses the right ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((age) => fallbackBirthdayMessage('u', age))).toEqual([
      '🎂 Happy 1st birthday <@u>!',
      '🎂 Happy 2nd birthday <@u>!',
      '🎂 Happy 3rd birthday <@u>!',
      '🎂 Happy 4th birthday <@u>!',
      '🎂 Happy 11th birthday <@u>!',
      '🎂 Happy 12th birthday <@u>!',
      '🎂 Happy 13th birthday <@u>!',
      '🎂 Happy 21st birthday <@u>!',
      '🎂 Happy 22nd birthday <@u>!',
      '🎂 Happy 23rd birthday <@u>!',
      '🎂 Happy 101st birthday <@u>!',
      '🎂 Happy 111th birthday <@u>!',
    ]);
    expect(fallbackBirthdayMessage('u')).toBe('🎂 Happy birthday <@u>!');
  });
});

describe('createBirthdayWriter', () => {
  function capturingClient(response: { status: number; body: unknown }) {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });
    return { client, requests };
  }

  const completion = (content: string) => ({
    id: 'gen-1',
    object: 'chat.completion',
    created: 0,
    model: 'test-chat-model',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }],
  });

  const input: BirthdayMessageInput = {
    userId: ALICE,
    name: 'Alice',
    age: 30,
    memories: ['Alice is a nurse', 'Alice hates cilantro'],
    botName: 'Frigidaire',
  };

  it('asks the chat model with ZDR routing, tags the call as birthday, and finalizes the text', async () => {
    const { client, requests } = capturingClient({
      status: 200,
      body: completion(`<@${ALICE}> 30 and still can't handle cilantro`),
    });
    const writer = createBirthdayWriter({ client, model: 'test-chat-model' });

    expect(await writer(input)).toBe(`🎂 <@${ALICE}> 30 and still can't handle cilantro`);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requests[0].headers.get(FEATURE_HEADER)).toBe('birthday');
    // Low reasoning effort with room for it: the default chat model reasons at 'max' unless told
    // otherwise, and at a 600-token cap that came back empty.
    expect(requests[0].body).toMatchObject({
      model: 'test-chat-model',
      max_tokens: 1500,
      reasoning: { effort: 'low' },
      provider: { zdr: true },
    });
    const messages = requests[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("It's Alice's birthday today (turning 30)");
    expect(messages[0].content).toContain(`<@${ALICE}>`);
    expect(messages[1].content).toContain('- Alice hates cilantro');
  });

  it('returns undefined (template time) on an API error or an empty answer', async () => {
    const failing = capturingClient({ status: 500, body: { error: { message: 'upstream down', code: 500 } } });
    expect(await createBirthdayWriter({ client: failing.client, model: 'm' })(input)).toBeUndefined();

    const empty = capturingClient({ status: 200, body: completion('') });
    expect(await createBirthdayWriter({ client: empty.client, model: 'm' })(input)).toBeUndefined();
  });

  it('returns undefined without an OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(await createBirthdayWriter()(input)).toBeUndefined();
  });
});
