import type { Collection, Message } from 'discord.js';

export type SummaryPrep = {
  prompt: string;
  error?: string;
};

export async function prepareSummaryPrompt(message: Message, startTime: string, endTime: string): Promise<SummaryPrep> {
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { prompt: '', error: 'Invalid date format. Please use ISO 8601 format (e.g., "2025-10-03T18:00:00Z").' };
  }
  if (endDate.getTime() - startDate.getTime() > 7 * 24 * 60 * 60 * 1000) {
    return { prompt: '', error: 'The maximum timeframe for a summary is one week.' };
  }
  if (startDate > endDate) {
    return { prompt: '', error: 'The start time must be before the end time.' };
  }

  const messagesForSummary: Message[] = [];
  let lastIdBeforeChunk: string | undefined = undefined;

  for (let i = 0; i < 50; i++) {
    const chunk: Collection<string, Message> = await message.channel.messages.fetch({
      limit: 100,
      before: lastIdBeforeChunk,
    });
    if (chunk.size === 0) break;

    lastIdBeforeChunk = chunk.lastKey();
    const oldestMessageInChunk = chunk.last();

    for (const msg of chunk.values()) {
      if (msg.createdAt >= startDate && msg.createdAt <= endDate) {
        if (!msg.author.bot) {
          messagesForSummary.push(msg);
        }
      }
    }

    if (oldestMessageInChunk && oldestMessageInChunk.createdAt < startDate) {
      break;
    }
  }

  if (messagesForSummary.length === 0) {
    return { prompt: '', error: 'I found no messages in that time range to summarize.' };
  }

  const formattedMessages = messagesForSummary
    .reverse()
    .map((msg) => `${msg.member?.displayName || msg.author.username}: ${msg.content}`)
    .join('\n');

  const prompt = `Provide a concise summary of the key topics and events from this Discord chat:\n\n${formattedMessages}`;
  return { prompt };
}
