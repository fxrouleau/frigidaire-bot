// Typed factories for context-menu command interactions (and the guild/message pieces they touch), for
// tests of src/commands/. The response methods follow discord.js's state machine — deferReply/reply only
// on a fresh interaction, editReply/followUp/deleteReply only after one — and throw like discord.js does
// on a misuse, so a handler that would crash in production crashes in its test too. Every response is
// recorded in call order with its visibility.
import {
  ApplicationCommandType,
  type Client,
  Collection,
  type Guild,
  type Message,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  MessageFlagsBitField,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import type { AudioInput, VideoInput, VideoOutcome } from '../ai/media';
import type { MemoryStore } from '../ai/memory/memoryStore';
import type { ChannelSummary, CommandDeps, CompletionRequest, SummarizeRequest } from '../commands/types';
import { createFakeMessage, type FakeMessageOptions } from './fakeDiscord';
import { createRecorder, type Recorder } from './recorder';

export type InteractionResponseMethod = 'deferReply' | 'reply' | 'editReply' | 'followUp' | 'deleteReply';

export type RecordedResponse = {
  method: InteractionResponseMethod;
  /** The text sent (undefined for deferReply/deleteReply). */
  content?: string;
  /** Whether this response is only visible to the invoker. */
  ephemeral: boolean;
  options: unknown;
};

export type FakeGuildOptions = {
  id?: string;
  name?: string;
  /** Members the guild knows, by user id → current display name. Unknown ids reject like "Unknown Member". */
  members?: Record<string, string>;
  /** Makes guild.commands.set() reject with this error. */
  commandsSetError?: unknown;
};

export type FakeGuild = {
  guild: Guild;
  recorders: {
    membersFetch: Recorder<[string], Promise<unknown>>;
    commandsSet: Recorder<[unknown[]], Promise<unknown>>;
  };
};

/** A guild with a member cache/fetch and a recording commands.set(). */
export function createFakeGuild(opts: FakeGuildOptions = {}): FakeGuild {
  const members = opts.members ?? {};
  const membersFetch = createRecorder<[string], Promise<unknown>>(async (userId: string) => {
    const displayName = members[userId];
    if (displayName === undefined) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return { id: userId, displayName };
  });
  const commandsSet = createRecorder<[unknown[]], Promise<unknown>>(async (payload: unknown[]) => {
    if (opts.commandsSetError !== undefined) throw opts.commandsSetError;
    return new Collection(payload.map((command, index) => [`command-${index}`, command]));
  });
  const built = {
    id: opts.id ?? 'guild-1',
    name: opts.name ?? 'Test Guild',
    members: { cache: new Collection<string, unknown>(), fetch: membersFetch },
    commands: { set: commandsSet },
  };
  return { guild: built as unknown as Guild, recorders: { membersFetch, commandsSet } };
}

export type FakeTargetMessageOptions = FakeMessageOptions & {
  guild?: Guild | null;
  /** Rendered text with mentions resolved; defaults to `content`. */
  cleanContent?: string;
  voiceMessage?: boolean;
  /** Replaces createFakeMessage's attachments with fuller ones (duration). */
  mediaAttachments?: Array<{ url: string; contentType: string | null; name?: string; duration?: number | null }>;
  /** The channel is missing from the cache until client.channels.fetch() is called. */
  channelUncached?: boolean;
  /** Makes client.channels.fetch() reject (with channelUncached: the channel can't be resolved at all). */
  channelFetchFails?: boolean;
};

export type FakeTargetMessage = ReturnType<typeof createFakeMessage> & {
  recorders: ReturnType<typeof createFakeMessage>['recorders'] & {
    channelsFetch: Recorder<[string], Promise<unknown>>;
  };
};

let postedCounter = 0;

/**
 * A message as a context-menu command receives it: createFakeMessage() plus the fields the commands
 * read (url, channelId, flags, cleanContent, guild, attachment durations) and a client whose
 * channels.fetch() fills the channel cache. Replies and sends resolve to a posted message with a url.
 */
export function createFakeTargetMessage(opts: FakeTargetMessageOptions = {}): FakeTargetMessage {
  const posted = async () => {
    postedCounter += 1;
    return {
      id: `posted-${postedCounter}`,
      url: `https://discord.com/channels/guild-1/channel/posted-${postedCounter}`,
    };
  };
  const fake = createFakeMessage({ replyImpl: posted, sendImpl: posted, ...opts });
  const message = fake.message as unknown as Record<string, unknown>;
  const channelId = opts.channelId ?? 'channel-1';
  const messageId = opts.messageId ?? 'msg-1';

  const realChannel = message.channel;
  let cachedChannel: unknown = opts.channelUncached ? null : realChannel;
  const channelsFetch = createRecorder<[string], Promise<unknown>>(async (_id: string) => {
    if (opts.channelFetchFails) throw new Error('Missing Access');
    cachedChannel = realChannel;
    return realChannel;
  });
  Object.defineProperty(message, 'channel', { get: () => cachedChannel, configurable: true });

  const baseClient = message.client as { user: { id: string; displayName: string } };
  message.client = { ...baseClient, application: { id: baseClient.user.id }, channels: { fetch: channelsFetch } };
  message.channelId = channelId;
  message.url = `https://discord.com/channels/guild-1/${channelId}/${messageId}`;
  message.cleanContent = opts.cleanContent ?? opts.content ?? '';
  message.flags = new MessageFlagsBitField(opts.voiceMessage ? MessageFlags.IsVoiceMessage : 0);
  message.guild = opts.guild ?? null;

  if (opts.mediaAttachments) {
    const attachments = new Collection<string, unknown>();
    opts.mediaAttachments.forEach((att, index) => {
      attachments.set(`att-${index}`, {
        url: att.url,
        contentType: att.contentType,
        name: att.name ?? `file-${index}`,
        duration: att.duration ?? null,
      });
    });
    message.attachments = attachments;
  }

  return { ...fake, recorders: { ...fake.recorders, channelsFetch } };
}

export type FakeInteractionOptions = {
  commandName: string;
  inGuild?: boolean;
  guild?: Guild | null;
  invokerId?: string;
  invokerUsername?: string;
  /** The invoker's server display name; null ⇒ no member object. */
  invokerDisplayName?: string | null;
  botUserId?: string;
  channelId?: string;
  /** Makes the named response method reject (e.g. an expired interaction token). */
  failOn?: Partial<Record<InteractionResponseMethod, unknown>>;
};

export type FakeInteractionHandle<T> = {
  interaction: T;
  responses: RecordedResponse[];
  /** Text of every non-deferral response, in order. */
  texts: () => string[];
};

function contentOf(options: unknown): string | undefined {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object' && 'content' in options) {
    const content = (options as { content?: unknown }).content;
    return typeof content === 'string' ? content : undefined;
  }
  return undefined;
}

function isEphemeralFlag(options: unknown): boolean {
  if (!options || typeof options !== 'object' || !('flags' in options)) return false;
  const flags = (options as { flags?: unknown }).flags;
  return typeof flags === 'number' && (flags & MessageFlags.Ephemeral) !== 0;
}

function buildInteraction(
  opts: FakeInteractionOptions,
  commandType: ApplicationCommandType,
  extra: Record<string, unknown>,
): { interaction: Record<string, unknown>; responses: RecordedResponse[] } {
  const responses: RecordedResponse[] = [];
  const botUserId = opts.botUserId ?? 'bot-1';
  const invokerId = opts.invokerId ?? 'invoker-1';
  const invokerUsername = opts.invokerUsername ?? 'invoker';
  const invokerDisplayName = opts.invokerDisplayName === undefined ? 'Invoker' : opts.invokerDisplayName;
  const inGuild = opts.inGuild ?? true;

  const state = { deferred: false, replied: false, ephemeral: null as boolean | null };
  const failIfConfigured = (method: InteractionResponseMethod) => {
    if (opts.failOn && method in opts.failOn) throw opts.failOn[method];
  };
  const notReplied = () =>
    Object.assign(new Error('The reply to this interaction has not been sent or deferred.'), {
      code: 'InteractionNotReplied',
    });
  const alreadyReplied = () =>
    Object.assign(new Error('The reply to this interaction has already been sent or deferred.'), {
      code: 'InteractionAlreadyReplied',
    });

  const interaction: Record<string, unknown> = {
    id: 'interaction-1',
    commandName: opts.commandName,
    commandType,
    channelId: opts.channelId ?? 'channel-1',
    guildId: inGuild ? 'guild-1' : null,
    guild: opts.guild ?? null,
    user: { id: invokerId, username: invokerUsername, displayName: invokerDisplayName ?? invokerUsername },
    member: inGuild && invokerDisplayName !== null ? { id: invokerId, displayName: invokerDisplayName } : null,
    client: { user: { id: botUserId, displayName: 'Frigidaire' }, application: { id: botUserId } },
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    get ephemeral() {
      return state.ephemeral;
    },
    inGuild: () => inGuild,
    inCachedGuild: () => inGuild,
    isContextMenuCommand: () => true,
    isMessageContextMenuCommand: () => commandType === ApplicationCommandType.Message,
    isUserContextMenuCommand: () => commandType === ApplicationCommandType.User,
    isChatInputCommand: () => false,
    async deferReply(options?: unknown) {
      failIfConfigured('deferReply');
      if (state.deferred || state.replied) throw alreadyReplied();
      state.deferred = true;
      state.ephemeral = isEphemeralFlag(options);
      responses.push({ method: 'deferReply', ephemeral: state.ephemeral, options });
    },
    async reply(options: unknown) {
      failIfConfigured('reply');
      if (state.deferred || state.replied) throw alreadyReplied();
      state.replied = true;
      state.ephemeral = isEphemeralFlag(options);
      responses.push({ method: 'reply', content: contentOf(options), ephemeral: state.ephemeral, options });
    },
    async editReply(options: unknown) {
      failIfConfigured('editReply');
      if (!state.deferred && !state.replied) throw notReplied();
      state.replied = true;
      responses.push({
        method: 'editReply',
        content: contentOf(options),
        ephemeral: state.ephemeral ?? false,
        options,
      });
      return { id: 'reply-1' };
    },
    async followUp(options: unknown) {
      failIfConfigured('followUp');
      if (!state.deferred && !state.replied) throw notReplied();
      state.replied = true;
      responses.push({ method: 'followUp', content: contentOf(options), ephemeral: isEphemeralFlag(options), options });
      return { id: `followup-${responses.length}` };
    },
    async deleteReply() {
      failIfConfigured('deleteReply');
      if (!state.deferred && !state.replied) throw notReplied();
      responses.push({ method: 'deleteReply', ephemeral: state.ephemeral ?? false, options: undefined });
    },
    ...extra,
  };
  return { interaction, responses };
}

function handle<T>(built: {
  interaction: Record<string, unknown>;
  responses: RecordedResponse[];
}): FakeInteractionHandle<T> {
  return {
    interaction: built.interaction as unknown as T,
    responses: built.responses,
    texts: () => built.responses.filter((r) => r.content !== undefined).map((r) => r.content as string),
  };
}

/** A message context-menu interaction ("Apps" on a message) targeting `target`. */
export function createFakeMessageCommandInteraction(
  target: Message,
  opts: FakeInteractionOptions,
): FakeInteractionHandle<MessageContextMenuCommandInteraction> {
  return handle(buildInteraction(opts, ApplicationCommandType.Message, { targetId: target.id, targetMessage: target }));
}

export type FakeTargetUser = {
  id: string;
  username?: string;
  displayName?: string;
  /** Server display name; null ⇒ not a member (left the server). */
  memberDisplayName?: string | null;
};

/** A user context-menu interaction ("Apps" on a member) targeting `target`. */
export function createFakeUserCommandInteraction(
  target: FakeTargetUser,
  opts: FakeInteractionOptions,
): FakeInteractionHandle<UserContextMenuCommandInteraction> {
  const username = target.username ?? 'targetuser';
  const targetUser = { id: target.id, username, displayName: target.displayName ?? username, bot: false };
  const targetMember =
    target.memberDisplayName === null || target.memberDisplayName === undefined
      ? null
      : { id: target.id, displayName: target.memberDisplayName };
  return handle(buildInteraction(opts, ApplicationCommandType.User, { targetId: target.id, targetUser, targetMember }));
}

/** A ready client whose guild cache holds the given guilds (for command registration). */
export function createFakeReadyClient(guilds: Guild[], opts: { botUserId?: string } = {}): Client<true> {
  const botUserId = opts.botUserId ?? 'bot-1';
  const cache = new Collection<string, Guild>(guilds.map((g) => [g.id, g]));
  const built = {
    user: { id: botUserId, tag: 'Frigidaire#0001', displayName: 'Frigidaire' },
    application: { id: botUserId },
    guilds: { cache },
  };
  return built as unknown as Client<true>;
}

export type FakeCommandDeps = {
  deps: CommandDeps;
  recorders: {
    askAgent: Recorder<[Message], Promise<void>>;
    summarize: Recorder<[SummarizeRequest], Promise<ChannelSummary>>;
    transcribeAudio: Recorder<[AudioInput], Promise<string | undefined>>;
    getCachedTranscript: Recorder<[string], string | undefined>;
    watchVideo: Recorder<[VideoInput], Promise<VideoOutcome>>;
    complete: Recorder<[CompletionRequest], Promise<string | undefined>>;
  };
};

export const FAKE_NOW = new Date('2026-09-25T16:00:00Z');

/**
 * CommandDeps where every collaborator is recorded: the agent and media do nothing, the summary is a
 * canned text, the model answers nothing, the clock is FAKE_NOW, and the memory store is `store` (pass
 * an in-memory MemoryStore). Override any collaborator's implementation; calls are still recorded.
 */
export function createFakeCommandDeps(
  opts: {
    store?: MemoryStore;
    askAgent?: CommandDeps['askAgent'];
    summarize?: CommandDeps['summarize'];
    transcribeAudio?: CommandDeps['transcribeAudio'];
    getCachedTranscript?: CommandDeps['getCachedTranscript'];
    watchVideo?: CommandDeps['watchVideo'];
    complete?: CommandDeps['complete'];
    now?: Date;
  } = {},
): FakeCommandDeps {
  const recorders = {
    askAgent: createRecorder<[Message], Promise<void>>(opts.askAgent ?? (async () => {})),
    summarize: createRecorder<[SummarizeRequest], Promise<ChannelSummary>>(
      opts.summarize ?? (async () => ({ ok: true, text: 'they argued about pineapple pizza' })),
    ),
    transcribeAudio: createRecorder<[AudioInput], Promise<string | undefined>>(
      opts.transcribeAudio ?? (async () => undefined),
    ),
    getCachedTranscript: createRecorder<[string], string | undefined>(opts.getCachedTranscript ?? (() => undefined)),
    watchVideo: createRecorder<[VideoInput], Promise<VideoOutcome>>(
      opts.watchVideo ?? (async () => ({ status: 'unavailable' })),
    ),
    complete: createRecorder<[CompletionRequest], Promise<string | undefined>>(
      opts.complete ?? (async () => undefined),
    ),
  };
  const now = opts.now ?? FAKE_NOW;
  const deps: CommandDeps = {
    ...recorders,
    memoryStore: () => {
      if (!opts.store) throw new Error('This test did not provide a memory store');
      return opts.store;
    },
    now: () => now,
  };
  return { deps, recorders };
}
