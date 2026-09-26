// Every reaction was removed from a message (a moderator cleared them): the archive drops them too.
import { Events } from 'discord.js';
import { archiveReactionsCleared } from '../archive/reactions';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageReactionRemoveAll, {
  execute(message) {
    archiveReactionsCleared(message);
  },
});
