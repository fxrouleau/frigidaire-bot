// Typed factories that build discord.js Message objects for tests. Real Collection instances are
// used so .size/.values()/.has() behave like production; a single localized cast bridges the plain
// object to the Message type at the very end.
import {
  type Channel,
  ChannelType,
  type Client,
  Collection,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js';
import { type Recorder, createRecorder } from './recorder';

// The exact type discord.js hands to a MessageCreate listener (a Message whose channel is never a
// partial group DM), so fakes can be passed straight to event handlers as well as to the agent.
export type EventMessage = OmitPartialGroupDMChannel<Message>;

export type FakeWebhook = {
  send: Recorder<[unknown], Promise<unknown>>;
  delete: Recorder<[], Promise<unknown>>;
};

export type FakeMessageOptions = {
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  authorIsBot?: boolean;
  botUserId?: string;
  botDisplayName?: string;
  channelId?: string;
  channelType?: ChannelType;
  messageId?: string;
  webhookId?: string | null;
  // Discord stamps the owning application's id on messages from application-owned webhooks (the bot's
  // own relays) and on interaction responses.
  applicationId?: string | null;
  createdAt?: Date;
  attachments?: Array<{ url: string; contentType: string | null; name?: string }>;
  embeds?: Array<{
    imageUrl?: string;
    imageProxyUrl?: string;
    thumbnailUrl?: string;
    authorName?: string;
    title?: string;
    description?: string;
    url?: string;
  }>;
  stickers?: Array<{ id: string; name: string; format: number }>;
  mentionedUserIds?: string[];
  // Mentioned users with resolved display data, mirroring discord.js `message.mentions.users` /
  // `.members`. `member: false` puts the user in `.users` only (not a guild member). When omitted,
  // `mentionedUserIds` still populates `.users` with bare entries (no display name) for has() checks.
  mentionedUsers?: Array<{ id: string; displayName?: string; username?: string; member?: boolean }>;
  // The author of the message this one replies to, when Discord resolved it (reply pings on).
  repliedUserId?: string | null;
  referencedMessageId?: string | null;
  // MessageReferenceType of the reference (0 = reply, 1 = forward); omitted ⇒ no `type` field.
  referencedMessageType?: number;
  memberIsNull?: boolean;
  historyMessages?: Message[];
  fetchedMessageById?: Record<string, Message>;
  // A channel log with Discord's fetch semantics: fetch({ limit, before, after, around }) filters and
  // limits it by snowflake like the API (ids must be numeric), and fetch(id) finds messages in it. When
  // set, it replaces `historyMessages` for list fetches; `fetchedMessageById` still answers id fetches.
  channelMessages?: Message[];
  guildId?: string;
  channelName?: string;
  channelTopic?: string | null;
  // Thread channels: isThread() is true and the parent is reported.
  parentChannelId?: string;
  parentChannelName?: string;
  system?: boolean;
  reactImpl?: (emoji: unknown) => Promise<unknown>;
  replyImpl?: (content: unknown) => Promise<unknown>;
  sendImpl?: (content: unknown) => Promise<unknown>;
  // Make the fake webhook's send() reject (exercises repost error paths).
  webhookSendImpl?: (content: unknown) => Promise<unknown>;
};

export type FakeMessage = {
  message: EventMessage;
  recorders: {
    reply: Recorder<[unknown], Promise<unknown>>;
    send: Recorder<[unknown], Promise<unknown>>;
    sendTyping: Recorder<[], Promise<void>>;
    messagesFetch: Recorder<[unknown], Promise<unknown>>;
    delete: Recorder<[], Promise<unknown>>;
    createWebhook: Recorder<[unknown], Promise<unknown>>;
    react: Recorder<[unknown], Promise<unknown>>;
  };
  webhooks: FakeWebhook[];
};

type FetchListOptions = { limit?: number; before?: string; after?: string; around?: string };

const byIdDesc = (a: Message, b: Message) => {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? 1 : x > y ? -1 : 0;
};

/** Discord's list-fetch semantics over a channel log: newest first, filtered by snowflake, limited. */
function fetchFromLog(log: Message[], options: FetchListOptions): Message[] {
  const limit = options.limit ?? 50;
  const sorted = [...log].sort(byIdDesc);
  if (options.around !== undefined) {
    const pivot = BigInt(options.around);
    const older = sorted.filter((m) => BigInt(m.id) <= pivot);
    const newer = sorted.filter((m) => BigInt(m.id) > pivot).reverse();
    // Roughly half on each side of the pivot (the pivot itself counts on the older side).
    const takeNewer = newer.slice(0, Math.floor(limit / 2));
    const takeOlder = older.slice(0, limit - takeNewer.length);
    return [...takeNewer.reverse(), ...takeOlder];
  }
  if (options.after !== undefined) {
    const after = BigInt(options.after);
    // The messages directly after the id (the oldest ones), returned newest first.
    return sorted
      .filter((m) => BigInt(m.id) > after)
      .reverse()
      .slice(0, limit)
      .reverse();
  }
  const before = options.before !== undefined ? BigInt(options.before) : undefined;
  return sorted.filter((m) => before === undefined || BigInt(m.id) < before).slice(0, limit);
}

let fakeWebhookMessageCounter = 0;

function createFakeWebhook(sendImpl?: (content: unknown) => Promise<unknown>): FakeWebhook {
  return {
    // Like discord.js, send() resolves to the posted message (only its id matters to callers).
    send: createRecorder(async (content: unknown) =>
      sendImpl ? sendImpl(content) : ({ id: `webhook-message-${++fakeWebhookMessageCounter}` } as unknown),
    ),
    delete: createRecorder(async () => ({}) as unknown),
  };
}

export function createFakeMessage(opts: FakeMessageOptions = {}): FakeMessage {
  const content = opts.content ?? '';
  const authorId = opts.authorId ?? 'user-1';
  const authorUsername = opts.authorUsername ?? 'testuser';
  const authorDisplayName = opts.authorDisplayName ?? 'Test User';
  // Discord marks every webhook message's author as a bot, so a webhook fake defaults to bot-authored.
  const authorIsBot = opts.authorIsBot ?? (opts.webhookId !== undefined && opts.webhookId !== null);
  const botUserId = opts.botUserId ?? 'bot-1';
  const botDisplayName = opts.botDisplayName ?? 'Frigidaire';
  const channelId = opts.channelId ?? 'channel-1';
  const channelType = opts.channelType ?? ChannelType.GuildText;
  const messageId = opts.messageId ?? 'msg-1';
  const webhookId = opts.webhookId ?? null;
  const createdAt = opts.createdAt ?? new Date('2026-01-01T00:00:00Z');
  const mentionedUserIds = opts.mentionedUserIds ?? [];
  const referencedMessageId = opts.referencedMessageId ?? null;
  const historyMessages = opts.historyMessages ?? [];
  const fetchedMessageById = opts.fetchedMessageById ?? {};

  const attachments = new Collection<string, { contentType: string | null; url: string; name: string }>();
  (opts.attachments ?? []).forEach((att, index) => {
    attachments.set(`att-${index}`, { contentType: att.contentType, url: att.url, name: att.name ?? `file-${index}` });
  });

  const stickers = new Collection<string, { id: string; name: string; format: number }>();
  for (const sticker of opts.stickers ?? []) {
    stickers.set(sticker.id, sticker);
  }

  const mentionUsers = new Collection<string, unknown>();
  const mentionMembers = new Collection<string, unknown>();
  for (const id of mentionedUserIds) {
    mentionUsers.set(id, { id });
  }
  for (const m of opts.mentionedUsers ?? []) {
    mentionUsers.set(m.id, { id: m.id, displayName: m.displayName, username: m.username });
    if (m.member !== false) {
      mentionMembers.set(m.id, { id: m.id, displayName: m.displayName });
    }
  }

  const embeds = (opts.embeds ?? []).map((embed) => ({
    image: embed.imageUrl ? { url: embed.imageUrl, proxyURL: embed.imageProxyUrl } : null,
    thumbnail: embed.thumbnailUrl ? { url: embed.thumbnailUrl } : null,
    author: embed.authorName ? { name: embed.authorName } : null,
    title: embed.title ?? null,
    description: embed.description ?? null,
    url: embed.url ?? null,
  }));

  const webhooks: FakeWebhook[] = [];

  const replyImpl = opts.replyImpl ?? (async (_content: unknown) => ({}) as unknown);
  const sendImpl = opts.sendImpl ?? (async (_content: unknown) => ({}) as unknown);

  const reply = createRecorder<[unknown], Promise<unknown>>((c) => replyImpl(c));
  const send = createRecorder<[unknown], Promise<unknown>>((c) => sendImpl(c));
  const sendTyping = createRecorder<[], Promise<void>>(async () => {});
  const deleteRecorder = createRecorder<[], Promise<unknown>>(async () => ({}) as unknown);
  const reactImpl = opts.reactImpl ?? (async (_emoji: unknown) => ({}) as unknown);
  const react = createRecorder<[unknown], Promise<unknown>>((emoji) => reactImpl(emoji));
  const createWebhook = createRecorder<[unknown], Promise<unknown>>(async (_options) => {
    const hook = createFakeWebhook(opts.webhookSendImpl);
    webhooks.push(hook);
    return hook as unknown;
  });
  const messagesFetch = createRecorder<[unknown], Promise<unknown>>(async (arg) => {
    if (typeof arg === 'string') {
      const found = fetchedMessageById[arg] ?? opts.channelMessages?.find((m) => m.id === arg);
      if (!found) {
        throw new Error(`No fetched message registered for id "${arg}"`);
      }
      return found as unknown;
    }
    const collection = new Collection<string, Message>();
    const listed = opts.channelMessages
      ? fetchFromLog(opts.channelMessages, (arg ?? {}) as FetchListOptions)
      : historyMessages;
    for (const msg of listed) {
      collection.set(msg.id, msg);
    }
    return collection as unknown;
  });

  const member = opts.memberIsNull
    ? null
    : {
        displayName: authorDisplayName,
        nickname: null as string | null,
        displayAvatarURL: (_opts?: unknown) => 'https://cdn.example/avatar.png',
      };

  const guildId = opts.guildId ?? 'guild-1';
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const isDmChannel = channelType === ChannelType.DM || channelType === ChannelType.GroupDM;

  const built = {
    id: messageId,
    url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
    guildId,
    system: opts.system ?? false,
    content,
    createdAt,
    createdTimestamp: createdAt.getTime(),
    partial: false,
    webhookId,
    applicationId: opts.applicationId ?? null,
    author: {
      id: authorId,
      username: authorUsername,
      displayName: authorDisplayName,
      bot: authorIsBot,
    },
    member,
    attachments,
    embeds,
    stickers,
    mentions: {
      users: mentionUsers,
      members: mentionMembers,
      repliedUser: opts.repliedUserId ? { id: opts.repliedUserId } : null,
    },
    reference: referencedMessageId
      ? {
          messageId: referencedMessageId,
          channelId,
          guildId,
          ...(opts.referencedMessageType !== undefined ? { type: opts.referencedMessageType } : {}),
        }
      : null,
    client: {
      user: { id: botUserId, displayName: botDisplayName },
    },
    channel: {
      id: channelId,
      type: channelType,
      name: opts.channelName ?? 'general',
      topic: opts.channelTopic ?? null,
      parentId: opts.parentChannelId ?? null,
      parent: opts.parentChannelId ? { id: opts.parentChannelId, name: opts.parentChannelName ?? 'parent' } : null,
      isTextBased: () => true,
      isThread: () => isThreadChannel,
      isDMBased: () => isDmChannel,
      send,
      sendTyping,
      createWebhook,
      messages: { fetch: messagesFetch },
    },
    reply,
    react,
    delete: deleteRecorder,
  };

  return {
    message: built as unknown as EventMessage,
    recorders: { reply, send, sendTyping, messagesFetch, delete: deleteRecorder, createWebhook, react },
    webhooks,
  };
}

export type FakeChannel = {
  channel: Channel;
  recorders: { send: Recorder<[unknown], Promise<unknown>> };
};

/** A minimal sendable GuildText channel: isTextBased() true + a recording send(). */
export function createFakeChannel(opts: { id?: string } = {}): FakeChannel {
  const id = opts.id ?? 'report-channel-1';
  const send = createRecorder<[unknown], Promise<unknown>>(async (_content: unknown) => ({}) as unknown);
  const built = {
    id,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send,
  };
  return { channel: built as unknown as Channel, recorders: { send } };
}

export type FakeClient = {
  // A ready client (Client<true>) — what every ClientReady handler receives.
  client: Client<true>;
  recorders: { channelsFetch: Recorder<[string], Promise<Channel>> };
};

/** A ready Client whose channels.fetch(id) resolves channels from a map and throws for unknown ids. */
export function createFakeClient(opts: { channelsById?: Record<string, Channel> } = {}): FakeClient {
  const channelsById = opts.channelsById ?? {};
  const channelsFetch = createRecorder<[string], Promise<Channel>>(async (channelId: string) => {
    const found = channelsById[channelId];
    if (found === undefined) {
      throw new Error(`Unknown channel id "${channelId}"`);
    }
    return found;
  });
  const built = {
    channels: { fetch: channelsFetch },
    user: { id: 'bot-1', tag: 'Frigidaire#0001', displayName: 'Frigidaire' },
    guilds: { cache: new Collection() },
  };
  return { client: built as unknown as Client<true>, recorders: { channelsFetch } };
}

export function createFakeBotMessage(opts: FakeMessageOptions = {}): FakeMessage {
  const botUserId = opts.botUserId ?? 'bot-1';
  const botDisplayName = opts.botDisplayName ?? 'Frigidaire';
  return createFakeMessage({
    ...opts,
    authorId: opts.authorId ?? botUserId,
    authorIsBot: true,
    authorDisplayName: opts.authorDisplayName ?? botDisplayName,
    botUserId,
    botDisplayName,
  });
}
