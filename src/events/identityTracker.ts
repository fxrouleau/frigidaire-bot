import { Events, type Message } from 'discord.js';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

module.exports = {
  name: Events.MessageCreate,
  execute(message: Message) {
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
};
