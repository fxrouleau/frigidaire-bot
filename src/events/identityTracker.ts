import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

// Keeps each member's identity row on their CURRENT display name. Memories, the learner, summaries and
// the memory tools all name people by it (and resolve names back to ids through it).
export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (message.author.bot) return;
    if (message.webhookId) return;

    // Server nickname first, then the global display name; the bare username only as a last resort.
    const displayName = message.member?.displayName || message.author.displayName || message.author.username;
    if (!displayName) return;

    try {
      getMemoryStore().upsertIdentity(message.author.id, displayName);
    } catch (error) {
      logger.warn('identityTracker: failed to upsert identity:', error);
    }
  },
});
