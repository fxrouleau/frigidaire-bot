import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deletedMessageReposter } from '../deletedMessages';
import { resetFixerHealthForTesting } from '../links/embedFixers';
import { createFakeMessage } from '../test-support/fakeDiscord';
import linkRepostEvent from './linkRepost';

const OG_HTML = '<html><head><meta property="og:video" content="https://cdn.example/v.mp4"></head></html>';

function respondWithOg() {
  return new Response(OG_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
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
    expect(fake.webhooks[0].send.calls[0][0]).toBe('look https://ig.test/p/AbCdEf123/');
    expect(fake.recorders.delete.calls).toHaveLength(1);
    expect(fake.webhooks[0].delete.calls).toHaveLength(1);
  });

  it('reposts once with every link rewritten when a message mixes platforms', async () => {
    const fake = createFakeMessage({
      content: 'https://www.tiktok.com/@u/video/1 and https://x.com/u/status/2',
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    expect(fake.webhooks[0].send.calls[0][0]).toBe('https://tt.test/@u/video/1 and https://tw.test/u/status/2');
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

  it('skips channels that cannot own a webhook (threads)', async () => {
    const fake = createFakeMessage({ channelType: ChannelType.PublicThread, content: 'https://x.com/u/status/1' });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('tells the deleted-message reposter the bot is the one deleting the original', async () => {
    const forget = vi.spyOn(deletedMessageReposter, 'forget');
    const fake = createFakeMessage({ content: 'https://x.com/u/status/1', messageId: 'msg-42' });

    await linkRepostEvent.execute(fake.message);

    expect(forget).toHaveBeenCalledWith('msg-42');
  });
});
