import { describe, expect, it, vi } from 'vitest';
import { createAttachmentUrlSigner, isDiscordAttachmentUrl, needsSigning } from './discordCdn';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const hexSeconds = (ms: number) => Math.floor(ms / 1000).toString(16);

describe('isDiscordAttachmentUrl', () => {
  it('knows attachment links on the CDN and the media proxy, signed or not', () => {
    expect(isDiscordAttachmentUrl('https://cdn.discordapp.com/attachments/1/2/dance.gif')).toBe(true);
    expect(isDiscordAttachmentUrl('https://media.discordapp.net/attachments/1/2/DANCE.GIF?backend=b2')).toBe(true);
    expect(isDiscordAttachmentUrl('https://cdn.discordapp.com/ephemeral-attachments/1/2/x.png?ex=1&is=2&hm=3')).toBe(true);
  });

  it('refuses everything else: other paths, other hosts, plain http', () => {
    expect(isDiscordAttachmentUrl('https://cdn.discordapp.com/emojis/123.png')).toBe(false);
    expect(isDiscordAttachmentUrl('https://cdn.discordapp.com/attachments/1/2/a/b.png')).toBe(false);
    expect(isDiscordAttachmentUrl('https://evil.example/attachments/1/2/dance.gif')).toBe(false);
    expect(isDiscordAttachmentUrl('http://cdn.discordapp.com/attachments/1/2/dance.gif')).toBe(false);
    expect(isDiscordAttachmentUrl('not a url')).toBe(false);
  });
});

describe('needsSigning', () => {
  it('signs an unsigned link, an expired one and one about to expire; leaves a valid one alone', () => {
    const base = 'https://cdn.discordapp.com/attachments/1/2/dance.gif';
    expect(needsSigning(base, NOW)).toBe(true);
    expect(needsSigning(`${base}?backend=b2`, NOW)).toBe(true);
    expect(needsSigning(`${base}?ex=${hexSeconds(NOW - 1000)}&is=1&hm=2`, NOW)).toBe(true);
    expect(needsSigning(`${base}?ex=${hexSeconds(NOW + 30_000)}&is=1&hm=2`, NOW)).toBe(true);
    expect(needsSigning(`${base}?ex=${hexSeconds(NOW + 3_600_000)}&is=1&hm=2`, NOW)).toBe(false);
  });

  it('never asks to sign what is not an attachment link', () => {
    expect(needsSigning('https://media.tenor.com/abc/dance.gif', NOW)).toBe(false);
  });
});

describe('createAttachmentUrlSigner', () => {
  const unsigned = 'https://cdn.discordapp.com/attachments/1/2/dance.gif?backend=b2';
  const signed = `${unsigned}&ex=${hexSeconds(NOW + 86_400_000)}&is=1&hm=abc`;

  it("asks Discord's refresh-urls route and maps each link to its signed version", async () => {
    const post = vi.fn(async () => ({ refreshed_urls: [{ original: unsigned, refreshed: signed }] }));
    const sign = createAttachmentUrlSigner({ post });

    expect(await sign([unsigned, unsigned, 'https://media.tenor.com/x.gif'])).toEqual(new Map([[unsigned, signed]]));
    // Deduplicated, and only attachment links are sent.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([
      '/attachments/refresh-urls',
      { body: { attachment_urls: [unsigned] }, signal: expect.any(AbortSignal) },
    ]);
  });

  it('accepts only a signed attachment link for the same file back', async () => {
    const other = 'https://cdn.discordapp.com/attachments/1/2/other.gif';
    const post = vi.fn(async () => ({
      refreshed_urls: [
        { original: unsigned, refreshed: 'https://evil.example/attachments/1/2/dance.gif?ex=1&is=2&hm=3' },
        { original: other, refreshed: `${unsigned}&ex=1&is=2&hm=3` },
        {
          original: 'https://cdn.discordapp.com/attachments/9/9/never-sent.gif',
          refreshed: 'https://cdn.discordapp.com/attachments/9/9/never-sent.gif?ex=1&is=2&hm=3',
        },
      ],
    }));
    const sign = createAttachmentUrlSigner({ post });

    expect(await sign([unsigned, other])).toEqual(new Map());
  });

  it("matches a signed link back by its file's path when the echo changed the link sent", async () => {
    const proxied = 'https://media.discordapp.net/attachments/1/2/dance.gif?backend=b2';
    const post = vi.fn(async () => ({
      refreshed_urls: [{ original: 'https://cdn.discordapp.com/attachments/1/2/dance.gif', refreshed: signed }],
    }));

    expect(await createAttachmentUrlSigner({ post })([proxied])).toEqual(new Map([[proxied, signed]]));
  });

  it('sends at most 50 links per call', async () => {
    const links = Array.from({ length: 51 }, (_, i) => `https://cdn.discordapp.com/attachments/1/${i}/x.gif`);
    const post = vi.fn(async () => ({ refreshed_urls: [] }));

    await createAttachmentUrlSigner({ post })(links);

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never throws: a failed call leaves its links unsigned', async () => {
    const post = vi.fn(async () => {
      throw new Error('Missing Access');
    });
    expect(await createAttachmentUrlSigner({ post })([unsigned])).toEqual(new Map());
  });
});
