import { Events, type GuildEmoji } from 'discord.js';
import { syncEmoji } from '../ai/emojiSync';
import { logger } from '../logger';

module.exports = {
  name: Events.GuildEmojiCreate,
  async execute(emoji: GuildEmoji) {
    try {
      await syncEmoji(emoji);
    } catch (error) {
      logger.warn('emojiCreate: failed to sync new emoji:', error);
    }
  },
};
