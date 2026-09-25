import {
  type Channel,
  ChannelType,
  type ForumChannel,
  type MediaChannel,
  type Message,
  MessageFlags,
  type NewsChannel,
  type TextChannel,
  type VoiceChannel,
  type Webhook,
  type WebhookMessageCreateOptions,
  type WebhookType,
} from 'discord.js';
import { config } from './config';
import { downloadAttachments, formatSize } from './links/attachments';
import { replyContextLine } from './links/replyContext';
import { logger } from './logger';
import { recordRelay } from './relay';

/** A guild channel that can own a webhook: regular text channels and announcement channels. */
export type WebhookCapableChannel = TextChannel | NewsChannel;

/** Every channel type a webhook can be created on. Threads and forum posts post through their parent's. */
export type WebhookParentChannel = TextChannel | NewsChannel | VoiceChannel | ForumChannel | MediaChannel;

/** Where a webhook post for a channel goes: the webhook's channel, plus the thread for threads and forum posts. */
export type WebhookTarget = { channel: WebhookParentChannel; threadId?: string };

// Discord's limit for a webhook message's content (Nitro members can send up to 4000 themselves).
const MAX_WEBHOOK_CONTENT = 2000;

/**
 * Splits a string into multiple chunks of a specified size.
 * @param text The text to split.
 * @param maxLength The maximum length of each chunk.
 * @returns An array of strings, where each string is no longer than maxLength.
 */
export function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  // Split by lines to avoid breaking in the middle of a word or sentence.
  const lines = text.split('\n');

  for (const line of lines) {
    // If the line itself exceeds maxLength, hard-split it into pieces
    if (line.length > maxLength) {
      // Flush current chunk first
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
      continue;
    }

    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }
      currentChunk = '';
    }
    currentChunk += (currentChunk.length > 0 ? '\n' : '') + line;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.filter((c) => c.length > 0);
}

/** Who a webhook post should appear to come from. */
export type WebhookIdentity = { name: string; avatar?: string };

/** Channels that can own a webhook themselves: text and announcement channels (threads and DMs cannot). */
export function isWebhookCapableChannel(channel: Channel): channel is WebhookCapableChannel {
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

/**
 * Where a webhook repost of a message in `channel` goes, or undefined when it can't have one. Text,
 * announcement and voice-channel chats own the webhook themselves; a thread or forum post is reached
 * through a webhook on its parent plus `threadId`. Archived threads are skipped (a webhook post would
 * silently unarchive them) and so are locked ones (closed on purpose).
 */
export function webhookTargetOf(channel: Channel): WebhookTarget | undefined {
  switch (channel.type) {
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
    case ChannelType.GuildVoice:
      return { channel };
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread: {
      if (channel.archived || channel.locked) return undefined;
      const parent = channel.parent;
      return parent ? { channel: parent, threadId: channel.id } : undefined;
    }
    default:
      return undefined;
  }
}

/** The identity a message's author would have as a webhook: server nickname first, then display name. */
export function identityOf(message: Message): WebhookIdentity {
  return {
    name: message.member?.nickname || message.author.displayName,
    avatar: message.member?.displayAvatarURL({ forceStatic: true }),
  };
}

/**
 * Runs `use` with a one-time webhook wearing `identity`. The webhook is always deleted afterwards —
 * including when `use` throws — so a failure can never leak one of the 15 webhooks a channel may hold.
 */
export async function withTemporaryWebhook<T>(
  channel: WebhookParentChannel,
  identity: WebhookIdentity,
  use: (webhook: Webhook<WebhookType.Incoming>) => Promise<T>,
): Promise<T> {
  const webhook = await channel.createWebhook({ name: identity.name, avatar: identity.avatar });
  logger.info(`Created webhook ${webhook.id} in #${channel.id}.`);
  try {
    return await use(webhook);
  } finally {
    try {
      await webhook.delete();
      logger.info(`Deleted webhook ${webhook.id}.`);
    } catch (error) {
      logger.warn(`Failed to delete webhook ${webhook.id}:`, error);
    }
  }
}

/**
 * Posts as `identity` through a one-time webhook (deleted afterwards, also on failure). To post into a
 * thread, pass its parent as `channel` and the thread's id as `payload.threadId`.
 */
export async function sendViaWebhook(
  channel: WebhookParentChannel,
  identity: WebhookIdentity,
  payload: string | WebhookMessageCreateOptions,
): Promise<Message> {
  return withTemporaryWebhook(channel, identity, (webhook) => webhook.send(payload));
}

/**
 * Why a message can't be reposted faithfully, or undefined when it can. Everything here is checked
 * before any network work: a message the bot can't carry over whole is left exactly as it is.
 */
export function repostBlocker(
  message: Message,
  maxAttachmentBytes = config.links.maxRepostAttachmentBytes,
): string | undefined {
  const target = webhookTargetOf(message.channel);
  if (!target) return "its channel can't host a webhook repost (DM, archived or locked thread)";
  if (target.threadId === message.id) return 'it opens a forum post (deleting it would delete the post)';
  if (message.stickers.size > 0) return "it has a sticker (webhooks can't send stickers)";
  if (message.poll) return 'it has a poll';
  if (message.content.length > MAX_WEBHOOK_CONTENT) {
    return `it is ${message.content.length} characters, over the ${MAX_WEBHOOK_CONTENT} a webhook can post`;
  }
  const attachmentBytes = [...message.attachments.values()].reduce((sum, a) => sum + a.size, 0);
  if (attachmentBytes > maxAttachmentBytes) {
    return `its attachments total ${formatSize(attachmentBytes)}, over the ${formatSize(maxAttachmentBytes)} repost cap`;
  }
  return undefined;
}

export type RepostOptions = {
  /** Downloads the attachments to carry over (injectable for tests). */
  fetch?: typeof globalThis.fetch;
  /** Total attachment bytes the repost may carry; defaults to LINK_REPOST_MAX_ATTACHMENT_BYTES. */
  maxAttachmentBytes?: number;
  /** Runs right before the original is deleted (the deleted-message reposter must not see a "regret"). */
  onBeforeDelete?: () => void;
};

export type RepostOutcome =
  /** Posted as the author; the original is gone. */
  | { status: 'reposted'; repostId: string }
  /** Nothing was posted; the original is untouched. */
  | { status: 'skipped'; reason: string }
  /** Posted, but the original couldn't be deleted (the author deleted it meanwhile, or permissions),
   * so the repost was taken back instead of leaving the message twice. */
  | { status: 'rolled-back'; reason: string };

/** The repost text: the reply-context line when it fits, else just the body; undefined when nothing fits. */
function composeRepostContent(context: string | undefined, body: string): string | undefined {
  if (context) {
    const withContext = `${context}\n${body}`;
    if (withContext.length <= MAX_WEBHOOK_CONTENT) return withContext;
  }
  return body.length <= MAX_WEBHOOK_CONTENT ? body : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reposts a message via a webhook wearing the author's name and avatar, then deletes the original.
 *
 * The repost is faithful or doesn't happen: attachments are downloaded and re-uploaded (all of them,
 * within the size cap), a reply gets a `-# ↪ replying to …` context line (webhooks can't reply),
 * `@silent` stays silent, and mentions never ping twice (`allowedMentions: { parse: [] }` — the
 * original already pinged). Messages that can't be carried over whole (stickers, polls, oversized
 * attachments, a failed download) are left untouched.
 *
 * Order matters: the repost goes out first, so a failed send never loses the user's message.
 */
export async function repostMessage(
  message: Message,
  newContent: string,
  options: RepostOptions = {},
): Promise<RepostOutcome> {
  const target = webhookTargetOf(message.channel);
  const blocker = repostBlocker(message, options.maxAttachmentBytes);
  if (!target || blocker) return { status: 'skipped', reason: blocker ?? "its channel can't host a webhook repost" };

  const carried = await downloadAttachments(
    [...message.attachments.values()].map((a) => ({ url: a.url, name: a.name, size: a.size, description: a.description })),
    {
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      maxTotalBytes: options.maxAttachmentBytes ?? config.links.maxRepostAttachmentBytes,
    },
  );
  if (!carried.ok) return { status: 'skipped', reason: carried.reason };

  const content = composeRepostContent(await replyContextLine(message), newContent);
  if (content === undefined) {
    return { status: 'skipped', reason: `the rewritten text is over the ${MAX_WEBHOOK_CONTENT} a webhook can post` };
  }

  const identity = identityOf(message);
  const payload: WebhookMessageCreateOptions = {
    content,
    files: carried.files,
    allowedMentions: { parse: [] },
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(message.flags.has(MessageFlags.SuppressNotifications) ? { flags: MessageFlags.SuppressNotifications } : {}),
  };

  return withTemporaryWebhook(target.channel, identity, async (webhook): Promise<RepostOutcome> => {
    const repost = await webhook.send(payload);
    recordRelay({
      messageId: repost.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      authorName: identity.name,
      kind: 'link_fix',
    });

    options.onBeforeDelete?.();
    try {
      await message.delete();
    } catch (error) {
      logger.warn(`Could not delete message ${message.id} after reposting it; taking the repost back:`, error);
      try {
        await webhook.deleteMessage(repost, target.threadId);
      } catch (cleanupError) {
        logger.warn(`Failed to delete repost ${repost.id}; the message now appears twice:`, cleanupError);
      }
      return { status: 'rolled-back', reason: `the original could not be deleted (${errorText(error)})` };
    }
    return { status: 'reposted', repostId: repost.id };
  });
}
