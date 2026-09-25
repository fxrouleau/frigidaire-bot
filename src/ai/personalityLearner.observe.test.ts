// The learner's observation cycle end to end: fake Discord channel fetches in, a capturing OpenRouter
// client out. Prompt-rule and parser tests live in personalityLearner.test.ts.
import { type Channel, ChannelType, type Client, Collection, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  type CapturedRequest,
  chatCompletionBody,
  createCapturingClient,
  type ScriptedReply,
} from '../test-support/capturingClient';
import { createFakeBotMessage, createFakeClient, createFakeMessage, type FakeMessageOptions } from '../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import { capImageParts, MAX_LEARNER_IMAGES, PersonalityLearner } from './personalityLearner';
import { FEATURE_HEADER } from './usage';

const transcripts = vi.hoisted(() => new Map<string, string>());
vi.mock('./media', () => ({
  getCachedTranscript: (messageId: string) => transcripts.get(messageId),
  transcribeAudio: async () => undefined,
}));

const CHANNEL_ID = 'chan-general';
const BASE = new Date('2026-03-01T15:00:00Z').getTime();

let store: MemoryStore;
let seq = 0;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  transcripts.clear();
  vi.stubEnv('SELF_IMPROVEMENT_ENABLED', 'false');
  store.upsertIdentity('100000000000000001', 'Jason');
  store.upsertIdentity('100000000000000002', 'OldNick');
  store.upsertIdentity('100000000000000002', 'Wheezer');
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
});

function message(opts: FakeMessageOptions): Message {
  seq += 1;
  const createdAt = new Date(BASE + seq * 60_000);
  return createFakeMessage({ messageId: String(1_000_000 + seq), createdAt, channelId: CHANNEL_ID, ...opts }).message;
}

const jason = (content: string, opts: FakeMessageOptions = {}) =>
  message({ authorId: '100000000000000001', authorDisplayName: 'Jason', content, ...opts });
const wheezer = (content: string, opts: FakeMessageOptions = {}) =>
  message({ authorId: '100000000000000002', authorDisplayName: 'Wheezer', content, ...opts });

type FakeChannel = { client: Client; fetchCalls: unknown[] };

/** A ready client whose one text channel returns `messages` (newest first, like Discord) on every fetch. */
function channelServing(messages: Message[] | (() => Promise<Message[]>)): FakeChannel {
  const fetchCalls: unknown[] = [];
  const channel = {
    id: CHANNEL_ID,
    name: 'general',
    type: ChannelType.GuildText,
    messages: {
      fetch: async (opts: unknown) => {
        fetchCalls.push(opts);
        const list = typeof messages === 'function' ? await messages() : messages;
        const newestFirst = [...list].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        return new Collection(newestFirst.map((m) => [m.id, m]));
      },
    },
  };
  const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: channel as unknown as Channel } });
  return { client, fetchCalls };
}

function learnerWith(replies: ScriptedReply[], minMessages = 3) {
  const { client, requests } = createCapturingClient(replies);
  const learner = new PersonalityLearner(store, { client, minMessages, intervalMs: 60_000 });
  learner.trackActivity(CHANNEL_ID);
  return { learner, requests };
}

const noObservations = () => ({ body: chatCompletionBody('{"observations": []}') });

type Part = { type: string; text?: string; image_url?: { url: string } };
function partsOf(request: CapturedRequest): Part[] {
  const messages = request.body.messages as { content: Part[] }[];
  return messages[0].content;
}
function textOf(request: CapturedRequest): string {
  return partsOf(request)
    .map((p) => p.text ?? `<image ${p.image_url?.url}>`)
    .join('\n');
}

describe('PersonalityLearner observation cycle', () => {
  it('includes relayed messages under their real author and drops other bots and the bot itself', async () => {
    const relay = message({ webhookId: 'wh-1', authorUsername: 'Jason', content: 'https://fxtwitter.com/a/status/1' });
    recordRelay({ messageId: relay.id, channelId: CHANNEL_ID, authorId: '100000000000000001', authorName: 'Jason', kind: 'link_fix' });
    const history = [
      jason('anyone watching the game'),
      relay,
      message({ authorId: 'music-bot', authorIsBot: true, authorDisplayName: 'Jockie', content: 'Now playing: song' }),
      createFakeBotMessage({ messageId: String(2_000_000 + seq), createdAt: new Date(BASE + 90 * 60_000), content: 'bot reply' }).message,
      wheezer('yeah at 8'),
    ];
    const { client } = channelServing(history);
    const { learner, requests } = learnerWith([noObservations()]);

    await learner.observeOnce(client);

    expect(requests).toHaveLength(1);
    const text = textOf(requests[0]);
    expect(text).toContain('[Jason (id:100000000000000001)] https://fxtwitter.com/a/status/1');
    expect(text).toContain('[Wheezer (id:100000000000000002)] yeah at 8');
    expect(text).not.toContain('Now playing');
    expect(text).not.toContain('bot reply');
  });

  it('counts relays toward the minimum-message threshold', async () => {
    const relays = [0, 1].map((i) => {
      const relay = message({ webhookId: 'wh-1', authorUsername: 'Jason', content: `link ${i}` });
      recordRelay({ messageId: relay.id, channelId: CHANNEL_ID, authorId: '100000000000000001', authorName: 'Jason', kind: 'link_fix' });
      return relay;
    });
    const { client } = channelServing([jason('one'), ...relays]);
    const { learner, requests } = learnerWith([noObservations()], 3);

    await learner.observeOnce(client);

    expect(requests).toHaveLength(1);
  });

  it('gives existing-memory context per participant by id and every past name', async () => {
    await store.save({ category: 'fact', subject: 'OldNick', subject_user_id: '100000000000000002', content: 'Plays bass' });
    await store.save({ category: 'fact', subject: 'OldNick', content: 'Owns a husky' });
    await store.save({ category: 'fact', subject: 'Stranger', content: 'Not in this batch' });
    const { client } = channelServing([jason('a'), wheezer('b'), wheezer('c')]);
    const { learner, requests } = learnerWith([noObservations()]);

    await learner.observeOnce(client);

    const prompt = partsOf(requests[0])[0].text ?? '';
    expect(prompt).toContain('- [fact] OldNick: Plays bass');
    expect(prompt).toContain('- [fact] OldNick: Owns a husky');
    expect(prompt).not.toContain('Not in this batch');
  });

  it('adds a cached voice transcript after its message, without paying to transcribe', async () => {
    const voice = wheezer('', { attachments: [{ url: 'https://cdn.example/v.ogg', contentType: 'audio/ogg' }] });
    transcripts.set(voice.id, 'I got the job');
    const { client } = channelServing([jason('a'), voice, jason('congrats')]);
    const { learner, requests } = learnerWith([noObservations()]);

    await learner.observeOnce(client);

    const texts = partsOf(requests[0]).map((p) => p.text);
    const at = texts.findIndex((t) => t?.startsWith('[') && t.includes('[Wheezer (id:100000000000000002)]'));
    expect(texts[at + 1]).toBe('[voice message transcript: I got the job]');
  });

  it('uses the embed proxy URL when Discord provides one', async () => {
    const shared = jason('look', {
      embeds: [
        { imageUrl: 'https://origin.example/a.jpg', imageProxyUrl: 'https://media.discordapp.net/external/a.jpg' },
        { thumbnailUrl: 'https://origin.example/thumb.jpg' },
      ],
    });
    const { client } = channelServing([shared, jason('b'), wheezer('c')]);
    const { learner, requests } = learnerWith([noObservations()]);

    await learner.observeOnce(client);

    const images = partsOf(requests[0])
      .filter((p) => p.type === 'image_url')
      .map((p) => p.image_url?.url);
    expect(images).toEqual(['https://media.discordapp.net/external/a.jpg', 'https://origin.example/thumb.jpg']);
  });

  it(`keeps only the ${MAX_LEARNER_IMAGES} most recent images per request`, async () => {
    const history = Array.from({ length: 11 }, (_, i) =>
      jason(`pic ${i}`, { attachments: [{ url: `https://cdn.example/${i}.png`, contentType: 'image/png' }] }),
    );
    const { client } = channelServing(history);
    const { learner, requests } = learnerWith([noObservations()]);

    await learner.observeOnce(client);

    const parts = partsOf(requests[0]);
    const images = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url);
    expect(images).toEqual(Array.from({ length: 8 }, (_, i) => `https://cdn.example/${i + 3}.png`));
    expect(parts.filter((p) => p.text === '[image not shown]')).toHaveLength(3);
  });

  it('routes with ZDR and tags each pass with its feature', async () => {
    vi.stubEnv('SELF_IMPROVEMENT_ENABLED', 'true');
    const { client } = channelServing([jason('a'), wheezer('b'), jason('c')]);
    const { learner, requests } = learnerWith([noObservations(), noObservations()]);

    await learner.observeOnce(client);

    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.body.provider)).toEqual([{ zdr: true }, { zdr: true }]);
    expect(requests.map((r) => r.headers.get(FEATURE_HEADER))).toEqual(['learner', 'self_improvement']);
  });

  it("gives the self-improvement pass the bot's mention id and the asked rule", async () => {
    vi.stubEnv('SELF_IMPROVEMENT_ENABLED', 'true');
    const { client } = channelServing([jason('a'), wheezer('<@bot-1> can you open this?'), jason('c')]);
    const { learner, requests } = learnerWith([noObservations(), noObservations()]);

    await learner.observeOnce(client);

    const prompt = textOf(requests[1]);
    expect(prompt).toContain('it is mentioned as <@bot-1>.');
    expect(prompt).toContain('6. The asked rule');
    expect(prompt).toContain('<@bot-1> can you open this?');
  });

  it('files observations under the member: id wins and names the subject, bare names are matched', async () => {
    const output = JSON.stringify({
      observations: [
        { category: 'fact', subject: 'Wheez', subject_user_id: '100000000000000002', content: 'Works as an electrician' },
        { category: 'fact', subject: 'jason', content: 'Drives a red Miata' },
        { category: 'vibe', subject: 'Server', subject_user_id: '100000000000000001', content: 'Wings every Friday' },
        // A JSON number cannot carry an 18-digit id exactly: ignored, the name decides.
        { category: 'preference', subject: 'Wheezer', subject_user_id: 100000000000000002, content: 'Hates cilantro' },
      ],
    });
    const { client } = channelServing([jason('a'), wheezer('b'), jason('c')]);
    const { learner } = learnerWith([{ body: chatCompletionBody(output) }]);

    await learner.observeOnce(client);

    const rows = store.getAllActive().map((m) => [m.subject, m.subject_user_id, m.content]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['Wheezer', '100000000000000002', 'Works as an electrician'],
        ['Jason', '100000000000000001', 'Drives a red Miata'],
        ['server', null, 'Wings every Friday'],
        ['Wheezer', '100000000000000002', 'Hates cilantro'],
      ]),
    );
  });

  it('records Discord handles and files a subject written as a handle under the member', async () => {
    const output = JSON.stringify({
      observations: [{ category: 'fact', subject: 'cigalefourmi', content: 'Mains Jhin' }],
    });
    recordRelay({ messageId: '9000', channelId: CHANNEL_ID, authorId: '100000000000000002', authorName: 'Wheezer', kind: 'link_fix' });
    const relay = createFakeMessage({
      messageId: '9000',
      webhookId: 'wh-1',
      authorUsername: 'Wheezer',
      channelId: CHANNEL_ID,
      createdAt: new Date(BASE),
      content: 'https://fixvx.com/x/status/1',
    }).message;
    const { client } = channelServing([
      jason('a', { authorUsername: 'cigalefourmi', memberIsNull: true }),
      wheezer('b', { authorUsername: 'wheezy_d' }),
      relay,
    ]);
    const { learner, requests } = learnerWith([{ body: chatCompletionBody(output) }]);

    await learner.observeOnce(client);

    expect(store.getIdentityById('100000000000000001')?.username).toBe('cigalefourmi');
    // A relay's author is the webhook: its "username" is a display name and must never be recorded.
    expect(store.getIdentityById('100000000000000002')?.username).toBe('wheezy_d');
    expect(textOf(requests[0])).toContain('- Jason @cigalefourmi (id:100000000000000001)');
    expect(store.getAllActive().map((m) => [m.subject, m.subject_user_id, m.content])).toEqual([
      ['Jason', '100000000000000001', 'Mains Jhin'],
    ]);
  });

  it("files a linked side account's messages, names and id under the main account (LINKED_ACCOUNTS)", async () => {
    const SIDE = '100000000000000003';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:100000000000000001`);
    store.upsertIdentity(SIDE, 'JayAlt', 'jay_alt');
    const output = JSON.stringify({
      observations: [
        { category: 'fact', subject: 'JayAlt', content: 'Works nights at the depot' },
        { category: 'preference', subject: 'Whoever', subject_user_id: SIDE, content: 'Hates cilantro' },
      ],
      identity_updates: [{ discord_user_id: SIDE, irl_name: 'Jason' }],
    });
    const { client } = channelServing([
      message({ authorId: SIDE, authorDisplayName: 'JayAlt', authorUsername: 'jay_alt', content: 'posting from my alt' }),
      wheezer('lol ok'),
      jason('yeah that was me'),
    ]);
    const { learner, requests } = learnerWith([{ body: chatCompletionBody(output) }]);

    await learner.observeOnce(client);

    const text = textOf(requests[0]);
    // The side account's message is attributed to the main account, and the side account is folded
    // into the main account's identities line instead of being listed as another person.
    expect(text).toContain('[Jason (id:100000000000000001)] posting from my alt');
    expect(text).toContain('- Jason @testuser (id:100000000000000001) — also posts as JayAlt @jay_alt (id:100000000000000003)');
    expect(text).not.toContain('\n- JayAlt');
    expect(store.getAllActive().map((m) => [m.subject, m.subject_user_id, m.content])).toEqual([
      ['Jason', '100000000000000001', 'Works nights at the depot'],
      ['Jason', '100000000000000001', 'Hates cilantro'],
    ]);
    // Real names belong to the person: the update lands on the main account's row.
    expect(store.getIdentityById('100000000000000001')?.irl_name).toBe('Jason');
    expect(store.getIdentityById(SIDE)?.irl_name).toBeNull();
    // The side account keeps its own row (display name and handle), refreshed from its message.
    expect(store.getIdentityById(SIDE)?.username).toBe('jay_alt');
  });

  it('never overwrites a known nickname with the global name of a member-less fetched message', async () => {
    const { client } = channelServing([
      jason('a', { memberIsNull: true, authorDisplayName: 'jay_global' }),
      message({ authorId: '100000000000000009', authorDisplayName: 'Newcomer', memberIsNull: true, content: 'hi' }),
      wheezer('b'),
    ]);
    const { learner } = learnerWith([noObservations()]);

    await learner.observeOnce(client);

    expect(store.getIdentityById('100000000000000001')?.display_name).toBe('Jason');
    expect(store.getIdentityById('100000000000000009')?.display_name).toBe('Newcomer');
  });

  it('advances the watermark to the newest fetched message, bot messages included', async () => {
    const history = [jason('a'), wheezer('b'), jason('c')];
    const newest = message({ authorId: 'music-bot', authorIsBot: true, content: 'Now playing' });
    const { client, fetchCalls } = channelServing([...history, newest]);
    const { learner } = learnerWith([noObservations(), noObservations()]);

    await learner.observeOnce(client);
    expect(store.getLastObserved(CHANNEL_ID)).toBe(newest.id);

    learner.trackActivity(CHANNEL_ID);
    await learner.observeOnce(client);
    expect(fetchCalls[1]).toEqual({ limit: 100, after: newest.id });
  });

  it('skips a tick while the previous cycle is still running, keeping the queued channels', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const history = [jason('a'), wheezer('b'), jason('c')];
    const { client, fetchCalls } = channelServing(async () => {
      await gate;
      return history;
    });
    const { learner, requests } = learnerWith([noObservations(), noObservations()]);

    const first = learner.observeOnce(client);
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    learner.trackActivity(CHANNEL_ID);
    await learner.observeOnce(client); // overlapping tick: returns immediately
    expect(fetchCalls).toHaveLength(1);

    release();
    await first;
    expect(requests).toHaveLength(1);

    // The channel queued during the skipped tick is processed on the next one.
    await learner.observeOnce(client);
    expect(fetchCalls).toHaveLength(2);
  });

  it('survives a channel fetch failure and a model failure without throwing', async () => {
    const { client } = channelServing(async () => {
      throw new Error('Missing Access');
    });
    const failing = learnerWith([{ status: 500, body: { error: { message: 'boom' } } }]);
    await expect(failing.learner.observeOnce(client)).resolves.toBeUndefined();

    const ok = channelServing([jason('a'), wheezer('b'), jason('c')]);
    const modelDown = learnerWith([{ error: new Error('network down') }]);
    await expect(modelDown.learner.observeOnce(ok.client)).resolves.toBeUndefined();
    // The watermark only moves after a successful pass.
    expect(store.getLastObserved(CHANNEL_ID)).toBeNull();
  });
});

describe('capImageParts', () => {
  it('leaves requests under the cap untouched', () => {
    const parts = [
      { type: 'text' as const, text: 'a' },
      { type: 'image_url' as const, image_url: { url: 'u1' } },
    ];
    expect(capImageParts(parts, 8)).toEqual({ parts, kept: 1, dropped: 0 });
  });

  it('replaces the oldest images with a placeholder', () => {
    const parts = ['u1', 'u2', 'u3'].map((url) => ({ type: 'image_url' as const, image_url: { url } }));
    const result = capImageParts(parts, 2);
    expect(result.kept).toBe(2);
    expect(result.dropped).toBe(1);
    expect(result.parts[0]).toEqual({ type: 'text', text: '[image not shown]' });
    expect(result.parts.slice(1)).toEqual(parts.slice(1));
  });
});
