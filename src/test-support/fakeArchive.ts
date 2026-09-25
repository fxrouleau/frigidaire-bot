// Fakes for the message archive's tests: archive rows, discord.js-shaped guild messages (with the
// fields ingest reads that fakeDiscord's messages don't carry: guildId, type, flags, reactions, thread
// parents) and real-looking snowflakes (the archive orders ids numerically, as BigInt).
import { ChannelType, Collection, type Message, MessageType } from 'discord.js';
import type { ArchiveMessageInput } from '../archive/archiveStore';

export const GUILD_ID = '900000000000000001';
export const BOT_USER_ID = '900000000000000099';

const DISCORD_EPOCH = 1420070400000n;

/** A snowflake for a creation time; `seq` tells apart ids minted in the same millisecond. */
export function snowflake(ms: number, seq = 0): string {
  return (((BigInt(ms) - DISCORD_EPOCH) << 22n) | BigInt(seq)).toString();
}

/** An archive row with sensible defaults (a human message in channel '100000000000000001'). */
export function archiveInput(
  overrides: Partial<ArchiveMessageInput> & { createdAt?: number } = {},
): ArchiveMessageInput {
  const createdAt = overrides.createdAt ?? Date.UTC(2026, 0, 15, 17, 0);
  return {
    id: overrides.id ?? snowflake(createdAt),
    guildId: GUILD_ID,
    channelId: '100000000000000001',
    parentChannelId: null,
    authorId: '200000000000000001',
    authorName: 'Remi',
    source: 'human',
    relayKind: null,
    content: '',
    extraText: '',
    transcript: null,
    editedAt: null,
    replyToId: null,
    flags: 0,
    hasAudio: false,
    attachments: [],
    embeds: [],
    reactions: [],
    ...overrides,
    createdAt,
  };
}

export type FakeReactionOptions = { id?: string | null; name: string; animated?: boolean; count: number; me?: boolean };

export type ArchivableMessageOptions = {
  id?: string;
  content?: string;
  guildId?: string | null;
  channelId?: string;
  channelName?: string;
  channelType?: ChannelType;
  parentId?: string | null;
  authorId?: string;
  authorName?: string;
  authorBot?: boolean;
  webhookId?: string | null;
  applicationId?: string | null;
  botUserId?: string;
  type?: MessageType;
  createdAt?: number;
  editedAt?: number | null;
  flags?: number;
  replyToId?: string | null;
  attachments?: Array<{ name: string; contentType: string | null; size?: number; url?: string }>;
  embeds?: Array<{ title?: string; description?: string; url?: string }>;
  stickers?: string[];
  reactions?: FakeReactionOptions[];
  partial?: boolean;
  /** For partial messages: what message.fetch() resolves to (rejects when absent). */
  fetched?: () => Message;
};

/** A discord.js-shaped guild message, typed as Message through one localized cast. */
export function archivableMessage(opts: ArchivableMessageOptions = {}): Message {
  const createdAt = opts.createdAt ?? Date.UTC(2026, 0, 15, 17, 0);
  const id = opts.id ?? snowflake(createdAt);
  const botUserId = opts.botUserId ?? BOT_USER_ID;
  const channelType = opts.channelType ?? ChannelType.GuildText;
  const guildId = opts.guildId === undefined ? GUILD_ID : opts.guildId;

  const attachments = new Collection<string, unknown>();
  (opts.attachments ?? []).forEach((a, i) => {
    attachments.set(`${id}-att-${i}`, {
      name: a.name,
      contentType: a.contentType,
      size: a.size ?? 1234,
      url: a.url ?? `https://cdn.discordapp.com/attachments/1/2/${a.name}`,
    });
  });
  const stickers = new Collection<string, unknown>();
  (opts.stickers ?? []).forEach((name, i) => {
    stickers.set(`st-${i}`, { name });
  });
  const reactions = new Collection<string, unknown>();
  for (const r of opts.reactions ?? []) {
    reactions.set(r.id ?? r.name, {
      emoji: { id: r.id ?? null, name: r.name, animated: r.animated ?? false },
      count: r.count,
      me: r.me ?? false,
    });
  }

  const built = {
    id,
    partial: opts.partial ?? false,
    guildId,
    channelId: opts.channelId ?? '100000000000000001',
    type: opts.type ?? (opts.replyToId ? MessageType.Reply : MessageType.Default),
    content: opts.content ?? '',
    createdTimestamp: createdAt,
    editedTimestamp: opts.editedAt ?? null,
    webhookId: opts.webhookId ?? null,
    applicationId: opts.applicationId ?? null,
    flags: { bitfield: opts.flags ?? 0 },
    reference: opts.replyToId ? { messageId: opts.replyToId } : null,
    author: {
      id: opts.authorId ?? '200000000000000001',
      username: (opts.authorName ?? 'Remi').toLowerCase(),
      displayName: opts.authorName ?? 'Remi',
      bot: opts.authorBot ?? Boolean(opts.webhookId),
    },
    member: opts.webhookId ? null : { displayName: opts.authorName ?? 'Remi' },
    attachments,
    embeds: (opts.embeds ?? []).map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
    })),
    stickers,
    messageSnapshots: new Collection(),
    poll: null,
    reactions: { cache: reactions },
    client: { user: { id: botUserId }, application: { id: botUserId } },
    channel: {
      id: opts.channelId ?? '100000000000000001',
      type: channelType,
      name: opts.channelName ?? 'bagel-bar',
      parentId: opts.parentId ?? null,
      guildId,
    },
    fetch: async () => {
      if (!opts.fetched) throw new Error('Unknown Message');
      return opts.fetched();
    },
  };
  return built as unknown as Message;
}
