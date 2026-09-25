import { FfmpegTranscoder, type MediaTranscoder } from './transcoder';
// Media understanding: audio transcription (Discord voice messages, audio files) and video description
// (uploaded clips, videos behind shared links). These are the stable entry points the rest of the bot
// calls — the chat agent (through the media enricher), the learner, summaries, the link reader and the
// context-menu commands. Every call that reaches a model goes through OpenRouter with ZDR routing.
//
// Results are cached in bot.db (transcripts by message id, descriptions by URL), so whichever feature
// pays for a recording first, every later reader gets it for free.
import { AudioTranscriber } from './transcriber';
import type { AudioInput, VideoInput } from './types';
import { VideoDescriber } from './video';

export type { AudioInput, TranscriptionOutcome, VideoInput, VideoOutcome } from './types';

let transcoder: MediaTranscoder | undefined;
let transcriber: AudioTranscriber | undefined;
let describer: VideoDescriber | undefined;

function sharedTranscoder(): MediaTranscoder {
  if (!transcoder) transcoder = new FfmpegTranscoder();
  return transcoder;
}

/** The process-wide transcriber (in-flight dedup and failure cooldowns are per instance). */
export function getAudioTranscriber(): AudioTranscriber {
  if (!transcriber) transcriber = new AudioTranscriber({ transcoder: sharedTranscoder() });
  return transcriber;
}

export function getVideoDescriber(): VideoDescriber {
  if (!describer) {
    describer = new VideoDescriber({ transcoder: sharedTranscoder(), transcriber: getAudioTranscriber() });
  }
  return describer;
}

/** Test-only: swaps the shared instances (undefined restores lazily built defaults). */
export function setMediaForTesting(opts?: { transcriber?: AudioTranscriber; describer?: VideoDescriber }): void {
  transcriber = opts?.transcriber;
  describer = opts?.describer;
}

/**
 * Transcribes an audio file: the words in the language they were spoken, plus a final "English: …"
 * line when that wasn't English. '' when the recording holds no speech; undefined when transcription
 * is unavailable, the recording is over VOICE_MAX_SECONDS or 25 MB, or the call failed.
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

/** A previously produced description for this URL, without doing any paid work. */
export function getCachedVideoDescription(url: string): string | undefined {
  return getVideoDescriber().cached(url);
}
