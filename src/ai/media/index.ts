// Media understanding: audio transcription (Discord voice messages, audio files) and video description
// (uploaded clips, videos behind shared links). These are the stable entry points the rest of the bot
// calls — the chat agent (through the media enricher), the learner, summaries, the link reader and the
// context-menu commands. Every call that reaches a model goes through OpenRouter with ZDR routing.
//
// Placeholder implementations: they report "no transcript / no description" until the media feature
// fills them in, so callers already handle the undefined case.

export type AudioInput = {
  url: string;
  contentType?: string | null;
  /** When set, the transcript is cached under this Discord message id (see getCachedTranscript). */
  messageId?: string;
  durationSecs?: number | null;
};

export type VideoInput = {
  url: string;
  contentType?: string | null;
  /** Optional hint for the model: who shared it, the accompanying message, the link's title. */
  context?: string;
};

/** Transcribes an audio file. Undefined when transcription is unavailable or failed. */
export async function transcribeAudio(_input: AudioInput): Promise<string | undefined> {
  return undefined;
}

/** A previously produced transcript for a message, without doing any paid work. */
export function getCachedTranscript(_messageId: string): string | undefined {
  return undefined;
}

/** Describes a video (visuals + speech). Undefined when video understanding is unavailable or failed. */
export async function describeVideo(_input: VideoInput): Promise<string | undefined> {
  return undefined;
}
