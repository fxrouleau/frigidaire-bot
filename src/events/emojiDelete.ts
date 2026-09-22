import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.GuildEmojiDelete, {
  execute(emoji) {
    if (!emoji.id) return;
    try {
      getMemoryStore().deactivateEmoji(emoji.id);
      logger.info(`emojiDelete: deactivated ${emoji.name ?? '(unknown)'} (${emoji.id})`);
    } catch (error) {
      logger.warn('emojiDelete: failed to deactivate emoji:', error);
    }
  },
});
