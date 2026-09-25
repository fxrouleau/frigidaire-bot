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

// Code defaults match prod. GLM-5.3-Flash reads text, images and video (members post memes, custom emojis
// and screenshots constantly, so a text-only default like the old deepseek/deepseek-v3.2 broke every image
// turn), has a 1.31M-token context, and costs $0.045/M in, $0.14/M out; most of its OpenRouter hosts are
// zero-data-retention. The learner reads the same images, so it shares the model.
export const DEFAULT_CHAT_MODEL = 'z-ai/glm-5.3-flash';
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image';
export const DEFAULT_LEARNER_MODEL = 'z-ai/glm-5.3-flash';
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
// Probed 2026-09 with Discord's crawler UA: vxreddit.com served embeds; rxddit.com answered 502
// "Forbidden." (Reddit blocking its worker) but is the most popular instance and kept as the fallback.
export const DEFAULT_REDDIT_FIXERS = ['vxreddit.com', 'rxddit.com'];
// fxbsky.app (FxEmbed) first: it answers a missing post with a clean "doesn't exist" page instead of a
// 5xx, so a deleted post never counts against its health. bskx.app (VixBluesky) and xbsky.app follow.
export const DEFAULT_BLUESKY_FIXERS = ['fxbsky.app', 'bskx.app', 'xbsky.app'];
export const DEFAULT_TWITTER_TRANSLATE_TO = 'en';

// Persona eval judge: a frontier reasoning model with ZDR endpoints (Google Vertex / AI Studio) that
// OpenRouter does not run through its moderation layer — Anthropic/OpenAI endpoints are moderated,
// and the transcripts being graded are roasts and dark banter. A different family from the default
// chat model also avoids a judge grading its own style.
export const DEFAULT_EVAL_JUDGE_MODEL = 'google/gemini-3.1-pro-preview';

// Env variables that hold channel ids, by name (see config.logging.channelVariables).
const CHANNEL_VARIABLE_NAME = /(?:^|_)(?:CHANNEL_IDS?|CHANNELS)$|^CHANNEL_NOTES$/;

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

const SNOWFLAKE = /^\d{15,21}$/;

/** Parses `sideId:mainId` pairs into side → main. Malformed entries and self-links are dropped. */
export function parseLinkedAccounts(entries: string[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const entry of entries) {
    const [side, main, ...rest] = entry.split(':').map((part) => part.trim());
    if (rest.length > 0 || !side || !main || side === main) continue;
    if (!SNOWFLAKE.test(side) || !SNOWFLAKE.test(main)) continue;
    links.set(side, main);
  }
  return links;
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
    /**
     * Per-attempt timeout of every call through the shared client. The SDK default is 10 minutes, and
     * chat turns are serialized per channel, so one hung call would stall the bot in that channel.
     */
    get timeoutMs(): number {
      return envInt('OPENROUTER_TIMEOUT_MS', 2 * MINUTE_MS, { min: 1000, max: 30 * MINUTE_MS });
    },
    /** SDK retries on connection errors, timeouts, 408/409/429 and 5xx (exponential backoff). */
    get maxRetries(): number {
      return envInt('OPENROUTER_MAX_RETRIES', 2, { min: 0, max: 10 });
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
    /** Weekly job that rewrites each caption's "for …" half from how the group actually uses the emoji. */
    get usageCaptionsEnabled(): boolean {
      return envBool('EMOJI_USAGE_CAPTIONS_ENABLED', true);
    },
    /** One-shot: re-ground every eligible caption from usage at startup. Unset it again afterwards. */
    get recaptionFromUsage(): boolean {
      return envBool('EMOJI_RECAPTION_FROM_USAGE', false);
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
    get redditFixers(): string[] {
      const fromEnv = envCsv('REDDIT_FIXERS');
      return fromEnv.length > 0 ? fromEnv : DEFAULT_REDDIT_FIXERS;
    },
    get blueskyFixers(): string[] {
      const fromEnv = envCsv('BLUESKY_FIXERS');
      return fromEnv.length > 0 ? fromEnv : DEFAULT_BLUESKY_FIXERS;
    },
    /** When false, the first configured fixer is used blindly (no health probe). */
    get verify(): boolean {
      return envBool('LINK_FIX_VERIFY', true);
    },
    get timeoutMs(): number {
      return envInt('LINK_FIX_TIMEOUT_MS', 4000, { min: 100 });
    },
    /**
     * Total bytes of attachments a link-fix repost may carry over (downloaded, then re-uploaded through
     * the webhook). A message whose attachments exceed it is left untouched. 0 ⇒ only attachment-free
     * messages are reposted.
     */
    get maxRepostAttachmentBytes(): number {
      return envInt('LINK_REPOST_MAX_ATTACHMENT_BYTES', 10 * 1024 * 1024, { min: 0 });
    },
    /**
     * Language foreign tweets are translated into (a code appended to the fixer URL). Unset ⇒ English;
     * set but blank, or off/none/false/0 ⇒ translation disabled; anything that isn't a language code ⇒
     * the English default.
     */
    get twitterTranslateTo(): string | undefined {
      if (process.env.TWITTER_TRANSLATE_TO === undefined) return DEFAULT_TWITTER_TRANSLATE_TO;
      const value = envString('TWITTER_TRANSLATE_TO')?.toLowerCase();
      if (value === undefined || ['off', 'none', 'false', 'no', '0'].includes(value)) return undefined;
      return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(value) ? value : DEFAULT_TWITTER_TRANSLATE_TO;
    },
    /** Report-channel alerts when every fixer of a platform is down (and when one recovers). */
    get alertsEnabled(): boolean {
      return envBool('LINK_FIX_ALERTS', true);
    },
    /** Minimum time between two alerts for the same platform, so a flapping fixer can't spam. */
    get alertMinIntervalMs(): number {
      return envInt('LINK_FIX_ALERT_MIN_INTERVAL_MS', 6 * HOUR_MS, { min: 1 });
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
    /**
     * The size-rotated log file in the data volume (src/logFile.ts), so logs survive the container being
     * recreated on every deploy. `off` (or false/0/no/none) disables it. Never written under Vitest.
     */
    get file(): string | undefined {
      const value = envString('LOG_FILE');
      if (value !== undefined && ['off', 'false', '0', 'no', 'none'].includes(value.toLowerCase())) return undefined;
      return value ?? './data/logs/bot.log';
    },
    /** Rotate once the current file would pass this size. */
    get fileMaxBytes(): number {
      return envInt('LOG_FILE_MAX_BYTES', 5 * 1024 * 1024, { min: 64 * 1024, max: 1024 * 1024 * 1024 });
    },
    /** Files kept in total, the current one included (bot.log, bot.log.1, bot.log.2). */
    get fileMaxFiles(): number {
      return envInt('LOG_FILE_MAX_FILES', 3, { min: 1, max: 20 });
    },
    /**
     * Every set variable that names Discord channels, found by naming convention rather than a list
     * (…_CHANNEL_ID, …_CHANNEL_IDS, …_CHANNELS, CHANNEL_NOTES), so a channel variable added later shows
     * up in the startup channel report (src/channelEnv.ts) without touching it. Sorted by name.
     */
    get channelVariables(): Array<{ name: string; value: string }> {
      return Object.keys(process.env)
        .filter((name) => CHANNEL_VARIABLE_NAME.test(name))
        .sort()
        .flatMap((name) => {
          const value = envString(name);
          return value === undefined ? [] : [{ name, value }];
        });
    },
  },

  /** The server's layout, shared by every feature that posts on its own (reminders, birthdays, Wrapped, …). */
  server: {
    /** The channel the group actually talks in; proactive posts default here. Unset ⇒ proactive posts off. */
    get mainChannelId(): string | undefined {
      return envString('MAIN_CHANNEL_ID');
    },
    /**
     * Side accounts that belong to the same person as a main account, as `sideId:mainId` pairs
     * (LINKED_ACCOUNTS, csv). Malformed pairs and self-links are ignored. See src/linkedAccounts.ts.
     */
    get linkedAccounts(): Map<string, string> {
      return parseLinkedAccounts(envCsv('LINKED_ACCOUNTS'));
    },
  },

  // ---- Feature sections. Each feature adds its getters inside its own section only. ----

  /** Reminders and polls (src/scheduling/, src/ai/tools/reminders.ts). */
  reminders: {
    /** Pending reminders one member may have set at once (a runaway tool loop can't flood the table). */
    get maxPerUser(): number {
      return envInt('REMINDERS_MAX_PER_USER', 25, { min: 1, max: 1000 });
    },
  },

  /** Birthday announcements (src/scheduling/, src/ai/tools/birthdays.ts). */
  birthdays: {
    /** Where birthday announcements go; defaults to MAIN_CHANNEL_ID. Unset (both) ⇒ announcements off. */
    get channelId(): string | undefined {
      return envString('BIRTHDAY_CHANNEL_ID') ?? config.server.mainChannelId;
    },
    /** Kill switch for the announcements alone; the birthday tools keep working either way. */
    get announceEnabled(): boolean {
      return envBool('BIRTHDAY_ANNOUNCE_ENABLED', true);
    },
    /** Eastern hour (0–23) from which the day's birthdays are announced: afternoon, not midnight. */
    get announceHour(): number {
      return envInt('BIRTHDAY_ANNOUNCE_HOUR', 15, { min: 0, max: 23 });
    },
    /** `userId:MM-DD` / `userId:YYYY-MM-DD` entries applied at startup for users without a birthday yet. */
    get seed(): string[] {
      return envCsv('BIRTHDAYS_SEED');
    },
  },

  /** Local message archive, search and Wrapped (src/archive/). */
  archive: {
    /** Master switch: false ⇒ no ingest, no backfill, no search tools, no Wrapped. */
    get enabled(): boolean {
      return envBool('ARCHIVE_ENABLED', true);
    },
    /** Channel ids never archived, searched or counted (a parent channel id covers its threads). */
    get ignoredChannels(): string[] {
      return envCsv('ARCHIVE_IGNORE_CHANNELS');
    },
    /** false ⇒ neither the history backfill nor the after-downtime gap fill runs (live ingest still does). */
    get backfillEnabled(): boolean {
      return envBool('ARCHIVE_BACKFILL_ENABLED', true);
    },
    /** Channels whose full history is imported. Defaults to the main channel; unset both ⇒ none. */
    get backfillChannels(): string[] {
      const fromEnv = envCsv('ARCHIVE_BACKFILL_CHANNELS');
      if (fromEnv.length > 0) return fromEnv;
      const main = envString('MAIN_CHANNEL_ID');
      return main ? [main] : [];
    },
    /** Pause between history requests. discord.js already obeys 429s; this keeps the import polite. */
    get backfillDelayMs(): number {
      return envInt('ARCHIVE_BACKFILL_DELAY_MS', 1100, { min: 0, max: 60_000 });
    },
    get wrappedEnabled(): boolean {
      return envBool('WRAPPED_ENABLED', true);
    },
    /**
     * Where the yearly Wrapped post goes. Defaults to the report channel (the owner looks at it there
     * first), never the main channel on its own; unset both ⇒ Wrapped off.
     */
    get wrappedChannelId(): string | undefined {
      return envString('WRAPPED_CHANNEL_ID') ?? config.report.channelId;
    },
    /** One roast-y intro line from the chat model on top of the deterministic stats. */
    get wrappedLlmIntro(): boolean {
      return envBool('WRAPPED_LLM_INTRO', true);
    },
  },

  /** Voice-message transcription and video understanding (src/ai/media/). */
  media: {
    // Voice goes to Whisper Large V3 through OpenRouter's speech-to-text endpoint: ≈$0.00045 per minute
    // (DeepInfra) and every host serving it is zero-data-retention — which is checked at startup and
    // daily, because that endpoint ignores provider routing (src/ai/media/speechToText.ts). Video goes
    // to Gemini 3.5 Flash-Lite, which watches the picture and hears the soundtrack in one call (~100
    // tokens per second) on Google Vertex endpoints that are all ZDR and take base64 video.
    /**
     * Transcribes voice messages and audio files: a speech-to-text model (served by /audio/transcriptions;
     * every endpoint must be ZDR, or TRANSCRIPTION_FALLBACK_MODEL is used) or an audio-input chat model.
     */
    get transcriptionModel(): string {
      return envString('TRANSCRIPTION_MODEL') ?? 'openai/whisper-large-v3';
    },
    /**
     * Audio-input chat model (called with provider.zdr) used when TRANSCRIPTION_MODEL is a speech-to-text
     * model that can't be verified as zero-data-retention on every host.
     */
    get transcriptionFallbackModel(): string {
      return envString('TRANSCRIPTION_FALLBACK_MODEL') ?? 'google/gemini-3.5-flash-lite';
    },
    /** Model that describes videos: sent the clip itself, or keyframes + transcript (see videoInputMode). */
    get videoModel(): string {
      return envString('VIDEO_MODEL') ?? 'google/gemini-3.5-flash-lite';
    },
    /** Reply to members' voice messages with a transcript. */
    get voiceAutoTranscribe(): boolean {
      return envBool('VOICE_AUTO_TRANSCRIBE', true);
    },
    /** Channel ids (a thread matches through its parent) where auto-transcripts are posted; empty ⇒ all. */
    get voiceTranscribeChannels(): string[] {
      return envCsv('VOICE_TRANSCRIBE_CHANNELS');
    },
    /** Longer recordings are not transcribed at all (cost and latency guard). */
    get voiceMaxSeconds(): number {
      return envInt('VOICE_MAX_SECONDS', 600, { min: 1 });
    },
    /**
     * Largest clip sent to the video model as-is; bigger ones go through keyframe sampling. Gemini caps a
     * request with inline media at 20 MB and base64 adds a third, hence 14 MB.
     */
    get videoMaxBytes(): number {
      return envInt('VIDEO_MAX_BYTES', 14 * 1024 * 1024, { min: 1024 });
    },
    /** Longest clip sent to the video model as-is; longer ones go through keyframe sampling. */
    get videoMaxSeconds(): number {
      return envInt('VIDEO_MAX_SECONDS', 300, { min: 1 });
    },
    /**
     * 'auto' sends whole clips to models whose OpenRouter catalog entry lists video input and keyframes to
     * anything else; 'native' / 'frames' force one path.
     */
    get videoInputMode(): 'auto' | 'native' | 'frames' {
      return envEnum('VIDEO_INPUT_MODE', ['auto', 'native', 'frames'] as const, 'auto');
    },
    /**
     * Most the video model may spend per Eastern calendar day (USD, from the usage ledger's 'video' rows);
     * past it, clips aren't watched until midnight ET. 0 = unlimited. Transcription is not counted.
     */
    get videoDailyBudgetUsd(): number {
      return envNumber('VIDEO_DAILY_BUDGET_USD', 0.5, { min: 0 });
    },
  },

  /** Reading shared links (src/ai/linkReader/). */
  linkReader: {
    /** Master switch: false ⇒ no read_link tool and no link previews. */
    get enabled(): boolean {
      return envBool('LINK_READER_ENABLED', true);
    },
    /** Automatic previews of links in the message being answered (and the one it replies to). */
    get previewsEnabled(): boolean {
      return envBool('LINK_PREVIEWS_ENABLED', true);
    },
    /** Per-request timeout for every fetch the link reader makes. */
    get timeoutMs(): number {
      return envInt('LINK_READER_TIMEOUT_MS', 8000, { min: 500, max: 60_000 });
    },
    /** Body cap for fetched pages (bytes after decompression); longer pages are read up to the cap. */
    get maxPageBytes(): number {
      return envInt('LINK_READER_MAX_BYTES', 2 * 1024 * 1024, { min: 64 * 1024, max: 16 * 1024 * 1024 });
    },
    /** Longest linked video (seconds) that read_link hands to video understanding; 0 disables it. */
    get videoMaxSeconds(): number {
      return envInt('LINK_READER_VIDEO_MAX_SECS', 300, { min: 0, max: 3600 });
    },
  },

  /** Replying without an explicit @-mention, judged by a decision model (src/gate/). */
  gate: {
    get enabled(): boolean {
      return envBool('GATE_ENABLED', true);
    },
    /** Channels where the bot may answer unprompted. Defaults to MAIN_CHANNEL_ID; empty ⇒ gate off. */
    get channelIds(): string[] {
      const fromEnv = envCsv('GATE_CHANNELS');
      if (fromEnv.length > 0) return fromEnv;
      const main = config.server.mainChannelId;
      return main ? [main] : [];
    },
    /** Words that make a message a candidate (whole words, case-insensitive). */
    get names(): string[] {
      const fromEnv = envCsv('GATE_NAMES');
      return (fromEnv.length > 0 ? fromEnv : ['fridge', 'frigidaire', 'frigi', 'bot', 'clanker']).map((name) =>
        name.toLowerCase(),
      );
    },
    /**
     * A channel has an active exchange while the bot answered someone there within this many seconds
     * (sliding: every answer extends it). During one, messages from anyone the bot has exchanged with
     * are candidates even without a name. 0 disables follow-ups (every name-drop is then cold).
     */
    get followupSeconds(): number {
      return envInt('GATE_FOLLOWUP_SECONDS', 120, { min: 0 });
    },
    /**
     * Runaway guard: unprompted replies per channel per rolling 10 minutes, all kinds together. High on
     * purpose — conversations come in bursts and must not be cut off mid-exchange. 0 ⇒ never unprompted.
     */
    get maxPer10Min(): number {
      return envInt('GATE_MAX_PER_10MIN', 30, { min: 0 });
    },
    /** Cold interjections (a name-drop with no active exchange) per channel per rolling 10 minutes. */
    get maxColdPer10Min(): number {
      return envInt('GATE_MAX_COLD_PER_10MIN', 6, { min: 0 });
    },
    /** Probability at/above which the decision model's "addressed to the bot" counts as yes. */
    get threshold(): number {
      return envNumber('GATE_THRESHOLD', 0.7, { min: 0, max: 1 });
    },
    /**
     * TypeSafe decision model for the gate. Pinned rather than `~typesafe/jev-latest`
     * because the thresholds are tuned against one model version. Only decision models are served by the
     * decisions endpoint, so anything else (a chat model id) ⇒ the default.
     */
    get model(): string {
      const fromEnv = envString('GATE_MODEL');
      return fromEnv && /^~?typesafe\//.test(fromEnv) ? fromEnv : 'typesafe/jev-1.13';
    },
  },

  /** Redirecting a member's rambles to their own channel, judged on content (src/gate/). */
  ramble: {
    /** Members whose rambles get redirected (side accounts resolve via LINKED_ACCOUNTS). Empty ⇒ feature off. */
    get userIds(): string[] {
      return envCsv('RAMBLE_USER_IDS');
    },
    /** Where rambles belong, and the archive's labelled set of real rambles. Unset ⇒ feature off. */
    get channelId(): string | undefined {
      return envString('RAMBLE_CHANNEL_ID');
    },
    /** Channels watched for rambles; defaults to MAIN_CHANNEL_ID. The ramble channel itself never is. */
    get watchChannelIds(): string[] {
      const fromEnv = envCsv('RAMBLE_WATCH_CHANNELS');
      if (fromEnv.length > 0) return fromEnv;
      const main = config.server.mainChannelId;
      return main ? [main] : [];
    },
    /** Prefilter: this many messages in a row (nobody else in between) within the window ⇒ ask the judge. */
    get minMessages(): number {
      return envInt('RAMBLE_MIN_MESSAGES', 3, { min: 1 });
    },
    /** Prefilter: one message with at least this many characters of prose ⇒ ask the judge. */
    get longMessageChars(): number {
      return envInt('RAMBLE_LONG_MESSAGE_CHARS', 600, { min: 1 });
    },
    get windowSeconds(): number {
      return envInt('RAMBLE_WINDOW_SECONDS', 300, { min: 1 });
    },
    /** Minimum time between two nudges for the same member. */
    get cooldownMinutes(): number {
      return envNumber('RAMBLE_COOLDOWN_MINUTES', 120, { min: 0 });
    },
    /** The judge's confidence at/above which its "this is a ramble" earns a nudge. */
    get threshold(): number {
      return envNumber('RAMBLE_THRESHOLD', 0.75, { min: 0, max: 1 });
    },
  },

  /** The code-execution sidecar (sandbox/, src/ai/tools/sandbox.ts). */
  sandbox: {
    /** Base URL of the sidecar, e.g. http://sandbox:8080. Unset ⇒ the run_code tool is not offered. */
    get url(): string | undefined {
      return envString('SANDBOX_URL');
    },
    /** Optional bearer token; must match the sidecar's own SANDBOX_TOKEN. */
    get token(): string | undefined {
      return envString('SANDBOX_TOKEN');
    },
    /** Run time limit when the model doesn't ask for one (the sidecar caps every run at 60 s). */
    get timeoutSeconds(): number {
      return envInt('SANDBOX_TIMEOUT_SECONDS', 20, { min: 1, max: 60 });
    },
  },

  /** Filing member feature requests as GitHub issues (src/ai/tools/featureRequest.ts, src/github/). */
  featureRequests: {
    /** Fine-grained PAT scoped to the one repo with Issues read/write. Never logged. */
    get githubToken(): string | undefined {
      return envString('GITHUB_TOKEN');
    },
    /** `owner/name` of the repo that receives the issues; anything not shaped like that counts as unset. */
    get githubRepo(): string | undefined {
      const value = envString('GITHUB_REPO');
      return value && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
    },
    /** The request_feature tool is only offered when both the token and the repo are configured. */
    get enabled(): boolean {
      return Boolean(this.githubToken && this.githubRepo);
    },
    /** Issues one member may file per rolling 24 hours. */
    get maxPerDay(): number {
      return envInt('FEATURE_REQUEST_MAX_PER_DAY', 3, { min: 1, max: 100 });
    },
    /** Discord user ids allowed to file; empty ⇒ every member can. */
    get userIds(): string[] {
      return envCsv('FEATURE_REQUEST_USER_IDS');
    },
    /**
     * +1 comments one member may add to existing requests per rolling 24 hours. Counted separately from
     * maxPerDay: backing an open request is cheap and is exactly what should happen instead of a new issue.
     */
    get maxCommentsPerDay(): number {
      return envInt('FEATURE_REQUEST_MAX_COMMENTS_PER_DAY', 10, { min: 1, max: 100 });
    },
    /** How far back closed issues count as "already done / declined"; 0 ⇒ only open issues are matched. */
    get closedLookbackDays(): number {
      return envInt('FEATURE_REQUEST_CLOSED_LOOKBACK_DAYS', 90, { min: 0, max: 3650 });
    },
  },

  /** OpenRouter usage/cost accounting (src/ai/usage.ts). */
  costs: {
    /**
     * Kill switch for the usage ledger (the shared client's response inspection + the bot.db rows).
     * Off ⇒ requests pass through untouched and query_costs / the digest's Spend section say so.
     */
    get ledgerEnabled(): boolean {
      return envBool('USAGE_LEDGER_ENABLED', true);
    },
  },

  /** The persona eval harness (src/evals/persona/, `yarn eval:persona`). Never read by the bot itself. */
  evals: {
    /** Paid runs are opt-in, like the live tests. */
    get runLive(): boolean {
      return envBool('RUN_LIVE', false);
    },
    /** Candidate chat models to compare; defaults to the configured CHAT_MODEL. */
    get models(): string[] {
      const fromEnv = envCsv('EVAL_MODELS');
      return fromEnv.length > 0 ? fromEnv : [config.models.chat];
    },
    get judgeModel(): string {
      return envString('EVAL_JUDGE_MODEL') ?? DEFAULT_EVAL_JUDGE_MODEL;
    },
    /** Optional csv of scenario ids to run (default: all). */
    get scenarioIds(): string[] {
      return envCsv('EVAL_SCENARIOS');
    },
    get outputDir(): string {
      return envString('EVAL_OUTPUT_DIR') ?? './data/evals';
    },
  },

  /** Discord application commands: right-click message/user menu entries (src/commands/). */
  commands: {
    /**
     * Master switch. False ⇒ the bot registers an empty command set at startup (the entries disappear from the
     * Apps menu instead of lingering as dead buttons) and refuses any interaction that still arrives.
     */
    get enabled(): boolean {
      return envBool('COMMANDS_ENABLED', true);
    },
  },

  /** Spontaneous emoji reactions to standout posts (src/reactions/). */
  autoReact: {
    /**
     * off: nothing runs. shadow (default): decides as if live but only posts what it WOULD react with to
     * the report channel, so the owner can review it before switching to on. on: actually reacts.
     */
    get mode(): 'off' | 'shadow' | 'on' {
      return envEnum('AUTO_REACT_MODE', ['off', 'shadow', 'on'] as const, 'shadow');
    },
    /** Channels (a thread matches through its parent) whose posts may get a reaction. Defaults to MAIN_CHANNEL_ID. */
    get channelIds(): string[] {
      const fromEnv = envCsv('AUTO_REACT_CHANNELS');
      if (fromEnv.length > 0) return fromEnv;
      const main = config.server.mainChannelId;
      return main ? [main] : [];
    },
    /** Reactions (shadow ones included) in any rolling 24 hours; 0 ⇒ never. */
    get maxPerDay(): number {
      return envInt('AUTO_REACT_MAX_PER_DAY', 3, { min: 0, max: 100 });
    },
    /** Minimum time between two reactions. */
    get minGapMinutes(): number {
      return envNumber('AUTO_REACT_MIN_GAP_MINUTES', 45, { min: 0, max: 24 * 60 });
    },
    /** Learn first: nothing is judged until the archive holds this many member messages that got a reaction. */
    get minProfileMessages(): number {
      return envInt('AUTO_REACT_MIN_PROFILE_MESSAGES', 200, { min: 0 });
    },
    /** Wait after a post before judging it: link previews resolve and a quick delete or edit lands first. */
    get delaySeconds(): number {
      return envNumber('AUTO_REACT_DELAY_SECONDS', 10, { min: 1, max: 300 });
    },
  },

  /** True inside the Vitest runner — the structural test-hermeticity guard. */
  get isTest(): boolean {
    return Boolean(process.env.VITEST);
  },
};

// ---- Startup summary ----

const onOff = (value: boolean): string => (value ? 'on' : 'off');

/** 604800000 → "7d", 1800000 → "30m", 4000 → "4s": the unit the value was most likely written in. */
function formatDuration(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms >= MINUTE_MS && ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * `name=on(detail,…)` / `name=off` / `name=off(reason)`. Details never contain spaces, so the summary
 * stays one `key=value` token per feature and greps cleanly.
 */
function feature(name: string, enabled: boolean, details: string[] = [], offReason?: string): string {
  if (!enabled) return offReason ? `${name}=off(${offReason})` : `${name}=off`;
  return details.length > 0 ? `${name}=on(${details.join(',')})` : `${name}=on`;
}

/**
 * One-line summary of the effective configuration for the startup log: every config section, so a
 * deploy's log shows at a glance which features are live and on which models. Secret-free by
 * construction: tokens, keys, URLs and repo names only ever appear as set/missing, and Discord ids only
 * as counts or "set" (channel names are resolved separately, see src/channelEnv.ts). The persona eval
 * section is left out: the bot never reads it.
 */
export function describeEffectiveConfig(): string {
  const { models, agent, learner, memory, report, links, deleteRepost, server } = config;
  const { birthdays, archive, media, linkReader, gate, ramble, sandbox, featureRequests, autoReact } = config;

  const fallbacks = models.chatFallbacks;
  const notes = agent.channelNotes;
  const deployAnnounce = !report.deployAnnounceEnabled ? 'off' : report.gitSha ? 'on' : 'no-sha';
  // Birthdays post to BIRTHDAY_CHANNEL_ID, else the main channel: say which, without the id.
  let birthdayAnnounce = `${birthdays.announceHour}h,channel:${birthdays.channelId === server.mainChannelId ? 'main' : 'own'}`;
  if (!birthdays.channelId) birthdayAnnounce = 'no-channel';
  if (!birthdays.announceEnabled) birthdayAnnounce = 'off';
  // Half-configured feature requests are the likely mistake: name the missing half.
  let featureRequestsOff: string | undefined;
  if (featureRequests.githubToken && !featureRequests.githubRepo) featureRequestsOff = 'no-repo';
  if (!featureRequests.githubToken && featureRequests.githubRepo) featureRequestsOff = 'no-token';
  const voiceChannels = media.voiceTranscribeChannels.length;
  // VIDEO_DAILY_BUDGET_USD: 0 means no cap.
  const videoBudget = media.videoDailyBudgetUsd > 0 ? `$${media.videoDailyBudgetUsd.toFixed(2)}/day` : 'unlimited';
  const translate = links.twitterTranslateTo ?? 'off';
  const fixers = [
    `x${links.twitterFixers.length}`,
    `ig${links.instagramFixers.length}`,
    `tt${links.tiktokFixers.length}`,
    `rd${links.redditFixers.length}`,
    `bsky${links.blueskyFixers.length}`,
  ].join('/');

  const parts = [
    // Models
    `chat=${models.chat}`,
    `chatFallbacks=${fallbacks.length > 0 ? fallbacks.join(',') : 'none'}`,
    `learner=${models.learner}`,
    ...(models.selfImprovement !== models.learner ? [`selfImprovement=${models.selfImprovement}`] : []),
    `image=${models.image}`,
    `embedding=${models.embedding}`,
    `emojiCaption=${models.emojiCaption}`,
    // Plumbing
    `discordToken=${config.discord.token ? 'set' : 'MISSING'}`,
    `openRouter=key:${config.openRouter.apiKey ? 'set' : 'MISSING'},timeout:${formatDuration(config.openRouter.timeoutMs)},retries:${config.openRouter.maxRetries}`,
    `usageLedger=${onOff(config.costs.ledgerEnabled)}`,
    `debugCapture=${onOff(config.debugCapture.enabled)}`,
    `logFile=${onOff(config.logging.file !== undefined)}`,
    `logDebug=${onOff(config.logging.debug)}`,
    // Server layout
    `mainChannel=${server.mainChannelId ? 'set' : 'off'}`,
    `linkedAccounts=${server.linkedAccounts.size}`,
    report.channelId
      ? `reportChannel=set(digest:${onOff(report.digestEnabled)}@${formatDuration(report.digestPeriodMs)},deploy:${deployAnnounce})`
      : 'reportChannel=off',
    // Chat, memory, learning
    `agent=rounds:${agent.maxToolRounds},history:${agent.historyTokenBudget ?? 'auto'},notes:${notes.invalid ? 'INVALID' : Object.keys(notes.notes).length}`,
    `semanticMemory=${onOff(memory.semanticEnabled)}`,
    `learning=every:${formatDuration(learner.intervalMs)},ignore:${learner.ignoredChannels.length},selfImprovement:${onOff(learner.selfImprovementEnabled)}`,
    `forceRecaption=${onOff(config.emoji.forceRecaption)}`,
    `usageCaptions=${onOff(config.emoji.usageCaptionsEnabled)}`,
    `recaptionFromUsage=${onOff(config.emoji.recaptionFromUsage)}`,
    // Features
    `links=verify:${onOff(links.verify)},fixers:${fixers},translate:${translate},alerts:${onOff(links.alertsEnabled)}`,
    feature('deleteRepost', deleteRepost.userIds.length > 0, [
      `users:${deleteRepost.userIds.length}`,
      `mode:${deleteRepost.mode}`,
      ...(deleteRepost.mode === 'edgy' ? [`judge:${models.messageJudge}`] : []),
    ]),
    `reminders=max:${config.reminders.maxPerUser}/user`,
    `birthdays=announce:${birthdayAnnounce},seed:${birthdays.seed.length}`,
    feature('archive', archive.enabled, [
      `backfill:${archive.backfillEnabled ? archive.backfillChannels.length : 'off'}`,
      `ignore:${archive.ignoredChannels.length}`,
      `wrapped:${onOff(archive.wrappedEnabled && archive.wrappedChannelId !== undefined)}`,
    ]),
    `media=transcribe:${media.transcriptionModel},video:${media.videoModel},videoBudget:${videoBudget},voiceAuto:${media.voiceAutoTranscribe ? (voiceChannels > 0 ? voiceChannels : 'all') : 'off'}`,
    feature('linkReader', linkReader.enabled, [`previews:${onOff(linkReader.previewsEnabled)}`]),
    feature(
      'gate',
      gate.enabled && gate.channelIds.length > 0,
      [`channels:${gate.channelIds.length}`, `max:${gate.maxPer10Min}/10m`, `cold:${gate.maxColdPer10Min}/10m`],
      gate.enabled ? 'no-channel' : undefined,
    ),
    feature(
      'ramble',
      ramble.userIds.length > 0 && ramble.channelId !== undefined,
      [`users:${ramble.userIds.length}`, `channels:${ramble.watchChannelIds.length}`],
      ramble.userIds.length > 0 ? 'no-channel' : undefined,
    ),
    feature('sandbox', sandbox.url !== undefined, [
      `token:${sandbox.token ? 'set' : 'none'}`,
      `timeout:${sandbox.timeoutSeconds}s`,
    ]),
    feature(
      'featureRequests',
      featureRequests.enabled,
      [`max:${featureRequests.maxPerDay}/day`, `users:${featureRequests.userIds.length || 'all'}`],
      featureRequestsOff,
    ),
    `commands=${onOff(config.commands.enabled)}`,
    feature(
      'autoReact',
      autoReact.mode !== 'off' && autoReact.channelIds.length > 0,
      [
        `mode:${autoReact.mode}`,
        `channels:${autoReact.channelIds.length}`,
        `max:${autoReact.maxPerDay}/day`,
        `gap:${formatDuration(autoReact.minGapMinutes * MINUTE_MS)}`,
      ],
      autoReact.mode !== 'off' ? 'no-channel' : undefined,
    ),
  ];
  return parts.join(' ');
}
