import * as process from 'node:process';
import { ChannelType, type Client, type Collection, type Message, type TextChannel } from 'discord.js';
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { logger } from '../logger';
import type { MemoryStore } from './memory/memoryStore';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MIN_MESSAGES = 5;

type Observation = {
  category: 'fact' | 'preference' | 'personality' | 'event' | 'vibe';
  subject: string;
  content: string;
};

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

        // Build multimodal content blocks from messages
        const imageUrls: string[] = [];
        const formattedMessages = humanMessages
          .map((msg) => {
            const name = msg.member?.displayName || msg.author.username;
            // Collect image URLs from attachments
            for (const attachment of msg.attachments.values()) {
              if (attachment.contentType?.startsWith('image/')) {
                imageUrls.push(attachment.url);
              }
            }
            // Collect image URLs from embeds
            for (const embed of msg.embeds) {
              if (embed.image?.url) {
                imageUrls.push(embed.image.url);
              }
              if (embed.thumbnail?.url) {
                imageUrls.push(embed.thumbnail.url);
              }
            }
            return `[${name}] ${msg.content}`;
          })
          .join('\n');

        // Get existing memories to avoid duplicates
        const existingMemories = this.store.getAllActive();
        const existingMemoriesSummary =
          existingMemories.length > 0
            ? existingMemories.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')
            : '(none yet)';

        const analysisPrompt = `You are analyzing a Discord conversation to extract observations for a bot's long-term memory.
There are MULTIPLE people in this conversation. Pay attention to WHO says what — attribute observations to the correct person by their display name.

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

Messages:
${formattedMessages}

Respond ONLY with a JSON array, or [] if nothing worth remembering:
[{"category": "fact|preference|personality|event|vibe", "subject": "DisplayName|server", "content": "concise observation"}]`;

        // Build multimodal content: text prompt first, then any images
        const contentParts: ChatCompletionContentPart[] = [{ type: 'text', text: analysisPrompt }];
        for (const url of imageUrls) {
          contentParts.push({ type: 'image_url', image_url: { url } });
        }

        if (imageUrls.length > 0) {
          logger.info(`PersonalityLearner: Including ${imageUrls.length} images from channel ${channelId}`);
        }

        const learnerModel = process.env.LEARNER_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';
        logger.info(`PersonalityLearner: Sending request to ${learnerModel} for channel ${channelId}`);

        const response = await openai.chat.completions.create({
          model: learnerModel,
          max_tokens: 1024,
          temperature: 0.3,
          messages: [{ role: 'user', content: contentParts }],
          // @ts-expect-error OpenRouter-specific field
          provider: { zdr: true },
        });

        const text = response.choices[0]?.message?.content?.trim();
        if (!text) continue;

        // Parse JSON response, with regex fallback
        let observations: Observation[] = [];
        try {
          observations = JSON.parse(text) as Observation[];
        } catch {
          // Try regex fallback to extract JSON array
          const match = text.match(/\[[\s\S]*\]/);
          if (match) {
            try {
              observations = JSON.parse(match[0]) as Observation[];
            } catch {
              logger.warn(
                `PersonalityLearner: Failed to parse JSON for channel ${channelId}. Raw: ${text.slice(0, 200)}`,
              );
              continue;
            }
          } else {
            logger.warn(`PersonalityLearner: No JSON array found for channel ${channelId}. Raw: ${text.slice(0, 200)}`);
            continue;
          }
        }

        if (!Array.isArray(observations)) continue;

        for (const obs of observations) {
          if (obs.category && obs.subject && obs.content) {
            this.store.save({
              category: obs.category,
              subject: obs.subject,
              content: obs.content,
              source: 'observation',
            });
          }
        }

        if (observations.length > 0) {
          logger.info(`PersonalityLearner: Saved ${observations.length} observations from channel ${channelId}`);
        } else {
          logger.info(`PersonalityLearner: No new observations from channel ${channelId}`);
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
