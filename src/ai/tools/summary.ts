// "Catch me up": summarizing a stretch of channel history. Self-contained — it fetches the messages,
// renders them into a transcript, and calls OpenRouter directly (ZDR, tagged 'summary') — so it does
// not depend on the chat provider. This is the bot's only summary pipeline: the summarize_messages tool
// hands its text to the chat model as a tool result (relayed in the bot's voice), and the "Summarize
// from here" command posts summarizeChannelResult()'s summary itself (audience 'group': the prompt then
// says the text goes straight to the group, so it is written for them rather than for the bot).
//
// People: the summarizer gets a WHO'S WHO block for the people in the stretch — everyone who talked
// and everyone the messages refer to (mentions, or any name they go by: display name, handle, IRL
// name, nickname) — with a few durable memories about the most prominent ones as background, so it
// understands references ("the depot" is where Jasper works). The prompt fences that background off:
// it explains the chat, it is never reported as something that happened in it.
import { type Message, SnowflakeUtil } from 'discord.js';
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { attributeMessage } from '../../relay';
import { getCachedTranscript } from '../media';
import { getMemoryStore } from '../memory';
import type { Identity, MemoryStore } from '../memory/memoryStore';
import { requireOpenRouterClient } from '../openRouterClient';
import { createPeopleMatcher, foldMembers, memoryKeyFor } from '../people';
import { featureRequestOptions } from '../usage';
import { formatTimestampET, parseEasternDateTime } from '../utils';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The longest range one summary covers. */
export const MAX_SUMMARY_RANGE_MS = 7 * DAY_MS;
const PAGE_SIZE = 100;
// 5,000 messages: a hard stop on the Discord API calls one summary can make.
const MAX_PAGES = 50;
// ~50–65k tokens of transcript: comfortably inside the chat model's context (DeepSeek V3.2: 163,840) and
// any sane replacement's, at a couple of cents per summary. Over budget, the OLDEST messages are dropped.
const TRANSCRIPT_BUDGET_CHARS = 200_000;
const MAX_MESSAGE_CHARS = 1_500;
// The bot's own replies are context, not the story (and include its earlier summaries): keep them short.
const MAX_BOT_MESSAGE_CHARS = 300;
const MAX_EMBED_DESCRIPTION_CHARS = 280;
const MAX_VOICE_TRANSCRIPT_CHARS = 2_000;
// People listed in WHO'S WHO: everyone who talked or was referred to, most prominent first.
const MAX_WHOS_WHO_ENTRIES = 25;
// Background memories: for the most prominent people only, and only durable kinds. Events and image
// shares are moments, and a two-week-old "moving on Saturday" would read as news in a summary.
const MAX_BACKGROUND_PEOPLE = 8;
const MAX_BACKGROUND_MEMORIES = 4;
const MAX_BACKGROUND_MEMORY_CHARS = 200;
const BACKGROUND_CATEGORIES: ReadonlySet<string> = new Set(['fact', 'preference', 'personality']);
// The prompt asks for ~1,500 characters (~400 tokens); the headroom is for a reasoning model in
// CHAT_MODEL, whose thinking tokens count against this limit too.
const SUMMARY_MAX_TOKENS = 4_000;
// "Since my last message": the asker's messages within this gap of each other (going back from the
// request) are the current visit — "yo" then "fridge catch me up" — not the message they mean.
const SAME_VISIT_GAP_MS = 15 * MINUTE_MS;

export type SummaryDeps = {
  /** OpenRouter client; defaults to the shared one. */
  client?: OpenAI;
  /** Clock; defaults to the real one. */
  now?: () => Date;
};

export type SummarizeChannelOptions = SummaryDeps & {
  /** A message in the channel to summarize; `messageRole` says what it is. */
  message: Message;
  /**
   * 'request' (default): `message` asks for the summary, so it is left out and history is read back
   * from it. 'target': `message` was picked from the channel ("Summarize from here"), so it is
   * summarized like any other message in the range and history is read back from `end`.
   */
  messageRole?: 'request' | 'target';
  start: Date;
  /** Defaults to now. */
  end?: Date;
  /** Who asked (a Discord user id); named in the prompt so the summary is written for them. */
  requesterId?: string;
  /** Messages the caller already fetched from this channel (any order), used instead of fetching again. */
  prefetched?: Message[];
  /** Context for the summarizer when the range is "what X missed": when X was last active. */
  requesterLastActive?: Date;
  /** Who reads the summary (default 'bot'); 'group' when it is posted as-is. */
  audience?: SummaryAudience;
};

// ---------------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------------

function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a.localeCompare(b);
}

/** Newest first, the order Discord returns pages in (sorted again here rather than trusted). */
function newestFirst(a: Message, b: Message): number {
  return b.createdTimestamp - a.createdTimestamp || compareIds(b.id, a.id);
}

/** The smallest snowflake at `ms`: every message sent at or before `ms - 1` has a smaller id. */
function snowflakeAt(ms: number): string {
  return SnowflakeUtil.generate({ timestamp: ms, increment: 0n, workerId: 0n, processId: 0n }).toString();
}

type Walk = {
  /** Newest first. */
  messages: Message[];
  /** The message `stop` matched, if it matched one. */
  stoppedAt?: Message;
  /** False when the page cap ran out before `stop` matched or the channel's first message was reached. */
  complete: boolean;
};

/**
 * Walks the channel backwards from `before` (exclusive), newest first, until `stop` matches a message
 * (which is not included), the channel runs out, or MAX_PAGES pages have been read.
 */
async function walkBack(message: Message, before: string, stop: (msg: Message) => boolean): Promise<Walk> {
  const messages: Message[] = [];
  let cursor = before;
  for (let page = 0; page < MAX_PAGES; page++) {
    const chunk = await message.channel.messages.fetch({ limit: PAGE_SIZE, before: cursor, cache: false });
    const sorted = [...chunk.values()].sort(newestFirst);
    for (const msg of sorted) {
      if (stop(msg)) return { messages, stoppedAt: msg, complete: true };
      messages.push(msg);
    }
    const oldest = sorted.at(-1);
    if (!oldest || sorted.length < PAGE_SIZE) return { messages, complete: true };
    cursor = oldest.id;
  }
  return { messages, complete: false };
}

type CatchUpStart =
  | { found: Message; scanned: Message[] }
  | { found: undefined; scanned: Message[]; searchedBackTo: Date };

/**
 * Finds the asker's last message before the current visit, searching back up to MAX_SUMMARY_RANGE_MS.
 * `scanned` holds every message newer than it (newest first) so the summary can reuse them.
 */
export async function findCatchUpStart(message: Message, requesterId: string, now: Date): Promise<CatchUpStart> {
  const floor = now.getTime() - MAX_SUMMARY_RANGE_MS;
  let visitStart = message.createdTimestamp;
  let tooOld = false;
  const walk = await walkBack(message, message.id, (msg) => {
    if (msg.createdTimestamp < floor) {
      tooOld = true;
      return true;
    }
    if (attributeMessage(msg)?.authorId !== requesterId) return false;
    if (visitStart - msg.createdTimestamp < SAME_VISIT_GAP_MS) {
      visitStart = msg.createdTimestamp;
      return false;
    }
    return true;
  });
  if (walk.stoppedAt && !tooOld) return { found: walk.stoppedAt, scanned: walk.messages };
  // Out of pages before reaching the 7-day floor: say how far back the search actually got.
  const oldest = walk.messages.at(-1);
  const searchedBackTo = new Date(walk.complete ? floor : (oldest?.createdTimestamp ?? floor));
  return { found: undefined, scanned: walk.messages, searchedBackTo };
}

// ---------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

type RenderContext = {
  botId?: string;
  botName: string;
  identitiesById: Map<string, Identity>;
  /** Author label of every message in the range, for "(replying to X)". */
  authorById: Map<string, string>;
};

type Author = { key: string; name: string; isBot: boolean; userId?: string };

/** Who wrote a message, or undefined for messages that are not part of the conversation. */
function authorOf(msg: Message, ctx: RenderContext): Author | undefined {
  if (msg.system) return undefined;
  const attribution = attributeMessage(msg);
  if (attribution) {
    // Fetched history usually lacks member data (no nickname), so the identities table, which the
    // identity tracker keeps on each member's current display name, names people first.
    const known = attribution.authorId ? ctx.identitiesById.get(attribution.authorId)?.display_name : undefined;
    const name = known ?? attribution.authorName;
    return { key: attribution.authorId ?? `name:${name}`, name, isBot: false, userId: attribution.authorId };
  }
  // The bot's own replies are part of what happened; other bots and integrations are not.
  if (!msg.webhookId && ctx.botId && msg.author.id === ctx.botId) {
    return { key: `bot:${ctx.botId}`, name: ctx.botName, isBot: true };
  }
  return undefined;
}

/** Discord markup → readable text: mentions become names, custom emojis their :name:, timestamps Eastern time. */
function readableContent(msg: Message, ctx: RenderContext): string {
  return (msg.content ?? '')
    .replace(/<@!?(\d+)>/g, (_token, id: string) => {
      const name =
        msg.mentions?.members?.get(id)?.displayName ||
        msg.mentions?.users?.get(id)?.displayName ||
        ctx.identitiesById.get(id)?.display_name ||
        (id === ctx.botId ? ctx.botName : undefined);
      return name ? `@${name}` : '@someone';
    })
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#(\d+)>/g, (_token, id: string) => {
      const channel = msg.mentions?.channels?.get(id);
      return channel && 'name' in channel && channel.name ? `#${channel.name}` : '#channel';
    })
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (token, seconds: string) => {
      const date = new Date(Number(seconds) * 1000);
      return Number.isNaN(date.getTime()) ? token : formatTimestampET(date);
    })
    .trim();
}

/** Bracketed notes for what a message carries besides text: files, stickers, link previews, a voice transcript. */
function extras(msg: Message): string[] {
  const notes: string[] = [];
  for (const attachment of msg.attachments?.values() ?? []) {
    const type = attachment.contentType ?? '';
    if (type.startsWith('image/')) notes.push('[image]');
    else if (type.startsWith('video/')) notes.push('[video]');
    else if (type.startsWith('audio/')) notes.push('[audio]');
    else notes.push(`[file: ${attachment.name}]`);
  }
  for (const sticker of msg.stickers?.values() ?? []) notes.push(`[sticker: ${sticker.name}]`);
  for (const embed of msg.embeds ?? []) {
    // Link previews: a shared tweet's text lives in the embed description, an article's headline in
    // its title — without these a link share reads as a bare URL.
    const parts = [embed.author?.name, embed.title, embed.description]
      .filter((p): p is string => Boolean(p?.trim()))
      .map((p) => p.trim());
    if (parts.length === 0) continue;
    notes.push(`[link: ${truncate(parts.join(' — ').replace(/\s+/g, ' '), MAX_EMBED_DESCRIPTION_CHARS)}]`);
  }
  const transcript = cachedTranscript(msg.id);
  if (transcript) notes.push(`[voice message transcript: ${truncate(transcript, MAX_VOICE_TRANSCRIPT_CHARS)}]`);
  return notes;
}

/** Cache-only: a summary never pays to transcribe history. */
function cachedTranscript(messageId: string): string | undefined {
  try {
    return getCachedTranscript(messageId)?.trim() || undefined;
  } catch (error) {
    logger.warn(`summary: transcript lookup failed for message ${messageId}:`, error);
    return undefined;
  }
}

/** One transcript line, or undefined when the message is not part of the conversation or carries nothing. */
function renderLine(msg: Message, ctx: RenderContext): { line: string; author: Author } | undefined {
  const author = authorOf(msg, ctx);
  if (!author) return undefined;
  const body = [readableContent(msg, ctx), ...extras(msg)].filter((p) => p.length > 0).join(' ');
  if (!body) return undefined;
  const replyTo = msg.reference?.messageId ? ctx.authorById.get(msg.reference.messageId) : undefined;
  const who = `${author.name}${author.isBot ? ' (bot)' : ''}${replyTo ? ` (replying to ${replyTo})` : ''}`;
  const limit = author.isBot ? MAX_BOT_MESSAGE_CHARS : MAX_MESSAGE_CHARS;
  return { line: `[${formatTimestampET(msg.createdAt)}] ${who}: ${truncate(body, limit)}`, author };
}

type Transcript = {
  /** Chronological. */
  lines: string[];
  /** The messages behind `lines` with their authors, chronological. */
  entries: { msg: Message; author: Author }[];
  /** Messages rendered. */
  included: number;
  /** Messages dropped (oldest first) to stay within the budget. */
  omitted: number;
  /** Timestamp of the oldest included message. */
  firstIncluded?: Date;
  /** Distinct people (not counting the bot) in the included messages. */
  speakers: number;
};

/** Renders newest → oldest until the budget is spent, so an over-long range loses its OLDEST messages. */
function buildTranscript(messagesNewestFirst: Message[], ctx: RenderContext): Transcript {
  const rendered: { line: string; author: Author; msg: Message }[] = [];
  let used = 0;
  let omitted = 0;
  for (const msg of messagesNewestFirst) {
    const entry = renderLine(msg, ctx);
    if (!entry) continue;
    if (omitted > 0 || used + entry.line.length + 1 > TRANSCRIPT_BUDGET_CHARS) {
      omitted++;
      continue;
    }
    used += entry.line.length + 1;
    rendered.push({ ...entry, msg });
  }
  rendered.reverse();
  const speakers = new Set(rendered.filter((r) => !r.author.isBot).map((r) => r.author.key));
  return {
    lines: rendered.map((r) => r.line),
    entries: rendered.map(({ msg, author }) => ({ msg, author })),
    included: rendered.length,
    omitted,
    firstIncluded: rendered[0]?.msg.createdAt,
    speakers: speakers.size,
  };
}

// ---------------------------------------------------------------------------------------------------
// People in the stretch
// ---------------------------------------------------------------------------------------------------

/** Someone who talked in, or was referred to by, the summarized messages. */
export type StretchPerson = {
  /** Undefined only for an old relay whose author could not be matched to a member. */
  userId?: string;
  /** Current display name. */
  name: string;
  identity?: Identity;
  /** Messages they wrote in the transcript. */
  messages: number;
  /** Times the messages refer to them (mention tokens or any name they go by). */
  references: number;
  /** Up to MAX_BACKGROUND_MEMORIES durable memories (the most prominent people only). */
  background: string[];
};

/**
 * Everyone who talked in the transcript (most messages first), then everyone the messages refer to
 * without talking (most referenced first), each with their background memories when they are among
 * the MAX_BACKGROUND_PEOPLE most prominent.
 */
function peopleInStretch(transcript: Transcript, identities: Identity[], store: MemoryStore): StretchPerson[] {
  const identitiesById = new Map(identities.map((i) => [i.discord_user_id, i]));
  const people = new Map<string, StretchPerson>();
  const personFor = (key: string, userId: string | undefined, name: string): StretchPerson => {
    let person = people.get(key);
    if (!person) {
      const identity = userId ? identitiesById.get(userId) : undefined;
      person = { userId, name: identity?.display_name ?? name, identity, messages: 0, references: 0, background: [] };
      people.set(key, person);
    }
    return person;
  };

  // References come back by main account id (a side account's names count as its member).
  const membersById = new Map(foldMembers(identities).map((m) => [m.userId, m]));
  const findReferences = createPeopleMatcher(identities);
  for (const { msg, author } of transcript.entries) {
    if (!author.isBot) personFor(author.key, author.userId, author.name).messages++;
    const text = [msg.content ?? '', cachedTranscript(msg.id) ?? ''].join('\n');
    for (const [userId, count] of findReferences(text)) {
      const member = membersById.get(userId);
      if (member) personFor(userId, userId, member.displayName).references += count;
    }
  }

  const all = [...people.values()];
  const talked = all.filter((p) => p.messages > 0).sort((a, b) => b.messages - a.messages);
  const mentionedOnly = all.filter((p) => p.messages === 0).sort((a, b) => b.references - a.references);
  const ranked = [...talked, ...mentionedOnly].slice(0, MAX_WHOS_WHO_ENTRIES);

  for (const person of ranked.slice(0, MAX_BACKGROUND_PEOPLE)) {
    person.background = backgroundFor(store, person);
  }
  return ranked;
}

/** A person's most recently updated durable memories, by id and every name they go by. */
function backgroundFor(store: MemoryStore, person: StretchPerson): string[] {
  // Without an id there is only a display name that matched no member: too weak to pull memories by.
  if (!person.userId) return [];
  try {
    return store
      .getForPerson(memoryKeyFor(store, person.userId, [person.name]), 50)
      .filter((m) => BACKGROUND_CATEGORIES.has(m.category))
      .slice(0, MAX_BACKGROUND_MEMORIES)
      .map((m) => truncate(m.content.replace(/\s+/g, ' ').trim(), MAX_BACKGROUND_MEMORY_CHARS));
  } catch (error) {
    logger.warn(`summary: loading background memories for ${person.name} failed:`, error);
    return [];
  }
}

/** "Jasper (@lapinlune) — real name Alex; also called J" */
function describePerson(person: StretchPerson): string {
  const identity = person.identity;
  const handle =
    identity?.username && identity.username.toLowerCase() !== person.name.toLowerCase()
      ? ` (@${identity.username})`
      : '';
  const irl = identity?.irl_name ? ` — real name ${identity.irl_name}` : '';
  const aliases = identity && identity.aliases.length > 0 ? `; also called ${identity.aliases.join(', ')}` : '';
  return `${person.name}${handle}${irl}${aliases}`;
}

function formatWhoIsWho(people: StretchPerson[]): string {
  if (people.length === 0) return '(nobody known)';
  return people
    .map((person) => {
      const role =
        person.messages > 0
          ? `${person.messages} ${person.messages === 1 ? 'message' : 'messages'}`
          : "mentioned, didn't talk";
      const lines = [`- ${describePerson(person)} [${role}]`];
      if (person.background.length > 0) lines.push(`  background: ${person.background.join(' | ')}`);
      return lines.join('\n');
    })
    .join('\n');
}

/** The footer for the chat model: who the stretch involved, so it can bring its own memory of them. */
function formatPeopleFooter(people: StretchPerson[]): string | undefined {
  const label = (p: StretchPerson) => (p.identity?.irl_name ? `${p.name} (${p.identity.irl_name})` : p.name);
  const talked = people.filter((p) => p.messages > 0).map(label);
  const mentioned = people.filter((p) => p.messages === 0).map(label);
  if (talked.length === 0 && mentioned.length === 0) return undefined;
  const parts = [talked.length > 0 ? talked.join(', ') : 'nobody but the bot'];
  if (mentioned.length > 0) parts.push(`mentioned without talking: ${mentioned.join(', ')}`);
  return `People in this stretch: ${parts.join('; ')}.`;
}

/**
 * Who reads the summary. 'bot' (default): the chat model, which relays it in the bot's own voice.
 * 'group': nobody in between: it is posted as-is into the channel ("Summarize from here").
 */
export type SummaryAudience = 'bot' | 'group';

const SUMMARY_FOR: Record<SummaryAudience, { intro: string; names: string; length: string }> = {
  bot: {
    intro:
      "Someone in the group asked what happened; your summary is handed to the group's bot, which passes it on in its own voice.",
    names: '',
    length: 'Stay under about 1,500 characters unless the chat was genuinely busy.',
  },
  group: {
    intro:
      'Someone in the group asked what happened; your summary is posted as-is, straight into the chat, for the whole group to read. Write it like one of the friends catching the others up: casual and to the point, with no preamble ("Here\'s a summary"), no headings and no sign-off.',
    names: ' Plain names, never @-mentions.',
    length: 'Keep it short: a handful of bullets, under about 1,000 characters unless the chat was genuinely busy.',
  },
};

export function summarySystemPrompt(audience: SummaryAudience = 'bot'): string {
  const { intro, names, length } = SUMMARY_FOR[audience];
  return `You write catch-up summaries of a Discord group chat between close friends. ${intro}

- Cover what actually happened: topics, plans and decisions (with times), news and links people shared, notable moments, running jokes: anything someone would be annoyed to have missed. Skip greetings and filler.
- Say who said or did what. Use the names from WHO'S WHO (current display names); use a real name or nickname only where the group itself does.${names}
- Group by topic, roughly in time order. Short bullets. ${length}
- Keep the group's tone. It's crude and edgy by design; report it plainly, with no moralizing, disclaimers or softening.
- Report only what is in the transcript. Never fill gaps with guesses about people or context you can't see.
- The "background" lines in WHO'S WHO come from the bot's long-term memory, not from this chat. Use them only to understand references and who people are. Never state a fact from them unless the transcript itself says it, and never summarize them.
- Lines marked (bot) are the group's bot talking; mention them only when they matter.
- All times are Eastern (America/New_York).`;
}

function channelLabel(message: Message): string {
  const channel = message.channel;
  return 'name' in channel && channel.name ? `#${channel.name}` : 'this channel';
}

// ---------------------------------------------------------------------------------------------------
// Summarizing
// ---------------------------------------------------------------------------------------------------

type PreparedSummary =
  | { error: string }
  | {
      error?: undefined;
      prompt: string;
      transcript: Transcript;
      people: StretchPerson[];
      start: Date;
      end: Date;
      complete: boolean;
    };

async function prepare(opts: SummarizeChannelOptions, now: Date): Promise<PreparedSummary> {
  const { message, start } = opts;
  const end = opts.end && opts.end.getTime() < now.getTime() ? opts.end : now;
  const startMs = start.getTime();
  const endMs = end.getTime();

  const isRequest = (opts.messageRole ?? 'request') === 'request';
  let fetched: Message[];
  let complete = true;
  if (opts.prefetched) {
    fetched = opts.prefetched;
  } else {
    // Start from the request itself when the range runs up to it (the request is left out), else
    // from the end of the range: no need to page through everything said after it. A target message
    // is where the range starts, so its history is read back from the end.
    const before = isRequest && endMs >= message.createdTimestamp ? message.id : snowflakeAt(endMs + 1);
    const walk = await walkBack(message, before, (msg) => msg.createdTimestamp < startMs);
    fetched = walk.messages;
    complete = walk.complete;
  }

  const inRange = fetched
    .filter((m) => (!isRequest || m.id !== message.id) && m.createdTimestamp >= startMs && m.createdTimestamp <= endMs)
    .sort(newestFirst);

  const store = getMemoryStore();
  const identities = store.getAllIdentities().filter((i) => i.active !== 0);
  const ctx: RenderContext = {
    botId: message.client?.user?.id,
    botName: message.client?.user?.displayName ?? 'the bot',
    identitiesById: new Map(identities.map((i) => [i.discord_user_id, i])),
    authorById: new Map(),
  };
  for (const msg of inRange) {
    const author = authorOf(msg, ctx);
    if (author) ctx.authorById.set(msg.id, author.name);
  }

  const transcript = buildTranscript(inRange, ctx);
  if (transcript.included === 0) {
    return {
      error: `There are no messages in ${channelLabel(message)} between ${formatTimestampET(start)} and ${formatTimestampET(end)} (Eastern) to summarize.`,
    };
  }

  // Only a request message was written by the requester; a target message's author is someone else.
  const requesterName = opts.requesterId
    ? (ctx.identitiesById.get(opts.requesterId)?.display_name ??
      (isRequest ? attributeMessage(message)?.authorName : undefined))
    : undefined;
  const header = [
    `Channel: ${channelLabel(message)}`,
    `Range: ${formatTimestampET(start)} to ${formatTimestampET(end)} (Eastern), ${transcript.included} messages.`,
  ];
  if (requesterName) {
    header.push(
      opts.requesterLastActive
        ? `Requested by ${requesterName}, who was last active here at ${formatTimestampET(opts.requesterLastActive)}: this is what they missed.`
        : `Requested by ${requesterName}.`,
    );
  }

  const gaps: string[] = [];
  if (!complete) {
    gaps.push('[Messages before the start of this transcript could not be fetched (history limit).]');
  }
  if (transcript.omitted > 0 && transcript.firstIncluded) {
    gaps.push(
      `[${transcript.omitted} older messages, before ${formatTimestampET(transcript.firstIncluded)}, are left out: the range is too long to read in full.]`,
    );
  }

  const people = peopleInStretch(transcript, identities, store);
  const prompt = `${header.join('\n')}

WHO'S WHO (people in this stretch: display name (@handle) — real name; nicknames. Background lines are from the bot's memory, NOT from this chat: context only):
${formatWhoIsWho(people)}

TRANSCRIPT:
${[...gaps, ...transcript.lines].join('\n')}`;

  return { prompt, transcript, people, start, end, complete };
}

/** Why there is no summary. */
export type SummaryFailure = 'no_messages' | 'history_unreadable' | 'model_failed' | 'model_empty';

/** The pipeline's outcome, for callers that present it themselves (the "Summarize from here" command). */
export type ChannelSummaryResult =
  | {
      ok: true;
      /** The summarizer's text. */
      summary: string;
      /** "Summary of #channel from … to … Eastern (N messages from M people):" */
      header: string;
      /** Plain sentences about what the summary could not cover (history limits, skipped messages). */
      caveats: string[];
      /** "People in this stretch: …", so the chat model can bring its own memory of them. */
      peopleFooter?: string;
    }
  | {
      ok: false;
      reason: SummaryFailure;
      /** A plain explanation, written for the chat model. */
      message: string;
    };

/**
 * Summarizes the messages of `message`'s channel between `start` and `end` for the chat model. Returns
 * text for the model either way: the summary with a one-line range header, any caveats and the people
 * footer, or a plain explanation of what went wrong (no messages, missing permission, model failure).
 */
export async function summarizeChannel(opts: SummarizeChannelOptions): Promise<string> {
  const result = await summarizeChannelResult(opts);
  if (!result.ok) return result.message;
  return [
    result.header,
    result.summary,
    ...result.caveats.map((c) => `(Note: ${c})`),
    ...(result.peopleFooter ? [result.peopleFooter] : []),
  ].join('\n');
}

/** summarizeChannel() as data: the same pipeline, one model call, nothing formatted for a reader yet. */
export async function summarizeChannelResult(opts: SummarizeChannelOptions): Promise<ChannelSummaryResult> {
  const now = opts.now?.() ?? new Date();

  let prepared: PreparedSummary;
  try {
    prepared = await prepare(opts, now);
  } catch (error) {
    logger.warn(`summary: reading history of channel ${opts.message.channel.id} failed:`, error);
    return {
      ok: false,
      reason: 'history_unreadable',
      message: "Couldn't read this channel's history (missing permission or a Discord error), so there is no summary.",
    };
  }
  if (prepared.error !== undefined) return { ok: false, reason: 'no_messages', message: prepared.error };

  let text: string | undefined;
  try {
    const client = opts.client ?? requireOpenRouterClient('summaries');
    const response = await client.chat.completions.create(
      {
        model: config.models.chat,
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [
          { role: 'system', content: summarySystemPrompt(opts.audience) },
          { role: 'user', content: prepared.prompt },
        ],
        // @ts-expect-error OpenRouter-specific field: zero-data-retention endpoints only
        provider: { zdr: true },
      },
      featureRequestOptions('summary'),
    );
    text = response.choices?.[0]?.message?.content?.trim() || undefined;
  } catch (error) {
    logger.error(`summary: model call failed for channel ${opts.message.channel.id}:`, error);
    return {
      ok: false,
      reason: 'model_failed',
      message: 'The summary model call failed, so there is no summary right now. Try again in a bit.',
    };
  }
  if (!text) {
    logger.warn(`summary: empty model response for channel ${opts.message.channel.id}`);
    return { ok: false, reason: 'model_empty', message: 'The summary model returned nothing. Try again in a bit.' };
  }

  const { transcript, people: stretchPeople, start, end, complete } = prepared;
  const caveats: string[] = [];
  if (transcript.omitted > 0 && transcript.firstIncluded) {
    caveats.push(
      `The range was too long to read in full: the ${transcript.omitted} oldest messages were skipped, so this starts at ${formatTimestampET(transcript.firstIncluded)}.`,
    );
  }
  if (!complete) caveats.push('History before the first summarized message could not be fetched.');

  const people = `${transcript.speakers} ${transcript.speakers === 1 ? 'person' : 'people'}`;
  return {
    ok: true,
    summary: text,
    header: `Summary of ${channelLabel(opts.message)} from ${formatTimestampET(start)} to ${formatTimestampET(end)} Eastern (${transcript.included} messages from ${people}):`,
    caveats,
    peopleFooter: formatPeopleFooter(stretchPeople),
  };
}

// ---------------------------------------------------------------------------------------------------
// The summarize_messages tool
// ---------------------------------------------------------------------------------------------------

function parseTime(raw: unknown): Date | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return 'invalid';
  if (raw.trim() === '') return undefined;
  return parseEasternDateTime(raw) ?? 'invalid';
}

/**
 * The summarize_messages tool: parses the model's arguments (Eastern wall-clock times, or "since my
 * last message"), enforces the 7-day cap, and summarizes. Always resolves to text for the model.
 */
export async function runSummaryTool(
  message: Message,
  args: Record<string, unknown>,
  deps: SummaryDeps = {},
): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const invalid = (field: string, value: unknown) =>
    `Invalid ${field} "${String(value)}". Use Eastern wall-clock time as 'YYYY-MM-DD HH:MM'.`;

  const parsedEnd = parseTime(args.end_time);
  if (parsedEnd === 'invalid') return invalid('end_time', args.end_time);
  const end = parsedEnd && parsedEnd.getTime() < now.getTime() ? parsedEnd : now;

  const requester = attributeMessage(message);
  const sinceMine = args.since_my_last_message === true || args.since_my_last_message === 'true';

  if (sinceMine) {
    if (!requester?.authorId) return "Can't tell who is asking, so there is no 'last message' to start from.";
    let search: CatchUpStart;
    try {
      search = await findCatchUpStart(message, requester.authorId, now);
    } catch (error) {
      logger.warn(`summary: searching channel ${message.channel.id} for the asker's last message failed:`, error);
      return "Couldn't read this channel's history (missing permission or a Discord error), so there is no summary.";
    }
    if (!search.found) {
      return `${requester.authorName} has no earlier message in ${channelLabel(message)} going back to ${formatTimestampET(search.searchedBackTo)} (Eastern), so there is no "last message" to start from. Ask them what timeframe they want, then call this again with start_time.`;
    }
    return summarizeChannel({
      ...deps,
      message,
      start: search.found.createdAt,
      end,
      requesterId: requester.authorId,
      requesterLastActive: search.found.createdAt,
      prefetched: search.scanned,
    });
  }

  const parsedStart = parseTime(args.start_time);
  if (parsedStart === 'invalid') return invalid('start_time', args.start_time);
  if (!parsedStart) return "Give a start_time ('YYYY-MM-DD HH:MM', Eastern) or set since_my_last_message.";
  if (parsedStart.getTime() >= end.getTime()) {
    return `start_time (${formatTimestampET(parsedStart)}) must be before end_time (${formatTimestampET(end)}), both Eastern.`;
  }

  let start = parsedStart;
  let capped = false;
  if (end.getTime() - start.getTime() > MAX_SUMMARY_RANGE_MS) {
    start = new Date(end.getTime() - MAX_SUMMARY_RANGE_MS);
    capped = true;
  }

  const summary = await summarizeChannel({ ...deps, message, start, end, requesterId: requester?.authorId });
  return capped
    ? `${summary}\n(Note: summaries cover at most 7 days, so this starts at ${formatTimestampET(start)} instead of ${formatTimestampET(parsedStart)}.)`
    : summary;
}
