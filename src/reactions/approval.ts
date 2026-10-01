// The owner confirmed a shadow auto-react line (its React button, src/approvals/): add that reaction to the
// post now. The budget was already spent when the shadow row was claimed, so confirming costs nothing more;
// the ledger row just turns into a real one.
import { type Client, RESTJSONErrorCodes } from 'discord.js';
import type { ReactionApproval } from '../approvals/approvalStore';
import type { ApprovalResult } from '../approvals/handler';
import { logger } from '../logger';
import { discordErrorCode } from '../scheduling/discord';
import { AutoReactLedger } from './ledger';

type ReactableMessage = { url: string; react(emoji: string): Promise<unknown> };
type MessageSource = { messages: { fetch(id: string): Promise<ReactableMessage> } };

// Discord's answers that another click won't change.
const GONE: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.MissingAccess,
]);
const REFUSED: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownEmoji,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.ReactionWasBlocked,
  RESTJSONErrorCodes.MaximumNumberOfReactionsReached,
  RESTJSONErrorCodes.InvalidActionOnArchivedThread,
  RESTJSONErrorCodes.ThreadLocked,
]);

function failure(error: unknown, label: string): ApprovalResult {
  const code = discordErrorCode(error);
  if (code !== undefined && GONE.has(code)) return { status: 'closed', note: 'the post is gone' };
  if (code !== undefined && REFUSED.has(code)) return { status: 'closed', note: `Discord refused ${label} there` };
  return { status: 'retry', note: "couldn't react just now, click again in a bit" };
}

export async function addApprovedReaction(
  client: Client,
  approval: ReactionApproval,
  ledger: AutoReactLedger = new AutoReactLedger(),
): Promise<ApprovalResult> {
  let message: ReactableMessage;
  try {
    const channel = await client.channels.fetch(approval.channelId);
    if (!channel?.isTextBased() || !('messages' in channel)) return { status: 'closed', note: 'the post is gone' };
    message = await (channel as unknown as MessageSource).messages.fetch(approval.messageId);
  } catch (error) {
    return failure(error, approval.label);
  }
  try {
    await message.react(approval.emoji);
  } catch (error) {
    logger.warn(`autoReact: adding the approved ${approval.label} to ${message.url} failed:`, error);
    return failure(error, approval.label);
  }
  try {
    ledger.markReacted(approval.messageId);
  } catch (error) {
    logger.warn('autoReact: could not mark the approved reaction in the ledger:', error);
  }
  logger.info(`autoReact: reacted ${approval.label} to ${message.url} (approved from the shadow line)`);
  return { status: 'done', note: `reacted ${approval.label}` };
}
