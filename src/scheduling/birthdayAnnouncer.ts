// The daily birthday announcement. Once the Eastern clock reaches BIRTHDAY_ANNOUNCE_HOUR, every
// birthday that is today and not yet announced this year gets one short in-character message in the
// birthday channel, written by the chat model with what it knows about the person as light context
// (a fixed template when the model call fails). Only today's birthdays are ever considered, so a bot
// that was offline all afternoon announces late the same evening and never the day after.
// BIRTHDAY_ANNOUNCE_MODE=shadow (the default) writes the message exactly the same way but posts it only to
// the report channel, under its own watermark, so the owner can read it before turning announcements on.
// The shadow post carries a "Post it" button (src/approvals/): the owner can still let a good one through,
// that same day, and postApprovedBirthday() then announces it for real.
import { createHash } from 'node:crypto';
import { type Client, RESTJSONErrorCodes } from 'discord.js';
import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { getMemoryStore, getNotesStore } from '../ai/memory';
import { CORRECTION_CATEGORY, type Memory, SELF_DIAGNOSIS_CATEGORIES } from '../ai/memory/memoryStore';
import { chatExcerpt, correctionSource } from '../ai/memory/notes/context';
import { getOpenRouterClient } from '../ai/openRouterClient';
import { currentName, memoryKeyFor } from '../ai/people';
import { featureRequestOptions } from '../ai/usage';
import { easternParts, easternWallClockToDate, formatRelativeAge, parseSqliteUtc } from '../ai/utils';
import type { BirthdayApproval } from '../approvals/approvalStore';
import type { ApprovalResult } from '../approvals/handler';
import { offerApproval } from '../approvals/offer';
import { type ArchivedMessage, getArchivedMessages } from '../archive';
import { config } from '../config';
import { logger } from '../logger';
import {
  type Birthday,
  claimAnnouncement,
  claimShadowAnnouncement,
  getBirthday,
  isBirthdayOn,
  listBirthdays,
  releaseAnnouncement,
  releaseShadowAnnouncement,
} from './birthdayStore';
import {
  describeError,
  discordErrorCode,
  fetchPostableChannel,
  isPermanentChannelError,
  type PostableChannel,
} from './discord';

const MINUTE_MS = 60_000;
// The writer sees what the bot knows about the person nearly whole (a few dozen memories each), dated, and
// picks for itself. With only the newest few, undated, yesterday's story became the whole message, told
// as old lore. Past the limit it gets the oldest half (lore) and the newest half (what's going on).
const MEMORY_CONTEXT_LIMIT = 40;
// Every memory filed under them, before the categories below are dropped.
const MEMORY_CANDIDATES = 500;
// The profile the writer sees (memory v2), Earlier footnotes left out.
const PROFILE_MAX_CHARS = 3_000;
const MODEL_TIMEOUT_MS = 30_000;
// The default chat model (z-ai/glm-5.3-flash) reasons at 'max' unless told otherwise, and reasoning counts
// toward max_tokens: the writer asks for 'low' and leaves room for it before the message (only the tokens
// actually generated are billed).
const MODEL_MAX_TOKENS = 1500;
const MAX_MESSAGE_CHARS = 600;
/** Waits between failed attempts for the same birthday (the last one repeats until the day ends). */
const RETRY_DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS];
// Image shares expire within a day and self-diagnosis rows are about the bot: neither belongs in a toast.
// Events stay: dated, recent news can be fair game ("just got engaged") as long as it's told as recent.
const EXCLUDED_MEMORY_CATEGORIES = new Set<string>(['image', ...SELF_DIAGNOSIS_CATEGORIES]);
// "Friday, September 25, 2026": the writer's today, on the group's clock.
const EASTERN_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
// Today's chat as writer context: the newest lines of the day, one line each, capped so a busy day stays cheap.
const TODAYS_CHAT_MAX_LINES = 60;
const TODAYS_CHAT_MAX_CHARS = 6_000;
const TODAYS_CHAT_LINE_MAX_CHARS = 200;
const EASTERN_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * One archived message as `HH:MM Name: text`: mentions become @names (or @someone), custom emojis :name:, a voice
 * message its transcript, files their names. The bot's own lines are marked as the writer's. undefined when there's
 * nothing to show.
 */
function renderChatLine(
  message: ArchivedMessage,
  botName: string,
  nameOf: (userId: string) => string | undefined,
): string | undefined {
  const text = [
    message.content,
    message.transcript ? `[voice message: ${message.transcript}]` : '',
    ...message.attachments.map((file) => `[file: ${file.name}]`),
  ]
    .filter((part) => part.trim().length > 0)
    .join(' ')
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${nameOf(id) ?? 'someone'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  const author = message.source === 'bot' ? `${botName} (you)` : message.authorName;
  const clipped = text.length > TODAYS_CHAT_LINE_MAX_CHARS ? `${text.slice(0, TODAYS_CHAT_LINE_MAX_CHARS - 1)}…` : text;
  return `${EASTERN_TIME.format(message.createdAt)} ${author}: ${clipped}`;
}

export type BirthdayMessageInput = {
  userId: string;
  name: string;
  /** The age they turn today, when the birth year is known. */
  age?: number;
  /**
   * Your notes on who they are (memory v2: their profile without its dated "Earlier" footnotes), when the
   * nightly dream has written one. `memories` then holds only what was picked up since.
   */
  profile?: string;
  /**
   * What the bot knows about them, oldest first, each tagged with when it was first noted ("… (noted 3mo
   * ago)"): with a profile, the journal rows newer than it; without, everything filed under them.
   */
  memories: string[];
  botName: string;
  /** Today's Eastern date, e.g. "Friday, September 25, 2026". */
  today: string;
  /**
   * The birthday channel's chat so far today (Eastern), newest last: `HH:MM Name: text` lines, capped. Plain
   * background: the writer can bounce off it (or notice nobody said anything) without being told what to look for.
   */
  todaysChat?: string[];
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
- At most one detail from what you know about them, and only if it fits naturally. Prefer something long-running about them (a trait, a running joke, old lore). Each thing you know says when you first noted it: anything from the last couple of weeks is recent news, so only bring it up as something that just happened, never as history or an old running joke. Never list facts, and never say you have notes or memories.
- No hashtags, no emojis, no quotation marks around the message.
Reply with the message text only.`;
  const newer = input.memories.map((m) => `- ${m}`).join('\n');
  const known = input.profile
    ? [
        `Your notes on who ${input.name} is (background only):\n${input.profile}`,
        ...(newer ? [`Picked up since those notes (recent, each with when you first noted it):\n${newer}`] : []),
      ].join('\n\n')
    : input.memories.length > 0
      ? `What you know about ${input.name} (background only; oldest first, each with when you first noted it):\n${newer}`
      : `You don't know much about ${input.name} beyond their name.`;
  const chat =
    input.todaysChat && input.todaysChat.length > 0
      ? `\n\nThe chat so far today (background):\n${input.todaysChat.join('\n')}`
      : '';
  return { system, user: `Today is ${input.today}.\n\n${known}${chat}` };
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

/** Posts an announcement: a ping for the birthday person only, deduped by Discord on a retry. */
async function sendAnnouncement(channel: PostableChannel, userId: string, year: number, text: string): Promise<void> {
  await channel.send({
    content: text,
    allowedMentions: { parse: [], users: [userId] },
    // Discord dedupes a retried post with the same nonce for a few minutes (≤25 chars).
    nonce: `bd-${createHash('sha1').update(`${userId}:${year}`).digest('hex').slice(0, 20)}`,
    enforceNonce: true,
  });
}

/**
 * The owner confirmed a shadow announcement: posts its text in the birthday channel it was written for,
 * under the real watermark, exactly as live mode would have (so the day never gets a second one, and
 * switching to `on` later the same day doesn't announce again).
 */
export async function postApprovedBirthday(client: Client, approval: BirthdayApproval): Promise<ApprovalResult> {
  const { userId, year } = approval;
  const birthday = getBirthday(userId);
  if (!birthday) return { status: 'closed', note: 'their birthday is no longer saved' };
  if (birthday.lastAnnouncedYear !== null && birthday.lastAnnouncedYear >= year) {
    return { status: 'closed', note: 'already announced this year' };
  }
  let channel: PostableChannel;
  try {
    channel = await fetchPostableChannel(client, approval.channelId);
  } catch (error) {
    if (isPermanentChannelError(error)) return { status: 'closed', note: `can't post in <#${approval.channelId}>` };
    return { status: 'retry', note: `couldn't reach <#${approval.channelId}>, click again in a bit` };
  }
  if (!claimAnnouncement(userId, year)) return { status: 'closed', note: 'already announced this year' };
  try {
    await sendAnnouncement(channel, userId, year, approval.text);
  } catch (error) {
    releaseAnnouncement(userId, year, birthday.lastAnnouncedYear);
    logger.warn(`birthdays: posting ${userId}'s approved announcement failed: ${describeError(error)}`);
    if (isPermanentChannelError(error)) return { status: 'closed', note: `can't post in <#${approval.channelId}>` };
    return { status: 'retry', note: "the post didn't go through, click again in a bit" };
  }
  logger.info(`birthdays: announced ${userId}'s birthday (approved from the shadow post).`);
  return { status: 'done', note: `posted in <#${approval.channelId}>` };
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
    const mode = config.birthdays.announceMode;
    if (!channelId || mode === 'off') return 0;
    const shadow = mode === 'shadow';
    // Shadow posts go to the report channel: without one there is nowhere to put them.
    if (shadow && !config.report.channelId) return 0;

    const now = easternParts(new Date(nowMs));
    if (now.hour < config.birthdays.announceHour) return 0;

    let due: Birthday[];
    try {
      due = listBirthdays().filter((b) => {
        if (!isBirthdayOn(b, now)) return false;
        const last = shadow ? b.lastShadowYear : b.lastAnnouncedYear;
        // A real announcement this year makes a shadow one pointless.
        if (shadow && b.lastAnnouncedYear !== null && b.lastAnnouncedYear >= now.year) return false;
        return last === null || last < now.year;
      });
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
      if (await this.announce(birthday, channel, now.year, nowMs, shadow)) announced++;
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

  private async announce(
    birthday: Birthday,
    channel: PostableChannel,
    year: number,
    nowMs: number,
    shadow: boolean,
  ): Promise<boolean> {
    const { userId } = birthday;
    try {
      const member = await this.lookupMember(channel, userId);
      if (member === 'gone') {
        // They left the server: pinging them would be noise. Claim the year so this isn't re-checked.
        if (shadow) claimShadowAnnouncement(userId, year);
        else claimAnnouncement(userId, year);
        logger.info(`birthdays: ${userId} is no longer in the server; skipping their announcement.`);
        return false;
      }

      const identity = this.safeIdentity(userId);
      const name = member?.displayName ?? identity?.display_name ?? (await this.lookupUserName(userId));
      const age = birthday.year ? year - birthday.year : undefined;
      const { profile, memories } = this.knownAbout(userId, name, nowMs);
      const botName = this.client.user?.displayName ?? 'Frigidaire';

      let written: string | undefined;
      try {
        written = await this.writer({
          userId,
          name,
          age,
          ...(profile ? { profile } : {}),
          memories,
          botName,
          today: EASTERN_DATE.format(nowMs),
          todaysChat: this.todaysChat(channel.id, nowMs, botName),
        });
      } catch (error) {
        logger.warn(`birthdays: writing ${userId}'s message failed; using the template:`, error);
      }
      const text = written ?? fallbackBirthdayMessage(userId, age);

      if (shadow) return await this.postShadow(birthday, channel, year, text);

      // Claim right before posting: whoever moves the watermark is the only one that posts this year.
      if (!claimAnnouncement(userId, year)) return false;
      try {
        await sendAnnouncement(channel, userId, year, text);
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
   * Posts the would-be announcement to the report channel (which pings nobody) under the shadow watermark,
   * with a button that posts it for real (postApprovedBirthday).
   */
  private async postShadow(birthday: Birthday, channel: PostableChannel, year: number, text: string): Promise<boolean> {
    const { userId } = birthday;
    if (!claimShadowAnnouncement(userId, year)) return false;
    const posted = await offerApproval(
      this.client,
      `-# 🎂 birthday (shadow) · would post in <#${channel.id}>:\n${text}`,
      { kind: 'birthday', userId, year, channelId: channel.id, text },
    );
    if (!posted) {
      releaseShadowAnnouncement(userId, year, birthday.lastShadowYear);
      throw new Error('the report channel post failed');
    }
    this.attempts.delete(this.attemptKey(userId, year));
    logger.info(`birthdays: shadow-announced ${userId}'s birthday in the report channel.`);
    return true;
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

  /** The birthday channel's messages since midnight Eastern, rendered compactly; [] when the archive has none. */
  private todaysChat(channelId: string, nowMs: number, botName: string): string[] {
    const { year, month, day } = easternParts(new Date(nowMs));
    const midnight = easternWallClockToDate(year, month, day, 0, 0).getTime();
    const lines = getArchivedMessages(channelId, midnight, nowMs + 1)
      .map((message) => renderChatLine(message, botName, (id) => this.safeIdentity(id)?.display_name))
      .filter((line): line is string => line !== undefined);
    // The newest lines, within both caps: the latest part of the day is what the writer would bounce off.
    const kept: string[] = [];
    let chars = 0;
    for (let i = lines.length - 1; i >= 0 && kept.length < TODAYS_CHAT_MAX_LINES; i--) {
      if (chars + lines[i].length > TODAYS_CHAT_MAX_CHARS) break;
      kept.unshift(lines[i]);
      chars += lines[i].length + 1;
    }
    return kept;
  }

  private safeIdentity(userId: string) {
    try {
      return getMemoryStore().getIdentityById(userId);
    } catch {
      return undefined;
    }
  }

  /**
   * What the bot knows about them: their profile (without its Earlier footnotes) and the journal rows newer
   * than it once the dream has written one, else every memory filed under them (by id and every name any of
   * their accounts goes by: display, handle, first-seen, IRL, nicknames). Image and self-diagnosis rows are
   * left out; rows are oldest first, each tagged with when it was first noted, capped at
   * MEMORY_CONTEXT_LIMIT (the oldest and the newest halves).
   */
  private knownAbout(userId: string, liveName: string, nowMs: number): { profile?: string; memories: string[] } {
    try {
      const store = getMemoryStore();
      const key = memoryKeyFor(store, userId, [liveName]);
      const profile = getNotesStore(store).getProfile(userId);
      if (profile) {
        const newer = getNotesStore(store).newJournal({ scope: 'person', ownerId: key.userId, names: key.names });
        return { profile: chatExcerpt(profile.content, PROFILE_MAX_CHARS), memories: this.dated(newer, nowMs) };
      }
      return { memories: this.dated(store.getForPerson(key, MEMORY_CANDIDATES), nowMs) };
    } catch (error) {
      logger.warn(`birthdays: couldn't read memories for ${userId}:`, error);
      return { memories: [] };
    }
  }

  /**
   * Rows as dated lines, oldest first, image and self-diagnosis rows left out, capped (oldest + newest halves).
   * A correction says whose word it is: someone's claim about the person is never handed over as their fact.
   */
  private dated(rows: Memory[], nowMs: number): string[] {
    // Oldest first by when each was first noted (an unreadable time counts as old); ties by id, for a stable
    // order. First seen (created_at for older rows), not updated_at: the learner re-confirming old lore must
    // not make it look new, and a backdated row (the bootstrap reading old history) is as old as the history.
    const firstNoted = (m: Memory) => m.first_seen_at ?? m.created_at;
    const dated = rows
      .filter((m) => !EXCLUDED_MEMORY_CATEGORIES.has(m.category))
      .map((m) => ({ memory: m, noted: parseSqliteUtc(firstNoted(m)) ?? Number.NEGATIVE_INFINITY }))
      .sort((a, b) => (a.noted === b.noted ? a.memory.id - b.memory.id : a.noted < b.noted ? -1 : 1));
    const half = MEMORY_CONTEXT_LIMIT / 2;
    const picked = dated.length > MEMORY_CONTEXT_LIMIT ? [...dated.slice(0, half), ...dated.slice(-half)] : dated;
    const now = new Date(nowMs);
    const nameOf = (id: string) => currentName(id, '', getMemoryStore()) || undefined;
    return picked.map(({ memory }) => {
      const age = formatRelativeAge(firstNoted(memory), now);
      const notes = [
        ...(memory.category === CORRECTION_CATEGORY ? [`a correction, ${correctionSource(memory, nameOf)}`] : []),
        ...(age ? [`noted ${age}`] : []),
      ];
      return notes.length > 0 ? `${memory.content} (${notes.join('; ')})` : memory.content;
    });
  }
}
