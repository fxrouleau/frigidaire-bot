// The report channel hosts the self-diagnosis digest and deploy announcements. It is fully OFF unless
// REPORT_CHANNEL_ID is set (Vitest never sets it ⇒ tests stay hermetic). Every failure here is caught
// and logged at WARN — posting to the report channel must never throw into a caller.
import type { Client } from 'discord.js';
import { logger } from '../logger';
import { splitMessage } from '../utils';

export function getReportChannelId(): string | undefined {
  const id = process.env.REPORT_CHANNEL_ID?.trim();
  return id ? id : undefined;
}

export async function sendToReportChannel(client: Client, text: string): Promise<void> {
  const id = getReportChannelId();
  if (!id) return;

  try {
    const channel = await client.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      logger.warn(`Report channel ${id} is missing or not text-based; skipping send.`);
      return;
    }
    for (const chunk of splitMessage(text)) {
      await channel.send(chunk);
    }
  } catch (error) {
    logger.warn(`Failed to send to report channel ${id}:`, error);
  }
}
