// "Summarize from here": a summary of the channel from the target message up to now, posted for
// everyone as a reply to that message. The range is capped at 7 days (the summary pipeline's limit);
// an older target summarizes the last week and says so.
import { ApplicationCommandType } from 'discord.js';
import { canonicalUserId } from '../linkedAccounts';
import { answerPrivately, deferPrivately, postPublicReply, subtext } from './respond';
import { ensureTargetChannel, invokerName } from './targets';
import { CommandError, type MessageCommand } from './types';

export const MAX_SUMMARY_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

export const summarizeFromHere: MessageCommand = {
  type: ApplicationCommandType.Message,
  name: 'Summarize from here',
  exclusive: 'target',
  async run(interaction, deps) {
    const target = interaction.targetMessage;
    await deferPrivately(interaction);
    await ensureTargetChannel(target);

    const end = deps.now();
    const earliest = new Date(end.getTime() - MAX_SUMMARY_RANGE_MS);
    const capped = target.createdAt < earliest;
    const start = capped ? earliest : target.createdAt;

    // The requester as a member: a linked side account asks as its main account (LINKED_ACCOUNTS).
    const requesterId = canonicalUserId(interaction.user.id);
    const summary = await deps.summarize({ message: target, start, end, requesterId });
    if (!summary.ok) throw new CommandError(summary.reason);

    const scope = capped
      ? 'summary of the last 7 days (that message is older than a week)'
      : 'summary from here to now';
    const posted = await postPublicReply(
      target,
      `${subtext(`${scope} · asked by ${invokerName(interaction)}`)}\n${summary.text}`,
    );
    await answerPrivately(interaction, `posted it: ${posted.url}`);
  },
};
