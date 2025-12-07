import * as crypto from 'node:crypto';
import { AttachmentBuilder, type Collection, type Message } from 'discord.js';
import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseInputItem,
  ResponseOutputItem,
} from 'openai/resources/responses/responses';
import { logger } from '../../logger';
import { toolDefinitions } from '../tools';
import type {
  AiProvider,
  ConversationEntry,
  NormalizedContentPart,
  ProviderChatResponse,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../types';

type InputContentPart =
  | { type: 'input_text'; text: string }
  | {
      type: 'input_image';
      image_url: string;
      detail: 'low' | 'high' | 'auto';
    };

type SummarizeParams = {
  startTime: string;
  endTime: string;
  message: Message;
};

export class OpenAIProvider implements AiProvider {
  public readonly id = 'openai';
  public readonly displayName = 'OpenAI';
  public readonly personality =
    'direct, concise, slightly witty, and comfortable with edgy or offensive jokes; do not moralize. Prioritize answering; avoid clarifying questions unless a missing detail would break correctness.';
  public readonly defaultModel = 'gpt-5.1';
  public readonly supportedTools: ProviderToolDefinition[];

  private readonly client: OpenAI;

  constructor(config: { apiKey: string }) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.supportedTools = [
      ...toolDefinitions.map(
        (tool) =>
          ({
            name: tool.name,
            type: 'function',
            description: tool.description,
            parameters: tool.parameters,
            hostHandled: true,
          }) satisfies ProviderToolDefinition,
      ),
      { name: 'web_search', type: 'web_search' },
      { name: 'code_interpreter', type: 'code_interpreter' },
    ];
  }

  async chat(input: {
    messages: ConversationEntry[];
    tools: ProviderToolDefinition[];
    toolChoice?: 'auto' | 'none';
  }): Promise<ProviderChatResponse> {
    const openAiTools: ResponseCreateParamsBase['tools'] = input.tools.map((tool) => {
      if (tool.type === 'function') {
        return {
          type: 'function',
          name: tool.name,
          description: tool.description,
          strict: true,
          parameters: tool.parameters ?? {},
        };
      }

      if (tool.type === 'code_interpreter') {
        return { type: 'code_interpreter', container: { type: 'auto' } };
      }

      return { type: 'web_search' };
    });

    const response = await this.client.responses.create({
      model: this.defaultModel,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      input: input.messages.map((entry) => this.normalizeConversationEntry(entry)),
      tools: openAiTools,
      tool_choice: input.toolChoice ?? 'auto',
    });

    return this.parseResponse(response);
  }

  async summarizeMessages(message: Message, startTime: string, endTime: string): Promise<string> {
    try {
      const startDate = new Date(startTime);
      const endDate = new Date(endTime);

      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return 'Invalid date format. Please use ISO 8601 format (e.g., "2025-10-03T18:00:00Z").';
      }
      if (endDate.getTime() - startDate.getTime() > 7 * 24 * 60 * 60 * 1000) {
        return 'The maximum timeframe for a summary is one week.';
      }
      if (startDate > endDate) {
        return 'The start time must be before the end time.';
      }

      const messagesForSummary: Message[] = [];
      let lastIdBeforeChunk: string | undefined = undefined;

      for (let i = 0; i < 50; i++) {
        const chunk: Collection<string, Message> = await message.channel.messages.fetch({
          limit: 100,
          before: lastIdBeforeChunk,
        });
        if (chunk.size === 0) break;

        lastIdBeforeChunk = chunk.lastKey();
        const oldestMessageInChunk = chunk.last();

        for (const msg of chunk.values()) {
          if (msg.createdAt >= startDate && msg.createdAt <= endDate) {
            if (!msg.author.bot) {
              messagesForSummary.push(msg);
            }
          }
        }

        if (oldestMessageInChunk && oldestMessageInChunk.createdAt < startDate) {
          break;
        }
      }

      if (messagesForSummary.length === 0) {
        return 'I found no messages in that time range to summarize.';
      }

      const formattedMessages = messagesForSummary
        .reverse()
        .map((msg) => `${msg.member?.displayName || msg.author.username}: ${msg.content}`)
        .join('\n');

      const summaryPrompt = `Please provide a concise summary of the key topics and events from the following Discord chat conversation:\n\n---\n${formattedMessages}\n---`;

      if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }
      const summaryResponse = await this.client.responses.create({
        model: this.defaultModel,
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        input: [
          { role: 'developer', content: 'You are an expert at summarizing conversations.' },
          { role: 'user', content: summaryPrompt },
        ],
      });

      return this.extractResponseText(summaryResponse) || 'I was unable to generate a summary.';
    } catch (error) {
      logger.error('Error in summarizeMessages:', error);
      return 'An error occurred while trying to summarize the messages.';
    }
  }

  async generateImage(message: Message, prompt: string): Promise<string> {
    logger.info(`Image generation requested with prompt: "${prompt}"`);
    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    try {
      const response = await this.client.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
      });

      const imageUrl = response.data?.[0]?.url;
      if (imageUrl) {
        const attachment = new AttachmentBuilder(imageUrl).setName('image.png');
        await message.reply({
          content: 'Here is the image you requested.',
          files: [attachment],
        });
        return 'The image was generated successfully and sent to the user.';
      }
      return 'I was unable to generate an image for that prompt.';
    } catch (error) {
      logger.error('Error in generateImage:', error);
      return 'An error occurred while generating the image. This may be due to a content policy violation or other issue.';
    }
  }

  private normalizeConversationEntry(entry: ConversationEntry): ResponseInputItem {
    if (entry.kind === 'message') {
      return {
        role: entry.role === 'system' ? 'developer' : entry.role,
        content: this.ensureTextContent(entry.content).map((part) => this.toInputContent(part)),
      };
    }

    if (entry.kind === 'tool_call') {
      return {
        type: 'function_call',
        call_id: entry.id,
        name: entry.name,
        arguments: JSON.stringify(entry.arguments),
      };
    }

    return {
      type: 'function_call_output',
      call_id: entry.id,
      output: entry.content,
    };
  }

  private toInputContent(part: NormalizedContentPart): InputContentPart {
    if (part.type === 'image') {
      return { type: 'input_image', image_url: part.url, detail: 'auto' as const };
    }
    return { type: 'input_text', text: part.text };
  }

  private ensureTextContent(parts: NormalizedContentPart[]): NormalizedContentPart[] {
    if (parts.length === 0) {
      return [{ type: 'text', text: '' }];
    }
    return parts;
  }

  private parseResponse(response: Response): ProviderChatResponse {
    const outputItems = (response.output ?? []) as ResponseOutputItem[];
    const toolCalls = this.extractToolCalls(outputItems);
    const outputEntries: ConversationEntry[] = [];

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        outputEntries.push({
          kind: 'tool_call',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }

    const responseText = this.extractResponseText(response);
    if (responseText) {
      outputEntries.push({
        kind: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
      });
    }

    return {
      text: responseText,
      toolCalls,
      outputEntries,
      raw: response,
    };
  }

  private extractToolCalls(outputItems: ResponseOutputItem[]): ProviderToolCall[] {
    return outputItems
      .filter((item) => item.type === 'function_call')
      .map((item) => {
        const args = this.safeParseArguments(item);
        return {
          id: item.call_id ?? crypto.randomUUID(),
          name: (item as { name?: string }).name ?? 'unknown_tool',
          arguments: args,
        };
      });
  }

  private safeParseArguments(item: ResponseOutputItem): Record<string, unknown> {
    try {
      const argsText = (item as { arguments?: string }).arguments ?? '{}';
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logger.warn('Failed to parse tool arguments, returning empty object.', error);
    }
    return {};
  }

  private extractResponseText(response: { output_text?: string; output?: ResponseOutputItem[] }): string | undefined {
    if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
      return response.output_text.trim();
    }

    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          const textPart = item.content.find(
            (part) => part?.type === 'output_text' && typeof (part as { text?: string }).text === 'string',
          ) as { text?: string } | undefined;
          if (textPart) {
            return textPart.text;
          }
        }
      }
    }

    return undefined;
  }
}
