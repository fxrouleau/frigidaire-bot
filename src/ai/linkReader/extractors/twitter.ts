// Tweets through FxTwitter's public JSON API (https://docs.fxembed.com/api/twitter/operations/2statusid/).
//
// GET https://api.fxtwitter.com/2/status/<id>?lang=en answers { code, status } where status carries
// the text, author, counts, media (photos / videos with mp4 variants / external embeds), a quoted
// status, a poll, a community note — and, with ?lang=en, a `translation` object for non-English posts
// (English posts simply have none). 404 = deleted/nonexistent, 401 = protected account.
//
// When the API itself is down, the configured fixer domains' embed pages (the same ones the link fixer
// uses) still carry the text and media as OpenGraph tags, so they are the fallback.
import { config } from '../../../config';
import { logger } from '../../../logger';
import { extractMetadata } from '../html';
import { DISCORD_CRAWLER_UA } from '../safeFetch';
import type { LinkContent, LinkMedia, LinkQuote, LinkVideo } from '../types';
import {
  asArray,
  asRecord,
  capText,
  ExtractError,
  type ExtractorContext,
  fetchHtml,
  fetchJson,
  type Json,
  num,
  str,
} from './common';

const API_BASE = 'https://api.fxtwitter.com/2/status';
// A small mp4 is plenty for video understanding and keeps the download short.
const PREFERRED_VIDEO_BITRATE = 1_000_000;

/** pbs.twimg.com serves several sizes; `medium` (≤1200px) is plenty for a model and ~4× lighter than `orig`. */
export function mediumTwitterImage(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'pbs.twimg.com' || !parsed.pathname.startsWith('/media/')) return url;
    parsed.searchParams.set('name', 'medium');
    return parsed.toString();
  } catch {
    return url;
  }
}

function pickVideoFile(video: Json): string | undefined {
  const mp4s = asArray(video.formats)
    .map(asRecord)
    .filter((f): f is Json => Boolean(f && str(f.url) && f.container === 'mp4'))
    .sort((a, b) => (num(a.bitrate) ?? 0) - (num(b.bitrate) ?? 0));
  const modest = mp4s.filter((f) => (num(f.bitrate) ?? 0) <= PREFERRED_VIDEO_BITRATE).at(-1) ?? mp4s[0];
  return str(modest?.url) ?? str(video.url);
}

function parseMedia(mediaField: unknown): LinkMedia[] {
  const media = asRecord(mediaField);
  if (!media) return [];
  const items: LinkMedia[] = [];
  for (const photo of asArray(media.photos).map(asRecord)) {
    const url = str(photo?.url);
    if (url) items.push({ type: 'image', url: mediumTwitterImage(url), alt: str(photo?.altText) });
  }
  for (const video of asArray(media.videos).map(asRecord)) {
    if (!video) continue;
    const item: LinkVideo = {
      type: 'video',
      url: pickVideoFile(video),
      thumbnailUrl: str(video.thumbnail_url),
      durationSecs: num(video.duration),
      contentType: 'video/mp4',
    };
    if (video.type === 'gif') item.note = 'GIF';
    items.push(item);
  }
  const external = asRecord(media.external);
  if (external && str(external.url)) {
    items.push({ type: 'video', pageUrl: str(external.url), thumbnailUrl: str(external.thumbnail_url) });
  }
  return items;
}

function describeMediaBriefly(media: LinkMedia[]): string | undefined {
  const photos = media.filter((m) => m.type === 'image').length;
  const videos = media.filter((m) => m.type === 'video').length;
  const parts = [
    photos ? `${photos} photo${photos > 1 ? 's' : ''}` : '',
    videos ? `${videos} video${videos > 1 ? 's' : ''}` : '',
  ];
  const joined = parts.filter(Boolean).join(', ');
  return joined || undefined;
}

function parsePoll(pollField: unknown): string | undefined {
  const poll = asRecord(pollField);
  if (!poll) return undefined;
  const choices = asArray(poll.choices)
    .map(asRecord)
    .filter((c): c is Json => Boolean(c && str(c.label)))
    .map((c) => `${str(c.label)} — ${num(c.percentage) ?? 0}%`);
  if (choices.length === 0) return undefined;
  const total = num(poll.total_votes);
  return `Poll: ${choices.join(' · ')}${total !== undefined ? ` (${total} votes)` : ''}`;
}

function replyingToHandle(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return str(asRecord(value)?.screen_name);
}

function parseQuote(quoteField: unknown): LinkQuote | undefined {
  const quote = asRecord(quoteField);
  if (!quote) return undefined;
  const author = asRecord(quote.author);
  const media = describeMediaBriefly(parseMedia(quote.media));
  const text = str(quote.text);
  if (!text && !author && !media) return { text: '[quoted post unavailable]' };
  return {
    author: str(author?.name),
    handle: str(author?.screen_name),
    text: text ? capText(text, 1500).text : undefined,
    url: str(quote.url),
    media,
  };
}

/** Maps an FxTwitter v2 status object to LinkContent. Exported for tests. */
export function parseFxStatus(status: Json, fallbackUrl: string): LinkContent {
  const author = asRecord(status.author);
  const media = parseMedia(status.media);
  const article = asRecord(status.article);
  const poll = parsePoll(status.poll);

  const body = [str(status.text), poll].filter(Boolean).join('\n\n');
  const { text, truncated } = capText(body || str(article?.preview_text));

  const translation = asRecord(status.translation);
  const translatedText = str(translation?.text);
  const sourceLang = str(translation?.source_lang) ?? str(status.lang);

  const notes: string[] = [];
  const note = str(asRecord(status.community_note)?.text);
  if (note) notes.push(`community note: ${capText(note, 600).text}`);
  if (status.possibly_sensitive === true) notes.push('marked as possibly sensitive');

  const createdSecs = num(status.created_timestamp);
  return {
    url: str(status.url) ?? fallbackUrl,
    source: 'twitter',
    kind: 'tweet',
    title: str(article?.title),
    author: str(author?.name),
    handle: str(author?.screen_name),
    publishedAt: createdSecs !== undefined ? createdSecs * 1000 : undefined,
    text,
    textTruncated: truncated,
    language: str(status.lang),
    translation:
      translatedText && sourceLang && sourceLang !== 'en'
        ? { from: sourceLang, text: capText(translatedText).text ?? translatedText }
        : undefined,
    quote: parseQuote(status.quote),
    replyingTo: replyingToHandle(status.replying_to),
    stats: {
      likes: num(status.likes),
      reposts: num(status.reposts) ?? num(status.retweets),
      replies: num(status.replies),
      quotes: num(status.quotes),
      views: num(status.views) ?? undefined,
    },
    media,
    notes: notes.length > 0 ? notes : undefined,
  };
}

async function readFromApi(statusId: string, url: string, ctx: ExtractorContext): Promise<LinkContent> {
  const { result, json } = await fetchJson(ctx, `${API_BASE}/${statusId}?lang=en`);
  const body = asRecord(json);
  const code = num(body?.code) ?? result.status;
  const status = asRecord(body?.status);
  if (code === 200 && status) return parseFxStatus(status, url);
  if (code === 404) throw new ExtractError('that post does not exist (deleted, or a bad link)');
  if (code === 401) throw new ExtractError('that post is from a private account or otherwise unavailable');
  throw new Error(`FxTwitter answered HTTP ${result.status}${str(body?.message) ? ` (${str(body?.message)})` : ''}`);
}

/** Fallback: a fixer's embed page (OpenGraph tags) when the API is unreachable. */
async function readFromFixerPage(
  statusId: string,
  url: string,
  ctx: ExtractorContext,
): Promise<LinkContent | undefined> {
  for (const domain of config.links.twitterFixers.slice(0, 2)) {
    try {
      const { result, html } = await fetchHtml(ctx, `https://${domain}/i/status/${statusId}`, {
        userAgent: DISCORD_CRAWLER_UA,
        maxBytes: 256 * 1024,
      });
      if (!result.ok || !html) continue;
      const meta = extractMetadata(html, result.url);
      if (!meta.description && meta.images.length === 0 && meta.videos.length === 0) continue;
      const titleMatch = meta.title?.match(/^(.*?)\s*\(@(\w+)\)/);
      const { text, truncated } = capText(meta.description);
      return {
        url,
        source: 'twitter',
        kind: 'tweet',
        author: titleMatch?.[1] ?? meta.title,
        handle: titleMatch?.[2],
        text,
        textTruncated: truncated,
        media: [
          ...meta.images.slice(0, 4).map((image): LinkMedia => ({ type: 'image', url: mediumTwitterImage(image) })),
          ...meta.videos
            .filter((v) => !v.type || v.type.startsWith('video/'))
            .slice(0, 1)
            .map((v): LinkMedia => ({ type: 'video', url: v.url, contentType: v.type })),
        ],
        notes: ['read from an embed page (FxTwitter API unavailable): stats and translation missing'],
      };
    } catch (error) {
      logger.info(`linkreader: twitter fallback ${domain} failed for ${statusId}:`, error);
    }
  }
  return undefined;
}

export async function readTweet(statusId: string, url: string, ctx: ExtractorContext): Promise<LinkContent> {
  try {
    return await readFromApi(statusId, url, ctx);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    logger.warn(`linkreader: FxTwitter API failed for ${statusId}; trying embed pages:`, error);
    const fallback = await readFromFixerPage(statusId, url, ctx);
    if (fallback) return fallback;
    throw error;
  }
}
