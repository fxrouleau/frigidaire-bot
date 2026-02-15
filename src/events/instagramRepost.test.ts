import { describe, expect, it } from 'vitest';
import { re, replaceString } from './instagramRepost';

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
});
