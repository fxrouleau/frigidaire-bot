// Typed factories for context-menu command interactions, the button / select-menu / modal-submit
// interactions that follow them (the notes viewer), and the guild/message pieces they touch, for tests of
// src/commands/. The response methods follow discord.js's state machine — deferReply/reply/update/
// deferUpdate/showModal only on a fresh interaction, editReply/followUp/deleteReply only after one — and
// throw like discord.js does on a misuse, so a handler that would crash in production crashes in its test
// too. Where discord.js lets a call through that Discord itself refuses, the fake refuses too: nothing
// after a modal (a modal response has no message to edit or follow up), update/deferUpdate only on a
// component or on a modal submitted from a message component, and showModal never on a modal submit.
// Every response is recorded in call order with its visibility.
import {
  ApplicationCommandType,
  type ButtonInteraction,
  type Client,
  Collection,
  ComponentType,
  type Guild,
  type Message,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  MessageFlagsBitField,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import type { AudioInput, VideoInput, VideoOutcome } from '../ai/media';
import type { MemoryStore } from '../ai/memory/memoryStore';
import type { EditProposal, EditRequest } from '../ai/memory/notes/dreamer';
import { NotesStore } from '../ai/memory/notes/notesStore';
import type { ChannelSummary, CommandDeps, CompletionRequest, SummarizeRequest } from '../commands/types';
import { canonicalUserId } from '../linkedAccounts';
import { createFakeMessage, type FakeMessageOptions } from './fakeDiscord';
import { createRecorder, type Recorder } from './recorder';

export type InteractionResponseMethod =
  | 'deferReply'
  | 'reply'
  | 'editReply'
  | 'followUp'
  | 'deleteReply'
  | 'update'
  | 'deferUpdate'
  | 'showModal';

export type RecordedResponse = {
  method: InteractionResponseMethod;
  /** The text sent (undefined for deferReply/deferUpdate/deleteReply/showModal). */
  content?: string;
  /** Whether this response is only visible to the invoker. */
  ephemeral: boolean;
  /** What was passed (the modal for showModal). */
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

/** Which response methods a fake has: a command's, a message component's, or a modal submit's. */
type FakeInteractionKind = 'command' | 'component' | 'modal';

type BuildOptions = FakeInteractionOptions & {
  kind: FakeInteractionKind;
  /** Whether the message a component (or a modal opened from one) is on is ephemeral. Default true. */
  messageEphemeral?: boolean;
  /** A modal submit that came from a message component (it can update that message). */
  fromMessage?: boolean;
};

function buildInteraction(
  opts: BuildOptions,
  commandType: ApplicationCommandType | undefined,
  extra: Record<string, unknown>,
): { interaction: Record<string, unknown>; responses: RecordedResponse[] } {
  const responses: RecordedResponse[] = [];
  const botUserId = opts.botUserId ?? 'bot-1';
  const invokerId = opts.invokerId ?? 'invoker-1';
  const invokerUsername = opts.invokerUsername ?? 'invoker';
  const invokerDisplayName = opts.invokerDisplayName === undefined ? 'Invoker' : opts.invokerDisplayName;
  const inGuild = opts.inGuild ?? true;
  const kind = opts.kind;
  const canUpdate = kind === 'component' || (kind === 'modal' && opts.fromMessage === true);

  const state = { deferred: false, replied: false, ephemeral: null as boolean | null, modalShown: false };
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
  // What Discord answers when a modal response is edited or followed up: there is no message behind it.
  const noMessage = () => Object.assign(new Error('Unknown Message'), { code: 10008 });
  const mustBeFresh = () => {
    if (state.deferred || state.replied) throw alreadyReplied();
  };
  const mustHaveResponded = () => {
    if (!state.deferred && !state.replied) throw notReplied();
    if (state.modalShown) throw noMessage();
  };
  const missing = (method: string) => () => {
    throw new TypeError(`interaction.${method} is not a function`);
  };

  const interaction: Record<string, unknown> = {
    id: 'interaction-1',
    ...(commandType !== undefined ? { commandName: opts.commandName, commandType } : {}),
    channelId: opts.channelId ?? 'channel-1',
    guildId: inGuild ? 'guild-1' : null,
    guild: opts.guild ?? null,
    user: { id: invokerId, username: invokerUsername, displayName: invokerDisplayName ?? invokerUsername },
    member: inGuild && invokerDisplayName !== null ? { id: invokerId, displayName: invokerDisplayName } : null,
    client: {
      user: { id: botUserId, displayName: 'Frigidaire' },
      application: { id: botUserId },
      users: { cache: new Collection<string, unknown>() },
    },
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
    isContextMenuCommand: () => kind === 'command',
    isMessageContextMenuCommand: () => kind === 'command' && commandType === ApplicationCommandType.Message,
    isUserContextMenuCommand: () => kind === 'command' && commandType === ApplicationCommandType.User,
    isChatInputCommand: () => false,
    isMessageComponent: () => kind === 'component',
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal',
    async deferReply(options?: unknown) {
      failIfConfigured('deferReply');
      mustBeFresh();
      state.deferred = true;
      state.ephemeral = isEphemeralFlag(options);
      responses.push({ method: 'deferReply', ephemeral: state.ephemeral, options });
    },
    async reply(options: unknown) {
      failIfConfigured('reply');
      mustBeFresh();
      state.replied = true;
      state.ephemeral = isEphemeralFlag(options);
      responses.push({ method: 'reply', content: contentOf(options), ephemeral: state.ephemeral, options });
    },
    async editReply(options: unknown) {
      failIfConfigured('editReply');
      mustHaveResponded();
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
      mustHaveResponded();
      state.replied = true;
      responses.push({ method: 'followUp', content: contentOf(options), ephemeral: isEphemeralFlag(options), options });
      return { id: `followup-${responses.length}` };
    },
    async deleteReply() {
      failIfConfigured('deleteReply');
      mustHaveResponded();
      responses.push({ method: 'deleteReply', ephemeral: state.ephemeral ?? false, options: undefined });
    },
    update: canUpdate
      ? async (options: unknown) => {
          failIfConfigured('update');
          mustBeFresh();
          state.replied = true;
          state.ephemeral = opts.messageEphemeral ?? true;
          responses.push({ method: 'update', content: contentOf(options), ephemeral: state.ephemeral, options });
        }
      : missing('update'),
    deferUpdate: canUpdate
      ? async () => {
          failIfConfigured('deferUpdate');
          mustBeFresh();
          state.deferred = true;
          state.ephemeral = opts.messageEphemeral ?? true;
          responses.push({ method: 'deferUpdate', ephemeral: state.ephemeral, options: undefined });
        }
      : missing('deferUpdate'),
    showModal:
      kind === 'modal'
        ? missing('showModal')
        : async (modal: unknown) => {
            failIfConfigured('showModal');
            mustBeFresh();
            state.replied = true;
            state.modalShown = true;
            responses.push({ method: 'showModal', ephemeral: true, options: modal });
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
  return handle(
    buildInteraction({ ...opts, kind: 'command' }, ApplicationCommandType.Message, {
      targetId: target.id,
      targetMessage: target,
    }),
  );
}

export type FakeTargetUser = {
  id: string;
  username?: string;
  displayName?: string;
  /** Server display name; null ⇒ not a member (left the server). */
  memberDisplayName?: string | null;
  bot?: boolean;
};

/** A user context-menu interaction ("Apps" on a member) targeting `target`. */
export function createFakeUserCommandInteraction(
  target: FakeTargetUser,
  opts: FakeInteractionOptions,
): FakeInteractionHandle<UserContextMenuCommandInteraction> {
  const username = target.username ?? 'targetuser';
  const targetUser = { id: target.id, username, displayName: target.displayName ?? username, bot: target.bot ?? false };
  const targetMember =
    target.memberDisplayName === null || target.memberDisplayName === undefined
      ? null
      : { id: target.id, displayName: target.memberDisplayName };
  return handle(
    buildInteraction({ ...opts, kind: 'command' }, ApplicationCommandType.User, {
      targetId: target.id,
      targetUser,
      targetMember,
    }),
  );
}

export type FakeComponentOptions = Omit<FakeInteractionOptions, 'commandName'> & {
  customId: string;
  /** Whether the message the component is on is ephemeral (the notes viewer's is). Default true. */
  messageEphemeral?: boolean;
};

function componentMessage(opts: FakeComponentOptions): Record<string, unknown> {
  return {
    id: 'component-message-1',
    flags: new MessageFlagsBitField(opts.messageEphemeral === false ? 0 : MessageFlags.Ephemeral),
  };
}

/** A button click on a message (a message component interaction). */
export function createFakeButtonInteraction(opts: FakeComponentOptions): FakeInteractionHandle<ButtonInteraction> {
  return handle(
    buildInteraction({ ...opts, commandName: '', kind: 'component' }, undefined, {
      customId: opts.customId,
      componentType: ComponentType.Button,
      message: componentMessage(opts),
      isButton: () => true,
    }),
  );
}

/** A choice in a string select menu on a message (a message component interaction). */
export function createFakeSelectInteraction(
  opts: FakeComponentOptions & { values: string[] },
): FakeInteractionHandle<StringSelectMenuInteraction> {
  return handle(
    buildInteraction({ ...opts, commandName: '', kind: 'component' }, undefined, {
      customId: opts.customId,
      componentType: ComponentType.StringSelect,
      values: opts.values,
      message: componentMessage(opts),
      isStringSelectMenu: () => true,
    }),
  );
}

/**
 * A submitted modal: `fields` by text input custom id (what fields.getTextInputValue() reads; an unknown
 * id throws like discord.js). `fromMessage` (default true): the modal was opened from a message
 * component, so the submit can update that message.
 */
export function createFakeModalSubmitInteraction(
  opts: FakeComponentOptions & { fields: Record<string, string>; fromMessage?: boolean },
): FakeInteractionHandle<ModalSubmitInteraction> {
  const fromMessage = opts.fromMessage ?? true;
  return handle(
    buildInteraction({ ...opts, commandName: '', kind: 'modal', fromMessage }, undefined, {
      customId: opts.customId,
      message: fromMessage ? componentMessage(opts) : null,
      isFromMessage: () => fromMessage,
      fields: {
        getTextInputValue: (customId: string) => {
          const value = opts.fields[customId];
          if (value === undefined) {
            throw Object.assign(new TypeError(`Required field with custom id "${customId}" not found.`), {
              code: 'ModalSubmitInteractionFieldNotFound',
            });
          }
          return value;
        },
      },
    }),
  );
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
    isOwner: Recorder<[Client, string], Promise<boolean>>;
    proposeEdit: Recorder<[EditRequest], Promise<EditProposal>>;
    report: Recorder<[Client, string], Promise<boolean>>;
  };
};

export const FAKE_NOW = new Date('2026-09-25T16:00:00Z');

/**
 * CommandDeps where every collaborator is recorded: the agent and media do nothing, the summary is a
 * canned text, the model answers nothing, the clock is FAKE_NOW (or `now`: a date, or a function for a
 * clock that moves), the memory store is `store` (pass an in-memory MemoryStore) and the notes store
 * `notes` (default: one over `store`), nobody is the bot's owner but the `owners` (a linked side account
 * of one counts), and an owner edit draft fails unless `proposeEdit` is scripted. Override any
 * collaborator's implementation; calls are still recorded.
 */
export function createFakeCommandDeps(
  opts: {
    store?: MemoryStore;
    notes?: NotesStore;
    owners?: string[];
    askAgent?: CommandDeps['askAgent'];
    summarize?: CommandDeps['summarize'];
    transcribeAudio?: CommandDeps['transcribeAudio'];
    getCachedTranscript?: CommandDeps['getCachedTranscript'];
    watchVideo?: CommandDeps['watchVideo'];
    complete?: CommandDeps['complete'];
    proposeEdit?: CommandDeps['proposeEdit'];
    report?: CommandDeps['report'];
    now?: Date | (() => Date);
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
    isOwner: createRecorder<[Client, string], Promise<boolean>>(async (_client, userId) =>
      (opts.owners ?? []).some((owner) => canonicalUserId(owner) === canonicalUserId(userId)),
    ),
    proposeEdit: createRecorder<[EditRequest], Promise<EditProposal>>(
      opts.proposeEdit ?? (async () => ({ ok: false, error: 'this test scripted no edit' })),
    ),
    report: createRecorder<[Client, string], Promise<boolean>>(opts.report ?? (async () => true)),
  };
  const memoryStore = () => {
    if (!opts.store) throw new Error('This test did not provide a memory store');
    return opts.store;
  };
  let notes = opts.notes;
  const now = opts.now ?? FAKE_NOW;
  const deps: CommandDeps = {
    ...recorders,
    memoryStore,
    notesStore: () => {
      notes ??= new NotesStore(memoryStore());
      return notes;
    },
    now: typeof now === 'function' ? now : () => now,
  };
  return { deps, recorders };
}
