import { afterEach, describe, expect, it, vi } from 'vitest';
import { findLinks, identifyLink, isDiscordUrl } from './targets';

const id = (url: string) => identifyLink(new URL(url));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('identifyLink', () => {
  it('maps every Twitter/X spelling (incl. fixer reposts) to one key', () => {
    const urls = [
      'https://x.com/jack/status/20',
      'https://twitter.com/jack/status/20?s=46&t=abc',
      'https://mobile.twitter.com/jack/status/20/photo/1',
      'https://fixvx.com/jack/status/20',
      'https://fxtwitter.com/jack/status/20',
      'https://vxtwitter.com/jack/statuses/20',
      'https://fixupx.com/i/web/status/20',
      'https://x.com/i/status/20',
    ];
    for (const url of urls) expect(id(url)).toMatchObject({ source: 'twitter', key: 'twitter:20', statusId: '20' });
    expect(id('https://x.com/jack/status/20').url).toBe('https://x.com/jack/status/20');
  });

  it('honors a configured custom Twitter fixer domain', () => {
    vi.stubEnv('TWITTER_FIXERS', 'mytwitterfix.example');
    expect(id('https://mytwitterfix.example/jack/status/20')).toMatchObject({ source: 'twitter', key: 'twitter:20' });
  });

  it('treats non-status Twitter pages as ordinary web pages', () => {
    expect(id('https://x.com/jack')).toMatchObject({ source: 'web' });
  });

  it('recognizes YouTube watch, short, embed and youtu.be links', () => {
    expect(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toMatchObject({
      source: 'youtube',
      key: 'youtube:dQw4w9WgXcQ',
      isShort: false,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(id('https://youtu.be/dQw4w9WgXcQ?si=x')).toMatchObject({ key: 'youtube:dQw4w9WgXcQ' });
    expect(id('https://m.youtube.com/shorts/abcdefghijk')).toMatchObject({
      key: 'youtube:abcdefghijk',
      isShort: true,
      url: 'https://www.youtube.com/shorts/abcdefghijk',
    });
    expect(id('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toMatchObject({ key: 'youtube:dQw4w9WgXcQ' });
    expect(id('https://www.youtube.com/live/dQw4w9WgXcQ')).toMatchObject({ key: 'youtube:dQw4w9WgXcQ' });
    expect(id('https://www.youtube.com/@channel')).toMatchObject({ source: 'web' });
  });

  it('recognizes TikTok videos, fixer reposts and short links', () => {
    expect(id('https://www.tiktok.com/@user.name/video/7234567890123456789?lang=en')).toMatchObject({
      source: 'tiktok',
      key: 'tiktok:7234567890123456789',
      path: '/@user.name/video/7234567890123456789',
    });
    expect(id('https://tnktok.com/@user.name/video/7234567890123456789')).toMatchObject({ key: 'tiktok:7234567890123456789' });
    expect(id('https://vm.tiktok.com/ZMabc123/')).toMatchObject({ key: 'tiktok:t:ZMabc123', path: '/t/ZMabc123' });
  });

  it('recognizes Instagram posts/reels (profile-prefixed too) and share links', () => {
    expect(id('https://www.instagram.com/reel/C1a2b3c4d5/?igsh=x')).toMatchObject({
      source: 'instagram',
      key: 'instagram:C1a2b3c4d5',
      path: '/reel/C1a2b3c4d5/',
    });
    expect(id('https://www.instagram.com/some.user/p/C1a2b3c4d5/')).toMatchObject({ key: 'instagram:C1a2b3c4d5', path: '/p/C1a2b3c4d5/' });
    expect(id('https://uuinstagram.com/reel/C1a2b3c4d5/')).toMatchObject({ key: 'instagram:C1a2b3c4d5' });
    expect(id('https://www.instagram.com/share/reel/BAabc123/')).toMatchObject({ key: 'instagram:share:BAabc123' });
    expect(id('https://www.instagram.com/some.user/')).toMatchObject({ source: 'web' });
  });

  it('recognizes Reddit posts, short links and share links', () => {
    expect(id('https://www.reddit.com/r/pics/comments/1abcde/some_title/?share_id=x')).toMatchObject({
      source: 'reddit',
      key: 'reddit:1abcde',
      postId: '1abcde',
      url: 'https://www.reddit.com/r/pics/comments/1abcde/some_title/',
    });
    expect(id('https://old.reddit.com/comments/1abcde')).toMatchObject({ key: 'reddit:1abcde', url: 'https://www.reddit.com/comments/1abcde/' });
    expect(id('https://redd.it/1abcde')).toMatchObject({ key: 'reddit:1abcde' });
    expect(id('https://rxddit.com/r/pics/comments/1abcde/t/')).toMatchObject({ key: 'reddit:1abcde' });
    const share = id('https://www.reddit.com/r/pics/s/AbCdEf123');
    expect(share).toMatchObject({ source: 'reddit', key: 'reddit:share:AbCdEf123' });
    expect('postId' in share && share.postId).toBeFalsy();
  });

  it('recognizes Bluesky posts by handle or DID', () => {
    expect(id('https://bsky.app/profile/Someone.bsky.social/post/3kabc123xyz')).toMatchObject({
      source: 'bluesky',
      key: 'bluesky:someone.bsky.social/3kabc123xyz',
      actor: 'Someone.bsky.social',
      rkey: '3kabc123xyz',
    });
    expect(id('https://fxbsky.app/profile/did:plc:abc123/post/3kabc123xyz')).toMatchObject({ actor: 'did:plc:abc123' });
    expect(id('https://bsky.app/profile/someone.bsky.social')).toMatchObject({ source: 'web' });
  });

  it('recognizes Tenor view pages and short links (media files stay generic)', () => {
    expect(id('https://tenor.com/view/sir-cat-gif-1501192124616773468')).toMatchObject({
      source: 'tenor',
      key: 'tenor:1501192124616773468',
      url: 'https://tenor.com/view/sir-cat-gif-1501192124616773468',
    });
    expect(id('https://tenor.com/es/view/gato-gif-1501192124616773468')).toMatchObject({ key: 'tenor:1501192124616773468' });
    expect(id('https://tenor.com/bEfN4.gif')).toMatchObject({ source: 'tenor', key: 'tenor:short:befn4' });
    expect(id('https://media1.tenor.com/m/FNVOSJ9lj1wAAAAC/sir-cat.gif')).toMatchObject({ source: 'web' });
  });

  it('recognizes Klipy GIF, sticker and clip pages', () => {
    expect(id('https://klipy.com/gifs/cat-reaction-michi-triste')).toMatchObject({
      source: 'klipy',
      key: 'klipy:gifs/cat-reaction-michi-triste',
      section: 'gifs',
    });
    expect(id('https://www.klipy.com/clips/are-you-ready-for-it/')).toMatchObject({ section: 'clips' });
    expect(id('https://klipy.com/stickers/wave')).toMatchObject({ section: 'stickers' });
    expect(id('https://klipy.com/')).toMatchObject({ source: 'web' });
  });

  it('keys generic pages by the full URL without the fragment', () => {
    expect(id('https://example.com/a?b=1#section')).toEqual({
      source: 'web',
      key: 'web:https://example.com/a?b=1',
      url: 'https://example.com/a?b=1',
    });
  });
});

describe('findLinks', () => {
  it('finds links in order, deduplicated, trimming sentence punctuation', () => {
    expect(findLinks('look https://a.example/x. and (https://b.example/y), also https://a.example/x!')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
  });

  it('keeps balanced parentheses (Wikipedia-style URLs)', () => {
    expect(findLinks('see https://en.wikipedia.org/wiki/Fridge_(appliance) ok')).toEqual([
      'https://en.wikipedia.org/wiki/Fridge_(appliance)',
    ]);
  });

  it('skips links wrapped in <…> (embed suppressed on purpose)', () => {
    expect(findLinks('no embed <https://a.example/x> but https://b.example/y')).toEqual(['https://b.example/y']);
  });

  it('skips links inside inline code and code blocks', () => {
    expect(findLinks('`https://a.example/x` and\n```\ncurl https://b.example/y\n```\nhttps://c.example/z')).toEqual([
      'https://c.example/z',
    ]);
  });

  it("skips Discord's own links", () => {
    expect(findLinks('https://discord.com/channels/1/2/3 https://cdn.discordapp.com/attachments/1/2/a.png https://discord.gg/abc')).toEqual([]);
    expect(isDiscordUrl(new URL('https://media.discordapp.net/x.png'))).toBe(true);
  });

  it('ignores markdown emphasis around a link', () => {
    expect(findLinks('**https://a.example/x**')).toEqual(['https://a.example/x']);
  });

  it('returns nothing for text without links', () => {
    expect(findLinks('just chatting, no links here: www.example.com')).toEqual([]);
  });
});
