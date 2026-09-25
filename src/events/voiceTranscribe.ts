// Replies to members' voice messages (the hold-to-record kind, not uploaded audio files) with a silent
// transcript, or a one-line "too long to transcribe" note past VOICE_MAX_SECONDS (see
// src/ai/media/autoTranscribe.ts). On by default; VOICE_AUTO_TRANSCRIBE=false turns it off,
// VOICE_TRANSCRIBE_CHANNELS limits where.
import { Events } from 'discord.js';
import { voiceAutoTranscriber } from '../ai/media/autoTranscribe';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    await voiceAutoTranscriber.handle(message);
  },
});
