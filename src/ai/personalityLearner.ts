import * as process from 'node:process';
import { ChannelType, type Client, type Collection, type Message, type TextChannel } from 'discord.js';
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { logger } from '../logger';
import type { MemoryStore } from './memory/memoryStore';

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
  content: string;
};

const SELF_IMPROVEMENT_CATEGORIES: ObservationCategory[] = [
  'capability_gap',
  'pain_point',
  'feature_request',
  'improvement_idea',
];

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
   * Sends content parts to an LLM, parses the JSON response, and saves valid observations.
   * Returns the number of observations saved.
   */
  private async analyzeAndSave(
    openai: OpenAI,
    model: string,
    contentParts: ChatCompletionContentPart[],
    channelId: string,
    source: string,
    label: string,
  ): Promise<number> {
    logger.info(`${label}: Sending request to ${model} for channel ${channelId}`);

    const response = await openai.chat.completions.create({
      model,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [{ role: 'user', content: contentParts }],
      // @ts-expect-error OpenRouter-specific field
      provider: { zdr: true },
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return 0;

    // Parse JSON response, with regex fallback
    let observations: Observation[] = [];
    try {
      observations = JSON.parse(text) as Observation[];
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          observations = JSON.parse(match[0]) as Observation[];
        } catch {
          logger.warn(`${label}: Failed to parse JSON for channel ${channelId}. Raw: ${text.slice(0, 200)}`);
          return 0;
        }
      } else {
        logger.warn(`${label}: No JSON array found for channel ${channelId}. Raw: ${text.slice(0, 200)}`);
        return 0;
      }
    }

    if (!Array.isArray(observations)) return 0;

    let saved = 0;
    for (const obs of observations) {
      if (obs.category && obs.subject && obs.content) {
        this.store.save({
          category: obs.category,
          subject: obs.subject,
          content: obs.content,
          source,
        });
        saved++;
      }
    }

    return saved;
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

        // Build interleaved content parts: text + images per message
        const messageParts: ChatCompletionContentPart[] = [];
        let imageCount = 0;
        for (const msg of humanMessages) {
          const name = msg.member?.displayName || msg.author.username;
          messageParts.push({ type: 'text', text: `[${name}] ${msg.content}` });
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
        const existingMemories = this.store.getAllActive();
        const existingMemoriesSummary =
          existingMemories.length > 0
            ? existingMemories.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')
            : '(none yet)';

        const personalityPrompt = `You are analyzing a Discord conversation to extract observations for a bot's long-term memory.
There are MULTIPLE people in this conversation. Pay attention to WHO says what — attribute observations to the correct person by their display name.
Images appear directly after the message that shared them — attribute each image to that person.

Extract ONLY things worth remembering long-term:
- Facts about specific users (jobs, interests, real names, locations) — attribute to that person
- Individual humor styles and communication preferences — attribute to that person
- Server-wide culture, in-jokes, recurring themes — attribute to "server"
- Strong opinions or preferences someone expressed — attribute to the person who said it
- Notable events, plans, or milestones
- Shared images that reveal interests, context, or personality — attribute to the person who shared them

Do NOT extract:
- Transient small talk or greetings
- Anything already known (see existing memories below)
- Generic observations ("people were chatting", "active conversation")
- Things about someone based on what OTHERS said about them — only first-hand statements

Existing memories (avoid duplicates):
${existingMemoriesSummary}

The conversation messages and any shared images follow as separate content parts below.

Respond ONLY with a JSON array, or [] if nothing worth remembering:
[{"category": "fact|preference|personality|event|vibe", "subject": "DisplayName|server", "content": "concise observation"}]`;

        const personalityParts: ChatCompletionContentPart[] = [
          { type: 'text', text: personalityPrompt },
          ...messageParts,
        ];

        const learnerModel = process.env.LEARNER_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';
        const personalitySaved = await this.analyzeAndSave(
          openai,
          learnerModel,
          personalityParts,
          channelId,
          'observation',
          'PersonalityLearner',
        );

        if (personalitySaved > 0) {
          logger.info(`PersonalityLearner: Saved ${personalitySaved} observations from channel ${channelId}`);
        } else {
          logger.info(`PersonalityLearner: No new observations from channel ${channelId}`);
        }

        // --- Pass 2: Self-improvement analysis (optional) ---
        if (selfImprovementEnabled) {
          try {
            const existingSelfImprovement = SELF_IMPROVEMENT_CATEGORIES.flatMap((cat) =>
              this.store.getByCategory(cat, 20),
            );
            const existingSelfImprovementSummary =
              existingSelfImprovement.length > 0
                ? existingSelfImprovement.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')
                : '(none yet)';

            const selfImprovementPrompt = `You are analyzing a Discord conversation from the perspective of a bot called "${botName}" that participates in this server. Your job is to identify ways the bot could improve itself.

Look for:
- capability_gap: Things the bot was asked to do but couldn't, or content it couldn't process (e.g., "the bot couldn't read that link", "fridge didn't understand the image", custom emojis treated as unknown text)
- pain_point: User frustrations with the bot's behavior (e.g., "the bot keeps responding when nobody asked it", "its summaries are too long", "it forgot what we talked about")
- feature_request: Things users explicitly or implicitly wish the bot could do (e.g., "it would be cool if fridge could...", "can the bot do X?", someone manually doing something the bot could automate)
- improvement_idea: Patterns suggesting the bot could be better (e.g., the bot gives verbose answers in a channel that prefers short messages, users consistently rephrase questions the bot misunderstood)

Do NOT extract:
- Things the bot already does well
- General conversation unrelated to bot interaction
- Transient complaints that are just jokes or roasting (use context to judge — friends roasting the bot vs genuine frustration)
- Anything already in existing observations (below)

Bot name: "${botName}" (also called "fridge", "fridge bot", "bot")

Existing self-improvement observations (avoid duplicates):
${existingSelfImprovementSummary}

Messages follow as separate content parts below.

Respond ONLY with a JSON array, or [] if nothing actionable:
[{"category": "capability_gap|pain_point|feature_request|improvement_idea", "subject": "bot|server|DisplayName", "content": "concise, actionable observation"}]`;

            const selfImprovementParts: ChatCompletionContentPart[] = [
              { type: 'text', text: selfImprovementPrompt },
              ...messageParts,
            ];

            const selfImprovementModel =
              process.env.SELF_IMPROVEMENT_MODEL || process.env.LEARNER_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';
            const selfImprovementSaved = await this.analyzeAndSave(
              openai,
              selfImprovementModel,
              selfImprovementParts,
              channelId,
              'self-improvement',
              'SelfImprovementLearner',
            );

            if (selfImprovementSaved > 0) {
              logger.info(
                `SelfImprovementLearner: Saved ${selfImprovementSaved} observations from channel ${channelId}`,
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
