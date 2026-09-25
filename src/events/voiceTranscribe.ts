// Replies to members' voice messages with a silent transcript (see src/ai/media/autoTranscribe.ts).
// On by default; VOICE_AUTO_TRANSCRIBE=false turns it off, VOICE_TRANSCRIBE_CHANNELS limits where.
import { Events } from 'discord.js';
import { voiceAutoTranscriber } from '../ai/media/autoTranscribe';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    await voiceAutoTranscriber.handle(message);
  },
});
