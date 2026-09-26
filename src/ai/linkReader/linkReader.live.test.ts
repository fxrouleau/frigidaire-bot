// Live, opt-in canaries against the real sites the link reader depends on. Free (no model calls, no
// key), but they hit the public internet, so they are SKIPPED unless RUN_LIVE=1:
//
//   docker compose run --rm -e RUN_LIVE=1 test yarn test:live
//
// They exist to catch upstream shape changes (FxTwitter's API, Tenor/Klipy page tags, Bluesky's AppView)
// before members notice previews silently degrading. Reddit and the TikTok/Instagram fixers block or
// change often from datacenter IPs, so those only assert that the reader answers something readable.
import { describe, expect, it } from 'vitest';
import { formatLinkForTool } from './format';
import { LinkReader } from './reader';
import type { LinkReadResult } from './types';

const RUN_LIVE = process.env.RUN_LIVE === '1';
const LIVE_TIMEOUT = 45_000;

function content(result: LinkReadResult) {
  if (!result.ok) throw new Error(`read failed: ${result.error}`);
  return result.content;
}

describe.skipIf(!RUN_LIVE)('link reader (live)', () => {
  const reader = new LinkReader({ watchVideo: async () => ({ status: 'unavailable' }) });

  it(
    'reads a tweet through FxTwitter',
    async () => {
      const tweet = content(await reader.read('https://x.com/jack/status/20'));
      expect(tweet).toMatchObject({ source: 'twitter', handle: 'jack', text: 'just setting up my twttr' });
      console.log(`LIVE tweet:\n${formatLinkForTool({ ok: true, content: tweet })}`);
    },
    LIVE_TIMEOUT,
  );

  it(
    'reads a YouTube video',
    async () => {
      const video = content(await reader.read('https://youtu.be/dQw4w9WgXcQ'));
      expect(video.title).toMatch(/Never Gonna Give You Up/);
      expect(video.author).toMatch(/Rick Astley/);
    },
    LIVE_TIMEOUT,
  );

  it(
    'reads a Bluesky post',
    async () => {
      const post = content(await reader.read('https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l'));
      expect(post).toMatchObject({ source: 'bluesky', handle: 'bsky.app' });
      expect(post.text).toMatch(/Bluesky/);
    },
    LIVE_TIMEOUT,
  );

  it(
    'reads Tenor and Klipy GIF pages',
    async () => {
      const tenor = content(await reader.read('https://tenor.com/view/sir-cat-gif-1501192124616773468'));
      expect(tenor).toMatchObject({ kind: 'gif', title: expect.stringMatching(/Sir Cat/i) });
      expect(tenor.media.length).toBeGreaterThan(0);
      const klipy = content(await reader.read('https://klipy.com/gifs/cat-reaction-michi-triste'));
      expect(klipy).toMatchObject({ kind: 'gif', title: 'Cat Reaction Michi Triste' });
      expect(await reader.previewImages(klipy, 1)).toHaveLength(1);
    },
    LIVE_TIMEOUT,
  );

  it(
    'reads an article',
    async () => {
      const article = content(await reader.read('https://en.wikipedia.org/wiki/Refrigerator'));
      expect(article.title).toMatch(/Refrigerator/);
      expect(article.text?.length ?? 0).toBeGreaterThan(1000);
    },
    LIVE_TIMEOUT,
  );

  it(
    'answers something readable for flaky platforms (TikTok, Reddit)',
    async () => {
      for (const url of [
        'https://www.tiktok.com/@scout2015/video/6718335390845095173',
        'https://www.reddit.com/r/AskReddit/comments/1g4rmmd/',
      ]) {
        const result = await reader.read(url);
        console.log(`LIVE ${url}: ${result.ok ? `${result.content.kind} "${result.content.title ?? result.content.text?.slice(0, 60)}"` : result.error}`);
        expect(typeof (result.ok ? result.content.kind : result.error)).toBe('string');
      }
    },
    LIVE_TIMEOUT * 2,
  );

  it('still refuses internal targets', async () => {
    expect(await reader.read('http://169.254.169.254/latest/meta-data/')).toMatchObject({ ok: false });
    expect(await reader.read('http://localhost:8080/')).toMatchObject({ ok: false });
  });
});
