// Bulk deletions (moderation purges) are marked deleted in the archive like single ones, but are not
// counted as the authors' own deletions.
import { Events } from 'discord.js';
import { archiveBulkDeletes } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageBulkDelete, {
  execute(messages) {
    if (!config.archive.enabled) return;
    archiveBulkDeletes([...messages.keys()]);
  },
});
