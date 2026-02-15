import { describe, expect, it } from 'vitest';
import { re, replaceString } from './twitterRepost';

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
});
