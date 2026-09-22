// Rewrites Twitter/X, Instagram and TikTok links to "embed fixer" domains that serve Discord proper
// OpenGraph tags, with the resilience the platform reality demands:
//
//   - every platform has an ORDERED list of fixer domains (env-overridable); the first one that
//     actually answers with an embed wins, so a dead hobby instance degrades to the next instead of
//     silently breaking for weeks (zzinstagram.com died exactly that way)
//   - each candidate is probed with Discord's crawler user agent, because several fixers only serve
//     OpenGraph tags to bots; a fixer that is down (network error, 5xx, timeout, bounce to the
//     platform's login wall) is put in a short cooldown so a dead domain costs one probe per period
//   - links are canonicalized first: Instagram `/share/<id>` links and TikTok `vm.`/`vt.` short links
//     are resolved through the platform's own redirect (no login needed), and profile-prefixed
//     Instagram paths are reduced to the bare post path every fixer accepts
//   - when NO fixer works, the link is left untouched — the user keeps a raw link instead of a
//     guaranteed-broken one
import { config } from '../config';
import { logger } from '../logger';

export type Platform = 'twitter' | 'instagram' | 'tiktok';

export type LinkMatch = { platform: Platform; url: string; index: number };

export type FixerProbe = 'ok' | 'unavailable' | 'down';

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const MAX_REDIRECT_HOPS = 3;
const MAX_HTML_BYTES = 64 * 1024;
const FAILURES_BEFORE_COOLDOWN = 2;
const COOLDOWN_MS = 10 * 60 * 1000;

// One full-URL pattern per platform. The trailing `[^\s<>]*` swallows query strings and fragments so
// the whole token is replaced in the message. Only post-shaped paths match: profiles, tags, discover
// pages and stories are deliberately excluded (a fixer can't embed them and users lose their link).
const URL_PATTERNS: Record<Platform, RegExp> = {
  twitter: /https?:\/\/(?:[a-z0-9-]+\.)?(?:twitter|x)\.com\/\w+\/status\/\d+[^\s<>]*/gi,
  instagram:
    /https?:\/\/(?:[a-z0-9-]+\.)?instagram\.com\/(?:(?:[a-z0-9_.]+\/)?(?:p|reels?|tv)\/[A-Za-z0-9_-]+|share\/(?:(?:p|reels?)\/)?[A-Za-z0-9_-]+)\/?[^\s<>]*/gi,
  tiktok:
    /https?:\/\/(?:(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+|(?:[a-z0-9-]+\.)*tiktok\.com\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/[A-Za-z0-9]+|v\/\d+(?:\.html)?))\/?[^\s<>]*/gi,
};

const PLATFORM_HOSTS: Record<Platform, RegExp> = {
  twitter: /(?:^|\.)(?:twitter|x)\.com$/i,
  instagram: /(?:^|\.)instagram\.com$/i,
  tiktok: /(?:^|\.)tiktok\.com$/i,
};

/** Every fixable link in the text, in order. Links wrapped in `<...>` (embeds suppressed on purpose) are skipped. */
export function findLinks(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  for (const platform of Object.keys(URL_PATTERNS) as Platform[]) {
    const pattern = new RegExp(URL_PATTERNS[platform].source, URL_PATTERNS[platform].flags);
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > 0 && text[index - 1] === '<') continue;
      matches.push({ platform, url: match[0], index });
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
  }
}

/** True for the link shapes that need one redirect hop through the platform to reach the real post path. */
export function needsResolution(platform: Platform, path: string): boolean {
  return (platform === 'instagram' && path.startsWith('/share/')) || (platform === 'tiktok' && path.startsWith('/t/'));
}

/**
 * Follows the platform's own redirect for share/short links (Instagram answers `/share/<id>` and
 * TikTok answers `vm.tiktok.com/<code>` with a plain 302 — no login wall). Falls back to the input
 * path when the redirect doesn't yield a recognizable post (some fixers handle these shapes natively).
 */
export async function resolveCanonicalPath(
  platform: Platform,
  rawUrl: string,
  deps: FixerDeps = defaultDeps,
): Promise<string | undefined> {
  const path = canonicalPath(platform, rawUrl);
  if (!path || !needsResolution(platform, path)) return path;

  const origin = platform === 'instagram' ? 'https://www.instagram.com' : 'https://www.tiktok.com';
  const lookupUrl = platform === 'tiktok' ? `https://vm.tiktok.com/${path.slice('/t/'.length)}` : `${origin}${path}`;

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
  /\.(?:mp4|webm|mov|jpe?g|png|webp|gif)(?:\?|#|$)|cdninstagram\.com|fbcdn\.net|tiktokcdn|twimg\.com/i;
const PLATFORM_LOCATION = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:instagram\.com|tiktok\.com|twitter\.com|x\.com)\//i;
const EMBED_TAGS: Record<Platform, RegExp> = {
  twitter: /property="og:(?:description|image|video)"|name="twitter:card"/i,
  instagram: /property="og:(?:video|image)"|name="twitter:player"/i,
  tiktok: /property="og:(?:video|image)"|name="twitter:player"/i,
};
const NOT_FOUND_META = /content="[^"]*(?:post|video|content|page) not (?:found|available)/i;

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
    if (NOT_FOUND_META.test(html)) return 'unavailable';
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

/** Test-only: forgets every fixer's health state. */
export function resetFixerHealthForTesting(): void {
  health.clear();
}

// ---- Selection ----

/**
 * The first fixer URL that will embed, or undefined when none will. Domains in cooldown are skipped;
 * a domain that reports "unavailable" is skipped for this link only (the post may simply not exist
 * there), while "down" counts against its health.
 */
export async function pickFixerUrl(
  platform: Platform,
  path: string,
  deps: FixerDeps = defaultDeps,
): Promise<string | undefined> {
  const now = deps.now();
  const candidates = fixerDomains(platform).filter((domain) => !isCoolingDown(domain, now));
  if (candidates.length === 0) {
    logger.warn(`linkfix: every ${platform} fixer is cooling down; leaving link as-is`);
    return undefined;
  }

  if (!config.links.verify) {
    return `https://${candidates[0]}${path}`;
  }

  for (const domain of candidates) {
    const candidate = `https://${domain}${path}`;
    const result = await probeFixerUrl(platform, candidate, deps);
    if (result === 'ok') {
      recordSuccess(domain);
      return candidate;
    }
    if (result === 'down') {
      recordDown(domain, deps.now());
    }
    logger.info(`linkfix: ${domain} ${result} for ${platform} ${path}`);
  }
  return undefined;
}

export type FixResult = { content: string; fixed: number; unfixable: number };

/**
 * Replaces every fixable link in the text with a verified fixer URL. Links that can't be fixed (no
 * fixer answered, or the URL isn't a recognizable post) are left exactly as they were.
 */
export async function fixLinksInContent(content: string, deps: FixerDeps = defaultDeps): Promise<FixResult> {
  const links = findLinks(content);
  if (links.length === 0) return { content, fixed: 0, unfixable: 0 };

  const replacements = new Map<string, string>();
  let fixed = 0;
  let unfixable = 0;

  for (const link of links) {
    if (replacements.has(link.url)) continue;
    const path = await resolveCanonicalPath(link.platform, link.url, deps);
    const fixedUrl = path ? await pickFixerUrl(link.platform, path, deps) : undefined;
    if (fixedUrl) {
      replacements.set(link.url, fixedUrl);
      fixed++;
    } else {
      unfixable++;
    }
  }

  let output = content;
  for (const [original, replacement] of replacements) {
    output = output.split(original).join(replacement);
  }
  return { content: output, fixed, unfixable };
}
