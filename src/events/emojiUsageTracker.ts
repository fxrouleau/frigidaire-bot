import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { findCustomEmojis } from '../ai/promptSections';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (message.author.bot) return;
    if (message.webhookId) return;
    if (!message.content) return;

    const store = getMemoryStore();
    const seenIds = new Map<string, number>();
    for (const emoji of findCustomEmojis(message.content)) {
      seenIds.set(emoji.id, (seenIds.get(emoji.id) ?? 0) + 1);
    }

    for (const [emojiId, count] of seenIds) {
      try {
        store.incrementEmojiUsage(emojiId, count);
      } catch (error) {
        logger.warn(`emojiUsageTracker: increment failed for ${emojiId}:`, error);
      }
    }
  },
});
