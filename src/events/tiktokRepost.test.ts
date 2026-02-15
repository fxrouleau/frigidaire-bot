import { describe, expect, it } from 'vitest';
import { re, replaceString } from './tiktokRepost';

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
});
