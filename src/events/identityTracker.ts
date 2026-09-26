import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

// Keeps each member's identity row on their CURRENT display name and Discord handle. Memories, the
// learner, summaries and the memory tools all name people by the display name, and resolve any name
// people use (display name, handle, IRL name, nicknames) back to the member's id through this row.
// A linked side account (LINKED_ACCOUNTS) gets its own row too, keyed on its own id: its names are
// names of the person, and src/ai/people.ts folds the row into the main account's member. Nothing else
// keys on the side id (memories, reminders and the archive use the main id).
export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (message.author.bot) return;
    if (message.webhookId) return;

    // Server nickname first, then the global display name; the bare username only as a last resort.
    const displayName = message.member?.displayName || message.author.displayName || message.author.username;
    if (!displayName) return;

    try {
      getMemoryStore().upsertIdentity(message.author.id, displayName, message.author.username);
    } catch (error) {
      logger.warn('identityTracker: failed to upsert identity:', error);
    }
  },
});
