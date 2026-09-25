// Video understanding: a compact description (what happens, on-screen text, what's said) of an
// uploaded clip or a video behind a shared link.
//
// Two paths:
//   - native: the whole clip goes to a video-input model as a base64 data URL. Gemini is served with
//     zero data retention only on Google Vertex, which fetches no arbitrary URLs (AI Studio's YouTube
//     links don't apply there), so the bot downloads the clip itself. Bounded by VIDEO_MAX_BYTES and
//     VIDEO_MAX_SECONDS.
//   - frames: for clips over those bounds, containers the endpoint doesn't take, models without video
//     input, or a failed native call — ffmpeg samples up to 8 keyframes plus the audio track, the track
//     is transcribed, and a vision model describes the frames with the transcript alongside.
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { getOpenRouterClient } from '../openRouterClient';
import { downloadMedia, redact } from './download';
import { acceptsVideoInput, detectVideoMime } from './formats';
import { type MediaContentPart, completeMedia, describeError } from './modelCall';
import { getStoredVideoDescription, mediaCacheKey, storeVideoDescription } from './store';
import type { AudioTranscriber } from './transcriber';
import type { MediaTranscoder } from './transcoder';
import type { VideoInput, VideoOutcome } from './types';
import { formatClock } from './voice';

/** The most the frames path will download; bigger files are skipped rather than buffered. */
export const VIDEO_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DESCRIBE_TIMEOUT_MS = 120_000;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_FRAMES = 8;
const FRAME_MAX_DIMENSION = 768;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_CONTEXT_CHARS = 300;

const SYSTEM_PROMPT =
  "You describe videos for a Discord bot in a private friend group's server; the bot can't watch them itself. Be factual and compact, and never comment on the task.";

const ANSWER_SHAPE = `Answer in this shape, leaving out any line that doesn't apply:
<1–3 sentences: what happens — who or what is on screen, the key moment, the tone (funny, hype, cringe, wholesome…). For gameplay, name the game and the play.>
On-screen text: <captions, subtitles or other text that matters, verbatim>
Said: <what's spoken or sung, close to verbatim in the original language; add an English translation in parentheses if it isn't English>
No preamble, no markdown headings, under 120 words.`;

function contextLine(context: string | undefined): string {
  const trimmed = context?.trim();
  if (!trimmed) return '';
  const capped = trimmed.length > MAX_CONTEXT_CHARS ? `${trimmed.slice(0, MAX_CONTEXT_CHARS)}…` : trimmed;
  return `\nContext from the chat: ${capped}`;
}

export function cleanDescription(raw: string): string | undefined {
  const text = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
}

export type VideoDescriberOptions = {
  client?: () => OpenAI | undefined;
  fetch?: typeof globalThis.fetch;
  transcoder: MediaTranscoder;
  /** Transcribes the audio track on the frames path. */
  transcriber: Pick<AudioTranscriber, 'transcribeBuffer'>;
  model?: () => string;
  maxBytes?: () => number;
  maxSeconds?: () => number;
  inputMode?: () => 'auto' | 'native' | 'frames';
  maxAudioSeconds?: () => number;
  now?: () => number;
};

export class VideoDescriber {
  private readonly client: () => OpenAI | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly transcoder: MediaTranscoder;
  private readonly transcriber: Pick<AudioTranscriber, 'transcribeBuffer'>;
  private readonly model: () => string;
  private readonly maxBytes: () => number;
  private readonly maxSeconds: () => number;
  private readonly inputMode: () => 'auto' | 'native' | 'frames';
  private readonly maxAudioSeconds: () => number;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<VideoOutcome>>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(opts: VideoDescriberOptions) {
    this.client = opts.client ?? getOpenRouterClient;
    this.fetchImpl = opts.fetch;
    this.transcoder = opts.transcoder;
    this.transcriber = opts.transcriber;
    this.model = opts.model ?? (() => config.media.videoModel);
    this.maxBytes = opts.maxBytes ?? (() => config.media.videoMaxBytes);
    this.maxSeconds = opts.maxSeconds ?? (() => config.media.videoMaxSeconds);
    this.inputMode = opts.inputMode ?? (() => config.media.videoInputMode);
    this.maxAudioSeconds = opts.maxAudioSeconds ?? (() => config.media.voiceMaxSeconds);
    this.now = opts.now ?? (() => Date.now());
  }

  /** A stored description for this URL, without any paid work. */
  cached(url: string): string | undefined {
    return getStoredVideoDescription(mediaCacheKey(url));
  }

  async describe(input: VideoInput): Promise<VideoOutcome> {
    const key = mediaCacheKey(input.url);
    const stored = getStoredVideoDescription(key);
    if (stored !== undefined) return { status: 'ok', text: stored, cached: true };

    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if ((this.cooldownUntil.get(key) ?? 0) > this.now()) return { status: 'failed' };

    const run = this.run(input, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async run(input: VideoInput, key: string): Promise<VideoOutcome> {
    const client = this.client();
    if (!client) {
      logger.warn('video: no OPENROUTER_API_KEY; skipping');
      return { status: 'unavailable' };
    }

    const maxBytes = this.maxBytes();
    const download = await downloadMedia(input.url, {
      maxBytes: Math.max(maxBytes, VIDEO_DOWNLOAD_MAX_BYTES),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    if (!download.ok) {
      if (download.reason === 'too_large') {
        logger.info(`video: ${redact(input.url)} is too large to download; skipping`);
        return { status: 'too_large' };
      }
      this.cooldownUntil.set(key, this.now() + FAILURE_COOLDOWN_MS);
      return { status: 'failed' };
    }

    const model = this.model();
    const text =
      (await this.tryNative(client, model, input, download.data, download.contentType)) ??
      (await this.tryFrames(client, model, input, download.data));

    if (text === undefined) {
      this.cooldownUntil.set(key, this.now() + FAILURE_COOLDOWN_MS);
      return { status: 'failed' };
    }
    storeVideoDescription(key, text, model, this.now());
    return { status: 'ok', text, cached: false };
  }

  /** The whole clip as a data URL, when the model, container, size and length all allow it. */
  private async tryNative(
    client: OpenAI,
    model: string,
    input: VideoInput,
    data: Buffer,
    downloadedType: string | undefined,
  ): Promise<string | undefined> {
    const mode = this.inputMode();
    if (mode === 'frames' || (mode === 'auto' && !acceptsVideoInput(model))) return undefined;
    const mime = detectVideoMime(data, input.contentType ?? downloadedType, input.url);
    if (!mime) return undefined;
    if (data.byteLength > this.maxBytes()) return undefined;

    const durationSecs = input.durationSecs ?? (await this.probeDuration(data));
    if (durationSecs !== undefined && durationSecs > this.maxSeconds()) return undefined;

    const started = this.now();
    try {
      const raw = await completeMedia({
        client,
        model,
        feature: 'video',
        system: SYSTEM_PROMPT,
        content: [
          { type: 'video_url', video_url: { url: `data:${mime};base64,${data.toString('base64')}` } },
          {
            type: 'text',
            text: `Describe this video so someone who can't watch it knows what's in it.${contextLine(input.context)}\n${ANSWER_SHAPE}`,
          },
        ],
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: DESCRIBE_TIMEOUT_MS,
      });
      const text = cleanDescription(raw);
      if (text === undefined) throw new Error(`${model} returned an empty description`);
      logger.info(
        `video: described ${redact(input.url)} natively via ${model} (${mime}, ${data.byteLength} bytes) in ${this.now() - started}ms`,
      );
      return text;
    } catch (error) {
      logger.warn(`video: native description via ${model} failed (${describeError(error)}); trying keyframes`);
      return undefined;
    }
  }

  /** Keyframes + the audio track's transcript, for a vision model. */
  private async tryFrames(client: OpenAI, model: string, input: VideoInput, data: Buffer): Promise<string | undefined> {
    const started = this.now();
    let sample: Awaited<ReturnType<MediaTranscoder['sampleVideo']>>;
    try {
      sample = await this.transcoder.sampleVideo(data, {
        frames: MAX_FRAMES,
        maxDimension: FRAME_MAX_DIMENSION,
        maxAudioSeconds: this.maxAudioSeconds(),
      });
    } catch (error) {
      logger.warn(`video: could not sample ${redact(input.url)}:`, error);
      return undefined;
    }
    if (sample.frames.length === 0 && !sample.audio) {
      logger.warn(`video: ${redact(input.url)} yielded neither frames nor audio`);
      return undefined;
    }

    let heard = 'It has no audio track.';
    if (sample.audio) {
      const transcript = await this.transcriber.transcribeBuffer(sample.audio, 'mp3', `video ${redact(input.url)}`);
      if (transcript.status === 'ok') {
        heard = transcript.text ? `Transcript of its audio:\n${transcript.text}` : 'Its audio has no speech.';
      } else {
        heard = "Its audio couldn't be transcribed.";
      }
    }

    const length = sample.durationSecs ? `${formatClock(sample.durationSecs)} ` : '';
    const intro =
      sample.frames.length > 0
        ? `These are ${sample.frames.length} still frames sampled evenly, in order, from a ${length}video; you can't hear it.`
        : `This ${length}video has no picture you can see; only its audio is available.`;
    const content: MediaContentPart[] = [
      ...sample.frames.map(
        (frame): MediaContentPart => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` },
        }),
      ),
      {
        type: 'text',
        text: `${intro}\n${heard}\nDescribe the video so someone who can't watch it knows what's in it.${contextLine(input.context)}\n${ANSWER_SHAPE}`,
      },
    ];

    try {
      const raw = await completeMedia({
        client,
        model,
        feature: 'video',
        system: SYSTEM_PROMPT,
        content,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: DESCRIBE_TIMEOUT_MS,
      });
      const text = cleanDescription(raw);
      if (text === undefined) throw new Error(`${model} returned an empty description`);
      logger.info(
        `video: described ${redact(input.url)} from ${sample.frames.length} frames via ${model} in ${this.now() - started}ms`,
      );
      return text;
    } catch (error) {
      logger.warn(`video: keyframe description via ${model} failed: ${describeError(error)}`);
      return undefined;
    }
  }

  private async probeDuration(data: Buffer): Promise<number | undefined> {
    try {
      return (await this.transcoder.probe(data)).durationSecs;
    } catch (error) {
      logger.debug('video: duration probe unavailable:', error);
      return undefined;
    }
  }
}
