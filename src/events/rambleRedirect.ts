import { Events } from 'discord.js';
import { defineEvent } from '../eventModule';
import { rambleWatcher } from '../gate';

// Nudges a watched member's rambles toward RAMBLE_CHANNEL_ID (see src/gate/ramble.ts): a free prefilter,
// then the chat model judges the content. Returns immediately unless RAMBLE_USER_IDS and
// RAMBLE_CHANNEL_ID are set and the channel is watched.
export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    await rambleWatcher.observe(message);
  },
});
