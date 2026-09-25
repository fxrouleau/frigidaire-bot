// Bluesky through the public AppView (no key, no login): one getPostThread call with the post's AT URI.
//
// Verified (2026-09, https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread):
//   - the URI may carry the handle as its authority (at://bsky.app/app.bsky.feed.post/<rkey>); the AppView
//     resolves it, so no separate resolveHandle round trip is needed
//   - `thread.$type` is app.bsky.feed.defs#threadViewPost on success; a missing post answers HTTP 400
//     { error: "NotFound" }, blocked/deleted ones #notFoundPost / #blockedPost
//   - embeds come as views: images#view (fullsize/alt), gallery#view (items[].fullsize — the 5+ photo
//     carousel), video#view (HLS playlist + thumbnail only), external#view (link card), record#view
//     (quote post: record.value.text + author), recordWithMedia#view (media + record)
//   - video files are only served as HLS; the original upload is a blob on the author's PDS, reachable
//     through the bsky.social entryway (com.atproto.sync.getBlob 302s to the PDS host for bsky-hosted
//     accounts) — a direct mp4 that video understanding can use
import type { LinkContent, LinkMedia, LinkQuote } from '../types';
import {
  type ExtractorContext,
  ExtractError,
  type Json,
  asArray,
  asRecord,
  capText,
  fetchJson,
  num,
  parseDate,
  str,
} from './common';

const APPVIEW = 'https://public.api.bsky.app/xrpc';
const BLOB_ENTRYWAY = 'https://bsky.social/xrpc/com.atproto.sync.getBlob';
const MAX_IMAGES = 4;

// Authors can ask to be hidden from logged-out viewers; the official web app honors it, and so do we.
const LOGGED_OUT_OPT_OUT = '!no-unauthenticated';

function optedOutOfLoggedOutViewers(author: Json | undefined): boolean {
  return asArray(author?.labels).some((label) => asRecord(label)?.val === LOGGED_OUT_OPT_OUT);
}

function imagesFrom(view: Json): LinkMedia[] {
  const items = view.$type === 'app.bsky.embed.gallery#view' ? asArray(view.items) : asArray(view.images);
  return items
    .map(asRecord)
    .filter((image): image is Json => Boolean(image && str(image.fullsize)))
    .slice(0, MAX_IMAGES)
    .map((image): LinkMedia => ({ type: 'image', url: str(image.fullsize) as string, alt: str(image.alt) }));
}

function blobUrl(did: string | undefined, cid: string | undefined): string | undefined {
  if (!did || !cid) return undefined;
  return `${BLOB_ENTRYWAY}?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}

/** Media from an embed view (images, gallery, video, or the media half of recordWithMedia). */
function mediaFrom(viewField: unknown, authorDid: string | undefined): LinkMedia[] {
  const view = asRecord(viewField);
  if (!view) return [];
  const type = str(view.$type);
  if (type === 'app.bsky.embed.images#view' || type === 'app.bsky.embed.gallery#view') return imagesFrom(view);
  if (type === 'app.bsky.embed.video#view') {
    return [
      {
        type: 'video',
        url: blobUrl(authorDid, str(view.cid)),
        pageUrl: str(view.playlist),
        thumbnailUrl: str(view.thumbnail),
        contentType: 'video/mp4',
        note: view.presentation === 'gif' ? 'GIF' : undefined,
      },
    ];
  }
  if (type === 'app.bsky.embed.recordWithMedia#view') return mediaFrom(view.media, authorDid);
  return [];
}

function linkCardFrom(viewField: unknown): string | undefined {
  const view = asRecord(viewField);
  const external = asRecord(view?.external) ?? asRecord(asRecord(view?.media)?.external);
  const uri = str(external?.uri);
  if (!uri) return undefined;
  const title = str(external?.title);
  const description = str(external?.description);
  return `Link card: ${[title, description].filter(Boolean).join(' — ') || uri} (${uri})`;
}

function quoteFrom(viewField: unknown): LinkQuote | undefined {
  const view = asRecord(viewField);
  const type = str(view?.$type);
  // record#view wraps the quoted record once; recordWithMedia#view wraps it twice.
  const wrapper =
    type === 'app.bsky.embed.record#view'
      ? view
      : type === 'app.bsky.embed.recordWithMedia#view'
        ? asRecord(view?.record)
        : undefined;
  const record = asRecord(wrapper?.record);
  if (!record) return undefined;
  const recordType = str(record.$type);
  if (recordType === 'app.bsky.embed.record#viewNotFound') return { text: '[quoted post deleted]' };
  if (recordType === 'app.bsky.embed.record#viewBlocked') return { text: '[quoted post unavailable]' };
  if (recordType === 'app.bsky.embed.record#viewDetached') return { text: '[quoted post detached by its author]' };
  if (recordType !== 'app.bsky.embed.record#viewRecord') return undefined; // feeds, lists, starter packs

  const author = asRecord(record.author);
  if (optedOutOfLoggedOutViewers(author)) return { text: '[quoted post only visible to logged-in users]' };
  const media = asArray(record.embeds).flatMap((embed) => mediaFrom(embed, str(author?.did)));
  const photos = media.filter((m) => m.type === 'image').length;
  const videos = media.filter((m) => m.type === 'video').length;
  const mediaSummary = [photos ? `${photos} photo${photos > 1 ? 's' : ''}` : '', videos ? 'video' : '']
    .filter(Boolean)
    .join(', ');
  const handle = str(author?.handle);
  const rkey = str(record.uri)?.split('/').pop();
  return {
    author: str(author?.displayName),
    handle,
    text: capText(str(asRecord(record.value)?.text), 1500).text,
    url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : undefined,
    media: mediaSummary || undefined,
  };
}

/** Maps a threadViewPost to LinkContent. Exported for tests. */
export function parseBlueskyThread(thread: Json, fallbackUrl: string): LinkContent {
  const post = asRecord(thread.post) ?? {};
  const author = asRecord(post.author);
  if (optedOutOfLoggedOutViewers(author)) {
    throw new ExtractError('that Bluesky account only shows its posts to logged-in users');
  }
  const record = asRecord(post.record) ?? {};
  const handle = str(author?.handle);
  const rkey = str(post.uri)?.split('/').pop();

  const card = linkCardFrom(post.embed);
  const { text, truncated } = capText([str(record.text), card].filter(Boolean).join('\n\n'));

  const parent = asRecord(thread.parent);
  const parentAuthor = asRecord(asRecord(parent?.post)?.author);
  const notes: string[] = [];
  if (asArray(post.labels).some((label) => ['porn', 'sexual', 'nudity', 'graphic-media'].includes(String(asRecord(label)?.val)))) {
    notes.push('labeled as adult/graphic content');
  }

  return {
    url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : fallbackUrl,
    source: 'bluesky',
    kind: 'bluesky post',
    author: str(author?.displayName),
    handle,
    publishedAt: parseDate(str(record.createdAt)),
    text,
    textTruncated: truncated,
    language: str(asArray(record.langs)[0]),
    quote: quoteFrom(post.embed),
    replyingTo: str(parentAuthor?.handle),
    stats: {
      likes: num(post.likeCount),
      reposts: num(post.repostCount),
      replies: num(post.replyCount),
      quotes: num(post.quoteCount),
    },
    media: mediaFrom(post.embed, str(author?.did)),
    notes: notes.length > 0 ? notes : undefined,
  };
}

export async function readBluesky(
  target: { actor: string; rkey: string; url: string },
  ctx: ExtractorContext,
): Promise<LinkContent> {
  const uri = `at://${target.actor}/app.bsky.feed.post/${target.rkey}`;
  const { result, json } = await fetchJson(
    ctx,
    `${APPVIEW}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=1`,
  );
  const body = asRecord(json);
  const thread = asRecord(body?.thread);
  const threadType = str(thread?.$type);
  if (thread && threadType === 'app.bsky.feed.defs#threadViewPost') return parseBlueskyThread(thread, target.url);

  if (threadType === 'app.bsky.feed.defs#blockedPost') throw new ExtractError('that Bluesky post is unavailable');
  const error = str(body?.error);
  const message = str(body?.message) ?? '';
  if (threadType === 'app.bsky.feed.defs#notFoundPost' || error === 'NotFound' || /not found/i.test(message)) {
    throw new ExtractError('that Bluesky post does not exist (deleted, or a bad link)');
  }
  if (error === 'InvalidRequest' && /resolve|handle|profile/i.test(message)) {
    throw new ExtractError("that Bluesky account doesn't exist");
  }
  throw new Error(`Bluesky answered HTTP ${result.status}${error ? ` (${error})` : ''}`);
}
