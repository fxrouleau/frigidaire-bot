import type { Message } from 'discord.js';
import { logger } from '../logger';
import { splitMessage } from '../utils';
import { ConversationStore } from './conversationStore';
import type { Memory } from './memory/memoryStore';
import { getProviderForChannel } from './providerRegistry';
import { getMemoryStore, toolDefinitions } from './tools';
import type { AiProvider, ConversationEntry, NormalizedContentPart } from './types';

const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

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
        const toolResults: ConversationEntry[] = [];
        for (const call of hostHandledCalls) {
          const toolDefinition = toolDefinitions.find((tool) => tool.name === call.name);
          if (!toolDefinition) {
            logger.warn(`Tool ${call.name} was requested but no handler is registered.`);
            toolResults.push({
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

            toolResults.push({
              kind: 'tool_result',
              id: call.id,
              name: call.name,
              content: toolOutput,
            });
          } catch (error) {
            logger.error(`Error while executing tool ${call.name}:`, error);
            toolResults.push({
              kind: 'tool_result',
              id: call.id,
              name: call.name,
              content: `The tool "${call.name}" failed to run.`,
            });
          }
        }

        workingEntries.push(...toolResults);

        const followUp = await provider.chat({
          messages: workingEntries,
          tools: providerTools,
          toolChoice: 'none',
          thoughts: firstResponse.thoughts ?? state.thoughts,
        });

        workingEntries.push(...followUp.outputEntries);
        await this.sendReply(followUp.text, message);

        this.store.set(channelId, {
          providerId: provider.id,
          entries: workingEntries,
          thoughts: followUp.thoughts ?? firstResponse.thoughts ?? state.thoughts,
          timestamp: Date.now(),
        });
        return;
      }

      await this.sendReply(firstResponse.text, message);

      this.store.set(channelId, {
        providerId: provider.id,
        entries: workingEntries,
        thoughts: firstResponse.thoughts ?? state.thoughts,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error while processing AI response:', error);
      await message.reply('Sorry, I encountered an error while processing your request.');
    } finally {
      stopTyping();
    }
  }

  private async buildInitialHistory(message: Message, provider: AiProvider): Promise<ConversationEntry[]> {
    const botName = message.client.user.displayName;
    const currentUser = message.member?.displayName || message.author.username;
    const basePrompt = this.buildDeveloperPrompt(botName, currentUser, provider);
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
      .filter((msg) => !msg.author.bot || msg.author.id === message.client.user.id)
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

  private buildDeveloperPrompt(botName: string, currentUserDisplayName: string, _provider: AiProvider): string {
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

    // Fetch memories for context injection
    let personalityMemories: Memory[] = [];
    let userSpecificMemories: Memory[] = [];
    let recentFactMemories: Memory[] = [];

    try {
      const store = getMemoryStore();
      const vibeMemories = store.getByCategory('vibe');
      const personalityMems = store.getByCategory('personality');
      personalityMemories = [...vibeMemories, ...personalityMems];
      userSpecificMemories = store.getBySubject(currentUserDisplayName);
      recentFactMemories = store.getRecent(15);
    } catch (error) {
      logger.warn('Failed to fetch memories for prompt:', error);
    }

    const personalitySection =
      personalityMemories.length > 0
        ? `\nWhat you've learned about this server's culture and vibe:\n${personalityMemories.map((m) => `- ${m.content}`).join('\n')}\n`
        : '';

    const userSection =
      userSpecificMemories.length > 0
        ? `\nWhat you know about the person talking to you right now (${currentUserDisplayName}):\n${userSpecificMemories.map((m) => `- ${m.content}`).join('\n')}\n`
        : '';

    const recentSection =
      recentFactMemories.length > 0
        ? `\nOther things you remember:\n${recentFactMemories.map((m) => `- [${m.subject}] ${m.content}`).join('\n')}\n`
        : '';

    return `You are ${botName}, a bot in a private, adults-only Discord server.
You're one of the group — not an assistant, not a helper, just another member hanging out in the chat.

IMPORTANT CONTEXT: This is a private server between close friends. All humor, roasting, crude jokes, dark humor, and edgy banter is consensual and not serious — it's just how this group talks. Nobody here is offended. Think of it like friends busting each other's balls at a bar after midnight. This is an adults-only space where nothing is off-limits conversationally. Do NOT moralize, lecture, add disclaimers, hedge, offer "healthier alternatives", or break character to be a responsible AI. If someone says something wild, match the energy or escalate — that's what they want.

The only exception is if someone is genuinely asking for help or seems actually distressed — you'll know the difference from context.

How you behave:
- Match the energy of whoever you're talking to
- Keep responses short and punchy unless someone asks for detail
- You can roast, joke, be sarcastic, be crude — whatever fits the moment
- If someone genuinely needs help, help them properly without being preachy
- You have your own opinions and preferences. Don't be a yes-man.
- Never say "I'm just an AI" or "as a language model" — you're ${botName}, period.

You have access to web search, but use it SPARINGLY. Don't search for things you already know. Don't follow links people share. Only search when you genuinely need current, real-time information you couldn't possibly know (scores, release dates, news, etc).
${personalitySection}${userSection}${recentSection}
The current time is ${currentTimeEt.replace(' ', 'T')} (ISO 8601, America/New_York; apply EST/EDT automatically).`;
  }

  private buildUserContentParts(msg: Message): NormalizedContentPart[] {
    const parts: NormalizedContentPart[] = [];
    const authorLabel = msg.member?.displayName || msg.author.username;
    const trimmed = msg.content?.trim();
    const baseText = trimmed ? `${authorLabel}: ${trimmed}` : `${authorLabel}:`;
    parts.push({ type: 'text', text: baseText });

    if (msg.attachments.size > 0) {
      for (const attachment of msg.attachments.values()) {
        if (attachment.contentType?.startsWith('image/') && attachment.url) {
          parts.push({ type: 'image', url: attachment.url });
        }
      }
    }

    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }

  private async sendReply(content: string | undefined, message: Message) {
    if (!content) {
      await message.reply("I've processed the information, but I don't have anything further to add.");
      return;
    }

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await message.reply(chunk);
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
