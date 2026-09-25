// "Ask Fridge": the bot answers the target message in the channel exactly as if someone had pinged it on
// that message. The invoker gets a private "on it" right away; the agent turn (tools, web search, a
// slow model) runs in the background and replies to the target itself, so the interaction never waits
// on it — and the agent's own error handling covers failures from there on.
import { ApplicationCommandType, type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import { logger } from '../logger';
import { LINES, answerPrivately, failPrivately } from './respond';
import { ensureTargetChannel, liveDisplayName } from './targets';
import { type CommandDeps, CommandError, type MessageCommand } from './types';

export const ASK_FRIDGE_LINES = {
  onIt: 'on it',
  ownMessage: "that's my own message, just reply to it if you want more out of me",
  alreadyAnswering: "already answering that one, it's coming",
} as const;

// Targets whose answer is still being written. The dispatcher's own guard ends when run() returns, which
// is right after the "on it"; this one lasts until the agent is done, so a double-click doesn't get the
// same message answered twice.
const answering = new Set<string>();

export const askFridge: MessageCommand = {
  type: ApplicationCommandType.Message,
  name: 'Ask Fridge',
  exclusive: 'target',
  async run(interaction, deps) {
    const target = interaction.targetMessage;
    if (target.author.id === interaction.client.user.id) throw new CommandError(ASK_FRIDGE_LINES.ownMessage);
    if (answering.has(target.id)) throw new CommandError(ASK_FRIDGE_LINES.alreadyAnswering);

    answering.add(target.id);
    try {
      await answerPrivately(interaction, ASK_FRIDGE_LINES.onIt);
    } catch (error) {
      // The acknowledgement failed (expired token): don't answer a click the invoker was never told about.
      answering.delete(target.id);
      throw error;
    }
    void answerInBackground(interaction, target, deps);
  },
};

async function answerInBackground(
  interaction: MessageContextMenuCommandInteraction,
  target: Message,
  deps: CommandDeps,
): Promise<void> {
  try {
    await ensureTargetChannel(target);
    // The agent labels the speaker with message.member, a lookup in the member cache that is empty for
    // someone who hasn't posted since the bot started; one fetch fills it so the reply knows who it's
    // talking about. Webhook and bot authors aren't members.
    if (!target.webhookId && !target.author.bot) await liveDisplayName(target.guild, target.author.id);
    await deps.askAgent(target);
  } catch (error) {
    if (error instanceof CommandError) {
      await failPrivately(interaction, error.userMessage);
      return;
    }
    logger.warn(`commands: "Ask Fridge" on message ${target.id} failed:`, error);
    await failPrivately(interaction, LINES.failed);
  } finally {
    answering.delete(target.id);
  }
}
