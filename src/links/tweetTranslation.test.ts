import { describe, expect, it } from 'vitest';
import { lookupTweetLanguage, shouldTranslate, supportsTranslation } from './tweetTranslation';

describe('shouldTranslate', () => {
  it.each([
    ['ja', 'en', true],
    ['pt-BR', 'en', true],
    ['en', 'en', false],
    ['en-GB', 'en', false],
    ['EN', 'en', false],
    ['fr', 'fr', false],
    ['und', 'en', false],
    ['zxx', 'en', false],
    ['qme', 'en', false],
    ['qht', 'en', false],
    ['art', 'en', false],
    [undefined, 'en', false],
    ['', 'en', false],
  ])('%s → %s: %s', (lang, target, expected) => {
    expect(shouldTranslate(lang, target)).toBe(expected);
  });
});

describe('supportsTranslation', () => {
  it('knows the FxTwitter and vxTwitter domains', () => {
    for (const domain of ['fxtwitter.com', 'fixupx.com', 'fixvx.com', 'vxtwitter.com', 'FIXVX.COM']) {
      expect(supportsTranslation(domain)).toBe(true);
    }
    expect(supportsTranslation('twitter.example')).toBe(false);
  });
});

describe('lookupTweetLanguage', () => {
  const respond = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

  it("reads tweet.lang from FxTwitter's status API", async () => {
    let requested = '';
    const fetchFn = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify({ code: 200, tweet: { lang: 'ja' } }));
    }) as typeof globalThis.fetch;

    expect(await lookupTweetLanguage('1904509839516303592', fetchFn, 4000)).toBe('ja');
    expect(requested).toBe('https://api.fxtwitter.com/status/1904509839516303592');
  });

  it('returns undefined (never throws) for a missing tweet, junk, or a network failure', async () => {
    expect(await lookupTweetLanguage('1', respond(JSON.stringify({ code: 404, tweet: null }), 404), 4000)).toBeUndefined();
    expect(await lookupTweetLanguage('1', respond('null'), 4000)).toBeUndefined();
    expect(await lookupTweetLanguage('1', respond('<html>'), 4000)).toBeUndefined();
    expect(await lookupTweetLanguage('1', respond(JSON.stringify({ tweet: { lang: 7 } })), 4000)).toBeUndefined();
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    expect(await lookupTweetLanguage('1', failing, 4000)).toBeUndefined();
  });

  it('gives up at the time box', async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;

    const started = Date.now();
    expect(await lookupTweetLanguage('1', hanging, 50)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
