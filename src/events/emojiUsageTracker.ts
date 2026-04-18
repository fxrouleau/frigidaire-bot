import { Events, type Message } from 'discord.js';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

const CUSTOM_EMOJI_REGEX = /<a?:(\w+):(\d+)>/g;

module.exports = {
  name: Events.MessageCreate,
  execute(message: Message) {
    if (message.author.bot) return;
    if (message.webhookId) return;
    if (!message.content) return;

    const store = getMemoryStore();
    const seenIds = new Map<string, number>();
    for (const match of message.content.matchAll(CUSTOM_EMOJI_REGEX)) {
      const emojiId = match[2];
      if (!emojiId) continue;
      seenIds.set(emojiId, (seenIds.get(emojiId) ?? 0) + 1);
    }

    for (const [emojiId, count] of seenIds) {
      try {
        store.incrementEmojiUsage(emojiId, count);
      } catch (error) {
        logger.warn(`emojiUsageTracker: increment failed for ${emojiId}:`, error);
      }
    }
  },
};
