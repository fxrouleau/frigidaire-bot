// Voice-message and audio-file transcription through an audio-input chat model on OpenRouter.
//
// A chat model (Gemini by default) rather than a Whisper-style speech-to-text endpoint, because the
// transcript should come back in the language it was spoken plus an English line when it wasn't
// English — one prompt instead of two calls — and because OpenRouter's /audio/transcriptions endpoint
// does not apply provider routing preferences, so `provider: { zdr: true }` couldn't be pinned per
// request the way it is on every other call the bot makes.
//
// Pipeline: cache → duration guard → bounded download → send as-is when the model takes the format,
// otherwise (or when the provider refuses it) transcode to MP3 → store under the message id.
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { getOpenRouterClient } from '../openRouterClient';
import { downloadMedia, redact } from './download';
import { type AudioFormat, detectAudioFormat, nativeAudioFormats } from './formats';
import { completeMedia, describeError, isInputRejection } from './modelCall';
import { type ModelCatalog, getModelCatalog } from './modelCatalog';
import { getStoredTranscript, mediaCacheKey, storeTranscript } from './store';
import type { MediaTranscoder } from './transcoder';
import type { AudioInput, TranscriptionOutcome } from './types';

/** Discord's own upload ceiling for free accounts is far below this; it bounds link-borne audio. */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
// Gemini caps a request with inline media at 20 MB in total, and base64 adds a third: anything bigger
// is re-encoded to compact MP3 first (10 minutes of speech ≈ 3.6 MB) instead of being sent as-is.
export const INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
// A failed recording is not retried on every chat turn that renders it; it gets another chance later.
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
// ~10 minutes of speech plus its translation fits comfortably; reasoning models spend part of it thinking.
const MAX_OUTPUT_TOKENS = 8192;
const MAX_TRANSCRIPT_CHARS = 12_000;
const NO_SPEECH = '[no speech]';

const SYSTEM_PROMPT = 'You are a speech-to-text engine. You output transcripts only, never commentary.';

const TRANSCRIBE_PROMPT = `Transcribe this recording.
- Write exactly what is said, in the language it is spoken. Keep slang, profanity, names and code-switching as spoken. Don't translate, summarize, correct or censor. Pure filler sounds (um, uh) may be dropped.
- When more than one person speaks, start each speaker's turn on a new line beginning with "- ".
- Mention non-speech sounds only when they matter, in brackets, e.g. [laughs].
- If any of the speech is not in English, end with one extra line: "English: " followed by an English translation of everything said.
- If there is no intelligible speech (silence, noise, music without words), output exactly: ${NO_SPEECH}
Output the transcript only: no preamble, no quotes, no timestamps, no notes.`;

/**
 * Normalizes the model's answer: strips wrappers models add despite instructions and maps the
 * no-speech marker to ''. Undefined when the model returned nothing at all (a failure, not silence).
 */
export function cleanTranscript(raw: string): string | undefined {
  let text = raw.trim();
  text = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  text = text.replace(/^(transcript|transcription)\s*:\s*/i, '').trim();
  if (/^"[^"]*"$/s.test(text) || /^“[^”]*”$/s.test(text)) text = text.slice(1, -1).trim();
  if (text.length === 0) return undefined;
  if (/^\[?\s*no (intelligible )?speech\s*\]?\.?$/i.test(text)) return '';
  return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…` : text;
}

export type AudioTranscriberOptions = {
  client?: () => OpenAI | undefined;
  fetch?: typeof globalThis.fetch;
  transcoder: MediaTranscoder;
  model?: () => string;
  maxSeconds?: () => number;
  now?: () => number;
  catalog?: Pick<ModelCatalog, 'info' | 'catalogInfo'>;
};

type ModelPlan = { usable: true; effort?: string } | { usable: false };

export class AudioTranscriber {
  private readonly client: () => OpenAI | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly transcoder: MediaTranscoder;
  private readonly model: () => string;
  private readonly maxSeconds: () => number;
  private readonly now: () => number;
  private readonly catalog: Pick<ModelCatalog, 'info' | 'catalogInfo'>;
  private readonly warnedModels = new Set<string>();
  // The auto-transcript reply and the chat agent often ask for the same voice message at once.
  private readonly inFlight = new Map<string, Promise<TranscriptionOutcome>>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(opts: AudioTranscriberOptions) {
    this.client = opts.client ?? getOpenRouterClient;
    this.fetchImpl = opts.fetch;
    this.transcoder = opts.transcoder;
    this.model = opts.model ?? (() => config.media.transcriptionModel);
    this.maxSeconds = opts.maxSeconds ?? (() => config.media.voiceMaxSeconds);
    this.now = opts.now ?? (() => Date.now());
    this.catalog = opts.catalog ?? getModelCatalog();
  }

  /** The stored transcript for a cache key (a message id), without any paid work. */
  cached(key: string): string | undefined {
    return getStoredTranscript(key);
  }

  async transcribe(input: AudioInput): Promise<TranscriptionOutcome> {
    const key = input.messageId ?? `url:${mediaCacheKey(input.url)}`;
    if (input.messageId) {
      const stored = getStoredTranscript(key);
      if (stored !== undefined) return { status: 'ok', text: stored, cached: true };
    }

    const maxSeconds = this.maxSeconds();
    if (input.durationSecs && input.durationSecs > maxSeconds) {
      return { status: 'too_long', durationSecs: input.durationSecs };
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if ((this.cooldownUntil.get(key) ?? 0) > this.now()) return { status: 'failed' };

    const run = this.run(input, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  /** Transcribes audio already in memory (a video's extracted track). Nothing is cached. */
  async transcribeBuffer(data: Buffer, format: AudioFormat | undefined, label: string): Promise<TranscriptionOutcome> {
    const client = this.client();
    if (!client) return { status: 'unavailable' };
    const plan = await this.plan();
    if (!plan.usable) return { status: 'unavailable' };
    return this.transcribeData(client, data, format, undefined, label, plan.effort);
  }

  /**
   * Whether the configured model can hear audio at all (a misconfigured TRANSCRIPTION_MODEL would
   * otherwise fail every voice message with an opaque routing error), and the reasoning effort to ask for.
   */
  private async plan(): Promise<ModelPlan> {
    const model = this.model();
    const known = await this.catalog.catalogInfo(model);
    if (known && !known.inputModalities.has('audio')) {
      if (!this.warnedModels.has(model)) {
        this.warnedModels.add(model);
        logger.warn(`transcription: TRANSCRIPTION_MODEL ${model} does not take audio input; transcription is off`);
      }
      return { usable: false };
    }
    return { usable: true, effort: (known ?? (await this.catalog.info(model))).lowestEffort };
  }

  private setCooldown(key: string): void {
    const now = this.now();
    // Bounded: expired entries are swept whenever the map grows past a few hundred failures.
    if (this.cooldownUntil.size > 500) {
      for (const [k, until] of this.cooldownUntil) if (until <= now) this.cooldownUntil.delete(k);
    }
    this.cooldownUntil.set(key, now + FAILURE_COOLDOWN_MS);
  }

  private async run(input: AudioInput, key: string): Promise<TranscriptionOutcome> {
    const client = this.client();
    if (!client) {
      logger.warn('transcription: no OPENROUTER_API_KEY; skipping');
      return { status: 'unavailable' };
    }
    const plan = await this.plan();
    if (!plan.usable) return { status: 'unavailable' };

    const download = await downloadMedia(input.url, {
      maxBytes: AUDIO_MAX_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    if (!download.ok) {
      if (download.reason === 'too_large') {
        logger.info(`transcription: ${redact(input.url)} is over ${AUDIO_MAX_BYTES} bytes; skipping`);
        return { status: 'too_large' };
      }
      this.setCooldown(key);
      return { status: 'failed' };
    }

    const format = detectAudioFormat(download.data, input.contentType ?? download.contentType, input.url);
    const outcome = await this.transcribeData(
      client,
      download.data,
      format,
      input.durationSecs ?? undefined,
      key,
      plan.effort,
    );

    if (outcome.status === 'ok' && input.messageId) {
      storeTranscript(key, outcome.text, this.model(), this.now());
    } else if (outcome.status === 'failed') {
      this.setCooldown(key);
    }
    return outcome;
  }

  private async transcribeData(
    client: OpenAI,
    data: Buffer,
    format: AudioFormat | undefined,
    knownDurationSecs: number | undefined,
    label: string,
    effort: string | undefined,
  ): Promise<TranscriptionOutcome> {
    const model = this.model();
    const maxSeconds = this.maxSeconds();
    const fitsInline = data.byteLength <= INLINE_AUDIO_MAX_BYTES;
    const native = format !== undefined && nativeAudioFormats(model).has(format) && fitsInline;

    if (native && format) {
      if (knownDurationSecs === undefined) {
        const probed = await this.probeDuration(data);
        if (probed !== undefined && probed > maxSeconds) return { status: 'too_long', durationSecs: probed };
      }
      try {
        return await this.callModel(client, model, data, format, label, effort);
      } catch (error) {
        if (!isInputRejection(error)) {
          logger.warn(`transcription: ${model} failed on ${label}: ${describeError(error)}`);
          return { status: 'failed' };
        }
        logger.warn(
          `transcription: ${model} refused ${format} for ${label} (${describeError(error)}); retrying as MP3`,
        );
      }
    }

    let mp3: { data: Buffer; durationSecs?: number } | undefined;
    try {
      mp3 = await this.transcoder.toMp3(data, maxSeconds);
    } catch (error) {
      logger.warn(`transcription: could not transcode ${label} (${format ?? 'unknown format'}):`, error);
      // Without a working transcoder, a format OpenRouter documents is still worth one attempt as-is.
      if (!native && format && fitsInline) {
        try {
          return await this.callModel(client, model, data, format, label, effort);
        } catch (sendError) {
          logger.warn(`transcription: ${model} failed on ${label}: ${describeError(sendError)}`);
        }
      }
      return { status: 'failed' };
    }

    // A file without an audio track has nothing to say.
    if (!mp3) return { status: 'ok', text: '', cached: false };
    if (mp3.durationSecs !== undefined && mp3.durationSecs > maxSeconds) {
      return { status: 'too_long', durationSecs: mp3.durationSecs };
    }
    try {
      return await this.callModel(client, model, mp3.data, 'mp3', label, effort);
    } catch (error) {
      logger.warn(`transcription: ${model} failed on ${label} (as MP3): ${describeError(error)}`);
      return { status: 'failed' };
    }
  }

  private async probeDuration(data: Buffer): Promise<number | undefined> {
    try {
      return (await this.transcoder.probe(data)).durationSecs;
    } catch (error) {
      logger.debug('transcription: duration probe unavailable:', error);
      return undefined;
    }
  }

  /** Throws on API failures and on an empty answer; resolves to an ok outcome otherwise. */
  private async callModel(
    client: OpenAI,
    model: string,
    data: Buffer,
    format: AudioFormat,
    label: string,
    effort: string | undefined,
  ): Promise<TranscriptionOutcome> {
    const started = this.now();
    const raw = await completeMedia({
      client,
      model,
      feature: 'transcription',
      system: SYSTEM_PROMPT,
      // Gemini recommends the media part before the instruction.
      content: [
        { type: 'input_audio', input_audio: { data: data.toString('base64'), format } },
        { type: 'text', text: TRANSCRIBE_PROMPT },
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      reasoningEffort: effort,
    });
    const text = cleanTranscript(raw);
    if (text === undefined) throw new Error(`${model} returned an empty transcript`);
    logger.info(
      `transcription: ${label} via ${model} (${format}, ${data.byteLength} bytes) → ${text ? `${text.length} chars` : 'no speech'} in ${this.now() - started}ms`,
    );
    return { status: 'ok', text, cached: false };
  }
}
