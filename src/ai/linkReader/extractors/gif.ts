// Tenor and Klipy GIF pages. Discord's GIF picker moved from Tenor to Klipy (Tenor's API shut down in
// June 2026), so people now post klipy.com links the bot previously saw only as a bare URL.
//
// Verified page shapes (2026-09, fetched with Discord's crawler user agent):
//   - Tenor /view/<slug>-<id>: og:title "<Title> - Discover & Share GIFs", og:image = the GIF, og:video =
//     mp4/webm, JSON-LD Article whose `image` ImageObject carries a static PNG `thumbnailUrl`, and the
//     main <img> (src on media*.tenor.com) has a real content description in its alt text ("a black cat
//     wearing a striped tie …"). tenor.com/<code>.gif short links 301 to the view page.
//   - Klipy /gifs|stickers|clips|memes/<slug>: og:title "KLIPY: <Name> GIF – View & Share", og:image =
//     a webp still and the GIF, og:video = mp4; JSON-LD ImageObject (GIFs) or VideoObject (clips) with
//     the clean `name`, a still `thumbnailUrl` and, for clips, a tag list in `description`.
// The model gets the title, the description/tags, and a still frame as the image (models read the
// first frame of an animated GIF anyway, and a still is a fraction of the bytes).
import { logger } from '../../../logger';
import { extractJsonLd, extractMetadata, findTags } from '../html';
import { DISCORD_CRAWLER_UA } from '../safeFetch';
import type { KlipySection } from '../targets';
import type { LinkContent, LinkKind, LinkMedia } from '../types';
import { type ExtractorContext, ExtractError, type Json, asRecord, capText, fetchHtml, parseDate, str } from './common';

const PAGE_MAX_BYTES = 1024 * 1024;
// Keywords every GIF page carries; they say nothing about this one.
const GENERIC_TAGS = new Set(['gif', 'gifs', 'animated gif', 'animated gifs', 'meme', 'memes', 'sticker', 'stickers', 'clip', 'clips']);

type MediaObject = { name?: string; description?: string; contentUrl?: string; thumbnailUrl?: string; creator?: string; date?: number };

/** The first JSON-LD ImageObject/VideoObject, looking inside `image`/`video` of a wrapping Article too. */
function findMediaObject(blocks: unknown[]): MediaObject | undefined {
  const candidates: Json[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 3) return;
    for (const item of Array.isArray(value) ? value : [value]) {
      const node = asRecord(item);
      if (!node) continue;
      const type = str(node['@type'])?.toLowerCase();
      if (type === 'imageobject' || type === 'videoobject') candidates.push(node);
      for (const key of ['@graph', 'image', 'video']) if (key in node) visit(node[key], depth + 1);
    }
  };
  for (const block of blocks) visit(block, 0);
  const best = candidates.find((c) => str(c.contentUrl)) ?? candidates[0];
  if (!best) return undefined;
  const creator = asRecord(best.creator);
  return {
    name: str(best.name),
    description: str(best.description),
    contentUrl: str(best.contentUrl),
    thumbnailUrl: str(best.thumbnailUrl),
    creator: str(best.creator) ?? str(creator?.name) ?? str(best.author),
    date: parseDate(str(best.uploadDate) ?? str(best.dateCreated)),
  };
}

/** "Sir Cat Meme - Sir cat - Discover & Share GIFs" / "KLIPY: Cat Reaction GIF – View & Share" → the name. */
export function cleanGifTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const cleaned = title
    .replace(/^KLIPY:\s*/i, '')
    .replace(/\s*[-–—]\s*(?:Discover\s*&\s*Share\s+GIFs|View\s*&\s*Share)\s*$/i, '')
    .replace(/\s+(?:GIF|Sticker|Clip|Meme)$/i, '')
    .trim();
  return cleaned || undefined;
}

function usefulTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const tags = raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && !GENERIC_TAGS.has(tag.toLowerCase()));
  return [...new Set(tags)].slice(0, 12);
}

/** Tenor's main GIF <img> alt text: a real description of what the GIF shows. */
function tenorAltText(html: string): string | undefined {
  for (const img of findTags(html, ['img'])) {
    const src = img.attrs.src ?? '';
    const alt = img.attrs.alt?.trim();
    if (alt && /^https:\/\/media\d*\.tenor\.com\//.test(src)) return alt.replace(/\s+\.$/, '.');
  }
  return undefined;
}

function kindFor(source: 'tenor' | 'klipy', section: KlipySection | undefined): LinkKind {
  if (source === 'klipy' && section === 'clips') return 'video clip';
  if (source === 'klipy' && section === 'stickers') return 'sticker';
  return 'gif';
}

function isVideoFileUrl(url: string | undefined): url is string {
  return Boolean(url && /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url));
}

export async function readGif(
  target: { source: 'tenor' | 'klipy'; url: string; section?: KlipySection },
  ctx: ExtractorContext,
): Promise<LinkContent> {
  const { result, html } = await fetchHtml(ctx, target.url, { userAgent: DISCORD_CRAWLER_UA, maxBytes: PAGE_MAX_BYTES });
  if (result.status === 404 || result.status === 410) {
    throw new ExtractError(`that ${target.source === 'tenor' ? 'Tenor' : 'Klipy'} page does not exist`);
  }
  if (!result.ok || !html) throw new Error(`${target.source} answered HTTP ${result.status}`);

  const meta = extractMetadata(html, result.url);
  const object = findMediaObject(extractJsonLd(html));
  const title = object?.name ?? cleanGifTitle(meta.title);
  // Tenor serves its 404 page with a 200 on some paths ("404 Error" everywhere).
  if (!title || /^404\b/.test(title)) throw new ExtractError(`that ${target.source === 'tenor' ? 'Tenor' : 'Klipy'} GIF does not exist`);

  const kind = kindFor(target.source, target.section);
  const alt = target.source === 'tenor' ? tenorAltText(html) : undefined;
  const tags = usefulTags(meta.meta.keywords ?? (kind === 'video clip' ? object?.description : undefined));
  const description = [alt, tags.length > 0 ? `tags: ${tags.join(', ')}` : undefined].filter(Boolean).join('\n');

  const media: LinkMedia[] = [];
  // A still first (what the model is shown), then the animation itself for reference.
  const still = object?.thumbnailUrl ?? meta.images.find((url) => !/\.gif(?:[?#]|$)/i.test(url));
  const animated = meta.images.find((url) => /\.gif(?:[?#]|$)/i.test(url)) ?? object?.contentUrl;
  if (still) media.push({ type: 'image', url: still, alt: alt ?? title });
  if (animated && animated !== still && kind !== 'video clip') media.push({ type: 'image', url: animated, alt: 'animated' });
  if (kind === 'video clip') {
    const file = isVideoFileUrl(object?.contentUrl) ? object.contentUrl : meta.videos.map((v) => v.url).find(isVideoFileUrl);
    if (file) media.push({ type: 'video', url: file, thumbnailUrl: still, contentType: 'video/mp4' });
  }
  if (media.length === 0) logger.info(`linkreader: ${target.source} page ${target.url} had no media tags`);

  const canonical = meta.canonicalUrl && !/\.(?:gif|mp4|webp)(?:[?#]|$)/i.test(meta.canonicalUrl) ? meta.canonicalUrl : result.url;
  return {
    url: canonical,
    source: target.source,
    kind,
    title,
    author: object?.creator,
    site: target.source === 'tenor' ? 'Tenor' : 'Klipy',
    publishedAt: object?.date,
    text: capText(description, 1000).text,
    textTruncated: false,
    media,
    notes: media.length === 0 ? ['no preview image found'] : undefined,
  };
}
