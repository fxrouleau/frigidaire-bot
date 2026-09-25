// Media understanding: audio transcription (Discord voice messages, audio files) and video description
// (uploaded clips, videos behind shared links). These are the stable entry points the rest of the bot
// calls — the chat agent (through the media enricher), the learner, summaries, the link reader and the
// context-menu commands. The chat model itself never receives audio or video, only the text made here:
//   - voice / audio → Whisper Large V3 on the speech-to-text endpoint (transcriber.ts), while every
//     host serving it is verified zero-data-retention; otherwise a chat model with provider.zdr
//   - video → VIDEO_MODEL (Gemini) watching the picture and hearing the soundtrack in one call
//     (video.ts); long or huge clips → keyframes + the soundtrack's Whisper transcript
//   - YouTube → metadata only (link reader): no ZDR host can fetch it, and it's too big to upload
// Every chat-completions call carries provider.zdr; the STT endpoint is covered by the host check.
//
// Results are cached in bot.db (transcripts by message id, descriptions by URL), so whichever feature
// pays for a recording first, every later reader gets it for free.
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { getOpenRouterClient } from '../openRouterClient';
import { FfmpegTranscoder, type MediaTranscoder } from './transcoder';
import { AudioTranscriber } from './transcriber';
import type { AudioInput, VideoInput, VideoOutcome } from './types';
import { VideoDescriber } from './video';

export type { AudioInput, TranscriptionOutcome, VideoInput, VideoOutcome } from './types';

let transcoder: MediaTranscoder | undefined;
let transcriber: AudioTranscriber | undefined;
let describer: VideoDescriber | undefined;

// Under Vitest the shared instances never reach OpenRouter, even on a machine with a key exported:
// tests that render messages through the default enricher must stay hermetic.
function defaultClient(): OpenAI | undefined {
  return config.isTest ? undefined : getOpenRouterClient();
}

function sharedTranscoder(): MediaTranscoder {
  if (!transcoder) transcoder = new FfmpegTranscoder();
  return transcoder;
}

/** The process-wide transcriber (in-flight dedup and failure cooldowns are per instance). */
export function getAudioTranscriber(): AudioTranscriber {
  if (!transcriber) transcriber = new AudioTranscriber({ client: defaultClient, transcoder: sharedTranscoder() });
  return transcriber;
}

export function getVideoDescriber(): VideoDescriber {
  if (!describer) {
    describer = new VideoDescriber({
      client: defaultClient,
      transcoder: sharedTranscoder(),
      transcriber: getAudioTranscriber(),
    });
  }
  return describer;
}

/** Test-only: swaps the shared instances (undefined restores lazily built defaults). */
export function setMediaForTesting(opts?: { transcriber?: AudioTranscriber; describer?: VideoDescriber }): void {
  transcriber = opts?.transcriber;
  describer = opts?.describer;
}

const ROUTE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let routeCheckTimer: NodeJS.Timeout | undefined;

/**
 * Verifies the transcription route now and then daily: a speech-to-text TRANSCRIPTION_MODEL is only
 * used while every endpoint serving it is on OpenRouter's ZDR list (that endpoint ignores routing
 * preferences), and the verdict — or a WARN plus the chat-model fallback — lands in the log at startup
 * rather than on the first voice message. Idempotent; returns a stop function.
 */
export function startTranscriptionRouteChecks(intervalMs = ROUTE_CHECK_INTERVAL_MS): () => void {
  const check = () => {
    // Without a key nothing is transcribed, so there is no route to vouch for.
    if (!config.openRouter.apiKey) return;
    getAudioTranscriber()
      .route()
      .catch((error: unknown) => logger.warn('transcription: route check failed:', error));
  };
  if (!routeCheckTimer) {
    check();
    routeCheckTimer = setInterval(check, intervalMs);
    routeCheckTimer.unref();
  }
  return () => {
    if (routeCheckTimer) clearInterval(routeCheckTimer);
    routeCheckTimer = undefined;
  };
}

/**
 * Transcribes an audio file: the words in the language they were spoken (the chat-model fallback also
 * adds a final "English: …" line under non-English speech). '' when the recording holds no speech;
 * undefined when transcription is unavailable, the recording is over VOICE_MAX_SECONDS or 25 MB, or
 * the call failed.
 */
export async function transcribeAudio(input: AudioInput): Promise<string | undefined> {
  const outcome = await getAudioTranscriber().transcribe(input);
  return outcome.status === 'ok' ? outcome.text : undefined;
}

/** A previously produced transcript for a message ('' = no speech), without doing any paid work. */
export function getCachedTranscript(messageId: string): string | undefined {
  return getAudioTranscriber().cached(messageId);
}

/**
 * Describes a video (what happens, on-screen text, what's said) in a few compact lines. Undefined when
 * video understanding is unavailable, the file is over the download cap, or the call failed.
 */
export async function describeVideo(input: VideoInput): Promise<string | undefined> {
  const outcome = await getVideoDescriber().describe(input);
  return outcome.status === 'ok' ? outcome.text : undefined;
}

/**
 * describeVideo() with the full outcome, for callers that tell the chat model why nothing came back
 * (over today's VIDEO_DAILY_BUDGET_USD, too large, unavailable). With `input.question`, the clip is
 * watched to answer that question instead (cached per URL and question).
 */
export function watchVideo(input: VideoInput): Promise<VideoOutcome> {
  return getVideoDescriber().describe(input);
}

/** How a video outcome that isn't a description reads to the chat model (in the bot's own voice). */
export function videoOutcomeNote(outcome: Exclude<VideoOutcome, { status: 'ok' }>): string {
  switch (outcome.status) {
    case 'over_budget':
      return 'not watched: out of popcorn money for today, the daily video budget is spent';
    case 'too_large':
      return 'too large to watch';
    case 'unavailable':
      return 'video understanding is unavailable';
    default:
      return "couldn't watch it";
  }
}

/** A previously produced description for this URL, without doing any paid work. */
export function getCachedVideoDescription(url: string): string | undefined {
  return getVideoDescriber().cached(url);
}
