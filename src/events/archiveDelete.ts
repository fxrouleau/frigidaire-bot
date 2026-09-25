// A deleted message is marked deleted in the archive and its text scrubbed (src/archive/).
import { Events } from 'discord.js';
import { archiveMessageDeletes } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageDelete, {
  execute(message) {
    if (!config.archive.enabled) return;
    archiveMessageDeletes([message.id]);
  },
});
