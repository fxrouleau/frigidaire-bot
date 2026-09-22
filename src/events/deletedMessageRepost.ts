// Reposts a watched user's message when they delete it right after posting (see src/deletedMessages.ts).
import { Events } from 'discord.js';
import { deletedMessageReposter } from '../deletedMessages';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.MessageDelete, {
  async execute(message) {
    const outcome = await deletedMessageReposter.handleDelete(message);
    if (outcome !== 'ignored') {
      logger.info(`deletedMessages: ${message.id} → ${outcome}`);
    }
  },
});
