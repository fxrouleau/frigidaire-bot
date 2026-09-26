// OpenRouter's speech-to-text endpoint (POST /audio/transcriptions) — Whisper Large V3 by default.
//
// Why a dedicated STT model instead of a chat model hearing the audio: Whisper is built for exactly
// this, costs less than half as much (≈$0.00045 per minute on DeepInfra vs ≈$0.001 for Gemini
// Flash-Lite), and returns what was said in the language it was said, with nothing else to parse.
//
// ZDR: this endpoint does NOT apply provider routing preferences (OpenRouter's STT docs), so
// `provider: { zdr: true }` can't pin a zero-data-retention host per request the way every chat call
// does. Privacy therefore rests on the model choice: the transcriber only uses this path after the
// model catalog has confirmed that EVERY endpoint serving the model is on OpenRouter's ZDR list
// (ModelCatalog.endpointCoverage); otherwise it falls back to a chat model with provider.zdr.
//
// Whisper's known failure mode is inventing text over silence or noise — usually the subtitle credits
// and YouTube outros it saw in training ("Sous-titres réalisés par la communauté d'Amara.org",
// "Thanks for watching!"). The response is requested as verbose_json so each segment's
// no_speech_prob / avg_logprob can be checked (Whisper's own skip rule), and a phrase list catches
// the credits on hosts that don't report those scores.
import type OpenAI from 'openai';
import { featureRequestOptions } from '../usage';
import type { AudioFormat } from './formats';

/**
 * Formats sent to the STT endpoint without transcoding: the ones OpenRouter documents for
 * `input_audio.format` that every Whisper Large V3 host takes (DeepInfra, Together and Groq all list
 * flac/mp3/m4a/ogg/wav/webm, checked 2026-09-25) — so a Discord voice message (Ogg/Opus) goes as-is.
 */
export const STT_AUDIO_FORMATS: ReadonlySet<AudioFormat> = new Set(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm']);

const MAX_TRANSCRIPT_CHARS = 12_000;

export type SttSegment = {
  text?: unknown;
  no_speech_prob?: unknown;
  avg_logprob?: unknown;
};

/** The endpoint's JSON answer (verbose_json adds language/duration/segments; `usage` is always there). */
export type SttResponse = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
  usage?: { seconds?: unknown; cost?: unknown };
};

export type SttRequest = {
  client: OpenAI;
  model: string;
  data: Buffer;
  format: AudioFormat;
  timeoutMs: number;
  /** Ask for per-segment scores (the default). The plain `json` form is the fallback for hosts that refuse it. */
  verbose?: boolean;
};

/**
 * One transcription request through the shared OpenRouter client, tagged 'transcription' so the usage
 * ledger books it (the response's `usage.cost` is the call's USD cost; there is no `model` field, so the
 * ledger takes the model from the request). Throws the SDK's APIError on HTTP failures.
 */
export async function requestTranscription(req: SttRequest): Promise<SttResponse> {
  const verbose = req.verbose ?? true;
  return req.client.post<SttResponse>('/audio/transcriptions', {
    body: {
      model: req.model,
      input_audio: { data: req.data.toString('base64'), format: req.format },
      // No `language`: the group code-switches between French and English, and Whisper's detection
      // handles that better than a fixed hint. No `provider`: routing is ignored here (see above).
      ...(verbose ? { response_format: 'verbose_json', timestamp_granularities: ['segment'] } : {}),
    },
    ...featureRequestOptions('transcription'),
    timeout: req.timeoutMs,
    maxRetries: 1,
  });
}

// ---- Hallucination filtering ----

/** Lowercased, accent-preserving, apostrophes unified, outer punctuation and extra spaces removed. */
export function normalizePhrase(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'«»“”.,!?¡¿…:;♪-]+|[\s"'«»“”.,!?¡¿…:;♪-]+$/g, '');
}

// Subtitle credits and channel outros Whisper produces over silence, music or noise. Nobody says these
// in a voice message, so a segment (or sentence) matching one is dropped wherever it appears.
const CREDIT_PATTERNS: RegExp[] = [
  /amara\.org/,
  /^sous-titr/, // "Sous-titres réalisés par …", "Sous-titrage ST' 501", "Sous-titrage Société Radio-Canada"
  /^(subtitles|captions|subtitling|transcription) (by|provided by|made by|created by)\b/,
  /^untertitel (der|im auftrag|von)\b/,
  /^subt[ií]tulos (realizados |hechos )?por\b/,
  /^sottotitoli (creati |a cura )?(dalla|di)\b/,
  /^legendas? (pela|por)\b/,
  /ご視聴ありがとうございました/,
  /^продолжение следует/,
  /字幕/,
];

const OUTRO_PHRASES = new Set(
  [
    'thanks for watching',
    'thank you for watching',
    'thank you so much for watching',
    'thanks for watching and see you next time',
    'thank you for watching and see you next time',
    'please subscribe',
    'please like and subscribe',
    'like and subscribe',
    "don't forget to like and subscribe",
    'subscribe to my channel',
    'see you in the next video',
    "merci d'avoir regardé",
    "merci d'avoir regardé cette vidéo",
    "merci d'avoir regardé la vidéo",
    'abonnez-vous',
    "n'oubliez pas de vous abonner",
    "n'oubliez pas de vous abonner à la chaîne",
  ].map(normalizePhrase),
);

// Short fillers Whisper emits over silence ("you", "Thank you.") that are also things people really
// say — dropped only when the host's own score says the segment is probably not speech.
const SILENCE_FILLERS = new Set(
  ['you', 'thank you', 'thanks', 'bye', 'merci', 'merci beaucoup', 'okay'].map(normalizePhrase),
);
const FILLER_NO_SPEECH_PROB = 0.5;

/** True for a subtitle credit or a channel outro (whole segment/sentence). */
export function isHallucinatedPhrase(text: string): boolean {
  const phrase = normalizePhrase(text);
  if (!phrase) return false;
  return OUTRO_PHRASES.has(phrase) || CREDIT_PATTERNS.some((pattern) => pattern.test(phrase));
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Whisper's own rule for skipping a segment as silence (openai/whisper transcribe(): no_speech_threshold
 * 0.6 unless avg_logprob beats logprob_threshold -1.0), plus the silence fillers above.
 */
function isSilentSegment(segment: SttSegment, text: string): boolean {
  const noSpeech = finite(segment.no_speech_prob);
  if (noSpeech === undefined) return false;
  const logprob = finite(segment.avg_logprob);
  if (noSpeech > 0.6 && (logprob === undefined || logprob <= -1)) return true;
  return noSpeech > FILLER_NO_SPEECH_PROB && SILENCE_FILLERS.has(normalizePhrase(text));
}

/** Splits plain text into sentences (keeping their punctuation) for phrase filtering. */
function sentences(text: string): string[] {
  return text.match(/[^.!?…。]+[.!?…。]*/g) ?? [text];
}

function capped(text: string): string {
  return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…` : text;
}

/**
 * The transcript worth keeping from an STT response: '' when nothing but silence artifacts is left,
 * undefined when the response carries no text at all (a failure, never cached as silence).
 */
export function cleanSttTranscript(response: SttResponse): string | undefined {
  const segments = Array.isArray(response.segments) ? (response.segments as SttSegment[]) : undefined;
  if (segments && segments.length > 0) {
    const kept = segments
      .map((segment) => ({ segment, text: typeof segment.text === 'string' ? segment.text.trim() : '' }))
      .filter(({ segment, text }) => text && !isSilentSegment(segment, text) && !isHallucinatedPhrase(text))
      .map(({ text }) => text);
    return capped(kept.join(' ').replace(/\s+/g, ' ').trim());
  }

  if (typeof response.text !== 'string') return undefined;
  const kept = sentences(response.text).filter((sentence) => !isHallucinatedPhrase(sentence));
  return capped(kept.join('').replace(/\s+/g, ' ').trim());
}
