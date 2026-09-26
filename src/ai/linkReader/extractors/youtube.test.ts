import { describe, expect, it } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext, htmlPage } from '../../../test-support/fakeSafeFetch';
import { ExtractError } from './common';
import { extractPlayerResponse, parseWatchPage, readYouTube, sliceJsonObject } from './youtube';

const player = {
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: 'abcdefghijk',
    title: 'A Video {with braces}',
    author: 'Some Channel',
    shortDescription: 'Line one\nLine "two" with } brace',
    lengthSeconds: '212',
    viewCount: '1234567',
    isLiveContent: false,
  },
  microformat: { playerMicroformatRenderer: { publishDate: '2026-09-01T10:00:00-07:00', category: 'Comedy' } },
};

const watchPage = (response: unknown) =>
  htmlPage(
    { 'og:title': 'OG title', 'og:description': 'OG description' },
    `<script>var ytInitialPlayerResponse = ${JSON.stringify(response)};var meta = {"x": 1};</script>`,
  );

const target = { videoId: 'abcdefghijk', isShort: false, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
const oembedUrl = 'https://www.youtube.com/oembed?format=json&url=';
const watchUrl = 'https://www.youtube.com/watch?v=abcdefghijk&hl=en';

describe('player response parsing', () => {
  it('slices a JSON object literal with braces inside strings', () => {
    const text = 'x = {"a":"}{","b":{"c":1}}; more';
    expect(sliceJsonObject(text, text.indexOf('{'))).toBe('{"a":"}{","b":{"c":1}}');
    expect(sliceJsonObject('{"unterminated": 1', 0)).toBeUndefined();
  });

  it('extracts and parses the embedded player response', () => {
    expect(extractPlayerResponse(watchPage(player))?.videoDetails).toMatchObject({ title: 'A Video {with braces}' });
    expect(extractPlayerResponse('<html>no player</html>')).toBeUndefined();
  });

  it('parses the watch page details', () => {
    expect(parseWatchPage(watchPage(player), watchUrl)).toEqual({
      title: 'A Video {with braces}',
      channel: 'Some Channel',
      description: 'Line one\nLine "two" with } brace',
      durationSecs: 212,
      views: 1234567,
      publishedAt: Date.parse('2026-09-01T10:00:00-07:00'),
      category: 'Comedy',
      isLive: false,
      playability: undefined,
    });
  });

  it('notes age-restricted videos', () => {
    const restricted = { ...player, playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' } };
    expect(parseWatchPage(watchPage(restricted), watchUrl).playability).toBe('age-restricted or sign-in required');
  });
});

describe('readYouTube', () => {
  it('combines oEmbed and the watch page', async () => {
    const fetch = createFakeSafeFetch({
      [oembedUrl]: { body: { title: 'oEmbed title', author_name: 'oEmbed channel' } },
      [watchUrl]: { body: watchPage(player) },
    });
    const content = await readYouTube(target, fakeExtractorContext(fetch));
    expect(content).toMatchObject({
      source: 'youtube',
      kind: 'youtube video',
      title: 'A Video {with braces}',
      author: 'Some Channel',
      site: 'YouTube · Comedy',
      text: 'Line one\nLine "two" with } brace',
      stats: { views: 1234567 },
    });
    expect(content.media[0]).toMatchObject({ type: 'video', durationSecs: 212, thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' });
    expect(content.media[0]).not.toHaveProperty('url');
    // The watch page is only served whole to Discord's crawler from server IPs.
    expect(fetch.calls.find((c) => c.url === watchUrl)?.options.userAgent).toMatch(/Discordbot/);
  });

  it('goes by oEmbed alone when the watch page is a consent/bot wall', async () => {
    const fetch = createFakeSafeFetch({
      [oembedUrl]: { body: { title: 'oEmbed title', author_name: 'oEmbed channel' } },
      [watchUrl]: { finalUrl: 'https://consent.youtube.com/m?continue=x', body: htmlPage({ 'og:title': 'Before you continue' }) },
    });
    const content = await readYouTube({ ...target, isShort: true }, fakeExtractorContext(fetch));
    expect(content).toMatchObject({ kind: 'youtube short', title: 'oEmbed title', author: 'oEmbed channel', notes: ['description unavailable'] });
  });

  it('reports private or removed videos', async () => {
    const fetch = createFakeSafeFetch({
      [oembedUrl]: { status: 401, body: 'Unauthorized', contentType: 'text/html' },
      [watchUrl]: { body: '<html><title>YouTube</title></html>' },
    });
    await expect(readYouTube(target, fakeExtractorContext(fetch))).rejects.toBeInstanceOf(ExtractError);
  });

  it('fails (retryably) when YouTube answers nothing useful at all', async () => {
    const fetch = createFakeSafeFetch({ [oembedUrl]: new Error('timeout'), [watchUrl]: new Error('timeout') });
    const error = await readYouTube(target, fakeExtractorContext(fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExtractError);
  });
});
