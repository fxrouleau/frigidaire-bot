import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (message.author.bot) return;
    if (message.webhookId) return;

    const displayName = message.member?.displayName || message.author.username;
    if (!displayName) return;

    try {
      getMemoryStore().upsertIdentity(message.author.id, displayName);
    } catch (error) {
      logger.warn('identityTracker: failed to upsert identity:', error);
    }
  },
});
