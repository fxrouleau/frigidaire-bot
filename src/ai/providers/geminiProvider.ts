import * as crypto from 'node:crypto';
import {
  type Content,
  FunctionCallingMode,
  type FunctionDeclaration,
  type Part as GeminiSdkPart,
  type GenerateContentRequest,
  GoogleGenerativeAI,
  type Tool,
} from '@google/generative-ai';
import type { Message } from 'discord.js';
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

type GeminiInlineData = { data: string; mimeType: string };
type GeminiFunctionCall = { name: string; args?: Record<string, unknown>; thoughtSignature?: string };
type GeminiFunctionResponse = { name: string; response: unknown };
type GeminiPart = {
  text?: string;
  inlineData?: GeminiInlineData;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  thoughtSignature?: string;
};

export class GeminiProvider implements AiProvider {
  public readonly id = 'gemini';
  public readonly displayName = 'Gemini';
  public readonly personality =
    'precise, fast, and cooperative; concise but friendly. Provide decisive answers with minimal hedging.';
  public readonly defaultModel = process.env.GEMINI_MODEL || 'gemini-3.0-pro-preview';
  public readonly supportedTools: ProviderToolDefinition[];

  private readonly apiKey: string;

  constructor(config: { apiKey: string }) {
    this.apiKey = config.apiKey;
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
    const client = new GoogleGenerativeAI(this.apiKey);
    const functionDeclarations: FunctionDeclaration[] = input.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: this.stripAdditionalProperties(t.parameters) as FunctionDeclaration['parameters'],
      }));

    const model = client.getGenerativeModel({
      model: this.defaultModel,
      tools: [
        {
          functionDeclarations,
        },
        { googleSearchRetrieval: {} },
        { codeExecution: {} },
      ] as Tool[],
    });

    const { systemInstruction, contents } = this.buildPayload(input.messages);

    const request: GenerateContentRequest = {
      systemInstruction,
      contents,
      toolConfig: {
        functionCallingConfig: {
          mode: input.toolChoice === 'none' ? FunctionCallingMode.NONE : FunctionCallingMode.AUTO,
        },
      },
      // Encourage code execution and search availability
      safetySettings: [],
    };

    const result = await model.generateContent(request);

    const parts: GeminiPart[] = (result?.response?.candidates?.[0]?.content?.parts as GeminiPart[]) ?? [];
    const text = this.extractText(parts);
    const { toolCalls, thoughtSignatures } = this.extractToolCalls(parts);

    const outputEntries: ConversationEntry[] = [];
    for (const call of toolCalls) {
      outputEntries.push({
        kind: 'tool_call',
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        thoughtSignature: call.thoughtSignature,
      });
    }
    if (text) {
      outputEntries.push({
        kind: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      });
    }

    return {
      text,
      toolCalls,
      outputEntries,
      thoughts: thoughtSignatures.length > 0 ? thoughtSignatures : undefined,
      raw: result,
    };
  }

  async summarizeMessages(message: Message, startTime: string, endTime: string): Promise<string> {
    try {
      const prepared = await prepareSummaryPrompt(message, startTime, endTime);
      if (prepared.error) return prepared.error;
      const prompt = prepared.prompt;

      const client = new GoogleGenerativeAI(this.apiKey);
      const model = client.getGenerativeModel({ model: this.defaultModel });
      const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
      const parts = (result?.response?.candidates?.[0]?.content?.parts as GeminiPart[]) ?? [];
      return this.extractText(parts) || 'I was unable to generate a summary.';
    } catch (error) {
      logger.error('Error in summarizeMessages (gemini):', error);
      return 'An error occurred while trying to summarize the messages.';
    }
  }

  async generateImageLocal(message: Message, prompt: string, options?: { refinePrevious?: boolean }): Promise<string> {
    const { generateLocalImage } = await import('../tools/localImageGenerator');
    return generateLocalImage(message, prompt, { refinePrevious: options?.refinePrevious });
  }

  private buildPayload(entries: ConversationEntry[]): { systemInstruction?: string; contents: Content[] } {
    const contents: Content[] = [];
    let systemInstruction: string | undefined;

    for (const entry of entries) {
      if (entry.kind === 'message') {
        if (entry.role === 'developer' && !systemInstruction) {
          systemInstruction = entry.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
          continue;
        }
        contents.push({
          role: this.mapRole(entry.role),
          parts: entry.content.map((part) => this.mapContent(part)).filter(Boolean) as GeminiSdkPart[],
        });
      } else if (entry.kind === 'tool_call') {
        contents.push({
          role: 'model',
          parts: [
            {
              functionCall: {
                name: entry.name,
                args: entry.arguments,
              },
            } as GeminiSdkPart,
          ] as GeminiSdkPart[],
        });
      } else if (entry.kind === 'tool_result') {
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: entry.name,
                response: { output: entry.content },
              },
            } as GeminiSdkPart,
          ] as GeminiSdkPart[],
        });
      }
    }

    return { systemInstruction, contents };
  }

  private mapRole(role: 'assistant' | 'user' | 'developer' | 'system'): 'user' | 'model' | 'function' {
    if (role === 'assistant') return 'model';
    return 'user';
  }

  private mapContent(part: NormalizedContentPart):
    | {
        text?: string;
        inlineData?: { data: string; mimeType: string };
      }
    | undefined {
    if (part.type === 'text') {
      return { text: part.text };
    }
    return undefined;
  }

  private extractText(parts: GeminiPart[]): string | undefined {
    const texts = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim();
    return texts.length > 0 ? texts : undefined;
  }

  private extractToolCalls(parts: GeminiPart[]): { toolCalls: ProviderToolCall[]; thoughtSignatures: string[] } {
    const calls: ProviderToolCall[] = [];
    const thoughtSignatures: string[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        if (part.thoughtSignature) {
          thoughtSignatures.push(part.thoughtSignature);
        }
        calls.push({
          id: crypto.randomUUID(),
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
          thoughtSignature: part.thoughtSignature,
        });
      }
    }
    return { toolCalls: calls, thoughtSignatures };
  }

  private stripAdditionalProperties<T>(schema: T): T {
    if (schema === null || typeof schema !== 'object') {
      return schema;
    }
    if (Array.isArray(schema)) {
      return schema.map((item) => this.stripAdditionalProperties(item)) as unknown as T;
    }
    const entries = Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, value]) => [key, this.stripAdditionalProperties(value)]);
    return Object.fromEntries(entries) as T;
  }
}
