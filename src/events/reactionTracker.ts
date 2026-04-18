import { Events, type MessageReaction, type PartialMessageReaction, type PartialUser, type User } from 'discord.js';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

module.exports = {
  name: Events.MessageReactionAdd,
  execute(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return;

    const emojiId = reaction.emoji.id;
    if (!emojiId) return; // standard Unicode emoji — only track custom ones

    try {
      getMemoryStore().incrementEmojiUsage(emojiId);
    } catch (error) {
      logger.warn(`reactionTracker: increment failed for ${emojiId}:`, error);
    }
  },
};
