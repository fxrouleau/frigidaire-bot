// Confirm buttons on shadow lines in the report channel (a birthday announcement, an auto-react): the
// owner lets a good one through by hand. Only buttons whose custom_id is an approval's are handled.
import { Events } from 'discord.js';
import { handleApprovalClick } from '../approvals/handler';
import { isApprovalCustomId } from '../approvals/offer';
import { isBotOwner } from '../botOwner';
import { defineEvent } from '../eventModule';
import { addApprovedReaction } from '../reactions/approval';
import { postApprovedBirthday } from '../scheduling/birthdayAnnouncer';

export default defineEvent(Events.InteractionCreate, {
  async execute(interaction) {
    if (!interaction.isButton() || !isApprovalCustomId(interaction.customId)) return;
    await handleApprovalClick(interaction, {
      isOwner: isBotOwner,
      execute: (payload, client) =>
        payload.kind === 'birthday' ? postApprovedBirthday(client, payload) : addApprovedReaction(client, payload),
    });
  },
});
