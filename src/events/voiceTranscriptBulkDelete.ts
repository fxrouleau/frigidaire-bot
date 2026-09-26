// Bulk deletions (moderation purges) take the bot's transcripts of voice messages along, like single ones.
import { Events } from 'discord.js';
import { removeTranscriptsOf } from '../ai/media/autoTranscribe';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageBulkDelete, {
  async execute(messages, channel) {
    await removeTranscriptsOf(channel, [...messages.keys()]);
  },
});
