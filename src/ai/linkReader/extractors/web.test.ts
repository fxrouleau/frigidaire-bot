import { describe, expect, it } from 'vitest';
import { createFakeSafeFetch, fakeExtractorContext, htmlPage } from '../../../test-support/fakeSafeFetch';
import { ExtractError } from './common';
import { parseHtmlPage, readWebPage } from './web';

const notPlatform = () => false;
const story = 'The council voted on Tuesday to replace every fridge in the building with a newer model. '.repeat(5);

describe('parseHtmlPage', () => {
  it('prefers the JSON-LD article body and metadata', () => {
    const html = htmlPage(
      { 'og:title': 'Fridges Replaced', 'og:site_name': 'Daily Example', 'og:image': 'https://img.example/cover.jpg', 'og:type': 'article' },
      '<nav>menu</nav><article><p>page text that should not be used</p></article>',
      `<script type="application/ld+json">{"@type":"NewsArticle","headline":"Fridges Replaced","author":{"name":"Jane Reporter"},
        "datePublished":"2026-09-20T09:00:00-04:00","articleBody":${JSON.stringify(story)}}</script>`,
    );
    expect(parseHtmlPage(html, 'https://news.example/fridges', false)).toMatchObject({
      url: 'https://news.example/fridges',
      source: 'web',
      kind: 'article',
      title: 'Fridges Replaced',
      author: 'Jane Reporter',
      site: 'Daily Example',
      publishedAt: Date.parse('2026-09-20T09:00:00-04:00'),
      text: story.trim(),
      language: 'en',
      media: [{ type: 'image', url: 'https://img.example/cover.jpg' }],
    });
  });

  it('falls back to readable text, and to the description for JS-only shells', () => {
    const readable = parseHtmlPage(htmlPage({ 'og:title': 'Blog' }, `<main><p>${story}</p></main>`), 'https://blog.example/p', false);
    expect(readable).toMatchObject({ kind: 'web page', site: 'blog.example', text: story.trim() });

    const shell = parseHtmlPage(htmlPage({ description: 'An app you need JS for' }, '<div id="root"></div>'), 'https://app.example/', true);
    expect(shell.text).toBe('An app you need JS for');
    expect(shell.notes).toEqual(['page was too large to read in full']);

    const empty = parseHtmlPage('<html><body><div id="root"></div></body></html>', 'https://app.example/', false);
    expect(empty.notes).toEqual(['no readable text (the page probably needs JavaScript)']);
  });

  it('caps very long text', () => {
    const long = parseHtmlPage(htmlPage({}, `<article><p>${'word '.repeat(5000)}</p></article>`), 'https://x.example/', false);
    expect(long.textTruncated).toBe(true);
    expect(long.text?.length).toBeLessThanOrEqual(7001);
  });
});

describe('readWebPage', () => {
  it('reads an HTML page', async () => {
    const fetch = createFakeSafeFetch({ 'https://blog.example/p': { body: htmlPage({ 'og:title': 'Post' }, `<article>${story}</article>`) } });
    const outcome = await readWebPage('https://blog.example/p', fakeExtractorContext(fetch), notPlatform);
    expect('content' in outcome && outcome.content.title).toBe('Post');
    expect(fetch.calls[0].options.accept).toEqual(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown']);
  });

  it('decodes legacy charsets declared in the page', async () => {
    const body = Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><title>caf'), Buffer.from([0xe9]), Buffer.from('</title>')]);
    const fetch = createFakeSafeFetch({ 'https://old.example/': { contentType: 'text/html', body } });
    const outcome = await readWebPage('https://old.example/', fakeExtractorContext(fetch), notPlatform);
    expect('content' in outcome && outcome.content.title).toBe('café');
  });

  it('reads plain text files', async () => {
    const fetch = createFakeSafeFetch({ 'https://x.example/notes.txt': { contentType: 'text/plain; charset=utf-8', body: 'just some notes' } });
    const outcome = await readWebPage('https://x.example/notes.txt', fakeExtractorContext(fetch), notPlatform);
    expect(outcome).toEqual({
      content: {
        url: 'https://x.example/notes.txt',
        source: 'web',
        kind: 'document',
        title: 'notes.txt',
        site: 'x.example',
        text: 'just some notes',
        textTruncated: false,
        media: [],
      },
    });
  });

  it('describes images, videos and PDFs from their headers without downloading them', async () => {
    const fetch = createFakeSafeFetch({
      'https://cdn.example/pic.png': { contentType: 'image/png', body: Buffer.alloc(8) },
      'https://cdn.example/clip.mp4': { contentType: 'video/mp4', headers: { 'content-length': '5000000' }, body: Buffer.alloc(8) },
      'https://cdn.example/paper.pdf': { contentType: 'application/pdf', headers: { 'content-length': '204800' }, body: Buffer.alloc(8) },
      'https://cdn.example/archive.zip': { contentType: 'application/zip', body: Buffer.alloc(8) },
    });
    const ctx = fakeExtractorContext(fetch);
    const read = async (url: string) => {
      const outcome = await readWebPage(url, ctx, notPlatform);
      if (!('content' in outcome)) throw new Error('expected content');
      return outcome.content;
    };
    expect(await read('https://cdn.example/pic.png')).toMatchObject({ kind: 'image', media: [{ type: 'image', url: 'https://cdn.example/pic.png' }] });
    expect(await read('https://cdn.example/clip.mp4')).toMatchObject({
      kind: 'video file',
      media: [{ type: 'video', url: 'https://cdn.example/clip.mp4', contentType: 'video/mp4', sizeBytes: 5_000_000 }],
    });
    expect(await read('https://cdn.example/paper.pdf')).toMatchObject({ kind: 'document', title: 'paper.pdf', notes: [expect.stringMatching(/PDF \(200 KB\)/)] });
    await expect(read('https://cdn.example/archive.zip')).rejects.toThrow(/application\/zip file/);
  });

  it.each([
    [404, ExtractError, /does not exist/],
    [403, ExtractError, /refused/],
    [503, Error, /HTTP 503/],
  ])('maps HTTP %s', async (status, type, message) => {
    const fetch = createFakeSafeFetch({ 'https://x.example/': { status, body: '<html></html>' } });
    const error = await readWebPage('https://x.example/', fakeExtractorContext(fetch), notPlatform).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).toMatch(message);
  });

  it('reports a redirect onto a platform with its own extractor', async () => {
    const fetch = createFakeSafeFetch({ 'https://t.co/abc': { finalUrl: 'https://x.com/jack/status/20', body: '<html></html>' } });
    const outcome = await readWebPage('https://t.co/abc', fakeExtractorContext(fetch), (url) => url.startsWith('https://x.com/'));
    expect(outcome).toEqual({ redirectedTo: 'https://x.com/jack/status/20' });
  });
});
