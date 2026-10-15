// Reposts a watched user's edgy message when they edit it into something harmless right after posting
// (see src/deletedMessages.ts). No-op unless DELETE_REPOST_USER_IDS is set.
import { Events } from 'discord.js';
import { deletedMessageReposter } from '../deletedMessages';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.MessageUpdate, {
  async execute(_oldMessage, newMessage) {
    const outcome = await deletedMessageReposter.handleEdit(newMessage);
    if (outcome !== 'ignored' && outcome !== 'unchanged') {
      logger.info(`deletedMessages: ${newMessage.id} edited → ${outcome}`);
    }
  },
});
