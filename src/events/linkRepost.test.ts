import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import * as linkRepostModule from './linkRepost';
import { replaceLinks } from './linkRepost';

// The handler is `module.exports = { name, execute }`; it surfaces as the namespace's
// `default` member under Vitest/Vite. `replaceLinks`/`platforms` are real named exports.
const linkRepostEvent = (
  linkRepostModule as unknown as {
    default: { name: string; execute: (message: Message) => Promise<void> };
  }
).default;

type WebhookSendArg = { content: string; files: string[] };

describe('replaceLinks', () => {
  describe('twitter', () => {
    const shouldFix = [
      'https://twitter.com/user/status/1234567890',
      'https://x.com/user/status/1234567890',
      'https://www.twitter.com/user/status/1234567890',
      'https://mobile.twitter.com/user/status/1234567890',
      'https://mobile.x.com/user/status/1234567890',
      'http://twitter.com/user/status/1234567890',
      'https://x.com/user/status/1234567890?s=20&t=abc',
      'https://twitter.com/user_name/status/1234567890',
    ];
    for (const url of shouldFix) {
      it(`fixes: ${url}`, () => {
        const { content, changed } = replaceLinks(url);
        expect(changed).toBe(true);
        expect(content).toContain('fixvx.com');
      });
    }

    const shouldNotFix = [
      'https://nottwitter.com/user/status/1234567890',
      'https://twitter.org/user/status/1234567890',
      'https://twitter.com/user/1234567890',
      'https://twitter.com/user',
      'just some random text',
      'twitter.com/user/status/1234567890',
    ];
    for (const text of shouldNotFix) {
      it(`does not fix: ${text}`, () => {
        const { content, changed } = replaceLinks(text);
        expect(changed).toBe(false);
        expect(content).toBe(text);
      });
    }

    it('replaces twitter.com with fixvx.com and strips query params', () => {
      expect(replaceLinks('https://twitter.com/user/status/123?s=20&t=abc').content).toBe(
        'https://fixvx.com/user/status/123',
      );
    });

    it('preserves the www subdomain', () => {
      expect(replaceLinks('https://www.twitter.com/user/status/123').content).toBe(
        'https://www.fixvx.com/user/status/123',
      );
    });
  });

  describe('instagram', () => {
    it('replaces instagram.com with zzinstagram.com for posts, reels, and tv', () => {
      expect(replaceLinks('https://instagram.com/p/abc123/').content).toBe('https://zzinstagram.com/p/abc123/');
      expect(replaceLinks('https://www.instagram.com/reel/xyz/?igsh=1').content).toBe(
        'https://www.zzinstagram.com/reel/xyz/',
      );
      expect(replaceLinks('https://instagram.com/tv/qq/').content).toBe('https://zzinstagram.com/tv/qq/');
    });

    it('does not fix profile links', () => {
      expect(replaceLinks('https://instagram.com/someuser').changed).toBe(false);
    });
  });

  describe('tiktok', () => {
    it('replaces tiktok.com with tnktok.com, including vm short links', () => {
      expect(replaceLinks('https://www.tiktok.com/@user/video/123?is_from=x').content).toBe(
        'https://www.tnktok.com/@user/video/123',
      );
      expect(replaceLinks('https://vm.tiktok.com/ZMabcdef/').content).toBe('https://vm.tnktok.com/ZMabcdef/');
    });
  });

  describe('markup safety (regression: trailing markup used to be swallowed and stripped)', () => {
    it('keeps spoiler bars balanced around a spoilered link', () => {
      const { content } = replaceLinks('||https://x.com/u/status/1?s=20||');
      expect(content).toBe('||https://fixvx.com/u/status/1||');
    });

    it('leaves <>-suppressed links completely untouched', () => {
      const input = 'look <https://x.com/u/status/1?s=20> there';
      const { content, changed } = replaceLinks(input);
      expect(changed).toBe(false);
      expect(content).toBe(input);
    });

    it('leaves links inside code blocks and inline code untouched', () => {
      const fenced = '```\nhttps://x.com/u/status/1\n```';
      expect(replaceLinks(fenced).changed).toBe(false);
      const inline = 'see `https://x.com/u/status/1` here';
      expect(replaceLinks(inline).changed).toBe(false);
    });

    it('still fixes links outside code while skipping the ones inside', () => {
      const input = '```\nhttps://x.com/a/status/1\n```\nhttps://x.com/b/status/2';
      const { content, changed } = replaceLinks(input);
      expect(changed).toBe(true);
      expect(content).toBe('```\nhttps://x.com/a/status/1\n```\nhttps://fixvx.com/b/status/2');
    });
  });

  describe('multiple links (regression: only the first link used to be fixed)', () => {
    it('fixes every link of the same platform', () => {
      const { content } = replaceLinks('https://x.com/a/status/1 and https://x.com/b/status/2');
      expect(content).toBe('https://fixvx.com/a/status/1 and https://fixvx.com/b/status/2');
    });

    it('fixes links from different platforms in one pass', () => {
      const { content } = replaceLinks('https://x.com/a/status/1 https://vm.tiktok.com/ZM1/ https://instagram.com/p/z/');
      expect(content).toBe('https://fixvx.com/a/status/1 https://vm.tnktok.com/ZM1/ https://zzinstagram.com/p/z/');
    });
  });
});

describe('execute (webhook repost flow)', () => {
  it('reposts a message with a fixable link via webhook, exactly once for multi-platform messages', async () => {
    const fake = createFakeMessage({
      content: 'check https://twitter.com/user/status/123 and https://vm.tiktok.com/ZM1/',
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    expect(fake.recorders.delete.calls).toHaveLength(1);
    expect(fake.webhooks).toHaveLength(1);

    const hook = fake.webhooks[0];
    expect(hook.send.calls).toHaveLength(1);
    const sent = hook.send.calls[0][0] as WebhookSendArg;
    expect(sent.content).toBe('check https://fixvx.com/user/status/123 and https://vm.tnktok.com/ZM1/');
    expect(hook.delete.calls).toHaveLength(1);
  });

  it('forwards attachment URLs with the repost', async () => {
    const fake = createFakeMessage({
      content: 'https://x.com/user/status/999',
      attachments: [{ url: 'https://cdn.example/photo.png', contentType: 'image/png' }],
    });

    await linkRepostEvent.execute(fake.message);

    const sent = fake.webhooks[0].send.calls[0][0] as WebhookSendArg;
    expect(sent.files).toEqual(['https://cdn.example/photo.png']);
  });

  it('does nothing when there is no fixable link', async () => {
    const fake = createFakeMessage({ content: 'just a normal message with no links' });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('ignores bot-authored messages even with a matching link', async () => {
    const fake = createFakeMessage({
      authorIsBot: true,
      content: 'https://twitter.com/user/status/123',
    });

    await linkRepostEvent.execute(fake.message);

    expect(fake.recorders.createWebhook.calls).toHaveLength(0);
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });

  it('never throws when the repost fails (regression: crash loop in under-permissioned channels)', async () => {
    const fake = createFakeMessage({ content: 'https://x.com/user/status/1' });
    const channel = fake.message.channel as unknown as { createWebhook: () => Promise<unknown> };
    channel.createWebhook = () => Promise.reject(new Error('Missing Permissions'));

    await expect(linkRepostEvent.execute(fake.message)).resolves.toBeUndefined();
    expect(fake.recorders.delete.calls).toHaveLength(0);
  });
});
