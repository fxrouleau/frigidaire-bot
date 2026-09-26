// A deleted voice message takes the bot's transcript of it along (src/ai/media/autoTranscribe.ts).
import { Events } from 'discord.js';
import { removeTranscriptsOf } from '../ai/media/autoTranscribe';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageDelete, {
  async execute(message) {
    // The bot's own messages (a transcript reply included) have no transcript of their own.
    if (message.author?.id === message.client.user.id) return;
    await removeTranscriptsOf(message.channel, [message.id]);
  },
});
