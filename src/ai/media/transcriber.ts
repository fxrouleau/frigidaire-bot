// Voice-message and audio-file transcription on OpenRouter, over one of two routes:
//
//   - stt  (default: openai/whisper-large-v3): the speech-to-text endpoint. Cheapest and purpose-built,
//          but it ignores provider routing, so it is only used while the model catalog confirms that
//          EVERY endpoint serving the model is zero-data-retention (checked at startup and daily; see
//          speechToText.ts). The transcript is what was said, in the language it was said.
//   - chat (TRANSCRIPTION_FALLBACK_MODEL, default Gemini 3.5 Flash-Lite, or TRANSCRIPTION_MODEL itself
//          when it is a chat model): an `input_audio` part to an audio-input chat model with
//          provider.zdr pinned per request. Same output as Whisper: what was said, in the language it
//          was said, with no translation line (the group reads French; the Translate command covers the rest).
//
// Pipeline: cache → duration guards (too long / under a second) → bounded download → send as-is when
// the route takes the format, otherwise (or when the provider refuses it) transcode to MP3 → store
// under the message id.
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import type { SafeFetch } from '../linkReader/safeFetch';
import { type EndpointCoverage, getModelCatalog, type ModelCatalog, type ModelInfo } from '../modelCatalog';
import { getOpenRouterClient } from '../openRouterClient';
import { downloadMedia, redact } from './download';
import { type AudioFormat, detectAudioFormat, nativeAudioFormats } from './formats';
import { completeMedia, describeError, isInputRejection } from './modelCall';
import { cleanSttTranscript, requestTranscription, STT_AUDIO_FORMATS } from './speechToText';
import { getStoredTranscript, mediaCacheKey, storeTranscript } from './store';
import type { MediaTranscoder } from './transcoder';
import type { AudioInput, TranscriptionOutcome } from './types';

/** Discord's own upload ceiling for free accounts is far below this; it bounds link-borne audio. */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
// Gemini caps a request with inline media at 20 MB in total, and base64 adds a third: anything bigger
// is re-encoded to compact MP3 first (10 minutes of speech ≈ 3.6 MB) instead of being sent as-is. The
// STT hosts accept more, but a smaller upload is also a faster one against their 60 s upstream timeout.
export const INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024;
/** Shorter recordings hold no transcribable speech — and are exactly where Whisper invents text. */
export const MIN_SPEECH_SECONDS = 1;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
// A failed recording is not retried on every chat turn that renders it; it gets another chance later.
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
// ~10 minutes of speech fits comfortably; reasoning models spend part of it thinking.
const MAX_OUTPUT_TOKENS = 8192;
const MAX_TRANSCRIPT_CHARS = 12_000;
const NO_SPEECH = '[no speech]';
// Recorded as the "model" of a transcript nobody had to compute.
const TOO_SHORT_MODEL = '(under a second)';

const SYSTEM_PROMPT = 'You are a speech-to-text engine. You output transcripts only, never commentary.';

const TRANSCRIBE_PROMPT = `Transcribe this recording.
- Write exactly what is said, in the language it is spoken. Keep slang, profanity, names and code-switching as spoken. Don't translate, summarize, correct or censor. Pure filler sounds (um, uh) may be dropped.
- When more than one person speaks, start each speaker's turn on a new line beginning with "- ".
- Mention non-speech sounds only when they matter, in brackets, e.g. [laughs].
- If there is no intelligible speech (silence, noise, music without words), output exactly: ${NO_SPEECH}
Output the transcript only: no preamble, no quotes, no timestamps, no notes.`;

/**
 * Normalizes a chat model's answer: strips wrappers models add despite instructions and maps the
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

/**
 * Name-based guess for when the catalog can't say whether a model is speech-to-text (metadata
 * unreachable): such a model can't be verified as ZDR, so the guess only ever routes AWAY from it.
 */
export function looksLikeSttModel(model: string): boolean {
  return /whisper|transcri|[-/]asr\b|[-/]stt\b|chirp|parakeet|nova-\d/i.test(model);
}

export type TranscriptionRoute =
  | { kind: 'stt'; model: string }
  | { kind: 'chat'; model: string; effort?: string }
  | { kind: 'off' };

export type AudioTranscriberOptions = {
  client?: () => OpenAI | undefined;
  fetch?: typeof globalThis.fetch;
  /** The guarded fetch for non-Discord URLs (default: the shared createSafeFetch()). */
  safeFetch?: SafeFetch;
  transcoder: MediaTranscoder;
  model?: () => string;
  fallbackModel?: () => string;
  maxSeconds?: () => number;
  now?: () => number;
  catalog?: Pick<ModelCatalog, 'info' | 'catalogInfo' | 'endpointCoverage'>;
};

function tooShort(durationSecs: number | undefined | null): boolean {
  return durationSecs !== undefined && durationSecs !== null && durationSecs > 0 && durationSecs < MIN_SPEECH_SECONDS;
}

const SILENT: TranscriptionOutcome = { status: 'ok', text: '', cached: false };

function hostList(endpoints: EndpointCoverage['endpoints']): string {
  return [...new Set(endpoints.map((e) => e.provider))].join(', ');
}

export class AudioTranscriber {
  private readonly client: () => OpenAI | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly safeFetch?: SafeFetch;
  private readonly transcoder: MediaTranscoder;
  private readonly model: () => string;
  private readonly fallbackModel: () => string;
  private readonly maxSeconds: () => number;
  private readonly now: () => number;
  private readonly catalog: Pick<ModelCatalog, 'info' | 'catalogInfo' | 'endpointCoverage'>;
  private readonly warnedModels = new Set<string>();
  // The last route verdict logged, so a daily re-check only speaks up when something changed.
  private lastRouteNote: string | undefined;
  // The auto-transcript reply and the chat agent often ask for the same voice message at once.
  private readonly inFlight = new Map<string, Promise<TranscriptionOutcome>>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(opts: AudioTranscriberOptions) {
    this.client = opts.client ?? getOpenRouterClient;
    this.fetchImpl = opts.fetch;
    this.safeFetch = opts.safeFetch;
    this.transcoder = opts.transcoder;
    this.model = opts.model ?? (() => config.media.transcriptionModel);
    this.fallbackModel = opts.fallbackModel ?? (() => config.media.transcriptionFallbackModel);
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
    if (tooShort(input.durationSecs)) {
      if (input.messageId) storeTranscript(key, '', TOO_SHORT_MODEL, this.now());
      return SILENT;
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
    const route = await this.route();
    if (route.kind === 'off') return { status: 'unavailable' };
    return this.transcribeData(client, route, data, format, undefined, label);
  }

  /**
   * Which route transcription takes right now. The configured model is used when it is a chat model
   * that hears audio, or a speech-to-text model whose every endpoint is on OpenRouter's ZDR list;
   * a speech-to-text model that can't be verified falls back to TRANSCRIPTION_FALLBACK_MODEL. Verdict
   * changes are logged (WARN for a fallback), so the startup and daily checks surface in the logs.
   */
  async route(): Promise<TranscriptionRoute> {
    const model = this.model();
    const chatInfo = await this.catalog.catalogInfo(model);
    if (chatInfo) return this.chatRoute(model, chatInfo);

    // Speech-to-text models aren't in the chat model list; their endpoints listing says what they are.
    const coverage = await this.catalog.endpointCoverage(model);
    const isStt = coverage?.found ? coverage.outputModalities.has('transcription') : looksLikeSttModel(model);
    if (!isStt) return this.chatRoute(model, undefined);

    if (coverage?.allZdr) {
      this.noteRoute(`stt ${model}`, () =>
        logger.info(
          `transcription: ${model} via the speech-to-text endpoint; every endpoint is zero-data-retention (${hostList(coverage.endpoints)})`,
        ),
      );
      return { kind: 'stt', model };
    }

    const fallback = this.fallbackModel();
    const why = !coverage
      ? "its hosts couldn't be checked against OpenRouter's ZDR list right now"
      : !coverage.found
        ? 'OpenRouter does not list it'
        : `not every host is zero-data-retention (not ZDR: ${hostList(coverage.endpoints.filter((e) => !e.zdr)) || 'no endpoints'})`;
    this.noteRoute(`fallback ${model} ${why}`, () =>
      logger.warn(
        `transcription: not using ${model}: ${why}. Transcribing with ${fallback} through chat completions (provider.zdr) instead.`,
      ),
    );
    return this.chatRoute(fallback, undefined);
  }

  private noteRoute(note: string, log: () => void): void {
    if (this.lastRouteNote === note) return;
    this.lastRouteNote = note;
    log();
  }

  /**
   * A chat model route, if the model can hear audio at all (a misconfigured model would otherwise fail
   * every voice message with an opaque routing error), with the lowest reasoning effort it accepts.
   */
  private async chatRoute(model: string, known: ModelInfo | undefined): Promise<TranscriptionRoute> {
    const info = known ?? (await this.catalog.catalogInfo(model));
    if (info && !info.inputModalities.has('audio')) {
      if (!this.warnedModels.has(model)) {
        this.warnedModels.add(model);
        logger.warn(`transcription: ${model} does not take audio input; transcription is off`);
      }
      return { kind: 'off' };
    }
    return { kind: 'chat', model, effort: (info ?? (await this.catalog.info(model))).lowestEffort };
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
    const route = await this.route();
    if (route.kind === 'off') return { status: 'unavailable' };

    const download = await downloadMedia(input.url, {
      maxBytes: AUDIO_MAX_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      fetch: this.fetchImpl,
      safeFetch: this.safeFetch,
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
      route,
      download.data,
      format,
      input.durationSecs ?? undefined,
      key,
    );

    if (outcome.status === 'ok' && input.messageId) {
      storeTranscript(key, outcome.text, route.model, this.now());
    } else if (outcome.status === 'failed') {
      this.setCooldown(key);
    }
    return outcome;
  }

  private async transcribeData(
    client: OpenAI,
    route: Exclude<TranscriptionRoute, { kind: 'off' }>,
    data: Buffer,
    format: AudioFormat | undefined,
    knownDurationSecs: number | undefined,
    label: string,
  ): Promise<TranscriptionOutcome> {
    const maxSeconds = this.maxSeconds();
    const fitsInline = data.byteLength <= INLINE_AUDIO_MAX_BYTES;
    const accepted = route.kind === 'stt' ? STT_AUDIO_FORMATS : nativeAudioFormats(route.model);
    const native = format !== undefined && accepted.has(format) && fitsInline;

    if (native && format) {
      if (knownDurationSecs === undefined) {
        const probed = await this.probeDuration(data);
        if (probed !== undefined && probed > maxSeconds) return { status: 'too_long', durationSecs: probed };
        if (tooShort(probed)) return SILENT;
      }
      try {
        return await this.call(client, route, data, format, label, { firstTry: true });
      } catch (error) {
        if (!isInputRejection(error)) {
          logger.warn(`transcription: ${route.model} failed on ${label}: ${describeError(error)}`);
          return { status: 'failed' };
        }
        logger.warn(
          `transcription: ${route.model} refused ${format} for ${label} (${describeError(error)}); retrying as MP3`,
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
          return await this.call(client, route, data, format, label, { firstTry: true });
        } catch (sendError) {
          logger.warn(`transcription: ${route.model} failed on ${label}: ${describeError(sendError)}`);
        }
      }
      return { status: 'failed' };
    }

    // A file without an audio track has nothing to say.
    if (!mp3) return SILENT;
    if (mp3.durationSecs !== undefined && mp3.durationSecs > maxSeconds) {
      return { status: 'too_long', durationSecs: mp3.durationSecs };
    }
    if (tooShort(mp3.durationSecs)) return SILENT;
    try {
      return await this.call(client, route, mp3.data, 'mp3', label, { firstTry: !native });
    } catch (error) {
      logger.warn(`transcription: ${route.model} failed on ${label} (as MP3): ${describeError(error)}`);
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
  private async call(
    client: OpenAI,
    route: Exclude<TranscriptionRoute, { kind: 'off' }>,
    data: Buffer,
    format: AudioFormat,
    label: string,
    opts: { firstTry: boolean },
  ): Promise<TranscriptionOutcome> {
    const started = this.now();
    let text: string | undefined;
    if (route.kind === 'stt') {
      // A retry after a refused request drops the optional verbose_json too: the safest request there is.
      const response = await requestTranscription({
        client,
        model: route.model,
        data,
        format,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        verbose: opts.firstTry,
      });
      text = cleanSttTranscript(response);
    } else {
      const raw = await completeMedia({
        client,
        model: route.model,
        feature: 'transcription',
        system: SYSTEM_PROMPT,
        // Gemini recommends the media part before the instruction.
        content: [
          { type: 'input_audio', input_audio: { data: data.toString('base64'), format } },
          { type: 'text', text: TRANSCRIBE_PROMPT },
        ],
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        reasoningEffort: route.effort,
      });
      text = cleanTranscript(raw);
    }
    if (text === undefined) throw new Error(`${route.model} returned an empty transcript`);
    logger.info(
      `transcription: ${label} via ${route.model} (${route.kind}, ${format}, ${data.byteLength} bytes) → ${text ? `${text.length} chars` : 'no speech'} in ${this.now() - started}ms`,
    );
    return { status: 'ok', text, cached: false };
  }
}
