// A deleted channel takes its messages (and its threads' messages) with it, in the archive too.
import { Events } from 'discord.js';
import { archiveChannelDelete } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.ChannelDelete, {
  execute(channel) {
    if (!config.archive.enabled) return;
    archiveChannelDelete(channel.id);
  },
});
