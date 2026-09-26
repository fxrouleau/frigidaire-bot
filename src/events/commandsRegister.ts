// Registers the context-menu commands in every guild once the client is ready (see src/commands/).
import { Events } from 'discord.js';
import { registerGuildCommands } from '../commands';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.ClientReady, {
  once: true,
  async execute(client) {
    await registerGuildCommands(client);
  },
});
