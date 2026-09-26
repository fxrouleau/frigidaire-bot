// Clicks in the notes viewer ("What does Fridge know?"): its select menu, buttons and the owner's Edit
// modal. Only interactions whose custom_id is the viewer's are handled; context-menu commands go through
// interactionCreate.ts and anything else is left alone.
import { Events } from 'discord.js';
import { handleViewerInteraction, isViewerCustomId } from '../commands/notesViewerActions';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.InteractionCreate, {
  async execute(interaction) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    if (!isViewerCustomId(interaction.customId)) return;
    await handleViewerInteraction(interaction);
  },
});
