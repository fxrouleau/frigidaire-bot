// Keeps an archived message's reaction counts current (src/archive/reactions.ts).
import { Events } from 'discord.js';
import { archiveReactionChange } from '../archive/reactions';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageReactionAdd, {
  execute(reaction, user) {
    archiveReactionChange(reaction, user, 1);
  },
});
