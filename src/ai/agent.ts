import type { Message } from 'discord.js';
import { logger } from '../logger';
import { splitMessage } from '../utils';
import { ConversationStore } from './conversationStore';
import { getProviderForChannel, setProviderForChannel } from './providerRegistry';
import { toolDefinitions } from './tools';
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
    } else if (state.providerId !== provider.id) {
      // Preserve context across provider changes
      this.store.switchProvider(channelId, provider.id);
      state = this.store.get(channelId);
      if (state) {
        const updatedEntries = [...state.entries];
        this.refreshDeveloperMessage(updatedEntries, botName, provider);
        this.store.set(channelId, {
          providerId: provider.id,
          entries: updatedEntries,
          thoughts: undefined,
          timestamp: Date.now(),
        });
        state = this.store.get(channelId);
      }
    }

    if (!state) {
      stopTyping();
      await message.reply('Failed to initialize the conversation state.');
      return;
    }

    let activeProvider = provider;
    let providerTools = activeProvider.supportedTools;
    const userEntry = this.buildUserEntry(message);
    const workingEntries: ConversationEntry[] = [...state.entries, userEntry];

    try {
      const firstResponse = await activeProvider.chat({
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
            const toolOutput = await toolDefinition.handler(
              {
                message,
                providerId: activeProvider.id,
                provider: activeProvider,
                channelId,
                switchProvider: (providerId) => this.switchProviderForChannel(channelId, providerId, botName),
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

        const refreshedProvider = getProviderForChannel(channelId);
        if (refreshedProvider) {
          const providerChanged = refreshedProvider.id !== activeProvider.id;
          activeProvider = refreshedProvider;
          providerTools = activeProvider.supportedTools;
          if (providerChanged) {
            this.refreshDeveloperMessage(workingEntries, botName, activeProvider);
          }
        }

        const followUp = await activeProvider.chat({
          messages: workingEntries,
          tools: providerTools,
          toolChoice: 'none',
          thoughts: firstResponse.thoughts ?? state.thoughts,
        });

        workingEntries.push(...followUp.outputEntries);
        await this.sendReply(followUp.text, message);

        this.store.set(channelId, {
          providerId: activeProvider.id,
          entries: workingEntries,
          thoughts: followUp.thoughts ?? firstResponse.thoughts ?? state.thoughts,
          timestamp: Date.now(),
        });
        return;
      }

      await this.sendReply(firstResponse.text, message);

      this.store.set(channelId, {
        providerId: activeProvider.id,
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
    const basePrompt = this.buildDeveloperPrompt(botName, provider);
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'developer',
        content: [{ type: 'text', text: basePrompt }],
      },
    ];

    const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id });
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

  private switchProviderForChannel(channelId: string, providerId: string, botName: string) {
    const result = setProviderForChannel(channelId, providerId);
    if (result.provider) {
      const state = this.store.get(channelId);
      if (state) {
        const updatedEntries = [...state.entries];
        this.refreshDeveloperMessage(updatedEntries, botName, result.provider);

        this.store.set(channelId, {
          providerId: result.provider.id,
          entries: updatedEntries,
          thoughts: undefined,
          timestamp: Date.now(),
        });
      } else {
        this.store.switchProvider(channelId, result.provider.id);
      }
    }
    return result;
  }

  private refreshDeveloperMessage(entries: ConversationEntry[], botName: string, provider: AiProvider) {
    const refreshedPrompt = this.buildDeveloperPrompt(botName, provider);
    if (entries[0]?.kind === 'message' && entries[0].role === 'developer') {
      entries[0] = {
        kind: 'message',
        role: 'developer',
        content: [{ type: 'text', text: refreshedPrompt }],
      };
    } else {
      entries.unshift({
        kind: 'message',
        role: 'developer',
        content: [{ type: 'text', text: refreshedPrompt }],
      });
    }
  }

  private buildDeveloperPrompt(botName: string, provider: AiProvider): string {
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
    const toolLines: string[] = [];
    const toolNames = new Set(provider.supportedTools.map((t) => t.name));

    if (toolNames.has('summarize_messages')) {
      toolLines.push("- Use 'summarize_messages' only when explicitly asked for a summary.");
    }
    if (toolNames.has('generate_image')) {
      toolLines.push("- Use 'generate_image' only when the user asks for an image.");
    }
    if (toolNames.has('web_search')) {
      if (provider.id === 'gemini') {
        toolLines.push(
          "- Use 'web_search' when it would materially improve correctness, freshness, or completeness (Google Search available; free quota).",
        );
      } else {
        toolLines.push(
          "- Use 'web_search' only when local context is insufficient, the topic requires up-to-date information, or the user explicitly wants fresh/external info; never for convenience.",
        );
      }
    }
    if (toolNames.has('code_interpreter')) {
      if (provider.id === 'gemini') {
        toolLines.push(
          "- Use 'code_interpreter' freely whenever it helps solve the request accurately or efficiently.",
        );
      } else {
        toolLines.push(
          "- Use 'code_interpreter' only when real computation or data wrangling is needed; not for trivial math.",
        );
      }
    }
    if (toolNames.has('switch_provider')) {
      toolLines.push("- Use 'switch_provider' if the user explicitly asks to change the AI provider/model.");
    }

    const toolSection = toolLines.length > 0 ? `Tools:\n${toolLines.join('\n')}\n` : '';

    return `You are ${botName}, a helpful Discord chatbot. Personality: ${provider.personality}
${toolSection}Provide one clear response (no multiple versions). The current time is ${currentTimeEt.replace(' ', 'T')} (ISO 8601, America/New_York; apply EST/EDT automatically).`;
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
