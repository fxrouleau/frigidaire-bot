import type { BaseGuildTextChannel, Message } from 'discord.js';
import { logger } from './logger';

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

/**
 * Reposts a message via a webhook to impersonate the original author.
 * Deletes the original message.
 * @param message The original message object.
 * @param newContent The content to send in the new message.
 */
export async function repostMessage(message: Message, newContent: string): Promise<void> {
  const webhook = await (message.channel as BaseGuildTextChannel).createWebhook({
    name: message.member?.nickname || message.author.displayName,
    avatar: message.member?.displayAvatarURL({ forceStatic: true }),
  });
  logger.info(`Created webhook ${webhook.id} for message ${message.id}.`);

  await Promise.all([message.delete(), webhook.send(newContent)]);

  // Cleanup the webhook, we don't need it anymore; they're one-time use
  await webhook.delete();
  logger.info(`Deleted webhook ${webhook.id}.`);
}
