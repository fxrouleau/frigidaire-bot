import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import * as twitterModule from './twitterRepost';
import { re, replaceString } from './twitterRepost';

// The handler is `module.exports = { name, execute }`; it surfaces as the namespace's
// `default` member under Vitest/Vite. `re`/`replaceString` are real named exports.
const twitterEvent = (twitterModule as unknown as {
  default: { name: string; execute: (message: Message) => Promise<void> };
}).default;

describe('twitterRepost', () => {
  describe('regex matching', () => {
    const shouldMatch = [
      'https://twitter.com/user/status/1234567890',
      'https://x.com/user/status/1234567890',
      'https://www.twitter.com/user/status/1234567890',
      'https://mobile.twitter.com/user/status/1234567890',
      'https://mobile.x.com/user/status/1234567890',
      'http://twitter.com/user/status/1234567890',
      'https://x.com/user/status/1234567890?s=20&t=abc',
      'https://twitter.com/user_name/status/1234567890',
    ];

    for (const url of shouldMatch) {
      it(`should match: ${url}`, () => {
        expect(re.test(url)).toBe(true);
      });
    }

    const shouldNotMatch = [
      'https://nottwitter.com/user/status/1234567890',
      'https://twitter.org/user/status/1234567890',
      'https://twitter.com/user/1234567890',
      'https://twitter.com/user',
      'just some random text',
      'twitter.com/user/status/1234567890',
    ];

    for (const url of shouldNotMatch) {
      it(`should NOT match: ${url}`, () => {
        expect(re.test(url)).toBe(false);
      });
    }
  });

  describe('replaceString', () => {
    it('should replace twitter.com with fixvx.com', () => {
      expect(replaceString('https://twitter.com/user/status/123')).toBe(
        'https://fixvx.com/user/status/123',
      );
    });

    it('should replace x.com with fixvx.com', () => {
      expect(replaceString('https://x.com/user/status/123')).toBe(
        'https://fixvx.com/user/status/123',
      );
    });

    it('should strip query params', () => {
      expect(replaceString('https://twitter.com/user/status/123?s=20&t=abc')).toBe(
        'https://fixvx.com/user/status/123',
      );
    });

    it('should handle www subdomain', () => {
      expect(replaceString('https://www.twitter.com/user/status/123')).toBe(
        'https://www.fixvx.com/user/status/123',
      );
    });
  });

  describe('execute (webhook repost flow)', () => {
    it('reposts a matching twitter link via webhook with the domain replaced', async () => {
      const fake = createFakeMessage({
        content: 'check this https://twitter.com/user/status/123',
      });

      await twitterEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(1);
      expect(fake.recorders.delete.calls).toHaveLength(1);
      expect(fake.webhooks).toHaveLength(1);

      const hook = fake.webhooks[0];
      expect(hook.send.calls).toHaveLength(1);
      expect(hook.send.calls[0][0]).toBe('check this https://fixvx.com/user/status/123');
      expect(hook.delete.calls).toHaveLength(1);
    });

    it('reposts x.com links too', async () => {
      const fake = createFakeMessage({ content: 'https://x.com/user/status/999' });

      await twitterEvent.execute(fake.message);

      expect(fake.webhooks[0].send.calls[0][0]).toBe('https://fixvx.com/user/status/999');
    });

    it('does nothing when there is no matching link', async () => {
      const fake = createFakeMessage({ content: 'just a normal message with no links' });

      await twitterEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });

    it('ignores bot-authored messages even with a matching link', async () => {
      const fake = createFakeMessage({
        authorIsBot: true,
        content: 'https://twitter.com/user/status/123',
      });

      await twitterEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });
  });
});
