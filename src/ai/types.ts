import type { Message } from 'discord.js';

export type NormalizedContentPart = { type: 'text'; text: string } | { type: 'image'; url: string };

export type ConversationEntry =
  | {
      kind: 'message';
      role: 'system' | 'developer' | 'assistant' | 'user';
      content: NormalizedContentPart[];
      name?: string;
      /**
       * Discord ids of the message(s) this entry renders: the source message of a user entry, every chunk
       * of a sent reply, every message quoted in a reply-context entry. Lets a turn tell whether a message
       * is already in the window (e.g. the one being replied to); dropped along with the entry on trim.
       */
      messageIds?: string[];
      /** Ids of the long-term memories rendered into this (developer) entry, for cross-turn dedup. */
      memoryIds?: number[];
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
// v3: message entries carry their Discord `messageIds` / rendered `memoryIds`; the state carries
// `lastSeenMessageId`.
export const CONVERSATION_STATE_SCHEMA_VERSION = 3;

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
  /** The model that actually answered (OpenRouter's `model` field; differs from the request under fallbacks). */
  servedBy?: string;
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

export type ImageGenerationOptions = {
  refinePrevious?: boolean;
  sourceImageUrl?: string;
  /** The current chat turn: the generated image is attached to the bot's reply instead of posted on its own. */
  turn?: TurnEffects;
};

export interface AiProvider {
  id: string;
  defaultModel: string;
  /** Every model a chat request may be served by, primary first (fallback routing). Absent ⇒ [defaultModel]. */
  readonly chatModels?: string[];
  supportedTools: ProviderToolDefinition[];
  chat(input: ChatInput): Promise<ProviderChatResponse>;
  generateImage?(message: Message, prompt: string, options?: ImageGenerationOptions): Promise<string>;
}
