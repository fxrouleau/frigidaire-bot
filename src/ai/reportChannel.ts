// The report channel hosts the self-diagnosis digest and deploy announcements. It is fully OFF unless
// REPORT_CHANNEL_ID is set (Vitest never sets it ⇒ tests stay hermetic). Every failure here is caught
// and logged at WARN — posting to the report channel must never throw into a caller. Callers that
// record "this was posted" (the digest watermark, the announced deploy sha, fixer alert state) check
// the returned flag, so a failed post is retried instead of silently marked done.
import type { Client } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { splitMessage } from '../utils';

/** The configured report channel id, parsed like every other env var (trimmed, quotes stripped). */
export function getReportChannelId(): string | undefined {
  return config.report.channelId;
}

/**
 * Posts `text` (split into Discord-sized chunks) to the report channel. Resolves true only when the
 * channel resolved and every chunk went out; false when the channel is unset, missing or not
 * text-based, or a send failed. Never throws. Nothing in a report post pings anyone: the digest and
 * shadow reports carry member- and model-written text.
 */
export async function sendToReportChannel(client: Client, text: string): Promise<boolean> {
  const id = getReportChannelId();
  if (!id) return false;

  try {
    const channel = await client.channels.fetch(id);
    if (!channel?.isTextBased() || !('send' in channel)) {
      logger.warn(`Report channel ${id} is missing or not text-based; skipping send.`);
      return false;
    }
    for (const chunk of splitMessage(text)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
    return true;
  } catch (error) {
    logger.warn(`Failed to send to report channel ${id}:`, error);
    return false;
  }
}
