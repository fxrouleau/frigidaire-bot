// The link reader: one entry point (read) shared by the read_link tool and the link-preview enricher.
//
//   - identifies the link (targets.ts) and runs the matching extractor, every request through the
//     SSRF-guarded fetch
//   - caches results per canonical link (LRU, 1 h; failures for less), so the enricher's preview, the
//     tool call that follows it and the next turn's re-rendered history all cost one fetch — and
//     de-duplicates concurrent reads of the same link
//   - on request (read_link only), hands the first video to video understanding (watchVideo, the
//     media feature) and caches the description with the content — or, with a question, has the video
//     watched to answer it (answers are cached by the media feature, not with the content)
//   - vets every image/video URL it hands onward (previewImages, describe): only live, media-typed,
//     redirect-free URLs reach the chat provider and the media feature (which fetch any non-Discord URL
//     through this same guarded fetch again, so a page's og:image pointing at an internal address is
//     refused twice over)
import { config } from '../../config';
import { logger } from '../../logger';
import { type VideoInput, type VideoOutcome, watchVideo as defaultWatchVideo, videoOutcomeNote } from '../media';
import { TtlCache } from './cache';
import { readBluesky } from './extractors/bluesky';
import { ExtractError, type ExtractorContext, capText } from './extractors/common';
import { readGif } from './extractors/gif';
import { readReddit } from './extractors/reddit';
import { readInstagram, readTikTok } from './extractors/shortVideo';
import { readTweet } from './extractors/twitter';
import { readWebPage } from './extractors/web';
import { readYouTube } from './extractors/youtube';
import { checkUrlShape } from './netGuard';
import { BlockedUrlError, FetchFailedError, type SafeFetch, createSafeFetch } from './safeFetch';
import { type LinkTarget, identifyLink } from './targets';
import type { LinkContent, LinkReadResult, LinkVideo } from './types';

const CACHE_ENTRIES = 200;
const SUCCESS_TTL_MS = 60 * 60 * 1000;
// "Deleted", "private", "refused": re-checking in 15 minutes is plenty.
const PERMANENT_FAILURE_TTL_MS = 15 * 60 * 1000;
// Timeouts, 5xx, network blips: short enough that a retry a couple of minutes later really retries.
const TRANSIENT_FAILURE_TTL_MS = 2 * 60 * 1000;

const MEDIA_CHECK_ENTRIES = 500;
const MEDIA_CHECK_TTL_MS = 60 * 60 * 1000;
const MEDIA_CHECK_TIMEOUT_MS = 5000;
// A sanity bound on what gets handed to video understanding; short clips are a few MB.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_DESCRIPTION_CHARS = 3000;

type Entry = { result: LinkReadResult; videosDescribed: boolean };

type CheckedMedia = { url: string; contentType: string; sizeBytes?: number };

export type LinkReaderOptions = {
  fetch?: SafeFetch;
  now?: () => number;
  /** Video understanding (the media feature): a description, or with `input.question` an answer. */
  watchVideo?: (input: VideoInput) => Promise<VideoOutcome>;
};

export type ReadOptions = {
  /** Hand the link's first video to video understanding (paid; read_link only). */
  watchVideos?: boolean;
  /**
   * Watch the link's first video to answer this question instead (paid; read_link / watch_video). The
   * answer is returned on that video (`answer`), not cached with the content.
   */
  question?: string;
};

function failure(url: string, error: unknown): { result: LinkReadResult; permanent: boolean } {
  if (error instanceof ExtractError) return { result: { ok: false, url, error: error.message }, permanent: true };
  if (error instanceof BlockedUrlError) {
    return { result: { ok: false, url, error: `refused to open it (${error.message})` }, permanent: true };
  }
  if (error instanceof FetchFailedError) {
    const message =
      error.reason === 'timeout'
        ? 'the site took too long to answer'
        : error.reason === 'redirects'
          ? 'the link redirects too many times'
          : `couldn't reach the site (${error.message})`;
    return { result: { ok: false, url, error: message }, permanent: false };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { result: { ok: false, url, error: `couldn't load it (${detail})` }, permanent: false };
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const joined = notes.filter(Boolean).join('; ');
  return joined || undefined;
}

/** A hint for video understanding: what the video is and what its poster said about it. */
function videoContext(content: LinkContent): string {
  const who = content.handle ? `@${content.handle}` : content.author;
  const text = content.translation?.text ?? content.text ?? content.title;
  const parts = [`A ${content.kind}${who ? ` posted by ${who}` : ''}`, text ? `caption: ${text.slice(0, 500)}` : ''];
  return parts.filter(Boolean).join('; ');
}

const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;
const VIDEO_FILE = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i;

function mediaTypeAcceptable(prefix: 'image/' | 'video/', contentType: string, url: string): boolean {
  // SVG is XML the image pipeline would rasterize: refuse it rather than feed it arbitrary markup.
  if (contentType === 'image/svg+xml') return false;
  if (contentType.startsWith(prefix)) return true;
  // Object stores often label media generically; trust the file extension then.
  const generic =
    contentType === 'application/octet-stream' || contentType === 'binary/octet-stream' || contentType === '';
  return generic && (prefix === 'image/' ? IMAGE_FILE : VIDEO_FILE).test(url);
}

export class LinkReader {
  private readonly fetch: SafeFetch;
  private readonly now: () => number;
  private readonly watchVideo: (input: VideoInput) => Promise<VideoOutcome>;
  private readonly cache: TtlCache<Entry>;
  private readonly mediaChecks: TtlCache<CheckedMedia | null>;
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly describing = new Map<string, Promise<Entry>>();
  private readonly mediaInflight = new Map<string, Promise<CheckedMedia | null>>();
  private readonly cooldowns = new Map<string, number>();

  constructor(options: LinkReaderOptions = {}) {
    this.fetch = options.fetch ?? createSafeFetch();
    this.now = options.now ?? Date.now;
    this.watchVideo = options.watchVideo ?? defaultWatchVideo;
    this.cache = new TtlCache<Entry>(CACHE_ENTRIES, this.now);
    this.mediaChecks = new TtlCache<CheckedMedia | null>(MEDIA_CHECK_ENTRIES, this.now);
  }

  /** The extractor target for a URL, or the reason it will never be fetched. */
  private identify(url: string): { target: LinkTarget } | { refused: string } {
    try {
      return { target: identifyLink(checkUrlShape(url)) };
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The cache identity of a link: two spellings of the same post (x.com vs fixvx.com) share it. */
  keyFor(url: string): string | undefined {
    const identified = this.identify(url);
    return 'target' in identified ? identified.target.key : undefined;
  }

  /** Cache-only lookup: never touches the network (for history messages). */
  peek(url: string): LinkReadResult | undefined {
    const identified = this.identify(url);
    return 'target' in identified ? this.cache.get(identified.target.key)?.result : undefined;
  }

  async read(url: string, options: ReadOptions = {}): Promise<LinkReadResult> {
    const identified = this.identify(url);
    if ('refused' in identified) return { ok: false, url, error: `refused to open it (${identified.refused})` };
    const { target } = identified;

    let entry = this.cache.get(target.key) ?? (await this.dedup(this.inflight, target.key, () => this.extract(target)));
    const question = options.question?.trim();
    if (question && entry.result.ok) {
      return { ok: true, content: await this.askFirstVideo(entry.result.content, question) };
    }
    if (options.watchVideos && entry.result.ok && !entry.videosDescribed) {
      const current = entry;
      entry = await this.dedup(this.describing, target.key, () => this.watchFirstVideo(target.key, current));
    }
    return entry.result;
  }

  /**
   * Image URLs from this content that are safe to hand to the chat model (vetted and redirect-free),
   * at most `max`. With `cacheOnly`, only images vetted earlier are returned and nothing is fetched.
   */
  async previewImages(content: LinkContent, max: number, options: { cacheOnly?: boolean } = {}): Promise<string[]> {
    if (max <= 0) return [];
    const candidates: string[] = [];
    for (const item of content.media) {
      const url = item.type === 'image' ? item.url : item.thumbnailUrl;
      if (url && !candidates.includes(url)) candidates.push(url);
    }
    // A couple of spares, in case the first images turn out to be dead.
    const considered = candidates.slice(0, max + 2);
    const checked = options.cacheOnly
      ? considered.map((url) => this.mediaChecks.get(`image/${url}`) ?? null)
      : await Promise.all(considered.map((url) => this.checkMedia(url, 'image/')));
    return checked
      .filter((media): media is CheckedMedia => media !== null)
      .map((media) => media.url)
      .slice(0, max);
  }

  private dedup<T>(map: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
    const existing = map.get(key);
    if (existing) return existing;
    const promise = run().finally(() => map.delete(key));
    map.set(key, promise);
    return promise;
  }

  private context(): ExtractorContext {
    return {
      fetch: this.fetch,
      now: this.now,
      isCoolingDown: (key) => (this.cooldowns.get(key) ?? 0) > this.now(),
      coolDown: (key, ms) => {
        this.cooldowns.set(key, this.now() + ms);
      },
    };
  }

  private async extract(target: LinkTarget): Promise<Entry> {
    let entry: Entry;
    try {
      const content = await this.dispatch(target, this.context(), 0);
      entry = { result: { ok: true, content }, videosDescribed: !content.media.some((m) => m.type === 'video') };
      this.cache.set(target.key, entry, SUCCESS_TTL_MS);
    } catch (error) {
      const { result, permanent } = failure(target.url, error);
      if (permanent) logger.info(`linkreader: ${target.key}: ${result.ok ? '' : result.error}`);
      else logger.warn(`linkreader: reading ${target.key} failed:`, error);
      entry = { result, videosDescribed: true };
      this.cache.set(target.key, entry, permanent ? PERMANENT_FAILURE_TTL_MS : TRANSIENT_FAILURE_TTL_MS);
    }
    return entry;
  }

  private async dispatch(target: LinkTarget, ctx: ExtractorContext, depth: number): Promise<LinkContent> {
    switch (target.source) {
      case 'twitter':
        return readTweet(target.statusId, target.url, ctx);
      case 'youtube':
        return readYouTube(target, ctx);
      case 'tiktok':
        return readTikTok(target, ctx);
      case 'instagram':
        return readInstagram(target, ctx);
      case 'reddit':
        return readReddit(target, ctx);
      case 'bluesky':
        return readBluesky(target, ctx);
      case 'tenor':
      case 'klipy':
        return readGif(target, ctx);
      case 'web': {
        // Only one hop of re-dispatch: a platform page that redirects back out is read as a page.
        const isPlatform = (url: string) => {
          if (depth > 0) return false;
          const identified = this.identify(url);
          return 'target' in identified && identified.target.source !== 'web';
        };
        const outcome = await readWebPage(target.url, ctx, isPlatform);
        if ('content' in outcome) return outcome.content;
        const identified = this.identify(outcome.redirectedTo);
        if ('refused' in identified) throw new BlockedUrlError(identified.refused);
        return this.dispatch(identified.target, ctx, depth + 1);
      }
    }
  }

  /** HEAD-like probe (headers only) of a media URL through the guarded fetch; cached. */
  private checkMedia(url: string, prefix: 'image/' | 'video/'): Promise<CheckedMedia | null> {
    const key = `${prefix}${url}`;
    const cached = this.mediaChecks.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.dedup(this.mediaInflight, key, async () => {
      let checked: CheckedMedia | null = null;
      try {
        // An empty accept list means the body is never downloaded; the header still says what we want.
        const result = await this.fetch(url, {
          accept: [],
          headers: { accept: `${prefix}*` },
          timeoutMs: MEDIA_CHECK_TIMEOUT_MS,
        });
        if (result.ok && mediaTypeAcceptable(prefix, result.contentType, result.url)) {
          const size = Number(result.headers['content-length']);
          checked = {
            url: result.url,
            contentType: result.contentType || (prefix === 'image/' ? 'image/jpeg' : 'video/mp4'),
            sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
          };
        } else {
          logger.info(
            `linkreader: ${prefix.slice(0, -1)} ${url} unusable (HTTP ${result.status}, ${result.contentType || 'no type'})`,
          );
        }
      } catch (error) {
        logger.info(
          `linkreader: ${prefix.slice(0, -1)} ${url} unreachable:`,
          error instanceof Error ? error.message : error,
        );
      }
      this.mediaChecks.set(key, checked, MEDIA_CHECK_TTL_MS);
      return checked;
    });
  }

  /** Describes the first video (only the first: each description is a paid model call). */
  private async watchFirstVideo(key: string, entry: Entry): Promise<Entry> {
    if (!entry.result.ok) return entry;
    const content = entry.result.content;
    const index = content.media.findIndex((m) => m.type === 'video' && !m.description);
    let media = content.media;
    if (index !== -1) {
      const video = content.media[index] as LinkVideo;
      const update = await this.describe(video, content);
      media = content.media.map((item, i) => (i === index ? { ...video, ...update } : item));
    }
    const updated: Entry = { result: { ok: true, content: { ...content, media } }, videosDescribed: true };
    this.cache.set(key, updated, SUCCESS_TTL_MS);
    return updated;
  }

  /** The first video's answer to `question` (the content itself is returned otherwise unchanged). */
  private async askFirstVideo(content: LinkContent, question: string): Promise<LinkContent> {
    const index = content.media.findIndex((m) => m.type === 'video');
    if (index === -1) {
      return { ...content, notes: [...(content.notes ?? []), 'no video in this link to watch'] };
    }
    const video = content.media[index] as LinkVideo;
    const update = await this.describe(video, content, question);
    return { ...content, media: content.media.map((item, i) => (i === index ? { ...video, ...update } : item)) };
  }

  /** A description of the video, or with `question` the answer to it; a note says why there is none. */
  private async describe(video: LinkVideo, content: LinkContent, question?: string): Promise<Partial<LinkVideo>> {
    if (!config.linkReader.watchVideos) return { note: joinNotes(video.note, 'video understanding is turned off') };
    // YouTube and players without a file: there is nothing to watch (the note already says why).
    if (!video.url) return question ? { note: joinNotes(video.note, "can't watch this one") } : {};
    // No length limit here: like an attachment, a long video is skimmed (keyframes + its soundtrack) by
    // the media feature, which also enforces the download cap and the daily video budget.
    const file = await this.checkMedia(video.url, 'video/');
    if (!file) return { note: joinNotes(video.note, "the video file couldn't be opened") };
    const size = file.sizeBytes ?? video.sizeBytes;
    if (size !== undefined && size > MAX_VIDEO_BYTES) {
      return { note: joinNotes(video.note, `too large to watch (${Math.round(size / 1024 / 1024)} MB)`) };
    }

    let outcome: VideoOutcome;
    try {
      outcome = await this.watchVideo({
        url: file.url,
        contentType: file.contentType,
        context: videoContext(content),
        // The post's own duration spares a probe and sends a long video straight to the skim.
        ...(video.durationSecs !== undefined ? { durationSecs: video.durationSecs } : {}),
        ...(question ? { question } : {}),
      });
    } catch (error) {
      logger.warn(`linkreader: watching the video of ${content.url} failed:`, error);
      outcome = { status: 'failed' };
    }
    if (outcome.status === 'ok' && outcome.text.trim()) {
      const text = capText(outcome.text, MAX_VIDEO_DESCRIPTION_CHARS).text ?? outcome.text.trim();
      return question ? { answer: { question, text } } : { description: text };
    }
    if (outcome.status === 'over_budget' || outcome.status === 'too_large') {
      return { note: joinNotes(video.note, videoOutcomeNote(outcome)) };
    }
    return { note: joinNotes(video.note, 'video understanding is unavailable right now') };
  }
}

// ---- Shared instance ----

let instance: LinkReader | undefined;

/** Under Vitest the default instance can't reach the network (tests inject their own reader). */
const offlineFetch: SafeFetch = async () => {
  throw new FetchFailedError('network access is disabled in tests', 'network');
};

export function getLinkReader(): LinkReader {
  instance ??= new LinkReader(config.isTest ? { fetch: offlineFetch } : {});
  return instance;
}

export function setLinkReaderForTesting(reader: LinkReader | undefined): void {
  instance = reader;
}
