// Which extractor handles a URL, and the canonical identity used as its cache key.
//
// Links reach the bot in many spellings of the same thing: x.com vs twitter.com vs the fixvx.com
// repost the link fixer just made, youtu.be vs youtube.com/watch vs /shorts/, profile-prefixed
// Instagram paths, … Each is mapped to one target with a stable key, so the enricher (which may see the
// original message) and the tool (which may be handed the fixer repost) share one cache entry.
import { config } from '../../config';
import { canonicalPath } from '../../links/embedFixers';

export type LinkTarget =
  | { source: 'twitter'; key: string; url: string; statusId: string }
  | { source: 'youtube'; key: string; url: string; videoId: string; isShort: boolean }
  | { source: 'tiktok'; key: string; url: string; path: string }
  | { source: 'instagram'; key: string; url: string; path: string }
  | { source: 'reddit'; key: string; url: string; postId?: string }
  | { source: 'bluesky'; key: string; url: string; actor: string; rkey: string }
  | { source: 'tenor'; key: string; url: string }
  | { source: 'klipy'; key: string; url: string; section: KlipySection }
  | { source: 'web'; key: string; url: string };

export type KlipySection = 'gifs' | 'stickers' | 'clips' | 'memes';

// Embed-fixer and mirror domains that serve the same path shapes as the platform they mirror, on top
// of whatever the link fixer is configured to rewrite to (config.links.*Fixers).
const TWITTER_DOMAINS = [
  'twitter.com',
  'x.com',
  'fxtwitter.com',
  'fixupx.com',
  'fixvx.com',
  'vxtwitter.com',
  'twittpr.com',
  'xcancel.com',
  'nitter.net',
];
const INSTAGRAM_DOMAINS = [
  'instagram.com',
  'ddinstagram.com',
  'kkinstagram.com',
  'uuinstagram.com',
  'instagramez.com',
  'vxinstagram.com',
  'eeinstagram.com',
];
const TIKTOK_DOMAINS = [
  'tiktok.com',
  'tnktok.com',
  'tiktxk.com',
  'vxtiktok.com',
  'fixtiktok.com',
  'tfxktok.com',
  'tiktokez.com',
];
const BLUESKY_DOMAINS = ['bsky.app', 'fxbsky.app', 'bskx.app', 'bsyy.app', 'vxbsky.app'];
const REDDIT_DOMAINS = ['reddit.com', 'rxddit.com', 'vxreddit.com'];
const YOUTUBE_DOMAINS = ['youtube.com', 'youtube-nocookie.com'];
// Discord's own links (message links, invites, attachments) are never worth fetching: attachments are
// already in the message and the rest is the Discord web app.
const DISCORD_DOMAINS = ['discord.com', 'discordapp.com', 'discord.gg', 'discordapp.net', 'discord.media'];

function hostIn(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.+$/, '');
}

export function isDiscordUrl(url: URL): boolean {
  return hostIn(normalizedHost(url), DISCORD_DOMAINS);
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeTarget(url: URL, host: string): LinkTarget | undefined {
  let id: string | undefined;
  let isShort = false;
  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    id = url.pathname.split('/')[1];
  } else if (hostIn(host, YOUTUBE_DOMAINS)) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'watch') id = url.searchParams.get('v') ?? segments[1];
    else if (segments[0] === 'shorts') {
      id = segments[1];
      isShort = true;
    } else if (['live', 'embed', 'v', 'e'].includes(segments[0] ?? '')) id = segments[1];
  }
  if (!id || !YOUTUBE_ID.test(id)) return undefined;
  const canonical = isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
  return { source: 'youtube', key: `youtube:${id}`, url: canonical, videoId: id, isShort };
}

function twitterTarget(url: URL): LinkTarget | undefined {
  const match = url.pathname.match(/^\/(?:i\/web|i|(\w{1,20}))\/status(?:es)?\/(\d{2,20})/);
  if (!match) return undefined;
  const statusId = match[2];
  return {
    source: 'twitter',
    key: `twitter:${statusId}`,
    url: `https://x.com/${match[1] ?? 'i'}/status/${statusId}`,
    statusId,
  };
}

function tiktokTarget(url: URL, host: string): LinkTarget | undefined {
  // Short links keep their own host (vm./vt.tiktok.com); everything else is read as a www.tiktok.com path.
  const isShortHost = /^(vm|vt)\.tiktok\.com$/.test(host);
  const probe = isShortHost ? url.toString() : `https://www.tiktok.com${url.pathname}`;
  const path = canonicalPath('tiktok', probe);
  if (!path) return undefined;
  const video = path.match(/\/(?:video|photo)\/(\d+)|^\/v\/(\d+)/);
  const short = path.match(/^\/t\/([A-Za-z0-9]+)/);
  const key = video ? `tiktok:${video[1] ?? video[2]}` : short ? `tiktok:t:${short[1]}` : `tiktok:${path}`;
  const canonical = short ? `https://vm.tiktok.com/${short[1]}/` : `https://www.tiktok.com${path}`;
  return { source: 'tiktok', key, url: canonical, path };
}

function instagramTarget(url: URL): LinkTarget | undefined {
  const path = canonicalPath('instagram', `https://www.instagram.com${url.pathname}`);
  if (!path) return undefined;
  const id = path.split('/').filter(Boolean)[1] ?? path;
  const key = path.startsWith('/share/') ? `instagram:share:${id}` : `instagram:${id}`;
  return { source: 'instagram', key, url: `https://www.instagram.com${path}`, path };
}

function redditTarget(url: URL, host: string): LinkTarget | undefined {
  if (host === 'redd.it') {
    const id = url.pathname.split('/')[1]?.toLowerCase();
    if (!id || !/^[a-z0-9]{3,12}$/.test(id)) return undefined;
    return { source: 'reddit', key: `reddit:${id}`, url: `https://www.reddit.com/comments/${id}/`, postId: id };
  }
  if (!hostIn(host, REDDIT_DOMAINS)) return undefined;
  const path = url.pathname;
  const post = path.match(/^\/(?:(?:r|u|user)\/[\w-]+\/)?(?:comments|gallery)\/([a-z0-9]{3,12})(?:\/[^/?#]*)?/i);
  if (post) {
    const id = post[1].toLowerCase();
    const canonicalPathPart = path.match(/^\/r\/[\w-]+\/comments\//i) ? post[0] : `/comments/${id}`;
    return {
      source: 'reddit',
      key: `reddit:${id}`,
      url: `https://www.reddit.com${canonicalPathPart.replace(/\/?$/, '/')}`,
      postId: id,
    };
  }
  // Share links (/r/<sub>/s/<code>) only resolve to a post through Reddit's redirect.
  const share = path.match(/^\/r\/[\w-]+\/s\/([A-Za-z0-9]+)/);
  if (share) return { source: 'reddit', key: `reddit:share:${share[1]}`, url: `https://www.reddit.com${share[0]}` };
  return undefined;
}

// Tenor's pages (not media.tenor.com / c.tenor.com: those are the GIF files themselves, read as images).
const TENOR_HOSTS = new Set(['tenor.com', 'www.tenor.com']);
const KLIPY_HOSTS = new Set(['klipy.com', 'www.klipy.com']);

function tenorTarget(url: URL): LinkTarget | undefined {
  // /view/<slug>-gif-<id>, optionally locale-prefixed (/es/view/…, /pt-BR/view/…).
  const view = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\/([^/]*?)(\d{6,25})\/?$/i);
  if (view) return { source: 'tenor', key: `tenor:${view[2]}`, url: `https://tenor.com/view/${view[1]}${view[2]}` };
  // Share short links (tenor.com/bEfN4.gif) redirect to the view page.
  const short = url.pathname.match(/^\/([A-Za-z0-9]{3,16})\.gif$/);
  if (short)
    return { source: 'tenor', key: `tenor:short:${short[1].toLowerCase()}`, url: `https://tenor.com/${short[1]}.gif` };
  return undefined;
}

function klipyTarget(url: URL): LinkTarget | undefined {
  const match = url.pathname.match(/^\/(gifs|stickers|clips|memes)\/([A-Za-z0-9_-]{1,200})\/?$/);
  if (!match) return undefined;
  const section = match[1] as KlipySection;
  return {
    source: 'klipy',
    key: `klipy:${section}/${match[2].toLowerCase()}`,
    url: `https://klipy.com/${section}/${match[2]}`,
    section,
  };
}

function blueskyTarget(url: URL): LinkTarget | undefined {
  const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([A-Za-z0-9._:~-]{1,64})\/?$/);
  if (!match) return undefined;
  const actor = decodeURIComponent(match[1]);
  if (!/^(did:[a-z]+:[A-Za-z0-9._:%-]+|[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.test(actor)) return undefined;
  return {
    source: 'bluesky',
    key: `bluesky:${actor.toLowerCase()}/${match[2]}`,
    url: `https://bsky.app/profile/${actor}/post/${match[2]}`,
    actor,
    rkey: match[2],
  };
}

/** The extractor target for a URL. Unrecognized shapes on known platforms fall back to a generic page read. */
export function identifyLink(url: URL): LinkTarget {
  const host = normalizedHost(url);
  let target: LinkTarget | undefined;
  if (hostIn(host, [...TWITTER_DOMAINS, ...config.links.twitterFixers])) target = twitterTarget(url);
  else if (host === 'youtu.be' || host.endsWith('.youtu.be') || hostIn(host, YOUTUBE_DOMAINS))
    target = youtubeTarget(url, host);
  else if (hostIn(host, [...TIKTOK_DOMAINS, ...config.links.tiktokFixers])) target = tiktokTarget(url, host);
  else if (hostIn(host, [...INSTAGRAM_DOMAINS, ...config.links.instagramFixers])) target = instagramTarget(url);
  else if (host === 'redd.it' || hostIn(host, REDDIT_DOMAINS)) target = redditTarget(url, host);
  else if (hostIn(host, BLUESKY_DOMAINS)) target = blueskyTarget(url);
  else if (TENOR_HOSTS.has(host)) target = tenorTarget(url);
  else if (KLIPY_HOSTS.has(host)) target = klipyTarget(url);
  if (target) return target;

  const clean = new URL(url.toString());
  clean.hash = '';
  return { source: 'web', key: `web:${clean.toString()}`, url: clean.toString() };
}

// ---- Finding links in a message ----

const MAX_URL_LENGTH = 2048;
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '!', '?', '*', '_', '~', '|', "'", '"']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/** Drops punctuation that belongs to the sentence or markdown, keeping balanced parens (Wikipedia URLs). */
function trimTrailing(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (!last) return url;
    if (TRAILING_PUNCTUATION.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && count(url, last) > count(url, opener)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Removes ``` fenced blocks and `inline code`: a link someone pasted as code is not a link they shared. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/(`{1,2})[^`\n]+?\1/g, ' ');
}

/**
 * The http(s) links a message shares, in order and deduplicated. Links in code and links wrapped in
 * <…> (the author suppressed the embed on purpose) are skipped, as are Discord's own links.
 */
export function findLinks(text: string): string[] {
  const source = stripCode(text);
  const found: string[] = [];
  for (const match of source.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const index = match.index ?? 0;
    if (index > 0 && source[index - 1] === '<') continue;
    const candidate = trimTrailing(match[0]);
    if (candidate.length > MAX_URL_LENGTH) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (isDiscordUrl(url)) continue;
    if (!found.includes(candidate)) found.push(candidate);
  }
  return found;
}
