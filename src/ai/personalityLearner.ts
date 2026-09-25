import { ChannelType, type Client, type Collection, type Message, type TextChannel } from 'discord.js';
import type OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { config } from '../config';
import { canonicalUserId } from '../linkedAccounts';
import { logger } from '../logger';
import { attributeMessage } from '../relay';
import { getCachedTranscript } from './media';
import { type Identity, type MemoryStore, NON_PERSON_SUBJECTS, nameKey } from './memory/memoryStore';
import { getOpenRouterClient } from './openRouterClient';
import { type Member, checkNickname, foldMembers, matchMemberByName, memoryKeyFor, parseMemberName } from './people';
import { formatEmojiLines, formatIdentityLines } from './promptSections';
import { type UsageFeature, featureRequestOptions } from './usage';
import { formatTimestampET } from './utils';

// Single source of truth for valid categories — a runtime value (not just a type) because the TTL
// sweep keys on exact category strings: a hallucinated category from the LLM ('Image', 'meme') would
// create a memory that never expires. analyzeAndSave() validates against this list before saving.
const OBSERVATION_CATEGORIES = [
  'fact',
  'preference',
  'personality',
  'event', // time-bound: expired by the TTL sweep (~14 days)
  'vibe',
  'image', // image/GIF share observations: ephemeral by definition, expired by the TTL sweep (~24h)
  'capability_gap',
  'pain_point',
  'feature_request',
  'improvement_idea',
] as const;

export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/**
 * Normalizes an LLM-emitted category string (trim + lowercase) and validates it against the known
 * categories. Returns undefined for anything that isn't a real category — callers drop the observation.
 */
export function normalizeObservationCategory(raw: string): ObservationCategory | undefined {
  const normalized = raw.trim().toLowerCase();
  return (OBSERVATION_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as ObservationCategory)
    : undefined;
}

export type Observation = {
  category: ObservationCategory;
  subject: string;
  subject_user_id?: string;
  content: string;
};

export type IdentityUpdate = {
  discord_user_id: string;
  irl_name?: string;
  aliases_add?: string[];
};

type LearnerOutput = {
  observations: Observation[];
  identity_updates?: IdentityUpdate[];
};

const SELF_IMPROVEMENT_CATEGORIES: ObservationCategory[] = [
  'capability_gap',
  'pain_point',
  'feature_request',
  'improvement_idea',
];

export function parseLearnerOutput(raw: string): LearnerOutput | undefined {
  const tryParse = (candidate: string): LearnerOutput | undefined => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return { observations: parsed as Observation[] };
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.observations)) {
        return {
          observations: parsed.observations as Observation[],
          identity_updates: Array.isArray(parsed.identity_updates)
            ? (parsed.identity_updates as IdentityUpdate[])
            : undefined,
        };
      }
    } catch {
      // fall through
    }
    return undefined;
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    const fromObject = tryParse(objectMatch[0]);
    if (fromObject) return fromObject;
  }

  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const fromArray = tryParse(arrayMatch[0]);
    if (fromArray) return fromArray;
  }

  return undefined;
}

/**
 * Builds the pass-1 (personality/observation) prompt. Exported as a pure function so tests can assert
 * the memory-quality rules (30-day test, ephemeral categories, subject normalization) are present.
 */
export function buildPersonalityPrompt(args: {
  identitiesSection: string;
  emojisSection: string;
  existingMemoriesSummary: string;
}): string {
  return `You are extracting atomic long-term memories from a Discord conversation.
Messages are labeled: [timestamp] [DisplayName (id:DISCORD_USER_ID)] content. Images appear after the message that shared them.

THE 30-DAY TEST (apply this before everything else):
Save only knowledge that will still be true and useful in 30 days — jobs, preferences, relationships, recurring
habits, skills, goals, server culture. NEVER record the conversation itself: that someone asked, confirmed,
declined, arrived, responded, reacted, or shared something is transcription, not a memory. Record what a message
REVEALS about the person, never what the message DID.

OUTPUT RULES (the most important part):
1. Each "content" field MUST be ≤80 characters. One atomic fact per row. If you notice two things, emit two observations.
2. Write as if editing Wikipedia infobox fields, not a personality essay. Use plain declarative sentences.
3. FORBIDDEN phrases — do NOT use any of these or similar editorializing:
   - "reinforcing his pattern of ..."
   - "continuing his pattern of ..."
   - "boundary-pushing" / "edgy" / "absurdist" / "self-deprecating" as summary adjectives
   - "reflecting interest in ..."
   - "indicating a/his/her ..."
   - "suggesting a preference for ..."
   Describe what someone DID or IS, not what it signals or reinforces.
4. Skip if already known (see existing memories below). "Already known" means the same fact with different wording,
   examples, or emojis. If you'd write a 5th version of "Jason uses racially charged humor", DON'T. Save a
   personality memory only for a NEW trait or a clear CHANGE in a known one.
5. Subject normalization: "subject" MUST be the person's CURRENT display name — the name their identities entry
   below starts with (never the "formerly" name). Never use nicknames, in-game names, @handles or old usernames.
   "subject_user_id" MUST be their Discord ID (the id on that line, never an "also posts as" account's) — it is the
   stable identity anchor even when display names change. For server-wide observations use subject "server" with
   no subject_user_id.

CATEGORIES (pick the right one — some expire automatically):
- "fact": durable facts — jobs, locations, hobbies, relationships, possessions, skills, goals
- "preference": stated likes/dislikes and strong opinions (not casual one-off reactions)
- "personality": communication style and traits (NEW traits or clear changes only — see rule 4)
- "event": plans, outings, milestones, things that happened. Anything time-bound MUST be "event" (never "fact") —
  events expire automatically after ~2 weeks, so stale plans never pollute the bot's memory.
- "vibe": server-wide culture — in-jokes, running bits, group dynamics (subject "server")
- "image": a shared image/GIF/meme worth noting. Any observation describing an image share MUST be "image" — these
  expire automatically after ~a day. If an image reveals a DURABLE fact (bought a car, got injured, moved house),
  save that fact as "fact" instead of describing the share.

WHAT NOT TO EXTRACT:
- Small talk, greetings, reactions to the current moment
- Conversation logistics — who asked, confirmed, declined, arrived, responded (fails the 30-day test)
- Single emoji usages or reactions (a person's habitual emoji style belongs in ONE personality memory described in words — never paste emoji syntax into a memory)
- Personality restatements of a known pattern
- Things only inferred from what others say about them — only first-hand evidence
- Real names, aliases, or nicknames — those go in identity_updates, never in observations

GOOD vs BAD examples:
  GOOD: {"category":"fact","subject":"Jason","subject_user_id":"456","content":"Still plays on PS4."}
  BAD:  {"category":"fact","subject":"Jason","content":"Mentioned he is still using a PS4, indicating a preference for older gaming hardware."}

  GOOD: {"category":"fact","subject":"Simon","subject_user_id":"789","content":"Goal: lose 40 kg."}
  BAD:  {"category":"fact","subject":"Simon","content":"Asked what the group is getting from Costco, indicating active participation in planning."}

  GOOD: {"category":"event","subject":"server","content":"Costco run + BBQ planned for Sunday June 7."}
  BAD:  {"category":"fact","subject":"server","content":"Group plans Costco run at 11am Sunday before 2pm BBQ."}

  GOOD: {"category":"image","subject":"Jason","subject_user_id":"456","content":"Shared a meme about League ranked anxiety."}
  BAD:  {"category":"personality","subject":"Jason","content":"Shared a Tenor GIF of a dancing man, reinforcing his pattern of absurdist humor."}

  GOOD: {"category":"personality","subject":"Jason","subject_user_id":"456","content":"Edgy humor, loves winding people up."}
  BAD:  {"category":"personality","subject":"Jason","content":"Uses absurdist, boundary-pushing humor by sharing a joke ... reinforcing his pattern of edgy commentary."}

  GOOD: {"category":"vibe","subject":"server","content":"Group in-joke: Dillon cast as the villain."}
  BAD:  {"category":"vibe","subject":"server","content":"Group frequently engages in playful teasing of Dillon in a boundary-pushing manner."}

IDENTITY UPDATES: If someone reveals or is consistently called by a real name / alias / nickname, add an entry in "identity_updates" keyed on their Discord ID. Use "irl_name" for a real name ("Derrick"), "aliases_add" for nicknames. Direct evidence only.
${args.identitiesSection}${args.emojisSection}
Existing memories (skip if semantically covered):
${args.existingMemoriesSummary}

Respond ONLY with a JSON object. If nothing worth saving, respond with {"observations": []}.
{
  "observations": [
    {"category": "fact|preference|personality|event|vibe|image", "subject": "CurrentDisplayName|server", "subject_user_id": "discord-id-if-person", "content": "atomic ≤80-char statement"}
  ],
  "identity_updates": [
    {"discord_user_id": "123", "irl_name": "Derrick", "aliases_add": ["Derek", "D"]}
  ]
}`;
}

/**
 * Builds the pass-2 (self-improvement) prompt. Exported as a pure function so tests can assert the
 * dedup/30-day/asked rules are present.
 *
 * The asked rule exists because the digest filled with capability_gap entries like "Cannot react to shared
 * meme or comic images": nobody had pinged the bot, it stayed quiet as designed, and the learner read the
 * silence as inability. The transcript also leaves out the bot's own replies, so every ping looks
 * unanswered; only what people say next can show a real failure.
 */
export function buildSelfImprovementPrompt(args: {
  botName: string;
  /** The bot's Discord id, so the model can recognize `<@id>` mentions in the raw message text. */
  botUserId?: string;
  existingSelfImprovementSummary: string;
}): string {
  const mention = args.botUserId ? `; it is mentioned as <@${args.botUserId}>` : '';
  return `You are looking for bot self-improvement signals in a Discord conversation for a bot called "${args.botName}".
Messages: [timestamp] [DisplayName (id:DISCORD_USER_ID)] content. Bot name: "${args.botName}" (also "fridge", "fridge bot", "bot")${mention}.
The bot's own replies are NOT shown in this transcript, so a message without a visible answer tells you nothing about whether the bot answered it.

OUTPUT RULES:
1. Each "content" MUST be ≤80 characters. One atomic issue per row.
2. Plain declarative sentences. NO boilerplate like "bot should offer a simple, context-aware fallback response (e.g., '...')". Just state the gap.
3. STRONG dedup rule: if the issue is already in existing observations with a different example (different URL, different emoji, different GIF), DO NOT save it. A new YouTube link example of an already-documented YouTube-link gap is NOT a new observation. The existing observations are injected below — re-saving anything semantically covered there is the #1 failure mode of this task.
4. Only save when the issue is NEW or notably more severe than existing entries.
5. The 30-day test: save lasting gaps and behavior patterns, never single missed messages. "User shared X and got no bot response" is transcription of one moment, not an issue — if there is a real underlying gap, state the gap itself ("Cannot join voice chat when asked"), and only if it is not already saved.
6. The asked rule: a capability_gap needs BOTH (a) someone asked the bot to do something — mentioned it, replied to it, or clearly talked to it by name — AND (b) it failed, errored, or said it couldn't. Since its replies aren't shown, (b) comes from what people say next ("fridge can't even open tiktoks", "it said it can't watch videos", someone asking it again because it got it wrong). Posts nobody asked the bot about are NEVER gaps: the bot only talks when it is talked to, so not reacting to a meme, image, comic, video, link or voice message that nobody pointed it at is intended behavior, not an inability.

Categories:
- capability_gap: Bot was asked to process something (link, attachment, emoji type, etc.) and couldn't (see rule 6)
- pain_point: User frustration with bot behavior (too verbose, responds when not asked, forgets context, etc.)
- feature_request: Explicit user wish for a missing feature
- improvement_idea: Concrete behavioral tweak (shorter responses in channel X, better emoji use, etc.)

DO NOT SAVE:
- Things the bot already does well
- Jokey roasting (friends ribbing the bot is not a pain_point)
- Re-statements of known limitations with new examples (see rule 3)
- "User shared X but received no bot engagement" entries — that is one missed message, not a lasting issue (see rule 5)
- Gaps inferred from posts nobody asked the bot about — the bot staying quiet there is by design (see rule 6)
- Custom emoji interpretation — the bot CAN see custom server emojis (see list injected in the personality prompt). Do NOT log capability_gap entries claiming the bot can't read them.

GOOD vs BAD examples:
  GOOD: {"category":"capability_gap","subject":"bot","content":"Cannot read restaurant receipts for bill splitting."}
  BAD:  {"category":"capability_gap","subject":"bot","content":"Bot cannot interpret or respond to restaurant receipts (e.g., Cocodak receipt) even when users share them for group expense tracking, treating them as unprocessable media instead of acknowledging their financial, culinary, or social relevance."}

  BAD:  {"category":"capability_gap","subject":"bot","content":"Cannot react to shared meme or comic images"}
        (people posted memes and nobody asked the bot about them: it stays quiet unless talked to, which is not a gap)
  GOOD: {"category":"capability_gap","subject":"bot","content":"Can't join voice chat when asked to."}
        (someone pinged it to hop in VC, then said "right, you can't even join voice")

  GOOD: {"category":"pain_point","subject":"bot","content":"Responses too long for meme-channel pace."}
  BAD:  {"category":"improvement_idea","subject":"bot","content":"Bot should default to clean, consistent formatting (e.g., bullet points, @mentions, aligned tables) for financial splits unless explicitly overridden, to reduce user frustration and improve usability during group expense coordination."}

Existing self-improvement observations (skip anything semantically covered):
${args.existingSelfImprovementSummary}

Respond ONLY with a JSON object. If nothing actionable, respond with {"observations": []}.
{
  "observations": [
    {"category": "capability_gap|pain_point|feature_request|improvement_idea", "subject": "bot|server|DisplayName", "subject_user_id": "discord-id-if-person", "content": "atomic ≤80-char issue"}
  ]
}`;
}

// Image parts per learner request: every image is paid vision input, and a busy meme channel can post
// dozens between cycles. The newest ones are kept; older ones become a text placeholder.
export const MAX_LEARNER_IMAGES = 8;
const IMAGE_PLACEHOLDER = '[image not shown]';
const MAX_VOICE_TRANSCRIPT_CHARS = 2_000;
const PER_PERSON_MEMORY_LIMIT = 25;

/**
 * Keeps the `max` most recent image parts (parts are in chronological order) and replaces older ones
 * with a text placeholder, so the model still knows those messages carried an image.
 */
export function capImageParts(
  parts: ChatCompletionContentPart[],
  max: number,
): { parts: ChatCompletionContentPart[]; kept: number; dropped: number } {
  const imageIndexes = parts.flatMap((part, index) => (part.type === 'image_url' ? [index] : []));
  const dropped = Math.max(0, imageIndexes.length - max);
  const drop = new Set(imageIndexes.slice(0, dropped));
  return {
    parts: parts.map((part, index) => (drop.has(index) ? { type: 'text', text: IMAGE_PLACEHOLDER } : part)),
    kept: imageIndexes.length - dropped,
    dropped,
  };
}

/** Image URLs a message carries: image attachments, then one preview image per embed. */
function imageUrls(msg: Message): string[] {
  const urls: string[] = [];
  for (const attachment of msg.attachments.values()) {
    if (attachment.contentType?.startsWith('image/') && attachment.url) urls.push(attachment.url);
  }
  for (const embed of msg.embeds) {
    // Discord's media proxy over the third-party origin, like the chat agent: the origin may be
    // hotlink-protected or gone, the proxy serves what Discord already cached.
    const image = embed.image ?? embed.thumbnail;
    const url = image?.proxyURL || image?.url;
    if (url) urls.push(url);
  }
  return urls;
}

/** A transcript the media feature already produced for this message. Cache only: the learner never pays to transcribe. */
function cachedTranscript(messageId: string): string | undefined {
  try {
    const transcript = getCachedTranscript(messageId)?.trim();
    if (!transcript) return undefined;
    return transcript.length > MAX_VOICE_TRANSCRIPT_CHARS
      ? `${transcript.slice(0, MAX_VOICE_TRANSCRIPT_CHARS - 1)}…`
      : transcript;
  } catch (error) {
    logger.warn(`PersonalityLearner: transcript lookup failed for message ${messageId}:`, error);
    return undefined;
  }
}

/** Snowflake order: timestamp first, then the id itself (equal-length decimal strings compare lexically). */
function isNewer(a: Message, b: Message): boolean {
  if (a.createdTimestamp !== b.createdTimestamp) return a.createdTimestamp > b.createdTimestamp;
  return a.id.length !== b.id.length ? a.id.length > b.id.length : a.id > b.id;
}

/** A fetched message the learner looks at, attributed to the person who wrote it. */
type ObservedMessage = {
  msg: Message;
  /** Discord id of the real author; absent only for an old relay whose author could not be matched. */
  authorId?: string;
  authorName: string;
  source: 'human' | 'relay';
};

export type PersonalityLearnerOptions = {
  intervalMs?: number;
  minMessages?: number;
  /** OpenRouter client; defaults to the shared one (tests inject a replay client). */
  client?: OpenAI;
};

export class PersonalityLearner {
  private readonly store: MemoryStore;
  private readonly intervalMs: number;
  private readonly minMessages: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly activeChannels = new Set<string>();
  private readonly ignoredChannels: Set<string>;
  private client: OpenAI | undefined;
  // A cycle can outlast the interval (slow model, many channels); the next tick must not start a
  // second one that re-reads the same watermarks and saves every observation twice.
  private cycleInFlight = false;

  constructor(store: MemoryStore, opts: PersonalityLearnerOptions = {}) {
    this.store = store;
    this.intervalMs = opts.intervalMs ?? config.learner.intervalMs;
    this.minMessages = opts.minMessages ?? config.learner.minMessages;
    this.ignoredChannels = new Set(config.learner.ignoredChannels);
    this.client = opts.client;
  }

  start(discordClient: Client): void {
    if (this.timer) return;

    logger.info(`PersonalityLearner started (interval: ${this.intervalMs}ms, min messages: ${this.minMessages})`);

    this.timer = setInterval(() => {
      void this.observeOnce(discordClient);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('PersonalityLearner stopped.');
    }
  }

  trackActivity(channelId: string): void {
    if (this.ignoredChannels.has(channelId)) return;
    this.activeChannels.add(channelId);
  }

  /**
   * One observation cycle over the channels that saw activity since the last one. Never throws. When
   * the previous cycle is still running this one is skipped, and the channels it would have handled
   * stay queued for the next tick.
   */
  async observeOnce(discordClient: Client): Promise<void> {
    if (this.cycleInFlight) {
      logger.warn('PersonalityLearner: previous observation cycle still running, skipping this tick');
      return;
    }
    this.cycleInFlight = true;
    try {
      await this.observe(discordClient);
    } catch (error) {
      logger.error('PersonalityLearner observation failed:', error);
    } finally {
      this.cycleInFlight = false;
    }
  }

  private buildRelevantMemoriesSummary(observed: ObservedMessage[]): string {
    // Fetch memories keyed on who actually participated in this batch, plus server-wide
    // and bot-subject context. Avoids dumping all ~1000 memories into every prompt. A participant's
    // memories are looked up by their Discord id and every name they have had, so rows filed under an
    // old display name still count as "already known".
    const seen = new Set<number>();
    const chunks: string[] = [];

    const push = (rows: { id: number; category: string; subject: string; content: string }[]) => {
      for (const m of rows) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        chunks.push(`- [${m.category}] ${m.subject}: ${m.content}`);
      }
    };

    // authorId is already the main account (attributeMessage), and memoryKeyFor adds the names of
    // every linked account.
    const participants = new Map<string, { userId?: string; names: string[] }>();
    for (const o of observed) {
      const key = o.authorId ?? `name:${o.authorName}`;
      if (participants.has(key)) continue;
      participants.set(
        key,
        o.authorId ? memoryKeyFor(this.store, o.authorId, [o.authorName]) : { names: [o.authorName] },
      );
    }

    for (const participant of participants.values()) {
      push(this.store.getForPerson(participant, PER_PERSON_MEMORY_LIMIT));
    }
    push(this.store.getBySubject('server', 25));

    if (chunks.length === 0) return '(none yet)';
    return chunks.join('\n');
  }

  private formatLearnerIdentitiesSection(identities: Identity[]): string {
    if (identities.length === 0) return '';

    // The shared SERVER PEOPLE lines: each starts with the member's current display name (the subject to
    // use), then their @handle and id. The handle is spelled out because the model once filed memories
    // under "lapinlune", a handle, instead of the member. Side accounts are folded into their member.
    const lines = formatIdentityLines(identities);
    return `\nKnown server identities (each line starts with the member's CURRENT display name, then their @Discord handle and Discord ID). A Discord handle, a "formerly" name or an "also posts as" account is never a subject: use the name the line starts with and its id. Do NOT repeat this info in observations; use identity_updates for new aliases or real names:\n${lines.join('\n')}\n`;
  }

  private formatLearnerEmojisSection(): string {
    const emojis = this.store.getUsableEmojis();
    if (emojis.length === 0) return '';

    return `\nKnown server custom emojis (the bot can see/interpret these — do NOT log capability_gap entries claiming otherwise):\n${formatEmojiLines(emojis).join('\n')}\n`;
  }

  private getClient(): OpenAI | undefined {
    this.client ??= getOpenRouterClient();
    return this.client;
  }

  /**
   * Humans, plus the bot's relays of them (link-fix and regret reposts, which Discord marks as bot
   * messages), attributed to the real author; other bots, integrations and the bot's own replies are
   * dropped. Returned in chronological order.
   */
  private attributeAll(messages: Message[], identitiesById: Map<string, Identity>): ObservedMessage[] {
    const observed: ObservedMessage[] = [];
    for (const msg of [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
      const attribution = attributeMessage(msg);
      if (!attribution) continue;
      // Fetched history usually lacks member data (no nickname); the identities table carries each
      // member's current display name, which is what observation subjects must use.
      const known = attribution.authorId ? identitiesById.get(attribution.authorId)?.display_name : undefined;
      observed.push({
        msg,
        authorId: attribution.authorId,
        authorName: known ?? attribution.authorName,
        source: attribution.source,
      });
    }
    return observed;
  }

  /**
   * Safety net for the identityTracker event (which misses messages during downtime). Fetched history
   * rarely carries member data, and without it the only names on hand are the global display name or
   * username — which must never overwrite a known server nickname, so those only seed unknown members.
   * The Discord handle is always on the author, so it is recorded either way. Only called for human
   * messages: a relay's author is the webhook, whose "username" is the member's display name.
   */
  private refreshIdentity(msg: Message): void {
    try {
      const username = msg.author.username || undefined;
      const memberName = msg.member?.displayName;
      const known = this.store.getIdentityById(msg.author.id);
      if (memberName) {
        this.store.upsertIdentity(msg.author.id, memberName, username);
      } else if (known) {
        if (username && known.username !== username)
          this.store.upsertIdentity(msg.author.id, known.display_name, username);
      } else {
        const fallback = msg.author.displayName || msg.author.username;
        if (fallback) this.store.upsertIdentity(msg.author.id, fallback, username);
      }
    } catch (error) {
      logger.warn('PersonalityLearner: upsertIdentity failed:', error);
    }
  }

  /**
   * Interleaved content parts, one text line per message (plus a cached voice transcript when there is
   * one) followed by its images, capped at MAX_LEARNER_IMAGES image parts.
   */
  private buildMessageParts(observed: ObservedMessage[], channelId: string): ChatCompletionContentPart[] {
    const parts: ChatCompletionContentPart[] = [];
    for (const o of observed) {
      const ts = formatTimestampET(o.msg.createdAt);
      const idSuffix = o.authorId ? ` (id:${o.authorId})` : '';
      parts.push({ type: 'text', text: `[${ts}] [${o.authorName}${idSuffix}] ${o.msg.content}` });
      const transcript = cachedTranscript(o.msg.id);
      if (transcript) parts.push({ type: 'text', text: `[voice message transcript: ${transcript}]` });
      for (const url of imageUrls(o.msg)) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }

    const capped = capImageParts(parts, MAX_LEARNER_IMAGES);
    if (capped.dropped > 0) {
      logger.info(
        `PersonalityLearner: Including ${capped.kept} images from channel ${channelId}, dropped ${capped.dropped} older ones (cap ${MAX_LEARNER_IMAGES} per request)`,
      );
    } else if (capped.kept > 0) {
      logger.info(`PersonalityLearner: Including ${capped.kept} images from channel ${channelId}`);
    }
    return capped.parts;
  }

  /**
   * Files an observation under the member it is about: a subject_user_id that belongs to a member wins
   * and its member's current display name becomes the subject (the model sometimes writes a nickname);
   * otherwise the name is matched against every name the members go by (an id no member has, e.g. one
   * copied from the prompt's examples or a garbled snowflake, is ignored rather than stored); 'server'/
   * 'bot' (lowercased) never carry an id. The id is always the member's MAIN account (a side account's
   * id or name counts as its member).
   */
  private normalizeSubject(
    rawSubject: string,
    rawUserId: unknown,
    members: Member[],
  ): { subject: string; subjectUserId?: string } {
    const subject = rawSubject.trim();
    if (NON_PERSON_SUBJECTS.has(nameKey(subject))) return { subject: nameKey(subject) };

    // A JSON number cannot hold a snowflake exactly (18+ digits exceed 2^53), so only strings count.
    const rawId = typeof rawUserId === 'string' ? rawUserId.trim() : '';
    if (/^\d+$/.test(rawId)) {
      const member = members.find((m) => m.userId === canonicalUserId(rawId));
      if (member) return { subject: member.displayName, subjectUserId: member.userId };
    }

    const match = matchMemberByName(members, subject);
    return match ? { subject: match.displayName, subjectUserId: match.userId } : { subject };
  }

  /**
   * Applies one of the model's identity_updates. Its fields are untrusted JSON (null, numbers, a string
   * where a list belongs), and the model is a background guesser: it only fills in a real name when
   * none is on record (a name members gave through set_member_info is never replaced by a joke read as
   * a real name), and adds a nickname only when set_member_info would and no other member goes by it in
   * any form. Returns whether the identity changed.
   */
  private applyIdentityUpdate(update: unknown, label: string): boolean {
    if (!update || typeof update !== 'object') return false;
    const { discord_user_id: rawId, irl_name: rawIrl, aliases_add: rawAliases } = update as Record<string, unknown>;
    const accountId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!accountId) return false;
    // Real names and nicknames belong to the person: a side account's update goes on the main
    // account's row (the side row keeps only its own display name and handle), when there is one.
    const mainId = canonicalUserId(accountId);
    const target = this.store.getIdentityById(mainId) ? mainId : accountId;
    const identity = this.store.getIdentityById(target);
    if (!identity) return false;
    const who = `${identity.display_name} (${target})`;

    let irlName: string | undefined;
    const irl = parseMemberName(rawIrl);
    if (irl === 'invalid') {
      logger.info(`${label}: ignoring a real name for ${who} that is not a name`);
    } else if (irl && !identity.irl_name) {
      irlName = irl;
    } else if (irl && identity.irl_name && nameKey(irl) !== nameKey(identity.irl_name)) {
      logger.info(`${label}: keeping ${who}'s real name "${identity.irl_name}" over the suggested "${irl}"`);
    }

    const aliases: string[] = [];
    for (const raw of Array.isArray(rawAliases) ? rawAliases : []) {
      const alias = parseMemberName(raw);
      if (!alias || alias === 'invalid' || aliases.some((a) => nameKey(a) === nameKey(alias))) continue;
      const check = checkNickname(this.store, mainId, identity.display_name, alias);
      if (check.alreadyKnown) continue;
      const reason = check.refusal ?? check.note;
      if (reason) {
        logger.info(`${label}: not adding nickname "${alias}" to ${who}: ${reason}`);
        continue;
      }
      aliases.push(alias);
    }

    const changed = this.store.updateIdentityMeta(target, { irl_name: irlName, aliases_add: aliases });
    if (changed) {
      const parts = [
        ...(irlName ? [`real name ${irlName}`] : []),
        ...(aliases.length > 0 ? [`nicknames ${aliases.map((a) => `"${a}"`).join(', ')}`] : []),
      ];
      logger.info(`${label}: identity update for ${who}: ${parts.join('; ')}`);
    }
    return changed;
  }

  /**
   * Sends content parts to an LLM, parses the JSON response, and saves valid observations +
   * identity updates. Returns counts of what was saved.
   */
  private async analyzeAndSave(
    openai: OpenAI,
    model: string,
    contentParts: ChatCompletionContentPart[],
    channelId: string,
    source: string,
    label: string,
    feature: UsageFeature,
  ): Promise<{ observations: number; identityUpdates: number }> {
    logger.info(`${label}: Sending request to ${model} for channel ${channelId}`);

    const response = await openai.chat.completions.create(
      {
        model,
        max_tokens: 1536,
        temperature: 0.3,
        messages: [{ role: 'user', content: contentParts }],
        // @ts-expect-error OpenRouter-specific field
        provider: { zdr: true },
      },
      featureRequestOptions(feature),
    );

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return { observations: 0, identityUpdates: 0 };

    const parsed = parseLearnerOutput(text);
    if (!parsed) {
      logger.warn(`${label}: Failed to parse JSON for channel ${channelId}. Raw: ${text.slice(0, 200)}`);
      return { observations: 0, identityUpdates: 0 };
    }

    const members = foldMembers(this.store.getAllIdentities());
    let observations = 0;
    // The parser only guarantees arrays: every field is checked here, because one malformed entry (a
    // null, a number) must not throw and cost the whole cycle (the watermark only advances after it).
    for (const raw of parsed.observations as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const obs = raw as Record<string, unknown>;
      if (typeof obs.category !== 'string' || typeof obs.subject !== 'string' || !obs.subject.trim()) continue;
      if (typeof obs.content !== 'string' || !obs.content.trim()) continue;

      // Runtime whitelist: the parser doesn't validate categories, and the TTL sweep keys on exact
      // strings — an invented category would silently produce a never-expiring memory.
      const category = normalizeObservationCategory(obs.category);
      if (!category) {
        logger.warn(`${label}: Dropping observation with unknown category '${obs.category}': ${obs.content}`);
        continue;
      }

      const { subject, subjectUserId } = this.normalizeSubject(obs.subject, obs.subject_user_id, members);
      await this.store.save({
        category,
        subject,
        content: obs.content,
        source,
        subject_user_id: subjectUserId,
      });
      observations++;
    }

    let identityUpdates = 0;
    for (const update of (parsed.identity_updates ?? []) as unknown[]) {
      try {
        if (this.applyIdentityUpdate(update, label)) identityUpdates++;
      } catch (error) {
        logger.warn(`${label}: Skipping an identity update that failed for channel ${channelId}:`, error);
      }
    }

    return { observations, identityUpdates };
  }

  private async observe(discordClient: Client): Promise<void> {
    const channelsToProcess = [...this.activeChannels];
    this.activeChannels.clear();

    if (channelsToProcess.length === 0) return;

    logger.info(`PersonalityLearner: Observation cycle started — ${channelsToProcess.length} active channel(s)`);

    const openai = this.getClient();
    if (!openai) {
      logger.warn('PersonalityLearner: No OPENROUTER_API_KEY, skipping observation.');
      return;
    }

    const botName = discordClient.user?.displayName ?? 'Frigidaire';
    const selfImprovementEnabled = config.learner.selfImprovementEnabled;

    for (const channelId of channelsToProcess) {
      try {
        await this.observeChannel(discordClient, openai, channelId, botName, selfImprovementEnabled);
      } catch (error) {
        logger.error(`PersonalityLearner: Error processing channel ${channelId}:`, error);
      }
    }
  }

  private async observeChannel(
    discordClient: Client,
    openai: OpenAI,
    channelId: string,
    botName: string,
    selfImprovementEnabled: boolean,
  ): Promise<void> {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const textChannel = channel as TextChannel;
    const lastMessageId = this.store.getLastObserved(channelId);

    const fetchOptions: { limit: number; after?: string } = { limit: 100 };
    if (lastMessageId) {
      fetchOptions.after = lastMessageId;
    }

    const messages: Collection<string, Message> = await textChannel.messages.fetch(fetchOptions);
    if (messages.size === 0) return;

    const fetched = [...messages.values()];
    let observed = this.attributeAll(fetched, this.identitiesById());

    if (observed.length < this.minMessages) {
      logger.info(
        `PersonalityLearner: Skipping channel ${channelId} — only ${observed.length}/${this.minMessages} messages`,
      );
      return;
    }

    const relayed = observed.filter((o) => o.source === 'relay').length;
    logger.info(
      `PersonalityLearner: Processing ${observed.length} messages (${relayed} relayed) from channel ${channelId} (#${textChannel.name})`,
    );

    // Mechanically upsert identities for every observed author, then re-attribute so labels use the
    // refreshed names.
    for (const o of observed) {
      if (o.source === 'human') this.refreshIdentity(o.msg);
    }
    const identitiesById = this.identitiesById();
    observed = this.attributeAll(fetched, identitiesById);

    const messageParts = this.buildMessageParts(observed, channelId);

    // --- Pass 1: Personality analysis ---
    const activeIdentities = [...identitiesById.values()].filter((i) => i.active !== 0);
    const personalityPrompt = buildPersonalityPrompt({
      identitiesSection: this.formatLearnerIdentitiesSection(activeIdentities),
      emojisSection: this.formatLearnerEmojisSection(),
      existingMemoriesSummary: this.buildRelevantMemoriesSummary(observed),
    });

    const personalityResult = await this.analyzeAndSave(
      openai,
      config.models.learner,
      [{ type: 'text', text: personalityPrompt }, ...messageParts],
      channelId,
      'observation',
      'PersonalityLearner',
      'learner',
    );

    if (personalityResult.observations > 0 || personalityResult.identityUpdates > 0) {
      logger.info(
        `PersonalityLearner: Saved ${personalityResult.observations} observations, ${personalityResult.identityUpdates} identity updates from channel ${channelId}`,
      );
    } else {
      logger.info(`PersonalityLearner: No new observations from channel ${channelId}`);
    }

    // --- Pass 2: Self-improvement analysis (optional) ---
    if (selfImprovementEnabled) {
      try {
        const existingSelfImprovement = SELF_IMPROVEMENT_CATEGORIES.flatMap((cat) => this.store.getByCategory(cat, 60));
        const existingSelfImprovementSummary =
          existingSelfImprovement.length > 0
            ? existingSelfImprovement.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')
            : '(none yet)';

        const selfImprovementPrompt = buildSelfImprovementPrompt({
          botName,
          botUserId: discordClient.user?.id,
          existingSelfImprovementSummary,
        });

        const selfImprovementResult = await this.analyzeAndSave(
          openai,
          config.models.selfImprovement,
          [{ type: 'text', text: selfImprovementPrompt }, ...messageParts],
          channelId,
          'self-improvement',
          'SelfImprovementLearner',
          'self_improvement',
        );

        if (selfImprovementResult.observations > 0) {
          logger.info(
            `SelfImprovementLearner: Saved ${selfImprovementResult.observations} observations from channel ${channelId}`,
          );
        } else {
          logger.info(`SelfImprovementLearner: No new observations from channel ${channelId}`);
        }
      } catch (error) {
        logger.warn('SelfImprovementLearner: Self-improvement pass failed, continuing:', error);
      }
    }

    // Advance the watermark to the newest fetched message (bot messages included: they were seen).
    const newestMessage = fetched.reduce((newest, msg) => (isNewer(msg, newest) ? msg : newest));
    this.store.setLastObserved(channelId, newestMessage.id);
  }

  private identitiesById(): Map<string, Identity> {
    return new Map(this.store.getAllIdentities().map((i) => [i.discord_user_id, i]));
  }
}
