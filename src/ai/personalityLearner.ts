import * as process from 'node:process';
import { ChannelType, type Client, type Collection, type Message, type TextChannel } from 'discord.js';
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { logger } from '../logger';
import type { MemoryStore } from './memory/memoryStore';
import { formatTimestampET } from './utils';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MIN_MESSAGES = 5;

export type ObservationCategory =
  | 'fact'
  | 'preference'
  | 'personality'
  | 'event'
  | 'vibe'
  | 'capability_gap'
  | 'pain_point'
  | 'feature_request'
  | 'improvement_idea';

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

export class PersonalityLearner {
  private readonly store: MemoryStore;
  private readonly intervalMs: number;
  private readonly minMessages: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly activeChannels = new Set<string>();
  private readonly ignoredChannels: Set<string>;
  private client: OpenAI | undefined;

  constructor(store: MemoryStore, intervalMs?: number) {
    this.store = store;
    this.intervalMs = intervalMs ?? (Number(process.env.LEARNING_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
    this.minMessages = Number(process.env.MIN_MESSAGES_FOR_OBSERVATION) || DEFAULT_MIN_MESSAGES;
    this.ignoredChannels = new Set((process.env.LEARNER_IGNORE_CHANNELS || '').split(',').filter(Boolean));
  }

  start(discordClient: Client): void {
    if (this.timer) return;

    logger.info(`PersonalityLearner started (interval: ${this.intervalMs}ms, min messages: ${this.minMessages})`);

    this.timer = setInterval(() => {
      this.observe(discordClient).catch((error) => {
        logger.error('PersonalityLearner observation failed:', error);
      });
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

  private buildRelevantMemoriesSummary(subjectsInBatch: Set<string>): string {
    // Fetch memories keyed on who actually participated in this batch, plus server-wide
    // and bot-subject context. Avoids dumping all ~1000 memories into every prompt.
    const seen = new Set<number>();
    const chunks: string[] = [];

    const push = (rows: { id: number; category: string; subject: string; content: string }[]) => {
      for (const m of rows) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        chunks.push(`- [${m.category}] ${m.subject}: ${m.content}`);
      }
    };

    const PER_SUBJECT_LIMIT = 25;
    for (const subject of subjectsInBatch) {
      push(this.store.getBySubject(subject, PER_SUBJECT_LIMIT));
    }
    push(this.store.getBySubject('server', 25));

    if (chunks.length === 0) return '(none yet)';
    return chunks.join('\n');
  }

  private formatLearnerIdentitiesSection(): string {
    const identities = this.store.getAllIdentities().filter((i) => i.active !== 0);
    if (identities.length === 0) return '';

    const lines = identities.map((i) => {
      const namePart =
        i.canonical_name === i.display_name ? i.canonical_name : `${i.canonical_name} (now: ${i.display_name})`;
      const irlPart = i.irl_name ? ` — IRL: ${i.irl_name}` : '';
      const aliasPart = i.aliases.length > 0 ? `. Also called: ${i.aliases.join(', ')}` : '';
      return `- ${namePart} (id:${i.discord_user_id})${irlPart}${aliasPart}`;
    });

    return `\nKnown server identities (Discord ID → canonical name). Do NOT repeat this info in observations; use identity_updates for new aliases or real names:\n${lines.join('\n')}\n`;
  }

  private formatLearnerEmojisSection(): string {
    const emojis = this.store.getUsableEmojis();
    if (emojis.length === 0) return '';

    const lines = emojis.map((e) => {
      const syntax = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
      const captionPart = e.caption ? ` — ${e.caption}` : '';
      return `- ${syntax}${captionPart}`;
    });

    return `\nKnown server custom emojis (the bot can see/interpret these — do NOT log capability_gap entries claiming otherwise):\n${lines.join('\n')}\n`;
  }

  private getClient(): OpenAI | undefined {
    if (!process.env.OPENROUTER_API_KEY) return undefined;
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: { 'X-Title': 'Frigidaire Bot' },
      });
    }
    return this.client;
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
  ): Promise<{ observations: number; identityUpdates: number }> {
    logger.info(`${label}: Sending request to ${model} for channel ${channelId}`);

    const response = await openai.chat.completions.create({
      model,
      max_tokens: 1536,
      temperature: 0.3,
      messages: [{ role: 'user', content: contentParts }],
      // @ts-expect-error OpenRouter-specific field
      provider: { zdr: true },
    });

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return { observations: 0, identityUpdates: 0 };

    const parsed = parseLearnerOutput(text);
    if (!parsed) {
      logger.warn(`${label}: Failed to parse JSON for channel ${channelId}. Raw: ${text.slice(0, 200)}`);
      return { observations: 0, identityUpdates: 0 };
    }

    let observations = 0;
    for (const obs of parsed.observations) {
      if (obs.category && obs.subject && obs.content) {
        this.store.save({
          category: obs.category,
          subject: obs.subject,
          content: obs.content,
          source,
          subject_user_id: obs.subject_user_id,
        });
        observations++;
      }
    }

    let identityUpdates = 0;
    for (const update of parsed.identity_updates ?? []) {
      if (!update.discord_user_id) continue;
      const changed = this.store.updateIdentityMeta(update.discord_user_id, {
        irl_name: update.irl_name,
        aliases_add: update.aliases_add,
      });
      if (changed) identityUpdates++;
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
    const selfImprovementEnabled = (process.env.SELF_IMPROVEMENT_ENABLED ?? 'true') !== 'false';

    for (const channelId of channelsToProcess) {
      try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) continue;

        const textChannel = channel as TextChannel;
        const lastMessageId = this.store.getLastObserved(channelId);

        const fetchOptions: { limit: number; after?: string } = { limit: 100 };
        if (lastMessageId) {
          fetchOptions.after = lastMessageId;
        }

        const messages: Collection<string, Message> = await textChannel.messages.fetch(fetchOptions);
        if (messages.size === 0) continue;

        // Filter out bot messages
        const humanMessages = [...messages.values()].filter((msg) => !msg.author.bot).reverse();

        if (humanMessages.length < this.minMessages) {
          logger.info(
            `PersonalityLearner: Skipping channel ${channelId} — only ${humanMessages.length}/${this.minMessages} messages`,
          );
          continue;
        }

        logger.info(
          `PersonalityLearner: Processing ${humanMessages.length} messages from channel ${channelId} (#${textChannel.name})`,
        );

        // Mechanically upsert identities for every observed author (safety net — the
        // identityTracker event may have missed messages during downtime).
        for (const msg of humanMessages) {
          if (msg.webhookId) continue;
          const name = msg.member?.displayName || msg.author.username;
          if (name) {
            try {
              this.store.upsertIdentity(msg.author.id, name);
            } catch (error) {
              logger.warn('PersonalityLearner: upsertIdentity failed:', error);
            }
          }
        }

        // Build interleaved content parts: text + images per message
        const messageParts: ChatCompletionContentPart[] = [];
        let imageCount = 0;
        for (const msg of humanMessages) {
          const name = msg.member?.displayName || msg.author.username;
          const ts = formatTimestampET(msg.createdAt);
          const idSuffix = !msg.webhookId && !msg.author.bot ? ` (id:${msg.author.id})` : '';
          messageParts.push({ type: 'text', text: `[${ts}] [${name}${idSuffix}] ${msg.content}` });
          // Inline image parts from attachments
          for (const attachment of msg.attachments.values()) {
            if (attachment.contentType?.startsWith('image/')) {
              messageParts.push({ type: 'image_url', image_url: { url: attachment.url } });
              imageCount++;
            }
          }
          // Inline image parts from embeds
          for (const embed of msg.embeds) {
            if (embed.image?.url) {
              messageParts.push({ type: 'image_url', image_url: { url: embed.image.url } });
              imageCount++;
            }
            if (embed.thumbnail?.url) {
              messageParts.push({ type: 'image_url', image_url: { url: embed.thumbnail.url } });
              imageCount++;
            }
          }
        }

        if (imageCount > 0) {
          logger.info(`PersonalityLearner: Including ${imageCount} images from channel ${channelId}`);
        }

        // --- Pass 1: Personality analysis ---
        const subjectsInBatch = new Set<string>();
        for (const msg of humanMessages) {
          const name = msg.member?.displayName || msg.author.username;
          if (name) subjectsInBatch.add(name);
        }

        const existingMemoriesSummary = this.buildRelevantMemoriesSummary(subjectsInBatch);
        const identitiesSection = this.formatLearnerIdentitiesSection();
        const emojisSection = this.formatLearnerEmojisSection();

        const personalityPrompt = `You are extracting atomic long-term memories from a Discord conversation.
Messages are labeled: [timestamp] [DisplayName (id:DISCORD_USER_ID)] content. Images appear after the message that shared them.

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
4. Skip if already known (see existing memories below). "Already known" means the same fact with different wording, examples, or emojis. If you'd write a 5th version of "Jason uses racially charged humor", DON'T.
5. Attribute each observation to the correct person BY DISPLAY NAME in "subject", and include their Discord ID in "subject_user_id" (person-subjects only — omit for "server" or "bot").

WHAT TO EXTRACT:
- Durable facts: jobs, locations, hobbies, relationships, platforms someone uses
- Strong preferences or opinions (stated clearly, not casual reactions)
- Server-wide culture: in-jokes, running bits, group dynamics (subject="server")
- Notable events, plans, milestones
- Images that reveal durable interests (not one-off reactions)

WHAT NOT TO EXTRACT:
- Small talk, greetings, reactions to the current moment
- Personality restatements of a known pattern
- Things only inferred from what others say about them — only first-hand evidence
- Real names, aliases, or nicknames — those go in identity_updates, never in observations

GOOD vs BAD examples:
  GOOD: {"category":"fact","subject":"Jason","subject_user_id":"456","content":"Still plays on PS4."}
  BAD:  {"category":"fact","subject":"Jason","content":"Mentioned he is still using a PS4, indicating a preference for older gaming hardware."}

  GOOD: {"category":"personality","subject":"Jason","subject_user_id":"456","content":"Edgy humor, often with <:trolle:...> reactions."}
  BAD:  {"category":"personality","subject":"Jason","content":"Uses absurdist, boundary-pushing humor by sharing a joke ... reinforcing his pattern of edgy commentary."}

  GOOD: {"category":"vibe","subject":"server","content":"Group in-joke: Dillon cast as the villain."}
  BAD:  {"category":"vibe","subject":"server","content":"Group frequently engages in playful teasing of Dillon in a boundary-pushing manner."}

IDENTITY UPDATES: If someone reveals or is consistently called by a real name / alias / nickname, add an entry in "identity_updates" keyed on their Discord ID. Use "irl_name" for a real name ("Derrick"), "aliases_add" for nicknames. Direct evidence only.
${identitiesSection}${emojisSection}
Existing memories (skip if semantically covered):
${existingMemoriesSummary}

Respond ONLY with a JSON object. If nothing worth saving, respond with {"observations": []}.
{
  "observations": [
    {"category": "fact|preference|personality|event|vibe", "subject": "DisplayName|server", "subject_user_id": "discord-id-if-person", "content": "atomic ≤80-char statement"}
  ],
  "identity_updates": [
    {"discord_user_id": "123", "irl_name": "Derrick", "aliases_add": ["Derek", "D"]}
  ]
}`;

        const personalityParts: ChatCompletionContentPart[] = [
          { type: 'text', text: personalityPrompt },
          ...messageParts,
        ];

        const learnerModel = process.env.LEARNER_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';
        const personalityResult = await this.analyzeAndSave(
          openai,
          learnerModel,
          personalityParts,
          channelId,
          'observation',
          'PersonalityLearner',
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
            const existingSelfImprovement = SELF_IMPROVEMENT_CATEGORIES.flatMap((cat) =>
              this.store.getByCategory(cat, 60),
            );
            const existingSelfImprovementSummary =
              existingSelfImprovement.length > 0
                ? existingSelfImprovement.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')
                : '(none yet)';

            const selfImprovementPrompt = `You are looking for bot self-improvement signals in a Discord conversation for a bot called "${botName}".
Messages: [timestamp] [DisplayName (id:DISCORD_USER_ID)] content. Bot name: "${botName}" (also "fridge", "fridge bot", "bot").

OUTPUT RULES:
1. Each "content" MUST be ≤80 characters. One atomic issue per row.
2. Plain declarative sentences. NO boilerplate like "bot should offer a simple, context-aware fallback response (e.g., '...')". Just state the gap.
3. STRONG dedup rule: if the issue is already in existing observations with a different example (different URL, different emoji, different GIF), DO NOT save it. A new YouTube link example of an already-documented YouTube-link gap is NOT a new observation.
4. Only save when the issue is NEW or notably more severe than existing entries.

Categories:
- capability_gap: Bot couldn't process something users wanted it to (link, attachment, emoji type, etc.)
- pain_point: User frustration with bot behavior (too verbose, responds when not asked, forgets context, etc.)
- feature_request: Explicit user wish for a missing feature
- improvement_idea: Concrete behavioral tweak (shorter responses in channel X, better emoji use, etc.)

DO NOT SAVE:
- Things the bot already does well
- Jokey roasting (friends ribbing the bot is not a pain_point)
- Re-statements of known limitations with new examples (see rule 3)
- Custom emoji interpretation — the bot CAN see custom server emojis (see list injected in the personality prompt). Do NOT log capability_gap entries claiming the bot can't read them.

GOOD vs BAD examples:
  GOOD: {"category":"capability_gap","subject":"bot","content":"Cannot read restaurant receipts for bill splitting."}
  BAD:  {"category":"capability_gap","subject":"bot","content":"Bot cannot interpret or respond to restaurant receipts (e.g., Cocodak receipt) even when users share them for group expense tracking, treating them as unprocessable media instead of acknowledging their financial, culinary, or social relevance."}

  GOOD: {"category":"pain_point","subject":"bot","content":"Responses too long for meme-channel pace."}
  BAD:  {"category":"improvement_idea","subject":"bot","content":"Bot should default to clean, consistent formatting (e.g., bullet points, @mentions, aligned tables) for financial splits unless explicitly overridden, to reduce user frustration and improve usability during group expense coordination."}

Existing self-improvement observations (skip anything semantically covered):
${existingSelfImprovementSummary}

Respond ONLY with a JSON object. If nothing actionable, respond with {"observations": []}.
{
  "observations": [
    {"category": "capability_gap|pain_point|feature_request|improvement_idea", "subject": "bot|server|DisplayName", "subject_user_id": "discord-id-if-person", "content": "atomic ≤80-char issue"}
  ]
}`;

            const selfImprovementParts: ChatCompletionContentPart[] = [
              { type: 'text', text: selfImprovementPrompt },
              ...messageParts,
            ];

            const selfImprovementModel =
              process.env.SELF_IMPROVEMENT_MODEL || process.env.LEARNER_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';
            const selfImprovementResult = await this.analyzeAndSave(
              openai,
              selfImprovementModel,
              selfImprovementParts,
              channelId,
              'self-improvement',
              'SelfImprovementLearner',
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

        // Update last observed message ID (newest message in the batch)
        const newestMessage = [...messages.values()][0];
        if (newestMessage) {
          this.store.setLastObserved(channelId, newestMessage.id);
        }
      } catch (error) {
        logger.error(`PersonalityLearner: Error processing channel ${channelId}:`, error);
      }
    }
  }
}
