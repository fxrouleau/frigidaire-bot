// Ramble redirect: when a watched member goes on a long monologue in the main chat, the bot replies once
// to their latest message with an in-character nudge toward the channel those belong in.
//
// A free rule runs first (RAMBLE_MIN_MESSAGES messages holding RAMBLE_MIN_CHARS characters of prose within
// RAMBLE_WINDOW_SECONDS, in a watched channel). Only then does one decision-model call confirm it is a
// monologue and not a lively back-and-forth (~$0.0001: the state is a short transcript). A negative or
// failed check waits for a couple more messages before asking again, a nudge starts a per-member cooldown
// (persisted in bot.db so a redeploy mid-rant can't nudge twice), and the ramble channel itself is never
// watched.
import type { Message } from 'discord.js';
import { type DecisionsOptions, type NoulQuestion, askNoul } from '../ai/decisions';
import { config } from '../config';
import { logger } from '../logger';
import { getBotDb } from '../storage/botDb';
import { readableMarkup, stripMarkup, truncate } from './text';

// In character: a friend telling another friend to take it elsewhere. `{channel}` becomes the channel link.
export const RAMBLE_LINES: readonly string[] = [
  'this is a {channel} moment',
  'we have a whole channel for this. {channel}. go',
  "sir this is a wendy's. {channel} is that way",
  'the committee has reviewed your essay and is forwarding it to {channel}',
  "i'm not reading all that. {channel} will though",
  '{channel} misses you. go talk to it',
  'ramble detected. relocating you to {channel}',
  'the ted talk continues in {channel}, not here',
  'somebody get this man a blog. or just {channel}',
  "you've unlocked a new channel: {channel}. please proceed",
  'free therapy session is in {channel}, walk-ins welcome',
];

const RECHECK_AFTER_MESSAGES = 2;
const TRANSCRIPT_MAX_LINES = 16;
const TRANSCRIPT_TEXT_MAX = 300;
const BUFFER_MAX_PER_CHANNEL = 100;

export type RambleSettings = {
  userIds: string[];
  channelId?: string;
  watchChannelIds: string[];
  minMessages: number;
  minChars: number;
  windowSeconds: number;
  cooldownMinutes: number;
  threshold: number;
  model: string;
};

export function rambleSettingsFromConfig(): RambleSettings {
  const ramble = config.ramble;
  return {
    userIds: ramble.userIds,
    channelId: ramble.channelId,
    watchChannelIds: ramble.watchChannelIds,
    minMessages: ramble.minMessages,
    minChars: ramble.minChars,
    windowSeconds: ramble.windowSeconds,
    cooldownMinutes: ramble.cooldownMinutes,
    threshold: ramble.threshold,
    model: config.gate.model,
  };
}

// ---- The decision-model question ----

export type RambleInput = {
  author: string;
  /** The channel's messages during the window, oldest first; `self` marks the bot's own. */
  transcript: Array<{ author: string; text: string; self?: boolean }>;
};

export type RambleCheck = (input: RambleInput) => Promise<number | undefined>;

/** The author's share of the transcript, in words (decision models don't count reliably). */
function describeShare(mine: number, total: number): string {
  if (total === 0 || mine === total) return 'every message in `recent_chat`';
  const share = mine / total;
  if (share >= 0.8) return 'almost every message in `recent_chat`';
  if (share >= 0.6) return 'most of the messages in `recent_chat`';
  if (share >= 0.4) return 'about half of the messages in `recent_chat`';
  return 'less than half of the messages in `recent_chat`';
}

export function buildRambleState(input: RambleInput): Record<string, unknown> {
  const lines = input.transcript.slice(-TRANSCRIPT_MAX_LINES);
  const mine = lines.filter((line) => !line.self && line.author === input.author).length;
  return {
    author: input.author,
    recent_chat: lines.map((line) => ({
      author: line.self ? `${line.author} (the bot)` : line.author,
      text: truncate(line.text, TRANSCRIPT_TEXT_MAX),
    })),
    author_wrote: describeShare(mine, lines.length),
  };
}

export const RAMBLE_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions:
    'Is `author` on a long rambling monologue or rant in `recent_chat`: posting long message after long message, mostly talking at the chat rather than having a back-and-forth with the others?',
  criteria: {
    true: [
      '`author` keeps posting long messages about their own topic (a rant, a story, a theory, a stream of consciousness, a long complaint) while the others barely respond.',
      'The others only chime in briefly, change the subject, or are not part of it: `author` is holding the floor.',
    ],
    false: [
      "A real conversation: other people are actively replying and `author`'s messages answer them.",
      '`author` is answering a question someone asked them, or is talking with the bot.',
      'The messages are mostly links, pasted text, game stats, or several short messages that only add up to a lot.',
    ],
  },
};

export function createRambleCheck(
  opts: Pick<DecisionsOptions, 'fetch' | 'apiKey' | 'timeoutMs'> & { model?: string } = {},
): RambleCheck {
  return (input) =>
    askNoul(opts.model ?? config.gate.model, buildRambleState(input), RAMBLE_QUESTION, {
      feature: 'ramble',
      fetch: opts.fetch,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
    });
}

// ---- Cooldowns (bot.db) ----

export type RambleCooldowns = {
  lastNudgedAt(userId: string): number | undefined;
  recordNudge(userId: string, at: number): void;
};

const COOLDOWN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ramble_nudges (
    user_id   TEXT    PRIMARY KEY,
    nudged_at INTEGER NOT NULL
  );
`;

/**
 * Cooldowns in bot.db with an in-memory mirror: a database hiccup must not turn into a nudge on every
 * message, so the mirror alone still enforces the cooldown for as long as the process lives.
 */
export function createBotDbRambleCooldowns(): RambleCooldowns {
  const memory = new Map<string, number>();
  const db = () => {
    const botDb = getBotDb();
    botDb.ensureSchema('ramble_nudges', COOLDOWN_SCHEMA);
    return botDb;
  };
  return {
    lastNudgedAt(userId) {
      let stored: number | undefined;
      try {
        const row = db().stmt('SELECT nudged_at FROM ramble_nudges WHERE user_id = ?').get(userId) as
          | { nudged_at: number }
          | undefined;
        stored = row?.nudged_at;
      } catch (error) {
        logger.warn('ramble: cooldown lookup failed:', error);
      }
      const remembered = memory.get(userId);
      if (stored === undefined) return remembered;
      return remembered === undefined ? stored : Math.max(stored, remembered);
    },
    recordNudge(userId, at) {
      memory.set(userId, at);
      try {
        db()
          .stmt(
            `INSERT INTO ramble_nudges (user_id, nudged_at) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET nudged_at = excluded.nudged_at`,
          )
          .run(userId, at);
      } catch (error) {
        logger.warn('ramble: failed to persist cooldown:', error);
      }
    },
  };
}

// ---- The watcher ----

function mentionName(message: Message, id: string, botId: string): string | undefined {
  if (id === botId) return message.client.user.displayName || 'Frigidaire';
  return (
    message.mentions?.members?.get(id)?.displayName ||
    message.mentions?.users?.get(id)?.displayName ||
    message.mentions?.users?.get(id)?.username ||
    undefined
  );
}

type Buffered = {
  authorId: string;
  authorName: string;
  text: string;
  /** Characters of prose (no links, emoji markup or mentions): what makes a ramble long. */
  chars: number;
  at: number;
  self: boolean;
};

export type RambleOutcome =
  | 'off'
  | 'ignored'
  | 'below_rule'
  | 'cooldown'
  | 'checking'
  | 'recheck_wait'
  | 'no_answer'
  | 'not_ramble'
  | 'nudged'
  | 'nudge_failed';

export type RambleWatcherOptions = {
  settings?: () => RambleSettings;
  check?: RambleCheck;
  cooldowns?: RambleCooldowns;
  now?: () => number;
  /** Picks the nudge line; injectable so tests are deterministic. */
  random?: () => number;
  lines?: readonly string[];
};

export class RambleWatcher {
  private readonly settings: () => RambleSettings;
  private readonly check: RambleCheck;
  private readonly cooldowns: RambleCooldowns;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lines: readonly string[];
  private readonly buffers = new Map<string, Buffered[]>();
  private readonly inFlight = new Set<string>();
  /** Per channel+member: timestamp of the newest message the last check covered. */
  private readonly lastCheckedAt = new Map<string, number>();
  private lastLine: string | undefined;

  constructor(opts: RambleWatcherOptions = {}) {
    this.settings = opts.settings ?? rambleSettingsFromConfig;
    this.check = opts.check ?? createRambleCheck();
    this.cooldowns = opts.cooldowns ?? createBotDbRambleCooldowns();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.lines = opts.lines ?? RAMBLE_LINES;
  }

  async observe(message: Message): Promise<RambleOutcome> {
    const settings = this.settings();
    if (settings.userIds.length === 0 || !settings.channelId) return 'off';
    const channelId = message.channel.id;
    if (channelId === settings.channelId || !settings.watchChannelIds.includes(channelId)) return 'ignored';

    const botId = message.client.user.id;
    const self = message.author.id === botId && !message.webhookId;
    // Other bots and webhook posts (incl. the bot's own link-fix relays of a message already counted) are skipped.
    if (!self && (message.author.bot || message.webhookId)) return 'ignored';

    const windowStart = message.createdTimestamp - settings.windowSeconds * 1000;
    const buffer = (this.buffers.get(channelId) ?? []).filter((entry) => entry.at >= windowStart);
    const content = message.content ?? '';
    buffer.push({
      authorId: message.author.id,
      authorName: message.member?.displayName || message.author.displayName || message.author.username,
      // What the decision model reads: `@Name` and `:emoji:` rather than raw ids.
      text: readableMarkup(content, (id) => mentionName(message, id, botId)),
      chars: stripMarkup(content).length,
      at: message.createdTimestamp,
      self,
    });
    this.buffers.set(channelId, buffer.slice(-BUFFER_MAX_PER_CHANNEL));

    const userId = message.author.id;
    if (self || !settings.userIds.includes(userId)) return 'ignored';

    const mine = buffer.filter((entry) => entry.authorId === userId && entry.chars > 0);
    const totalChars = mine.reduce((sum, entry) => sum + entry.chars, 0);
    if (mine.length < settings.minMessages || totalChars < settings.minChars) return 'below_rule';

    if (this.inCooldown(userId, settings)) return 'cooldown';
    const key = `${channelId}:${userId}`;
    if (this.inFlight.has(key)) return 'checking';
    const checkedAt = this.lastCheckedAt.get(key);
    if (checkedAt !== undefined && mine.filter((entry) => entry.at > checkedAt).length < RECHECK_AFTER_MESSAGES) {
      return 'recheck_wait';
    }

    const author = mine[mine.length - 1].authorName;
    this.inFlight.add(key);
    try {
      const probability = await this.safeCheck({
        author,
        transcript: buffer
          .filter((entry) => entry.text.trim().length > 0)
          .map((entry) => ({ author: entry.authorName, text: entry.text, ...(entry.self ? { self: true } : {}) })),
      });
      this.lastCheckedAt.set(key, message.createdTimestamp);
      const tail = `channel=${channelId} author=${author} messages=${mine.length} chars=${totalChars}`;
      if (probability === undefined) {
        logger.warn(`ramble: no decision from the model, ${tail}`);
        return 'no_answer';
      }
      const verdict = `p=${probability.toFixed(2)} threshold=${settings.threshold}`;
      if (probability < settings.threshold) {
        logger.info(`ramble: not a ramble ${verdict} ${tail}`);
        return 'not_ramble';
      }
      // Re-checked after the decision call: another channel may have nudged this member meanwhile.
      if (this.inCooldown(userId, settings)) return 'cooldown';
      // Recorded before sending, and kept when the send fails: a missing permission must not turn into
      // a decision call (and a failed reply) on every message that follows.
      this.cooldowns.recordNudge(userId, this.now());
      logger.info(`ramble: NUDGE ${verdict} ${tail}`);
      return (await this.sendNudge(message, settings.channelId)) ? 'nudged' : 'nudge_failed';
    } finally {
      this.inFlight.delete(key);
    }
  }

  private inCooldown(userId: string, settings: RambleSettings): boolean {
    const last = this.cooldowns.lastNudgedAt(userId);
    return last !== undefined && this.now() - last < settings.cooldownMinutes * 60 * 1000;
  }

  private async safeCheck(input: RambleInput): Promise<number | undefined> {
    try {
      return await this.check(input);
    } catch (error) {
      logger.warn('ramble: check threw:', error);
      return undefined;
    }
  }

  /** A random line, never the same one twice in a row. */
  pickLine(): string {
    let line = this.lines[Math.floor(this.random() * this.lines.length)] ?? this.lines[0];
    if (line === this.lastLine && this.lines.length > 1) {
      line = this.lines[(this.lines.indexOf(line) + 1) % this.lines.length];
    }
    this.lastLine = line;
    return line;
  }

  private async sendNudge(message: Message, rambleChannelId: string): Promise<boolean> {
    const content = this.pickLine().replaceAll('{channel}', `<#${rambleChannelId}>`);
    try {
      // No ping (they're clearly active), and still posted if the message was deleted meanwhile (e.g. a
      // link-fix repost replaced it).
      await message.reply({ content, allowedMentions: { repliedUser: false }, failIfNotExists: false });
      return true;
    } catch (error) {
      logger.warn(`ramble: failed to post the nudge in ${message.channel.id}:`, error);
      return false;
    }
  }
}
