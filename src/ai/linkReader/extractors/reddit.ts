// Reddit: the public JSON view of a post (https://www.reddit.com/comments/<id>/.json) gives the title,
// subreddit, author, selftext, score and the top comments in one request.
//
// Reddit blocks unauthenticated JSON from many server IPs (verified 2026-09: HTTP 403 "blocked by
// network security" from a datacenter). After one 403/429 the JSON route is skipped for a while and
// the post page is read instead as Discord's crawler: <title> carries the real post title
// ("Title : r/sub"), the description meta the start of the selftext, and og:image a rendered card of
// the post (share.redd.it/preview/post/<id>).
import { logger } from '../../../logger';
import { extractMetadata } from '../html';
import { DISCORD_CRAWLER_UA } from '../safeFetch';
import type { LinkComment, LinkContent, LinkMedia } from '../types';
import {
  ExtractError,
  type ExtractorContext,
  type Json,
  asArray,
  asRecord,
  capText,
  fetchHtml,
  fetchJson,
  num,
  resolveRedirect,
  str,
} from './common';

const JSON_HEALTH_KEY = 'reddit-json';
const JSON_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_COMMENTS = 5;

function postIdFrom(url: string): string | undefined {
  return url.match(/\/comments\/([a-z0-9]{3,12})/i)?.[1]?.toLowerCase();
}

function redditMedia(post: Json): LinkMedia[] {
  const media: LinkMedia[] = [];
  const previewImage = asRecord(asArray(asRecord(post.preview)?.images)[0]);
  const preview = str(asRecord(previewImage?.source)?.url);

  const video = asRecord(asRecord(post.secure_media ?? post.media)?.reddit_video);
  if (video && str(video.fallback_url)) {
    media.push({
      type: 'video',
      url: str(video.fallback_url),
      thumbnailUrl: preview,
      durationSecs: num(video.duration),
      contentType: 'video/mp4',
      // Reddit serves DASH: the fallback file is the video track alone.
      note: 'no audio track',
    });
    return media;
  }

  if (post.is_gallery === true) {
    const metadata = asRecord(post.media_metadata) ?? {};
    const order = asArray(asRecord(post.gallery_data)?.items).map((item) => str(asRecord(item)?.media_id));
    for (const id of order) {
      const url = id ? str(asRecord(asRecord(metadata[id])?.s)?.u) : undefined;
      if (url) media.push({ type: 'image', url });
      if (media.length >= 4) break;
    }
    return media;
  }

  if (post.post_hint === 'image' && str(post.url)) media.push({ type: 'image', url: str(post.url) as string });
  else if (preview) media.push({ type: 'image', url: preview });
  return media;
}

/** Maps Reddit's [postListing, commentListing] JSON to LinkContent. Exported for tests. */
export function parseRedditJson(json: unknown, fallbackUrl: string): LinkContent | undefined {
  const listings = asArray(json);
  const post = asRecord(asRecord(asArray(asRecord(asRecord(listings[0])?.data)?.children)[0])?.data);
  if (!post || !str(post.title)) return undefined;

  const comments: LinkComment[] = [];
  for (const child of asArray(asRecord(asRecord(listings[1])?.data)?.children)) {
    const record = asRecord(child);
    const data = asRecord(record?.data);
    if (record?.kind !== 't1' || !data || data.stickied === true) continue;
    const body = str(data.body);
    const author = str(data.author);
    if (!body || !author || body === '[deleted]' || body === '[removed]') continue;
    comments.push({ author: `u/${author}`, text: capText(body, 400).text ?? body, score: num(data.score) });
    if (comments.length >= MAX_COMMENTS) break;
  }

  const selftext = str(post.selftext);
  const linked = post.is_self === true ? undefined : (str(post.url_overridden_by_dest) ?? str(post.url));
  const body = [selftext, linked && !/reddit\.com|redd\.it/.test(linked) ? `(links to ${linked})` : undefined]
    .filter(Boolean)
    .join('\n\n');
  const { text, truncated } = capText(body);

  const notes: string[] = [];
  if (post.over_18 === true) notes.push('NSFW');
  if (post.spoiler === true) notes.push('spoiler');
  const flair = str(post.link_flair_text);
  if (flair) notes.push(`flair: ${flair}`);

  const permalink = str(post.permalink);
  const created = num(post.created_utc);
  return {
    url: permalink ? `https://www.reddit.com${permalink}` : fallbackUrl,
    source: 'reddit',
    kind: 'reddit post',
    title: str(post.title),
    author: str(post.author) ? `u/${str(post.author)}` : undefined,
    site: str(post.subreddit_name_prefixed),
    publishedAt: created !== undefined ? created * 1000 : undefined,
    text,
    textTruncated: truncated,
    comments: comments.length > 0 ? comments : undefined,
    stats: { score: num(post.score), comments: num(post.num_comments) },
    media: redditMedia(post),
    notes: notes.length > 0 ? notes : undefined,
  };
}

async function readFromJson(postId: string, url: string, ctx: ExtractorContext): Promise<LinkContent | undefined> {
  if (ctx.isCoolingDown(JSON_HEALTH_KEY)) return undefined;
  try {
    const { result, json } = await fetchJson(
      ctx,
      `https://www.reddit.com/comments/${postId}/.json?limit=${MAX_COMMENTS * 2}&depth=1&sort=top&raw_json=1`,
    );
    if (result.status === 404) throw new ExtractError('that Reddit post does not exist (deleted, or a bad link)');
    const parsed = result.ok ? parseRedditJson(json, url) : undefined;
    if (parsed) return parsed;
    if (result.status === 403 || result.status === 429 || (result.ok && json === undefined)) {
      ctx.coolDown(JSON_HEALTH_KEY, JSON_COOLDOWN_MS);
      logger.info(`linkreader: reddit JSON blocked (HTTP ${result.status}); using post pages for 30 min`);
    }
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    logger.info(`linkreader: reddit JSON failed for ${postId}:`, error instanceof Error ? error.message : error);
  }
  return undefined;
}

async function readFromPage(url: string, ctx: ExtractorContext): Promise<LinkContent> {
  const { result, html } = await fetchHtml(ctx, url, { userAgent: DISCORD_CRAWLER_UA, maxBytes: 1024 * 1024 });
  if (result.status === 404) throw new ExtractError('that Reddit post does not exist (deleted, or a bad link)');
  if (!result.ok || !html) throw new Error(`Reddit answered HTTP ${result.status}`);
  const meta = extractMetadata(html, result.url);
  // "<post title> : r/<sub>" — og:title is only the generic "From the X community on Reddit".
  const titleMatch = meta.documentTitle?.match(/^(.*)\s:\s(r\/[\w-]+)$/);
  const title = titleMatch?.[1] ?? meta.documentTitle;
  if (!title || /^reddit\s*-/i.test(title)) throw new Error('Reddit served a page without the post');
  // The plain description meta holds the start of the selftext; og:description is a generic blurb.
  const { text, truncated } = capText(meta.meta.description);
  return {
    url: meta.canonicalUrl ?? url,
    source: 'reddit',
    kind: 'reddit post',
    title,
    site: titleMatch?.[2],
    text,
    textTruncated: truncated,
    media: meta.images.slice(0, 1).map((image): LinkMedia => ({ type: 'image', url: image })),
    notes: ['only the post preview was readable (Reddit blocked the full read): no comments or stats'],
  };
}

export async function readReddit(
  target: { postId?: string; url: string },
  ctx: ExtractorContext,
): Promise<LinkContent> {
  let postId = target.postId;
  let url = target.url;
  if (!postId) {
    const location = await resolveRedirect(ctx, target.url, DISCORD_CRAWLER_UA).catch(() => undefined);
    postId = location ? postIdFrom(location) : undefined;
    if (!location || !postId) throw new ExtractError("couldn't resolve that Reddit share link");
    url = location.split('?')[0];
  }
  return (await readFromJson(postId, url, ctx)) ?? readFromPage(url, ctx);
}
