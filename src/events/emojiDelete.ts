import { Events, type GuildEmoji } from 'discord.js';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

module.exports = {
  name: Events.GuildEmojiDelete,
  execute(emoji: GuildEmoji) {
    if (!emoji.id) return;
    try {
      getMemoryStore().deactivateEmoji(emoji.id);
      logger.info(`emojiDelete: deactivated ${emoji.name ?? '(unknown)'} (${emoji.id})`);
    } catch (error) {
      logger.warn('emojiDelete: failed to deactivate emoji:', error);
    }
  },
};
