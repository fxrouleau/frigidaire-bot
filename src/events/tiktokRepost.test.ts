import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import * as tiktokModule from './tiktokRepost';
import { re, replaceString } from './tiktokRepost';

// The handler is `module.exports = { name, execute }`; it surfaces as the namespace's
// `default` member under Vitest/Vite. `re`/`replaceString` are real named exports.
const tiktokEvent = (tiktokModule as unknown as {
  default: { name: string; execute: (message: Message) => Promise<void> };
}).default;

describe('tiktokRepost', () => {
  describe('regex matching', () => {
    const shouldMatch = [
      'https://tiktok.com/something',
      'https://www.tiktok.com/@user/video/1234567890',
      'https://vm.tiktok.com/ZMhAbCdEf/',
      'https://vt.tiktok.com/ZSaBcDeFg/',
      'https://m.tiktok.com/v/1234567890.html',
      'https://t.tiktok.com/ZSxYz/',
      'http://vm.tiktok.com/ZMhAbCdEf/',
      'https://www.tiktok.com/@user/video/1234567890?is_from_webapp=1',
    ];

    for (const url of shouldMatch) {
      it(`should match: ${url}`, () => {
        expect(re.test(url)).toBe(true);
      });
    }

    const shouldNotMatch = [
      'https://notatiktok.com/something',
      'https://faketiktok.com.evil.com/path',
      'https://tiktok.org/something',
      'just some random text',
      'https://tiktok.com',
      'tiktok.com/something',
    ];

    for (const url of shouldNotMatch) {
      it(`should NOT match: ${url}`, () => {
        expect(re.test(url)).toBe(false);
      });
    }
  });

  describe('replaceString', () => {
    it('should replace tiktok.com with tnktok.com', () => {
      expect(replaceString('https://www.tiktok.com/@user/video/123')).toBe(
        'https://www.tnktok.com/@user/video/123',
      );
    });

    it('should replace vm.tiktok.com', () => {
      expect(replaceString('https://vm.tiktok.com/ZMhAbCdEf/')).toBe(
        'https://vm.tnktok.com/ZMhAbCdEf/',
      );
    });

    it('should replace vt.tiktok.com', () => {
      expect(replaceString('https://vt.tiktok.com/ZSaBcDeFg/')).toBe(
        'https://vt.tnktok.com/ZSaBcDeFg/',
      );
    });

    it('should strip query params', () => {
      expect(replaceString('https://www.tiktok.com/@user/video/123?is_from_webapp=1')).toBe(
        'https://www.tnktok.com/@user/video/123',
      );
    });
  });

  describe('execute (webhook repost flow)', () => {
    it('reposts a matching tiktok link via webhook with the domain replaced', async () => {
      const fake = createFakeMessage({
        content: 'watch https://www.tiktok.com/@user/video/123',
      });

      await tiktokEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(1);
      expect(fake.recorders.delete.calls).toHaveLength(1);
      expect(fake.webhooks).toHaveLength(1);

      const hook = fake.webhooks[0];
      expect(hook.send.calls).toHaveLength(1);
      expect(hook.send.calls[0][0]).toBe('watch https://www.tnktok.com/@user/video/123');
      expect(hook.delete.calls).toHaveLength(1);
    });

    it('reposts vm.tiktok.com short links', async () => {
      const fake = createFakeMessage({ content: 'https://vm.tiktok.com/ZMhAbCdEf/' });

      await tiktokEvent.execute(fake.message);

      expect(fake.webhooks[0].send.calls[0][0]).toBe('https://vm.tnktok.com/ZMhAbCdEf/');
    });

    it('does nothing when there is no matching link', async () => {
      const fake = createFakeMessage({ content: 'no video here, just text' });

      await tiktokEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });

    it('ignores bot-authored messages even with a matching link', async () => {
      const fake = createFakeMessage({
        authorIsBot: true,
        content: 'https://www.tiktok.com/@user/video/123',
      });

      await tiktokEvent.execute(fake.message);

      expect(fake.recorders.createWebhook.calls).toHaveLength(0);
      expect(fake.recorders.delete.calls).toHaveLength(0);
    });
  });
});
