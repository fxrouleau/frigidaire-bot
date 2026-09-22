import { Events } from 'discord.js';
import { syncEmoji } from '../ai/emojiSync';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.GuildEmojiCreate, {
  async execute(emoji) {
    try {
      await syncEmoji(emoji);
    } catch (error) {
      logger.warn('emojiCreate: failed to sync new emoji:', error);
    }
  },
});
