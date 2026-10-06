import { ChannelType, type Client, type Message, type TextChannel } from 'discord.js';
import type OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import { config } from '../config';
import { canonicalUserId } from '../linkedAccounts';
import { logger } from '../logger';
import { loadImageDataUri } from '../reactions/images';
import { attributeMessage } from '../relay';
import { citedEvidence, relatedMembers, type TranscriptLine } from './capture/citations';
import {
  CAPTURE_LIMITS,
  conversationStartIndex,
  readUncaptured,
  type Segment,
  type SizedItem,
  splitIntoSegments,
} from './capture/conversation';
import { buildCaptureKnowledge, type CapturePerson, KNOWN_LIMITS } from './capture/knowledge';
import { type CaptureActivity, type CaptureTrigger, IntervalCaptureTrigger } from './captureTrigger';
import { getCachedTranscript } from './media';
import { getNotesStore } from './memory';
import { type Identity, LEARNER_SOURCES, type MemoryStore, NON_PERSON_SUBJECTS, nameKey } from './memory/memoryStore';
import { getOpenRouterClient } from './openRouterClient';
import {
  checkNickname,
  checkRealName,
  createPeopleMatcher,
  foldMembers,
  type Member,
  matchMemberByName,
  parseMemberName,
} from './people';
import { formatEmojiLines, formatIdentityLines } from './promptSections';
import { featureRequestOptions, type UsageFeature } from './usage';
import { formatTimestampET } from './utils';

// Single source of truth for valid categories — a runtime value (not just a type) because the TTL
// sweep keys on exact category strings: a hallucinated category from the LLM ('Image', 'meme') would
// create a memory that never expires. analyzeAndSave() validates against this list before saving.
const OBSERVATION_CATEGORIES = [
  'fact',
  'preference',
  'personality',
  'event', // a dated milestone; expired by the TTL sweep (~14 days), once its owner's dream has read it
  'vibe',
  // Image/GIF share observations (expired by the TTL sweep, ~24 h): no longer asked for, still accepted from
  // the model and old rows. The dream never reads them (notesStore DREAM_EXCLUDED_CATEGORIES).
  'image',
  'capability_gap',
  'pain_point',
  'feature_request',
  'improvement_idea',
] as const;

export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

// The default learner model (z-ai/glm-5.3-flash) reasons at 'max' unless told otherwise, and reasoning
// counts toward max_tokens: at 'max', the old 1536-token cap could be spent before any JSON was written.
// Each pass asks for 'low' and keeps room for the observations after it: a part is a whole conversation
// (up to ~48k characters) and every observation carries its evidence, so a busy one can run to dozens of
// ~100-token rows. Only generated tokens are billed: the room costs nothing unless it is used.
const LEARNER_MAX_TOKENS = 16_384;
// Requests per pass: an answer that is empty, not the JSON asked for, or cut off at the length limit is
// asked for once more (see analyzeAndSave).
const LEARNER_ATTEMPTS = 2;

type LearnerRequestBody = {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: 'user'; content: ChatCompletionContentPart[] }>;
  reasoning: { effort: 'low' };
  provider: { zdr: true };
};

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
 * The complete observations of an answer cut off at the length limit: the entries of its "observations"
 * array up to the last one that closed (the whole array when the cut came after it, e.g. in
 * identity_updates). Undefined when there is no such array or the cut came before its first entry closed.
 * Strings are skipped with their escapes, so a brace or bracket inside a quote never counts.
 */
export function salvageTruncatedObservations(raw: string): Observation[] | undefined {
  const key = /"observations"\s*:\s*\[/.exec(raw);
  if (!key) return undefined;
  const start = key.index + key[0].length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastEntryEnd = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) break; // the observations array itself closed
      depth--;
      if (depth === 0) lastEntryEnd = i;
    }
  }
  if (lastEntryEnd < 0) return undefined;
  try {
    const entries: unknown = JSON.parse(`[${raw.slice(start, lastEntryEnd + 1)}]`);
    return Array.isArray(entries) && entries.length > 0 ? (entries as Observation[]) : undefined;
  } catch {
    return undefined;
  }
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
Messages are labeled: #N [timestamp] [DisplayName (id:DISCORD_USER_ID)] content, where #N is the line number you cite as evidence. Images appear after the message that shared them.
A part headed "ALREADY COVERED" is the end of the previous part of this conversation, already read: use it to understand what follows, never extract anything from it.

THE 30-DAY TEST (apply this before everything else):
Save only knowledge that will still be true and useful in 30 days — jobs, preferences, relationships, recurring
habits, skills, goals, server culture. NEVER record the conversation itself: that someone asked, confirmed,
declined, arrived, responded, reacted, or shared something is transcription, not a memory. Record what a message
REVEALS about the person, never what the message DID.
Every row you save is folded into the bot's permanent notes about that person (nothing you save just expires):
a row that won't matter next month sits in their notes as noise. Many conversations have nothing worth saving:
{"observations": []} is then the right answer.

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
4. Skip if already known (see what is already known, below). "Already known" means the same fact with different wording,
   examples, or emojis. If you'd write a 5th version of "Jason uses racially charged humor", DON'T. Save a
   personality memory only for a NEW trait or a clear CHANGE in a known one.
5. Subject normalization: "subject" MUST be the person's CURRENT display name — the name their identities entry
   below starts with (never the "formerly" name). Never use nicknames, in-game names, @handles or old usernames.
   "subject_user_id" MUST be their Discord ID (the id on that line, never an "also posts as" account's) — it is the
   stable identity anchor even when display names change. For server-wide observations use subject "server" with
   no subject_user_id.

CATEGORIES (pick the right one):
- "fact": durable facts — jobs, school, where they live, relationships, possessions, skills, goals, the games and
  hobbies they keep coming back to
- "preference": lasting likes/dislikes and strong opinions they hold (not a one-off reaction, not a rating of one
  meal, product or show)
- "personality": communication style and traits (NEW traits or clear changes only — see rule 4)
- "event": something out of the ordinary, with its date (and place, when said) — a milestone that happened (a move,
  a new job, an injury, a breakup, a tournament result, a big purchase) or a plan for one (a trip, an outing somewhere,
  a concert, a tournament): "Ski trip to Tremblant with Dale planned for Feb 2027". When a known plan changes or is
  called off, save that ("Tremblant trip called off"). NEVER the logistics (who drives, who picks up whom, who is
  late, who brings what, what time), routine plans (gaming tonight, dinner later), or what someone ate or watched.
- "vibe": server-wide culture — in-jokes, running bits, group dynamics (subject "server"). Not news from outside the
  server (a streamer's win, game drama, what a card sells for) unless it became a running thing in the group.
A shared image, GIF or meme is never an observation in itself. If an image reveals a DURABLE fact (bought a car,
got injured, moved house), save that fact as "fact" instead of describing the share.

WHAT NOT TO EXTRACT:
- Small talk, greetings, reactions to the current moment
- Conversation logistics — who asked, confirmed, declined, arrived, responded (fails the 30-day test)
- The logistics of a plan (who is driving or bringing what, who is running late) and routine plans (gaming tonight)
- Image, GIF and meme shares, and one-off ratings or reactions (a meal, a product, a video)
- News and trivia from outside the server, unless it reveals something lasting about a member (a pro they follow)
- Feedback about the bot itself (bugs, things it can't do): never an observation about a person
- Single emoji usages or reactions (a person's habitual emoji style belongs in ONE personality memory described in words — never paste emoji syntax into a memory)
- Personality restatements of a known pattern
- Things only inferred from what others say about them — only first-hand evidence
- Real names, aliases, or nicknames — those go in identity_updates, never in observations

GOOD vs BAD examples:
  GOOD: {"category":"fact","subject":"Jason","subject_user_id":"456","content":"Still plays on PS4."}
  BAD:  {"category":"fact","subject":"Jason","content":"Mentioned he is still using a PS4, indicating a preference for older gaming hardware."}

  GOOD: {"category":"fact","subject":"Simon","subject_user_id":"789","content":"Goal: lose 40 kg."}
  BAD:  {"category":"fact","subject":"Simon","content":"Asked what the group is getting from Costco, indicating active participation in planning."}

  GOOD: {"category":"event","subject":"Remi","subject_user_id":"321","content":"Moved to Ottawa for a new job (Sept 2026)."}
  GOOD: {"category":"event","subject":"Remi","subject_user_id":"321","content":"Ski trip to Tremblant with Dale planned for Feb 2027."}
  BAD:  {"category":"event","subject":"Remi","content":"Driving Saturday, has 3 seats, picking up Dale."}
  BAD:  {"category":"event","subject":"server","content":"Gaming session planned for tonight."}

  GOOD: (nothing: an image share on its own is not a memory)
  BAD:  {"category":"fact","subject":"Dale","content":"Shared a meme about League ranked anxiety."}

  GOOD: {"category":"personality","subject":"Jason","subject_user_id":"456","content":"Edgy humor, loves winding people up."}
  BAD:  {"category":"personality","subject":"Jason","content":"Uses absurdist, boundary-pushing humor by sharing a joke ... reinforcing his pattern of edgy commentary."}

  GOOD: {"category":"vibe","subject":"server","content":"Group in-joke: Dillon cast as the villain."}
  BAD:  {"category":"vibe","subject":"server","content":"Group frequently engages in playful teasing of Dillon in a boundary-pushing manner."}

IDENTITY UPDATES: If someone reveals or is consistently called by a real name / alias / nickname, add an entry in "identity_updates" keyed on their Discord ID. Use "irl_name" for a real name ("Derrick"), "aliases_add" for nicknames. Direct evidence only.

EVIDENCE: every observation cites where it comes from: "evidence": {"lines": [the #N numbers of the message(s) it is based on], "quote": "the key words, copied character for character from one of those lines (at most 200 characters)"}. The quote is kept as the source of the memory: copy it exactly, never reword it.

PEOPLE AN OBSERVATION IS ALSO ABOUT: a relationship or something shared (dating, roommates, siblings, a rivalry, a trip, a game they play together) is ONE observation filed under one person, with the other members' Discord IDs in "related_user_ids". Leave the field out when the observation is about one person only, and never list someone who is only mentioned in passing.
${args.identitiesSection}${args.emojisSection}
Already known about these people and the server (skip anything semantically covered). "Your notes" are consolidated notes; rows under them are newer:
${args.existingMemoriesSummary}

Respond ONLY with a JSON object. If nothing worth saving, respond with {"observations": []}.
{
  "observations": [
    {"category": "fact|preference|personality|event|vibe", "subject": "CurrentDisplayName|server", "subject_user_id": "discord-id-if-person", "content": "atomic ≤80-char statement", "evidence": {"lines": [12], "quote": "exact words from line 12"}, "related_user_ids": ["other-member-discord-id-if-shared"]}
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
Messages: #N [timestamp] [DisplayName (id:DISCORD_USER_ID)] content (#N is a line number). Bot name: "${args.botName}" (also "fridge", "fridge bot", "bot")${mention}.
A part headed "ALREADY COVERED" was already read: context only, never extract anything from it.
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
// dozens between cycles. The newest ones are kept; older ones become a text placeholder. The kept ones are
// downloaded and inlined (downscaled JPEG data URIs, src/reactions/images.ts): sent as raw Discord URLs,
// OpenRouter fetched them itself, Discord's media proxy refused it now and then, and the whole capture
// failed with a 400 ("Received 403 status code when fetching image from URL"), retry after retry.
export const MAX_LEARNER_IMAGES = 8;
const IMAGE_PLACEHOLDER = '[image not shown]';
const MAX_VOICE_TRANSCRIPT_CHARS = 2_000;
// The headers around a segment's lead-in (src/ai/capture/conversation.ts): the end of the previous segment,
// shown so the new one doesn't start abruptly, never extracted from (the prompts say so).
const LEAD_IN_HEADER =
  '## ALREADY COVERED — context only, do not extract (the end of the previous part of this conversation)';
const CONTINUES_HEADER = '## THE CONVERSATION CONTINUES — extract from here';
// A recently captured channel is re-read after a restart (see PersonalityLearner.start()).
const RESUME_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
// A failed capture is retried this many times in a row, each once the channel has been quiet again.
const MAX_CAPTURE_RETRIES = 3;

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

/**
 * An API error (it carries an HTTP status) as one line: the SDK's error objects log as ~40 lines of headers
 * and stack. Anything else is passed through for the logger to print whole.
 */
function briefError(error: unknown): unknown {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  if (typeof status !== 'number') return error;
  const message = (error as Error).message;
  return message.startsWith(String(status)) ? message : `${status} ${message}`;
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

/** A fetched message the learner looks at, attributed to the person who wrote it. */
type ObservedMessage = {
  msg: Message;
  /** Discord id of the real author; absent only for an old relay whose author could not be matched. */
  authorId?: string;
  authorName: string;
  source: 'human' | 'relay';
};

/** An observed message as a capture transcript line, weighed for the segment split. */
type CaptureItem = SizedItem & {
  observed: ObservedMessage;
  /** `[timestamp] [Name (id:…)] content`: the line without its #N. */
  line: string;
  /** A cached voice transcript, clamped. */
  transcript?: string;
};

/** Sizes a capture works within (tests shrink them); defaults in CAPTURE_LIMITS. */
export type CaptureSizes = {
  /** Messages one capture reads at most. */
  maxMessages?: number;
  /** Characters of transcript per extractor request. */
  segmentMaxChars?: number;
  /** Characters of the previous segment each later one opens with. */
  leadInChars?: number;
};

export type PersonalityLearnerOptions = {
  /** The default trigger's interval (LEARNING_INTERVAL_MS); ignored when `trigger` is given. */
  intervalMs?: number;
  minMessages?: number;
  /** OpenRouter client; defaults to the shared one (tests inject a replay client). */
  client?: OpenAI;
  /**
   * When a channel is read (src/ai/captureTrigger.ts). Defaults to the original fixed interval over every
   * channel with activity; the bot passes memory v2's ConversationEndTrigger (src/ai/learnerInstance.ts).
   */
  trigger?: CaptureTrigger;
  /** The quiet time that separates two conversations (CAPTURE_IDLE_MINUTES): where a first capture starts. */
  idleMs?: number;
  sizes?: CaptureSizes;
  /**
   * An image as an inline data URI, or undefined when it can't be loaded (it becomes a placeholder).
   * Default: loadImageDataUri (Discord-hosted URLs only, downscaled).
   */
  loadImage?: (url: string) => Promise<string | undefined>;
};

export class PersonalityLearner {
  private readonly store: MemoryStore;
  private readonly trigger: CaptureTrigger;
  private readonly minMessages: number;
  private readonly idleMs: number;
  private readonly sizes: Required<CaptureSizes>;
  private readonly loadImage: (url: string) => Promise<string | undefined>;
  private timer: NodeJS.Timeout | undefined;
  private readonly ignoredChannels: Set<string>;
  private client: OpenAI | undefined;
  // A cycle can outlast the interval (slow model, many channels); the next tick must not start a
  // second one that re-reads the same watermarks and saves every observation twice.
  private cycleInFlight = false;
  // Failed captures in a row per channel (see retryLater); cleared by a capture that finishes.
  private readonly captureFailures = new Map<string, number>();

  constructor(store: MemoryStore, opts: PersonalityLearnerOptions = {}) {
    this.store = store;
    this.trigger = opts.trigger ?? new IntervalCaptureTrigger(opts.intervalMs ?? config.learner.intervalMs);
    this.minMessages = opts.minMessages ?? config.learner.minMessages;
    this.idleMs = opts.idleMs ?? config.learner.captureIdleMinutes * 60_000;
    this.sizes = {
      maxMessages: opts.sizes?.maxMessages ?? CAPTURE_LIMITS.maxMessages,
      segmentMaxChars: opts.sizes?.segmentMaxChars ?? CAPTURE_LIMITS.segmentMaxChars,
      leadInChars: opts.sizes?.leadInChars ?? CAPTURE_LIMITS.leadInChars,
    };
    this.ignoredChannels = new Set(config.learner.ignoredChannels);
    this.client = opts.client;
    this.loadImage = opts.loadImage ?? ((url) => loadImageDataUri(url));
  }

  start(discordClient: Client, now: number = Date.now()): void {
    if (this.timer) return;

    logger.info(`PersonalityLearner started (capture: ${this.trigger.describe()}, min messages: ${this.minMessages})`);
    this.resumeRecentChannels(now);

    this.timer = setInterval(() => {
      void this.observeOnce(discordClient);
    }, this.trigger.tickMs);
  }

  /**
   * Activity lives in memory, so a restart (every deploy) forgets conversations still waiting for their
   * capture. The channels captured in the last two weeks are reported to the trigger as a possible backlog:
   * each is read once it has been quiet (a fetch from its watermark, usually empty), and the learner counts
   * what it finds against the minimum itself.
   */
  private resumeRecentChannels(now: number): void {
    try {
      const channels = this.store
        .observedChannelsSince(new Date(now - RESUME_LOOKBACK_MS))
        .filter((channelId) => !this.ignoredChannels.has(channelId));
      for (const channelId of channels) this.trigger.noteBacklog(channelId, now);
      if (channels.length > 0) {
        logger.info(
          `PersonalityLearner: ${channels.length} recently captured channel(s) will be checked for messages missed while offline`,
        );
      }
    } catch (error) {
      logger.warn('PersonalityLearner: could not list recently captured channels:', error);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('PersonalityLearner stopped.');
    }
  }

  /**
   * A member posted in `channelId` (the learnerActivityTracker event): reported to the capture trigger
   * unless the channel is in LEARNER_IGNORE_CHANNELS.
   */
  trackActivity(channelId: string, activity: Omit<CaptureActivity, 'channelId'> = { at: Date.now() }): void {
    if (this.ignoredChannels.has(channelId)) return;
    this.trigger.noteActivity({ ...activity, channelId });
  }

  /**
   * One observation cycle over the channels the capture trigger says are due. Never throws. When the
   * previous cycle is still running this one is skipped and takes nothing, so the pending channels stay
   * with the trigger for the next tick.
   */
  async observeOnce(discordClient: Client, now: number = Date.now()): Promise<void> {
    if (this.cycleInFlight) {
      // Routine on the 1-minute capture tick while a long conversation is being read: not worth a WARN.
      logger.debug('PersonalityLearner: previous observation cycle still running, skipping this tick');
      return;
    }
    this.cycleInFlight = true;
    try {
      await this.observe(discordClient, this.trigger.takeDue(now), now);
    } catch (error) {
      logger.error('PersonalityLearner observation failed:', error);
    } finally {
      this.cycleInFlight = false;
    }
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

  /** An observed message as a transcript line (without its #N), with its cached transcript and its size. */
  private toItem(o: ObservedMessage): CaptureItem {
    const ts = formatTimestampET(o.msg.createdAt);
    const idSuffix = o.authorId ? ` (id:${o.authorId})` : '';
    const line = `[${ts}] [${o.authorName}${idSuffix}] ${o.msg.content}`;
    const transcript = cachedTranscript(o.msg.id);
    // "#N " before the line, and the transcript's own part.
    const chars = line.length + 6 + (transcript ? transcript.length + 30 : 0);
    return { observed: o, line, transcript, at: o.msg.createdTimestamp, chars };
  }

  /**
   * One extractor request's messages: the lead-in (text only, under its "ALREADY COVERED" header) then the
   * segment, one numbered text line per message (plus a cached voice transcript when there is one)
   * followed by its images, capped at MAX_LEARNER_IMAGES image parts, each inlined as a data URI (one that
   * can't be loaded becomes a placeholder). `lines` maps each #N to its message, for the evidence the model
   * cites.
   */
  private async renderSegment(
    segment: Segment<CaptureItem>,
    channelId: string,
  ): Promise<{ parts: ChatCompletionContentPart[]; lines: Map<number, TranscriptLine> }> {
    const parts: ChatCompletionContentPart[] = [];
    const lines = new Map<number, TranscriptLine>();
    const add = (item: CaptureItem, leadIn: boolean) => {
      const n = lines.size + 1;
      parts.push({ type: 'text', text: `#${n} ${item.line}` });
      if (item.transcript) parts.push({ type: 'text', text: `[voice message transcript: ${item.transcript}]` });
      const { msg } = item.observed;
      lines.set(n, {
        line: n,
        messageId: msg.id,
        at: item.at,
        text: item.transcript ? `${msg.content}\n${item.transcript}` : msg.content,
        leadIn,
      });
      if (leadIn) return;
      for (const url of imageUrls(msg)) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    };
    if (segment.leadIn.length > 0) {
      parts.push({ type: 'text', text: LEAD_IN_HEADER });
      for (const item of segment.leadIn) add(item, true);
      parts.push({ type: 'text', text: CONTINUES_HEADER });
    }
    for (const item of segment.items) add(item, false);

    const capped = capImageParts(parts, MAX_LEARNER_IMAGES);
    const inlined = await Promise.all(
      capped.parts.map(async (part): Promise<ChatCompletionContentPart> => {
        if (part.type !== 'image_url') return part;
        const uri = await this.loadImage(part.image_url.url).catch(() => undefined);
        return uri ? { type: 'image_url', image_url: { url: uri } } : { type: 'text', text: IMAGE_PLACEHOLDER };
      }),
    );
    const shown = inlined.filter((part) => part.type === 'image_url').length;
    if (capped.kept > 0 || capped.dropped > 0) {
      const unloaded = capped.kept - shown;
      logger.info(
        `PersonalityLearner: Including ${shown} images from channel ${channelId}${capped.dropped > 0 ? `, dropped ${capped.dropped} older ones (cap ${MAX_LEARNER_IMAGES} per request)` : ''}${unloaded > 0 ? `, ${unloaded} could not be loaded` : ''}`,
      );
    }
    return { parts: inlined, lines };
  }

  /**
   * Whose knowledge the extractor gets for a segment: its authors, in the order they first speak (main
   * ids; a relay counts as its author), then up to KNOWN_LIMITS.referencedPeople members the segment talks
   * about (mentions and names, most referenced first).
   */
  private peopleIn(segment: Segment<CaptureItem>, matcher: (text: string) => Map<string, number>): CapturePerson[] {
    const people: CapturePerson[] = [];
    const authors = new Set<string>();
    for (const { observed } of segment.items) {
      const key = observed.authorId ?? `name:${observed.authorName}`;
      if (authors.has(key)) continue;
      authors.add(key);
      people.push(
        observed.authorId ? { userId: observed.authorId, name: observed.authorName } : { name: observed.authorName },
      );
    }
    const counts = new Map<string, number>();
    for (const item of segment.items) {
      for (const [userId, count] of matcher(`${item.observed.msg.content} ${item.transcript ?? ''}`)) {
        counts.set(userId, (counts.get(userId) ?? 0) + count);
      }
    }
    const referenced = [...counts.entries()]
      .filter(([userId]) => !authors.has(userId))
      .sort((a, b) => b[1] - a[1])
      .slice(0, KNOWN_LIMITS.referencedPeople);
    for (const [userId] of referenced) {
      people.push({ userId, name: this.store.getIdentityById(userId)?.display_name ?? userId });
    }
    return people;
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
   * a real name), only takes one no other member goes by in any form, and adds a nickname only when
   * set_member_info would and no other member goes by it in any form. Returns whether the identity changed.
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
      // Another member's name read as this one's real name (a joke, or two people mixed up) would make
      // that name ambiguous for every lookup and for the startup stamp.
      const check = checkRealName(this.store, mainId, identity.display_name, irl);
      const reason = check.refusal ?? check.note;
      if (reason) logger.info(`${label}: not recording "${irl}" as ${who}'s real name: ${reason}`);
      else irlName = irl;
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
   * identity updates. Each observation keeps the evidence it cites (resolved through `lines`, the
   * request's numbered messages) and, for a relationship or shared thing, the other members involved.
   * Returns counts of what was saved.
   */
  private async analyzeAndSave(
    openai: OpenAI,
    model: string,
    contentParts: ChatCompletionContentPart[],
    channelId: string,
    source: string,
    label: string,
    feature: UsageFeature,
    lines: ReadonlyMap<number, TranscriptLine>,
  ): Promise<{ observations: number; identityUpdates: number }> {
    logger.info(`${label}: Sending request to ${model} for channel ${channelId}`);

    const body: LearnerRequestBody = {
      model,
      max_tokens: LEARNER_MAX_TOKENS,
      temperature: 0.3,
      messages: [{ role: 'user', content: contentParts }],
      reasoning: { effort: 'low' },
      provider: { zdr: true },
    };
    // An answer that is empty, not the JSON asked for, or cut off at the length limit is asked for once
    // more (a fresh sample: a cut at this cap is a runaway, not a long answer). When no answer parses,
    // the complete observations of a cut-off one are kept. Either way the part then counts as read: the
    // same part would fail the same way at every later capture and hold the channel's watermark, and
    // every conversation after it, back for good. A failed call throws (the part is retried later).
    let parsed: LearnerOutput | undefined;
    let salvaged: Observation[] = [];
    for (let attempt = 1; attempt <= LEARNER_ATTEMPTS; attempt++) {
      // The SDK's types know neither `provider` nor OpenRouter's `reasoning` object: bridged here, once.
      const response = await openai.chat.completions.create(
        body as unknown as ChatCompletionCreateParamsNonStreaming,
        featureRequestOptions(feature),
      );
      const choice = response.choices?.[0];
      const text = choice?.message?.content?.trim() ?? '';
      const finish = choice?.finish_reason ?? 'none';
      parsed = text ? parseLearnerOutput(text) : undefined;
      if (parsed) break;
      const cut = finish === 'length';
      if (cut) {
        const complete = salvageTruncatedObservations(text) ?? [];
        if (complete.length > salvaged.length) salvaged = complete;
      }
      const problem = !text ? 'returned nothing' : cut ? 'was cut off at the length limit' : 'returned no JSON';
      const next = attempt < LEARNER_ATTEMPTS ? 'asking again' : 'no attempt left';
      logger.warn(
        `${label}: ${model} ${problem} for channel ${channelId} (finish=${finish}, attempt ${attempt}/${LEARNER_ATTEMPTS}), ${next}.${text && !cut ? ` Raw: ${text.slice(0, 200)}` : ''}`,
      );
    }
    if (!parsed && salvaged.length > 0) {
      logger.warn(
        `${label}: keeping the ${salvaged.length} complete observation(s) of a cut-off answer for channel ${channelId}`,
      );
      parsed = { observations: salvaged };
    }
    if (!parsed) return { observations: 0, identityUpdates: 0 };

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

      const { evidence, observedAt, leadInOnly } = citedEvidence(obs, lines);
      if (leadInOnly) {
        // Taken from the "ALREADY COVERED" lead-in, which the previous part already read: saved again, it
        // would count one message as a second sighting, or file a reworded duplicate.
        logger.info(`${label}: dropping an observation that cites only already-covered lines: ${obs.content}`);
        continue;
      }
      const { subject, subjectUserId } = this.normalizeSubject(obs.subject, obs.subject_user_id, members);
      // Self-improvement rows are about the bot: nobody's journal.
      const related = SELF_IMPROVEMENT_CATEGORIES.includes(category) ? [] : relatedMembers(obs, members, subjectUserId);
      await this.store.save({
        category,
        subject,
        content: obs.content,
        source,
        subject_user_id: subjectUserId,
        ...(evidence ? { evidence } : {}),
        ...(observedAt ? { observed_at: observedAt } : {}),
        ...(related.length > 0 ? { related_user_ids: related } : {}),
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

  private async observe(discordClient: Client, channelsToProcess: string[], now: number): Promise<void> {
    if (channelsToProcess.length === 0) return;

    logger.info(`PersonalityLearner: Observation cycle started — ${channelsToProcess.length} active channel(s)`);

    const openai = this.getClient();
    if (!openai) {
      logger.warn('PersonalityLearner: No OPENROUTER_API_KEY, skipping observation.');
      return;
    }

    const botName = discordClient.user?.displayName ?? 'Frigidaire';
    const selfImprovementEnabled = config.learner.selfImprovementEnabled;

    const started = Date.now();
    for (const channelId of channelsToProcess) {
      try {
        await this.observeChannel(discordClient, openai, channelId, botName, selfImprovementEnabled, now);
        this.captureFailures.delete(channelId);
      } catch (error) {
        logger.error(`PersonalityLearner: Error processing channel ${channelId}:`, briefError(error));
        this.retryLater(channelId, now + (Date.now() - started));
      }
    }
  }

  /**
   * A capture that failed (a Discord read, or an extractor call: an outage) has already been taken from the
   * trigger, and nothing new may be posted in the channel for days: it is reported as a backlog again, so
   * the channel is read once it has been quiet for the idle time after the failure. After
   * MAX_CAPTURE_RETRIES failures in a row (a lasting error, such as lost access) it waits for new activity
   * or a restart instead, so a broken channel never costs a call every twenty minutes.
   */
  private retryLater(channelId: string, at: number): void {
    const failures = (this.captureFailures.get(channelId) ?? 0) + 1;
    if (failures > MAX_CAPTURE_RETRIES) {
      this.captureFailures.delete(channelId);
      logger.warn(
        `PersonalityLearner: capture of channel ${channelId} failed ${failures} times in a row; waiting for new activity`,
      );
      return;
    }
    this.captureFailures.set(channelId, failures);
    this.trigger.noteBacklog(channelId, at);
    logger.info(
      `PersonalityLearner: capture of channel ${channelId} will be retried once it is quiet (retry ${failures}/${MAX_CAPTURE_RETRIES})`,
    );
  }

  /**
   * Captures a due channel: reads everything after its watermark (paged, up to the capture's cap; a channel
   * never captured is read back to the start of its last conversation), splits it into segments when it is
   * too long for one request, and runs the extractor (then the self-improvement pass) on each. The
   * watermark moves after each segment (a first capture's is anchored before the first one), so a failure
   * part-way loses nothing and repeats nothing: the rest is read at the channel's next capture, which the
   * caller schedules (retryLater). A read that stopped at its cap reports the rest as a backlog.
   */
  private async observeChannel(
    discordClient: Client,
    openai: OpenAI,
    channelId: string,
    botName: string,
    selfImprovementEnabled: boolean,
    now: number,
  ): Promise<void> {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const textChannel = channel as TextChannel;
    const watermark = this.store.getLastObserved(channelId);
    const read = await readUncaptured(textChannel.messages, watermark, {
      idleMs: this.idleMs,
      maxMessages: this.sizes.maxMessages,
    });
    if (read.messages.length === 0) return;
    const newestFetched = read.messages[read.messages.length - 1];

    let messages = read.messages;
    let observed = this.attributeAll(messages, this.identitiesById());
    // A first capture's anchor: the newest message before the conversation it reads.
    let anchor: Message | undefined;
    if (!watermark && observed.length > 0) {
      // A first capture reads only the channel's last conversation; the history before it is the bootstrap's.
      const startAt = observed[conversationStartIndex(this.timed(observed), this.idleMs)].msg.createdTimestamp;
      anchor = messages.filter((m) => m.createdTimestamp < startAt).at(-1);
      messages = messages.filter((m) => m.createdTimestamp >= startAt);
      observed = observed.filter((o) => o.msg.createdTimestamp >= startAt);
    }

    if (observed.length < this.minMessages) {
      if (!read.capped) {
        logger.info(
          `PersonalityLearner: Skipping channel ${channelId} — only ${observed.length}/${this.minMessages} messages`,
        );
        return;
      }
      // A full read with hardly any member messages in it (a bot flood): stepped over, not reread forever.
      this.store.setLastObserved(channelId, newestFetched.id);
      this.trigger.noteBacklog(channelId, now);
      return;
    }
    // Set before any part runs: when one fails, the next capture reads on from the anchor (this conversation
    // and whatever followed it) instead of reading back to the newest conversation and leaving this one out.
    if (anchor) this.store.setLastObserved(channelId, anchor.id);

    // Mechanically upsert identities for every observed author, then re-attribute so labels use the
    // refreshed names.
    for (const o of observed) {
      if (o.source === 'human') this.refreshIdentity(o.msg);
    }
    const identitiesById = this.identitiesById();
    observed = this.attributeAll(messages, identitiesById);

    const segments = splitIntoSegments(
      observed.map((o) => this.toItem(o)),
      { maxChars: this.sizes.segmentMaxChars, leadInChars: this.sizes.leadInChars },
    );
    const relayed = observed.filter((o) => o.source === 'relay').length;
    logger.info(
      `PersonalityLearner: Processing ${observed.length} messages (${relayed} relayed) from channel ${channelId} (#${textChannel.name}) in ${segments.length} part(s)`,
    );

    const activeIdentities = [...identitiesById.values()].filter((i) => i.active !== 0);
    const shared = {
      openai,
      channelId,
      botName,
      botUserId: discordClient.user?.id,
      selfImprovementEnabled,
      identitiesSection: this.formatLearnerIdentitiesSection(activeIdentities),
      emojisSection: this.formatLearnerEmojisSection(),
      matcher: createPeopleMatcher([...identitiesById.values()], { excludeNames: [botName] }),
      now: new Date(now),
    };
    const totals = { observations: 0, identityUpdates: 0 };
    for (const [index, segment] of segments.entries()) {
      const result = await this.captureSegment(segment, shared);
      totals.observations += result.observations;
      totals.identityUpdates += result.identityUpdates;
      // Up to the newest message read (bot messages included: they were seen) once the last part is done;
      // up to the part's own last message before that.
      const last = index === segments.length - 1;
      const through = last ? newestFetched : segment.items[segment.items.length - 1].observed.msg;
      this.store.setLastObserved(channelId, through.id);
    }
    if (read.capped) this.trigger.noteBacklog(channelId, now);

    logger.info(
      `capture: channel=${channelId} messages=${observed.length} parts=${segments.length} observations=${totals.observations} identity_updates=${totals.identityUpdates} capped=${read.capped ? 'yes' : 'no'}`,
    );
  }

  /** Observed messages as the timed items the conversation helpers take. */
  private timed(observed: ObservedMessage[]): { at: number }[] {
    return observed.map((o) => ({ at: o.msg.createdTimestamp }));
  }

  /**
   * One extractor request (and the self-improvement pass) over one segment. Throws when the extractor call
   * fails (the caller keeps the watermark before this segment); a failed self-improvement pass is logged.
   */
  private async captureSegment(
    segment: Segment<CaptureItem>,
    ctx: {
      openai: OpenAI;
      channelId: string;
      botName: string;
      botUserId?: string;
      selfImprovementEnabled: boolean;
      identitiesSection: string;
      emojisSection: string;
      matcher: (text: string) => Map<string, number>;
      now: Date;
    },
  ): Promise<{ observations: number; identityUpdates: number }> {
    const { openai, channelId } = ctx;
    const { parts, lines } = await this.renderSegment(segment, channelId);

    // --- Pass 1: Personality analysis ---
    const knowledge = buildCaptureKnowledge({
      store: this.store,
      notes: getNotesStore(this.store),
      people: this.peopleIn(segment, ctx.matcher),
      now: ctx.now,
    });
    const personalityPrompt = buildPersonalityPrompt({
      identitiesSection: ctx.identitiesSection,
      emojisSection: ctx.emojisSection,
      existingMemoriesSummary: knowledge,
    });

    const personalityResult = await this.analyzeAndSave(
      openai,
      config.models.learner,
      [{ type: 'text', text: personalityPrompt }, ...parts],
      channelId,
      LEARNER_SOURCES.observation,
      'PersonalityLearner',
      'memory_capture',
      lines,
    );

    if (personalityResult.observations > 0 || personalityResult.identityUpdates > 0) {
      logger.info(
        `PersonalityLearner: Saved ${personalityResult.observations} observations, ${personalityResult.identityUpdates} identity updates from channel ${channelId}`,
      );
    } else {
      logger.info(`PersonalityLearner: No new observations from channel ${channelId}`);
    }

    // --- Pass 2: Self-improvement analysis (optional) ---
    if (ctx.selfImprovementEnabled) {
      try {
        const existingSelfImprovement = SELF_IMPROVEMENT_CATEGORIES.flatMap((cat) => this.store.getByCategory(cat, 60));
        const existingSelfImprovementSummary =
          existingSelfImprovement.length > 0
            ? existingSelfImprovement.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')
            : '(none yet)';

        const selfImprovementPrompt = buildSelfImprovementPrompt({
          botName: ctx.botName,
          botUserId: ctx.botUserId,
          existingSelfImprovementSummary,
        });

        const selfImprovementResult = await this.analyzeAndSave(
          openai,
          config.models.selfImprovement,
          [{ type: 'text', text: selfImprovementPrompt }, ...parts],
          channelId,
          LEARNER_SOURCES.selfImprovement,
          'SelfImprovementLearner',
          'self_improvement',
          lines,
        );

        if (selfImprovementResult.observations > 0) {
          logger.info(
            `SelfImprovementLearner: Saved ${selfImprovementResult.observations} observations from channel ${channelId}`,
          );
        } else {
          logger.info(`SelfImprovementLearner: No new observations from channel ${channelId}`);
        }
      } catch (error) {
        logger.warn('SelfImprovementLearner: Self-improvement pass failed, continuing:', briefError(error));
      }
    }

    return personalityResult;
  }

  private identitiesById(): Map<string, Identity> {
    return new Map(this.store.getAllIdentities().map((i) => [i.discord_user_id, i]));
  }
}
