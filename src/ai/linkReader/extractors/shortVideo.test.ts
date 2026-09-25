import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext, htmlPage } from '../../../test-support/fakeSafeFetch';
import { ExtractError } from './common';
import { parseAccountTitle, readInstagram, readTikTok } from './shortVideo';

const VIDEO_PATH = '/@some.user/video/7234567890123456789';
const tiktokOEmbed = 'https://www.tiktok.com/oembed?url=';

beforeEach(() => {
  vi.stubEnv('TIKTOK_FIXERS', 'tnktok.com,fixtiktok.com');
  vi.stubEnv('INSTAGRAM_FIXERS', 'instagram7.com,uuinstagram.com,kkinstagram.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readTikTok', () => {
  const target = { path: VIDEO_PATH, url: `https://www.tiktok.com${VIDEO_PATH}` };

  it('combines the official oEmbed with the fixer page video file', async () => {
    const fetch = createFakeSafeFetch({
      [tiktokOEmbed]: {
        body: {
          title: 'dancing fridge #fyp',
          author_name: 'Some User',
          author_unique_id: 'some.user',
          thumbnail_url: 'https://p16.tiktokcdn.example/thumb.jpg',
        },
      },
      [`https://tnktok.com${VIDEO_PATH}`]: {
        body: htmlPage({
          'og:title': 'Some User (@some.user)',
          'og:description': 'dancing fridge #fyp',
          'og:video': 'https://tnktok.com/video/7234567890123456789.mp4',
          'og:video:type': 'video/mp4',
        }),
      },
    });
    const content = await readTikTok(target, fakeExtractorContext(fetch));
    expect(content).toMatchObject({
      url: `https://www.tiktok.com${VIDEO_PATH}`,
      source: 'tiktok',
      kind: 'tiktok',
      author: 'Some User',
      handle: 'some.user',
      text: 'dancing fridge #fyp',
      media: [
        {
          type: 'video',
          url: 'https://tnktok.com/video/7234567890123456789.mp4',
          thumbnailUrl: 'https://p16.tiktokcdn.example/thumb.jpg',
          contentType: 'video/mp4',
        },
      ],
    });
    expect(fetch.calls.find((c) => c.url.startsWith('https://tnktok.com'))?.options.userAgent).toMatch(/Discordbot/);
  });

  it('skips a failing fixer (cooling it down) and uses the next one', async () => {
    const fetch = createFakeSafeFetch({
      [tiktokOEmbed]: { status: 400, body: { code: 400 } },
      'https://tnktok.com/': { status: 502, body: 'bad gateway' },
      [`https://fixtiktok.com${VIDEO_PATH}`]: {
        body: htmlPage({ 'og:title': 'Some User (@some.user)', 'og:description': 'caption from fixer', 'og:image': 'https://img.example/t.jpg' }),
      },
    });
    const ctx = fakeExtractorContext(fetch);
    const content = await readTikTok(target, ctx);
    expect(content).toMatchObject({ author: 'Some User', handle: 'some.user', text: 'caption from fixer' });
    expect(content.media[0]).toMatchObject({ type: 'video', url: undefined, thumbnailUrl: 'https://img.example/t.jpg', note: 'no playable file found' });
    expect(ctx.cooledDown.has('fixer:tnktok.com')).toBe(true);
  });

  it('resolves vm.tiktok.com short links through TikTok first', async () => {
    const fetch = createFakeSafeFetch({
      'https://vm.tiktok.com/ZMabc123/': { status: 301, location: `https://www.tiktok.com${VIDEO_PATH}?_r=1` },
      [tiktokOEmbed]: { body: { title: 'caption', author_name: 'Some User' } },
      'https://tnktok.com/': { status: 404, body: '' },
      'https://fixtiktok.com/': { status: 404, body: '' },
    });
    const content = await readTikTok({ path: '/t/ZMabc123', url: 'https://vm.tiktok.com/ZMabc123/' }, fakeExtractorContext(fetch));
    expect(content.url).toBe(`https://www.tiktok.com${VIDEO_PATH}`);
    expect(content.handle).toBe('some.user');
    expect(fetch.calls.map((c) => c.url)).toContain(`https://tnktok.com${VIDEO_PATH}`);
  });

  it('fails readably when nothing answers', async () => {
    const fetch = createFakeSafeFetch({ [tiktokOEmbed]: { status: 404, body: {} } });
    await expect(readTikTok(target, fakeExtractorContext(fetch))).rejects.toBeInstanceOf(ExtractError);
  });
});

describe('readInstagram', () => {
  it('reads a reel from the first working fixer, resolving relative og:video URLs', async () => {
    const fetch = createFakeSafeFetch({
      'https://instagram7.com/': new Error('getaddrinfo ENOTFOUND instagram7.com'),
      'https://uuinstagram.com/reel/C1a2b3c4d5/': {
        body: htmlPage({
          'og:title': 'Some Creator (@creator)',
          'og:description': 'reel caption',
          'og:video': '/videos/C1a2b3c4d5/1',
          'og:video:type': 'video/mp4',
          'og:image': 'https://uuinstagram.com/images/C1a2b3c4d5/1',
        }),
      },
    });
    const ctx = fakeExtractorContext(fetch);
    const content = await readInstagram({ path: '/reel/C1a2b3c4d5/', url: 'https://www.instagram.com/reel/C1a2b3c4d5/' }, ctx);
    expect(content).toMatchObject({
      url: 'https://www.instagram.com/reel/C1a2b3c4d5/',
      kind: 'instagram reel',
      author: 'Some Creator',
      handle: 'creator',
      text: 'reel caption',
      media: [{ type: 'video', url: 'https://uuinstagram.com/videos/C1a2b3c4d5/1', thumbnailUrl: 'https://uuinstagram.com/images/C1a2b3c4d5/1' }],
    });
    expect(ctx.cooledDown.has('fixer:instagram7.com')).toBe(true);
  });

  it('uses a fixer that redirects straight to the media file', async () => {
    const fetch = createFakeSafeFetch({
      'https://instagram7.com/': { status: 404, body: '' },
      'https://uuinstagram.com/': { status: 404, body: '' },
      'https://kkinstagram.com/reel/C1a2b3c4d5/': {
        finalUrl: 'https://scontent.cdninstagram.example/v/reel.mp4',
        contentType: 'video/mp4',
        headers: { 'content-length': '2048000' },
        body: Buffer.alloc(4),
      },
      'https://www.instagram.com/reel/C1a2b3c4d5/': {
        body: htmlPage({ 'og:title': '@creator • Instagram reel', 'og:image': 'https://scontent.example/thumb.jpg' }),
      },
    });
    const content = await readInstagram({ path: '/reel/C1a2b3c4d5/', url: 'u' }, fakeExtractorContext(fetch));
    expect(content).toMatchObject({
      kind: 'instagram reel',
      handle: 'creator',
      notes: ['caption unavailable'],
      media: [{ type: 'video', url: 'https://scontent.cdninstagram.example/v/reel.mp4', sizeBytes: 2048000 }],
    });
  });

  it('reads photo posts as images', async () => {
    const fetch = createFakeSafeFetch({
      'https://instagram7.com/p/C1a2b3c4d5/': {
        body: htmlPage({ 'og:title': 'Someone (@someone)', 'og:description': 'beach day', 'og:image': 'https://img.example/1.jpg' }),
      },
    });
    const content = await readInstagram({ path: '/p/C1a2b3c4d5/', url: 'u' }, fakeExtractorContext(fetch));
    expect(content).toMatchObject({ kind: 'instagram post', text: 'beach day', media: [{ type: 'image', url: 'https://img.example/1.jpg' }] });
  });

  it('treats a bounce to the login wall as a miss and reports an unreadable post', async () => {
    const fetch = createFakeSafeFetch({
      'https://instagram7.com/': { finalUrl: 'https://www.instagram.com/accounts/login/', body: htmlPage({ 'og:title': 'Login' }) },
      'https://uuinstagram.com/': { status: 404, body: '' },
      'https://kkinstagram.com/': { status: 404, body: '' },
      'https://www.instagram.com/': { finalUrl: 'https://www.instagram.com/accounts/login/', body: htmlPage({ 'og:title': 'Login' }) },
    });
    await expect(readInstagram({ path: '/reel/C1a2b3c4d5/', url: 'u' }, fakeExtractorContext(fetch))).rejects.toBeInstanceOf(ExtractError);
  });

  it('resolves share links, and reports ones that do not resolve', async () => {
    const fetch = createFakeSafeFetch({
      'https://www.instagram.com/share/BAabc123/': { status: 302, location: 'https://www.instagram.com/reel/C1a2b3c4d5/?igsh=x' },
      'https://www.instagram.com/share/BAdead/': { status: 200, body: htmlPage({}) },
      'https://instagram7.com/reel/C1a2b3c4d5/': { body: htmlPage({ 'og:title': 'X (@x)', 'og:description': 'cap' }) },
    });
    const ctx = fakeExtractorContext(fetch);
    const content = await readInstagram({ path: '/share/BAabc123/', url: 'u' }, ctx);
    expect(content.url).toBe('https://www.instagram.com/reel/C1a2b3c4d5/');
    await expect(readInstagram({ path: '/share/BAdead/', url: 'u' }, ctx)).rejects.toThrow(/share link/);
  });
});

describe('parseAccountTitle', () => {
  it.each([
    ['Some User (@some.user)', { author: 'Some User', handle: 'some.user' }],
    ['Verified Person ✔ (@vp) • Instagram reel', { author: 'Verified Person', handle: 'vp' }],
    ['@creator • Instagram reel', { handle: 'creator' }],
    ['@creator', { handle: 'creator' }],
    ['Some Creator on Instagram: "caption"', { author: 'Some Creator' }],
    ['Instagram', {}],
  ])('parses %s', (title, expected) => {
    expect(parseAccountTitle(title)).toEqual(expected);
  });
});
