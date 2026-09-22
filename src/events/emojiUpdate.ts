import { Events } from 'discord.js';
import { syncEmoji } from '../ai/emojiSync';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.GuildEmojiUpdate, {
  async execute(_oldEmoji, newEmoji) {
    try {
      await syncEmoji(newEmoji);
    } catch (error) {
      logger.warn('emojiUpdate: failed to sync updated emoji:', error);
    }
  },
});
