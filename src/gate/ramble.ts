// Ramble redirect: when a watched member's messages turn into one of their rambles (monologue-ish,
// stream-of-consciousness, very weird rambling, the thing the group made a whole channel for), the bot
// replies once to their latest message with an in-character nudge toward that channel.
//
// It fires on CONTENT, not volume ("not whenever he talks"). A free prefilter picks the moments worth a
// look: RAMBLE_MIN_MESSAGES messages in a row from the member with nobody else in between (the bot
// included) within RAMBLE_WINDOW_SECONDS, or one message of RAMBLE_LONG_MESSAGE_CHARS characters of
// prose. Then the cheap chat model judges the run against real rambles from the ramble channel and the
// member's normal messages (rambleJudge.ts, rambleExamples.ts), and only a confident "ramble" nudges.
// A "no" waits for a couple more messages (or a new long one) before asking again, a nudge starts a
// per-member cooldown (bot.db, so a redeploy mid-ramble can't nudge twice), and the ramble channel itself
// is never watched. Side accounts count as their main account (LINKED_ACCOUNTS) for the run, the
// watch list and the cooldown. A nudge is not a conversation: it never makes the member a gate partner
// (the gate only counts routed turns, see addressedGate.ts).
import type { Message } from 'discord.js';
import { config } from '../config';
import { canonicalUserId, isSamePerson } from '../linkedAccounts';
import { logger } from '../logger';
import { getBotDb } from '../storage/botDb';
import { renderMessageText } from './addressedGate';
import {
  type RambleExampleRequest,
  type RambleExampleSource,
  type RambleExamples,
  createArchiveRambleExamples,
} from './rambleExamples';
import { type RambleJudge, type RambleJudgeInput, type RambleLine, createChatRambleJudge } from './rambleJudge';
import { stripMarkup } from './text';

// In character: a friend telling another friend to take it elsewhere. `{channel}` becomes the channel link.
export const RAMBLE_LINES: readonly string[] = [
  'this is a {channel} moment',
  'we have a whole channel for this. {channel}. go',
  "sir this is a wendy's. {channel} is that way",
  'the committee has reviewed your thoughts and is forwarding them to {channel}',
  "i'm not following all that. {channel} will though",
  '{channel} misses you. go talk to it',
  'ramble detected. relocating you to {channel}',
  'the ted talk continues in {channel}, not here',
  'somebody get this man a blog. or just {channel}',
  "you've unlocked a new channel: {channel}. please proceed",
  'free therapy session is in {channel}, walk-ins welcome',
  "brother is transmitting from another dimension. {channel}'s got the antenna",
  "that's a {channel} thought if i've ever seen one",
];

const RECHECK_AFTER_MESSAGES = 2;
// A run of "lol" / "wait" / "what" is not worth a judge call however many messages it has.
const MIN_RUN_PROSE_CHARS = 60;
const BEFORE_CONTEXT_MESSAGES = 4;
const BUFFER_MAX_PER_CHANNEL = 60;

export type RambleSettings = {
  userIds: string[];
  channelId?: string;
  watchChannelIds: string[];
  /** Where the member's normal messages come from for contrast; unset ⇒ the channel being watched. */
  mainChannelId?: string;
  minMessages: number;
  longMessageChars: number;
  windowSeconds: number;
  cooldownMinutes: number;
  threshold: number;
};

export function rambleSettingsFromConfig(): RambleSettings {
  const ramble = config.ramble;
  return {
    userIds: ramble.userIds,
    channelId: ramble.channelId,
    watchChannelIds: ramble.watchChannelIds,
    mainChannelId: config.server.mainChannelId,
    minMessages: ramble.minMessages,
    longMessageChars: ramble.longMessageChars,
    windowSeconds: ramble.windowSeconds,
    cooldownMinutes: ramble.cooldownMinutes,
    threshold: ramble.threshold,
  };
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
 * message, so the mirror alone still enforces the cooldown for as long as the process lives. Keyed by
 * the member's main account id (the watcher passes canonical ids).
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

type Buffered = {
  authorId: string;
  authorName: string;
  /** What the judge reads: readable mentions/emojis, plus notes for images and files. */
  text: string;
  /** Characters of prose (no links, emoji markup or mentions). */
  chars: number;
  at: number;
  /** The bot's own post: it breaks a run like anyone else talking. */
  self: boolean;
  replyTo?: string;
};

export type RambleTrigger = 'run' | 'long';

export type RambleOutcome =
  | 'off'
  | 'ignored'
  | 'below_rule'
  | 'addressed_bot'
  | 'cooldown'
  | 'checking'
  | 'recheck_wait'
  | 'no_answer'
  | 'not_ramble'
  | 'nudged'
  | 'nudge_failed';

export type RambleWatcherOptions = {
  settings?: () => RambleSettings;
  judge?: RambleJudge;
  examples?: RambleExampleSource;
  cooldowns?: RambleCooldowns;
  now?: () => number;
  /** Picks the nudge line; injectable so tests are deterministic. */
  random?: () => number;
  lines?: readonly string[];
  /** Whether the bot is answering this message anyway (the gate routed it); default: never. */
  wasRouted?: (message: Message) => boolean;
};

const NO_EXAMPLES: RambleExamples = { rambles: [], ramblesAreTheirs: false, normal: [] };

/**
 * The member's current run (their trailing consecutive messages, nobody else in between) limited to the
 * window, and the few messages right before it.
 */
function currentRun(buffer: Buffered[], windowSeconds: number): { run: Buffered[]; before: Buffered[] } {
  const last = buffer.at(-1);
  if (!last || last.self) return { run: [], before: [] };
  const windowStart = last.at - windowSeconds * 1000;
  let start = buffer.length;
  while (start > 0) {
    const entry = buffer[start - 1];
    if (entry.self || !isSamePerson(entry.authorId, last.authorId) || entry.at < windowStart) break;
    start--;
  }
  return {
    run: buffer.slice(start),
    before: buffer.slice(Math.max(0, start - BEFORE_CONTEXT_MESSAGES), start),
  };
}

function replyTargetName(message: Message): string | undefined {
  if (!message.reference?.messageId) return undefined;
  const target = message.mentions?.repliedUser;
  if (!target) return undefined;
  return message.mentions?.members?.get(target.id)?.displayName || target.displayName || target.username || undefined;
}

/** Talking to the bot (a mention, or a reply to it) is a conversation, never a ramble. */
function addressesBot(message: Message, botId: string): boolean {
  return message.mentions?.users?.has(botId) === true || message.mentions?.repliedUser?.id === botId;
}

export class RambleWatcher {
  private readonly settings: () => RambleSettings;
  private readonly judge: RambleJudge;
  private readonly examples: RambleExampleSource;
  private readonly cooldowns: RambleCooldowns;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lines: readonly string[];
  private readonly wasRouted: (message: Message) => boolean;
  private readonly buffers = new Map<string, Buffered[]>();
  private readonly inFlight = new Set<string>();
  /** Per channel+member: timestamp of the newest message the last judgement covered. */
  private readonly lastCheckedAt = new Map<string, number>();
  private lastLine: string | undefined;

  constructor(opts: RambleWatcherOptions = {}) {
    this.settings = opts.settings ?? rambleSettingsFromConfig;
    this.judge = opts.judge ?? createChatRambleJudge();
    this.examples = opts.examples ?? createArchiveRambleExamples();
    this.cooldowns = opts.cooldowns ?? createBotDbRambleCooldowns();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.lines = opts.lines ?? RAMBLE_LINES;
    this.wasRouted = opts.wasRouted ?? (() => false);
  }

  async observe(message: Message): Promise<RambleOutcome> {
    const settings = this.settings();
    if (settings.userIds.length === 0 || !settings.channelId) return 'off';
    const channelId = message.channel.id;
    if (channelId === settings.channelId || !settings.watchChannelIds.includes(channelId)) return 'ignored';

    const botId = message.client.user.id;
    const self = message.author.id === botId && !message.webhookId;
    // Other bots and webhook posts (incl. the bot's own link-fix relays of a message already counted)
    // neither count nor break a run.
    if (!self && (message.author.bot || message.webhookId)) return 'ignored';

    const buffer = this.record(message, settings, botId, self);
    if (self || !settings.userIds.some((id) => isSamePerson(id, message.author.id))) return 'ignored';

    const current = buffer[buffer.length - 1];
    const { run, before } = currentRun(buffer, settings.windowSeconds);
    const prose = run.filter((entry) => entry.chars > 0);
    const proseChars = prose.reduce((sum, entry) => sum + entry.chars, 0);
    const long = current.chars >= settings.longMessageChars;
    const trigger: RambleTrigger | undefined = long
      ? 'long'
      : prose.length >= settings.minMessages && proseChars >= MIN_RUN_PROSE_CHARS
        ? 'run'
        : undefined;
    if (!trigger) return 'below_rule';
    if (addressesBot(message, botId) || this.wasRouted(message)) return 'addressed_bot';

    const personId = canonicalUserId(message.author.id);
    if (this.inCooldown(personId, settings)) return 'cooldown';
    const key = `${channelId}:${personId}`;
    if (this.inFlight.has(key)) return 'checking';
    const checkedAt = this.lastCheckedAt.get(key);
    // After a "no", a new long message is new material on its own; a run needs a couple more messages.
    if (
      checkedAt !== undefined &&
      !(long && current.at > checkedAt) &&
      prose.filter((entry) => entry.at > checkedAt).length < RECHECK_AFTER_MESSAGES
    ) {
      return 'recheck_wait';
    }

    this.inFlight.add(key);
    try {
      const examples = this.safeExamples({
        userId: message.author.id,
        rambleChannelId: settings.channelId,
        normalChannelId: settings.mainChannelId ?? channelId,
      });
      const input: RambleJudgeInput = {
        author: current.authorName,
        run: run
          .filter((entry) => entry.text.length > 0)
          .map((entry) => ({ text: entry.text, ...(entry.replyTo ? { replyTo: entry.replyTo } : {}) })),
        before: before
          .filter((entry) => entry.text.length > 0)
          .map(
            (entry): RambleLine => ({
              author: entry.authorName,
              text: entry.text,
              ...(entry.self ? { self: true } : {}),
            }),
          ),
        examples,
      };
      const verdict = await this.safeJudge(input);
      this.lastCheckedAt.set(key, current.at);
      const tail = `trigger=${trigger} channel=${channelId} author=${current.authorName} messages=${run.length} chars=${proseChars} examples=${examples.rambles.length}${examples.ramblesAreTheirs ? '' : '(others)'}/${examples.normal.length}`;
      if (!verdict) {
        logger.warn(`ramble: no verdict from the judge, ${tail}`);
        return 'no_answer';
      }
      const described = `ramble=${verdict.ramble} confidence=${verdict.confidence.toFixed(2)} threshold=${settings.threshold}`;
      if (!verdict.ramble || verdict.confidence < settings.threshold) {
        logger.info(`ramble: not a ramble ${described} ${tail}`);
        return 'not_ramble';
      }
      // Re-checked after the (slow) judge call: another channel may have nudged this member meanwhile,
      // or the gate may have decided this message was meant for the bot (then it answers, no nudge).
      if (this.inCooldown(personId, settings)) return 'cooldown';
      if (this.wasRouted(message)) {
        logger.info(`ramble: skip, the bot is answering this message ${described} ${tail}`);
        return 'addressed_bot';
      }
      // Recorded before sending, and kept when the send fails: a missing permission must not turn into
      // a judge call (and a failed reply) on every message that follows.
      this.cooldowns.recordNudge(personId, this.now());
      logger.info(`ramble: NUDGE ${described} ${tail}`);
      return (await this.sendNudge(message, settings.channelId)) ? 'nudged' : 'nudge_failed';
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Adds the message to its channel's recent history and returns that history (oldest first). */
  private record(message: Message, settings: RambleSettings, botId: string, self: boolean): Buffered[] {
    const channelId = message.channel.id;
    // Twice the window: the run itself, plus what was said right before it.
    const keepFrom = message.createdTimestamp - 2 * settings.windowSeconds * 1000;
    const buffer = (this.buffers.get(channelId) ?? []).filter((entry) => entry.at >= keepFrom);
    const replyTo = replyTargetName(message);
    buffer.push({
      authorId: message.author.id,
      authorName: message.member?.displayName || message.author.displayName || message.author.username,
      text: renderMessageText(message, botId, message.client.user.displayName || 'Frigidaire'),
      chars: stripMarkup(message.content ?? '').length,
      at: message.createdTimestamp,
      self,
      ...(replyTo ? { replyTo } : {}),
    });
    const trimmed = buffer.slice(-BUFFER_MAX_PER_CHANNEL);
    this.buffers.set(channelId, trimmed);
    return trimmed;
  }

  private inCooldown(personId: string, settings: RambleSettings): boolean {
    const last = this.cooldowns.lastNudgedAt(personId);
    return last !== undefined && this.now() - last < settings.cooldownMinutes * 60 * 1000;
  }

  private safeExamples(request: RambleExampleRequest): RambleExamples {
    try {
      return this.examples(request);
    } catch (error) {
      logger.warn('ramble: could not load examples, judging zero-shot:', error);
      return NO_EXAMPLES;
    }
  }

  private async safeJudge(input: RambleJudgeInput) {
    try {
      return await this.judge(input);
    } catch (error) {
      logger.warn('ramble: judge threw:', error);
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
