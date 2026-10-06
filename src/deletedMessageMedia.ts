// What a deleted message showed, for the edgy judge (src/deletedMessages.ts). The judge can't open a
// link or watch a video, and a GIF from Discord's picker is nothing but a link in the text: judged on that
// alone, every GIF regret read as "just a link". So before judging:
//   - saved pictures: downscaled JPEGs; an animated GIF/WebP gives frames from across it
//   - saved videos: a few keyframes (ffmpeg) and what's said in them (the soundtrack, transcribed)
//   - GIF pages in the text (Klipy, Tenor): their title, description and tags through the link reader,
//     plus the GIF's still
//   - links to image files (a favorited GIF on Discord's CDN, a media.tenor.com/….gif): the image. A
//     favorite is an unsigned cdn.discordapp.com link the CDN refuses to serve as is: it is signed first
//     (src/discordCdn.ts), or every such GIF stays unseen (it did, until October 2026).
// Each thing it showed is one labelled visual ("linked GIF dance.gif (animated, 60 frames over 3.0 s)" and
// its frames in order), so the judge knows which frames belong together. Everything but the transcription
// (Whisper, a fraction of a cent) is free, and it all runs only for a watched member's message deleted
// inside the window, in edgy mode. Nothing here throws: whatever can't be read is left out (an image link
// that couldn't be opened is reported, so a message that was nothing else is never judged blind).
import sharp from 'sharp';
import { getLinkReader } from './ai/linkReader/reader';
import { findLinks, identifyLink } from './ai/linkReader/targets';
import type { LinkReadResult } from './ai/linkReader/types';
import { getAudioTranscriber, getMediaTranscoder } from './ai/media';
import { downloadMedia, redact } from './ai/media/download';
import type { MediaTranscoder } from './ai/media/transcoder';
import { formatClock } from './ai/media/voice';
import type { JudgeVisual } from './ai/messageJudge';
import { needsSigning, type UrlSigner } from './discordCdn';
import { logger } from './logger';

export type { JudgeVisual };

export type SnapshotAttachment = { name: string; contentType: string | null; data: Buffer };

/** What the judge gets on top of the text: the visuals, and the same in words. */
export type JudgeMedia = {
  visuals: JudgeVisual[];
  notes: string[];
  /** Links to image files in the text that could not be opened, as written there (their names say nothing). */
  unreadableLinks: string[];
};

export type JudgeMediaDeps = {
  /** Reads a GIF page: title, description, still. Default: the shared link reader. */
  readLink: (url: string) => Promise<LinkReadResult>;
  /** A linked image's bytes. Default: Discord's CDN directly, anything else through the guarded fetch. */
  downloadImage: (url: string) => Promise<Buffer | undefined>;
  /** Keyframes and the soundtrack of a saved video. Default: the shared ffmpeg wrapper. */
  sampleVideo: MediaTranscoder['sampleVideo'];
  /** What's said in an MP3 soundtrack: '' for no speech, undefined when it couldn't be transcribed. */
  transcribe: (audio: Buffer, label: string, durationSecs: number | undefined) => Promise<string | undefined>;
  /**
   * Signs Discord attachment links the CDN won't serve as they are (src/discordCdn.ts): the bot's REST
   * client, passed in by the reposter. Without one, links are fetched as written.
   */
  signUrls?: UrlSigner;
};

// The judge needs the gist, not every frame: a video's keyframes plus a GIF or two fit.
const MAX_IMAGES = 6;
const MAX_PICTURES = 4;
const MAX_VIDEOS = 2;
const MAX_LINKS = 3;
const ANIMATION_FRAMES = 3;
// A GIF that is the whole message gets every frame the judge can take: the punchline may be one beat of it.
const ANIMATION_FRAMES_ALONE = MAX_IMAGES;
const VIDEO_FRAMES = 4;
const IMAGE_DIMENSION = 768;
// A tiny GIF (favorites are often 200 px wide) is enlarged up to this much, so its caption stays legible.
const MAX_ENLARGEMENT = 2;
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

/**
 * One thing read for the judge: a visual (`label` and `frames`; `sequence` when the frames are a run of
 * moments, so the label says how many there are), its words (`note`), or a link that couldn't be opened.
 */
type Seen = { label?: string; frames: string[]; sequence?: boolean; note?: string; unreadable?: string };
const NOTHING: Seen = { frames: [] };

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function jpegUri(data: Buffer): string {
  return `data:image/jpeg;base64,${data.toString('base64')}`;
}

/** Evenly spaced frame indices from the middle of each stretch: 3 of 12 → 2, 6, 10 (frame 0 is often a fade-in). */
export function framePicks(pages: number, count: number): number[] {
  const n = Math.min(count, pages);
  return [...new Set(Array.from({ length: n }, (_, i) => Math.floor(((i + 0.5) * pages) / n)))];
}

type Frames = { frames: string[]; animated: boolean; pages: number; durationSecs?: number };

/** "(animated, 60 frames over 3.0 s)". */
function animationDetails(frames: Frames): string {
  const length = frames.durationSecs !== undefined ? ` over ${frames.durationSecs.toFixed(1)} s` : '';
  return `(animated, ${frames.pages} frames${length})`;
}

/**
 * A picture as downscaled JPEG data URIs: one for a still, `count` from across an animation. Small pictures
 * are enlarged up to MAX_ENLARGEMENT, big ones fit in IMAGE_DIMENSION. Flattened so transparency doesn't
 * turn black. Undecodable data gives none.
 */
async function pictureFrames(data: Buffer, label: string, count: number): Promise<Frames> {
  try {
    const meta = await sharp(data).metadata();
    const pages = meta.pages ?? 1;
    const width = meta.width;
    const height = meta.pageHeight ?? meta.height;
    const scale = width && height ? Math.min(IMAGE_DIMENSION / Math.max(width, height), MAX_ENLARGEMENT) : 1;
    const box =
      width && height
        ? { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
        : { width: IMAGE_DIMENSION, height: IMAGE_DIMENSION, withoutEnlargement: true };
    const frames: string[] = [];
    for (const page of framePicks(pages, pages > 1 ? count : 1)) {
      const jpeg = await sharp(data, { page })
        .resize({ ...box, fit: 'inside' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80 })
        .toBuffer();
      frames.push(jpegUri(jpeg));
    }
    const delays = Array.isArray(meta.delay) ? meta.delay : [];
    const totalMs = delays.reduce((sum, ms) => sum + ms, 0);
    return { frames, animated: pages > 1, pages, ...(totalMs > 0 ? { durationSecs: totalMs / 1000 } : {}) };
  } catch (error) {
    logger.debug(`deletedMessages: could not decode ${label} for the judge:`, error);
    return { frames: [], animated: false, pages: 0 };
  }
}

async function savedPicture(attachment: SnapshotAttachment, animationFrames: number): Promise<Seen> {
  const read = await pictureFrames(attachment.data, attachment.name, animationFrames);
  if (read.frames.length === 0) return NOTHING;
  if (!read.animated) return { label: `picture ${attachment.name}`, frames: read.frames };
  return {
    label: `animated image ${attachment.name} ${animationDetails(read)}`,
    frames: read.frames,
    sequence: true,
    note: `animated image ${attachment.name}`,
  };
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
  return {
    label: `video ${attachment.name}${length}`,
    frames: sample.frames.map(jpegUri),
    sequence: true,
    note: `video ${attachment.name}${length}${heard}`,
  };
}

/** The file name of a link (its signing parameters left out). */
function fileName(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split('/').pop() ?? '') || url.hostname;
  } catch {
    return url.pathname.split('/').pop() || url.hostname;
  }
}

async function linkedPicture(
  link: VisualLink,
  fetchUrl: string,
  deps: JudgeMediaDeps,
  animationFrames: number,
): Promise<Seen> {
  const name = fileName(link.url);
  const what = /\.gif$/i.test(link.url.pathname) ? 'GIF' : 'image';
  const data = await deps.downloadImage(fetchUrl);
  const read = data ? await pictureFrames(data, name, animationFrames) : undefined;
  if (!read || read.frames.length === 0) {
    return { frames: [], note: `linked ${what} ${name} (could not be opened)`, unreadable: link.raw };
  }
  if (!read.animated) return { label: `linked ${what} ${name}`, frames: read.frames };
  return {
    label: `linked ${what} ${name} ${animationDetails(read)}`,
    frames: read.frames,
    sequence: true,
    note: `linked animated image ${name}`,
  };
}

/**
 * A Klipy/Tenor page: what the GIF is called and shows, and its still. One that can't be read leaves the
 * judge its link, whose slug names the GIF ("…/gifs/cat-in-a-tie-…").
 */
async function gifPage(link: VisualLink, deps: JudgeMediaDeps): Promise<Seen> {
  const url = link.url.toString();
  const result = await deps.readLink(url);
  if (!result.ok) {
    logger.info(`deletedMessages: could not read the GIF ${redact(url)} for the judge: ${result.error}`);
    return NOTHING;
  }
  const content = result.content;
  const still = content.media.find((m) => m.type === 'image')?.url;
  const data = still ? await deps.downloadImage(still) : undefined;
  const { frames } = data ? await pictureFrames(data, still ?? url, 1) : { frames: [] };
  const title = content.title ? ` "${content.title}"` : '';
  const shows = content.text ? `: ${content.text}` : '';
  const site = content.site ?? content.source;
  return {
    ...(frames.length > 0 ? { label: `GIF from ${site}${title} (its still)`, frames } : { frames: [] }),
    note: oneLine(`${content.kind} on ${site}${title}${shows}`, NOTE_CHARS),
  };
}

/** A GIF page or an image file the text links to; `raw` is the link as written in the text. */
type VisualLink = { kind: 'gif' | 'picture'; url: URL; raw: string };

/** The GIF pages and image files the text links to (code and <…>-suppressed links aside). */
function visualLinks(content: string): VisualLink[] {
  const links: VisualLink[] = [];
  for (const raw of findLinks(content, { discordMedia: true })) {
    let url: URL;
    let source: string;
    try {
      url = new URL(raw);
      source = identifyLink(url).source;
    } catch {
      continue;
    }
    if (source === 'tenor' || source === 'klipy') links.push({ kind: 'gif', url, raw });
    else if (IMAGE_FILE.test(url.pathname)) links.push({ kind: 'picture', url, raw });
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

async function safely(label: string, work: () => Promise<Seen>, unreadable?: string): Promise<Seen> {
  try {
    return await work();
  } catch (error) {
    logger.warn(`deletedMessages: reading ${label} for the judge failed:`, error);
    return unreadable ? { frames: [], unreadable } : NOTHING;
  }
}

/** The attachment links of `links` the CDN won't serve as written, signed (original → signed). */
async function signedLinks(links: VisualLink[], deps: JudgeMediaDeps): Promise<Map<string, string>> {
  const unsigned = links.filter((l) => l.kind === 'picture' && needsSigning(l.url)).map((l) => l.url.toString());
  if (unsigned.length === 0 || !deps.signUrls) return new Map();
  return deps.signUrls(unsigned).catch((error) => {
    logger.warn('deletedMessages: signing linked attachments failed:', error);
    return new Map<string, string>();
  });
}

/** Frames in order, at most MAX_IMAGES in all; a visual left without a frame is left out. */
function capFrames(seen: Seen[]): JudgeVisual[] {
  const visuals: JudgeVisual[] = [];
  let room = MAX_IMAGES;
  for (const s of seen) {
    if (!s.label || s.frames.length === 0 || room === 0) continue;
    const frames = s.frames.slice(0, room);
    room -= frames.length;
    const count = s.sequence ? `: ${frames.length === 1 ? 'one frame' : `${frames.length} frames in order`}` : '';
    visuals.push({ label: `${s.label}${count}`, frames });
  }
  return visuals;
}

/** What the saved attachments and the text's GIF and image links show, as visuals and notes for the judge. */
export async function describeForJudge(
  content: string,
  attachments: SnapshotAttachment[],
  deps: JudgeMediaDeps = defaultJudgeMediaDeps(),
): Promise<JudgeMedia> {
  const pictures = attachments.filter((a) => attachmentKind(a) === 'picture').slice(0, MAX_PICTURES);
  const videos = attachments.filter((a) => attachmentKind(a) === 'video').slice(0, MAX_VIDEOS);
  const links = visualLinks(content);
  const alone = pictures.length + videos.length + links.length === 1;
  const animationFrames = alone ? ANIMATION_FRAMES_ALONE : ANIMATION_FRAMES;
  const signed = await signedLinks(links, deps);

  const jobs: Array<Promise<Seen>> = [
    ...attachments.flatMap((attachment) => {
      if (pictures.includes(attachment)) {
        return [safely(attachment.name, () => savedPicture(attachment, animationFrames))];
      }
      if (videos.includes(attachment)) return [safely(attachment.name, () => savedVideo(attachment, deps))];
      return [];
    }),
    ...links.map((link) => {
      const url = link.url.toString();
      const work = () =>
        link.kind === 'gif' ? gifPage(link, deps) : linkedPicture(link, signed.get(url) ?? url, deps, animationFrames);
      return safely(redact(url), work, link.kind === 'picture' ? link.raw : undefined);
    }),
  ];
  const seen = await Promise.all(jobs);
  return {
    visuals: capFrames(seen),
    notes: seen.flatMap((s) => (s.note ? [s.note] : [])),
    unreadableLinks: seen.flatMap((s) => (s.unreadable ? [s.unreadable] : [])),
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
