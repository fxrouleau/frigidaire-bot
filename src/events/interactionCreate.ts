// Context-menu commands (right-click a message or member → Apps). Every other interaction type is left
// alone, so a future button or modal handler can live in its own event file.
import { Events } from 'discord.js';
import { handleContextMenuCommand } from '../commands';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.InteractionCreate, {
  async execute(interaction) {
    if (!interaction.isContextMenuCommand()) return;
    await handleContextMenuCommand(interaction);
  },
});
