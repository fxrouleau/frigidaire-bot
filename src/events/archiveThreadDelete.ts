// A deleted thread's messages are gone from Discord, so the archive marks them deleted too.
import { Events } from 'discord.js';
import { archiveChannelDelete } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.ThreadDelete, {
  execute(thread) {
    if (!config.archive.enabled) return;
    archiveChannelDelete(thread.id);
  },
});
