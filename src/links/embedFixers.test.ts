import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FixerDeps,
  canonicalPath,
  findLinks,
  fixLinksInContent,
  hasFixableLink,
  pickFixerUrl,
  probeFixerUrl,
  resetFixerHealthForTesting,
  resolveCanonicalPath,
} from './embedFixers';

const OG_VIDEO_HTML =
  '<html><head><meta property="og:video" content="https://cdn.example/v.mp4"><meta property="og:image" content="https://cdn.example/i.jpg"></head></html>';
const OG_TWEET_HTML =
  '<html><head><meta property="og:description" content="a tweet"><meta name="twitter:card" content="summary"></head></html>';
const NOT_FOUND_HTML =
  '<html><head><meta property="og:title" content="InstaFix"><meta property="og:description" content="Post not found"></head></html>';
const NO_TAGS_HTML = '<html><head><title>login</title></head></html>';

type Route = (url: string) => Response | Promise<Response>;

const html = (body: string, status = 200) => () =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const status = (code: number) => () => new Response('', { status: code });
const media = () => new Response(new Uint8Array(8), { status: 200, headers: { 'content-type': 'video/mp4' } });
const networkError = () => {
  throw new TypeError('fetch failed');
};

/** A FixerDeps whose fetch answers by URL prefix (first match wins) and records every call. */
function fakeDeps(routes: Record<string, Route>, now = () => 1_000_000): FixerDeps & { calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!match) return new Response('unrouted', { status: 404 });
    return match[1](url);
  }) as typeof globalThis.fetch;
  return { fetch, now, calls };
}

beforeEach(() => {
  resetFixerHealthForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('findLinks / URL patterns', () => {
  const shouldMatch: Array<[string, string]> = [
    ['instagram', 'https://www.instagram.com/p/AbCdEf123/'],
    ['instagram', 'https://instagram.com/p/AbCdEf123/'],
    ['instagram', 'https://www.instagram.com/reel/AbCdEf123/'],
    ['instagram', 'https://www.instagram.com/reels/AbCdEf123/'],
    ['instagram', 'https://www.instagram.com/tv/AbCdEf123/'],
    ['instagram', 'https://m.instagram.com/p/AbCdEf123/'],
    ['instagram', 'http://www.instagram.com/p/AbCdEf123/?utm_source=ig_web'],
    ['instagram', 'https://www.instagram.com/share/BAIyS1iflh'],
    ['instagram', 'https://www.instagram.com/share/reel/BAIyS1iflh/'],
    ['instagram', 'https://www.instagram.com/natgeo/reel/DPT9TqZkR8L/'],
    ['instagram', 'https://www.instagram.com/some.user_1/p/DPT9TqZkR8L/?igsh=abc'],
    ['tiktok', 'https://www.tiktok.com/@user/video/1234567890'],
    ['tiktok', 'https://www.tiktok.com/@user.name/photo/1234567890?is_from_webapp=1'],
    ['tiktok', 'https://vm.tiktok.com/ZMhAbCdEf/'],
    ['tiktok', 'https://vt.tiktok.com/ZSaBcDeFg/'],
    ['tiktok', 'https://www.tiktok.com/t/ZTxyz123/'],
    ['tiktok', 'https://m.tiktok.com/v/1234567890.html'],
    ['twitter', 'https://twitter.com/user/status/1234567890'],
    ['twitter', 'https://x.com/user_name/status/1234567890?s=20&t=abc'],
    ['twitter', 'https://mobile.twitter.com/user/status/1234567890'],
  ];

  for (const [platform, url] of shouldMatch) {
    it(`matches ${platform}: ${url}`, () => {
      const links = findLinks(`hey ${url} look`);
      expect(links).toHaveLength(1);
      expect(links[0].platform).toBe(platform);
      expect(links[0].url).toBe(url);
    });
  }

  const shouldNotMatch = [
    'https://www.instagram.com/username/',
    'https://www.instagram.com/stories/user/123/',
    'https://www.notinstagram.com/p/AbCdEf123/',
    'https://www.instagram.org/p/AbCdEf123/',
    'https://www.tiktok.com/@user',
    'https://www.tiktok.com/discover/cats',
    'https://www.tiktok.com/tag/fyp',
    'https://tiktok.com/something',
    'https://faketiktok.com.evil.com/@u/video/1',
    'https://twitter.com/user',
    'https://twitter.com/user/1234567890',
    'https://nottwitter.com/user/status/1234567890',
    'instagram.com/p/AbCdEf123/',
    'just some random text',
  ];

  for (const url of shouldNotMatch) {
    it(`does not match: ${url}`, () => {
      expect(findLinks(url)).toEqual([]);
      expect(hasFixableLink(url)).toBe(false);
    });
  }

  it('skips links wrapped in <> (the author suppressed the embed on purpose)', () => {
    expect(findLinks('see <https://x.com/u/status/1> quietly')).toEqual([]);
  });

  it('returns every link in message order across platforms', () => {
    const text = 'a https://x.com/u/status/1 b https://www.instagram.com/p/AAA/ c https://vm.tiktok.com/ZZZ/';
    expect(findLinks(text).map((l) => l.platform)).toEqual(['twitter', 'instagram', 'tiktok']);
  });
});

describe('canonicalPath', () => {
  it('normalizes Instagram post paths (reels → reel, profile prefix and query dropped)', () => {
    expect(canonicalPath('instagram', 'https://www.instagram.com/reels/AbC_-1/?igsh=x')).toBe('/reel/AbC_-1/');
    expect(canonicalPath('instagram', 'https://www.instagram.com/natgeo/reel/DPT9/')).toBe('/reel/DPT9/');
    expect(canonicalPath('instagram', 'https://m.instagram.com/p/XYZ')).toBe('/p/XYZ/');
    expect(canonicalPath('instagram', 'https://www.instagram.com/tv/XYZ/')).toBe('/tv/XYZ/');
    expect(canonicalPath('instagram', 'https://www.instagram.com/share/reel/BAIyS1iflh')).toBe('/share/BAIyS1iflh/');
  });

  it('normalizes TikTok paths (short links become /t/<code>)', () => {
    expect(canonicalPath('tiktok', 'https://www.tiktok.com/@user/video/123?x=1')).toBe('/@user/video/123');
    expect(canonicalPath('tiktok', 'https://www.tiktok.com/@user/photo/123')).toBe('/@user/photo/123');
    expect(canonicalPath('tiktok', 'https://vm.tiktok.com/ZMh/')).toBe('/t/ZMh');
    expect(canonicalPath('tiktok', 'https://vt.tiktok.com/ZSa')).toBe('/t/ZSa');
    expect(canonicalPath('tiktok', 'https://m.tiktok.com/v/123.html')).toBe('/v/123.html');
  });

  it('normalizes tweet paths', () => {
    expect(canonicalPath('twitter', 'https://x.com/user_name/status/123?s=20')).toBe('/user_name/status/123');
    expect(canonicalPath('twitter', 'https://mobile.twitter.com/u/status/9')).toBe('/u/status/9');
  });

  it('returns undefined for the wrong platform or an unrecognized path', () => {
    expect(canonicalPath('instagram', 'https://x.com/u/status/1')).toBeUndefined();
    expect(canonicalPath('instagram', 'https://www.instagram.com/username/')).toBeUndefined();
    expect(canonicalPath('tiktok', 'not a url')).toBeUndefined();
  });
});

describe('resolveCanonicalPath', () => {
  it('follows Instagram /share/ links through the platform redirect to the real post path', async () => {
    const deps = fakeDeps({
      'https://www.instagram.com/share/BAIyS1iflh/': redirect('https://www.instagram.com/reel/DHuCmOJvVEM/?igsh=abc'),
    });

    const path = await resolveCanonicalPath('instagram', 'https://www.instagram.com/share/BAIyS1iflh', deps);

    expect(path).toBe('/reel/DHuCmOJvVEM/');
    expect(deps.calls).toEqual(['https://www.instagram.com/share/BAIyS1iflh/']);
  });

  it('follows TikTok short links to the @user/video path', async () => {
    const deps = fakeDeps({
      'https://vm.tiktok.com/ZMh': redirect('https://www.tiktok.com/@khaby/video/7137?_r=1&checksum=x'),
    });

    expect(await resolveCanonicalPath('tiktok', 'https://vm.tiktok.com/ZMh/', deps)).toBe('/@khaby/video/7137');
  });

  it('keeps the share path when the redirect lookup fails (some fixers handle it natively)', async () => {
    const deps = fakeDeps({ 'https://www.instagram.com/share/': networkError });

    expect(await resolveCanonicalPath('instagram', 'https://www.instagram.com/share/XYZ', deps)).toBe('/share/XYZ/');
  });

  it('does not touch the network for plain post links', async () => {
    const deps = fakeDeps({});
    expect(await resolveCanonicalPath('instagram', 'https://www.instagram.com/p/AAA/', deps)).toBe('/p/AAA/');
    expect(deps.calls).toEqual([]);
  });
});

describe('probeFixerUrl', () => {
  it('reports ok for a page with OpenGraph media tags', async () => {
    const deps = fakeDeps({ 'https://fixer.test/': html(OG_VIDEO_HTML) });
    expect(await probeFixerUrl('instagram', 'https://fixer.test/reel/AAA/', deps)).toBe('ok');
  });

  it('accepts a tweet page on description/card tags alone (text-only tweets have no media)', async () => {
    const deps = fakeDeps({ 'https://fixvx.test/': html(OG_TWEET_HTML) });
    expect(await probeFixerUrl('twitter', 'https://fixvx.test/u/status/1', deps)).toBe('ok');
  });

  it('reports ok for a redirect straight to a media file or CDN (direct-media fixers)', async () => {
    const deps = fakeDeps({
      'https://kk.test/a': redirect('https://scontent.cdninstagram.com/v/t51/123.mp4?x=1'),
      'https://kk.test/b': redirect('https://other.host/clip.mp4'),
    });
    expect(await probeFixerUrl('instagram', 'https://kk.test/a', deps)).toBe('ok');
    expect(await probeFixerUrl('instagram', 'https://kk.test/b', deps)).toBe('ok');
  });

  it('reports ok for a raw video/image body', async () => {
    const deps = fakeDeps({ 'https://hh.test/': media });
    expect(await probeFixerUrl('instagram', 'https://hh.test/reel/AAA/', deps)).toBe('ok');
  });

  it('follows a redirect within the fixer (e.g. www → apex) before judging', async () => {
    const deps = fakeDeps({
      'https://www.fixer.test/': redirect('https://fixer.test/reel/AAA/'),
      'https://fixer.test/': html(OG_VIDEO_HTML),
    });
    expect(await probeFixerUrl('instagram', 'https://www.fixer.test/reel/AAA/', deps)).toBe('ok');
  });

  it('reports unavailable for 404s and "post not found" pages (the fixer is fine, the post is not)', async () => {
    const deps = fakeDeps({
      'https://fixer.test/gone': status(404),
      'https://fixer.test/nf': html(NOT_FOUND_HTML),
      'https://fixer.test/plain': html(NO_TAGS_HTML),
    });
    expect(await probeFixerUrl('instagram', 'https://fixer.test/gone', deps)).toBe('unavailable');
    expect(await probeFixerUrl('instagram', 'https://fixer.test/nf', deps)).toBe('unavailable');
    expect(await probeFixerUrl('instagram', 'https://fixer.test/plain', deps)).toBe('unavailable');
  });

  it('reports down for 5xx, network errors, and a bounce back to the platform login wall', async () => {
    const deps = fakeDeps({
      'https://dead.test/502': status(502),
      'https://dead.test/net': networkError,
      'https://dead.test/bounce': redirect('https://www.instagram.com/accounts/login/'),
    });
    expect(await probeFixerUrl('instagram', 'https://dead.test/502', deps)).toBe('down');
    expect(await probeFixerUrl('instagram', 'https://dead.test/net', deps)).toBe('down');
    expect(await probeFixerUrl('instagram', 'https://dead.test/bounce', deps)).toBe('down');
  });

  it('sends Discord crawler user agent (several fixers only serve OpenGraph to bots)', async () => {
    let userAgent: string | undefined;
    const deps: FixerDeps = {
      now: () => 0,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        userAgent = new Headers(init?.headers).get('user-agent') ?? undefined;
        return new Response(OG_VIDEO_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }) as typeof globalThis.fetch,
    };
    await probeFixerUrl('tiktok', 'https://tnktok.test/@u/video/1', deps);
    expect(userAgent).toContain('Discordbot');
  });
});

describe('pickFixerUrl', () => {
  beforeEach(() => {
    vi.stubEnv('INSTAGRAM_FIXERS', 'first.test,second.test,third.test');
  });

  it('returns the first fixer that embeds, in configured order', async () => {
    const deps = fakeDeps({ 'https://first.test/': html(OG_VIDEO_HTML), 'https://second.test/': html(OG_VIDEO_HTML) });
    expect(await pickFixerUrl('instagram', '/reel/AAA/', deps)).toBe('https://first.test/reel/AAA/');
    expect(deps.calls).toEqual(['https://first.test/reel/AAA/']);
  });

  it('falls through a dead fixer to the next one', async () => {
    const deps = fakeDeps({ 'https://first.test/': status(502), 'https://second.test/': html(OG_VIDEO_HTML) });
    expect(await pickFixerUrl('instagram', '/reel/AAA/', deps)).toBe('https://second.test/reel/AAA/');
  });

  it('falls through a fixer that lacks the post without penalizing its health', async () => {
    const deps = fakeDeps({ 'https://first.test/': status(404), 'https://second.test/': html(OG_VIDEO_HTML) });
    await pickFixerUrl('instagram', '/share/AAA/', deps);
    await pickFixerUrl('instagram', '/share/BBB/', deps);
    await pickFixerUrl('instagram', '/share/CCC/', deps);
    // Still probed every time — "unavailable" is about the post, not the fixer.
    expect(deps.calls.filter((u) => u.startsWith('https://first.test/'))).toHaveLength(3);
  });

  it('puts a fixer in cooldown after two consecutive failures and skips it without probing', async () => {
    let now = 1_000_000;
    const deps = fakeDeps({ 'https://first.test/': status(503), 'https://second.test/': html(OG_VIDEO_HTML) }, () => now);

    await pickFixerUrl('instagram', '/reel/A/', deps);
    await pickFixerUrl('instagram', '/reel/B/', deps);
    deps.calls.length = 0;

    expect(await pickFixerUrl('instagram', '/reel/C/', deps)).toBe('https://second.test/reel/C/');
    expect(deps.calls).toEqual(['https://second.test/reel/C/']);

    // After the cooldown the dead fixer is probed again.
    now += 11 * 60 * 1000;
    await pickFixerUrl('instagram', '/reel/D/', deps);
    expect(deps.calls).toContain('https://first.test/reel/D/');
  });

  it('returns undefined when no fixer works', async () => {
    const deps = fakeDeps({ 'https://first.test/': status(502), 'https://second.test/': status(404), 'https://third.test/': networkError });
    expect(await pickFixerUrl('instagram', '/reel/AAA/', deps)).toBeUndefined();
  });

  it('uses the first configured fixer blindly when LINK_FIX_VERIFY is off', async () => {
    vi.stubEnv('LINK_FIX_VERIFY', 'false');
    const deps = fakeDeps({});
    expect(await pickFixerUrl('instagram', '/reel/AAA/', deps)).toBe('https://first.test/reel/AAA/');
    expect(deps.calls).toEqual([]);
  });
});

describe('fixLinksInContent', () => {
  beforeEach(() => {
    vi.stubEnv('INSTAGRAM_FIXERS', 'ig.test');
    vi.stubEnv('TIKTOK_FIXERS', 'tt.test');
    vi.stubEnv('TWITTER_FIXERS', 'tw.test');
  });

  it('rewrites every fixable link in the message, across platforms', async () => {
    const deps = fakeDeps({
      'https://ig.test/': html(OG_VIDEO_HTML),
      'https://tt.test/': html(OG_VIDEO_HTML),
      'https://tw.test/': html(OG_TWEET_HTML),
    });
    const content =
      'ig https://www.instagram.com/p/AAA/?igsh=1 tt https://www.tiktok.com/@u/video/22?x=1 tw https://x.com/u/status/33?s=20';

    const result = await fixLinksInContent(content, deps);

    expect(result).toEqual({
      content: 'ig https://ig.test/p/AAA/ tt https://tt.test/@u/video/22 tw https://tw.test/u/status/33',
      fixed: 3,
      unfixable: 0,
    });
  });

  it('leaves a link untouched when no fixer can embed it and counts it as unfixable', async () => {
    const deps = fakeDeps({ 'https://ig.test/': status(502), 'https://tw.test/': html(OG_TWEET_HTML) });
    const content = 'https://www.instagram.com/p/AAA/ and https://x.com/u/status/33';

    const result = await fixLinksInContent(content, deps);

    expect(result.content).toBe('https://www.instagram.com/p/AAA/ and https://tw.test/u/status/33');
    expect(result.fixed).toBe(1);
    expect(result.unfixable).toBe(1);
  });

  it('is a no-op for text without links', async () => {
    const deps = fakeDeps({});
    expect(await fixLinksInContent('nothing here', deps)).toEqual({ content: 'nothing here', fixed: 0, unfixable: 0 });
    expect(deps.calls).toEqual([]);
  });
});
