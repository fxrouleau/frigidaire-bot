import { describe, expect, it } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext, htmlPage } from '../../../test-support/fakeSafeFetch';
import { ExtractError } from './common';
import { parseRedditJson, readReddit } from './reddit';

// Shape of https://www.reddit.com/comments/<id>/.json (listing pair); content is synthetic.
const listing = (post: Record<string, unknown>, comments: unknown[] = []) => [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: post }] } },
  { kind: 'Listing', data: { children: comments } },
];

const post = {
  title: 'My fridge makes a noise',
  author: 'poster',
  subreddit_name_prefixed: 'r/appliances',
  selftext: 'It hums at night.',
  is_self: true,
  score: 321,
  num_comments: 12,
  created_utc: 1_758_000_000,
  permalink: '/r/appliances/comments/1abcde/my_fridge_makes_a_noise/',
  link_flair_text: 'Help',
  over_18: false,
};

const comment = (author: string, body: string, extra: Record<string, unknown> = {}) => ({
  kind: 't1',
  data: { author, body, score: 10, ...extra },
});

const jsonUrl = 'https://www.reddit.com/comments/1abcde/.json';
const target = { postId: '1abcde', url: 'https://www.reddit.com/r/appliances/comments/1abcde/my_fridge_makes_a_noise/' };

describe('parseRedditJson', () => {
  it('maps the post and its top comments, skipping stickied/deleted ones', () => {
    const content = parseRedditJson(
      listing(post, [
        comment('automod', 'rules reminder', { stickied: true }),
        comment('a', 'check the compressor'),
        comment('b', '[deleted]'),
        comment('c', 'mine does that too'),
        { kind: 'more', data: {} },
      ]),
      'fallback',
    );
    expect(content).toMatchObject({
      url: 'https://www.reddit.com/r/appliances/comments/1abcde/my_fridge_makes_a_noise/',
      source: 'reddit',
      kind: 'reddit post',
      title: 'My fridge makes a noise',
      author: 'u/poster',
      site: 'r/appliances',
      publishedAt: 1_758_000_000_000,
      text: 'It hums at night.',
      stats: { score: 321, comments: 12 },
      notes: ['flair: Help'],
      comments: [
        { author: 'u/a', text: 'check the compressor', score: 10 },
        { author: 'u/c', text: 'mine does that too', score: 10 },
      ],
    });
  });

  it('describes link posts, galleries and Reddit-hosted videos', () => {
    const link = parseRedditJson(listing({ ...post, is_self: false, selftext: '', url_overridden_by_dest: 'https://news.example/a' }), 'f');
    expect(link?.text).toBe('(links to https://news.example/a)');

    const gallery = parseRedditJson(
      listing({
        ...post,
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'm2' }, { media_id: 'm1' }] },
        media_metadata: { m1: { s: { u: 'https://preview.redd.it/1.jpg' } }, m2: { s: { u: 'https://preview.redd.it/2.jpg' } } },
      }),
      'f',
    );
    expect(gallery?.media).toEqual([
      { type: 'image', url: 'https://preview.redd.it/2.jpg' },
      { type: 'image', url: 'https://preview.redd.it/1.jpg' },
    ]);

    const video = parseRedditJson(
      listing({ ...post, secure_media: { reddit_video: { fallback_url: 'https://v.redd.it/x/DASH_720.mp4', duration: 31 } } }),
      'f',
    );
    expect(video?.media[0]).toMatchObject({ type: 'video', url: 'https://v.redd.it/x/DASH_720.mp4', durationSecs: 31, note: 'no audio track' });
  });

  it('returns undefined for JSON that is not a post listing', () => {
    expect(parseRedditJson({ error: 403 }, 'f')).toBeUndefined();
  });
});

describe('readReddit', () => {
  it('reads the JSON view', async () => {
    const fetch = createFakeSafeFetch({ [jsonUrl]: { body: listing(post) } });
    const content = await readReddit(target, fakeExtractorContext(fetch));
    expect(content.title).toBe('My fridge makes a noise');
    expect(fetch.calls).toHaveLength(1);
  });

  it('falls back to the post page when the JSON view is blocked, and stops trying JSON for a while', async () => {
    const fetch = createFakeSafeFetch({
      [jsonUrl]: { status: 403, contentType: 'text/html', body: '<html>blocked</html>' },
      [target.url]: {
        body: htmlPage(
          { description: 'It hums at night.', 'og:image': 'https://share.redd.it/preview/post/1abcde' },
          '',
          '<title>My fridge makes a noise : r/appliances</title>',
        ),
      },
    });
    const ctx = fakeExtractorContext(fetch);
    const content = await readReddit(target, ctx);
    expect(content).toMatchObject({
      title: 'My fridge makes a noise',
      site: 'r/appliances',
      text: 'It hums at night.',
      media: [{ type: 'image', url: 'https://share.redd.it/preview/post/1abcde' }],
    });
    expect(ctx.cooledDown.has('reddit-json')).toBe(true);

    await readReddit(target, ctx);
    expect(fetch.calls.filter((c) => c.url.startsWith(jsonUrl))).toHaveLength(1);
  });

  it('reports deleted posts', async () => {
    const fetch = createFakeSafeFetch({ [jsonUrl]: { status: 404, body: { error: 404 } } });
    await expect(readReddit(target, fakeExtractorContext(fetch))).rejects.toBeInstanceOf(ExtractError);
  });

  it('resolves share links through their redirect first', async () => {
    const fetch = createFakeSafeFetch({
      'https://www.reddit.com/r/appliances/s/AbC123': {
        status: 301,
        location: 'https://www.reddit.com/r/appliances/comments/1abcde/my_fridge_makes_a_noise/?share_id=x',
      },
      [jsonUrl]: { body: listing(post) },
    });
    const content = await readReddit({ url: 'https://www.reddit.com/r/appliances/s/AbC123' }, fakeExtractorContext(fetch));
    expect(content.title).toBe('My fridge makes a noise');
    expect(fetch.calls[0].options.redirect).toBe('manual');
  });

  it('reports share links that do not resolve', async () => {
    const fetch = createFakeSafeFetch({ 'https://www.reddit.com/r/x/s/Nope': { status: 404, body: '' } });
    await expect(readReddit({ url: 'https://www.reddit.com/r/x/s/Nope' }, fakeExtractorContext(fetch))).rejects.toThrow(
      /couldn't resolve that Reddit share link/,
    );
  });
});
