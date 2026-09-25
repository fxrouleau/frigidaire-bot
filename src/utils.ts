import {
  type Channel,
  ChannelType,
  type Message,
  type NewsChannel,
  type TextChannel,
  type WebhookMessageCreateOptions,
} from 'discord.js';
import { logger } from './logger';
import { recordRelay } from './relay';

/** A guild channel that can own a webhook: regular text channels and announcement channels. */
export type WebhookCapableChannel = TextChannel | NewsChannel;

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

/** Channels that can own a webhook (threads and DMs cannot). */
export function isWebhookCapableChannel(channel: Channel): channel is WebhookCapableChannel {
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

/** The identity a message's author would have as a webhook: server nickname first, then display name. */
export function identityOf(message: Message): WebhookIdentity {
  return {
    name: message.member?.nickname || message.author.displayName,
    avatar: message.member?.displayAvatarURL({ forceStatic: true }),
  };
}

/**
 * Posts as `identity` through a one-time webhook. The webhook is created for this post and always
 * deleted afterwards — including when the send fails — so a failure can never leak one of the 15
 * webhooks a channel may hold.
 */
export async function sendViaWebhook(
  channel: WebhookCapableChannel,
  identity: WebhookIdentity,
  payload: string | WebhookMessageCreateOptions,
): Promise<Message> {
  const webhook = await channel.createWebhook({ name: identity.name, avatar: identity.avatar });
  logger.info(`Created webhook ${webhook.id} in #${channel.id}.`);
  try {
    return await webhook.send(payload);
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
 * Reposts a message via a webhook to impersonate the original author, then deletes the original.
 * The repost goes out first: if it fails, the user's message is left in place rather than lost.
 * @param message The original message object.
 * @param newContent The content to send in the new message.
 */
export async function repostMessage(message: Message, newContent: string): Promise<void> {
  const channel = message.channel;
  if (!isWebhookCapableChannel(channel)) {
    throw new Error(`Channel ${channel.id} (type ${channel.type}) cannot own a webhook.`);
  }
  const identity = identityOf(message);
  const repost = await sendViaWebhook(channel, identity, newContent);
  recordRelay({
    messageId: repost.id,
    channelId: channel.id,
    authorId: message.author.id,
    authorName: identity.name,
    kind: 'link_fix',
  });
  await message.delete();
}
