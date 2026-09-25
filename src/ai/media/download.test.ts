import { describe, expect, it, vi } from 'vitest';
import { createFileFetch, createFileSafeFetch } from '../../test-support/fakeMedia';
import { downloadMedia, isDiscordMediaUrl, isFetchableUrl, redact } from './download';

const OPTS = { maxBytes: 100, timeoutMs: 5000 };
const CDN = 'https://cdn.discordapp.com/attachments/1/2';

describe('isFetchableUrl', () => {
  it.each([
    'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=abc',
    'https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/a.mp4',
    'https://8.8.8.8/file.mp4',
  ])('allows %s', (url) => {
    expect(isFetchableUrl(url)).toBe(true);
  });

  it.each([
    'http://cdn.discordapp.com/a.ogg',
    'file:///etc/passwd',
    'https://localhost/a.mp4',
    'https://127.0.0.1/a.mp4',
    'https://2130706433/a.mp4',
    'https://10.0.0.5/a.mp4',
    'https://192.168.1.1/a.mp4',
    'https://172.20.0.1/a.mp4',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/a.mp4',
    'https://nas.local/a.mp4',
    'https://intranet/a.mp4',
    'https://user:pw@example.com/a.mp4',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isFetchableUrl(url)).toBe(false);
  });
});

describe('isDiscordMediaUrl', () => {
  it.each([
    'https://cdn.discordapp.com/attachments/1/2/a.ogg?ex=1',
    'https://media.discordapp.net/attachments/1/2/a.mp4',
    'https://images-ext-1.discordapp.net/external/abc/https/example.com/a.png',
  ])('treats %s as Discord', (url) => {
    expect(isDiscordMediaUrl(url)).toBe(true);
  });

  it.each([
    'http://cdn.discordapp.com/a.ogg',
    'https://cdn.discordapp.com.evil.example/a.ogg',
    'https://discordapp.net.evil.example/a.mp4',
    'https://cdn.discordapp.com:8443/a.ogg',
    'https://video.twimg.com/a.mp4',
  ])('treats %s as any other host', (url) => {
    expect(isDiscordMediaUrl(url)).toBe(false);
  });
});

describe('downloadMedia from Discord', () => {
  it('returns the bytes and content type', async () => {
    const fetch = createFileFetch({ [`${CDN}/x.ogg`]: { body: Buffer.from('OggS-data'), contentType: 'audio/ogg' } });
    const result = await downloadMedia(`${CDN}/x.ogg`, { ...OPTS, fetch });
    expect(result).toEqual({ ok: true, data: Buffer.from('OggS-data'), contentType: 'audio/ogg' });
  });

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    const fetch = createFileFetch({
      [`${CDN}/big.mp4`]: { body: Buffer.alloc(10), headers: { 'content-length': '5000' } },
    });
    expect(await downloadMedia(`${CDN}/big.mp4`, { ...OPTS, fetch })).toEqual({ ok: false, reason: 'too_large' });
  });

  it('enforces the cap while streaming when the length is missing or lies', async () => {
    const fetch = createFileFetch({ [`${CDN}/big.mp4`]: { body: Buffer.alloc(150) } });
    expect(await downloadMedia(`${CDN}/big.mp4`, { ...OPTS, fetch })).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reports HTTP errors', async () => {
    const fetch = createFileFetch({});
    expect(await downloadMedia(`${CDN}/missing.ogg`, { ...OPTS, fetch })).toEqual({ ok: false, reason: 'http' });
  });

  it('follows redirects between Discord hosts', async () => {
    const fetch = createFileFetch({
      [`${CDN}/short`]: {
        body: Buffer.alloc(0),
        status: 302,
        headers: { location: 'https://media.discordapp.net/attachments/1/2/real.mp4' },
      },
      'https://media.discordapp.net/attachments/1/2/real.mp4': { body: Buffer.from('clip'), contentType: 'video/mp4' },
    });
    const result = await downloadMedia(`${CDN}/short`, { ...OPTS, fetch });
    expect(result.ok && result.data.toString()).toBe('clip');
    expect(fetch.urls).toHaveLength(2);
  });

  it('hands a redirect off Discord to the guarded fetch', async () => {
    const fetch = createFileFetch({
      [`${CDN}/away`]: { body: Buffer.alloc(0), status: 302, headers: { location: 'https://files.example/a.mp4' } },
    });
    const safeFetch = createFileSafeFetch({
      'https://files.example/a.mp4': { body: Buffer.from('clip'), contentType: 'video/mp4' },
    });
    const result = await downloadMedia(`${CDN}/away`, { ...OPTS, fetch, safeFetch });
    expect(result.ok && result.data.toString()).toBe('clip');
    expect(fetch.urls).toEqual([`${CDN}/away`]);
    expect(safeFetch.urls).toEqual(['https://files.example/a.mp4']);
  });

  it('refuses a redirect into the private network', async () => {
    const fetch = createFileFetch({
      [`${CDN}/sneaky`]: {
        body: Buffer.alloc(0),
        status: 301,
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
      },
    });
    const safeFetch = createFileSafeFetch({});
    expect(await downloadMedia(`${CDN}/sneaky`, { ...OPTS, fetch, safeFetch })).toEqual({
      ok: false,
      reason: 'blocked',
    });
    expect(safeFetch.urls).toEqual([]);
  });

  it('turns network errors into a result instead of throwing', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    expect(await downloadMedia(`${CDN}/x.ogg`, { ...OPTS, fetch })).toEqual({ ok: false, reason: 'network' });
  });

  it('gives up on redirect loops', async () => {
    const fetch = createFileFetch({
      [`${CDN}/loop`]: { body: Buffer.alloc(0), status: 302, headers: { location: '/attachments/1/2/loop' } },
    });
    expect(await downloadMedia(`${CDN}/loop`, { ...OPTS, fetch })).toEqual({ ok: false, reason: 'http' });
    expect(fetch.urls).toHaveLength(6);
  });
});

describe('downloadMedia from any other host (the guarded fetch)', () => {
  it('downloads through the SSRF-guarded fetch, never the plain one', async () => {
    const fetch = vi.fn();
    const safeFetch = createFileSafeFetch({
      'https://video.example/a.mp4': { body: Buffer.from('clip'), contentType: 'video/mp4' },
    });
    const result = await downloadMedia('https://video.example/a.mp4', {
      ...OPTS,
      fetch: fetch as unknown as typeof globalThis.fetch,
      safeFetch,
    });
    expect(result).toEqual({ ok: true, data: Buffer.from('clip'), contentType: 'video/mp4' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts generically labelled binaries', async () => {
    const safeFetch = createFileSafeFetch({
      'https://bucket.example/a.mp4': { body: Buffer.from('clip'), contentType: 'application/octet-stream' },
    });
    expect((await downloadMedia('https://bucket.example/a.mp4', { ...OPTS, safeFetch })).ok).toBe(true);
  });

  it('never downloads a page that is not media', async () => {
    const safeFetch = createFileSafeFetch({
      'https://site.example/login': { body: Buffer.from('<html>'), contentType: 'text/html' },
    });
    expect(await downloadMedia('https://site.example/login', { ...OPTS, safeFetch })).toEqual({
      ok: false,
      reason: 'http',
    });
  });

  it('honors a custom accept list (images for the chat provider)', async () => {
    const safeFetch = createFileSafeFetch({
      'https://site.example/a.png': { body: Buffer.from('png'), contentType: 'image/png' },
    });
    expect((await downloadMedia('https://site.example/a.png', { ...OPTS, safeFetch })).ok).toBe(false);
    expect((await downloadMedia('https://site.example/a.png', { ...OPTS, safeFetch, accept: ['image/*'] })).ok).toBe(
      true,
    );
  });

  it('refuses hosts that resolve into the private network', async () => {
    const safeFetch = createFileSafeFetch(
      { 'https://sneaky.example/a.mp4': { body: Buffer.from('x'), contentType: 'video/mp4' } },
      { privateHosts: ['sneaky.example'] },
    );
    expect(await downloadMedia('https://sneaky.example/a.mp4', { ...OPTS, safeFetch })).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('refuses a redirect into the private network', async () => {
    const safeFetch = createFileSafeFetch({
      'https://site.example/go': { body: Buffer.alloc(0), status: 302, headers: { location: 'http://sandbox:8080/' } },
    });
    expect(await downloadMedia('https://site.example/go', { ...OPTS, safeFetch })).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('reports a body over the cap, or a declared length over it, as too large', async () => {
    const safeFetch = createFileSafeFetch({
      'https://site.example/big.mp4': { body: Buffer.alloc(150), contentType: 'video/mp4' },
      'https://site.example/liar.mp4': {
        body: Buffer.alloc(10),
        contentType: 'video/mp4',
        headers: { 'content-length': '5000' },
      },
    });
    expect(await downloadMedia('https://site.example/big.mp4', { ...OPTS, safeFetch })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(await downloadMedia('https://site.example/liar.mp4', { ...OPTS, safeFetch })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('reports HTTP errors', async () => {
    const safeFetch = createFileSafeFetch({});
    expect(await downloadMedia('https://site.example/missing.mp4', { ...OPTS, safeFetch })).toEqual({
      ok: false,
      reason: 'http',
    });
  });

  it('never reaches the network by default under Vitest', async () => {
    expect(await downloadMedia('https://site.example/a.mp4', OPTS)).toEqual({ ok: false, reason: 'network' });
  });
});

describe('redact', () => {
  it('drops the signed query from logs', () => {
    expect(redact('https://cdn.discordapp.com/attachments/1/2/a.ogg?ex=1&is=2&hm=secret')).toBe(
      'https://cdn.discordapp.com/attachments/1/2/a.ogg',
    );
  });
});
