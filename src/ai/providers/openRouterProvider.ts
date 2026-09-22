import * as crypto from 'node:crypto';
import type { Message } from 'discord.js';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import sharp from 'sharp';
import { config } from '../../config';
import { logger } from '../../logger';
import { requireOpenRouterClient } from '../openRouterClient';
import { toolDefinitions } from '../tools';
import { prepareSummaryPrompt } from '../tools/summary';
import type {
  AiProvider,
  ChatInput,
  ConversationEntry,
  ImageGenerationOptions,
  NormalizedContentPart,
  ProviderChatResponse,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../types';

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } };

export type OpenRouterProviderOptions = {
  client?: OpenAI;
  model?: string;
  routing?: Record<string, unknown>;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1568;
// Every chat() call re-walks the whole conversation, so without a cache each image in the 25-message
// seed history would be downloaded and decoded again on every tool round of every turn.
const IMAGE_CACHE_MAX_ENTRIES = 100;
const IMAGE_CACHE_TTL_MS = 15 * 60 * 1000;

type CachedImage = { dataUri: Promise<string | undefined>; at: number };

export class OpenRouterProvider implements AiProvider {
  public readonly id = 'openrouter';
  public readonly defaultModel: string;
  public readonly supportedTools: ProviderToolDefinition[];

  private readonly client: OpenAI;
  private readonly routing: Record<string, unknown>;
  private readonly imageCache = new Map<string, CachedImage>();

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.client = opts.client ?? requireOpenRouterClient('chat');
    this.defaultModel = opts.model ?? config.models.chat;
    this.routing = opts.routing ?? { zdr: true, sort: 'throughput' };

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

    // Add native web search — handled by the model itself, not the host
    this.supportedTools.push({
      name: 'web_search',
      type: 'web_search',
      description: 'Search the web for current information.',
      hostHandled: false,
    });
  }

  async chat(input: ChatInput): Promise<ProviderChatResponse> {
    const messages = await this.toOpenAIMessages(input.messages);

    const functionTools: OpenAI.ChatCompletionTool[] = input.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? {},
        },
      }));

    const hasWebSearch = input.tools.some((t) => t.type === 'web_search');

    const allTools: unknown[] = [...functionTools];
    if (hasWebSearch) {
      allTools.push({ type: 'openrouter:web_search' });
    }

    const response = await this.client.chat.completions.create({
      model: this.defaultModel,
      messages,
      tools: allTools.length > 0 ? (allTools as OpenAI.ChatCompletionTool[]) : undefined,
      tool_choice: input.toolChoice === 'none' ? 'none' : 'auto',
      // @ts-expect-error OpenRouter-specific field
      provider: this.routing,
    });

    return parseOpenRouterResponse(response);
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
        provider: this.routing,
      });

      const text = response.choices[0]?.message?.content?.trim();
      return text || 'I was unable to generate a summary.';
    } catch (error) {
      logger.error('Error in summarizeMessages (openrouter):', error);
      return 'An error occurred while trying to summarize the messages.';
    }
  }

  async generateImage(message: Message, prompt: string, options?: ImageGenerationOptions): Promise<string> {
    const { generateLocalImage } = await import('../tools/localImageGenerator');
    return generateLocalImage(message, prompt, options);
  }

  private async toOpenAIMessages(entries: ConversationEntry[]): Promise<ChatCompletionMessageParam[]> {
    const messages: ChatCompletionMessageParam[] = [];
    let i = 0;

    while (i < entries.length) {
      const entry = entries[i];

      // Merge consecutive tool_call entries (and an optional trailing assistant message) into one
      if (entry.kind === 'tool_call') {
        const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

        while (i < entries.length) {
          const candidate = entries[i];
          if (candidate.kind !== 'tool_call') break;
          toolCalls.push({
            id: candidate.id,
            type: 'function',
            function: { name: candidate.name, arguments: JSON.stringify(candidate.arguments) },
          });
          i++;
        }

        // Check if the next entry is an assistant message to merge as content
        let content: string | null = null;
        const next = entries[i];
        if (next && next.kind === 'message' && next.role === 'assistant') {
          content = next.content.map((p) => (p.type === 'text' ? p.text : `[image]: ${p.url}`)).join('\n');
          i++;
        }

        messages.push({
          role: 'assistant',
          content,
          tool_calls: toolCalls,
        });
        continue;
      }

      messages.push(await this.toOpenAIMessage(entry));
      i++;
    }

    return messages;
  }

  private async toOpenAIMessage(
    entry: Exclude<ConversationEntry, { kind: 'tool_call' }>,
  ): Promise<ChatCompletionMessageParam> {
    if (entry.kind === 'tool_result') {
      return {
        role: 'tool',
        tool_call_id: entry.id,
        content: entry.content,
      };
    }

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

  private async buildContentParts(content: NormalizedContentPart[]): Promise<ChatContentPart[]> {
    if (content.length === 0) return [{ type: 'text', text: '' }];
    const parts: ChatContentPart[] = [];
    for (const part of content) {
      if (part.type === 'image') {
        const dataUri = await this.imageAsDataUri(part.url);
        if (dataUri) {
          parts.push({ type: 'image_url', image_url: { url: dataUri, detail: 'auto' } });
        }
      } else {
        parts.push({ type: 'text', text: part.text });
      }
    }
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }

  /** Memoized fetch + resize of an image URL (bounded, TTL'd); a failed fetch is cached too so it is not retried every round. */
  private imageAsDataUri(url: string): Promise<string | undefined> {
    if (url.startsWith('data:')) return Promise.resolve(url);

    const now = Date.now();
    const cached = this.imageCache.get(url);
    if (cached && now - cached.at < IMAGE_CACHE_TTL_MS) return cached.dataUri;

    const dataUri = this.fetchImageAsBase64(url);
    this.imageCache.set(url, { dataUri, at: now });
    while (this.imageCache.size > IMAGE_CACHE_MAX_ENTRIES) {
      const oldest = this.imageCache.keys().next().value;
      if (oldest === undefined) break;
      this.imageCache.delete(oldest);
    }
    return dataUri;
  }

  private async fetchImageAsBase64(url: string): Promise<string | undefined> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        logger.warn(`Failed to fetch image (HTTP ${response.status}): ${url}`);
        return undefined;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
        logger.warn(`Image too large (${contentLength} bytes), skipping: ${url}`);
        return undefined;
      }

      let buffer: Buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        logger.warn(`Image too large (${buffer.byteLength} bytes), skipping: ${url}`);
        return undefined;
      }

      let resized = false;
      try {
        const image = sharp(buffer);
        const metadata = await image.metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;

        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          logger.info(`Resizing image from ${width}x${height} (max ${MAX_IMAGE_DIMENSION}px): ${url}`);
          buffer = await image
            .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside' })
            .png()
            .toBuffer();
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
}

export function extractToolCalls(message: OpenAI.ChatCompletionMessage | undefined): ProviderToolCall[] {
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

export function parseOpenRouterResponse(response: OpenAI.ChatCompletion): ProviderChatResponse {
  const choices = response?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    const maybeError = (response as unknown as { error?: unknown })?.error;
    const snapshot = JSON.stringify(response ?? null).slice(0, 2000);
    logger.error('OpenRouter returned response with no choices', { error: maybeError, snapshot });
    const error: Error & { rawResponse?: unknown } = new Error(
      `OpenRouter returned no choices${maybeError ? `: ${JSON.stringify(maybeError)}` : ''}`,
    );
    error.rawResponse = response;
    throw error;
  }
  const choice = choices[0];
  const msg = choice?.message;
  const text = msg?.content?.trim() || undefined;
  const toolCalls = extractToolCalls(msg);
  const outputEntries: ConversationEntry[] = [];

  for (const call of toolCalls) {
    outputEntries.push({
      kind: 'tool_call',
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
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
