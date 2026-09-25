// Bulk deletions (moderation purges) are marked deleted in the archive like single ones.
import { Events } from 'discord.js';
import { archiveMessageDeletes } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageBulkDelete, {
  execute(messages) {
    if (!config.archive.enabled) return;
    archiveMessageDeletes([...messages.keys()]);
  },
});
