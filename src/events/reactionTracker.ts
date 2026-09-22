import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.MessageReactionAdd, {
  execute(reaction, user) {
    if (user.bot) return;

    const emojiId = reaction.emoji.id;
    if (!emojiId) return; // standard Unicode emoji — only track custom ones

    try {
      getMemoryStore().incrementEmojiUsage(emojiId);
    } catch (error) {
      logger.warn(`reactionTracker: increment failed for ${emojiId}:`, error);
    }
  },
});
