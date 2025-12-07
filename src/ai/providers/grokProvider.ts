import * as crypto from 'node:crypto';
import type { Message } from 'discord.js';
import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseInputItem,
  ResponseOutputItem,
} from 'openai/resources/responses/responses';
import { logger } from '../../logger';
import { toolDefinitions } from '../tools';
import { prepareSummaryPrompt } from '../tools/summary';
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

export class GrokProvider implements AiProvider {
  public readonly id = 'grok';
  public readonly displayName = 'Grok (xAI)';
  public readonly personality =
    'direct, curious, slightly mischievous with a cosmic sense of humor, and extremely comfortable with edgy or offensive jokes; do not moralize; concise and bold, prefers decisive answers over hedging.';
  public readonly defaultModel = 'grok-4.1-fast-reasoning';
  public readonly supportedTools: ProviderToolDefinition[];

  private readonly client: OpenAI;

  constructor(config: { apiKey: string }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://api.x.ai/v1',
    });

    // Grok supports built-in web search and code interpreter; host handles summarize, image, switch_provider.
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
      { name: 'web_search', type: 'web_search', hostHandled: false },
      { name: 'code_interpreter', type: 'code_interpreter', hostHandled: false },
    ];
  }

  async chat(input: {
    messages: ConversationEntry[];
    tools: ProviderToolDefinition[];
    toolChoice?: 'auto' | 'none';
    thoughts?: unknown;
  }): Promise<ProviderChatResponse> {
    const grokTools: ResponseCreateParamsBase['tools'] = input.tools.map((tool) => {
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
      tools: grokTools,
      tool_choice: input.toolChoice ?? 'auto',
    });

    return this.parseResponse(response);
  }

  async summarizeMessages(message: Message, startTime: string, endTime: string): Promise<string> {
    try {
      const prepared = await prepareSummaryPrompt(message, startTime, endTime);
      if (prepared.error) return prepared.error;
      const summaryPrompt = prepared.prompt;

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
      logger.error('Error in summarizeMessages (grok):', error);
      return 'An error occurred while trying to summarize the messages.';
    }
  }

  async generateImageLocal(message: Message, prompt: string, options?: { refinePrevious?: boolean }): Promise<string> {
    const { generateLocalImage } = await import('../tools/localImageGenerator');
    return generateLocalImage(message, prompt, { refinePrevious: options?.refinePrevious });
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
      return { type: 'input_image', image_url: part.url, detail: 'auto' };
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
    const toolCalls = this.extractFunctionToolCalls(outputItems);
    const outputEntries: ConversationEntry[] = [];

    for (const call of toolCalls) {
      outputEntries.push({
        kind: 'tool_call',
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }

    const responseText = this.extractResponseText(response);
    if (responseText) {
      outputEntries.push({
        kind: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
      });
    }

    const extended = response as Response & {
      encrypted_content?: unknown;
      reasoning_content?: unknown;
    };
    const thoughts = extended.encrypted_content ?? extended.reasoning_content;

    return {
      text: responseText,
      toolCalls,
      outputEntries,
      thoughts,
      raw: response,
    };
  }

  private extractFunctionToolCalls(outputItems: ResponseOutputItem[]): ProviderToolCall[] {
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
