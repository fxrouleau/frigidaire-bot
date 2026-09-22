// Snapshots new messages from the watched users so a quick deletion can be reposted (see
// src/deletedMessages.ts). No-op unless DELETE_REPOST_USER_IDS is set.
import { Events } from 'discord.js';
import { deletedMessageReposter } from '../deletedMessages';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    deletedMessageReposter.observe(message);
  },
});
