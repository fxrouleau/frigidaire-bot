import { ChannelType, Collection, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkReader, setLinkReaderForTesting } from '../ai/linkReader/reader';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { type FakeMessageOptions, createFakeMessage } from '../test-support/fakeDiscord';
import { createFakeSafeFetch } from '../test-support/fakeSafeFetch';
import { contextOf, discordCandidate, intakeSkipReason, namesBot, snapshotOf } from './candidate';

const SETTINGS = { channelIds: ['main'], botNames: ['fridge', 'bot'] };

type ReactionOption = { id?: string | null; name: string; count: number; me?: boolean };

/**
 * A fake message with what candidate.ts reads beyond fakeDiscord's defaults: the reaction cache, the
 * channel's message cache, forwarded snapshots and the client's application id.
 */
function message(
  opts: FakeMessageOptions & { reactions?: ReactionOption[]; cached?: Message[]; forwarded?: string[] } = {},
): Message {
  const fake = createFakeMessage({ channelId: 'main', messageId: '1001', ...opts });
  const raw = fake.message as unknown as Record<string, unknown>;
  const reactions = new Collection<string, unknown>();
  for (const r of opts.reactions ?? []) {
    reactions.set(r.id ?? r.name, { emoji: { id: r.id ?? null, name: r.name }, count: r.count, me: r.me ?? false });
  }
  raw.reactions = { cache: reactions };
  raw.messageSnapshots = new Collection((opts.forwarded ?? []).map((content, i) => [`fwd-${i}`, { content }]));
  const client = raw.client as Record<string, unknown>;
  client.application = { id: opts.botUserId ?? 'bot-1' };
  const channel = raw.channel as Record<string, unknown>;
  channel.messages = {
    ...(channel.messages as Record<string, unknown>),
    cache: new Collection((opts.cached ?? []).map((m) => [m.id, m])),
  };
  return fake.message;
}

let botDb: BotDb;

beforeEach(() => {
  botDb = new BotDb(':memory:');
  setBotDbForTesting(botDb);
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setLinkReaderForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('namesBot', () => {
  it('matches the bot names as whole words, case-insensitively', () => {
    expect(namesBot('lmao FRIDGE you seeing this', ['fridge'])).toBe(true);
    expect(namesBot('fridge?', ['fridge'])).toBe(true);
    expect(namesBot('my fridge_magnet', ['fridge'])).toBe(false);
    expect(namesBot('refridgerator', ['fridge'])).toBe(false);
    expect(namesBot('robot', ['bot'])).toBe(false);
    expect(namesBot('', ['fridge'])).toBe(false);
    expect(namesBot('anything', ['  '])).toBe(false);
  });
});

describe('intakeSkipReason', () => {
  it('accepts a member post in a watched channel', () => {
    expect(intakeSkipReason(message({ content: 'I parallel parked into a hydrant' }), SETTINGS)).toBeUndefined();
  });

  it('accepts a post in a thread under a watched channel', () => {
    const thread = message({ content: 'lol', channelId: 't1', channelType: ChannelType.PublicThread, parentChannelId: 'main' });
    expect(intakeSkipReason(thread, SETTINGS)).toBeUndefined();
  });

  it.each<[string, FakeMessageOptions, string]>([
    ['other channels', { channelId: 'elsewhere', content: 'lol' }, 'channel not watched'],
    ['DMs', { guildId: null, channelType: ChannelType.DM, content: 'lol' }, 'not in a server'],
    ['system messages', { system: true, content: 'joined' }, 'system message'],
    ['its own messages', { authorId: 'bot-1', authorIsBot: true, content: 'hi' }, 'own message'],
    ['other bots', { authorId: 'other-bot', authorIsBot: true, content: 'beep' }, 'bot'],
    ['other integrations’ webhooks', { webhookId: 'hook', applicationId: 'someone-else', content: 'x' }, 'foreign webhook'],
    ['mentions of the bot', { mentionedUserIds: ['bot-1'], content: '<@bot-1> hi' }, 'mentions the bot'],
    ['replies to the bot', { referencedMessageId: '999', repliedUserId: 'bot-1', content: 'ok' }, 'replies to the bot'],
    ['posts naming the bot (the gate may answer)', { content: 'fridge what do you think' }, 'names the bot'],
    ['empty posts', { content: '   ' }, 'empty'],
  ])('skips %s', (_label, opts, reason) => {
    expect(intakeSkipReason(message(opts), SETTINGS)).toBe(reason);
  });

  it("accepts the bot's own relays (link fixes) and replies to other members", () => {
    expect(intakeSkipReason(message({ webhookId: 'hook', applicationId: 'bot-1', content: 'x' }), SETTINGS)).toBeUndefined();
    expect(
      intakeSkipReason(message({ referencedMessageId: '999', repliedUserId: 'dan', content: 'hahaha' }), SETTINGS),
    ).toBeUndefined();
  });

  it('finds a reply to the bot through the message cache when Discord did not resolve the author', () => {
    const botMessage = message({ messageId: '999', authorId: 'bot-1', authorIsBot: true, content: 'answer' });
    const reply = message({ referencedMessageId: '999', content: 'ok', cached: [botMessage] });
    expect(intakeSkipReason(reply, SETTINGS)).toBe('replies to the bot');
  });

  it('accepts a post with only an attachment', () => {
    const post = message({ attachments: [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' }] });
    expect(intakeSkipReason(post, SETTINGS)).toBeUndefined();
  });
});

describe('snapshotOf', () => {
  it('describes a member post: readable text, attachments, embeds, reactions so far, images', () => {
    const post = message({
      content: 'look at this <:KEKW:300000000000000001>',
      authorId: 'felix',
      authorDisplayName: 'Felix',
      attachments: [
        { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png', name: 'a.png' },
        { url: 'https://cdn.discordapp.com/b.mp4', contentType: 'video/mp4', name: 'b.mp4' },
      ],
      stickers: [{ id: 's1', name: 'wave', format: 1 }],
      embeds: [
        {
          title: 'Man parks in hydrant',
          description: 'Local news',
          url: 'https://news.example/x',
          imageUrl: 'https://news.example/x.jpg',
          imageProxyUrl: 'https://images-ext-1.discordapp.net/x.jpg',
        },
      ],
      reactions: [
        { id: null, name: '😂', count: 2 },
        { id: '300000000000000001', name: 'KEKW', count: 1, me: true },
      ],
      forwarded: ['original <:KEKW:300000000000000001> text'],
    });
    expect(snapshotOf(post)).toEqual({
      authorId: 'felix',
      authorName: 'Felix',
      text: 'look at this :KEKW:',
      notes: [
        '[image attached: a.png]',
        '[video attached: b.mp4]',
        '[sticker: wave]',
        '[forwarded message: original :KEKW: text]',
        '[link preview: Man parks in hydrant — Local news]',
        '[reactions so far: 😂×2]',
      ],
      imageUrls: ['https://cdn.discordapp.com/a.png', 'https://images-ext-1.discordapp.net/x.jpg'],
      botReacted: true,
    });
  });

  it('attributes a link-fix relay to the member it was posted for', () => {
    recordRelay({ messageId: '1001', channelId: 'main', authorId: 'dan', authorName: 'Dan', kind: 'link_fix' });
    const relay = message({ webhookId: 'hook', applicationId: 'bot-1', authorUsername: 'Dan', content: 'https://fixvx.com/a/status/1' });
    expect(snapshotOf(relay)).toMatchObject({ authorId: 'dan', authorName: 'Dan', text: 'https://fixvx.com/a/status/1' });
  });

  it("is undefined for another integration's webhook", () => {
    expect(snapshotOf(message({ webhookId: 'hook', applicationId: 'someone-else', content: 'x' }))).toBeUndefined();
  });

  it("uses the link reader's cached preview instead of Discord's embed for the same link", async () => {
    const fetch = createFakeSafeFetch({
      'https://api.fxtwitter.com/2/status/111': {
        body: {
          code: 200,
          status: {
            url: 'https://x.com/someone/status/111',
            text: 'the tweet text',
            author: { screen_name: 'someone', name: 'Some One' },
          },
        },
      },
    });
    const reader = new LinkReader({ fetch, describeVideo: async () => undefined });
    await reader.read('https://x.com/someone/status/111');
    setLinkReaderForTesting(reader);
    const calls = fetch.calls.length;

    const post = message({
      content: 'https://fixvx.com/someone/status/111',
      embeds: [{ url: 'https://fixvx.com/someone/status/111', description: 'the tweet text (embed)' }],
    });
    const snapshot = snapshotOf(post);
    expect(snapshot?.notes).toEqual([expect.stringContaining('tweet by Some One (@someone): the tweet text')]);
    expect(fetch.calls.length).toBe(calls); // nothing fetched for a post nobody asked about
  });
});

describe('contextOf', () => {
  it('lists the messages just before the post from the cache, oldest first, the bot labelled', () => {
    const base = Date.UTC(2026, 8, 25, 16, 0);
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    const old = message({ messageId: '1', content: 'too old', createdAt: at(-45), authorDisplayName: 'Dan' });
    const a = message({ messageId: '2', content: 'who drives', createdAt: at(-5), authorDisplayName: 'Dan' });
    const bot = message({ messageId: '3', content: 'not me', createdAt: at(-4), authorId: 'bot-1', authorIsBot: true });
    const other = message({ messageId: '4', content: 'beep', createdAt: at(-3), authorId: 'x', authorIsBot: true });
    const pic = message({
      messageId: '5',
      content: '',
      createdAt: at(-2),
      authorDisplayName: 'Yi',
      attachments: [{ url: 'https://cdn.discordapp.com/p.png', contentType: 'image/png', name: 'p.png' }],
    });
    const later = message({ messageId: '7', content: 'after', createdAt: at(1), authorDisplayName: 'Dan' });
    const post = message({ messageId: '6', content: 'the post', createdAt: at(0), cached: [later, pic, other, bot, a, old] });

    expect(contextOf(post, 6)).toEqual([
      { author: 'Dan', text: 'who drives' },
      { author: 'Frigidaire (the bot)', text: 'not me' },
      { author: 'Yi', text: '[image]' },
    ]);
    expect(contextOf(post, 1)).toEqual([{ author: 'Yi', text: '[image]' }]);
  });
});

describe('discordCandidate', () => {
  it('exposes the message and reacts through discord.js', async () => {
    const fake = createFakeMessage({ channelId: 'main', messageId: '1001', content: 'lol' });
    const raw = fake.message as unknown as Record<string, unknown>;
    raw.reactions = { cache: new Collection() };
    const candidate = discordCandidate(fake.message);
    expect(candidate).toMatchObject({
      id: '1001',
      channelId: 'main',
      url: 'https://discord.com/channels/guild-1/main/1001',
    });
    await candidate.react('KEKW:300000000000000001');
    expect(fake.recorders.react.calls).toEqual([['KEKW:300000000000000001']]);
  });
});
