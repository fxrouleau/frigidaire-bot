// Rewrites Twitter/X, Instagram, TikTok, Reddit and Bluesky links to "embed fixer" domains that serve
// Discord proper OpenGraph tags, with the resilience the platform reality demands:
//
//   - every platform has an ORDERED list of fixer domains (env-overridable); the first one that
//     actually answers with an embed wins, so a dead hobby instance degrades to the next instead of
//     silently breaking for weeks (zzinstagram.com died exactly that way)
//   - each candidate is probed with Discord's crawler user agent, because several fixers only serve
//     OpenGraph tags to bots; a fixer that is down (network error, 5xx, timeout, bounce to the
//     platform's login wall) is put in a short cooldown so a dead domain costs one probe per period,
//     and when every fixer of a platform is cooling down the platform is reported down (fixerHealth.ts)
//   - links are canonicalized first: Instagram `/share/<id>`, Reddit `/r/<sub>/s/<id>` and TikTok
//     `vm.`/`vt.` short links are resolved through the platform's own redirect (no login needed), and
//     profile-prefixed Instagram paths are reduced to the bare post path every fixer accepts
//   - matching is markdown-aware (markdown.ts): spoilers stay spoilered, masked links and bold/italic
//     keep their closing delimiters, and links in code or `<…>` are left alone
//   - foreign-language tweets get the fixer's translation suffix (tweetTranslation.ts)
//   - when NO fixer works, the link is left untouched — the user keeps a raw link instead of a
//     guaranteed-broken one
import { config } from '../config';
import { logger } from '../logger';
import { reportPlatformHealth, resetPlatformHealthForTesting } from './fixerHealth';
import { codeSpans, isInsideSpan, trimLinkEnd } from './markdown';
import { PLATFORMS, type Platform } from './platforms';
import { lookupTweetLanguage, shouldTranslate, supportsTranslation } from './tweetTranslation';

export type { Platform } from './platforms';

export type LinkMatch = { platform: Platform; url: string; index: number };

export type FixerProbe = 'ok' | 'unavailable' | 'down';

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const MAX_REDIRECT_HOPS = 3;
const MAX_HTML_BYTES = 64 * 1024;
const FAILURES_BEFORE_COOLDOWN = 2;
const COOLDOWN_MS = 10 * 60 * 1000;

// The post-shaped part of each platform's links. Only post-shaped paths match: profiles, tags,
// discover pages and stories are deliberately excluded (a fixer can't embed them and users lose their link).
const POST_PATTERNS: Record<Platform, RegExp> = {
  twitter: /https?:\/\/(?:[a-z0-9-]+\.)?(?:twitter|x)\.com\/\w+\/status\/\d+/,
  instagram:
    /https?:\/\/(?:[a-z0-9-]+\.)?instagram\.com\/(?:(?:[a-z0-9_.]+\/)?(?:p|reels?|tv)\/[A-Za-z0-9_-]+|share\/(?:(?:p|reels?)\/)?[A-Za-z0-9_-]+)\/?/,
  tiktok:
    /https?:\/\/(?:(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+|(?:[a-z0-9-]+\.)*tiktok\.com\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/[A-Za-z0-9]+|v\/\d+(?:\.html)?))\/?/,
  reddit:
    /https?:\/\/(?:(?:[a-z0-9-]+\.)?reddit\.com\/(?:(?:r|u|user)\/[\w-]+\/(?:comments\/[a-z0-9]+|s\/[A-Za-z0-9]+)|comments\/[a-z0-9]+)|(?:www\.)?redd\.it\/[a-z0-9]+)/,
  bluesky: /https?:\/\/(?:www\.)?bsky\.app\/profile\/[^\s/<>|`?#]+\/post\/[A-Za-z0-9]+/,
};

// Whatever follows the post-shaped part (query, fragment, extra path) is part of the token so the whole
// link is replaced. Whitespace, `<>` (embed suppression), `|` (spoilers), backticks (code) and square
// brackets (masked-link syntax — never raw in these platforms' URLs) always end it; trailing
// markdown/punctuation is trimmed afterwards (trimLinkEnd).
const TAIL = '[^\\s<>|`\\[\\]]*';

const URL_PATTERNS = Object.fromEntries(
  PLATFORMS.map((platform) => [platform, new RegExp(POST_PATTERNS[platform].source + TAIL, 'gi')]),
) as Record<Platform, RegExp>;

const PLATFORM_HOSTS: Record<Platform, RegExp> = {
  twitter: /(?:^|\.)(?:twitter|x)\.com$/i,
  instagram: /(?:^|\.)instagram\.com$/i,
  tiktok: /(?:^|\.)tiktok\.com$/i,
  reddit: /(?:^|\.)reddit\.com$|^(?:www\.)?redd\.it$/i,
  bluesky: /^(?:www\.)?bsky\.app$/i,
};

// Characters that only precede a URL when it is embedded in another one (query value, path, fragment).
const EMBEDDED_URL_PREFIX = /^[=/%?&#]$/;

/**
 * Every fixable link in the text, in order. Skipped: links wrapped in `<...>` (embeds suppressed on
 * purpose), links inside inline code or fenced code blocks (shown as text, never embedded), and post
 * URLs that are part of a longer URL.
 * Trailing markdown delimiters and sentence punctuation are not part of a match.
 */
export function findLinks(text: string): LinkMatch[] {
  const code = codeSpans(text);
  const matches: LinkMatch[] = [];
  for (const platform of PLATFORMS) {
    for (const match of text.matchAll(URL_PATTERNS[platform])) {
      const index = match.index ?? 0;
      const before = index > 0 ? text[index - 1] : '';
      if (before === '<') continue;
      // A post URL inside another URL (`https://example.com/?u=https://x.com/…`) is part of that link.
      if (EMBEDDED_URL_PREFIX.test(before)) continue;
      if (isInsideSpan(index, code)) continue;
      matches.push({ platform, url: trimLinkEnd(match[0], text.slice(0, index)), index });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

export function hasFixableLink(text: string): boolean {
  return findLinks(text).length > 0;
}

export function fixerDomains(platform: Platform): string[] {
  switch (platform) {
    case 'twitter':
      return config.links.twitterFixers;
    case 'instagram':
      return config.links.instagramFixers;
    case 'tiktok':
      return config.links.tiktokFixers;
    case 'reddit':
      return config.links.redditFixers;
    case 'bluesky':
      return config.links.blueskyFixers;
  }
}

// ---- Canonical paths ----

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

// A Bluesky profile segment: a handle (always contains a dot) or a DID.
const BLUESKY_ACTOR = /^(?:did:[a-z]+:[A-Za-z0-9._:%-]+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;

/**
 * The platform-neutral path a fixer domain accepts for this link, or undefined when the URL is not a
 * recognizable post. Pure: never touches the network. Share links and short links keep their original
 * path here; resolveCanonicalPath() turns those into the real post path.
 */
export function canonicalPath(platform: Platform, rawUrl: string): string | undefined {
  const url = safeUrl(rawUrl);
  if (!url || !PLATFORM_HOSTS[platform].test(url.hostname)) return undefined;
  const path = url.pathname;

  switch (platform) {
    case 'twitter': {
      const match = path.match(/^\/(\w+)\/status\/(\d+)/);
      return match ? `/${match[1]}/status/${match[2]}` : undefined;
    }
    case 'instagram': {
      // Share links first: `/share/reel/<id>` would otherwise read as user "share" + a reel.
      const share = path.match(/^\/share\/(?:(?:p|reels?)\/)?([A-Za-z0-9_-]+)/i);
      if (share) return `/share/${share[1]}/`;
      const post = path.match(/^\/(?:[a-z0-9_.]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]+)/i);
      if (!post) return undefined;
      const kind = post[1].toLowerCase() === 'reels' ? 'reel' : post[1].toLowerCase();
      return `/${kind}/${post[2]}/`;
    }
    case 'tiktok': {
      if (/^(vm|vt)\.tiktok\.com$/i.test(url.hostname)) {
        const code = path.match(/^\/([A-Za-z0-9]+)/);
        return code ? `/t/${code[1]}` : undefined;
      }
      const video = path.match(/^\/(@[\w.-]+)\/(video|photo)\/(\d+)/);
      if (video) return `/${video[1]}/${video[2]}/${video[3]}`;
      const short = path.match(/^\/t\/([A-Za-z0-9]+)/);
      if (short) return `/t/${short[1]}`;
      const legacy = path.match(/^\/v\/(\d+)/);
      return legacy ? `/v/${legacy[1]}.html` : undefined;
    }
    case 'reddit': {
      // Both reddit fixers accept the bare post id (`/<id>`), which is all a redd.it link carries.
      if (/redd\.it$/i.test(url.hostname)) {
        const short = path.match(/^\/([a-z0-9]+)\/?$/i);
        return short ? `/${short[1].toLowerCase()}` : undefined;
      }
      const share = path.match(/^\/(r|u|user)\/([\w-]+)\/s\/([A-Za-z0-9]+)/i);
      if (share) return `/${share[1].toLowerCase()}/${share[2]}/s/${share[3]}`;
      const post = path.match(/^\/(?:(r|u|user)\/([\w-]+)\/)?comments\/([a-z0-9]+)(?:\/([^/]*)\/([a-z0-9]+))?/i);
      if (!post) return undefined;
      const id = post[3].toLowerCase();
      // A comment permalink keeps its comment id (the fixers embed the comment); the slug is cosmetic.
      const comment = post[5] ? `${/^[\w-]+$/.test(post[4]) ? post[4] : '_'}/${post[5].toLowerCase()}/` : '';
      if (!post[1]) return comment ? `/comments/${id}/${comment}` : `/${id}`;
      return `/${post[1].toLowerCase()}/${post[2]}/comments/${id}/${comment}`;
    }
    case 'bluesky': {
      const post = path.match(/^\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)/);
      if (!post || !BLUESKY_ACTOR.test(post[1])) return undefined;
      return `/profile/${post[1]}/post/${post[2]}`;
    }
  }
}

/** True for the link shapes that need one redirect hop through the platform to reach the real post path. */
export function needsResolution(platform: Platform, path: string): boolean {
  switch (platform) {
    case 'instagram':
      return path.startsWith('/share/');
    case 'tiktok':
      return path.startsWith('/t/');
    case 'reddit':
      return /^\/(?:r|u|user)\/[^/]+\/s\//.test(path);
    default:
      return false;
  }
}

function resolutionUrl(platform: Platform, path: string): string {
  switch (platform) {
    case 'tiktok':
      return `https://vm.tiktok.com/${path.slice('/t/'.length)}`;
    case 'reddit':
      return `https://www.reddit.com${path}`;
    default:
      return `https://www.instagram.com${path}`;
  }
}

/**
 * Follows the platform's own redirect for share/short links (Instagram answers `/share/<id>`, Reddit
 * `/r/<sub>/s/<id>` and TikTok `vm.tiktok.com/<code>` with a plain 30x — no login wall). Falls back to
 * the input path when the redirect doesn't yield a recognizable post (the fixers handle these shapes
 * natively, just less reliably).
 */
export async function resolveCanonicalPath(
  platform: Platform,
  rawUrl: string,
  deps: FixerDeps = defaultDeps,
): Promise<string | undefined> {
  const path = canonicalPath(platform, rawUrl);
  if (!path || !needsResolution(platform, path)) return path;

  const lookupUrl = resolutionUrl(platform, path);
  try {
    const response = await deps.fetch(lookupUrl, {
      method: 'GET',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(config.links.timeoutMs),
    });
    await discardBody(response);
    const location = response.headers.get('location');
    if (location) {
      const resolved = canonicalPath(platform, new URL(location, lookupUrl).toString());
      if (resolved && !needsResolution(platform, resolved)) return resolved;
    }
    logger.info(`linkfix: ${platform} ${path} did not resolve via redirect (HTTP ${response.status}); using as-is`);
  } catch (error) {
    logger.info(`linkfix: ${platform} ${path} redirect lookup failed; using as-is:`, error);
  }
  return path;
}

// ---- Probing ----

export type FixerDeps = {
  fetch: typeof globalThis.fetch;
  now: () => number;
};

const defaultDeps: FixerDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
};

const MEDIA_LOCATION =
  /\.(?:mp4|webm|mov|jpe?g|png|webp|gif)(?:\?|#|$)|cdninstagram\.com|fbcdn\.net|tiktokcdn|twimg\.com|\/\/(?:i|v|preview)\.redd\.it\/|\/\/(?:cdn|video)\.bsky\.app\//i;
const PLATFORM_LOCATION =
  /^https?:\/\/(?:(?:[a-z0-9-]+\.)?(?:instagram\.com|tiktok\.com|twitter\.com|x\.com|reddit\.com|bsky\.app)|(?:www\.)?redd\.it)\//i;

// Fixers write OpenGraph/Twitter-card tags with either `property=` or `name=`; accept both.
function metaTags(names: string): RegExp {
  return new RegExp(`(?:property|name)="(?:${names})"`, 'i');
}

// What counts as "an embed will render", per platform. Tweets, Reddit and Bluesky posts can be
// text-only (a description is the whole embed); Instagram and TikTok posts are always media.
const EMBED_TAGS: Record<Platform, RegExp> = {
  twitter: metaTags('og:(?:description|image|video)|twitter:card'),
  instagram: metaTags('og:(?:video|image)|twitter:player'),
  tiktok: metaTags('og:(?:video|image)|twitter:player'),
  reddit: metaTags('og:(?:description|image|video)|twitter:(?:card|player)'),
  bluesky: metaTags('og:(?:description|image|video)|twitter:(?:card|player)'),
};

// "The fixer is up but has nothing for this post" pages that still answer 200 with OpenGraph tags:
// InstaFix ("Post not found"), FxTwitter/FxBluesky ("Sorry, that post doesn't exist :("), vxTwitter
// ("Failed to scan your link!" for a deleted tweet), vxReddit ("Failed to get data from Reddit") and
// xbsky ("An error occurred" as the title).
const NOT_FOUND_META = [
  /content="[^"]*(?:post|tweet|video|content|page) (?:not (?:found|available)|does(?:n(?:'|&#0?39;|&#x27;|’)t| not) exist)/i,
  /content="failed to (?:get (?:data|post)|scan your link)/i,
  /(?:property|name)="og:title" content="an error occurred"/i,
];

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do — the body is irrelevant once we've read the headers.
  }
}

/**
 * Asks a fixer URL for what Discord's crawler would see and classifies the answer:
 *   ok          – an embed will render (OpenGraph media tags, or a redirect straight to the media file)
 *   unavailable – the fixer is up but has nothing for this post (404 / "not found" page)
 *   down        – the fixer itself is unusable (network error, timeout, 5xx, bounce to a login wall)
 */
export async function probeFixerUrl(
  platform: Platform,
  url: string,
  deps: FixerDeps = defaultDeps,
): Promise<FixerProbe> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await deps.fetch(current, {
        method: 'GET',
        headers: { 'user-agent': DISCORD_UA, accept: 'text/html,*/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(config.links.timeoutMs),
      });
    } catch {
      return 'down';
    }

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      const location = response.headers.get('location');
      if (!location) return 'down';
      const target = new URL(location, current).toString();
      if (MEDIA_LOCATION.test(target)) return 'ok';
      if (PLATFORM_LOCATION.test(target)) return 'down';
      current = target;
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      await discardBody(response);
      return 'unavailable';
    }
    if (!response.ok) {
      await discardBody(response);
      return 'down';
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (/^(?:video|image)\//i.test(contentType)) {
      await discardBody(response);
      return 'ok';
    }

    let html: string;
    try {
      html = (await response.text()).slice(0, MAX_HTML_BYTES);
    } catch {
      return 'down';
    }
    if (NOT_FOUND_META.some((pattern) => pattern.test(html))) return 'unavailable';
    return EMBED_TAGS[platform].test(html) ? 'ok' : 'unavailable';
  }
  return 'down';
}

// ---- Health tracking ----

type FixerHealth = { consecutiveFailures: number; cooldownUntil: number };

const health = new Map<string, FixerHealth>();

function isCoolingDown(domain: string, now: number): boolean {
  const entry = health.get(domain);
  return entry !== undefined && entry.cooldownUntil > now;
}

function recordSuccess(domain: string): void {
  health.delete(domain);
}

function recordDown(domain: string, now: number): void {
  const entry = health.get(domain) ?? { consecutiveFailures: 0, cooldownUntil: 0 };
  entry.consecutiveFailures++;
  if (entry.consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) {
    entry.cooldownUntil = now + COOLDOWN_MS;
    logger.warn(`linkfix: ${domain} is down (${entry.consecutiveFailures} failures); cooling down for 10 min`);
  }
  health.set(domain, entry);
}

/** Test-only: forgets every fixer's and every platform's health state. */
export function resetFixerHealthForTesting(): void {
  health.clear();
  resetPlatformHealthForTesting();
}

// ---- Selection ----

function describeOutage(domains: string[], results: ReadonlyMap<string, FixerProbe>): string {
  return domains.map((domain) => `${domain}: ${results.get(domain) ?? 'cooling down'}`).join(', ');
}

/**
 * The first fixer URL that will embed, or undefined when none will. Domains in cooldown are skipped;
 * a domain that reports "unavailable" is skipped for this link only (the post may simply not exist
 * there), while "down" counts against its health.
 *
 * Also the platform's health verdict: a working fixer means the platform is up; every configured
 * fixer in cooldown (each failed twice in a row) means it is down. Anything in between says nothing —
 * an "unavailable" answer proves the fixer is alive, and one failure isn't an outage yet.
 */
export async function pickFixerUrl(
  platform: Platform,
  path: string,
  deps: FixerDeps = defaultDeps,
): Promise<string | undefined> {
  const domains = fixerDomains(platform);
  const now = deps.now();
  const candidates = domains.filter((domain) => !isCoolingDown(domain, now));
  if (candidates.length === 0) {
    logger.warn(`linkfix: every ${platform} fixer is cooling down; leaving link as-is`);
    reportPlatformHealth(platform, 'down', now, describeOutage(domains, new Map()));
    return undefined;
  }

  if (!config.links.verify) {
    return `https://${candidates[0]}${path}`;
  }

  const results = new Map<string, FixerProbe>();
  for (const domain of candidates) {
    const candidate = `https://${domain}${path}`;
    const result = await probeFixerUrl(platform, candidate, deps);
    results.set(domain, result);
    if (result === 'ok') {
      recordSuccess(domain);
      reportPlatformHealth(platform, 'up', deps.now(), domain);
      return candidate;
    }
    if (result === 'down') {
      recordDown(domain, deps.now());
    }
    logger.info(`linkfix: ${domain} ${result} for ${platform} ${path}`);
  }

  const after = deps.now();
  if (domains.every((domain) => isCoolingDown(domain, after))) {
    reportPlatformHealth(platform, 'down', after, describeOutage(domains, results));
  }
  return undefined;
}

type FixedLink = { url: string; translated: boolean };

/**
 * Picks the fixer URL for one link and, for a foreign-language tweet, appends the translation suffix.
 * The language lookup starts before the probe so the two overlap instead of adding up.
 */
async function fixLink(link: LinkMatch, deps: FixerDeps): Promise<FixedLink | undefined> {
  const path = await resolveCanonicalPath(link.platform, link.url, deps);
  if (!path) return undefined;

  const target = link.platform === 'twitter' ? config.links.twitterTranslateTo : undefined;
  const statusId = path.match(/\/status\/(\d+)$/)?.[1];
  const language =
    target && statusId && fixerDomains('twitter').some(supportsTranslation)
      ? lookupTweetLanguage(statusId, deps.fetch, config.links.timeoutMs)
      : undefined;

  const fixedUrl = await pickFixerUrl(link.platform, path, deps);
  if (!fixedUrl) return undefined;
  if (!target || !language || !supportsTranslation(new URL(fixedUrl).hostname)) {
    return { url: fixedUrl, translated: false };
  }
  const lang = await language;
  if (!shouldTranslate(lang, target)) return { url: fixedUrl, translated: false };
  logger.info(`linkfix: translating tweet ${statusId} (${lang} → ${target})`);
  return { url: `${fixedUrl}/${target}`, translated: true };
}

export type FixResult = { content: string; fixed: number; unfixable: number; translated: number };

/**
 * Replaces every fixable link in the text with a verified fixer URL. Links that can't be fixed (no
 * fixer answered, or the URL isn't a recognizable post) are left exactly as they were. Replacement is
 * positional: the same URL elsewhere in the text (in code, or `<…>`-suppressed) stays untouched.
 */
export async function fixLinksInContent(content: string, deps: FixerDeps = defaultDeps): Promise<FixResult> {
  const links = findLinks(content);
  if (links.length === 0) return { content, fixed: 0, unfixable: 0, translated: 0 };

  const outcomes = new Map<string, FixedLink | undefined>();
  let fixed = 0;
  let unfixable = 0;
  let translated = 0;

  for (const link of links) {
    if (outcomes.has(link.url)) continue;
    const outcome = await fixLink(link, deps);
    outcomes.set(link.url, outcome);
    if (!outcome) {
      unfixable++;
      continue;
    }
    fixed++;
    if (outcome.translated) translated++;
  }

  let output = '';
  let cursor = 0;
  for (const link of links) {
    const outcome = outcomes.get(link.url);
    if (!outcome) continue;
    output += content.slice(cursor, link.index) + outcome.url;
    cursor = link.index + link.url.length;
  }
  output += content.slice(cursor);
  return { content: output, fixed, unfixable, translated };
}
