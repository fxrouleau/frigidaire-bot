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
  /** When already known (e.g. from the link's metadata), spares a probe. */
  durationSecs?: number | null;
};

/**
 * What a transcription attempt produced. `text` is '' when the recording was heard and held no speech
 * (silence, noise, music without words).
 */
export type TranscriptionOutcome =
  | { status: 'ok'; text: string; cached: boolean }
  | { status: 'too_long'; durationSecs: number }
  | { status: 'too_large' }
  | { status: 'unavailable' }
  | { status: 'failed' };

export type VideoOutcome =
  | { status: 'ok'; text: string; cached: boolean }
  | { status: 'too_large' }
  | { status: 'unavailable' }
  | { status: 'failed' };
