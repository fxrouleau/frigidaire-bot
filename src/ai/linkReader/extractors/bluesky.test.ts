import { describe, expect, it } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext } from '../../../test-support/fakeSafeFetch';
import { parseBlueskyThread, readBluesky } from './bluesky';
import { ExtractError } from './common';

// Shapes verified against public.api.bsky.app getPostThread / getAuthorFeed (2026-09); content is synthetic.
const DID = 'did:plc:abc123';
const author = { did: DID, handle: 'someone.bsky.social', displayName: 'Some One', labels: [] };

const thread = (post: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  $type: 'app.bsky.feed.defs#threadViewPost',
  post: {
    uri: `at://${DID}/app.bsky.feed.post/3kpost`,
    author,
    record: { $type: 'app.bsky.feed.post', text: 'hello bluesky', createdAt: '2026-09-01T12:00:00.000Z', langs: ['en'] },
    likeCount: 5,
    repostCount: 2,
    replyCount: 1,
    quoteCount: 0,
    labels: [],
    ...post,
  },
  ...extra,
});

const target = { actor: 'someone.bsky.social', rkey: '3kpost', url: 'https://bsky.app/profile/someone.bsky.social/post/3kpost' };
const threadUrl = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=';

describe('parseBlueskyThread', () => {
  it('maps a plain post with its parent', () => {
    const content = parseBlueskyThread(
      thread({}, { parent: { $type: 'app.bsky.feed.defs#threadViewPost', post: { author: { handle: 'parent.bsky.social' } } } }),
      'fallback',
    );
    expect(content).toEqual({
      url: 'https://bsky.app/profile/someone.bsky.social/post/3kpost',
      source: 'bluesky',
      kind: 'bluesky post',
      author: 'Some One',
      handle: 'someone.bsky.social',
      publishedAt: Date.parse('2026-09-01T12:00:00.000Z'),
      text: 'hello bluesky',
      textTruncated: false,
      language: 'en',
      quote: undefined,
      replyingTo: 'parent.bsky.social',
      stats: { likes: 5, reposts: 2, replies: 1, quotes: 0 },
      media: [],
      notes: undefined,
    });
  });

  it('reads images, galleries and link cards', () => {
    const images = parseBlueskyThread(
      thread({
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [{ thumb: 't', fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/x/1', alt: 'a dog' }],
        },
      }),
      'f',
    );
    expect(images.media).toEqual([{ type: 'image', url: 'https://cdn.bsky.app/img/feed_fullsize/plain/x/1', alt: 'a dog' }]);

    const gallery = parseBlueskyThread(
      thread({
        embed: {
          $type: 'app.bsky.embed.gallery#view',
          items: Array.from({ length: 6 }, (_, i) => ({ fullsize: `https://cdn.bsky.app/${i}`, alt: '' })),
        },
      }),
      'f',
    );
    expect(gallery.media).toHaveLength(4);

    const card = parseBlueskyThread(
      thread({
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: { uri: 'https://news.example/a', title: 'Headline', description: 'Summary' },
        },
      }),
      'f',
    );
    expect(card.text).toBe('hello bluesky\n\nLink card: Headline — Summary (https://news.example/a)');
  });

  it('turns a video into a direct blob URL through the entryway', () => {
    const content = parseBlueskyThread(
      thread({
        embed: {
          $type: 'app.bsky.embed.video#view',
          cid: 'bafkreivideo',
          playlist: 'https://video.bsky.app/watch/x/playlist.m3u8',
          thumbnail: 'https://video.bsky.app/watch/x/thumbnail.jpg',
          presentation: 'gif',
        },
      }),
      'f',
    );
    expect(content.media).toEqual([
      {
        type: 'video',
        url: 'https://bsky.social/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aabc123&cid=bafkreivideo',
        pageUrl: 'https://video.bsky.app/watch/x/playlist.m3u8',
        thumbnailUrl: 'https://video.bsky.app/watch/x/thumbnail.jpg',
        contentType: 'video/mp4',
        note: 'GIF',
      },
    ]);
  });

  it('reads quote posts, with or without media', () => {
    const quoted = {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: 'at://did:plc:q/app.bsky.feed.post/3kquoted',
      author: { did: 'did:plc:q', handle: 'quoted.example', displayName: 'Quoted' },
      value: { text: 'the original take' },
      embeds: [{ $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/q' }] }],
    };
    const plain = parseBlueskyThread(thread({ embed: { $type: 'app.bsky.embed.record#view', record: quoted } }), 'f');
    expect(plain.quote).toEqual({
      author: 'Quoted',
      handle: 'quoted.example',
      text: 'the original take',
      url: 'https://bsky.app/profile/quoted.example/post/3kquoted',
      media: '1 photo',
    });

    const withMedia = parseBlueskyThread(
      thread({
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: { $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/own' }] },
          record: { record: quoted },
        },
      }),
      'f',
    );
    expect(withMedia.quote?.text).toBe('the original take');
    expect(withMedia.media).toEqual([{ type: 'image', url: 'https://cdn.bsky.app/own', alt: undefined }]);

    const deleted = parseBlueskyThread(
      thread({ embed: { $type: 'app.bsky.embed.record#view', record: { $type: 'app.bsky.embed.record#viewNotFound' } } }),
      'f',
    );
    expect(deleted.quote).toEqual({ text: '[quoted post deleted]' });
  });

  it("respects authors who hide from logged-out viewers", () => {
    const hidden = thread({ author: { ...author, labels: [{ val: '!no-unauthenticated' }] } });
    expect(() => parseBlueskyThread(hidden, 'f')).toThrow(ExtractError);
  });
});

describe('readBluesky', () => {
  it('asks the AppView for the thread by handle-based AT URI', async () => {
    const fetch = createFakeSafeFetch({ [threadUrl]: { body: { thread: thread({}) } } });
    const content = await readBluesky(target, fakeExtractorContext(fetch));
    expect(content.text).toBe('hello bluesky');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toContain(encodeURIComponent('at://someone.bsky.social/app.bsky.feed.post/3kpost'));
  });

  it.each([
    [{ status: 400, body: { error: 'NotFound', message: 'Post not found: at://x' } }, /does not exist/],
    [{ body: { thread: { $type: 'app.bsky.feed.defs#notFoundPost' } } }, /does not exist/],
    [{ body: { thread: { $type: 'app.bsky.feed.defs#blockedPost' } } }, /unavailable/],
  ])('reports missing posts readably (%#)', async (response, message) => {
    const fetch = createFakeSafeFetch({ [threadUrl]: response });
    const error = await readBluesky(target, fakeExtractorContext(fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as Error).message).toMatch(message);
  });

  it('treats server errors as retryable', async () => {
    const fetch = createFakeSafeFetch({ [threadUrl]: { status: 502, body: 'bad gateway', contentType: 'text/html' } });
    const error = await readBluesky(target, fakeExtractorContext(fetch)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ExtractError);
    expect((error as Error).message).toMatch(/HTTP 502/);
  });
});
