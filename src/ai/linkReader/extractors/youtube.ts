// YouTube: the official oEmbed endpoint (title + channel, always works, no key) plus the watch page's
// embedded player response (description, duration, views, publish date) when YouTube serves it.
//
// Verified behavior (2026-09): a browser user agent from a datacenter IP is bounced to Google's
// "unusual traffic" page, while Discord's crawler user agent gets the full watch page (~1.9 MB, the
// player response JSON sits around 1.2 MB in), so the page is fetched as Discord's crawler with a
// larger cap than ordinary pages.
//
// Deliberately NOT done:
//   - transcripts: caption track URLs now require a proof-of-origin token (`exp=xpe`, empty 200s) and
//     the non-web InnerTube clients' URLs get "automated queries" blocks from server IPs, so nothing
//     no-key is robust enough to ship
//   - video understanding: with ZDR routing, Gemini only runs on Vertex, which accepts inline video data
//     but not YouTube URLs, and YouTube exposes no direct media file without cipher/PO-token work.
import { logger } from '../../../logger';
import { extractMetadata } from '../html';
import { DISCORD_CRAWLER_UA } from '../safeFetch';
import type { LinkContent, LinkVideo } from '../types';
import {
  ExtractError,
  type ExtractorContext,
  type Json,
  asRecord,
  capText,
  fetchHtml,
  fetchJson,
  num,
  parseDate,
  str,
} from './common';

const WATCH_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The JSON object literal starting at `start` (which must be `{`), found by tracking string/escape
 * state and brace depth — the player response is followed by more script, so a regex can't delimit it.
 */
export function sliceJsonObject(text: string, start: number): string | undefined {
  if (text[start] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** ytInitialPlayerResponse from a watch page, when present and parseable. Exported for tests. */
export function extractPlayerResponse(html: string): Json | undefined {
  const marker = html.indexOf('ytInitialPlayerResponse = {');
  if (marker === -1) return undefined;
  const json = sliceJsonObject(html, html.indexOf('{', marker));
  if (!json) return undefined;
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return undefined;
  }
}

type WatchPageInfo = {
  title?: string;
  channel?: string;
  description?: string;
  durationSecs?: number;
  views?: number;
  publishedAt?: number;
  category?: string;
  isLive?: boolean;
  playability?: string;
};

export function parseWatchPage(html: string, pageUrl: string): WatchPageInfo {
  const player = extractPlayerResponse(html);
  const details = asRecord(player?.videoDetails);
  const micro = asRecord(asRecord(player?.microformat)?.playerMicroformatRenderer);
  const playability = asRecord(player?.playabilityStatus);
  const status = str(playability?.status);
  const meta = extractMetadata(html, pageUrl);

  let playabilityNote: string | undefined;
  if (status === 'LOGIN_REQUIRED') playabilityNote = 'age-restricted or sign-in required';
  else if (status && status !== 'OK') playabilityNote = str(playability?.reason) ?? status.toLowerCase();

  // <title> alone is useless here: removed/private videos still serve "YouTube" or "- YouTube" pages.
  const pageTitle = meta.meta['og:title'] ?? meta.documentTitle?.replace(/\s*-\s*YouTube$/i, '');
  return {
    title: str(details?.title) ?? (pageTitle && !/^youtube$/i.test(pageTitle.trim()) ? pageTitle : undefined),
    channel: str(details?.author) ?? str(micro?.ownerChannelName),
    description: str(details?.shortDescription) ?? meta.description,
    durationSecs: num(details?.lengthSeconds),
    views: num(details?.viewCount),
    publishedAt: parseDate(str(micro?.publishDate) ?? str(micro?.uploadDate)),
    category: str(micro?.category),
    isLive: details?.isLiveContent === true || details?.isLive === true,
    playability: playabilityNote,
  };
}

function isWatchPageHost(url: string): boolean {
  try {
    return ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function readOEmbed(
  watchUrl: string,
  ctx: ExtractorContext,
): Promise<{ title?: string; channel?: string; status: number }> {
  const { result, json } = await fetchJson(
    ctx,
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
  );
  const body = asRecord(json);
  return { title: str(body?.title), channel: str(body?.author_name), status: result.status };
}

export async function readYouTube(
  target: { videoId: string; isShort: boolean; url: string },
  ctx: ExtractorContext,
): Promise<LinkContent> {
  const watchUrl = `https://www.youtube.com/watch?v=${target.videoId}`;
  const [oembed, page] = await Promise.allSettled([
    readOEmbed(watchUrl, ctx),
    fetchHtml(ctx, `${watchUrl}&hl=en`, { userAgent: DISCORD_CRAWLER_UA, maxBytes: WATCH_PAGE_MAX_BYTES }),
  ]);

  const embed = oembed.status === 'fulfilled' ? oembed.value : undefined;
  if (oembed.status === 'rejected')
    logger.info(`linkreader: youtube oEmbed failed for ${target.videoId}:`, oembed.reason);

  let info: WatchPageInfo = {};
  // Only trust a page that is still the watch page: EU consent walls (consent.youtube.com) and Google's
  // "unusual traffic" bounce are also 200s full of their own metadata.
  if (
    page.status === 'fulfilled' &&
    page.value.html &&
    page.value.result.ok &&
    isWatchPageHost(page.value.result.url)
  ) {
    info = parseWatchPage(page.value.html, page.value.result.url);
  } else if (page.status === 'rejected') {
    logger.info(`linkreader: youtube watch page failed for ${target.videoId}:`, page.reason);
  }

  const title = info.title ?? embed?.title;
  if (!title) {
    // oEmbed answers 400/404 for ids that don't exist and 401 for private ones; nothing else knew the video either.
    if (embed && embed.status >= 400)
      throw new ExtractError('that YouTube video is private, removed, or does not exist');
    throw new Error('YouTube returned neither oEmbed data nor a readable watch page');
  }

  const { text, truncated } = capText(info.description);
  const notes: string[] = [];
  if (info.playability) notes.push(info.playability);
  if (info.isLive) notes.push('livestream');
  if (!info.description) notes.push('description unavailable');

  const video: LinkVideo = {
    type: 'video',
    pageUrl: target.url,
    thumbnailUrl: `https://i.ytimg.com/vi/${target.videoId}/hqdefault.jpg`,
    durationSecs: info.durationSecs,
    note: "YouTube doesn't expose the video file; going by title and description",
  };

  return {
    url: target.url,
    source: 'youtube',
    kind: target.isShort ? 'youtube short' : 'youtube video',
    title,
    author: info.channel ?? embed?.channel,
    site: info.category ? `YouTube · ${info.category}` : undefined,
    publishedAt: info.publishedAt,
    text,
    textTruncated: truncated,
    stats: { views: info.views },
    media: [video],
    notes: notes.length > 0 ? notes : undefined,
  };
}
