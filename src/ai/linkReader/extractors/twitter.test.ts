import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext, htmlPage } from '../../../test-support/fakeSafeFetch';
import { ExtractError } from './common';
import { mediumTwitterImage, parseFxStatus, readTweet } from './twitter';

// Shape verified against https://api.fxtwitter.com/2/status/<id> (2026-09); content is synthetic.
const status = {
  type: 'status',
  url: 'https://x.com/someone/status/111',
  id: '111',
  text: 'これはテストです',
  author: { screen_name: 'someone', name: 'Some One' },
  replies: 3,
  reposts: 10,
  likes: 1234,
  quotes: 2,
  views: 45678,
  created_timestamp: 1_758_000_000,
  lang: 'ja',
  translation: { text: 'This is a test', source_lang: 'ja', source_lang_en: 'Japanese', target_lang: 'en', provider: 'x' },
  replying_to: { screen_name: 'other' },
  community_note: { text: 'Readers added context' },
  media: {
    photos: [{ type: 'photo', url: 'https://pbs.twimg.com/media/AbC.jpg?name=orig', altText: 'a cat' }],
    videos: [
      {
        type: 'video',
        url: 'https://video.twimg.com/vid/1920x1080/big.mp4',
        thumbnail_url: 'https://pbs.twimg.com/thumb.jpg',
        duration: 9.3,
        formats: [
          { url: 'https://video.twimg.com/pl/list.m3u8', container: 'm3u8' },
          { url: 'https://video.twimg.com/vid/480x270/small.mp4', bitrate: 256000, container: 'mp4' },
          { url: 'https://video.twimg.com/vid/640x360/medium.mp4', bitrate: 832000, container: 'mp4' },
          { url: 'https://video.twimg.com/vid/1920x1080/big.mp4', bitrate: 10368000, container: 'mp4' },
        ],
      },
    ],
  },
  quote: {
    url: 'https://x.com/quoted/status/99',
    text: 'the quoted post',
    author: { screen_name: 'quoted', name: 'Quoted Person' },
    media: { photos: [{ url: 'https://pbs.twimg.com/media/q.jpg' }, { url: 'https://pbs.twimg.com/media/q2.jpg' }] },
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseFxStatus', () => {
  it('maps text, author, stats, translation, quote, reply, note and media', () => {
    const content = parseFxStatus(status, 'https://x.com/i/status/111');
    expect(content).toMatchObject({
      url: 'https://x.com/someone/status/111',
      source: 'twitter',
      kind: 'tweet',
      author: 'Some One',
      handle: 'someone',
      publishedAt: 1_758_000_000_000,
      text: 'これはテストです',
      language: 'ja',
      translation: { from: 'ja', text: 'This is a test' },
      replyingTo: 'other',
      stats: { likes: 1234, reposts: 10, replies: 3, quotes: 2, views: 45678 },
      quote: { author: 'Quoted Person', handle: 'quoted', text: 'the quoted post', media: '2 photos', url: 'https://x.com/quoted/status/99' },
      notes: ['community note: Readers added context'],
    });
    expect(content.media).toEqual([
      { type: 'image', url: 'https://pbs.twimg.com/media/AbC.jpg?name=medium', alt: 'a cat' },
      {
        type: 'video',
        // The best mp4 at or under ~1 Mbps: plenty for video understanding, a fraction of the download.
        url: 'https://video.twimg.com/vid/640x360/medium.mp4',
        thumbnailUrl: 'https://pbs.twimg.com/thumb.jpg',
        durationSecs: 9.3,
        contentType: 'video/mp4',
      },
    ]);
  });

  it('omits the translation for English posts and renders polls', () => {
    const content = parseFxStatus(
      {
        ...status,
        lang: 'en',
        text: 'vote',
        translation: undefined,
        poll: { choices: [{ label: 'yes', percentage: 60 }, { label: 'no', percentage: 40 }], total_votes: 10 },
      },
      'u',
    );
    expect(content.translation).toBeUndefined();
    expect(content.text).toBe('vote\n\nPoll: yes — 60% · no — 40% (10 votes)');
  });
});

describe('mediumTwitterImage', () => {
  it('only rewrites pbs.twimg.com media URLs', () => {
    expect(mediumTwitterImage('https://pbs.twimg.com/media/x.jpg')).toBe('https://pbs.twimg.com/media/x.jpg?name=medium');
    expect(mediumTwitterImage('https://example.com/media/x.jpg')).toBe('https://example.com/media/x.jpg');
  });
});

describe('readTweet', () => {
  const api = 'https://api.fxtwitter.com/2/status/111?lang=en';

  it('reads through the FxTwitter API', async () => {
    const fetch = createFakeSafeFetch({ [api]: { body: { code: 200, status } } });
    const content = await readTweet('111', 'https://x.com/i/status/111', fakeExtractorContext(fetch));
    expect(content.author).toBe('Some One');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].options.userAgent).toMatch(/FrigidaireBot/);
  });

  it.each([
    [404, /does not exist/],
    [401, /private account/],
  ])('reports HTTP %s as a readable failure without fallbacks', async (code, message) => {
    const fetch = createFakeSafeFetch({ [api]: { status: code, body: { code, status: null } } });
    const error = await readTweet('111', 'u', fakeExtractorContext(fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as Error).message).toMatch(message);
    expect(fetch.calls).toHaveLength(1);
  });

  it('falls back to a fixer embed page when the API is down', async () => {
    vi.stubEnv('TWITTER_FIXERS', 'fixvx.com,fxtwitter.com');
    const fetch = createFakeSafeFetch({
      [api]: { status: 503, body: { code: 500, message: 'upstream' } },
      'https://fixvx.com/i/status/111': {
        body: htmlPage({
          'og:title': 'Some One (@someone)',
          'og:description': 'tweet text from the embed',
          'og:image': 'https://pbs.twimg.com/media/AbC.jpg',
        }),
      },
    });
    const content = await readTweet('111', 'https://x.com/i/status/111', fakeExtractorContext(fetch));
    expect(content).toMatchObject({
      author: 'Some One',
      handle: 'someone',
      text: 'tweet text from the embed',
      media: [{ type: 'image', url: 'https://pbs.twimg.com/media/AbC.jpg?name=medium' }],
    });
    expect(content.notes?.[0]).toMatch(/embed page/);
  });

  it('rethrows the API error when every fallback fails too', async () => {
    vi.stubEnv('TWITTER_FIXERS', 'fixvx.com');
    const fetch = createFakeSafeFetch({ [api]: new Error('socket hang up'), 'https://fixvx.com/': { status: 500, body: '' } });
    await expect(readTweet('111', 'u', fakeExtractorContext(fetch))).rejects.toThrow('socket hang up');
  });
});
