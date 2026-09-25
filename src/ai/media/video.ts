// Video understanding: a compact description (what happens, on-screen text, what's said) of an
// uploaded clip or a video behind a shared link — or, for a follow-up, the answer to one specific
// question about it ("what does he say at the end?"). The chat model never sees the video itself;
// it reads what this module writes, and asks again (watch_video / read_link's question) when it needs to.
//
// Two paths:
//   - native: the whole clip goes to a video-input model as a base64 data URL. Zero-data-retention
//     endpoints fetch no arbitrary URLs (Gemini on Vertex takes none; AI Studio's YouTube links don't
//     apply there), so the bot downloads the clip itself. Bounded by VIDEO_MAX_BYTES and
//     VIDEO_MAX_SECONDS. A model that watches but can't hear (GLM, most Qwen) gets the audio track's
//     transcript alongside, so "what's said" still makes it into the description.
//   - frames: for clips over those bounds, containers the endpoint doesn't take, models without video
//     input, or a failed native call — ffmpeg samples up to 8 keyframes plus the audio track, the track
//     is transcribed (Whisper), and a vision model describes the frames with the transcript alongside.
//
// Every video-model call first checks VIDEO_DAILY_BUDGET_USD against today's ledger spend
// (videoBudget.ts). Descriptions are cached per URL and answers per (URL, question) in bot.db; the
// downloaded clip itself is kept in memory for a few minutes (clipCache.ts) so a follow-up question
// doesn't download it again. What the model takes (video? audio?) comes from the model catalog.
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import type { SafeFetch } from '../linkReader/safeFetch';
import { type ModelCatalog, type ModelInfo, getModelCatalog } from '../modelCatalog';
import { getOpenRouterClient } from '../openRouterClient';
import { ClipCache } from './clipCache';
import { downloadMedia, redact } from './download';
import { detectVideoMime } from './formats';
import { type MediaContentPart, completeMedia, describeError } from './modelCall';
import {
  getStoredVideoAnswer,
  getStoredVideoDescription,
  mediaCacheKey,
  questionKey,
  storeVideoAnswer,
  storeVideoDescription,
} from './store';
import type { MediaTranscoder } from './transcoder';
import type { AudioTranscriber } from './transcriber';
import type { VideoInput, VideoOutcome } from './types';
import { VideoBudget } from './videoBudget';
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
export const MAX_QUESTION_CHARS = 500;

const SYSTEM_PROMPT =
  "You describe videos for a Discord bot in a private friend group's server; the bot can't watch them itself. Be factual and compact, and never comment on the task.";

const ANSWER_SHAPE = `Answer in this shape, leaving out any line that doesn't apply:
<1–3 sentences: what happens — who or what is on screen, the key moment, the tone (funny, hype, cringe, wholesome…). For gameplay, name the game and the play.>
On-screen text: <captions, subtitles or other text that matters, verbatim>
Said: <what's spoken or sung, close to verbatim in the original language; add an English translation in parentheses if it isn't English>
No preamble, no markdown headings, under 120 words.`;

const DESCRIBE_ASK = "Describe the video so someone who can't watch it knows what's in it.";

const QUESTION_SHAPE = `Answer from what the video shows and what is said in it. If it doesn't show or say that, say so plainly instead of guessing. Quote speech close to verbatim in the original language (add an English translation in parentheses if it isn't English); give timestamps (m:ss) when they help.
No preamble, no markdown headings, under 100 words.`;

/** What one watch is for: the general description, or one question. */
type Task = { ask: string; shape: string; what: string };

function describeTask(): Task {
  return { ask: DESCRIBE_ASK, shape: ANSWER_SHAPE, what: 'description' };
}

function questionTask(question: string): Task {
  // The question is a member's (or the chat model's) words: quoted as data, capped.
  return {
    ask: `Answer this question about the video: "${question.slice(0, MAX_QUESTION_CHARS)}"`,
    shape: QUESTION_SHAPE,
    what: 'answer',
  };
}

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
  /** The guarded fetch for non-Discord URLs (default: the shared createSafeFetch()). */
  safeFetch?: SafeFetch;
  transcoder: MediaTranscoder;
  /** Transcribes the audio track for models that can't hear it (and on the frames path). */
  transcriber: Pick<AudioTranscriber, 'transcribeBuffer'>;
  model?: () => string;
  maxBytes?: () => number;
  maxSeconds?: () => number;
  inputMode?: () => 'auto' | 'native' | 'frames';
  maxAudioSeconds?: () => number;
  now?: () => number;
  catalog?: Pick<ModelCatalog, 'info'>;
  /** Default: VIDEO_DAILY_BUDGET_USD against the usage ledger. */
  budget?: Pick<VideoBudget, 'check'>;
  /** Default: a private in-memory cache of the last few clips. */
  clips?: ClipCache;
};

type Attempt = {
  client: OpenAI;
  model: string;
  info: ModelInfo;
  input: VideoInput;
  data: Buffer;
  task: Task;
  /** The soundtrack line once transcribed, so a native call that fails doesn't pay for it twice. */
  heard?: string;
};

/** Thrown between calls when the day's budget ran out mid-watch (native failed, frames not tried). */
class OverBudget extends Error {}

export class VideoDescriber {
  private readonly client: () => OpenAI | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly safeFetch?: SafeFetch;
  private readonly transcoder: MediaTranscoder;
  private readonly transcriber: Pick<AudioTranscriber, 'transcribeBuffer'>;
  private readonly model: () => string;
  private readonly maxBytes: () => number;
  private readonly maxSeconds: () => number;
  private readonly inputMode: () => 'auto' | 'native' | 'frames';
  private readonly maxAudioSeconds: () => number;
  private readonly now: () => number;
  private readonly catalog: Pick<ModelCatalog, 'info'>;
  private readonly budget: Pick<VideoBudget, 'check'>;
  private readonly clips: ClipCache;
  private readonly inFlight = new Map<string, Promise<VideoOutcome>>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(opts: VideoDescriberOptions) {
    this.client = opts.client ?? getOpenRouterClient;
    this.fetchImpl = opts.fetch;
    this.safeFetch = opts.safeFetch;
    this.transcoder = opts.transcoder;
    this.transcriber = opts.transcriber;
    this.model = opts.model ?? (() => config.media.videoModel);
    this.maxBytes = opts.maxBytes ?? (() => config.media.videoMaxBytes);
    this.maxSeconds = opts.maxSeconds ?? (() => config.media.videoMaxSeconds);
    this.inputMode = opts.inputMode ?? (() => config.media.videoInputMode);
    this.maxAudioSeconds = opts.maxAudioSeconds ?? (() => config.media.voiceMaxSeconds);
    this.now = opts.now ?? (() => Date.now());
    this.catalog = opts.catalog ?? getModelCatalog();
    this.budget = opts.budget ?? new VideoBudget({ now: this.now });
    this.clips = opts.clips ?? new ClipCache({ now: this.now });
  }

  /** A stored description for this URL, without any paid work. */
  cached(url: string): string | undefined {
    return getStoredVideoDescription(mediaCacheKey(url));
  }

  /**
   * The clip's description — or, when `input.question` is set, the answer to that question (see ask()).
   * Cached per URL; concurrent asks share one run; a failure cools down before it is retried.
   */
  async describe(input: VideoInput): Promise<VideoOutcome> {
    const question = input.question?.trim();
    if (question) return this.ask({ ...input, question });

    const key = mediaCacheKey(input.url);
    const stored = getStoredVideoDescription(key);
    if (stored !== undefined) return { status: 'ok', text: stored, cached: true };
    return this.dedup(key, () =>
      this.watch(input, key, describeTask(), (text, model) => storeVideoDescription(key, text, model, this.now())),
    );
  }

  /** Watches the clip again to answer one question about it. Answers are cached per (URL, question). */
  async ask(input: VideoInput & { question: string }): Promise<VideoOutcome> {
    const key = mediaCacheKey(input.url);
    const stored = getStoredVideoAnswer(key, input.question);
    if (stored !== undefined) return { status: 'ok', text: stored, cached: true };
    return this.dedup(`${key}\n${questionKey(input.question)}`, () =>
      this.watch(input, key, questionTask(input.question), (text, model) =>
        storeVideoAnswer(key, input.question, text, model, this.now()),
      ),
    );
  }

  private dedup(runKey: string, run: () => Promise<VideoOutcome>): Promise<VideoOutcome> {
    const pending = this.inFlight.get(runKey);
    if (pending) return pending;
    if ((this.cooldownUntil.get(runKey) ?? 0) > this.now()) return Promise.resolve({ status: 'failed' });

    const promise = run()
      .then((outcome) => {
        if (outcome.status === 'failed') this.setCooldown(runKey);
        return outcome;
      })
      .finally(() => this.inFlight.delete(runKey));
    this.inFlight.set(runKey, promise);
    return promise;
  }

  private setCooldown(key: string): void {
    const now = this.now();
    if (this.cooldownUntil.size > 500) {
      for (const [k, until] of this.cooldownUntil) if (until <= now) this.cooldownUntil.delete(k);
    }
    this.cooldownUntil.set(key, now + FAILURE_COOLDOWN_MS);
  }

  /** False (and logged) when today's video budget is spent. */
  private withinBudget(input: VideoInput): boolean {
    const verdict = this.budget.check();
    if (verdict.ok) return true;
    logger.info(
      `video: the daily budget is spent ($${verdict.spentUsd.toFixed(4)} of $${verdict.budgetUsd.toFixed(2)} today); not watching ${redact(input.url)}`,
    );
    return false;
  }

  private async watch(
    input: VideoInput,
    key: string,
    task: Task,
    store: (text: string, model: string) => void,
  ): Promise<VideoOutcome> {
    const client = this.client();
    if (!client) {
      logger.warn('video: no OPENROUTER_API_KEY; skipping');
      return { status: 'unavailable' };
    }
    // Checked before downloading too: an over-budget day shouldn't cost bandwidth either.
    if (!this.withinBudget(input)) return { status: 'over_budget' };

    const clip = await this.clip(input, key);
    if (!clip.ok) return clip.outcome;

    const model = this.model();
    const attempt: Attempt = { client, model, info: await this.catalog.info(model), input, data: clip.data, task };
    let text: string | undefined;
    try {
      text = (await this.tryNative(attempt, clip.contentType)) ?? (await this.tryFrames(attempt));
    } catch (error) {
      if (error instanceof OverBudget) return { status: 'over_budget' };
      throw error;
    }

    if (text === undefined) return { status: 'failed' };
    store(text, model);
    return { status: 'ok', text, cached: false };
  }

  /** The clip's bytes: from the short-lived clip cache, or downloaded (and then cached). */
  private async clip(
    input: VideoInput,
    key: string,
  ): Promise<{ ok: true; data: Buffer; contentType?: string } | { ok: false; outcome: VideoOutcome }> {
    const cached = this.clips.get(key);
    if (cached) return { ok: true, ...cached };

    const download = await downloadMedia(input.url, {
      maxBytes: Math.max(this.maxBytes(), VIDEO_DOWNLOAD_MAX_BYTES),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      fetch: this.fetchImpl,
      safeFetch: this.safeFetch,
    });
    if (!download.ok) {
      if (download.reason === 'too_large') {
        logger.info(`video: ${redact(input.url)} is too large to download; skipping`);
        return { ok: false, outcome: { status: 'too_large' } };
      }
      return { ok: false, outcome: { status: 'failed' } };
    }
    this.clips.set(key, { data: download.data, contentType: download.contentType });
    return { ok: true, data: download.data, contentType: download.contentType };
  }

  /** The whole clip as a data URL, when the model, container, size and length all allow it. */
  private async tryNative(attempt: Attempt, downloadedType: string | undefined): Promise<string | undefined> {
    const { client, model, info, input, data, task } = attempt;
    const mode = this.inputMode();
    if (mode === 'frames' || (mode === 'auto' && !info.inputModalities.has('video'))) return undefined;
    const mime = detectVideoMime(data, input.contentType ?? downloadedType, input.url);
    if (!mime) return undefined;
    if (data.byteLength > this.maxBytes()) return undefined;

    const durationSecs = input.durationSecs ?? (await this.probeDuration(data));
    if (durationSecs !== undefined && durationSecs > this.maxSeconds()) return undefined;

    const started = this.now();
    // A model that can't hear the soundtrack is told what's said instead (and that it can't hear it,
    // so it doesn't make speech up).
    const heard = info.inputModalities.has('audio')
      ? ''
      : `\nYou can see this video but not hear it. ${await this.soundtrackTranscript(attempt)}`;
    try {
      const raw = await completeMedia({
        client,
        model,
        feature: 'video',
        system: SYSTEM_PROMPT,
        content: [
          { type: 'video_url', video_url: { url: `data:${mime};base64,${data.toString('base64')}` } },
          { type: 'text', text: `${task.ask}${heard}${contextLine(input.context)}\n${task.shape}` },
        ],
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: DESCRIBE_TIMEOUT_MS,
        reasoningEffort: info.lowestEffort,
      });
      const text = cleanDescription(raw);
      if (text === undefined) throw new Error(`${model} returned an empty ${task.what}`);
      logger.info(
        `video: ${task.what} of ${redact(input.url)} natively via ${model} (${mime}, ${data.byteLength} bytes) in ${this.now() - started}ms`,
      );
      return text;
    } catch (error) {
      logger.warn(`video: native ${task.what} via ${model} failed (${describeError(error)}); trying keyframes`);
      return undefined;
    }
  }

  /** Keyframes + the audio track's transcript, for a vision model. */
  private async tryFrames(attempt: Attempt): Promise<string | undefined> {
    const { client, model, info, input, data, task } = attempt;
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

    const heard =
      attempt.heard ??
      (sample.audio
        ? await this.transcriptLine(sample.audio, input.url, sample.durationSecs)
        : 'It has no audio track.');
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
      { type: 'text', text: `${intro}\n${heard}\n${task.ask}${contextLine(input.context)}\n${task.shape}` },
    ];

    // A native attempt may have spent the last of today's budget.
    if (!this.withinBudget(input)) throw new OverBudget();
    try {
      const raw = await completeMedia({
        client,
        model,
        feature: 'video',
        system: SYSTEM_PROMPT,
        content,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: DESCRIBE_TIMEOUT_MS,
        reasoningEffort: info.lowestEffort,
      });
      const text = cleanDescription(raw);
      if (text === undefined) throw new Error(`${model} returned an empty ${task.what}`);
      logger.info(
        `video: ${task.what} of ${redact(input.url)} from ${sample.frames.length} frames via ${model} in ${this.now() - started}ms`,
      );
      return text;
    } catch (error) {
      logger.warn(`video: keyframe ${task.what} via ${model} failed: ${describeError(error)}`);
      return undefined;
    }
  }

  /** The clip's soundtrack as a prompt line, for a native call to a model that can't hear. */
  private async soundtrackTranscript(attempt: Attempt): Promise<string> {
    let track: { data: Buffer; durationSecs?: number } | undefined;
    try {
      track = await this.transcoder.toMp3(attempt.data, this.maxAudioSeconds());
    } catch (error) {
      // No ffmpeg or a broken track: say so rather than cache it, so the frames path may still try.
      logger.warn(`video: could not extract the audio track of ${redact(attempt.input.url)}:`, error);
      return "Its audio couldn't be transcribed.";
    }
    attempt.heard = track
      ? await this.transcriptLine(track.data, attempt.input.url, track.durationSecs)
      : 'It has no audio track.';
    return attempt.heard;
  }

  /**
   * The soundtrack's transcript as a prompt line. The track is cut at VOICE_MAX_SECONDS, so for a longer
   * video (a skimmed link, say) the line says how much of it was heard.
   */
  private async transcriptLine(audio: Buffer, url: string, durationSecs: number | undefined): Promise<string> {
    const transcript = await this.transcriber.transcribeBuffer(audio, 'mp3', `video ${redact(url)}`);
    if (transcript.status !== 'ok') return "Its audio couldn't be transcribed.";
    const cutAt = this.maxAudioSeconds();
    const partial = durationSecs !== undefined && durationSecs > cutAt;
    if (!transcript.text)
      return partial ? `Its first ${formatClock(cutAt)} of audio has no speech.` : 'Its audio has no speech.';
    const heading = partial
      ? `Transcript of the first ${formatClock(cutAt)} of its audio (the rest wasn't transcribed):`
      : 'Transcript of its audio:';
    return `${heading}\n${transcript.text}`;
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
