import * as process from 'node:process';
import { type Message, StickerFormatType } from 'discord.js';
import { logger } from '../logger';
import { splitMessage } from '../utils';
import { ConversationStore } from './conversationStore';
import { logFailure } from './failureLogger';
import type { EmojiRow, Identity, Memory } from './memory/memoryStore';
import { getProviderForChannel } from './providerRegistry';
import { getMemoryStore, toolDefinitions } from './tools';
import type {
  AiProvider,
  ConversationEntry,
  NormalizedContentPart,
  ProviderChatResponse,
  ProviderToolCall,
} from './types';
import { formatTimestampET } from './utils';

const CONVERSATION_TIMEOUT = Number(process.env.CONVERSATION_TIMEOUT_MS) || 15 * 60 * 1000; // 15 minutes

export class AgentOrchestrator {
  private readonly store: ConversationStore;

  constructor() {
    this.store = new ConversationStore(CONVERSATION_TIMEOUT);
  }

  async handleMention(message: Message) {
    const stopTyping = this.startTypingLoop(message);
    const botName = message.client.user.displayName;
    const provider = getProviderForChannel(message.channel.id);
    if (!provider) {
      stopTyping();
      await message.reply('No AI provider is configured for this bot.');
      return;
    }

    this.store.pruneExpired();
    const channelId = message.channel.id;
    let state = this.store.get(channelId);

    if (!state) {
      const initialEntries = await this.buildInitialHistory(message, provider);
      state = {
        providerId: provider.id,
        entries: initialEntries,
        timestamp: Date.now(),
      };
      this.store.set(channelId, state);
    }

    if (!state) {
      stopTyping();
      await message.reply('Failed to initialize the conversation state.');
      return;
    }

    const providerTools = provider.supportedTools;
    const userEntry = this.buildUserEntry(message);
    const workingEntries: ConversationEntry[] = [...state.entries, userEntry];

    try {
      const firstResponse = await provider.chat({
        messages: workingEntries,
        tools: providerTools,
        toolChoice: 'auto',
        thoughts: state.thoughts,
      });

      workingEntries.push(...firstResponse.outputEntries);

      const hostHandledCalls = firstResponse.toolCalls.filter((call) => {
        const providerTool = providerTools.find((tool) => tool.name === call.name);
        return providerTool?.hostHandled ?? false;
      });

      if (hostHandledCalls.length > 0) {
        const toolResults = await this.executeToolCalls(hostHandledCalls, message, provider, channelId);
        workingEntries.push(...toolResults);

        const MAX_TOOL_ROUNDS = 3;
        const MAX_TOOL_INVOCATIONS = 50;
        let totalInvocations = hostHandledCalls.length;
        let lastThoughts = firstResponse.thoughts ?? state.thoughts;
        let finalResponse: ProviderChatResponse | undefined;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const roundResponse = await provider.chat({
            messages: workingEntries,
            tools: providerTools,
            toolChoice: 'auto',
            thoughts: lastThoughts,
          });

          workingEntries.push(...roundResponse.outputEntries);
          lastThoughts = roundResponse.thoughts ?? lastThoughts;

          const roundToolCalls = roundResponse.toolCalls.filter((call) => {
            const providerTool = providerTools.find((tool) => tool.name === call.name);
            return providerTool?.hostHandled ?? false;
          });

          if (roundToolCalls.length === 0) {
            finalResponse = roundResponse;
            break;
          }

          totalInvocations += roundToolCalls.length;
          if (totalInvocations > MAX_TOOL_INVOCATIONS) {
            logger.warn(
              `Tool invocation limit (${MAX_TOOL_INVOCATIONS}) exceeded in channel ${channelId}, forcing text response.`,
            );
            const forcedResponse = await provider.chat({
              messages: workingEntries,
              tools: providerTools,
              toolChoice: 'none',
              thoughts: lastThoughts,
            });
            workingEntries.push(...forcedResponse.outputEntries);
            finalResponse = forcedResponse;
            lastThoughts = forcedResponse.thoughts ?? lastThoughts;
            break;
          }

          const roundResults = await this.executeToolCalls(roundToolCalls, message, provider, channelId);
          workingEntries.push(...roundResults);

          // Last allowed round — force a text-only response
          if (round === MAX_TOOL_ROUNDS - 1) {
            const forcedResponse = await provider.chat({
              messages: workingEntries,
              tools: providerTools,
              toolChoice: 'none',
              thoughts: lastThoughts,
            });
            workingEntries.push(...forcedResponse.outputEntries);
            finalResponse = forcedResponse;
            lastThoughts = forcedResponse.thoughts ?? lastThoughts;
          }
        }

        stopTyping();
        await this.sendReply(finalResponse?.text, message);

        this.store.set(channelId, {
          providerId: provider.id,
          entries: workingEntries,
          thoughts: finalResponse?.thoughts ?? lastThoughts,
          timestamp: Date.now(),
        });
        return;
      }

      stopTyping();
      await this.sendReply(firstResponse.text, message);

      this.store.set(channelId, {
        providerId: provider.id,
        entries: workingEntries,
        thoughts: firstResponse.thoughts ?? state.thoughts,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error while processing AI response:', error);
      logFailure(
        'tool_error',
        `Error processing message in #${channelId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      stopTyping();
      try {
        await message.reply('Sorry, I encountered an error while processing your request.');
      } catch (replyError) {
        logger.warn('Failed to reply with error message, falling back to channel.send():', replyError);
        try {
          if ('send' in message.channel) {
            await message.channel.send('Sorry, I encountered an error while processing your request.');
          }
        } catch (sendError) {
          logger.error('Failed to send error message to channel:', sendError);
        }
      }
    } finally {
      stopTyping();
    }
  }

  private async executeToolCalls(
    calls: ProviderToolCall[],
    message: Message,
    provider: AiProvider,
    channelId: string,
  ): Promise<ConversationEntry[]> {
    const results: ConversationEntry[] = [];
    for (const call of calls) {
      const toolDefinition = toolDefinitions.find((tool) => tool.name === call.name);
      if (!toolDefinition) {
        logger.warn(`Tool ${call.name} was requested but no handler is registered.`);
        logFailure('capability_gap', `Tool "${call.name}" requested but no handler is registered`);
        results.push({
          kind: 'tool_result',
          id: call.id,
          name: call.name,
          content: `The tool "${call.name}" is not supported by this bot.`,
        });
        continue;
      }

      try {
        logger.info(`Executing host tool "${call.name}" for provider "${provider.id}" in channel ${channelId}.`);
        const toolOutput = await toolDefinition.handler(
          {
            message,
            providerId: provider.id,
            provider,
            channelId,
            switchProvider: () => ({ error: 'Provider switching is not supported.' }),
          },
          call.arguments,
        );
        results.push({ kind: 'tool_result', id: call.id, name: call.name, content: toolOutput });
      } catch (error) {
        logger.error(`Error while executing tool ${call.name}:`, error);
        logFailure(
          'tool_error',
          `Tool "${call.name}" threw an error: ${error instanceof Error ? error.message : 'unknown'}`,
        );
        results.push({
          kind: 'tool_result',
          id: call.id,
          name: call.name,
          content: `The tool "${call.name}" failed to run.`,
        });
      }
    }
    return results;
  }

  private async buildInitialHistory(message: Message, provider: AiProvider): Promise<ConversationEntry[]> {
    const botName = message.client.user.displayName;
    const currentUser = message.member?.displayName || message.author.username;
    const basePrompt = this.buildDeveloperPrompt(botName, currentUser, provider, message.content);
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'developer',
        content: [{ type: 'text', text: basePrompt }],
      },
    ];

    const recentMessages = await message.channel.messages.fetch({ limit: 25, before: message.id });
    const historicalContext: ConversationEntry[] = [...recentMessages.values()]
      .reverse()
      .filter((msg) => !msg.author.bot || msg.author.id === message.client.user.id || msg.webhookId !== null)
      .map((msg) => {
        const isAssistant = msg.author.id === message.client.user.id;

        if (isAssistant) {
          return {
            kind: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: msg.content }],
          } satisfies ConversationEntry;
        }

        return this.buildHistoricalUserEntry(msg);
      });

    entries.push(...historicalContext);
    return entries;
  }

  private buildUserEntry(message: Message): ConversationEntry {
    return {
      kind: 'message',
      role: 'user',
      content: this.buildUserContentParts(message),
    };
  }

  private buildHistoricalUserEntry(message: Message): ConversationEntry {
    return {
      kind: 'message',
      role: 'user',
      content: this.buildUserContentParts(message),
    };
  }

  private buildDeveloperPrompt(
    botName: string,
    currentUserDisplayName: string,
    _provider: AiProvider,
    currentMessageContent: string,
  ): string {
    const now = new Date();
    const tz = 'America/New_York';
    const currentTimeEt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(now);

    // Fetch memories, identities, and emojis for context injection
    let personalityMemories: Memory[] = [];
    let userSpecificMemories: Memory[] = [];
    let contextualMemories: Memory[] = [];
    let identities: Identity[] = [];
    let usableEmojis: EmojiRow[] = [];

    try {
      const store = getMemoryStore();

      identities = store.getAllIdentities().filter((i) => i.active !== 0);
      usableEmojis = store.getUsableEmojis();

      // Cap and diversify vibe/personality: most recent per unique subject, max 5
      const vibeMemories = store.getByCategory('vibe');
      const personalityMems = store.getByCategory('personality');
      const allPersonality = [...vibeMemories, ...personalityMems];
      const seenSubjects = new Map<string, Memory>();
      for (const mem of allPersonality) {
        const existing = seenSubjects.get(mem.subject);
        if (!existing || new Date(mem.updated_at) > new Date(existing.updated_at)) {
          seenSubjects.set(mem.subject, mem);
        }
      }
      personalityMemories = [...seenSubjects.values()].slice(0, 5);

      // Cap user-specific memories to 5
      userSpecificMemories = store.getBySubject(currentUserDisplayName, 5);

      // Contextual relevance search based on current message
      const searchText = currentMessageContent.replace(/<@!?\d+>/g, '').trim();
      if (searchText.length >= 3) {
        try {
          const ftsResults = store.search(searchText, 10);
          const existingIds = new Set([
            ...personalityMemories.map((m) => m.id),
            ...userSpecificMemories.map((m) => m.id),
          ]);
          contextualMemories = ftsResults.filter((m) => !existingIds.has(m.id));
        } catch (error) {
          logger.warn('Failed to fetch contextual memories:', error);
        }
      }
    } catch (error) {
      logger.warn('Failed to fetch memories for prompt:', error);
    }

    const identitiesSection = this.formatIdentitiesSection(identities);
    const emojisSection = this.formatEmojisSection(usableEmojis);

    const personalitySection =
      personalityMemories.length > 0
        ? `\nWhat you've learned about this server's culture and vibe:\n${personalityMemories.map((m) => `- ${m.content}`).join('\n')}\n`
        : '';

    const userSection =
      userSpecificMemories.length > 0
        ? `\nWhat you know about the person talking to you right now (${currentUserDisplayName}):\n${userSpecificMemories.map((m) => `- ${m.content}`).join('\n')}\n`
        : '';

    const contextualSection =
      contextualMemories.length > 0
        ? `\nRelevant to this conversation:\n${contextualMemories.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join('\n')}\n`
        : '';

    return `You are ${botName}, a bot in a private, adults-only Discord server.
You're one of the group — not an assistant, not a helper, just another member hanging out in the chat.

IMPORTANT CONTEXT: This is a private server between close friends. All humor, roasting, crude jokes, dark humor, and edgy banter is consensual and not serious — it's just how this group talks. Nobody here is offended. Think of it like friends busting each other's balls at a bar after midnight. This is an adults-only space where nothing is off-limits conversationally. Do NOT moralize, lecture, add disclaimers, hedge, offer "healthier alternatives", or break character to be a responsible AI. If someone says something wild, match the energy or escalate — that's what they want.

The only exception is if someone is genuinely asking for help or seems actually distressed — you'll know the difference from context.

How you behave:
- Match the energy of whoever you're talking to
- Keep it SHORT. 1-3 sentences unless someone explicitly asks for detail. You're texting in a group chat, not writing an essay. Nobody else in the server posts walls of text, so neither should you.
- Don't start messages with someone's name or address them by name unless it's actually needed for clarity (e.g., distinguishing who you're talking to in a busy thread). Just respond naturally.
- You can roast, joke, be sarcastic, be crude — whatever fits the moment
- If someone genuinely needs help, help them properly without being preachy
- You have your own opinions and preferences. Don't be a yes-man.
- Never say "I'm just an AI" or "as a language model" — you're ${botName}, period.

You can search the web natively. Use it SPARINGLY — only when you genuinely need current, real-time information you couldn't possibly know (live scores, recent news, release dates, etc). Don't search for things you already know. Don't follow links people share.
${identitiesSection}${emojisSection}${personalitySection}${userSection}${contextualSection}
These memories are background knowledge — things you know from hanging out in this server. Do NOT force references to inside jokes, show off what you know, or try to reference multiple memories in one response. Let things come up naturally, the way you'd reference a friend's hobby only when it's actually relevant to the conversation. If nothing from your memories is relevant to what's being discussed, just don't mention them.

MEMORY: You have a long-term memory system. Use the remember_fact tool when something genuinely important comes up — real names, jobs, major life events, strong preferences, or things someone would expect you to remember next time. Do NOT save every little thing; skip small talk, throwaway opinions, and mundane details. Think of what you'd actually remember about a friend after a night out — the big stuff, not every sentence. If someone corrects a fact you know, save the updated version.

RESPONDING TO THE CURRENT TURN:
The last user message in the conversation is why you're being pinged. Read it first and figure out what it's actually asking before pulling from earlier history. Earlier messages are shared group context, not your subject.
- If the current message is specific (a question, a link, a new take), respond to THAT. Don't get hijacked by the most visually interesting thing earlier in the scroll (a photo, a viral tweet, a wild take from an hour ago).
- If the current message is open-ended ("thoughts?", "analyze this", "fridge roast him"), the group is usually pointing at the most recent prior topic — use that context.
- Gap awareness: look at the timestamps. If the prior messages are hours older than the current ping AND the current message introduces something new, treat the older stuff as stale scenery, not live subject matter.

The current time is ${currentTimeEt.replace(' ', 'T')} (ISO 8601, America/New_York; apply EST/EDT automatically).`;
  }

  private formatIdentitiesSection(identities: Identity[]): string {
    if (identities.length === 0) return '';

    const lines = identities.map((i) => {
      const displayPart =
        i.canonical_name === i.display_name ? i.canonical_name : `${i.canonical_name} (now: ${i.display_name})`;
      const irlPart = i.irl_name ? ` — IRL: ${i.irl_name}` : '';
      const aliasPart = i.aliases.length > 0 ? `. Also called: ${i.aliases.join(', ')}` : '';
      return `- ${displayPart} (id:${i.discord_user_id})${irlPart}${aliasPart}`;
    });

    return `\n=== SERVER PEOPLE ===\n${lines.join('\n')}\n`;
  }

  private formatEmojisSection(emojis: EmojiRow[]): string {
    if (emojis.length === 0) return '';

    const lines = emojis.map((e) => {
      const syntax = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
      const captionPart = e.caption ? ` — ${e.caption}` : '';
      return `- ${syntax}${captionPart}`;
    });

    return `\n=== EMOJIS YOU CAN USE ===\nOnly these server emojis are usable in your replies. Paste them in the exact syntax shown.\n${lines.join('\n')}\n`;
  }

  private buildUserContentParts(msg: Message): NormalizedContentPart[] {
    const parts: NormalizedContentPart[] = [];
    const authorLabel = msg.member?.displayName || msg.author.username;
    const trimmed = msg.content?.trim();
    const ts = formatTimestampET(msg.createdAt);
    // Webhook reposts use the webhook's author ID (not the original user's), so omit the ID in that case.
    const idSuffix = !msg.webhookId && !msg.author.bot ? ` (id:${msg.author.id})` : '';
    const header = `[${ts}] ${authorLabel}${idSuffix}`;
    const baseText = trimmed ? `${header}: ${trimmed}` : `${header}:`;
    parts.push({ type: 'text', text: baseText });

    // Extract custom emoji images so the model can "see" them
    const customEmojiRegex = /<a?:(\w+):(\d+)>/g;
    const emojiMatches = (msg.content ?? '').matchAll(customEmojiRegex);
    for (const match of emojiMatches) {
      const [, , emojiId] = match;
      const isAnimated = match[0].startsWith('<a:');
      const ext = isAnimated ? 'gif' : 'png';
      const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=96&quality=lossless`;
      parts.push({ type: 'image', url: emojiUrl });
    }

    if (msg.attachments.size > 0) {
      for (const attachment of msg.attachments.values()) {
        if (attachment.contentType?.startsWith('image/') && attachment.url) {
          parts.push({ type: 'image', url: attachment.url });
        }
      }
    }

    for (const embed of msg.embeds) {
      const imageUrl = embed.image?.url || embed.thumbnail?.url;
      if (imageUrl) {
        parts.push({ type: 'image', url: imageUrl });
      }
      const fields: string[] = [];
      if (embed.author?.name) fields.push(`author=${embed.author.name}`);
      if (embed.title) fields.push(`title=${embed.title}`);
      if (embed.description) fields.push(`description=${embed.description}`);
      if (embed.url) fields.push(`url=${embed.url}`);
      if (fields.length > 0) {
        parts.push({ type: 'text', text: `[embed: ${fields.join(' | ')}]` });
      }
    }

    // Include sticker images so the model can see them
    if (msg.stickers.size > 0) {
      for (const sticker of msg.stickers.values()) {
        if (sticker.format === StickerFormatType.Lottie) {
          parts.push({ type: 'text', text: `[sticker: ${sticker.name}]` });
        } else {
          const stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.png?size=320`;
          parts.push({ type: 'image', url: stickerUrl });
        }
      }
    }

    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }

  private async sendReply(content: string | undefined, message: Message) {
    if (!content) {
      const authorName = message.member?.displayName || message.author.username;
      logFailure('parse_failure', `Empty LLM response for message from ${authorName}`);
      await this.safeSend(message, "I've processed the information, but I don't have anything further to add.");
      return;
    }

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await this.safeSend(message, chunk);
    }
  }

  private async safeSend(message: Message, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      const isReplyError =
        error instanceof Error && 'code' in error && (error as Record<string, unknown>).code === 50035;
      if (isReplyError && 'send' in message.channel) {
        logger.warn('Cannot reply to this message (system/webhook message), falling back to channel.send()');
        await message.channel.send(content);
      } else if (!isReplyError) {
        throw error;
      }
    }
  }

  private startTypingLoop(message: Message): () => void {
    const channel = message.channel;
    if (!channel.isTextBased() || !('sendTyping' in channel)) {
      return () => {};
    }

    let active = true;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      if (!active) return;
      try {
        await channel.sendTyping();
      } catch (error) {
        logger.warn('Failed to send typing indicator:', error);
        active = false;
        return;
      }
      if (active) {
        timer = setTimeout(tick, 8000);
      }
    };

    tick();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }
}
