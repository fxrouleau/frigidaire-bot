// One emoji's reactions were removed from a message (a moderator cleared them): the archive drops them too.
import { Events } from 'discord.js';
import { archiveReactionEmojiCleared } from '../archive/reactions';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageReactionRemoveEmoji, {
  execute(reaction) {
    archiveReactionEmojiCleared(reaction);
  },
});
