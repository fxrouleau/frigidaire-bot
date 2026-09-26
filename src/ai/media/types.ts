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
  /**
   * A specific question to answer by watching the clip (a follow-up about a video someone shared),
   * instead of the general description. Answers are cached per (clip, question).
   */
  question?: string;
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
  /** VIDEO_DAILY_BUDGET_USD is spent for today (Eastern): nothing was downloaded or called. */
  | { status: 'over_budget' }
  | { status: 'unavailable' }
  | { status: 'failed' };
