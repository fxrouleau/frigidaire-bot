// Keeps archived messages current: content edits (counted for Wrapped) and late link previews.
import { Events } from 'discord.js';
import { archiveMessageUpdate } from '../archive/ingest';
import { config } from '../config';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageUpdate, {
  async execute(_oldMessage, newMessage) {
    if (!config.archive.enabled) return;
    await archiveMessageUpdate(newMessage);
  },
});
