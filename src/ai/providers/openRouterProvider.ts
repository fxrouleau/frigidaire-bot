import * as crypto from 'node:crypto';
import * as process from 'node:process';
import { AttachmentBuilder, type Message } from 'discord.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import sharp from 'sharp';
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

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } };

export class OpenRouterProvider implements AiProvider {
  public readonly id = 'openrouter';
  public readonly displayName = 'OpenRouter';
  public readonly personality = '';
  public readonly defaultModel: string;
  public readonly supportedTools: ProviderToolDefinition[];

  private readonly client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'X-Title': 'Frigidaire Bot',
      },
    });

    this.defaultModel = process.env.CHAT_MODEL || 'deepseek/deepseek-v3.2:nitro';

    this.supportedTools = toolDefinitions.map(
      (tool) =>
        ({
          name: tool.name,
          type: 'function',
          description: tool.description,
          parameters: tool.parameters,
          hostHandled: true,
        }) satisfies ProviderToolDefinition,
    );
  }

  async chat(input: {
    messages: ConversationEntry[];
    tools: ProviderToolDefinition[];
    toolChoice?: 'auto' | 'none';
    thoughts?: unknown;
  }): Promise<ProviderChatResponse> {
    const messages = await Promise.all(input.messages.map((entry) => this.toOpenAIMessage(entry)));

    const tools: OpenAI.ChatCompletionTool[] = input.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? {},
        },
      }));

    const response = await this.client.chat.completions.create({
      model: this.defaultModel,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: input.toolChoice === 'none' ? 'none' : 'auto',
      // @ts-expect-error OpenRouter-specific field
      provider: {
        zdr: true,
        sort: 'throughput',
      },
    });

    return this.parseResponse(response);
  }

  async summarizeMessages(message: Message, startTime: string, endTime: string): Promise<string> {
    try {
      const prepared = await prepareSummaryPrompt(message, startTime, endTime);
      if (prepared.error) return prepared.error;

      if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }

      const response = await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [
          { role: 'system', content: 'You are an expert at summarizing conversations.' },
          { role: 'user', content: prepared.prompt },
        ],
        // @ts-expect-error OpenRouter-specific field
        provider: {
          zdr: true,
          sort: 'throughput',
        },
      });

      const text = response.choices[0]?.message?.content?.trim();
      return text || 'I was unable to generate a summary.';
    } catch (error) {
      logger.error('Error in summarizeMessages (openrouter):', error);
      return 'An error occurred while trying to summarize the messages.';
    }
  }

  async generateImageLocal(
    message: Message,
    prompt: string,
    options?: { refinePrevious?: boolean; sourceImageUrl?: string },
  ): Promise<string> {
    const { generateLocalImage } = await import('../tools/localImageGenerator');
    return generateLocalImage(message, prompt, {
      refinePrevious: options?.refinePrevious,
      sourceImageUrl: options?.sourceImageUrl,
    });
  }

  private async toOpenAIMessage(entry: ConversationEntry): Promise<ChatCompletionMessageParam> {
    if (entry.kind === 'message') {
      if (entry.role === 'assistant') {
        const text = entry.content.map((p) => (p.type === 'text' ? p.text : `[image]: ${p.url}`)).join('\n');
        return { role: 'assistant', content: text };
      }

      if (entry.role === 'developer' || entry.role === 'system') {
        const text = entry.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        return { role: 'system', content: text };
      }

      // user message
      const parts = await this.buildContentParts(entry.content);
      if (parts.length === 1 && parts[0].type === 'text') {
        return { role: 'user', content: parts[0].text };
      }
      return { role: 'user', content: parts };
    }

    if (entry.kind === 'tool_call') {
      return {
        role: 'assistant',
        tool_calls: [
          {
            id: entry.id,
            type: 'function',
            function: {
              name: entry.name,
              arguments: JSON.stringify(entry.arguments),
            },
          },
        ],
      };
    }

    // tool_result
    return {
      role: 'tool',
      tool_call_id: entry.id,
      content: entry.content,
    };
  }

  private async buildContentParts(content: NormalizedContentPart[]): Promise<ChatContentPart[]> {
    if (content.length === 0) return [{ type: 'text', text: '' }];
    const parts: ChatContentPart[] = [];
    for (const part of content) {
      if (part.type === 'image') {
        const dataUri = await this.fetchImageAsBase64(part.url);
        if (dataUri) {
          parts.push({ type: 'image_url', image_url: { url: dataUri, detail: 'auto' } });
        }
      } else {
        parts.push({ type: 'text', text: part.text });
      }
    }
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }

  private async fetchImageAsBase64(url: string): Promise<string | undefined> {
    if (url.startsWith('data:')) return url;

    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
    const MAX_DIMENSION = 1568;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        logger.warn(`Failed to fetch image (HTTP ${response.status}): ${url}`);
        return undefined;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_SIZE) {
        logger.warn(`Image too large (${contentLength} bytes), skipping: ${url}`);
        return undefined;
      }

      let buffer: Buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_SIZE) {
        logger.warn(`Image too large (${buffer.byteLength} bytes), skipping: ${url}`);
        return undefined;
      }

      let resized = false;
      try {
        const image = sharp(buffer);
        const metadata = await image.metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;

        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          logger.info(`Resizing image from ${width}x${height} (max ${MAX_DIMENSION}px): ${url}`);
          buffer = await image.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' }).png().toBuffer();
          resized = true;
        }
      } catch (resizeError) {
        logger.warn(`Failed to resize image, using original: ${url}`, resizeError);
      }

      const mimeType = resized
        ? 'image/png'
        : (response.headers.get('content-type') || 'image/png').split(';')[0].trim();
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (error) {
      logger.warn(`Failed to download image for base64 conversion: ${url}`, error);
      return undefined;
    }
  }

  private parseResponse(response: OpenAI.ChatCompletion): ProviderChatResponse {
    const choice = response.choices[0];
    const msg = choice?.message;
    const text = msg?.content?.trim() || undefined;
    const toolCalls = this.extractToolCalls(msg);
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

    if (text) {
      outputEntries.push({
        kind: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      });
    }

    return { text, toolCalls, outputEntries, raw: response };
  }

  private extractToolCalls(message: OpenAI.ChatCompletionMessage | undefined): ProviderToolCall[] {
    if (!message?.tool_calls) return [];

    return message.tool_calls
      .filter((call): call is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => call.type === 'function')
      .map((call) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === 'object') {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          logger.warn(`Failed to parse tool arguments for ${call.function.name}`);
        }

        return {
          id: call.id || crypto.randomUUID(),
          name: call.function.name,
          arguments: args,
        };
      });
  }
}
