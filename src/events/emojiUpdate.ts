import { Events, type GuildEmoji } from 'discord.js';
import { syncEmoji } from '../ai/emojiSync';
import { logger } from '../logger';

module.exports = {
  name: Events.GuildEmojiUpdate,
  async execute(_oldEmoji: GuildEmoji, newEmoji: GuildEmoji) {
    try {
      await syncEmoji(newEmoji);
    } catch (error) {
      logger.warn('emojiUpdate: failed to sync updated emoji:', error);
    }
  },
};
