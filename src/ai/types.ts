import type { Message } from 'discord.js';

export type NormalizedContentPart = { type: 'text'; text: string } | { type: 'image'; url: string };

export type ConversationEntry =
  | {
      kind: 'message';
      role: 'system' | 'developer' | 'assistant' | 'user';
      content: NormalizedContentPart[];
      name?: string;
    }
  | {
      kind: 'tool_call';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: 'tool_result';
      id: string;
      name: string;
      content: string;
    };

export type ProviderToolType = 'function' | 'web_search' | 'code_interpreter';

export type ProviderToolDefinition = {
  name: string;
  type: ProviderToolType;
  description?: string;
  parameters?: Record<string, unknown>;
  /**
   * True when the host (this bot) is responsible for executing the tool and sending the output
   * back to the provider.
   */
  hostHandled?: boolean;
};

export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ProviderChatResponse = {
  text?: string;
  toolCalls: ProviderToolCall[];
  outputEntries: ConversationEntry[];
  raw?: unknown;
};

export interface ToolHandlerContext {
  message: Message;
  providerId: string;
  provider: AiProvider;
  channelId: string;
  switchProvider: (providerId: string) => { provider?: AiProvider; error?: string };
}

export type ToolHandler = (ctx: ToolHandlerContext, args: Record<string, unknown>) => Promise<string>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
};

export interface AiProvider {
  id: string;
  displayName: string;
  personality: string;
  defaultModel: string;
  supportedTools: ProviderToolDefinition[];
  chat(input: {
    messages: ConversationEntry[];
    tools: ProviderToolDefinition[];
    toolChoice?: 'auto' | 'none';
  }): Promise<ProviderChatResponse>;
  summarizeMessages?(
    message: Message,
    startTime: string,
    endTime: string,
  ): Promise<string>;
  generateImage?(message: Message, prompt: string): Promise<string>;
}
