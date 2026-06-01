// Typed factories that build discord.js Message objects for tests. Real Collection instances are
// used so .size/.values()/.has() behave like production; a single localized cast bridges the plain
// object to the Message type at the very end.
import { ChannelType, Collection, type Message } from 'discord.js';
import { type Recorder, createRecorder } from './recorder';

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
  messageId?: string;
  webhookId?: string | null;
  createdAt?: Date;
  attachments?: Array<{ url: string; contentType: string | null }>;
  embeds?: Array<{
    imageUrl?: string;
    thumbnailUrl?: string;
    authorName?: string;
    title?: string;
    description?: string;
    url?: string;
  }>;
  stickers?: Array<{ id: string; name: string; format: number }>;
  mentionedUserIds?: string[];
  referencedMessageId?: string | null;
  memberIsNull?: boolean;
  historyMessages?: Message[];
  fetchedMessageById?: Record<string, Message>;
  replyImpl?: (content: unknown) => Promise<unknown>;
  sendImpl?: (content: unknown) => Promise<unknown>;
};

export type FakeMessage = {
  message: Message;
  recorders: {
    reply: Recorder<[unknown], Promise<unknown>>;
    send: Recorder<[unknown], Promise<unknown>>;
    sendTyping: Recorder<[], Promise<void>>;
    messagesFetch: Recorder<[unknown], Promise<unknown>>;
    delete: Recorder<[], Promise<unknown>>;
    createWebhook: Recorder<[unknown], Promise<unknown>>;
  };
  webhooks: FakeWebhook[];
};

function createFakeWebhook(): FakeWebhook {
  return {
    send: createRecorder(async (_content: unknown) => ({}) as unknown),
    delete: createRecorder(async () => ({}) as unknown),
  };
}

export function createFakeMessage(opts: FakeMessageOptions = {}): FakeMessage {
  const content = opts.content ?? '';
  const authorId = opts.authorId ?? 'user-1';
  const authorUsername = opts.authorUsername ?? 'testuser';
  const authorDisplayName = opts.authorDisplayName ?? 'Test User';
  const authorIsBot = opts.authorIsBot ?? false;
  const botUserId = opts.botUserId ?? 'bot-1';
  const botDisplayName = opts.botDisplayName ?? 'Frigidaire';
  const channelId = opts.channelId ?? 'channel-1';
  const messageId = opts.messageId ?? 'msg-1';
  const webhookId = opts.webhookId ?? null;
  const createdAt = opts.createdAt ?? new Date('2026-01-01T00:00:00Z');
  const mentionedUserIds = opts.mentionedUserIds ?? [];
  const referencedMessageId = opts.referencedMessageId ?? null;
  const historyMessages = opts.historyMessages ?? [];
  const fetchedMessageById = opts.fetchedMessageById ?? {};

  const attachments = new Collection<string, { contentType: string | null; url: string; size?: number }>();
  (opts.attachments ?? []).forEach((att, index) => {
    attachments.set(`att-${index}`, { contentType: att.contentType, url: att.url });
  });

  const stickers = new Collection<string, { id: string; name: string; format: number }>();
  for (const sticker of opts.stickers ?? []) {
    stickers.set(sticker.id, sticker);
  }

  const mentionUsers = new Collection<string, unknown>();
  for (const id of mentionedUserIds) {
    mentionUsers.set(id, {});
  }

  const embeds = (opts.embeds ?? []).map((embed) => ({
    image: embed.imageUrl ? { url: embed.imageUrl } : null,
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
  const createWebhook = createRecorder<[unknown], Promise<unknown>>(async (_options) => {
    const hook = createFakeWebhook();
    webhooks.push(hook);
    return hook as unknown;
  });
  const messagesFetch = createRecorder<[unknown], Promise<unknown>>(async (arg) => {
    if (typeof arg === 'string') {
      const found = fetchedMessageById[arg];
      if (!found) {
        throw new Error(`No fetched message registered for id "${arg}"`);
      }
      return found as unknown;
    }
    const collection = new Collection<string, Message>();
    for (const msg of historyMessages) {
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

  const built = {
    id: messageId,
    content,
    createdAt,
    webhookId,
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
    mentions: { users: mentionUsers },
    reference: referencedMessageId ? { messageId: referencedMessageId } : null,
    client: {
      user: { id: botUserId, displayName: botDisplayName },
    },
    channel: {
      id: channelId,
      type: ChannelType.GuildText,
      isTextBased: () => true,
      send,
      sendTyping,
      createWebhook,
      messages: { fetch: messagesFetch },
    },
    reply,
    delete: deleteRecorder,
  };

  return {
    message: built as unknown as Message,
    recorders: { reply, send, sendTyping, messagesFetch, delete: deleteRecorder, createWebhook },
    webhooks,
  };
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
