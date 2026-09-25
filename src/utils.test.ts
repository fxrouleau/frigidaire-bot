import {
  ChannelType,
  type Message,
  MessageFlags,
  MessageReferenceType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRelay } from './relay';
import { BotDb, setBotDbForTesting } from './storage/botDb';
import { createFakeMessage } from './test-support/fakeDiscord';
import {
  type RepostOutcome,
  type WebhookParentChannel,
  mentionsInText,
  repostBlocker,
  repostMessage,
  sendViaWebhook,
  splitMessage,
  webhookName,
  webhookTargetOf,
} from './utils';

describe('splitMessage', () => {
  it('returns a single unchanged chunk for short text', () => {
    const chunks = splitMessage('hello world');
    expect(chunks).toEqual(['hello world']);
  });

  it('returns a single chunk for text exactly at the limit', () => {
    const text = 'a'.repeat(2000);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
    expect(chunks[0].length).toBe(2000);
  });

  it('hard-splits a single oversized line with no newlines into two chunks', () => {
    const text = 'a'.repeat(2001);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(1);
    expect(chunks.join('')).toBe(text);
  });

  it('splits multi-line text at line boundaries without exceeding the limit', () => {
    // 30 lines of 100 chars each → 3000 chars total, forcing a split.
    const line = 'x'.repeat(100);
    const lines = Array.from({ length: 30 }, () => line);
    const text = lines.join('\n');

    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // Joining the chunks back with newlines reconstructs the original content.
    expect(chunks.join('\n')).toBe(text);
  });

  it('respects a custom maxLength', () => {
    const chunks = splitMessage('one\ntwo\nthree', 5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
    expect(chunks.join('\n')).toBe('one\ntwo\nthree');
  });

  it('returns a single empty chunk for an empty string', () => {
    // Empty string has length 0 <= maxLength so it short-circuits to [''].
    const chunks = splitMessage('');
    expect(chunks).toEqual(['']);
  });

  it('filters out empty chunks produced by blank lines when a split occurs', () => {
    // Force the line-splitting path (text longer than maxLength) and include blank lines.
    const block = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    const chunks = splitMessage(block);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should be empty — the implementation filters zero-length chunks.
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});

type SentPayload = {
  content: string;
  files: Array<{ attachment: Buffer; name: string; description?: string }>;
  allowedMentions?: { parse: string[] };
  threadId?: string;
  flags?: number;
};

function sentPayload(fake: ReturnType<typeof createFakeMessage>, hook = 0): SentPayload {
  return fake.webhooks[hook].send.calls[0][0] as SentPayload;
}

/** A fetch that serves attachment bytes by URL and records every request. */
function attachmentFetch(bodies: Record<string, Uint8Array<ArrayBuffer> | number>): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const body = bodies[url];
    if (body === undefined) throw new TypeError('fetch failed');
    if (typeof body === 'number') return new Response('', { status: body });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  return Object.assign(fn, { urls });
}

const noFetch = (async () => {
  throw new Error('no network in this test');
}) as typeof globalThis.fetch;

describe('repostMessage', () => {
  beforeEach(() => {
    setBotDbForTesting(new BotDb(':memory:'));
  });

  afterEach(() => {
    setBotDbForTesting(undefined);
    vi.unstubAllEnvs();
  });

  it('creates a webhook, sends the new content, deletes the original, and cleans up the webhook', async () => {
    const fake = createFakeMessage({
      content: 'original content',
      authorDisplayName: 'Cool Author',
    });

    const outcome = await repostMessage(fake.message, 'new content', { fetch: noFetch });

    // Webhook created exactly once with a name + avatar.
    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    const createArg = fake.recorders.createWebhook.calls[0][0] as { name: string; avatar: unknown };
    expect(createArg.name).toBe('Cool Author');
    expect(createArg).toHaveProperty('avatar');

    // Original message deleted.
    expect(fake.recorders.delete.calls).toHaveLength(1);

    // The created webhook is tracked; its send + delete recorders were exercised.
    expect(fake.webhooks).toHaveLength(1);
    const hook = fake.webhooks[0];
    expect(hook.send.calls).toHaveLength(1);
    expect(sentPayload(fake)).toEqual({ content: 'new content', files: [], allowedMentions: { parse: [] } });
    expect(hook.delete.calls).toHaveLength(1);
    expect(outcome.status).toBe('reposted');
  });

  it('never pings anyone again: the original already did (allowedMentions parse: [])', async () => {
    const fake = createFakeMessage({ content: '<@123> @everyone https://x.com/u/status/1' });

    await repostMessage(fake.message, '<@123> @everyone https://fixvx.com/u/status/1', { fetch: noFetch });

    expect(sentPayload(fake).allowedMentions).toEqual({ parse: [] });
  });

  it('records the repost as a relay of the real author (so it counts as theirs downstream)', async () => {
    const fake = createFakeMessage({ authorId: 'user-7', authorDisplayName: 'Jasper', channelId: 'chan-9' });

    const outcome = await repostMessage(fake.message, 'hi', { fetch: noFetch });

    expect(outcome.status).toBe('reposted');
    const repostId = (outcome as Extract<RepostOutcome, { status: 'reposted' }>).repostId;
    expect(getRelay(repostId)).toMatchObject({
      authorId: 'user-7',
      authorName: 'Jasper',
      channelId: 'chan-9',
      kind: 'link_fix',
      // The deleted original, so a window that already showed it doesn't show the repost again.
      originalId: fake.message.id,
    });
  });

  it('prefers the member nickname over the author displayName for the webhook name', async () => {
    const fake = createFakeMessage({ authorDisplayName: 'Fallback Name' });
    // member.nickname defaults to null in the fake; set it to exercise the preference branch.
    const member = (fake.message as unknown as { member: { nickname: string | null } }).member;
    member.nickname = 'Nickname';

    await repostMessage(fake.message, 'hi', { fetch: noFetch });

    const createArg = fake.recorders.createWebhook.calls[0][0] as { name: string };
    expect(createArg.name).toBe('Nickname');
  });

  it('sends the repost BEFORE deleting the original, so a failed send never loses the message', async () => {
    const events: string[] = [];
    const fake = createFakeMessage({
      webhookSendImpl: async () => {
        events.push('send');
        return { id: 'repost-1' };
      },
    });
    const msg = fake.message as unknown as { delete: () => Promise<unknown> };
    const realDelete = msg.delete;
    msg.delete = () => {
      events.push('delete');
      return realDelete();
    };

    await repostMessage(fake.message, 'ordered', { fetch: noFetch, onBeforeDelete: () => events.push('forget') });

    expect(events).toEqual(['send', 'forget', 'delete']);
  });

  it('deletes the webhook and keeps the original when the send fails (no webhook leak)', async () => {
    const fake = createFakeMessage({
      webhookSendImpl: async () => {
        throw new Error('Missing Permissions');
      },
    });

    await expect(repostMessage(fake.message, 'boom', { fetch: noFetch })).rejects.toThrow('Missing Permissions');

    expect(fake.webhooks).toHaveLength(1);
    expect(fake.webhooks[0].delete.calls).toHaveLength(1);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('takes the repost back when the original cannot be deleted, so the message never appears twice', async () => {
    const fake = createFakeMessage({
      deleteImpl: async () => {
        throw new Error('Unknown Message');
      },
    });

    const outcome = await repostMessage(fake.message, 'x', { fetch: noFetch });

    expect(outcome).toEqual({ status: 'rolled-back', reason: 'the original could not be deleted (Unknown Message)' });
    const hook = fake.webhooks[0];
    expect(hook.deleteMessage.calls).toHaveLength(1);
    expect(hook.deleteMessage.calls[0][1]).toBeUndefined();
    expect(hook.delete.calls).toHaveLength(1);
  });

  it('refuses DMs without touching the message', async () => {
    const fake = createFakeMessage({ channelType: ChannelType.DM });

    const outcome = await repostMessage(fake.message, 'x', { fetch: noFetch });

    expect(outcome.status).toBe('skipped');
    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('posts nothing when the message was edited while the webhook was being created', async () => {
    const fake = createFakeMessage({ content: 'https://x.com/u/status/1' });
    const channel = fake.message.channel as unknown as { createWebhook: (options: unknown) => Promise<unknown> };
    const create = channel.createWebhook;
    channel.createWebhook = async (options) => {
      (fake.message as unknown as { content: string }).content = 'edited https://x.com/u/status/1';
      return create(options);
    };

    const outcome = await repostMessage(fake.message, 'https://fixvx.com/u/status/1', {
      fetch: noFetch,
      stillCurrent: () => fake.message.content === 'https://x.com/u/status/1',
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'it was edited while the repost was being prepared' });
    expect(fake.webhooks[0].send.calls).toHaveLength(0);
    expect(fake.webhooks[0].delete.calls).toHaveLength(1);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('keeps @silent messages silent', async () => {
    const fake = createFakeMessage({ flags: MessageFlags.SuppressNotifications });

    await repostMessage(fake.message, 'shh', { fetch: noFetch });

    expect(sentPayload(fake).flags).toBe(MessageFlags.SuppressNotifications);
  });

  describe('threads and forum posts', () => {
    it('posts through a webhook on the parent channel with threadId', async () => {
      const fake = createFakeMessage({
        channelType: ChannelType.PublicThread,
        channelId: 'thread-1',
        threadParentId: 'parent-1',
      });

      const outcome = await repostMessage(fake.message, 'in a thread', { fetch: noFetch });

      expect(outcome.status).toBe('reposted');
      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.parentCreateWebhook.calls).toHaveLength(1);
      expect(sentPayload(fake).threadId).toBe('thread-1');
      expect(fake.recorders.delete.calls).toHaveLength(1);
      const repostId = (outcome as Extract<RepostOutcome, { status: 'reposted' }>).repostId;
      expect(getRelay(repostId)?.channelId).toBe('thread-1');
    });

    it('takes a thread repost back with the thread id when the original cannot be deleted', async () => {
      const fake = createFakeMessage({
        channelType: ChannelType.PrivateThread,
        channelId: 'thread-2',
        deleteImpl: async () => {
          throw new Error('Missing Permissions');
        },
      });

      await repostMessage(fake.message, 'x', { fetch: noFetch });

      expect(fake.webhooks[0].deleteMessage.calls[0][1]).toBe('thread-2');
    });

    it('works in forum posts (reply messages, not the starter)', async () => {
      const fake = createFakeMessage({
        channelType: ChannelType.PublicThread,
        channelId: 'post-1',
        messageId: 'reply-in-post',
        threadParentType: ChannelType.GuildForum,
      });

      expect((await repostMessage(fake.message, 'x', { fetch: noFetch })).status).toBe('reposted');
      expect(sentPayload(fake).threadId).toBe('post-1');
    });

    it("never reposts a forum post's starter message (deleting it would delete the whole post)", async () => {
      const fake = createFakeMessage({
        channelType: ChannelType.PublicThread,
        channelId: 'post-1',
        messageId: 'post-1',
        threadParentType: ChannelType.GuildForum,
      });

      const outcome = await repostMessage(fake.message, 'x', { fetch: noFetch });

      expect(outcome).toEqual({ status: 'skipped', reason: expect.stringContaining('forum post') });
      expect(fake.recorders.parentCreateWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });

    it.each([
      ['archived', { threadArchived: true }],
      ['locked', { threadLocked: true }],
      ['parentless', { threadParentMissing: true }],
    ])('skips %s threads', async (_label, threadOptions) => {
      const fake = createFakeMessage({ channelType: ChannelType.PublicThread, ...threadOptions });

      expect((await repostMessage(fake.message, 'x', { fetch: noFetch })).status).toBe('skipped');
      expect(fake.recorders.parentCreateWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });
  });

  describe('attachments', () => {
    it('downloads every attachment and re-uploads it with its name and alt text', async () => {
      const fetch = attachmentFetch({
        'https://cdn.discordapp.com/a.png': new Uint8Array([1, 2, 3]),
        'https://cdn.discordapp.com/SPOILER_b.mp4': new Uint8Array([4, 5]),
      });
      const fake = createFakeMessage({
        attachments: [
          { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png', name: 'a.png', size: 3, description: 'a cat' },
          { url: 'https://cdn.discordapp.com/SPOILER_b.mp4', contentType: 'video/mp4', name: 'SPOILER_b.mp4', size: 2 },
        ],
      });

      const outcome = await repostMessage(fake.message, 'look', { fetch });

      expect(outcome.status).toBe('reposted');
      const files = sentPayload(fake).files;
      expect(files.map((f) => f.name)).toEqual(['a.png', 'SPOILER_b.mp4']);
      expect(files[0].description).toBe('a cat');
      expect([...files[0].attachment]).toEqual([1, 2, 3]);
      expect([...files[1].attachment]).toEqual([4, 5]);
    });

    it('leaves the message untouched when an attachment cannot be downloaded', async () => {
      const fetch = attachmentFetch({ 'https://cdn.discordapp.com/a.png': 403 });
      const fake = createFakeMessage({
        attachments: [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png', name: 'a.png', size: 3 }],
      });

      const outcome = await repostMessage(fake.message, 'look', { fetch });

      expect(outcome).toEqual({ status: 'skipped', reason: 'a.png answered HTTP 403' });
      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });

    it('leaves the message untouched when the attachments exceed the cap, without downloading', async () => {
      const fetch = attachmentFetch({});
      const fake = createFakeMessage({
        attachments: [{ url: 'https://cdn.discordapp.com/big.mp4', contentType: 'video/mp4', size: 30 * 1024 * 1024 }],
      });

      const outcome = await repostMessage(fake.message, 'look', { fetch });

      expect(outcome.status).toBe('skipped');
      expect(fetch.urls).toEqual([]);
      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    });

    it('honors LINK_REPOST_MAX_ATTACHMENT_BYTES', async () => {
      vi.stubEnv('LINK_REPOST_MAX_ATTACHMENT_BYTES', '100');
      const fake = createFakeMessage({
        attachments: [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png', size: 101 }],
      });

      expect(repostBlocker(fake.message)).toBe('its attachments total 101 B, over the 100 B repost cap');
    });
  });

  describe('messages that cannot be carried over whole', () => {
    it('refuses messages with stickers (webhooks cannot send them)', async () => {
      const fake = createFakeMessage({ stickers: [{ id: 's1', name: 'pog', format: 1 }] });

      const outcome = await repostMessage(fake.message, 'x', { fetch: noFetch });

      expect(outcome).toEqual({ status: 'skipped', reason: expect.stringContaining('sticker') });
      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });

    it('refuses (before any network work) when the bot lacks Manage Webhooks or Manage Messages', async () => {
      const fake = createFakeMessage({ content: 'x' });
      const message = fake.message as unknown as {
        guild: { members: { me: unknown } };
        channel: { name: string; permissionsFor: (member: unknown) => PermissionsBitField };
      };
      message.guild.members.me = { id: 'bot-1' };
      message.channel.name = 'bagel-bar';
      message.channel.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ManageWebhooks]);

      const outcome = await repostMessage(fake.message, 'y', { fetch: noFetch });

      expect(outcome).toEqual({ status: 'skipped', reason: 'the bot lacks ManageMessages in #bagel-bar' });
      expect(fake.recorders.createWebhook.calls).toHaveLength(0);

      message.channel.permissionsFor = () =>
        new PermissionsBitField([PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages]);
      expect((await repostMessage(fake.message, 'y', { fetch: noFetch })).status).toBe('reposted');
    });

    it('refuses polls', () => {
      expect(repostBlocker(createFakeMessage({ hasPoll: true }).message)).toMatch(/poll/);
    });

    it('refuses a rewritten text too long for a webhook', async () => {
      const fake = createFakeMessage({ content: 'x' });

      const outcome = await repostMessage(fake.message, 'y'.repeat(2001), { fetch: noFetch });

      expect(outcome.status).toBe('skipped');
      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    });
  });

  describe('reply context', () => {
    it('prepends a subtext line naming the replied-to member (server nickname) with a jump link', async () => {
      const fake = createFakeMessage({
        guildId: 'g1',
        channelId: 'c1',
        referencedMessageId: 'm0',
        repliedUserId: 'u2',
        repliedUserDisplayName: 'remi_global',
        repliedMemberDisplayName: 'Remi',
      });

      await repostMessage(fake.message, 'agreed https://fixvx.com/u/status/1', { fetch: noFetch });

      expect(sentPayload(fake).content).toBe(
        '-# ↪ replying to Remi · https://discord.com/channels/g1/c1/m0\nagreed https://fixvx.com/u/status/1',
      );
    });

    it('falls back to fetching the referenced message when Discord sent no replied user', async () => {
      const referenced = createFakeMessage({ messageId: 'm0', authorDisplayName: 'Jasper' }).message;
      const fake = createFakeMessage({ guildId: 'g1', channelId: 'c1', referencedMessageId: 'm0', fetchedMessageById: { m0: referenced } });

      await repostMessage(fake.message, 'yo', { fetch: noFetch });

      expect(sentPayload(fake).content).toBe('-# ↪ replying to Jasper · https://discord.com/channels/g1/c1/m0\nyo');
    });

    it('keeps just the jump link when the replied-to message is gone', async () => {
      const fake = createFakeMessage({ guildId: 'g1', channelId: 'c1', referencedMessageId: 'deleted' });

      await repostMessage(fake.message, 'yo', { fetch: noFetch });

      expect(sentPayload(fake).content).toBe('-# ↪ replying to https://discord.com/channels/g1/c1/deleted\nyo');
    });

    it('adds nothing for forwards', async () => {
      const fake = createFakeMessage({ referencedMessageId: 'm0', referenceType: MessageReferenceType.Forward });

      await repostMessage(fake.message, 'yo', { fetch: noFetch });

      expect(sentPayload(fake).content).toBe('yo');
    });

    it('drops the context line rather than the message when both would not fit', async () => {
      const fake = createFakeMessage({ referencedMessageId: 'm0', repliedUserId: 'u2', repliedUserDisplayName: 'Remi' });
      const body = 'z'.repeat(1990);

      await repostMessage(fake.message, body, { fetch: noFetch });

      expect(sentPayload(fake).content).toBe(body);
    });
  });
});

describe('sendViaWebhook', () => {
  it('posts every payload through one webhook, never pinging unless told to, then deletes the webhook', async () => {
    const fake = createFakeMessage();
    const channel = fake.message.channel as unknown as WebhookParentChannel;

    const sent = await sendViaWebhook(channel, { name: 'Jasper' }, [
      { content: '@everyone part one' },
      { content: 'part two', allowedMentions: { users: ['7'] } },
    ]);

    expect(sent).toHaveLength(2);
    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    const hook = fake.webhooks[0];
    expect(hook.send.calls.map((call) => call[0])).toEqual([
      { content: '@everyone part one', allowedMentions: { parse: [] } },
      { content: 'part two', allowedMentions: { users: ['7'] } },
    ]);
    expect(hook.delete.calls).toHaveLength(1);
  });
});

describe('webhookName', () => {
  it('keeps ordinary names as they are', () => {
    expect(webhookName('Jasper')).toBe('Jasper');
    expect(webhookName('  Jay #1 @home: ok  ')).toBe('Jay #1 @home: ok');
  });

  it('breaks up "clyde" and "discord" (any case), which Discord refuses in webhook names', () => {
    expect(webhookName('Clyde')).toBe('C\u200Alyde');
    expect(webhookName('discordmod')).toBe('d\u200Aiscordmod');
    expect(webhookName('THE DISCORD CLYDE')).toBe('THE D\u200AISCORD C\u200ALYDE');
    for (const name of ['Clyde', 'discordmod', 'THE DISCORD CLYDE', 'xDiScOrDx']) {
      expect(webhookName(name).toLowerCase()).not.toMatch(/clyde|discord/);
    }
  });

  it('fits the 2-80 character range', () => {
    expect(webhookName('J')).toBe('J\u200A');
    expect(webhookName('x'.repeat(100))).toBe('x'.repeat(80));
    expect(webhookName('   ')).toBe('someone');
  });

  it('is what a repost webhook is created with', async () => {
    setBotDbForTesting(new BotDb(':memory:'));
    const fake = createFakeMessage({ authorDisplayName: 'Discord Andy' });

    await repostMessage(fake.message, 'hi', { fetch: noFetch });

    expect((fake.recorders.createWebhook.calls[0][0] as { name: string }).name).toBe('D\u200Aiscord Andy');
    setBotDbForTesting(undefined);
  });
});

describe('webhookTargetOf', () => {
  it.each([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice])(
    'lets channel type %s own the webhook itself',
    (type) => {
      const { message } = createFakeMessage({ channelType: type });
      expect(webhookTargetOf(message.channel)).toEqual({ channel: message.channel });
    },
  );

  it('routes threads through their parent', () => {
    const { message } = createFakeMessage({ channelType: ChannelType.AnnouncementThread, channelId: 't1' });
    expect(webhookTargetOf(message.channel)?.threadId).toBe('t1');
  });

  it('has nothing for DMs', () => {
    expect(webhookTargetOf(createFakeMessage({ channelType: ChannelType.DM }).message.channel)).toBeUndefined();
  });
});

describe('mentionsInText', () => {
  it('counts a mention written in the text, not the ping of a reply to that user', () => {
    const pingedReply = createFakeMessage({
      content: 'lmao',
      referencedMessageId: 'm-1',
      repliedUserId: 'bot-1',
      replyPinged: true,
    }).message;
    expect(pingedReply.mentions.users.has('bot-1')).toBe(true);
    expect(mentionsInText(pingedReply, 'bot-1')).toBe(false);

    for (const content of ['<@bot-1> lmao', 'lmao <@!bot-1>']) {
      const both = createFakeMessage({ content, referencedMessageId: 'm-1', repliedUserId: 'bot-1', replyPinged: true });
      expect(mentionsInText(both.message, 'bot-1')).toBe(true);
    }
    const plain = createFakeMessage({ content: 'hey', mentionedUserIds: ['bot-1'] });
    expect(mentionsInText(plain.message, 'bot-1')).toBe(true);
    expect(mentionsInText(createFakeMessage({ content: 'hey' }).message, 'bot-1')).toBe(false);
  });
});

// Type-only assertion that repostMessage accepts a Message — guards against signature drift.
const _typecheck: (m: Message, c: string) => Promise<RepostOutcome> = repostMessage;
void _typecheck;
