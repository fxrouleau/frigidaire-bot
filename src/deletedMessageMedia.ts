// What a deleted message showed, for the edgy judge (src/deletedMessages.ts). The judge can't open a
// link or watch a video, and a GIF from Discord's picker is nothing but a klipy.com (formerly tenor.com)
// link in the text: judged on that alone, every GIF regret read as "just a link". So before judging:
//   - saved pictures: downscaled JPEGs; an animated GIF/WebP gives a few frames from across it
//   - saved videos: a few keyframes (ffmpeg) and what's said in them (the soundtrack, transcribed)
//   - GIF pages in the text (Klipy, Tenor): their title, description and tags through the link reader,
//     plus the GIF's still
//   - links to image files (a favorited GIF on Discord's CDN, a media.tenor.com/….gif): the image
// Everything but the transcription (Whisper, a fraction of a cent) is free, and it all runs only for a
// watched member's message deleted inside the window, in edgy mode. Nothing here throws: whatever can't
// be read is left out, and the judge decides on the rest.
import sharp from 'sharp';
import { getLinkReader } from './ai/linkReader/reader';
import { findLinks, identifyLink } from './ai/linkReader/targets';
import type { LinkReadResult } from './ai/linkReader/types';
import { getAudioTranscriber, getMediaTranscoder } from './ai/media';
import { downloadMedia, redact } from './ai/media/download';
import type { MediaTranscoder } from './ai/media/transcoder';
import { formatClock } from './ai/media/voice';
import { logger } from './logger';

export type SnapshotAttachment = { name: string; contentType: string | null; data: Buffer };

/** What the judge gets on top of the text: images (data URIs) and the same in words. */
export type JudgeMedia = { imageUrls: string[]; notes: string[] };

export type JudgeMediaDeps = {
  /** Reads a GIF page: title, description, still. Default: the shared link reader. */
  readLink: (url: string) => Promise<LinkReadResult>;
  /** A linked image's bytes. Default: Discord's CDN directly, anything else through the guarded fetch. */
  downloadImage: (url: string) => Promise<Buffer | undefined>;
  /** Keyframes and the soundtrack of a saved video. Default: the shared ffmpeg wrapper. */
  sampleVideo: MediaTranscoder['sampleVideo'];
  /** What's said in an MP3 soundtrack: '' for no speech, undefined when it couldn't be transcribed. */
  transcribe: (audio: Buffer, label: string, durationSecs: number | undefined) => Promise<string | undefined>;
};

// The judge needs the gist, not every frame: a video's keyframes plus a GIF or two fit.
const MAX_IMAGES = 6;
const MAX_PICTURES = 4;
const MAX_VIDEOS = 2;
const MAX_LINKS = 3;
const ANIMATION_FRAMES = 3;
const VIDEO_FRAMES = 4;
const IMAGE_DIMENSION = 768;
// A clip small enough to be saved (10 MB) rarely runs longer; past this only its start is heard.
const MAX_AUDIO_SECONDS = 120;
const LINKED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const NOTE_CHARS = 300;
const SAID_CHARS = 600;
// Raster types only: SVG is markup the image pipeline would rasterize.
const IMAGE_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'image/avif'];
const IMAGE_FILE = /\.(?:gif|png|jpe?g|webp|avif)$/i;
const VIDEO_FILE = /\.(?:mp4|mov|m4v|webm|mkv)$/i;

type Seen = { images: string[]; note?: string };
const NOTHING: Seen = { images: [] };

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function jpegUri(data: Buffer): string {
  return `data:image/jpeg;base64,${data.toString('base64')}`;
}

/** Evenly spaced frame indices from the first one on: 3 of 12 → 0, 4, 8. */
function framePicks(pages: number, count: number): number[] {
  const n = Math.min(count, pages);
  return [...new Set(Array.from({ length: n }, (_, i) => Math.floor((i * pages) / n)))];
}

/**
 * A picture as downscaled JPEG data URIs: one for a still, a few from across an animation. Flattened so
 * transparency doesn't turn black. Undecodable data gives none.
 */
async function pictureFrames(data: Buffer, label: string): Promise<{ frames: string[]; animated: boolean }> {
  try {
    const pages = (await sharp(data).metadata()).pages ?? 1;
    const frames: string[] = [];
    for (const page of framePicks(pages, ANIMATION_FRAMES)) {
      const jpeg = await sharp(data, { page })
        .resize({ width: IMAGE_DIMENSION, height: IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80 })
        .toBuffer();
      frames.push(jpegUri(jpeg));
    }
    return { frames, animated: pages > 1 };
  } catch (error) {
    logger.debug(`deletedMessages: could not decode ${label} for the judge:`, error);
    return { frames: [], animated: false };
  }
}

async function savedPicture(attachment: SnapshotAttachment): Promise<Seen> {
  const { frames, animated } = await pictureFrames(attachment.data, attachment.name);
  return { images: frames, note: animated ? `animated image ${attachment.name}` : undefined };
}

async function savedVideo(attachment: SnapshotAttachment, deps: JudgeMediaDeps): Promise<Seen> {
  let sample: Awaited<ReturnType<MediaTranscoder['sampleVideo']>>;
  try {
    sample = await deps.sampleVideo(attachment.data, {
      frames: VIDEO_FRAMES,
      maxDimension: IMAGE_DIMENSION,
      maxAudioSeconds: MAX_AUDIO_SECONDS,
    });
  } catch (error) {
    logger.warn(`deletedMessages: could not open the video ${attachment.name} for the judge:`, error);
    return NOTHING;
  }
  let said: string | undefined;
  if (sample.audio) {
    // The track was cut at MAX_AUDIO_SECONDS, so its length is known.
    const trackSecs = sample.durationSecs !== undefined ? Math.min(sample.durationSecs, MAX_AUDIO_SECONDS) : undefined;
    said = await deps.transcribe(sample.audio, `deleted video ${attachment.name}`, trackSecs).catch((error) => {
      // The frames are still worth judging.
      logger.warn(`deletedMessages: could not transcribe the video ${attachment.name} for the judge:`, error);
      return undefined;
    });
  }
  const length = sample.durationSecs !== undefined ? ` (${formatClock(sample.durationSecs)})` : '';
  const heard = said ? `, said: "${oneLine(said, SAID_CHARS)}"` : said === '' ? ', no speech' : '';
  return { images: sample.frames.map(jpegUri), note: `video ${attachment.name}${length}${heard}` };
}

async function linkedPicture(url: URL, deps: JudgeMediaDeps): Promise<Seen> {
  const data = await deps.downloadImage(url.toString());
  if (!data) return NOTHING;
  // The file name, not the URL: Discord's CDN links carry signing parameters.
  const name = decodeURIComponent(url.pathname.split('/').pop() ?? '') || url.hostname;
  const { frames, animated } = await pictureFrames(data, name);
  return { images: frames, note: animated ? `linked animated image ${name}` : undefined };
}

/** A Klipy/Tenor page: what the GIF is called and shows, and its still. */
async function gifPage(url: string, deps: JudgeMediaDeps): Promise<Seen> {
  const result = await deps.readLink(url);
  if (!result.ok) {
    logger.info(`deletedMessages: could not read the GIF ${url} for the judge: ${result.error}`);
    return NOTHING;
  }
  const content = result.content;
  const still = content.media.find((m) => m.type === 'image')?.url;
  const data = still ? await deps.downloadImage(still) : undefined;
  const { frames } = data ? await pictureFrames(data, still ?? url) : { frames: [] };
  const title = content.title ? ` "${content.title}"` : '';
  const shows = content.text ? `: ${content.text}` : '';
  return {
    images: frames,
    note: oneLine(`${content.kind} on ${content.site ?? content.source}${title}${shows}`, NOTE_CHARS),
  };
}

type VisualLink = { kind: 'gif' | 'picture'; url: URL };

/** The GIF pages and image files the text links to (code and <…>-suppressed links aside). */
function visualLinks(content: string): VisualLink[] {
  const links: VisualLink[] = [];
  for (const link of findLinks(content, { discordMedia: true })) {
    let url: URL;
    let source: string;
    try {
      url = new URL(link);
      source = identifyLink(url).source;
    } catch {
      continue;
    }
    if (source === 'tenor' || source === 'klipy') links.push({ kind: 'gif', url });
    else if (IMAGE_FILE.test(url.pathname)) links.push({ kind: 'picture', url });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

/** A picture or a video, by declared type (or the extension when Discord left the type off). */
export function attachmentKind(
  attachment: Pick<SnapshotAttachment, 'name' | 'contentType'>,
): 'picture' | 'video' | undefined {
  const type = attachment.contentType?.split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') return undefined;
  if (type?.startsWith('image/')) return 'picture';
  if (type?.startsWith('video/')) return 'video';
  if (type) return undefined;
  // Discord leaves the type off now and then; the extension says enough.
  if (IMAGE_FILE.test(attachment.name)) return 'picture';
  if (VIDEO_FILE.test(attachment.name)) return 'video';
  return undefined;
}

async function safely(label: string, work: () => Promise<Seen>): Promise<Seen> {
  try {
    return await work();
  } catch (error) {
    logger.warn(`deletedMessages: reading ${label} for the judge failed:`, error);
    return NOTHING;
  }
}

/** What the saved attachments and the text's GIF and image links show, as images and notes for the judge. */
export async function describeForJudge(
  content: string,
  attachments: SnapshotAttachment[],
  deps: JudgeMediaDeps = defaultJudgeMediaDeps(),
): Promise<JudgeMedia> {
  const jobs: Array<Promise<Seen>> = [];
  let pictures = 0;
  let videos = 0;
  for (const attachment of attachments) {
    const kind = attachmentKind(attachment);
    if (kind === 'picture' && pictures++ < MAX_PICTURES) {
      jobs.push(safely(attachment.name, () => savedPicture(attachment)));
    } else if (kind === 'video' && videos++ < MAX_VIDEOS) {
      jobs.push(safely(attachment.name, () => savedVideo(attachment, deps)));
    }
  }
  for (const link of visualLinks(content)) {
    const url = link.url.toString();
    jobs.push(safely(redact(url), () => (link.kind === 'gif' ? gifPage(url, deps) : linkedPicture(link.url, deps))));
  }
  const seen = await Promise.all(jobs);
  return {
    imageUrls: seen.flatMap((s) => s.images).slice(0, MAX_IMAGES),
    notes: seen.flatMap((s) => (s.note ? [s.note] : [])),
  };
}

export function defaultJudgeMediaDeps(): JudgeMediaDeps {
  return {
    readLink: (url) => getLinkReader().read(url),
    downloadImage: async (url) => {
      const result = await downloadMedia(url, {
        maxBytes: LINKED_IMAGE_MAX_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        accept: IMAGE_TYPES,
      });
      // Discord's CDN is fetched without a type allowlist: its answer still has to be a raster image.
      const type = result.ok ? (result.contentType?.split(';')[0].trim().toLowerCase() ?? '') : '';
      return result.ok && (type === '' || IMAGE_TYPES.includes(type) || type === 'application/octet-stream')
        ? result.data
        : undefined;
    },
    sampleVideo: (input, opts) => getMediaTranscoder().sampleVideo(input, opts),
    transcribe: async (audio, label, durationSecs) => {
      const outcome = await getAudioTranscriber().transcribeBuffer(audio, 'mp3', label, { durationSecs });
      return outcome.status === 'ok' ? outcome.text : undefined;
    },
  };
}
