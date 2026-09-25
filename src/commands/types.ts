// The shape of a context-menu command ("Apps" when right-clicking a message or a user) and the
// dependencies every handler receives. Handlers take their collaborators through CommandDeps rather than
// importing singletons, so tests can drive each one with fakes (agent, summary pipeline, media, model,
// memory store, clock) and never touch the network or ./data.
import type {
  ApplicationCommandType,
  Message,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import type { AudioInput, VideoInput } from '../ai/media';
import type { MemoryStore } from '../ai/memory/memoryStore';

/** Result of the channel summary pipeline: the summary text, or why there is none (shown privately). */
export type ChannelSummary = { ok: true; text: string } | { ok: false; reason: string };

export type SummarizeRequest = { message: Message; start: Date; end: Date; requesterId?: string };

/**
 * A one-shot, tool-less chat completion: a system prompt, one user turn, one text answer. `maxTokens` is
 * only a ceiling (just the generated tokens are billed); keep it generous so a CHAT_MODEL that reasons
 * before answering still has room left for the answer itself.
 */
export type CompletionRequest = { system: string; user: string; maxTokens: number; temperature?: number };

export type CommandDeps = {
  /** Answers a message as if the bot had been pinged on it (the chat agent). */
  askAgent: (message: Message) => Promise<void>;
  summarize: (request: SummarizeRequest) => Promise<ChannelSummary>;
  transcribeAudio: (input: AudioInput) => Promise<string | undefined>;
  getCachedTranscript: (messageId: string) => string | undefined;
  describeVideo: (input: VideoInput) => Promise<string | undefined>;
  /** One chat-model call (ZDR, tagged 'command'). Resolves to the trimmed answer, undefined when empty; throws on API errors. */
  complete: (request: CompletionRequest) => Promise<string | undefined>;
  memoryStore: () => MemoryStore;
  now: () => Date;
};

export type MessageCommand = {
  type: ApplicationCommandType.Message;
  /** Shown verbatim under Apps (1–32 characters, spaces and mixed case allowed). Changing it re-creates the command. */
  name: string;
  run: (interaction: MessageContextMenuCommandInteraction, deps: CommandDeps) => Promise<void>;
};

export type UserCommand = {
  type: ApplicationCommandType.User;
  name: string;
  run: (interaction: UserContextMenuCommandInteraction, deps: CommandDeps) => Promise<void>;
};

export type ContextMenuCommand = MessageCommand | UserCommand;

/**
 * An expected, user-facing outcome that ends a command early ("nothing to transcribe there"). The
 * dispatcher shows `userMessage` privately to the invoker and logs at INFO — unlike an unexpected
 * error, which gets the generic in-character failure line and a WARN.
 */
export class CommandError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'CommandError';
  }
}
