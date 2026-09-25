// Every environment variable the bot reads, parsed in one place with one set of rules.
//
// Values are read lazily (getters) rather than once at import: tests set process.env per case, and
// prod never mutates it, so the cost is a few string reads per access and the behavior is identical
// either way. Parsing rules:
//   - booleans accept 1/0, true/false, yes/no, on/off (case-insensitive; surrounding whitespace and
//     quotes are ignored) — an unrecognized or blank value falls back to the default
//   - numbers must be finite (and within the stated bounds) or the default applies; "0" is a real value
//     where 0 is meaningful (TTLs) and out of bounds where it is not (intervals, limits)
//   - csv lists are trimmed and empty entries dropped
import process from 'node:process';

function raw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

export function envString(name: string): string | undefined {
  return raw(name);
}

export function envBool(name: string, fallback: boolean): boolean {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

export function envNumber(name: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (bounds.min !== undefined && parsed < bounds.min) return fallback;
  if (bounds.max !== undefined && parsed > bounds.max) return fallback;
  return parsed;
}

export function envInt(name: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const parsed = envNumber(name, fallback, bounds);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function envCsv(name: string): string[] {
  const value = raw(name);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v3.2:nitro';
export const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
export const DEFAULT_LEARNER_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';
// Opus over Qwen here because Qwen3-VL, despite being a strong generalist vision model, had no grasp of
// Twitch/meme-emote culture — it kept describing every Pepe variant as "green frog with wide eyes"
// regardless of whether it was monkaW, pepega, or FeelsGoodMan. Captions are one-shot per emoji and
// cached forever, so paying Opus rates here is pennies.
export const DEFAULT_EMOJI_CAPTION_MODEL = 'anthropic/claude-opus-4.7';
export const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
// Qwen3-Embedding's documented asymmetric-retrieval format: queries carry a task instruction,
// documents are embedded with no prefix at all. Getting this wrong silently costs retrieval quality.
export const DEFAULT_EMBEDDING_QUERY_INSTRUCTION =
  'Given a message from a Discord chat, retrieve stored memories about the people, preferences, events, and server culture that are relevant to it';

// Ordered fallback lists for the link embed fixers (see src/links/embedFixers.ts). The bot probes each
// one with Discord's crawler user agent and uses the first that actually serves an embed.
export const DEFAULT_TWITTER_FIXERS = ['fixvx.com', 'fxtwitter.com', 'vxtwitter.com'];
export const DEFAULT_INSTAGRAM_FIXERS = ['instagram7.com', 'uuinstagram.com', 'kkinstagram.com'];
export const DEFAULT_TIKTOK_FIXERS = ['tnktok.com', 'fixtiktok.com', 'tfxktok.com'];

export const DELETE_REPOST_MODES = ['edgy', 'always'] as const;
export type DeleteRepostMode = (typeof DELETE_REPOST_MODES)[number];

/** Parses CHANNEL_NOTES (see config.agent.channelNotes). Exported for tests. */
export function parseChannelNotes(raw: string | undefined): { notes: Record<string, string>; invalid: boolean } {
  if (raw === undefined) return { notes: {}, invalid: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { notes: {}, invalid: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { notes: {}, invalid: true };
  const notes: Record<string, string> = {};
  for (const [channelId, note] of Object.entries(parsed)) {
    if (typeof note === 'string' && note.trim().length > 0) notes[channelId.trim()] = note.trim();
  }
  return { notes, invalid: false };
}

export const config = {
  discord: {
    /** The bot token. Required in prod. */
    get token(): string | undefined {
      return envString('CLIENT_SECRET');
    },
  },

  openRouter: {
    /** Required for every AI feature (chat, embeddings, image generation, emoji captions, learner). */
    get apiKey(): string | undefined {
      return envString('OPENROUTER_API_KEY');
    },
  },

  models: {
    get chat(): string {
      return envString('CHAT_MODEL') ?? DEFAULT_CHAT_MODEL;
    },
    get image(): string {
      return envString('IMAGE_MODEL') ?? DEFAULT_IMAGE_MODEL;
    },
    get emojiCaption(): string {
      return envString('EMOJI_CAPTION_MODEL') ?? DEFAULT_EMOJI_CAPTION_MODEL;
    },
    get learner(): string {
      return envString('LEARNER_MODEL') ?? DEFAULT_LEARNER_MODEL;
    },
    get selfImprovement(): string {
      return envString('SELF_IMPROVEMENT_MODEL') ?? this.learner;
    },
    get embedding(): string {
      return envString('EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL;
    },
    /** Model that judges deleted messages (see deleteRepost). Defaults to the chat model. */
    get messageJudge(): string {
      return envString('DELETE_REPOST_MODEL') ?? this.chat;
    },
    /**
     * Chat models OpenRouter falls back to, in order, when the primary errors (down, rate-limited,
     * context too long, moderation). Empty ⇒ no fallback routing. The primary is never repeated here.
     */
    get chatFallbacks(): string[] {
      const primary = this.chat;
      return [...new Set(envCsv('CHAT_FALLBACK_MODELS'))].filter((model) => model !== primary);
    },
  },

  agent: {
    get conversationTimeoutMs(): number {
      return envInt('CONVERSATION_TIMEOUT_MS', 15 * MINUTE_MS, { min: 1 });
    },
    // Generous on purpose: these are runaway-loop backstops, not a budget a normal turn ever reaches.
    get maxToolRounds(): number {
      return envInt('MAX_TOOL_ROUNDS', 25, { min: 1 });
    },
    get maxToolInvocations(): number {
      return envInt('MAX_TOOL_INVOCATIONS', 200, { min: 1 });
    },
    /** The chat model's context window in tokens when OpenRouter's model list can't tell (offline, unknown id). */
    get chatContextTokens(): number {
      return envInt('CHAT_CONTEXT_TOKENS', 131_072, { min: 1024 });
    },
    /** Explicit in-window history budget (estimated tokens); unset ⇒ min(500k, half the chat model's context). */
    get historyTokenBudget(): number | undefined {
      const value = envInt('HISTORY_TOKEN_BUDGET', -1, { min: 1000 });
      return value > 0 ? value : undefined;
    },
    /**
     * CHANNEL_NOTES: a JSON object of channel id → short description shown to the chat model with the
     * channel's name and topic. Unset ⇒ no notes; not a JSON object ⇒ no notes and `invalid` set (the
     * agent logs it). Non-string values are ignored.
     */
    get channelNotes(): { notes: Record<string, string>; invalid: boolean } {
      return parseChannelNotes(envString('CHANNEL_NOTES'));
    },
  },

  learner: {
    get intervalMs(): number {
      return envInt('LEARNING_INTERVAL_MS', 30 * MINUTE_MS, { min: 1 });
    },
    get minMessages(): number {
      return envInt('MIN_MESSAGES_FOR_OBSERVATION', 5, { min: 1 });
    },
    get ignoredChannels(): string[] {
      return envCsv('LEARNER_IGNORE_CHANNELS');
    },
    get selfImprovementEnabled(): boolean {
      return envBool('SELF_IMPROVEMENT_ENABLED', true);
    },
  },

  emoji: {
    /** One-shot: clears every caption at startup so they get regenerated. Unset it again afterwards. */
    get forceRecaption(): boolean {
      return envBool('EMOJI_FORCE_RECAPTION', false);
    },
  },

  memory: {
    /** Kill switch: false ⇒ FTS5-only keyword retrieval, no embeddings API calls. */
    get semanticEnabled(): boolean {
      return envBool('SEMANTIC_MEMORY_ENABLED', true);
    },
    get relevanceThreshold(): number {
      return envNumber('MEMORY_RELEVANCE_THRESHOLD', 0.5, { min: 0, max: 1 });
    },
    get dedupThreshold(): number {
      return envNumber('MEMORY_DEDUP_THRESHOLD', 0.9, { min: 0, max: 1 });
    },
    get queryInstruction(): string {
      return envString('EMBEDDING_QUERY_INSTRUCTION') ?? DEFAULT_EMBEDDING_QUERY_INSTRUCTION;
    },
    get backfillIntervalMs(): number {
      return envInt('BACKFILL_INTERVAL_MS', 30 * MINUTE_MS, { min: 1 });
    },
    /** Hours before an `image` memory expires; 0 disables expiry. */
    get ttlImageHours(): number {
      return envNumber('MEMORY_TTL_IMAGE_HOURS', 24, { min: 0 });
    },
    /** Days before an `event` memory expires; 0 disables expiry. */
    get ttlEventDays(): number {
      return envNumber('MEMORY_TTL_EVENT_DAYS', 14, { min: 0 });
    },
  },

  debugCapture: {
    get enabled(): boolean {
      return envBool('DEBUG_CAPTURE', true);
    },
    get dir(): string {
      return envString('DEBUG_CAPTURE_DIR') ?? './data/debug';
    },
  },

  report: {
    /** Master switch for the digest and deploy announcements: unset ⇒ both off. */
    get channelId(): string | undefined {
      return envString('REPORT_CHANNEL_ID');
    },
    get digestEnabled(): boolean {
      return envBool('DIGEST_ENABLED', true);
    },
    get digestPeriodMs(): number {
      return envInt('DIGEST_PERIOD_MS', 7 * DAY_MS, { min: 1 });
    },
    get digestCheckIntervalMs(): number {
      return envInt('DIGEST_CHECK_INTERVAL_MS', HOUR_MS, { min: 1 });
    },
    get deployAnnounceEnabled(): boolean {
      return envBool('DEPLOY_ANNOUNCE_ENABLED', true);
    },
    /** Baked into the prod image by CI; unset ⇒ no deploy announcement. */
    get gitSha(): string | undefined {
      return envString('GIT_SHA');
    },
  },

  links: {
    get twitterFixers(): string[] {
      const fromEnv = envCsv('TWITTER_FIXERS');
      return fromEnv.length > 0 ? fromEnv : DEFAULT_TWITTER_FIXERS;
    },
    get instagramFixers(): string[] {
      const fromEnv = envCsv('INSTAGRAM_FIXERS');
      return fromEnv.length > 0 ? fromEnv : DEFAULT_INSTAGRAM_FIXERS;
    },
    get tiktokFixers(): string[] {
      const fromEnv = envCsv('TIKTOK_FIXERS');
      return fromEnv.length > 0 ? fromEnv : DEFAULT_TIKTOK_FIXERS;
    },
    /** When false, the first configured fixer is used blindly (no health probe). */
    get verify(): boolean {
      return envBool('LINK_FIX_VERIFY', true);
    },
    get timeoutMs(): number {
      return envInt('LINK_FIX_TIMEOUT_MS', 4000, { min: 100 });
    },
  },

  deleteRepost: {
    /** Discord user ids whose quickly-deleted messages get reposted. Empty ⇒ feature off. */
    get userIds(): string[] {
      return envCsv('DELETE_REPOST_USER_IDS');
    },
    /** A message only qualifies when it is deleted within this long after being posted. */
    get windowMs(): number {
      return envInt('DELETE_REPOST_WINDOW_MS', 2 * MINUTE_MS, { min: 1000 });
    },
    /** 'edgy' asks the judge model first; 'always' reposts every qualifying deletion. */
    get mode(): DeleteRepostMode {
      return envEnum('DELETE_REPOST_MODE', DELETE_REPOST_MODES, 'edgy');
    },
  },

  logging: {
    get debug(): boolean {
      return envBool('LOG_DEBUG', false);
    },
  },

  /** The server's layout, shared by every feature that posts on its own (reminders, birthdays, Wrapped, …). */
  server: {
    /** The channel the group actually talks in; proactive posts default here. Unset ⇒ proactive posts off. */
    get mainChannelId(): string | undefined {
      return envString('MAIN_CHANNEL_ID');
    },
  },

  // ---- Feature sections. Each feature adds its getters inside its own section only. ----

  /** Reminders and polls (src/scheduling/, src/ai/tools/reminders.ts). */
  reminders: {},

  /** Birthday announcements (src/scheduling/, src/ai/tools/birthdays.ts). */
  birthdays: {},

  /** Local message archive, search and Wrapped (src/archive/). */
  archive: {},

  /** Voice-message transcription and video understanding (src/ai/media/). */
  media: {},

  /** Reading shared links (src/ai/linkReader/). */
  linkReader: {},

  /** Replying without an explicit @-mention, judged by a decision model (src/gate/). */
  gate: {},

  /** Redirecting long rambles to their own channel (src/gate/). */
  ramble: {},

  /** The code-execution sidecar (sandbox/, src/ai/tools/sandbox.ts). */
  sandbox: {},

  /** Filing member feature requests as GitHub issues (src/ai/tools/featureRequest.ts). */
  featureRequests: {},

  /** OpenRouter usage/cost accounting (src/ai/usage.ts). */
  costs: {},

  /** Discord application commands: right-click message/user menu entries (src/commands/). */
  commands: {},

  /** True inside the Vitest runner — the structural test-hermeticity guard. */
  get isTest(): boolean {
    return Boolean(process.env.VITEST);
  },
};

/** One-line, secret-free summary of the effective configuration for the startup log. */
export function describeEffectiveConfig(): string {
  const parts = [
    `chat=${config.models.chat}`,
    `learner=${config.models.learner}`,
    `image=${config.models.image}`,
    `embedding=${config.models.embedding}`,
    `semantic=${config.memory.semanticEnabled}`,
    `debugCapture=${config.debugCapture.enabled}`,
    `reportChannel=${config.report.channelId ? 'set' : 'off'}`,
    `linkVerify=${config.links.verify}`,
    `deleteRepost=${config.deleteRepost.userIds.length > 0 ? `${config.deleteRepost.userIds.length} user(s), ${config.deleteRepost.mode}` : 'off'}`,
    `forceRecaption=${config.emoji.forceRecaption}`,
    `openRouterKey=${config.openRouter.apiKey ? 'set' : 'MISSING'}`,
  ];
  return parts.join(' ');
}
