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

// Bump whenever the ConversationEntry/ConversationState shape changes: persisted rows carrying an
// older version are discarded on restore (the conversation simply starts fresh), so a shape change
// can never feed a stale-shaped blob back into the running orchestrator.
// v2: dropped the multi-provider era fields (providerId, thoughts, thoughtSignature).
export const CONVERSATION_STATE_SCHEMA_VERSION = 2;

export type ProviderToolType = 'function' | 'web_search';

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

/** A file a tool wants attached to the bot's reply for this turn (a generated image, a sandbox chart, …). */
export type TurnFile = { attachment: Buffer; name: string };

/**
 * Side effects tools produce during one chat turn, applied by the orchestrator when it sends the reply:
 * files ride on the reply itself instead of a separate message, and a turn whose only output is a
 * reaction may end without any text.
 */
export type TurnEffects = {
  files: TurnFile[];
  /** Emojis already added as reactions to the triggering message this turn. */
  reactions: string[];
};

export function createTurnEffects(): TurnEffects {
  return { files: [], reactions: [] };
}

export interface ToolHandlerContext {
  message: Message;
  provider: AiProvider;
  channelId: string;
  turn: TurnEffects;
}

export type ToolHandler = (ctx: ToolHandlerContext, args: Record<string, unknown>) => Promise<string>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
  /**
   * Optional gate evaluated when the provider builds its tool list: a tool whose backing feature is not
   * configured (e.g. run_code without SANDBOX_URL) is simply not offered to the model. Absent ⇒ enabled.
   */
  isEnabled?: () => boolean;
};

export type ChatInput = {
  messages: ConversationEntry[];
  tools: ProviderToolDefinition[];
  toolChoice?: 'auto' | 'none';
};

export type ImageGenerationOptions = { refinePrevious?: boolean; sourceImageUrl?: string };

export interface AiProvider {
  id: string;
  defaultModel: string;
  supportedTools: ProviderToolDefinition[];
  chat(input: ChatInput): Promise<ProviderChatResponse>;
  summarizeMessages?(message: Message, startTime: string, endTime: string): Promise<string>;
  generateImage?(message: Message, prompt: string, options?: ImageGenerationOptions): Promise<string>;
}
