// The daily birthday announcement. Once the Eastern clock reaches BIRTHDAY_ANNOUNCE_HOUR, every
// birthday that is today and not yet announced this year gets one short in-character message in the
// birthday channel, written by the chat model with a few of the person's memories as light context
// (a fixed template when the model call fails). Only today's birthdays are ever considered, so a bot
// that was offline all afternoon announces late the same evening and never the day after.
import { createHash } from 'node:crypto';
import { type Client, RESTJSONErrorCodes } from 'discord.js';
import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { getMemoryStore } from '../ai/memory';
import { SELF_DIAGNOSIS_CATEGORIES } from '../ai/memory/memoryStore';
import { getOpenRouterClient } from '../ai/openRouterClient';
import { memoryKeyFor } from '../ai/people';
import { featureRequestOptions } from '../ai/usage';
import { easternParts } from '../ai/utils';
import { config } from '../config';
import { logger } from '../logger';
import { type Birthday, claimAnnouncement, isBirthdayOn, listBirthdays, releaseAnnouncement } from './birthdayStore';
import { describeError, discordErrorCode, fetchPostableChannel, type PostableChannel } from './discord';

const MINUTE_MS = 60_000;
const MEMORY_CONTEXT_LIMIT = 5;
const MODEL_TIMEOUT_MS = 30_000;
// The default chat model (z-ai/glm-5.3-flash) reasons at 'max' unless told otherwise, and reasoning counts
// toward max_tokens: the writer asks for 'low' and leaves room for it before the message (only the tokens
// actually generated are billed).
const MODEL_MAX_TOKENS = 1500;
const MAX_MESSAGE_CHARS = 600;
/** Waits between failed attempts for the same birthday (the last one repeats until the day ends). */
const RETRY_DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS];
// Image shares expire within a day and self-diagnosis rows are about the bot; neither belongs in a toast.
const EXCLUDED_MEMORY_CATEGORIES = new Set<string>(['image', ...SELF_DIAGNOSIS_CATEGORIES]);

export type BirthdayMessageInput = {
  userId: string;
  name: string;
  /** The age they turn today, when the birth year is known. */
  age?: number;
  /** A few things the bot knows about them (memory contents). */
  memories: string[];
  botName: string;
};

/** Writes the announcement text, or undefined when it couldn't (the caller then uses the template). */
export type BirthdayWriter = (input: BirthdayMessageInput) => Promise<string | undefined>;

export type BirthdayWriterOptions = { client?: OpenAI; model?: string; timeoutMs?: number };

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** The fixed announcement used whenever the model can't write one. */
export function fallbackBirthdayMessage(userId: string, age?: number): string {
  return age && age > 0 ? `🎂 Happy ${ordinal(age)} birthday <@${userId}>!` : `🎂 Happy birthday <@${userId}>!`;
}

function buildPrompt(input: BirthdayMessageInput): { system: string; user: string } {
  const mention = `<@${input.userId}>`;
  const turning = input.age ? ` (turning ${input.age})` : '';
  const system = `You are ${input.botName}, one of the regulars in a private Discord server of close friends — not an assistant, just another member of the group chat. The group's humor is crude, sarcastic and full of banter; nobody takes a roast seriously.

It's ${input.name}'s birthday today${turning}. Write the birthday message you'd drop in the group chat:
- 1 or 2 short sentences, casual group-chat texting, lowercase is fine. Warm underneath, but in the group's voice — a light roast is welcome, nothing actually mean.
- Address them with the exact token ${mention} (it becomes a ping); don't @ anyone else.
- At most one detail from what you know about them, and only if it fits naturally — never list facts, and never say you have notes or memories.
- No hashtags, no emojis, no quotation marks around the message.
Reply with the message text only.`;
  const known =
    input.memories.length > 0
      ? `Things you know about ${input.name} (background only):\n${input.memories.map((m) => `- ${m}`).join('\n')}`
      : `You don't know much about ${input.name} beyond their name.`;
  return { system, user: known };
}

/** Cleans the model's text into a postable announcement; undefined when there's nothing usable. */
export function finalizeBirthdayMessage(text: string | null | undefined, userId: string): string | undefined {
  let message = (text ?? '').trim();
  // Models like to wrap the whole thing in quotes.
  message = message.replace(/^["“”']+|["“”']+$/g, '').trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) return undefined;
  const mention = `<@${userId}>`;
  const withMention =
    message.includes(mention) || message.includes(`<@!${userId}>`) ? message : `${mention} ${message}`;
  return `🎂 ${withMention}`;
}

type WriterRequestBody = {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  reasoning: { effort: 'low' };
  provider: { zdr: true };
};

/** The chat-model writer (ZDR, low reasoning effort, tagged 'birthday' for cost attribution). */
export function createBirthdayWriter(opts: BirthdayWriterOptions = {}): BirthdayWriter {
  return async (input) => {
    const client = opts.client ?? getOpenRouterClient();
    if (!client) return undefined;
    const model = opts.model ?? config.models.chat;
    const prompt = buildPrompt(input);
    const body: WriterRequestBody = {
      model,
      max_tokens: MODEL_MAX_TOKENS,
      temperature: 0.9,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      reasoning: { effort: 'low' },
      provider: { zdr: true },
    };
    try {
      // The SDK's types know neither `provider` nor OpenRouter's `reasoning` object: bridged here, once.
      const response = await client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, {
        ...featureRequestOptions('birthday'),
        timeout: opts.timeoutMs ?? MODEL_TIMEOUT_MS,
        maxRetries: 1,
      });
      const choice = response.choices?.[0];
      const finalized = finalizeBirthdayMessage(choice?.message?.content, input.userId);
      if (!finalized) {
        logger.warn(
          `birthdays: ${model} returned no usable message (finish=${choice?.finish_reason ?? 'none'}); using the template.`,
        );
      }
      return finalized;
    } catch (error) {
      logger.warn(`birthdays: ${model} call failed; using the template:`, error);
      return undefined;
    }
  };
}

export type BirthdayAnnouncerOptions = {
  client: Client;
  writer?: BirthdayWriter;
};

type Attempt = { failures: number; nextAt: number };

/**
 * Announces today's birthdays. Holds only in-memory retry backoff; everything that must survive a
 * restart (who was announced which year) is in bot.db.
 */
export class BirthdayAnnouncer {
  private readonly client: Client;
  private readonly writer: BirthdayWriter;
  private readonly attempts = new Map<string, Attempt>();

  constructor(opts: BirthdayAnnouncerOptions) {
    this.client = opts.client;
    this.writer = opts.writer ?? createBirthdayWriter();
  }

  /** Posts every due announcement; returns how many went out. Never throws. */
  async run(nowMs: number): Promise<number> {
    const channelId = config.birthdays.channelId;
    if (!channelId || !config.birthdays.announceEnabled) return 0;

    const now = easternParts(new Date(nowMs));
    if (now.hour < config.birthdays.announceHour) return 0;

    let due: Birthday[];
    try {
      due = listBirthdays().filter(
        (b) => isBirthdayOn(b, now) && (b.lastAnnouncedYear === null || b.lastAnnouncedYear < now.year),
      );
    } catch (error) {
      logger.warn('birthdays: failed to read birthdays:', error);
      return 0;
    }
    const ready = due.filter((b) => (this.attempts.get(this.attemptKey(b.userId, now.year))?.nextAt ?? 0) <= nowMs);
    if (ready.length === 0) return 0;

    let channel: PostableChannel;
    try {
      channel = await fetchPostableChannel(this.client, channelId);
    } catch (error) {
      logger.warn(`birthdays: announcement channel ${channelId} is unavailable:`, error);
      for (const b of ready) this.recordFailure(b.userId, now.year, nowMs);
      return 0;
    }

    let announced = 0;
    for (const birthday of ready) {
      if (await this.announce(birthday, channel, now.year, nowMs)) announced++;
    }
    return announced;
  }

  private attemptKey(userId: string, year: number): string {
    return `${userId}:${year}`;
  }

  private recordFailure(userId: string, year: number, nowMs: number): void {
    const key = this.attemptKey(userId, year);
    const failures = (this.attempts.get(key)?.failures ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
    this.attempts.set(key, { failures, nextAt: nowMs + delay });
  }

  private async announce(birthday: Birthday, channel: PostableChannel, year: number, nowMs: number): Promise<boolean> {
    const { userId } = birthday;
    try {
      const member = await this.lookupMember(channel, userId);
      if (member === 'gone') {
        // They left the server: pinging them would be noise. Claim the year so this isn't re-checked.
        claimAnnouncement(userId, year);
        logger.info(`birthdays: ${userId} is no longer in the server; skipping their announcement.`);
        return false;
      }

      const identity = this.safeIdentity(userId);
      const name = member?.displayName ?? identity?.display_name ?? (await this.lookupUserName(userId));
      const age = birthday.year ? year - birthday.year : undefined;
      const memories = this.memoriesFor(userId, name);
      const botName = this.client.user?.displayName ?? 'Frigidaire';

      let written: string | undefined;
      try {
        written = await this.writer({ userId, name, age, memories, botName });
      } catch (error) {
        logger.warn(`birthdays: writing ${userId}'s message failed; using the template:`, error);
      }
      const text = written ?? fallbackBirthdayMessage(userId, age);

      // Claim right before posting: whoever moves the watermark is the only one that posts this year.
      if (!claimAnnouncement(userId, year)) return false;
      try {
        await channel.send({
          content: text,
          allowedMentions: { parse: [], users: [userId] },
          // Discord dedupes a retried post with the same nonce for a few minutes (≤25 chars).
          nonce: `bd-${createHash('sha1').update(`${userId}:${year}`).digest('hex').slice(0, 20)}`,
          enforceNonce: true,
        });
      } catch (error) {
        releaseAnnouncement(userId, year, birthday.lastAnnouncedYear);
        throw error;
      }
      this.attempts.delete(this.attemptKey(userId, year));
      logger.info(`birthdays: announced ${userId}'s birthday.`);
      return true;
    } catch (error) {
      this.recordFailure(userId, year, nowMs);
      logger.warn(`birthdays: announcing ${userId}'s birthday failed: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * The member in the channel's guild: `undefined` when it can't be checked (no guild, a transient
   * error), 'gone' when Discord says they're not a member anymore.
   */
  private async lookupMember(
    channel: PostableChannel,
    userId: string,
  ): Promise<{ displayName: string } | 'gone' | undefined> {
    const guild = (channel as { guild?: { members?: { fetch(id: string): Promise<{ displayName: string }> } } }).guild;
    if (!guild?.members) return undefined;
    try {
      return await guild.members.fetch(userId);
    } catch (error) {
      const code = discordErrorCode(error);
      if (code === RESTJSONErrorCodes.UnknownMember || code === RESTJSONErrorCodes.UnknownUser) return 'gone';
      logger.warn(`birthdays: couldn't check ${userId}'s membership:`, error);
      return undefined;
    }
  }

  /** Last resort for a name the prompt can use: the Discord user itself. */
  private async lookupUserName(userId: string): Promise<string> {
    try {
      const user = await this.client.users.fetch(userId);
      return user.displayName || user.username;
    } catch {
      return 'this friend';
    }
  }

  private safeIdentity(userId: string) {
    try {
      return getMemoryStore().getIdentityById(userId);
    } catch {
      return undefined;
    }
  }

  /** Their memories by id and every name any of their accounts goes by (display, handle, first-seen, IRL, nicknames). */
  private memoriesFor(userId: string, liveName: string): string[] {
    try {
      const store = getMemoryStore();
      return store
        .getForPerson(memoryKeyFor(store, userId, [liveName]), 20)
        .filter((m) => !EXCLUDED_MEMORY_CATEGORIES.has(m.category))
        .slice(0, MEMORY_CONTEXT_LIMIT)
        .map((m) => m.content);
    } catch (error) {
      logger.warn(`birthdays: couldn't read memories for ${userId}:`, error);
      return [];
    }
  }
}
