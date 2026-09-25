// TikTok and Instagram: neither has a no-key API, so the embed fixers the link fixer already relies on
// (config.links.tiktokFixers / instagramFixers) are read the way Discord reads them — with Discord's
// crawler user agent — and their OpenGraph tags give the caption, account and a direct video file.
//
// Verified shapes (2026-09): tnktok/fixtiktok serve og:description (caption), og:title
// "Name (@handle)" and og:video (an mp4 that 302s to TikTok's CDN); uuinstagram serves og:description
// and a RELATIVE og:video (/videos/<id>/1); kkinstagram answers with a 302 straight to the fbcdn mp4
// (no HTML at all). TikTok's official oEmbed (no key) adds the caption, author and a thumbnail;
// Instagram's own page gives crawlers the account name and a thumbnail but no caption.
import { config } from '../../../config';
import { canonicalPath, needsResolution } from '../../../links/embedFixers';
import { logger } from '../../../logger';
import { type PageMetadata, extractMetadata } from '../html';
import { BlockedUrlError, DISCORD_CRAWLER_UA } from '../safeFetch';
import type { LinkContent, LinkMedia } from '../types';
import {
  ExtractError,
  type ExtractorContext,
  asRecord,
  capText,
  fetchHtml,
  fetchJson,
  num,
  resolveRedirect,
  str,
} from './common';

const FIXER_COOLDOWN_MS = 10 * 60 * 1000;
const FIXER_PAGE_MAX_BYTES = 512 * 1024;
// The platforms' own share/short-link redirects are answered for browsers (see embedFixers.ts).
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

type FixerPage = {
  domain: string;
  meta?: PageMetadata;
  /** Some fixers redirect straight to the media file instead of serving a page. */
  directMedia?: { url: string; contentType: string; sizeBytes?: number };
};

const PLATFORM_PAGE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:instagram\.com|tiktok\.com)\//i;

function isVideoFile(video: { url: string; type?: string }): boolean {
  if (video.type) return video.type.toLowerCase().startsWith('video/');
  return /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(video.url);
}

/** The first configured fixer that yields something readable for this path. */
async function readFixerPage(ctx: ExtractorContext, domains: string[], path: string): Promise<FixerPage | undefined> {
  for (const domain of domains) {
    const healthKey = `fixer:${domain}`;
    if (ctx.isCoolingDown(healthKey)) continue;
    try {
      const { result, html } = await fetchHtml(ctx, `https://${domain}${path}`, {
        userAgent: DISCORD_CRAWLER_UA,
        maxBytes: FIXER_PAGE_MAX_BYTES,
      });
      if (/^(?:video|image)\//.test(result.contentType)) {
        const size = num(result.headers['content-length']);
        return { domain, directMedia: { url: result.url, contentType: result.contentType, sizeBytes: size } };
      }
      if (result.status >= 500) {
        ctx.coolDown(healthKey, FIXER_COOLDOWN_MS);
        continue;
      }
      // A 404/"not found" is about this post, not the fixer; a bounce to the platform is its login wall.
      if (!result.ok || !html || PLATFORM_PAGE.test(result.url)) continue;
      const meta = extractMetadata(html, result.url);
      if (!meta.description && meta.videos.length === 0 && meta.images.length === 0) continue;
      return { domain, meta };
    } catch (error) {
      if (!(error instanceof BlockedUrlError)) ctx.coolDown(healthKey, FIXER_COOLDOWN_MS);
      logger.info(`linkreader: fixer ${domain} failed for ${path}:`, error instanceof Error ? error.message : error);
    }
  }
  return undefined;
}

/** "Name (@handle)" / "Name ✔ (@handle) • Instagram reel" / "@handle • …" / "Name on Instagram: …" → parts. */
export function parseAccountTitle(title: string | undefined): { author?: string; handle?: string } {
  if (!title) return {};
  const full = title.match(/^(.*?)\s*[✔✓]?\s*\(@([\w.]+)\)/u);
  if (full) return { author: full[1].trim() || undefined, handle: full[2] };
  const bare = title.trim().match(/^@([\w.]+)(?:\s*[•·|].*)?$/u);
  if (bare) return { handle: bare[1] };
  const on = title.match(/^(.{1,80}?) on (?:Instagram|TikTok)\b/);
  return on ? { author: on[1].trim() } : {};
}

async function resolveSharePath(
  ctx: ExtractorContext,
  platform: 'tiktok' | 'instagram',
  lookupUrl: string,
): Promise<string | undefined> {
  try {
    const location = await resolveRedirect(ctx, lookupUrl, BROWSER_UA);
    const resolved = location ? canonicalPath(platform, location) : undefined;
    return resolved && !needsResolution(platform, resolved) ? resolved : undefined;
  } catch (error) {
    logger.info(
      `linkreader: ${platform} short link ${lookupUrl} did not resolve:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

function videoFrom(fixer: FixerPage | undefined, thumbnailUrl: string | undefined): LinkMedia {
  const direct = fixer?.directMedia?.contentType.startsWith('video/') ? fixer.directMedia : undefined;
  const fromMeta = fixer?.meta?.videos.find(isVideoFile);
  const url = direct?.url ?? fromMeta?.url;
  return {
    type: 'video',
    url,
    thumbnailUrl,
    contentType: direct?.contentType ?? fromMeta?.type ?? (url ? 'video/mp4' : undefined),
    sizeBytes: direct?.sizeBytes,
    note: url ? undefined : 'no playable file found',
  };
}

// ---- TikTok ----

type TikTokOEmbed = { caption?: string; author?: string; handle?: string; thumbnailUrl?: string };

async function readTikTokOEmbed(url: string, ctx: ExtractorContext): Promise<TikTokOEmbed | undefined> {
  const { result, json } = await fetchJson(ctx, `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  const body = asRecord(json);
  if (!result.ok || !body) return undefined;
  const authorUrl = str(body.author_url);
  return {
    caption: str(body.title),
    author: str(body.author_name),
    handle: str(body.author_unique_id) ?? authorUrl?.match(/\/@([\w.-]+)/)?.[1],
    thumbnailUrl: str(body.thumbnail_url),
  };
}

export async function readTikTok(target: { path: string; url: string }, ctx: ExtractorContext): Promise<LinkContent> {
  let path = target.path;
  if (needsResolution('tiktok', path)) path = (await resolveSharePath(ctx, 'tiktok', target.url)) ?? path;
  const resolved = !needsResolution('tiktok', path);
  const canonicalUrl = resolved ? `https://www.tiktok.com${path}` : target.url;

  const [oembed, fixer] = await Promise.all([
    resolved
      ? readTikTokOEmbed(canonicalUrl, ctx).catch((error: unknown) => {
          logger.info(`linkreader: tiktok oEmbed failed for ${path}:`, error instanceof Error ? error.message : error);
          return undefined;
        })
      : Promise.resolve(undefined),
    readFixerPage(ctx, config.links.tiktokFixers, path),
  ]);
  if (!oembed && !fixer) {
    throw new ExtractError("couldn't read that TikTok (private or deleted, or the embed services are down)");
  }

  const meta = fixer?.meta;
  const account = parseAccountTitle(meta?.title);
  const { text, truncated } = capText(oembed?.caption ?? meta?.description, 2000);
  const thumbnail = oembed?.thumbnailUrl ?? meta?.images[0];
  const media: LinkMedia[] = path.includes('/photo/')
    ? (meta?.images ?? (thumbnail ? [thumbnail] : [])).slice(0, 4).map((url): LinkMedia => ({ type: 'image', url }))
    : [videoFrom(fixer, thumbnail)];

  return {
    url: canonicalUrl,
    source: 'tiktok',
    kind: 'tiktok',
    author: oembed?.author ?? account.author,
    handle: oembed?.handle ?? account.handle ?? path.match(/^\/@([\w.-]+)/)?.[1],
    text,
    textTruncated: truncated,
    media,
  };
}

// ---- Instagram ----

export async function readInstagram(
  target: { path: string; url: string },
  ctx: ExtractorContext,
): Promise<LinkContent> {
  let path = target.path;
  if (needsResolution('instagram', path)) {
    const resolved = await resolveSharePath(ctx, 'instagram', `https://www.instagram.com${path}`);
    if (!resolved) throw new ExtractError("couldn't resolve that Instagram share link");
    path = resolved;
  }
  const canonicalUrl = `https://www.instagram.com${path}`;
  const isPost = path.startsWith('/p/');

  const fixer = await readFixerPage(ctx, config.links.instagramFixers, path);
  let platform: PageMetadata | undefined;
  if (!fixer?.meta?.description) {
    // Instagram's own page still tells crawlers whose post it is and shows a thumbnail.
    try {
      const { result, html } = await fetchHtml(ctx, canonicalUrl, {
        userAgent: DISCORD_CRAWLER_UA,
        maxBytes: 1024 * 1024,
      });
      if (result.ok && html && !/\/accounts\/login/.test(result.url)) platform = extractMetadata(html, result.url);
    } catch (error) {
      logger.info(`linkreader: instagram page failed for ${path}:`, error instanceof Error ? error.message : error);
    }
  }
  if (!fixer && !platform?.images.length) {
    throw new ExtractError("couldn't read that Instagram post (private or deleted, or the embed services are down)");
  }

  const meta = fixer?.meta;
  const fromFixer = parseAccountTitle(meta?.title);
  const fromPlatform = parseAccountTitle(platform?.title);
  const { text, truncated } = capText(meta?.description ?? platform?.description, 2000);
  const images = [...(meta?.images ?? []), ...(platform?.images ?? [])];
  const hasVideo = Boolean(fixer?.directMedia?.contentType.startsWith('video/') || meta?.videos.some(isVideoFile));

  const media: LinkMedia[] =
    isPost && !hasVideo
      ? [...(fixer?.directMedia?.contentType.startsWith('image/') ? [fixer.directMedia.url] : []), ...images]
          .slice(0, 4)
          .map((url): LinkMedia => ({ type: 'image', url }))
      : [videoFrom(fixer, images[0])];

  return {
    url: canonicalUrl,
    source: 'instagram',
    kind: isPost && !hasVideo ? 'instagram post' : 'instagram reel',
    author: fromFixer.author ?? fromPlatform.author,
    handle: fromFixer.handle ?? fromPlatform.handle,
    text,
    textTruncated: truncated,
    media,
    notes: text ? undefined : ['caption unavailable'],
  };
}
