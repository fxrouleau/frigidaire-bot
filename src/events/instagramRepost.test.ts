import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import * as instagramModule from './instagramRepost';
import { re, replaceString } from './instagramRepost';

// The handler is `module.exports = { name, execute }`; it surfaces as the namespace's
// `default` member under Vitest/Vite. `re`/`replaceString` are real named exports.
const instagramEvent = (instagramModule as unknown as {
  default: { name: string; execute: (message: Message) => Promise<void> };
}).default;

describe('instagramRepost', () => {
  describe('regex matching', () => {
    const shouldMatch = [
      'https://www.instagram.com/p/AbCdEf123/',
      'https://instagram.com/p/AbCdEf123/',
      'https://www.instagram.com/reel/AbCdEf123/',
      'https://www.instagram.com/reels/AbCdEf123/',
      'https://www.instagram.com/tv/AbCdEf123/',
      'https://m.instagram.com/p/AbCdEf123/',
      'https://m.instagram.com/reel/AbCdEf123/',
      'http://www.instagram.com/p/AbCdEf123/',
      'https://www.instagram.com/p/AbCdEf123/?utm_source=ig_web',
    ];

    for (const url of shouldMatch) {
      it(`should match: ${url}`, () => {
        expect(re.test(url)).toBe(true);
      });
    }

    const shouldNotMatch = [
      'https://www.instagram.com/username/',
      'https://www.notinstagram.com/p/AbCdEf123/',
      'https://www.instagram.org/p/AbCdEf123/',
      'https://www.instagram.com/stories/user/123/',
      'just some random text',
      'instagram.com/p/AbCdEf123/',
    ];

    for (const url of shouldNotMatch) {
      it(`should NOT match: ${url}`, () => {
        expect(re.test(url)).toBe(false);
      });
    }
  });

  describe('replaceString', () => {
    it('should replace instagram.com with zzinstagram.com for posts', () => {
      expect(replaceString('https://www.instagram.com/p/AbCdEf123/')).toBe(
        'https://www.zzinstagram.com/p/AbCdEf123/',
      );
    });

    it('should replace instagram.com for reels', () => {
      expect(replaceString('https://www.instagram.com/reel/AbCdEf123/')).toBe(
        'https://www.zzinstagram.com/reel/AbCdEf123/',
      );
    });

    it('should strip query params', () => {
      expect(replaceString('https://www.instagram.com/p/AbCdEf123/?utm_source=ig_web')).toBe(
        'https://www.zzinstagram.com/p/AbCdEf123/',
      );
    });

    it('should handle m.instagram.com', () => {
      expect(replaceString('https://m.instagram.com/p/AbCdEf123/')).toBe(
        'https://m.zzinstagram.com/p/AbCdEf123/',
      );
    });
  });

  describe('execute (webhook repost flow)', () => {
    it('reposts a matching instagram link via webhook with the domain replaced', async () => {
      const fake = createFakeMessage({
        content: 'look https://www.instagram.com/p/AbCdEf123/',
      });

      await instagramEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(1);
      expect(fake.recorders.delete.calls).toHaveLength(1);
      expect(fake.webhooks).toHaveLength(1);

      const hook = fake.webhooks[0];
      expect(hook.send.calls).toHaveLength(1);
      expect(hook.send.calls[0][0]).toBe('look https://www.zzinstagram.com/p/AbCdEf123/');
      expect(hook.delete.calls).toHaveLength(1);
    });

    it('reposts reel links', async () => {
      const fake = createFakeMessage({ content: 'https://www.instagram.com/reel/AbCdEf123/' });

      await instagramEvent.execute(fake.message);

      expect(fake.webhooks[0].send.calls[0][0]).toBe('https://www.zzinstagram.com/reel/AbCdEf123/');
    });

    it('does nothing when there is no matching link', async () => {
      const fake = createFakeMessage({ content: 'an instagram profile https://instagram.com/someuser/' });

      await instagramEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });

    it('ignores bot-authored messages even with a matching link', async () => {
      const fake = createFakeMessage({
        authorIsBot: true,
        content: 'https://www.instagram.com/p/AbCdEf123/',
      });

      await instagramEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });
  });
});
