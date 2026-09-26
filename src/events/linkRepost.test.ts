import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deletedMessageReposter } from '../deletedMessages';
import { resetFixerHealthForTesting } from '../links/embedFixers';
import { type FakeMessage, createFakeMessage } from '../test-support/fakeDiscord';
import linkRepostEvent from './linkRepost';

const OG_HTML = '<html><head><meta property="og:video" content="https://cdn.example/v.mp4"></head></html>';

function respondWithOg() {
  return new Response(OG_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
}

function sentPayload(fake: FakeMessage): { content: string; files: Array<{ name: string }>; threadId?: string } {
  return fake.webhooks[0].send.calls[0][0] as { content: string; files: Array<{ name: string }>; threadId?: string };
}

function sentContent(fake: FakeMessage): string {
  return sentPayload(fake).content;
}

describe('linkRepost event', () => {
  beforeEach(() => {
    resetFixerHealthForTesting();
    vi.stubGlobal('fetch', vi.fn(async () => respondWithOg()));
    vi.stubEnv('INSTAGRAM_FIXERS', 'ig.test');
    vi.stubEnv('TIKTOK_FIXERS', 'tt.test');
    vi.stubEnv('TWITTER_FIXERS', 'tw.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exposes the MessageCreate event name', () => {
    expect(linkRepostEvent.name).toBe('messageCreate');
  });

  it('reposts an Instagram link via webhook with a verified fixer domain', async () => {
    const fake = createFakeMessage({ content: 'look https://www.instagram.com/p/AbCdEf123/?igsh=x' });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    expect(sentContent(fake)).toBe('look https://ig.test/p/AbCdEf123/');
    expect(fake.recorders.delete.calls).toHaveLength(1);
    expect(fake.webhooks[0].delete.calls).toHaveLength(1);
  });

  it('reposts once with every link rewritten when a message mixes platforms', async () => {
    const fake = createFakeMessage({
      content: 'https://www.tiktok.com/@u/video/1 and https://x.com/u/status/2',
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    expect(sentContent(fake)).toBe('https://tt.test/@u/video/1 and https://tw.test/u/status/2');
  });

  it('leaves the message alone when no fixer can embed the link', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('', { status: 502 }));
    const fake = createFakeMessage({ content: 'https://www.instagram.com/reel/AbCdEf123/' });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('does nothing (and never probes) for a message without a fixable link', async () => {
    const fake = createFakeMessage({ content: 'an instagram profile https://instagram.com/someuser/' });

    await linkRepostEvent.execute(fake.message);

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
  });

  it('ignores bot-authored and webhook messages even with a matching link', async () => {
    const bot = createFakeMessage({ authorIsBot: true, content: 'https://x.com/u/status/1' });
    const hook = createFakeMessage({ webhookId: 'wh-1', content: 'https://x.com/u/status/1' });

    await linkRepostEvent.execute(bot.message);
    await linkRepostEvent.execute(hook.message);

    expect(bot.recorders.createWebhook.calls).toHaveLength(0);
    expect(hook.recorders.createWebhook.calls).toHaveLength(0);
  });

  it('reposts in threads through the parent channel webhook', async () => {
    const fake = createFakeMessage({
      channelType: ChannelType.PublicThread,
      channelId: 'thread-1',
      content: 'https://x.com/u/status/1',
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.parentCreateWebhook.calls).toHaveLength(1);
    expect(sentPayload(fake)).toMatchObject({ content: 'https://tw.test/u/status/1', threadId: 'thread-1' });
    expect(fake.recorders.delete.calls).toHaveLength(1);
  });

  it('skips archived threads and DMs without probing', async () => {
    const archived = createFakeMessage({
      channelType: ChannelType.PublicThread,
      threadArchived: true,
      content: 'https://x.com/u/status/1',
    });
    const dm = createFakeMessage({ channelType: ChannelType.DM, content: 'https://x.com/u/status/1' });

    await linkRepostEvent.execute(archived.message);
    await linkRepostEvent.execute(dm.message);

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(archived.recorders.parentCreateWebhook.calls).toHaveLength(0);
    expect(dm.recorders.createWebhook.calls).toHaveLength(0);
  });

  it('leaves a message with a sticker alone without probing (webhooks cannot send stickers)', async () => {
    const fake = createFakeMessage({
      content: 'https://x.com/u/status/1',
      stickers: [{ id: 's1', name: 'pog', format: 1 }],
    });

    await linkRepostEvent.execute(fake.message);

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('carries attachments posted with the link over to the repost', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
      String(input).startsWith('https://cdn.discordapp.com/') ? new Response(new Uint8Array([9, 9])) : respondWithOg(),
    );
    const fake = createFakeMessage({
      content: 'https://x.com/u/status/1 same energy',
      attachments: [{ url: 'https://cdn.discordapp.com/me.png', contentType: 'image/png', name: 'me.png', size: 2 }],
    });

    await linkRepostEvent.execute(fake.message);

    expect(sentPayload(fake).files.map((f) => f.name)).toEqual(['me.png']);
    expect(fake.recorders.delete.calls).toHaveLength(1);
  });

  it('keeps the original when its attachment cannot be downloaded', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
      String(input).startsWith('https://cdn.discordapp.com/') ? new Response('', { status: 404 }) : respondWithOg(),
    );
    const fake = createFakeMessage({
      content: 'https://x.com/u/status/1',
      attachments: [{ url: 'https://cdn.discordapp.com/me.png', contentType: 'image/png', name: 'me.png', size: 2 }],
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('keeps a spoilered link spoilered', async () => {
    const fake = createFakeMessage({ content: 'no way ||https://x.com/jasper/status/123||' });

    await linkRepostEvent.execute(fake.message);

    expect(sentContent(fake)).toBe('no way ||https://tw.test/jasper/status/123||');
  });

  it('adds the reply context line when the original was a reply', async () => {
    const fake = createFakeMessage({
      content: 'https://x.com/u/status/1',
      guildId: 'g1',
      channelId: 'c1',
      referencedMessageId: 'm0',
      repliedUserId: 'u2',
      repliedMemberDisplayName: 'Remi',
    });

    await linkRepostEvent.execute(fake.message);

    expect(sentContent(fake)).toBe('-# ↪ replying to Remi · https://discord.com/channels/g1/c1/m0\nhttps://tw.test/u/status/1');
  });

  it('does not repost a message the author edited while its links were being fixed', async () => {
    const fake = createFakeMessage({ content: 'https://x.com/u/status/1' });
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      (fake.message as unknown as { content: string }).content = 'edited https://x.com/u/status/1';
      return respondWithOg();
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('does not repost a message edited while its attachments were being carried over', async () => {
    const fake = createFakeMessage({
      content: 'https://x.com/u/status/1',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', contentType: 'image/png', name: 'pic.png', size: 3 }],
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input).startsWith('https://cdn.discordapp.com/')) {
        // The author fixes a typo while the bot is downloading the attachment.
        (fake.message as unknown as { content: string }).content = 'edited https://x.com/u/status/1';
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return respondWithOg();
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.webhooks.flatMap((hook) => hook.send.calls)).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('logs (and does not throw) when the webhook send fails, keeping the original', async () => {
    const fake = createFakeMessage({
      content: 'https://x.com/u/status/1',
      webhookSendImpl: async () => {
        throw new Error('Missing Permissions');
      },
    });

    await expect(linkRepostEvent.execute(fake.message)).resolves.toBeUndefined();

    expect(fake.recorders.delete.calls).toHaveLength(0);
    expect(fake.webhooks[0].delete.calls).toHaveLength(1);
  });

  it('tells the deleted-message reposter the bot is the one deleting the original', async () => {
    const forget = vi.spyOn(deletedMessageReposter, 'forget');
    const fake = createFakeMessage({ content: 'https://x.com/u/status/1', messageId: 'msg-42' });

    await linkRepostEvent.execute(fake.message);

    expect(forget).toHaveBeenCalledWith('msg-42');
  });
});
