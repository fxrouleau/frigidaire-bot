import { describe, expect, it } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext, htmlPage } from '../../../test-support/fakeSafeFetch';
import { ExtractError } from './common';
import { cleanGifTitle, readGif } from './gif';

// Trimmed-down copies of the real page structures (verified 2026-09 with Discord's crawler UA).
const TENOR_URL = 'https://tenor.com/view/sir-cat-gif-1501192124616773468';
const tenorPage = htmlPage(
  {
    keywords: 'sir cat,gif,animated gif,gifs,meme',
    'og:title': 'Sir Cat Meme - Sir cat - Discover &amp; Share GIFs',
    'og:url': 'https://media1.tenor.com/m/FNVOSJ9lj1wAAAAC/sir-cat.gif',
    'og:image': 'https://media1.tenor.com/m/FNVOSJ9lj1wAAAAC/sir-cat.gif',
    'og:video': ['https://media.tenor.com/FNVOSJ9lj1wAAAPo/sir-cat.mp4', 'https://media.tenor.com/FNVOSJ9lj1wAAAPs/sir-cat.webm'],
  },
  `<div class="Meme"><img src="https://media1.tenor.com/m/FNVOSJ9lj1wAAAAd/sir-cat.gif" width="400" alt="a black cat wearing a striped tie and collar is sitting on the floor ."></div>
   <img src="/assets/img/logo.png" alt="Tenor logo">`,
  `<link rel="canonical" href="${TENOR_URL}">
   <script type="application/ld+json">{"@context":"http://schema.org","@type":"Article","author":"bbruh0","headline":"Sir Cat Meme - Sir cat - Discover & Share GIFs",
   "image":{"@type":"ImageObject","author":"bbruh0","name":"Sir Cat Meme - Sir cat - Discover & Share GIFs","contentUrl":"https://media1.tenor.com/m/FNVOSJ9lj1wAAAAC/sir-cat.gif",
   "thumbnailUrl":"https://media.tenor.com/FNVOSJ9lj1wAAAAe/sir-cat.png","uploadDate":"2026-07-07T20:29:23.600Z"}}</script>`,
);

const KLIPY_GIF_URL = 'https://klipy.com/gifs/cat-reaction-michi-triste';
const klipyGifPage = htmlPage(
  {
    'og:title': 'KLIPY: Cat Reaction Michi Triste GIF – View &amp; Share',
    'og:image': ['https://static2.klipy.com/ii/abc/f6/76/3EqHaEdf.webp', 'https://static2.klipy.com/ii/abc/f6/76/SOXcy67n.gif'],
    'og:video:url': 'https://static2.klipy.com/ii/abc/f6/76/kss7RjCX.mp4',
    'twitter:player:stream': 'https://klipy.com/gifs/cat-reaction-michi-triste/player',
  },
  '<h1>Cat Reaction Michi Triste</h1>',
  `<link rel="canonical" href="${KLIPY_GIF_URL}"/>
   <script type="application/ld+json">{"@context":"https://schema.org","@type":"ImageObject","name":"Cat Reaction Michi Triste",
   "contentUrl":"https://static2.klipy.com/ii/abc/f6/76/SOXcy67n.gif","thumbnailUrl":"https://static2.klipy.com/ii/abc/f6/76/uOgjQfnT.jpg",
   "uploadDate":"2025-07-03T18:24:39.000Z","creator":{"@type":"Person","name":"someuploader"}}</script>`,
);

const KLIPY_CLIP_URL = 'https://klipy.com/clips/are-you-ready-for-it';
const klipyClipPage = htmlPage(
  {
    'og:title': 'KLIPY: Are you ready for it? Clip – View &amp; Share',
    'og:image': 'https://static2.klipy.com/ii/def/0f/e1/ieq2knqn.gif',
    'og:video:url': 'https://static2.klipy.com/ii/def/0f/e1/sGZwFYVR.mp4',
    'og:video:type': 'video/mp4',
    'twitter:player:stream': 'https://klipy.com/clips/are-you-ready-for-it/player',
  },
  '',
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Are you ready for it?",
   "description":"are you ready?, prepared, game face, clip","thumbnailUrl":"https://static2.klipy.com/ii/def/0f/e1/ieq2knqn.gif",
   "contentUrl":"https://static2.klipy.com/ii/def/0f/e1/sGZwFYVR.mp4","uploadDate":"2022-03-20 04:02:18"}</script>`,
);

describe('cleanGifTitle', () => {
  it.each([
    ['Sir Cat Meme - Sir cat - Discover & Share GIFs', 'Sir Cat Meme - Sir cat'],
    ['KLIPY: Cat Reaction Michi Triste GIF – View & Share', 'Cat Reaction Michi Triste'],
    ['KLIPY: Wave Sticker – View & Share', 'Wave'],
    [undefined, undefined],
  ])('cleans %s', (input, expected) => {
    expect(cleanGifTitle(input)).toBe(expected);
  });
});

describe('readGif', () => {
  it('reads a Tenor GIF: name, alt-text description, tags and a static still', async () => {
    const fetch = createFakeSafeFetch({ [TENOR_URL]: { body: tenorPage } });
    const content = await readGif({ source: 'tenor', url: TENOR_URL }, fakeExtractorContext(fetch));
    expect(content).toEqual({
      url: TENOR_URL,
      source: 'tenor',
      kind: 'gif',
      title: 'Sir Cat Meme - Sir cat',
      author: 'bbruh0',
      site: 'Tenor',
      publishedAt: Date.parse('2026-07-07T20:29:23.600Z'),
      text: 'a black cat wearing a striped tie and collar is sitting on the floor.\ntags: sir cat',
      textTruncated: false,
      media: [
        {
          type: 'image',
          url: 'https://media.tenor.com/FNVOSJ9lj1wAAAAe/sir-cat.png',
          alt: 'a black cat wearing a striped tie and collar is sitting on the floor.',
        },
      ],
      notes: undefined,
    });
    expect(fetch.calls[0].options.userAgent).toMatch(/Discordbot/);
  });

  it('reads a Klipy GIF (the picker Discord uses now)', async () => {
    const fetch = createFakeSafeFetch({ [KLIPY_GIF_URL]: { body: klipyGifPage } });
    const content = await readGif({ source: 'klipy', url: KLIPY_GIF_URL, section: 'gifs' }, fakeExtractorContext(fetch));
    expect(content).toMatchObject({
      url: KLIPY_GIF_URL,
      source: 'klipy',
      kind: 'gif',
      title: 'Cat Reaction Michi Triste',
      author: 'someuploader',
      site: 'Klipy',
      media: [
        { type: 'image', url: 'https://static2.klipy.com/ii/abc/f6/76/uOgjQfnT.jpg', alt: 'Cat Reaction Michi Triste' },
      ],
    });
  });

  it('falls back to the animated GIF when the page has no still', async () => {
    const fetch = createFakeSafeFetch({
      'https://tenor.com/view/x-gif-123456789': {
        body: htmlPage({ 'og:title': 'X - Discover &amp; Share GIFs', 'og:image': 'https://media1.tenor.com/m/abc/x.gif' }),
      },
    });
    const content = await readGif({ source: 'tenor', url: 'https://tenor.com/view/x-gif-123456789' }, fakeExtractorContext(fetch));
    expect(content.media).toEqual([{ type: 'image', url: 'https://media1.tenor.com/m/abc/x.gif', alt: 'X' }]);
  });

  it('reads a Klipy clip as a short video with its tags', async () => {
    const fetch = createFakeSafeFetch({ [KLIPY_CLIP_URL]: { body: klipyClipPage } });
    const content = await readGif({ source: 'klipy', url: KLIPY_CLIP_URL, section: 'clips' }, fakeExtractorContext(fetch));
    expect(content).toMatchObject({
      kind: 'video clip',
      title: 'Are you ready for it?',
      text: 'tags: are you ready?, prepared, game face',
      media: [
        { type: 'image', url: 'https://static2.klipy.com/ii/def/0f/e1/ieq2knqn.gif' },
        { type: 'video', url: 'https://static2.klipy.com/ii/def/0f/e1/sGZwFYVR.mp4', contentType: 'video/mp4' },
      ],
    });
  });

  it('reports pages that do not exist, including Tenor 404 pages served as 200', async () => {
    const fetch = createFakeSafeFetch({
      'https://tenor.com/view/gone-gif-123456789': { status: 404, body: '' },
      'https://tenor.com/view/soft-404-gif-123456789': { body: htmlPage({ 'og:title': '404 Error' }) },
    });
    const ctx = fakeExtractorContext(fetch);
    await expect(readGif({ source: 'tenor', url: 'https://tenor.com/view/gone-gif-123456789' }, ctx)).rejects.toBeInstanceOf(ExtractError);
    await expect(readGif({ source: 'tenor', url: 'https://tenor.com/view/soft-404-gif-123456789' }, ctx)).rejects.toBeInstanceOf(ExtractError);
  });

  it('treats server errors as retryable', async () => {
    const fetch = createFakeSafeFetch({ [KLIPY_GIF_URL]: { status: 503, body: 'down' } });
    const error = await readGif({ source: 'klipy', url: KLIPY_GIF_URL, section: 'gifs' }, fakeExtractorContext(fetch)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ExtractError);
  });
});
