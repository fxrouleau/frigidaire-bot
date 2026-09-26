// A deleted post never gets an auto-reaction (the link fixer's originals included: their relay is the
// candidate instead). See src/reactions/.
import { Events } from 'discord.js';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { getAutoReactor } from '../reactions';

export default defineEvent(Events.MessageDelete, {
  execute(message) {
    if (config.autoReact.mode === 'off') return;
    getAutoReactor(message.client).cancel(message.id);
  },
});
