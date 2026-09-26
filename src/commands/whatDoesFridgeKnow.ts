// "What does Fridge know?" (right-click a member → Apps): the private notes viewer (notesViewer.ts) on
// that person — their profile first, then their other topics, their circles and their raw memories one
// pick away; the group's notes when the member is the bot itself. Everyone can view everyone; the owner
// also gets Edit and Undo (notesViewerActions.ts). A linked side account (LINKED_ACCOUNTS) shows its
// member: the main account's name, notes and memories.
import { type APIInteractionGuildMember, ApplicationCommandType, type GuildMember, MessageFlags } from 'discord.js';
import { currentName } from '../ai/people';
import { canonicalUserId } from '../linkedAccounts';
import { renderViewer, type ViewerPayload, type ViewerSubject } from './notesViewer';
import type { UserCommand } from './types';

export const whatDoesFridgeKnow: UserCommand = {
  type: ApplicationCommandType.User,
  name: 'What does Fridge know?',
  async run(interaction, deps) {
    const user = interaction.targetUser;
    const memory = deps.memoryStore();
    const notes = deps.notesStore();
    const owner = await deps.isOwner(interaction.client, interaction.user.id);
    const now = deps.now();

    if (user.id === interaction.client.user.id) {
      const group: ViewerSubject = { kind: 'group' };
      await replyPrivately(
        interaction,
        renderViewer({ subject: group, screen: { kind: 'home' }, page: 0 }, { memory, notes, now, owner }),
      );
      return;
    }

    const main = canonicalUserId(user.id);
    const liveName = memberName(interaction.targetMember);
    const name =
      main === user.id
        ? (liveName ?? memory.getIdentityById(user.id)?.display_name ?? user.displayName)
        : currentName(main, liveName ?? user.displayName, memory);
    const payload = renderViewer(
      { subject: { kind: 'person', id: main }, screen: { kind: 'home' }, page: 0 },
      { memory, notes, now, owner, name, lookupNames: [liveName, user.displayName, user.username] },
    );
    await replyPrivately(interaction, payload);
  },
};

async function replyPrivately(interaction: Parameters<UserCommand['run']>[0], payload: ViewerPayload): Promise<void> {
  await interaction.reply({
    ...(payload.content ? { content: payload.content } : {}),
    embeds: payload.embeds,
    components: payload.components,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

function memberName(member: GuildMember | APIInteractionGuildMember | null): string | undefined {
  if (!member) return undefined;
  if ('displayName' in member) return member.displayName;
  return member.nick ?? undefined;
}
