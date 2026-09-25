import { describe, expect, it } from 'vitest';
import { createFileFetch } from '../../test-support/fakeMedia';
import { downloadMedia, isFetchableUrl, redact } from './download';

const OPTS = { maxBytes: 100, timeoutMs: 5000 };

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

describe('downloadMedia', () => {
  it('returns the bytes and content type', async () => {
    const fetch = createFileFetch({ 'https://a.example/x.ogg': { body: Buffer.from('OggS-data'), contentType: 'audio/ogg' } });
    const result = await downloadMedia('https://a.example/x.ogg', { ...OPTS, fetch });
    expect(result).toEqual({ ok: true, data: Buffer.from('OggS-data'), contentType: 'audio/ogg' });
  });

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    const fetch = createFileFetch({
      'https://a.example/big.mp4': { body: Buffer.alloc(10), headers: { 'content-length': '5000' } },
    });
    expect(await downloadMedia('https://a.example/big.mp4', { ...OPTS, fetch })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('enforces the cap while streaming when the length is missing or lies', async () => {
    const fetch = createFileFetch({ 'https://a.example/big.mp4': { body: Buffer.alloc(150) } });
    expect(await downloadMedia('https://a.example/big.mp4', { ...OPTS, fetch })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('reports HTTP errors', async () => {
    const fetch = createFileFetch({});
    expect(await downloadMedia('https://a.example/missing.ogg', { ...OPTS, fetch })).toEqual({
      ok: false,
      reason: 'http',
    });
  });

  it('follows redirects to allowed hosts', async () => {
    const fetch = createFileFetch({
      'https://a.example/short': { body: Buffer.alloc(0), status: 302, headers: { location: '/real.mp4' } },
      'https://a.example/real.mp4': { body: Buffer.from('clip'), contentType: 'video/mp4' },
    });
    const result = await downloadMedia('https://a.example/short', { ...OPTS, fetch });
    expect(result.ok && result.data.toString()).toBe('clip');
    expect(fetch.urls).toEqual(['https://a.example/short', 'https://a.example/real.mp4']);
  });

  it('refuses a redirect into the private network', async () => {
    const fetch = createFileFetch({
      'https://a.example/sneaky': {
        body: Buffer.alloc(0),
        status: 301,
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
      },
    });
    expect(await downloadMedia('https://a.example/sneaky', { ...OPTS, fetch })).toEqual({
      ok: false,
      reason: 'blocked',
    });
    expect(fetch.urls).toEqual(['https://a.example/sneaky']);
  });

  it('never fetches a blocked URL at all', async () => {
    const fetch = createFileFetch({});
    expect(await downloadMedia('http://a.example/x.ogg', { ...OPTS, fetch })).toEqual({ ok: false, reason: 'blocked' });
    expect(fetch.urls).toEqual([]);
  });

  it('turns network errors into a result instead of throwing', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    expect(await downloadMedia('https://a.example/x.ogg', { ...OPTS, fetch })).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('gives up on redirect loops', async () => {
    const fetch = createFileFetch({
      'https://a.example/loop': { body: Buffer.alloc(0), status: 302, headers: { location: '/loop' } },
    });
    expect(await downloadMedia('https://a.example/loop', { ...OPTS, fetch })).toEqual({ ok: false, reason: 'http' });
    expect(fetch.urls).toHaveLength(6);
  });
});

describe('redact', () => {
  it('drops the signed query from logs', () => {
    expect(redact('https://cdn.discordapp.com/attachments/1/2/a.ogg?ex=1&is=2&hm=secret')).toBe(
      'https://cdn.discordapp.com/attachments/1/2/a.ogg',
    );
  });
});
