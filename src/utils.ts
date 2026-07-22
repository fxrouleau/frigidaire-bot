import type { BaseGuildTextChannel, Message } from 'discord.js';
import { logger } from './logger';

const FENCE_CLOSE = '\n```';
// Room reserved per chunk for closing an open ``` fence and reopening it in the next chunk.
// Skipped entirely for tiny custom maxLengths where the reserve would eat the whole budget.
const FENCE_RESERVE = 32;

/** Line-based splitter; hard-splits oversized lines without bisecting surrogate pairs. */
function coreSplit(text: string, maxLength: number): string[] {
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
      for (let i = 0; i < line.length; ) {
        let end = Math.min(i + maxLength, line.length);
        // Never end a chunk on a high surrogate — both halves would render as U+FFFD.
        if (end < line.length) {
          const code = line.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff && end - 1 > i) end--;
        }
        chunks.push(line.slice(i, end));
        i = end;
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

/** Returns the fence opener (e.g. '```ts') if the text ends inside an unclosed ``` block, else null. */
function scanOpenFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (open === null) {
        const marker = line.trim();
        // Reopen with the language tag when short; fall back to a bare fence otherwise.
        open = marker.length <= FENCE_RESERVE - FENCE_CLOSE.length ? marker : '```';
      } else {
        open = null;
      }
    }
  }
  return open;
}

/**
 * Splits a string into multiple chunks of a specified size.
 * Code blocks that straddle a chunk boundary are closed at the end of the chunk and reopened
 * (with their language tag) at the start of the next, so both halves render as code.
 * @param text The text to split.
 * @param maxLength The maximum length of each chunk.
 * @returns An array of strings, where each string is no longer than maxLength.
 */
export function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const fixFences = text.includes('```') && maxLength > FENCE_RESERVE * 2;
  const chunks = coreSplit(text, fixFences ? maxLength - FENCE_RESERVE : maxLength);
  if (!fixFences) {
    return chunks;
  }

  const out: string[] = [];
  let open: string | null = null;
  for (const chunk of chunks) {
    let fixed = open !== null ? `${open}\n${chunk}` : chunk;
    open = scanOpenFence(fixed);
    if (open !== null) fixed += FENCE_CLOSE;
    out.push(fixed);
  }
  return out;
}

/**
 * Reposts a message via a webhook to impersonate the original author, then deletes the original.
 * Attachments are re-sent by URL alongside the rewritten content.
 * Ordering matters: the webhook copy is sent BEFORE the original is deleted, so a failed send
 * never destroys the user's message. The one-time webhook is always cleaned up (channels cap at
 * 15 webhooks, so a leak here would eventually break reposting in the channel for good).
 * @param message The original message object.
 * @param newContent The content to send in the new message.
 */
export async function repostMessage(message: Message, newContent: string): Promise<void> {
  const webhook = await (message.channel as BaseGuildTextChannel).createWebhook({
    name: message.member?.nickname || message.author.displayName,
    avatar: message.member?.displayAvatarURL({ forceStatic: true }),
  });
  logger.info(`Created webhook ${webhook.id} for message ${message.id}.`);

  try {
    const files = [...message.attachments.values()].map((attachment) => attachment.url);
    const chunks = splitMessage(newContent);
    for (let i = 0; i < chunks.length; i++) {
      // Attachments ride on the last chunk so they appear below the text.
      const isLast = i === chunks.length - 1;
      await webhook.send({ content: chunks[i], files: isLast ? files : [] });
    }
    await message.delete();
  } finally {
    try {
      await webhook.delete();
      logger.info(`Deleted webhook ${webhook.id}.`);
    } catch (error) {
      logger.warn(`Failed to delete webhook ${webhook.id}:`, error);
    }
  }
}
