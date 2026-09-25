// Archives every new member message (and the bot's own) into the local message archive (src/archive/).
import { Events } from 'discord.js';
import { archiveNewMessage } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (!config.archive.enabled) return;
    archiveNewMessage(message);
  },
});
