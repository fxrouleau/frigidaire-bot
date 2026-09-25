import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { isDiscordMediaUrl, loadImageDataUri, loadImages } from './images';

let png: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  png = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer));
});

function fakeFetch(respond: (url: string) => Response) {
  return vi.fn(async (url: string, _init?: { signal?: AbortSignal }) => respond(url));
}

describe('isDiscordMediaUrl', () => {
  it('accepts only Discord-hosted media over https', () => {
    expect(isDiscordMediaUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1')).toBe(true);
    expect(isDiscordMediaUrl('https://media.discordapp.net/attachments/1/2/a.png')).toBe(true);
    expect(isDiscordMediaUrl('https://images-ext-1.discordapp.net/external/abc/https/x.com/a.jpg')).toBe(true);
    expect(isDiscordMediaUrl('http://cdn.discordapp.com/a.png')).toBe(false);
    expect(isDiscordMediaUrl('https://cdn.discordapp.com.evil.example/a.png')).toBe(false);
    expect(isDiscordMediaUrl('https://pbs.twimg.com/media/a.jpg')).toBe(false);
    expect(isDiscordMediaUrl('not a url')).toBe(false);
  });
});

describe('loadImageDataUri', () => {
  it('downloads and downscales an image to a JPEG data URI', async () => {
    const fetch = fakeFetch(() => new Response(png, { headers: { 'content-type': 'image/png' } }));
    const uri = await loadImageDataUri('https://cdn.discordapp.com/a.png', fetch);
    expect(uri?.startsWith('data:image/jpeg;base64,')).toBe(true);
    const decoded = Buffer.from(uri?.split(',')[1] ?? '', 'base64');
    const meta = await sharp(decoded).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([768, 384, 'jpeg']);
  });

  it('never fetches a non-Discord URL', async () => {
    const fetch = fakeFetch(() => new Response(png));
    expect(await loadImageDataUri('https://example.com/a.png', fetch)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives up on HTTP errors, oversized files and non-images', async () => {
    expect(
      await loadImageDataUri('https://cdn.discordapp.com/a.png', fakeFetch(() => new Response('', { status: 404 }))),
    ).toBeUndefined();
    const huge = fakeFetch(() => new Response(png, { headers: { 'content-length': String(50 * 1024 * 1024) } }));
    expect(await loadImageDataUri('https://cdn.discordapp.com/a.png', huge)).toBeUndefined();
    const text = fakeFetch(() => new Response('not an image', { headers: { 'content-type': 'text/plain' } }));
    expect(await loadImageDataUri('https://cdn.discordapp.com/a.png', text)).toBeUndefined();
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await loadImageDataUri('https://cdn.discordapp.com/a.png', failing)).toBeUndefined();
  });
});

describe('loadImages', () => {
  it('loads up to max distinct URLs and leaves failures out', async () => {
    const fetch = fakeFetch((url) =>
      url.includes('bad') ? new Response('', { status: 500 }) : new Response(png, { headers: { 'content-type': 'image/png' } }),
    );
    const uris = await loadImages(
      [
        'https://cdn.discordapp.com/bad.png',
        'https://cdn.discordapp.com/a.png',
        'https://cdn.discordapp.com/a.png',
        'https://cdn.discordapp.com/b.png',
      ],
      2,
      fetch,
    );
    expect(uris).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
