// Checks the transcription route at startup and daily: Whisper (OpenRouter's speech-to-text endpoint,
// which ignores provider routing) is used only while every host serving it is zero-data-retention; the
// verdict, or a WARN and the chat-model fallback, is logged (see src/ai/media/transcriber.ts).
import { Events } from 'discord.js';
import { startTranscriptionRouteChecks } from '../ai/media';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.ClientReady, {
  once: true,
  execute() {
    startTranscriptionRouteChecks();
  },
});
