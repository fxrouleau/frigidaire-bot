// Media enricher: turns voice messages / audio / video attachments into model-visible text.
//
//   [voice message from Remi, 0:42: <transcript>]
//   [video msg:<message id>: <description>]
//
// The message id on a video line is the handle the chat model passes to watch_video to ask a follow-up
// question about that clip.
//
// The triggering message and the one it replies to ('current' / 'reference') may be transcribed or
// watched on the spot; seeded history only reads what is already cached, so a 25-message backfill never
// turns into 25 paid calls. A recording the bot couldn't (or didn't) process still leaves a marker, so the
// model knows something was said rather than seeing an empty message.
import type { Attachment, Message } from 'discord.js';
import type { ContentEnricher, EnrichmentRole } from '../enrichers';
import type { NormalizedContentPart } from '../types';
import { getAudioTranscriber, getVideoDescriber, videoOutcomeNote } from './index';
import type { AudioInput, TranscriptionOutcome, VideoInput, VideoOutcome } from './types';
import { audioAttachments, formatClock, isVoiceMessage, speakerName, transcriptKey, videoAttachments } from './voice';

// Bounds on paid work per message: nobody posts ten voice notes at once on purpose.
const MAX_AUDIO_PER_MESSAGE = 3;
const MAX_VIDEOS_PER_MESSAGE = 2;
const MAX_CONTEXT_CHARS = 200;

export type MediaEnricherDeps = {
  transcribe: (input: AudioInput) => Promise<TranscriptionOutcome>;
  cachedTranscript: (key: string) => string | undefined;
  describe: (input: VideoInput) => Promise<VideoOutcome>;
  cachedDescription: (url: string) => string | undefined;
};

const defaultDeps: MediaEnricherDeps = {
  transcribe: (input) => getAudioTranscriber().transcribe(input),
  cachedTranscript: (key) => getAudioTranscriber().cached(key),
  describe: (input) => getVideoDescriber().describe(input),
  cachedDescription: (url) => getVideoDescriber().cached(url),
};

function audioLabel(message: Message, attachment: Attachment, speaker: string): string {
  const kind = isVoiceMessage(message) ? 'voice message' : `audio file "${attachment.name}"`;
  const duration = attachment.duration ? `, ${formatClock(attachment.duration)}` : '';
  return `${kind} from ${speaker}${duration}`;
}

async function renderAudio(
  deps: MediaEnricherDeps,
  message: Message,
  attachment: Attachment,
  index: number,
  role: EnrichmentRole,
  speaker: string,
): Promise<string> {
  const label = audioLabel(message, attachment, speaker);
  const key = transcriptKey(message.id, attachment.id, index);

  let outcome: TranscriptionOutcome;
  if (role === 'history') {
    const cached = deps.cachedTranscript(key);
    if (cached === undefined) return `[${label} — not transcribed]`;
    outcome = { status: 'ok', text: cached, cached: true };
  } else {
    outcome = await deps.transcribe({
      url: attachment.url,
      contentType: attachment.contentType,
      messageId: key,
      durationSecs: attachment.duration,
    });
  }

  switch (outcome.status) {
    case 'ok':
      return outcome.text ? `[${label}: ${outcome.text}]` : `[${label}: (no speech)]`;
    case 'too_long':
      return `[${label} — too long to transcribe]`;
    case 'too_large':
      return `[${label} — too large to transcribe]`;
    default:
      return `[${label} — couldn't transcribe it]`;
  }
}

function videoContext(message: Message, speaker: string): string {
  const text = message.content?.trim();
  if (!text) return `Posted by ${speaker}.`;
  const capped = text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text;
  return `Posted by ${speaker} with the message: ${capped}`;
}

async function renderVideo(
  deps: MediaEnricherDeps,
  message: Message,
  attachment: Attachment,
  role: EnrichmentRole,
  speaker: string,
): Promise<string> {
  const head = `video msg:${message.id}`;
  let outcome: VideoOutcome;
  if (role === 'history') {
    const cached = deps.cachedDescription(attachment.url);
    if (cached === undefined) return `[${head}: ${attachment.name} (not watched)]`;
    outcome = { status: 'ok', text: cached, cached: true };
  } else {
    outcome = await deps.describe({
      url: attachment.url,
      contentType: attachment.contentType,
      context: videoContext(message, speaker),
      durationSecs: attachment.duration,
    });
  }

  if (outcome.status === 'ok') return `[${head}: ${outcome.text}]`;
  return `[${head}: ${attachment.name} (${videoOutcomeNote(outcome)})]`;
}

export function createMediaEnricher(deps: MediaEnricherDeps = defaultDeps): ContentEnricher {
  return {
    name: 'media',
    async enrich(message: Message, role: EnrichmentRole): Promise<NormalizedContentPart[]> {
      const audio = audioAttachments(message).slice(0, MAX_AUDIO_PER_MESSAGE);
      const video = videoAttachments(message).slice(0, MAX_VIDEOS_PER_MESSAGE);
      if (audio.length === 0 && video.length === 0) return [];

      const speaker = speakerName(message);
      const lines = await Promise.all([
        ...audio.map((attachment, index) => renderAudio(deps, message, attachment, index, role, speaker)),
        ...video.map((attachment) => renderVideo(deps, message, attachment, role, speaker)),
      ]);
      return lines.map((text) => ({ type: 'text', text }));
    },
  };
}

export const mediaEnricher: ContentEnricher = createMediaEnricher();
